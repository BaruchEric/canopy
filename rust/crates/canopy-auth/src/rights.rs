//! The route table and the rights each kind of caller holds (port of
//! `src/core/callers.ts`). The server checks `needs(method, path)` against
//! `allows(kind, right)` at the top of every request.
//!
//! The default denies: a route that is not a GET and not in the table needs
//! `admin`, so a new route is safe until someone files it here. A GET needs
//! `read` unless the table names it, and `read` is held by every caller with
//! a token and by nobody without one. What a caller with no token gets is the
//! short list filed `open`: the page's own files, what signing in needs, and
//! the few answers a script with no token asks for (`OPEN_READS`).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

/// A right a caller may hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Right {
    Read,
    Plan,
    Operate,
    Shell,
    Admin,
    Helper,
}

impl Right {
    /// Every right, in the order `rights_of` lists them.
    pub const ALL: [Right; 6] = [
        Right::Read,
        Right::Plan,
        Right::Operate,
        Right::Shell,
        Right::Admin,
        Right::Helper,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Right::Read => "read",
            Right::Plan => "plan",
            Right::Operate => "operate",
            Right::Shell => "shell",
            Right::Admin => "admin",
            Right::Helper => "helper",
        }
    }
}

impl fmt::Display for Right {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a route needs: nothing (`Open`) or one right.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Need {
    Open,
    Right(Right),
}

impl Need {
    pub fn as_str(self) -> &'static str {
        match self {
            Need::Open => "open",
            Need::Right(r) => r.as_str(),
        }
    }
}

impl From<Right> for Need {
    fn from(r: Right) -> Self {
        Need::Right(r)
    }
}

impl fmt::Display for Need {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Who is calling, by the kind of token it holds. `None` is no token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallerKind {
    Page,
    Cli,
    Shell,
    Ranger,
    Coordinator,
    Run,
    Helper,
    None,
}

impl CallerKind {
    pub const ALL: [CallerKind; 8] = [
        CallerKind::Page,
        CallerKind::Cli,
        CallerKind::Shell,
        CallerKind::Ranger,
        CallerKind::Coordinator,
        CallerKind::Run,
        CallerKind::Helper,
        CallerKind::None,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CallerKind::Page => "page",
            CallerKind::Cli => "cli",
            CallerKind::Shell => "shell",
            CallerKind::Ranger => "ranger",
            CallerKind::Coordinator => "coordinator",
            CallerKind::Run => "run",
            CallerKind::Helper => "helper",
            CallerKind::None => "none",
        }
    }

    /// The kind a stored or sent string names, exactly.
    pub fn parse(s: &str) -> Option<CallerKind> {
        CallerKind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

impl fmt::Display for CallerKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The kinds a pair request may ask for: the ones a person or a helper signs
/// in as, never a shell, ranger or coordinator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairKind {
    Page,
    Cli,
    Helper,
}

pub const PAIR_KINDS: [PairKind; 3] = [PairKind::Page, PairKind::Cli, PairKind::Helper];

impl PairKind {
    pub fn as_str(self) -> &'static str {
        CallerKind::from(self).as_str()
    }

    pub fn parse(s: &str) -> Option<PairKind> {
        PAIR_KINDS.into_iter().find(|k| k.as_str() == s)
    }
}

impl From<PairKind> for CallerKind {
    fn from(k: PairKind) -> Self {
        match k {
            PairKind::Page => CallerKind::Page,
            PairKind::Cli => CallerKind::Cli,
            PairKind::Helper => CallerKind::Helper,
        }
    }
}

/// The kinds a person holds: a page and the CLI. Shell, ranger, coordinator
/// and run tokens are agents', so only these steer a run mid-turn or stop its
/// turn (FR-066). No caller at all, outside enforce, counts as a person.
pub fn is_person(kind: Option<CallerKind>) -> bool {
    matches!(kind, None | Some(CallerKind::Page) | Some(CallerKind::Cli))
}

/// The kind a label names, for a request that does not say: "cli " a CLI,
/// "helper " a helper, anything else a page.
pub fn kind_of_label(label: &str) -> PairKind {
    if label.starts_with("cli ") {
        PairKind::Cli
    } else if label.starts_with("helper ") {
        PairKind::Helper
    } else {
        PairKind::Page
    }
}

/// The rights each kind holds.
pub fn kind_rights(kind: CallerKind) -> &'static [Right] {
    use Right::*;
    match kind {
        CallerKind::Page => &[Read, Operate, Shell, Admin],
        CallerKind::Cli => &[Read, Operate, Admin],
        CallerKind::Shell => &[Read, Operate],
        CallerKind::Ranger => &[Read, Operate],
        CallerKind::Coordinator => &[Read, Plan],
        CallerKind::Run => &[Read, Plan],
        CallerKind::Helper => &[Helper],
        // nobody known reads nothing: only an open route answers
        CallerKind::None => &[],
    }
}

const COORDINATOR_LANE: &[&str] = &[
    "GET /api/about",
    "GET /api/tree",
    "GET /api/trees",
    "GET /api/runs",
    "GET /api/landing",
    "GET /api/loadouts",
    "GET /api/coordinator/workflows",
    "POST /api/coordinator/plan",
];

const RUN_LANE: &[&str] = &[
    "GET /api/tree",
    "GET /api/runs",
    "GET /api/landing",
    "GET /api/health",
    "GET /api/auth",
    "POST /api/runs/child",
    "POST /api/runs/say",
    "POST /api/ranger/wakes",
    "POST /api/work/note",
];

/// What a kind held to a lane may call, as "METHOD /exact/path"; a kind with
/// no lane is held by the table alone. A coordinator gets the reads its brief
/// names, /api/about, the kept trees, and its plan. A run gets the reads its
/// tools make and the four plan routes, each of which also holds a run's
/// token to its own run in its handler (FR-038).
pub fn lane(kind: CallerKind) -> Option<&'static [&'static str]> {
    match kind {
        CallerKind::Coordinator => Some(COORDINATOR_LANE),
        CallerKind::Run => Some(RUN_LANE),
        _ => None,
    }
}

/// `open` routes are the ones pairing needs before a caller has a token.
/// Whoever may operate may also plan.
pub fn allows(kind: CallerKind, need: impl Into<Need>) -> bool {
    match need.into() {
        Need::Open => true,
        Need::Right(right) => {
            let held = kind_rights(kind);
            held.contains(&right) || (right == Right::Plan && held.contains(&Right::Operate))
        }
    }
}

struct Rule {
    methods: &'static [&'static str],
    paths: Vec<String>,
    need: Need,
}

const POST: &[&str] = &["POST"];
const DEL: &[&str] = &["DELETE"];
const GET: &[&str] = &["GET"];
const POST_DEL: &[&str] = &["POST", "DELETE"];
const REPO_OPERATE: &[&str] = &[
    "run",
    "flow",
    "resume",
    "stage",
    "commit",
    "push",
    "dropstale",
    "pull",
    "unlock",
    "note",
    "favorite",
    "harness",
    "spec",
    "suggest",
    "refresh",
    "floorplan",
    "archify",
    "diagnosis",
    "understand",
];

/// The GETs a caller with no token gets, each for a reason: the build and the
/// machine's name, the mode and who the caller is, what a redeploy would cut
/// off, one boolean for a shell's hook, and Linear's install and its return.
const OPEN_READS: &[&str] = &[
    "about",
    "auth",
    "going",
    "terms/watched",
    "linear/install",
    "linear/callback",
];

fn rule(methods: &'static [&'static str], paths: &[&str], need: Need) -> Rule {
    Rule {
        methods,
        paths: paths.iter().map(|p| (*p).to_string()).collect(),
        need,
    }
}

/// Paths are written without `/api/`. A trailing `/*` matches anything below.
/// The comments in `src/core/callers.ts` say why each row is what it is.
fn rules() -> Vec<Rule> {
    use Right::*;
    let open = Need::Open;
    let r = |x: Right| Need::Right(x);
    vec![
        rule(GET, OPEN_READS, open),
        rule(POST, &["runs/prune"], r(Admin)),
        rule(GET, &["runs/*"], r(Operate)),
        rule(GET, &["repos/*", "landing/diff", "browse"], r(Operate)),
        rule(POST, &["grep"], r(Operate)),
        rule(
            POST,
            &["auth/pair", "auth/claim", "auth/first", "auth/ticket"],
            open,
        ),
        rule(POST, &["auth/join", "auth/signout"], open),
        rule(POST, &["people/at", "people/me"], r(Read)),
        rule(
            POST,
            &[
                "people/add",
                "people/set",
                "people/remove",
                "people/invite",
                "people/uninvite",
                "people/team",
                "people/team/remove",
            ],
            r(Admin),
        ),
        rule(POST, &["hooks/*"], open),
        rule(POST, &["triggers/*"], r(Operate)),
        rule(DEL, &["triggers/events"], r(Operate)),
        rule(POST, &["remembered/check"], open),
        rule(POST, &["repos/movecheck"], r(Read)),
        rule(
            POST,
            &[
                "runs/answer",
                "runs/stop",
                "runs/fork",
                "runs/interrupt",
                "runs/name",
                "runs/side",
                "runs/model",
            ],
            r(Operate),
        ),
        rule(POST, &["coordinator/plan"], r(Plan)),
        rule(
            POST,
            &["runs/child", "runs/say", "ranger/wakes", "work/note"],
            r(Plan),
        ),
        rule(GET, &["coordinator/workflows"], r(Read)),
        rule(
            POST,
            &[
                "coordinator/tasks",
                "coordinator/start",
                "coordinator/hold",
                "coordinator/new",
                "coordinator/followup",
            ],
            r(Operate),
        ),
        rule(DEL, &["runs", "flows", "jobs"], r(Operate)),
        rule(
            POST,
            &[
                "flows/resume",
                "flows/stop",
                "flows/pickup",
                "fleet/stop",
                "jobs/stop",
            ],
            r(Operate),
        ),
        rule(
            POST_DEL,
            &["fleet", "repos/health", "incubator", "layouts"],
            r(Operate),
        ),
        rule(DEL, &["ranger/wakes"], r(Operate)),
        rule(&["POST", "DELETE", "PATCH"], &["workspaces"], r(Operate)),
        rule(POST, &["workspaces/run", "workspaces/open"], r(Operate)),
        Rule {
            methods: POST,
            paths: REPO_OPERATE.iter().map(|a| format!("repos/{a}")).collect(),
            need: r(Operate),
        },
        rule(POST, &["repos/tasks", "repos/tasks/def"], r(Operate)),
        rule(POST, &["work/*"], r(Operate)),
        rule(POST_DEL, &["notes", "notes/*"], r(Operate)),
        rule(GET, &["clips", "clips/*"], r(Operate)),
        rule(POST_DEL, &["clips", "clips/*"], r(Operate)),
        rule(
            POST,
            &["landing/*", "groups/*", "prs/*", "incubator/*"],
            r(Operate),
        ),
        rule(POST, &["capacity/read", "capacity/release"], r(Operate)),
        rule(POST, &["worktrees/prune"], r(Operate)),
        rule(
            POST,
            &[
                "trees/add",
                "trees/remove",
                "trees/merge",
                "trees/clean",
                "trees/sync",
                "trees/auto",
            ],
            r(Operate),
        ),
        rule(
            POST,
            &["tailchan/send", "tailchan/put", "tailchan/notify"],
            r(Operate),
        ),
        rule(
            GET,
            &["tailchan", "tailchan/read", "tailchan/blob"],
            r(Operate),
        ),
        rule(
            POST,
            &[
                "asks/answer",
                "presence",
                "presence/beat",
                "layouts/reset",
                "rescan",
                "preview",
            ],
            r(Operate),
        ),
        rule(POST_DEL, &["push/subscribe"], r(Operate)),
        rule(POST, &["push/test"], r(Admin)),
        rule(GET, &["push"], r(Admin)),
        rule(
            POST,
            &[
                "voice/session",
                "voice/live",
                "voice/dictate",
                "voice/ended",
            ],
            r(Operate),
        ),
        rule(
            POST,
            &[
                "terms/restore",
                "terms/paste",
                "terms/move/out",
                "terms/move/finish",
                "terms/move/undo",
                "repos/agent",
                "repos/movein",
            ],
            r(Shell),
        ),
        rule(POST, &["terms/say", "terms/keys"], r(Shell)),
        rule(POST, &["terms/label", "terms/place"], r(Shell)),
        rule(DEL, &["terms", "terms/kept"], r(Shell)),
        rule(GET, &["terms/move/plan", "terms/move/transcript"], r(Shell)),
        rule(
            GET,
            &["terms/screen", "terms/text", "terms/transcript"],
            r(Operate),
        ),
        // admin is also the default; these are written out so a test can pin them
        rule(
            POST,
            &[
                "agents/profile",
                "agents/role",
                "peers/sync",
                "repos/peer",
                "keep",
                "awake",
                "worktrees/warm",
                "health/heal",
                "remembered/forget",
                "capacity",
            ],
            r(Admin),
        ),
        rule(POST_DEL, &["sources"], r(Admin)),
        rule(
            POST,
            &[
                "sources/rescan",
                "kit/*",
                "secrets/*",
                "ranger",
                "ranger/restart",
                "ranger/fresh",
            ],
            r(Admin),
        ),
        rule(
            GET,
            &[
                "kit/plugins/catalog",
                "kit/plugins/details",
                "kit/plugins/commit",
            ],
            r(Operate),
        ),
        rule(
            POST,
            &["auth/approve", "auth/deny", "auth/revoke"],
            r(Admin),
        ),
        rule(&["PUT"], &["guards"], r(Admin)),
        rule(&["GET", "POST", "DELETE"], &["sweep", "sweep/*"], r(Admin)),
        rule(GET, &["scenarios"], r(Admin)),
        rule(POST_DEL, &["scenarios"], r(Admin)),
        rule(POST, &["scenarios/run"], r(Operate)),
        rule(
            POST,
            &[
                "repos/archive",
                "repos/open",
                "repos/openfile",
                "repos/emulator",
                "repos/launch",
                "repos/halt",
                "repos/install",
                "repos/uninstall",
                "repos/build",
                "repos/launcher",
            ],
            r(Admin),
        ),
    ]
}

struct Table {
    /// "METHOD path" to its need; a later row overwrites an earlier one
    exact: HashMap<String, Need>,
    /// prefix rows in table order; the first that matches wins
    prefixes: Vec<(&'static str, String, Need)>,
}

static TABLE: LazyLock<Table> = LazyLock::new(|| {
    let mut exact = HashMap::new();
    let mut prefixes = Vec::new();
    for r in rules() {
        for method in r.methods {
            for p in &r.paths {
                if let Some(prefix) = p.strip_suffix("/*") {
                    prefixes.push((*method, format!("{prefix}/"), r.need));
                } else {
                    exact.insert(format!("{method} {p}"), r.need);
                }
            }
        }
    }
    Table { exact, prefixes }
});

/// the table's need for a path written without `/api/`, if it has one
fn ruled(method: &str, rel: &str) -> Option<Need> {
    let t = &*TABLE;
    t.exact
        .get(&format!("{method} {rel}"))
        .copied()
        .or_else(|| {
            t.prefixes
                .iter()
                .find(|(m, prefix, _)| *m == method && rel.starts_with(prefix.as_str()))
                .map(|(_, _, need)| *need)
        })
}

/// The Library GETs that only read: the dashboard and its ports page (an
/// iframe's load carries no token, so these are open), the engine's ping,
/// manifest and state reads, and its file listing. Every other Library GET
/// needs admin: `/open` launches an editor, a terminal or a dev server, and a
/// path the engine reads differently from this table must not slip past it.
static LIBRARY_READS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "/api/library",
        "/api/library/sync",
        "/api/library/sync/status",
        "/library",
        "/library/",
        "/library/index.html",
        "/library/ports",
        "/library/ping",
        "/library/manifest",
        "/library/api/dev/state",
        "/library/api/ports/state",
        "/library/api/files",
    ]
    .into_iter()
    .collect()
});

/// `decodeURIComponent`: every `%XX` decoded, the result valid UTF-8 or
/// nothing. A `%` without two hex digits after it is no decoding either.
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            let hi = bytes.get(i + 1).copied().filter(u8::is_ascii_hexdigit)?;
            let lo = bytes.get(i + 2).copied().filter(u8::is_ascii_hexdigit)?;
            out.push(hex_val(hi) * 16 + hex_val(lo));
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        _ => b - b'A' + 10,
    }
}

/// A path cut at `;` and `?`, its repeated slashes collapsed and
/// percent-decoded once; None when it will not decode.
pub fn normal_path(path: &str) -> Option<String> {
    let cut = path.split([';', '?']).next().unwrap_or("");
    let mut collapsed = String::with_capacity(cut.len());
    let mut slash = false;
    for c in cut.chars() {
        if c == '/' {
            if slash {
                continue;
            }
            slash = true;
        } else {
            slash = false;
        }
        collapsed.push(c);
    }
    decode_uri_component(&collapsed)
}

/// Whether a Library GET only reads: a path already in normal form, on the
/// allowlist as written.
fn library_read(path: &str) -> bool {
    normal_path(path).as_deref() == Some(path) && LIBRARY_READS.contains(path)
}

/// The need a request has. `path` is the URL path, with or without a trailing
/// slash outside the Library, where the path must match exactly. A HEAD is
/// not mapped to GET here; the gate does that.
pub fn needs(method: &str, path: &str) -> Need {
    let is_library = path == "/api/library"
        || path.starts_with("/api/library/")
        || path == "/library"
        || path.starts_with("/library/");
    if is_library {
        return if method == "GET" && library_read(path) {
            Need::Open
        } else {
            Need::Right(Right::Admin)
        };
    }
    let clean = match path.strip_suffix('/') {
        Some(cut) if path.len() > 1 => cut,
        _ => path,
    };
    if method == "GET" {
        if clean == "/api/term" {
            return Need::Right(Right::Shell);
        }
        if clean == "/api/helper" {
            return Need::Right(Right::Helper);
        }
        // outside the API a GET is one of the page's own files
        let Some(rel) = clean.strip_prefix("/api/") else {
            return Need::Open;
        };
        // an API GET reads unless the table says otherwise
        return ruled(method, rel).unwrap_or(Need::Right(Right::Read));
    }
    let Some(rel) = clean.strip_prefix("/api/") else {
        return Need::Right(Right::Admin);
    };
    ruled(method, rel).unwrap_or(Need::Right(Right::Admin))
}
