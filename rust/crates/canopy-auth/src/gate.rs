//! The check at the top of every request (port of the rest of
//! `src/server/callers.ts` bar the /api/auth routes): the mode, the
//! loopback bypass, who is calling, the coordinator's and a run's lanes, and
//! `CallerGate`, which refuses, counts, logs once and limits guesses.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::json;

use crate::book::{Caller, CallerBook, Clock, PendingPair, Ticketed, system_clock};
use crate::origin::{is_loopback, is_loopback_host};
use crate::people::{Role, rights_of, role_allows};
use crate::request::Req;
use crate::rights::{CallerKind, Need, Right, allows, lane, needs};
use crate::text::{ascii_digits, js_trim};

/// An answer the gate or an auth route gives instead of passing a request
/// on: the status and the JSON body the TS sends.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: serde_json::Value,
}

impl Reply {
    pub fn json(status: u16, body: serde_json::Value) -> Reply {
        Reply { status, body }
    }

    pub(crate) fn error(status: u16, error: impl Into<String>) -> Reply {
        Reply::json(status, json!({ "error": error.into() }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallersMode {
    Off,
    Log,
    Enforce,
}

impl CallersMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CallersMode::Off => "off",
            CallersMode::Log => "log",
            CallersMode::Enforce => "enforce",
        }
    }
}

impl fmt::Display for CallersMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Reads an environment variable; tests pass a map instead of the process's.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The process's environment, for the `*_env` wrappers.
pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `CANOPY_CALLERS`, log unless it says off or enforce. Anything else is a
/// typo, said once and read as log.
pub fn callers_mode(env: Env<'_>) -> CallersMode {
    let raw = env("CANOPY_CALLERS").unwrap_or_default();
    match js_trim(&raw) {
        "off" => CallersMode::Off,
        "log" => CallersMode::Log,
        "enforce" => CallersMode::Enforce,
        "" => CallersMode::Log,
        other => {
            eprintln!(
                "callers: CANOPY_CALLERS={other} is not off, log or enforce; checking in log mode"
            );
            CallersMode::Log
        }
    }
}

pub fn callers_mode_env() -> CallersMode {
    callers_mode(&process_env)
}

/// `CANOPY_LOOPBACK_AUTH`: a dev-only switch. When set, a request from the
/// machine's own loopback that also asks for a loopback host is spoken for by
/// the built-in page caller. Off unless 1/on/true/yes; honoured only when the
/// server is not bound beyond loopback (`loopback_bypass`).
pub fn loopback_auth_wanted(env: Env<'_>) -> bool {
    let raw = env("CANOPY_LOOPBACK_AUTH").unwrap_or_default();
    matches!(
        js_trim(&raw).to_lowercase().as_str(),
        "1" | "on" | "true" | "yes"
    )
}

pub fn loopback_auth_wanted_env() -> bool {
    loopback_auth_wanted(&process_env)
}

/// Everything `loopback_bypass` weighs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bypass<'a> {
    pub wanted: bool,
    pub beyond_loopback: bool,
    pub on_lane: bool,
    pub upgrade: bool,
    pub sec_fetch_site: Option<&'a str>,
    pub addr: &'a str,
    pub hostname: &'a str,
}

/// Whether to speak for this request as the built-in loopback caller. Every
/// part is required: the switch is on, the server is not bound beyond
/// loopback, this is not the coordinator's listener, it is no socket upgrade
/// (a socket authenticates with a one-use ticket), the browser does not mark
/// it cross-site or same-site, the peer is loopback, and the Host asked for
/// is a loopback name (against DNS rebinding). An absent Sec-Fetch-Site reads
/// as a local process that is not a browser.
pub fn loopback_bypass(x: &Bypass<'_>) -> bool {
    let site_ok = !matches!(x.sec_fetch_site, Some("cross-site") | Some("same-site"));
    x.wanted
        && !x.beyond_loopback
        && !x.on_lane
        && !x.upgrade
        && site_ok
        && is_loopback(x.addr)
        && is_loopback_host(x.hostname)
}

/// The two sockets a browser opens and its event stream cannot carry a
/// header, so each takes a ticket in the query instead, for the right it
/// needs.
fn upgrade_right(path: &str) -> Option<Ticketed> {
    match path {
        "/api/term" => Some(Ticketed::Shell),
        "/api/helper" => Some(Ticketed::Helper),
        "/api/events" => Some(Ticketed::Read),
        _ => None,
    }
}

/// Who is calling: the `X-Canopy-Token` header, else a ticket on one of the
/// two upgrades or the event stream. None for nobody known. A ticket is spent
/// here, so this runs once per request.
pub fn caller_of(book: &CallerBook, req: &Req) -> Option<Caller> {
    if let Some(token) = req.header("x-canopy-token").filter(|t| !t.is_empty()) {
        return book.check(Some(&token));
    }
    let right = upgrade_right(req.path())?;
    let ticket = req.query("ticket").filter(|t| !t.is_empty())?;
    book.redeem(&ticket, right)
}

/// A refused call, as the recent list keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refused {
    pub kind: CallerKind,
    pub route: String,
    pub origin: String,
    pub ua: String,
    pub at: i64,
}

/// Every refusal since start, would-refuse ones in log mode included; the
/// newest 20, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RefusedLog {
    pub count: u64,
    pub recent: Vec<Refused>,
}

/// `CANOPY_COORD_PORT` read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordPort {
    pub port: Option<u16>,
    pub error: Option<String>,
}

/// `CANOPY_COORD_PORT`: the port of the coordinator's own listener. Unset or
/// not a port, there is no listener, and the error keeps every coordinator
/// from starting.
pub fn coord_port(env: Env<'_>) -> CoordPort {
    let raw = env("CANOPY_COORD_PORT").unwrap_or_default();
    let raw = js_trim(&raw);
    if raw.is_empty() {
        return CoordPort {
            port: None,
            error: Some(
                "CANOPY_COORD_PORT is not set, so the coordinator has no listener of its own and none starts"
                    .to_string(),
            ),
        };
    }
    let port = if raw.len() <= 5 && ascii_digits(raw) {
        raw.parse::<u32>().unwrap_or(0)
    } else {
        0
    };
    match u16::try_from(port) {
        Ok(p) if p >= 1 => CoordPort {
            port: Some(p),
            error: None,
        },
        _ => CoordPort {
            port: None,
            error: Some(format!(
                "CANOPY_COORD_PORT={raw} is not a port like 7859, so no coordinator starts"
            )),
        },
    }
}

pub fn coord_port_env() -> CoordPort {
    coord_port(&process_env)
}

/// Why no coordinator may start here, or None. Its agent runs with its
/// permissions bypassed, so outside enforce nothing would keep it from any
/// route. `lane_down` is why its own listener is not up, None once it is.
pub fn coordinator_refusal(mode: CallersMode, lane_down: Option<&str>) -> Option<String> {
    if mode != CallersMode::Enforce {
        return Some(format!(
            "the coordinator runs only while canopy enforces caller tokens (CANOPY_CALLERS=enforce; it is {mode} here), since in {mode} mode nothing stops its agent, which runs with its permissions bypassed, from calling any route"
        ));
    }
    lane_down.map(str::to_string)
}

/// Whether `kind`'s lane lets a request through; a HEAD is a GET without the
/// body. A kind with no lane has nothing here to pass.
pub fn lane_allows(kind: CallerKind, method: &str, path: &str) -> bool {
    let method = if method == "HEAD" { "GET" } else { method };
    let line = format!("{method} {path}");
    lane(kind).is_some_and(|routes| routes.contains(&line.as_str()))
}

/// The lane's word on a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneVerdict {
    /// a caller on the coordinator's listener that is not a coordinator
    Token,
    /// a kind with a lane, on either listener, off its routes
    Route,
}

/// None lets the request on to the gate.
pub fn lane_verdict(
    on_lane: bool,
    kind: CallerKind,
    method: &str,
    path: &str,
) -> Option<LaneVerdict> {
    if on_lane && kind != CallerKind::Coordinator {
        return Some(LaneVerdict::Token);
    }
    lane(kind)?;
    if lane_allows(kind, method, path) {
        None
    } else {
        Some(LaneVerdict::Route)
    }
}

const RECENT: usize = 20;
const GUESS_WINDOW: i64 = 10 * 60 * 1000;
const MOST_GUESSES: usize = 10;

pub(crate) fn is_auth(path: &str) -> bool {
    path == "/api/auth" || path.starts_with("/api/auth/")
}

/// the people routes that change who is here or what they may do; saying
/// where you are (`at`) and your own name (`me`) follow the mode like any read
fn is_people_write(method: &str, path: &str) -> bool {
    method != "GET"
        && method != "HEAD"
        && path.starts_with("/api/people/")
        && path != "/api/people/at"
        && path != "/api/people/me"
}

/// A 401 for nobody known, a 403 for a caller without the right. Never a
/// `login` key: the page reads that as the edge gate's sign-in.
pub(crate) fn refusal(right: Right, has_caller: bool, by_role: bool) -> Reply {
    // a kind short of the right signs in for a token of another kind; a role
    // short of it is the person's, and no sign-in changes that (FR-074)
    let how = if by_role {
        "your role on this backend does not hold it"
    } else {
        "run canopy auth login, or open a new shell"
    };
    Reply::json(
        if has_caller { 403 } else { 401 },
        json!({ "error": format!("this call needs the {right} right; {how}"), "need": right.as_str() }),
    )
}

/// Told every line the gate logs.
pub type LogHook = Arc<dyn Fn(&str) + Send + Sync>;
/// Told the waiting pairs whenever they change.
pub type PairsHook = Arc<dyn Fn(&[PendingPair]) + Send + Sync>;
/// Told the refusal count after each refusal.
pub type RefusedHook = Arc<dyn Fn(u64) + Send + Sync>;
/// The role of a caller's person, None once that person is gone or off.
pub type RoleOf = Arc<dyn Fn(&Caller) -> Option<Role> + Send + Sync>;

#[derive(Debug, Default)]
struct GateState {
    refused: RefusedLog,
    /// the would-refuse lines already logged, by kind, method and path
    said: HashSet<String>,
    /// failed guesses by route and address, as times
    misses: HashMap<String, Vec<i64>>,
    shown: Option<String>,
    /// the lane's refusals already logged, by kind, method and path
    lane_said: HashSet<String>,
}

/// The check at the top of every request, what it refused, the guesses at the
/// pairing routes, and the first code as last printed. Methods take `&self`;
/// the hooks are called with no lock held.
pub struct CallerGate {
    pub book: Arc<CallerBook>,
    pub mode: CallersMode,
    state: Mutex<GateState>,
    log: LogHook,
    on_pairs: PairsHook,
    on_refused: RefusedHook,
    now: Clock,
    role_of: RoleOf,
}

impl fmt::Debug for CallerGate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallerGate")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

impl CallerGate {
    /// A gate on `book` in `mode`. Unless `with_role_of` says otherwise,
    /// everyone is the owner, as before there were people (FR-074).
    pub fn new(book: Arc<CallerBook>, mode: CallersMode, log: LogHook) -> CallerGate {
        CallerGate {
            book,
            mode,
            state: Mutex::new(GateState::default()),
            log,
            on_pairs: Arc::new(|_| {}),
            on_refused: Arc::new(|_| {}),
            now: system_clock(),
            role_of: Arc::new(|_| Some(Role::Owner)),
        }
    }

    pub fn with_on_pairs(mut self, hook: PairsHook) -> CallerGate {
        self.on_pairs = hook;
        self
    }

    pub fn with_on_refused(mut self, hook: RefusedHook) -> CallerGate {
        self.on_refused = hook;
        self
    }

    pub fn with_clock(mut self, now: Clock) -> CallerGate {
        self.now = now;
        self
    }

    pub fn with_role_of(mut self, role_of: RoleOf) -> CallerGate {
        self.role_of = role_of;
        self
    }

    fn lock(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The refusals so far.
    pub fn refused(&self) -> RefusedLog {
        self.lock().refused.clone()
    }

    pub fn role_of(&self, caller: &Caller) -> Option<Role> {
        (self.role_of)(caller)
    }

    /// Whether a caller holds a need: its kind's and its person's role's,
    /// both. A caller whose person is gone or off holds nothing.
    pub fn can(&self, caller: Option<&Caller>, need: impl Into<Need>) -> bool {
        let need = need.into();
        if need == Need::Open {
            return true;
        }
        let Some(caller) = caller else { return false };
        match self.role_of(caller) {
            Some(role) => allows(caller.kind, need) && role_allows(role, need),
            None => false,
        }
    }

    /// Every right a caller holds, for `GET /api/auth`.
    pub fn rights(&self, caller: Option<&Caller>) -> Vec<Right> {
        let Some(caller) = caller else {
            return Vec::new();
        };
        match self.role_of(caller) {
            Some(role) => rights_of(caller.kind, role),
            None => Vec::new(),
        }
    }

    /// A refusal, would-refuse ones included, in the count and the recent
    /// list; the new count.
    fn record(st: &mut GateState, kind: CallerKind, req: &Req, at: i64) -> u64 {
        st.refused.count += 1;
        st.refused.recent.insert(
            0,
            Refused {
                kind,
                route: format!("{} {}", req.method(), req.path()),
                origin: req.header("origin").unwrap_or_default(),
                ua: req.header("user-agent").unwrap_or_default(),
                at,
            },
        );
        st.refused.recent.truncate(RECENT);
        st.refused.count
    }

    /// None lets the request through, anything else is the answer. The auth
    /// routes and the people routes that write are checked in every mode, so a
    /// token nobody approved while nothing was enforced cannot be one later,
    /// and nobody without admin adds a person or mints an invite.
    pub fn gate(&self, req: &Req, caller: Option<&Caller>) -> Option<Reply> {
        let path = req.path();
        let auth = is_auth(path) || is_people_write(req.method(), path);
        if self.mode == CallersMode::Off && !auth {
            return None;
        }
        // a HEAD is a GET without the body
        let method = if req.method() == "HEAD" {
            "GET"
        } else {
            req.method()
        };
        let Need::Right(right) = needs(method, path) else {
            return None;
        };
        // a token whose person is gone or off is nobody's
        let caller = caller.filter(|c| self.role_of(c).is_some());
        let kind = caller.map_or(CallerKind::None, |c| c.kind);
        if self.can(caller, right) {
            return None;
        }
        let at = (self.now)();
        let (count, line) = {
            let mut st = self.lock();
            let count = Self::record(&mut st, kind, req, at);
            let line = if self.mode == CallersMode::Log && !auth {
                let key = format!("{} {} {}", kind.as_str(), req.method(), path);
                st.said
                    .insert(key.clone())
                    .then(|| format!("callers: would refuse {key} (needs {right})"))
            } else {
                None
            };
            (count, line)
        };
        (self.on_refused)(count);
        if self.mode == CallersMode::Log && !auth {
            if let Some(line) = line {
                (self.log)(&line);
            }
            return None;
        }
        Some(refusal(
            right,
            caller.is_some(),
            caller.is_some() && allows(kind, right),
        ))
    }

    /// The lanes, ahead of `gate` and in every mode. A request on the
    /// coordinator's own listener (`on_lane`) must carry a coordinator's
    /// token, and a coordinator's or a run's token, on either listener,
    /// reaches only its kind's lane. The lane goes by the socket a request
    /// came in on, never by its source address. None lets the request on.
    pub fn lane(
        &self,
        req: &Req,
        caller: Option<&Caller>,
        addr: &str,
        on_lane: bool,
    ) -> Option<Reply> {
        let kind = caller.map_or(CallerKind::None, |c| c.kind);
        let verdict = lane_verdict(on_lane, kind, req.method(), req.path())?;
        let at = (self.now)();
        let key = format!("{} {} {}", kind.as_str(), req.method(), req.path());
        let (count, first) = {
            let mut st = self.lock();
            let count = Self::record(&mut st, kind, req, at);
            (count, st.lane_said.insert(key.clone()))
        };
        (self.on_refused)(count);
        if first {
            let who = if kind == CallerKind::Run {
                "run"
            } else {
                "coordinator"
            };
            (self.log)(&format!("callers: {who} lane refused {key} from {addr}"));
        }
        let error = match verdict {
            LaneVerdict::Token => {
                "a call on the coordinator's listener needs a coordinator's token"
            }
            LaneVerdict::Route if kind == CallerKind::Run => {
                "a run's token reads the board and starts, says to and notes on its own run's work, and nothing else; landing, pushing and answering prompts are yours to ask of the user"
            }
            LaneVerdict::Route => {
                "a coordinator's token reads the tree, runs, landing queue, loadouts and the workflows it may name, posts its plan, and nothing else"
            }
        };
        Some(Reply::error(403, error))
    }

    /// Whether `addr` has missed at `route` ten times in the last ten minutes.
    pub fn locked(&self, route: &str, addr: &str) -> bool {
        let at = (self.now)();
        let mut st = self.lock();
        st.misses.retain(|_, times| {
            times.retain(|t| at - t < GUESS_WINDOW);
            !times.is_empty()
        });
        st.misses
            .get(&format!("{route} {addr}"))
            .is_some_and(|t| t.len() >= MOST_GUESSES)
    }

    pub fn missed(&self, route: &str, addr: &str) {
        let at = (self.now)();
        self.lock()
            .misses
            .entry(format!("{route} {addr}"))
            .or_default()
            .push(at);
    }

    pub fn pairs_changed(&self) {
        let pending = self.book.pending();
        (self.on_pairs)(&pending);
    }

    /// a session that could approve the owner's sign-in: an owner's own
    fn owner_session(&self) -> impl Fn(&Caller) -> bool + '_ {
        move |c| self.role_of(c) == Some(Role::Owner)
    }

    /// The first code takes a waiting pair for the owner, while no owner is
    /// signed in to approve it.
    pub fn use_first(&self, given: &str, pair_id: &str) -> bool {
        let owner = self.owner_session();
        self.book.use_first(given, pair_id, Some(&owner))
    }

    /// Prints the first sign-in code when there is one not printed yet.
    pub fn announce(&self) {
        let owner = self.owner_session();
        let code = self.book.first_code(Some(&owner));
        let show = {
            let mut st = self.lock();
            let show = code.is_some() && code != st.shown;
            st.shown = code.clone();
            show
        };
        if let (true, Some(code)) = (show, code) {
            (self.log)(&format!(
                "canopy: first sign-in code {code} (good until a page or the CLI signs in)"
            ));
        }
    }
}
