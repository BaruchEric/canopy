//! The callers this backend knows (port of `CallerBook` in
//! `src/server/callers.ts`): `<config dir>/callers.json`, one entry per token
//! as `{hash, ...caller}`. The token itself is never kept, only its SHA-256
//! hex, so a copy of the file lets nobody in. The file is the TS server's,
//! byte for byte, so both servers can share a config dir.
//!
//! Pair requests, tickets and the first code live in memory only; a restart
//! drops them, which is what they should do.
//!
//! Every method takes `&self` and holds an internal lock, so a server can
//! share one book behind an `Arc`. A write to the file happens under that
//! lock, after memory has changed, so a revoke bites at once even when the
//! write fails.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::{Rng as _, RngExt as _};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::people::OWNER_ID;
use crate::rights::{CallerKind, PairKind, kind_of_label};
use crate::text::utf16_prefix;

/// Unix milliseconds now; tests pass their own.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Told the ids of the callers just dropped, so a server can close the
/// sockets they hold. Called after the book's lock is released.
pub type DropHook = Arc<dyn Fn(&[String]) + Send + Sync>;

/// The clock a server runs on.
pub fn system_clock() -> Clock {
    Arc::new(now_ms)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `CANOPY_CONFIG_DIR`, else `~/.config/canopy`.
pub fn config_dir() -> PathBuf {
    match std::env::var_os("CANOPY_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            home.join(".config").join("canopy")
        }
    }
}

/// A caller as the server and the page see it. `user` is the person it
/// belongs to (FR-074); none is the owner's. Fields serialize in the order the
/// TS writes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Caller {
    pub id: String,
    pub kind: CallerKind,
    pub label: String,
    pub created: i64,
    pub used: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

/// What a mint may tie a token to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MintOpts {
    pub label: String,
    pub term: Option<String>,
    pub run: Option<String>,
    pub user: Option<String>,
}

impl MintOpts {
    pub fn label(label: impl Into<String>) -> MintOpts {
        MintOpts {
            label: label.into(),
            ..MintOpts::default()
        }
    }

    pub fn term(mut self, term: impl Into<String>) -> MintOpts {
        self.term = Some(term.into());
        self
    }

    pub fn run(mut self, run: impl Into<String>) -> MintOpts {
        self.run = Some(run.into());
        self
    }

    pub fn user(mut self, user: impl Into<String>) -> MintOpts {
        self.user = Some(user.into());
        self
    }
}

/// A minted token and the caller it opens. The token is shown once and never
/// kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Minted {
    pub token: String,
    pub caller: Caller,
}

/// What a ticket may stand in for: a shell's socket, a helper's, and the
/// event stream, which any caller with a token may read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Ticketed {
    Shell,
    Helper,
    Read,
}

impl Ticketed {
    pub fn right(self) -> crate::rights::Right {
        use crate::rights::Right;
        match self {
            Ticketed::Shell => Right::Shell,
            Ticketed::Helper => Right::Helper,
            Ticketed::Read => Right::Read,
        }
    }
}

/// A pair request waiting, as an admin's page lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingPair {
    pub id: String,
    pub label: String,
    /// the address it asked from
    pub addr: String,
    pub code: String,
    pub at: i64,
    /// what it asks to sign in as, and so what one approval grants
    pub kind: PairKind,
}

/// What a new pair request's asker is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PairTicket {
    pub id: String,
    pub code: String,
    pub secret: String,
}

/// The asker's own waiting request, sent along to renew it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Renew {
    pub id: String,
    pub secret: String,
}

/// What a claim with the right secret gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// nobody has approved or denied it yet
    Waiting,
    /// approved: the token, handed out once
    Token(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoSuchCaller;

impl std::fmt::Display for NoSuchCaller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("no such caller")
    }
}

impl std::error::Error for NoSuchCaller {}

/// An entry as kept in callers.json, in the TS's key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Kept {
    hash: String,
    #[serde(flatten)]
    caller: Caller,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairState {
    Waiting,
    Approved,
    Denied,
}

#[derive(Debug, Clone)]
struct Pair {
    id: String,
    label: String,
    addr: String,
    kind: PairKind,
    code: String,
    secret: String,
    at: i64,
    state: PairState,
    user: Option<String>,
}

#[derive(Debug, Clone)]
struct Ticket {
    caller_id: String,
    right: Ticketed,
    at: i64,
}

#[derive(Debug)]
struct State {
    callers: Vec<Kept>,
    /// in the order they came, which `pending` keeps
    pairs: Vec<Pair>,
    tickets: HashMap<String, Ticket>,
    /// when each recent new pair request came, for the per-minute cap
    pair_times: Vec<i64>,
    /// the pairs a renewal replaced, with their secrets and when
    replaced: HashMap<String, (String, i64)>,
    first: Option<String>,
    last_save: i64,
}

/// The id of the built-in caller the loopback-auth bypass speaks as. It lives
/// in memory only and matches no token.
const LOOPBACK_ID: &str = "loopback";
const CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DAY: i64 = 24 * 60 * 60 * 1000;
/// a session of a person is over after this long unused
const SESSION_IDLE: i64 = 30 * DAY;
const TICKET_LIFE: i64 = 60 * 1000;
const PAIR_LIFE: i64 = 10 * 60 * 1000;
const MOST_PAIRS: usize = 3;
/// new pair requests the whole server takes in one rolling minute
const MOST_NEW_PAIRS: usize = 6;
const PAIR_RATE: i64 = 60 * 1000;
/// how often a bump of `used` is worth a write
const SAVE_EVERY: i64 = 60 * 1000;

/// Lowercase hex SHA-256, as the file keeps a token.
pub fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    buf
}

/// `randomBytes(n).toString("base64url")`
fn b64(n: usize) -> String {
    URL_SAFE_NO_PAD.encode(random_bytes(n))
}

/// Six characters, each uniform over the code alphabet.
fn pair_code() -> String {
    let mut rng = rand::rng();
    (0..6)
        .map(|_| CODE_CHARS[rng.random_range(0..CODE_CHARS.len())] as char)
        .collect()
}

fn is_session(kind: CallerKind) -> bool {
    matches!(kind, CallerKind::Page | CallerKind::Cli)
}

fn json_ms(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_number()?;
    n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))
}

fn json_str(v: Option<&Value>) -> Option<String> {
    v?.as_str().map(str::to_string)
}

/// The file read back; an entry that does not check out is left out. None
/// when the file is not a JSON array at all.
fn parse_kept(raw: &str) -> Option<Vec<Kept>> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let entries = v.as_array()?;
    let mut out = Vec::new();
    for e in entries {
        let Some(r) = e.as_object() else { continue };
        let (Some(hash), Some(id), Some(label)) = (
            json_str(r.get("hash")),
            json_str(r.get("id")),
            json_str(r.get("label")),
        ) else {
            continue;
        };
        let Some(kind) = r
            .get("kind")
            .and_then(Value::as_str)
            .and_then(CallerKind::parse)
        else {
            continue;
        };
        let (Some(created), Some(used)) = (json_ms(r.get("created")), json_ms(r.get("used")))
        else {
            continue;
        };
        out.push(Kept {
            hash,
            caller: Caller {
                id,
                kind,
                label,
                created,
                used,
                term: json_str(r.get("term")),
                run: json_str(r.get("run")),
                user: json_str(r.get("user")).filter(|u| u != OWNER_ID),
            },
        });
    }
    Some(out)
}

/// The book's file bytes for a list of callers: two-space JSON and a newline,
/// as `JSON.stringify(list, null, 2)` writes it.
fn file_text(callers: &[Kept]) -> io::Result<String> {
    let kept: Vec<&Kept> = callers
        .iter()
        .filter(|c| c.caller.id != LOOPBACK_ID)
        .collect();
    let mut text = serde_json::to_string_pretty(&kept).map_err(io::Error::other)?;
    text.push('\n');
    Ok(text)
}

pub struct CallerBook {
    state: Mutex<State>,
    file: PathBuf,
    now: Clock,
    on_drop: Mutex<Option<DropHook>>,
}

impl std::fmt::Debug for CallerBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallerBook")
            .field("file", &self.file)
            .finish_non_exhaustive()
    }
}

impl CallerBook {
    /// The book at `<config dir>/callers.json`, on the system clock.
    pub fn open_default() -> CallerBook {
        CallerBook::open(config_dir().join("callers.json"))
    }

    /// The book kept in `file`, on the system clock.
    pub fn open(file: impl Into<PathBuf>) -> CallerBook {
        CallerBook::open_with_clock(file, system_clock())
    }

    /// The book kept in `file`, on a clock of the caller's.
    pub fn open_with_clock(file: impl Into<PathBuf>, now: Clock) -> CallerBook {
        let file = file.into();
        let callers = load(&file);
        let last_save = now();
        CallerBook {
            state: Mutex::new(State {
                callers,
                pairs: Vec::new(),
                tickets: HashMap::new(),
                pair_times: Vec::new(),
                replaced: HashMap::new(),
                first: None,
                last_save,
            }),
            file,
            now,
            on_drop: Mutex::new(None),
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    /// Sets what is told the ids of dropped callers (a revoke, a shell or run
    /// ending, prune, expiry).
    pub fn set_on_drop(&self, hook: DropHook) {
        *lock(&self.on_drop) = Some(hook);
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn told(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        let hook = lock(&self.on_drop).clone();
        if let Some(hook) = hook {
            hook(ids);
        }
    }

    /// Writes what the book holds: through a temp file and a rename, 0600 in
    /// a 0700 folder. A failure is logged here and returned.
    fn save(&self, st: &mut State) -> io::Result<()> {
        st.last_save = (self.now)();
        let res = write_file(&self.file, &st.callers);
        if let Err(err) = &res {
            eprintln!("callers: could not write {}: {err}", self.file.display());
        }
        res
    }

    /// Writes the book now. Every change already writes, so a server needs
    /// this only to keep the last minute of `used` bumps at shutdown.
    pub fn flush(&self) -> io::Result<()> {
        let mut st = self.lock();
        self.save(&mut st)
    }

    fn mint_locked(&self, st: &mut State, kind: CallerKind, opts: MintOpts) -> Minted {
        let token = format!("cnp_{}_{}", kind.as_str(), b64(32));
        let at = (self.now)();
        let caller = Caller {
            id: b64(6),
            kind,
            label: opts.label,
            created: at,
            used: at,
            term: opts.term,
            run: opts.run,
            // the owner's is the absence of one, as every older session's is
            user: opts.user.filter(|u| u != OWNER_ID),
        };
        st.callers.push(Kept {
            hash: token_hash(&token),
            caller: caller.clone(),
        });
        // a failed write is logged; the token works until a restart
        let _ = self.save(st);
        Minted { token, caller }
    }

    pub fn mint(&self, kind: CallerKind, opts: MintOpts) -> Minted {
        let mut st = self.lock();
        self.mint_locked(&mut st, kind, opts)
    }

    /// The caller the loopback-auth bypass speaks as: a page-rights caller
    /// kept in memory only, never written and matching no token. The same one
    /// each call, re-made if a revoke or an idle sweep dropped it.
    pub fn local_caller(&self) -> Caller {
        let mut st = self.lock();
        if let Some(have) = st.callers.iter().find(|c| c.caller.id == LOOPBACK_ID) {
            return have.caller.clone();
        }
        let at = (self.now)();
        let caller = Caller {
            id: LOOPBACK_ID.to_string(),
            kind: CallerKind::Page,
            label: "loopback".to_string(),
            created: at,
            used: at,
            term: None,
            run: None,
            user: None,
        };
        st.callers.push(Kept {
            hash: format!("{LOOPBACK_ID}:no-token"),
            caller: caller.clone(),
        });
        caller
    }

    /// The caller a token belongs to, or None. A use counts as the session's
    /// last; a page or cli session unused for 30 days is over. The bump is
    /// written at most once a minute, so a restart loses a minute of it.
    pub fn check(&self, token: Option<&str>) -> Option<Caller> {
        let token = token.filter(|t| !t.is_empty())?;
        let hash = token_hash(token);
        let mut st = self.lock();
        let at = (self.now)();
        let i = st.callers.iter().position(|c| c.hash == hash)?;
        let kept = &mut st.callers[i];
        if is_session(kept.caller.kind) && at - kept.caller.used > SESSION_IDLE {
            let gone = st.callers.remove(i);
            let _ = self.save(&mut st);
            drop(st);
            self.told(&[gone.caller.id]);
            return None;
        }
        kept.caller.used = at;
        let caller = kept.caller.clone();
        if at - st.last_save >= SAVE_EVERY {
            let _ = self.save(&mut st);
        }
        Some(caller)
    }

    /// Drops at once in memory, then writes; Ok(false) when nothing matched.
    fn remove(&self, drop_it: impl Fn(&Caller) -> bool) -> io::Result<bool> {
        let mut st = self.lock();
        let (gone, kept): (Vec<Kept>, Vec<Kept>) = std::mem::take(&mut st.callers)
            .into_iter()
            .partition(|c| drop_it(&c.caller));
        st.callers = kept;
        if gone.is_empty() {
            return Ok(false);
        }
        let res = self.save(&mut st);
        drop(st);
        let ids: Vec<String> = gone.into_iter().map(|c| c.caller.id).collect();
        self.told(&ids);
        res.map(|()| true)
    }

    /// Ok(true) when there was such a caller; an Err means the drop holds in
    /// memory but the file was not written.
    pub fn revoke(&self, id: &str) -> io::Result<bool> {
        self.remove(|c| c.id == id)
    }

    pub fn drop_term(&self, term: &str) -> io::Result<()> {
        self.remove(|c| c.term.as_deref() == Some(term)).map(|_| ())
    }

    pub fn drop_run(&self, run: &str) -> io::Result<()> {
        self.remove(|c| c.run.as_deref() == Some(run)).map(|_| ())
    }

    /// Drops everything a person holds: their sessions, and the shells' and
    /// runs' tokens minted in their name. The owner's are those with no user.
    pub fn drop_user(&self, user: &str) -> io::Result<()> {
        self.remove(|c| c.user.as_deref().unwrap_or(OWNER_ID) == user)
            .map(|_| ())
    }

    /// Drops every caller of one kind: at start, the coordinators', since no
    /// run outlives a restart to hold one.
    pub fn drop_kind(&self, kind: CallerKind) -> io::Result<()> {
        self.remove(|c| c.kind == kind).map(|_| ())
    }

    /// Drops shell callers whose terminal is gone.
    pub fn prune(&self, live_terms: &std::collections::HashSet<String>) -> io::Result<()> {
        self.remove(|c| {
            c.kind == CallerKind::Shell && c.term.as_ref().is_none_or(|t| !live_terms.contains(t))
        })
        .map(|_| ())
    }

    pub fn list(&self) -> Vec<Caller> {
        self.lock()
            .callers
            .iter()
            .map(|c| c.caller.clone())
            .collect()
    }

    pub fn by_id(&self, id: &str) -> Option<Caller> {
        self.lock()
            .callers
            .iter()
            .find(|c| c.caller.id == id)
            .map(|c| c.caller.clone())
    }

    /// The person a shell's token is held for: None for the owner's, and for
    /// a shell with no token.
    pub fn user_of_term(&self, term: &str) -> Option<String> {
        self.lock()
            .callers
            .iter()
            .find(|c| c.caller.kind == CallerKind::Shell && c.caller.term.as_deref() == Some(term))
            .and_then(|c| c.caller.user.clone())
    }

    /// A one-use ticket, good for 60 s, for a socket or a stream that cannot
    /// send a header.
    pub fn ticket(&self, caller_id: &str, right: Ticketed) -> Result<String, NoSuchCaller> {
        let mut st = self.lock();
        if !st.callers.iter().any(|c| c.caller.id == caller_id) {
            return Err(NoSuchCaller);
        }
        let ticket = b64(32);
        let at = (self.now)();
        st.tickets.insert(
            ticket.clone(),
            Ticket {
                caller_id: caller_id.to_string(),
                right,
                at,
            },
        );
        Ok(ticket)
    }

    /// Spends a ticket: its caller when it was for this right and is under
    /// 60 s old. A ticket is gone after one try either way.
    pub fn redeem(&self, ticket: &str, right: Ticketed) -> Option<Caller> {
        let mut st = self.lock();
        let got = st.tickets.remove(ticket)?;
        let at = (self.now)();
        st.tickets.retain(|_, v| at - v.at <= TICKET_LIFE);
        if got.right != right || at - got.at > TICKET_LIFE {
            return None;
        }
        st.callers
            .iter()
            .find(|c| c.caller.id == got.caller_id)
            .map(|c| c.caller.clone())
    }

    fn sweep_pairs(&self, st: &mut State) {
        let at = (self.now)();
        st.pairs.retain(|p| at - p.at <= PAIR_LIFE);
    }

    fn waiting_count(&self, st: &mut State) -> usize {
        self.sweep_pairs(st);
        st.pairs
            .iter()
            .filter(|p| p.state == PairState::Waiting)
            .count()
    }

    /// A new request. The server takes at most 6 a minute, whoever they come
    /// from, since docker-proxy gives every client one address. `renew` is the
    /// id and secret of the asker's own waiting request: with both right, that
    /// one is replaced and its claim then says so. `kind` is what the asker
    /// signs in as; one that sends none gets the one its label names.
    pub fn pair(
        &self,
        label: &str,
        addr: &str,
        kind: Option<PairKind>,
        renew: Option<&Renew>,
    ) -> Result<PairTicket, String> {
        let mut st = self.lock();
        let at = (self.now)();
        st.pair_times.retain(|t| at - t < PAIR_RATE);
        if st.pair_times.len() >= MOST_NEW_PAIRS {
            return Err(format!(
                "more than {MOST_NEW_PAIRS} pair requests in a minute; deny the ones you do not recognize from a signed-in page's inbox, or wait for them to expire"
            ));
        }
        if let Some(renew) = renew {
            let old = st.pairs.iter().position(|p| {
                p.id == renew.id && p.state == PairState::Waiting && p.secret == renew.secret
            });
            if let Some(i) = old {
                let old = st.pairs.remove(i);
                st.replaced.insert(old.id, (old.secret, at));
            }
        }
        if self.waiting_count(&mut st) >= MOST_PAIRS {
            return Err(format!(
                "{MOST_PAIRS} pair requests already wait; deny the ones you do not recognize from a signed-in page's inbox, or wait for them to expire"
            ));
        }
        st.pair_times.push(at);
        let name = utf16_prefix(label, 80).to_string();
        let kind = kind.unwrap_or_else(|| kind_of_label(&name));
        let p = Pair {
            id: b64(6),
            label: name,
            addr: addr.to_string(),
            kind,
            code: pair_code(),
            secret: b64(32),
            at,
            state: PairState::Waiting,
            user: None,
        };
        let ticket = PairTicket {
            id: p.id.clone(),
            code: p.code.clone(),
            secret: p.secret.clone(),
        };
        st.pairs.push(p);
        Ok(ticket)
    }

    /// The asker takes its own waiting pair back: it signed in another way (an
    /// invite, FR-074). True when a waiting pair with that secret went.
    pub fn withdraw(&self, id: &str, secret: &str) -> bool {
        let mut st = self.lock();
        let Some(i) = st
            .pairs
            .iter()
            .position(|p| p.id == id && p.state == PairState::Waiting && p.secret == secret)
        else {
            return false;
        };
        st.pairs.remove(i);
        true
    }

    /// Whether this pair was replaced by a renewal, told only to its own asker.
    pub fn replaced(&self, id: &str, secret: &str) -> bool {
        let mut st = self.lock();
        let at = (self.now)();
        st.replaced.retain(|_, (_, t)| at - *t <= PAIR_LIFE);
        st.replaced.get(id).is_some_and(|(s, _)| s == secret)
    }

    pub fn pending(&self) -> Vec<PendingPair> {
        let mut st = self.lock();
        self.sweep_pairs(&mut st);
        st.pairs
            .iter()
            .filter(|p| p.state == PairState::Waiting)
            .map(|p| PendingPair {
                id: p.id.clone(),
                label: p.label.clone(),
                addr: p.addr.clone(),
                code: p.code.clone(),
                at: p.at,
                kind: p.kind,
            })
            .collect()
    }

    fn settle(&self, st: &mut State, id: &str, to: PairState, user: Option<&str>) -> bool {
        self.sweep_pairs(st);
        let Some(p) = st
            .pairs
            .iter_mut()
            .find(|p| p.id == id && p.state == PairState::Waiting)
        else {
            return false;
        };
        p.state = to;
        if let Some(user) = user {
            p.user = Some(user.to_string());
        }
        true
    }

    /// `user` is the person the device is approved as; none is the owner.
    pub fn approve(&self, id: &str, user: Option<&str>) -> bool {
        let mut st = self.lock();
        self.settle(&mut st, id, PairState::Approved, user)
    }

    pub fn deny(&self, id: &str) -> bool {
        let mut st = self.lock();
        self.settle(&mut st, id, PairState::Denied, None)
    }

    /// What the asker holding the secret gets: its token once approved (once
    /// only), Waiting until then, None for a wrong secret, a denial or an
    /// unknown or expired pair. The kind is the one the request asked for.
    pub fn claim(&self, id: &str, secret: &str) -> Option<Claim> {
        let mut st = self.lock();
        self.sweep_pairs(&mut st);
        let i = st.pairs.iter().position(|p| p.id == id)?;
        if st.pairs[i].secret != secret {
            return None;
        }
        if st.pairs[i].state == PairState::Waiting {
            return Some(Claim::Waiting);
        }
        let p = st.pairs.remove(i);
        if p.state == PairState::Denied {
            return None;
        }
        let opts = MintOpts {
            label: p.label,
            user: p.user,
            ..MintOpts::default()
        };
        Some(Claim::Token(
            self.mint_locked(&mut st, p.kind.into(), opts).token,
        ))
    }

    /// Whether a claim with this secret is a wrong guess at a live pair, the
    /// one kind of failed claim worth counting.
    pub fn wrong_secret(&self, id: &str, secret: &str) -> bool {
        let mut st = self.lock();
        self.sweep_pairs(&mut st);
        st.pairs.iter().any(|p| p.id == id && p.secret != secret)
    }

    fn first_code_locked(
        &self,
        st: &mut State,
        counts: &dyn Fn(&Caller) -> bool,
    ) -> Option<String> {
        let at = (self.now)();
        let live = st.callers.iter().any(|c| {
            c.caller.id != LOOPBACK_ID
                && is_session(c.caller.kind)
                && at - c.caller.used <= SESSION_IDLE
                && counts(&c.caller)
        });
        if live {
            return None;
        }
        Some(st.first.get_or_insert_with(pair_code).clone())
    }

    /// The code shown in the server's own log while nobody can approve a pair:
    /// there is one only while the book holds no live page or cli session that
    /// `counts`. None for `counts` counts every one. `counts` runs under the
    /// book's lock, so it must not call back into the book.
    pub fn first_code(&self, counts: Option<&dyn Fn(&Caller) -> bool>) -> Option<String> {
        let mut st = self.lock();
        self.first_code_locked(&mut st, counts.unwrap_or(&|_| true))
    }

    /// The first code approves a waiting pair, once; the code is burned.
    pub fn use_first(
        &self,
        given: &str,
        pair_id: &str,
        counts: Option<&dyn Fn(&Caller) -> bool>,
    ) -> bool {
        let mut st = self.lock();
        let Some(have) = self.first_code_locked(&mut st, counts.unwrap_or(&|_| true)) else {
            return false;
        };
        if given != have {
            return false;
        }
        if !self.settle(&mut st, pair_id, PairState::Approved, None) {
            return false;
        }
        st.first = None;
        true
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // a panic elsewhere while holding the lock leaves the data as it was;
    // keep serving rather than poisoning every later call
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Only a missing file is an empty book. A file that cannot be read or parsed
/// is moved aside, not overwritten, and the book starts empty.
fn load(file: &Path) -> Vec<Kept> {
    let reason = match fs::read(file) {
        Ok(bytes) => match parse_kept(&String::from_utf8_lossy(&bytes)) {
            Some(parsed) => return parsed,
            None => "not a JSON array".to_string(),
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(err) => err.to_string(),
    };
    let aside = PathBuf::from(format!("{}.corrupt-{}", file.display(), now_ms()));
    let moved = match fs::rename(file, &aside) {
        Ok(()) => aside.display().to_string(),
        Err(err) => format!("{} (move failed: {err})", aside.display()),
    };
    eprintln!(
        "callers: {} could not be read ({reason}); moved to {moved}; every page, CLI and helper must sign in again",
        file.display()
    );
    Vec::new()
}

fn write_file(file: &Path, callers: &[Kept]) -> io::Result<()> {
    let text = file_text(callers)?;
    let dir = file
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    let base = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let hex: String = random_bytes(4).iter().map(|b| format!("{b:02x}")).collect();
    let tmp = dir.join(format!(
        ".{base}.{}.{}.{hex}.tmp",
        std::process::id(),
        now_ms()
    ));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let written = opts
        .open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()));
    if let Err(err) = written.and_then(|()| fs::rename(&tmp, file)) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}
