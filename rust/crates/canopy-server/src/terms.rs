//! The shells behind the page's terminals, on tmux (the shell half of
//! src/server/index.ts and src/core/tmux.ts's calls). Every shell is a
//! session on canopy's own tmux server, `<config>/tmux.sock`, so it
//! outlives the socket and the server; every socket on it runs a tmux
//! client of its own on a pty (`pty.rs`). The session carries the repo,
//! place, path, handle and label as options, so the list is enough to
//! rebuild what the page reads after a restart.
//!
//! Which way each route goes:
//! - `GET /api/term` (the websocket): the same query, frames and close
//!   codes as the Bun server's. Keystrokes go down as binary frames and the
//!   pty's output comes back the same way; a resize is a JSON text frame,
//!   and the shell's exit one JSON text frame (`{"exit":code}`) before a
//!   1000 close. A rejoin for a shell that is gone closes with 4404, a
//!   failed start with 1011. A new session gets the Bun server's
//!   environment: `CANOPY_TERM`, `CANOPY_BACKEND`, `CANOPY_REPO`,
//!   `CANOPY_API` (once the server listens), a shell token minted for the
//!   caller's person, `TZ`, and `TAILCHAN_AS` while a broker is set.
//!   What this port does not do yet answers 501 before the upgrade or 1011
//!   after it, never a shell that differs from the Bun server's: a plain
//!   pty (no tmux, or `CANOPY_TMUX=0`), a shell in a kept worktree
//!   (`tree=`, or a card of the trees source, whose environment names the
//!   tree), the ranger's session, and a start that types an agent in
//!   (`start=agent`; a join onto a held shell still goes ahead).
//! - `GET /api/terms`: tmux's sessions, the map brought in line with them
//!   first, as `listTerms` does. `GET /api/terms/kept`: the records on disk
//!   minus the expired ones and the live sessions; the expired ones stay
//!   on disk here, where the Bun server deletes them.
//! - `DELETE /api/terms`: ends a shell, refused while an agent runs in it
//!   unless `force=1`, as the Bun server does. A session on the tmux server
//!   that is neither a shell nor a task (the ranger's) answers 501.
//! - `GET /api/terms/text`, `/screen`, `/watched`, `/agent` and `POST
//!   /api/terms/label`, `/place`, `/keys`: thin over tmux, as the Bun
//!   server's.
//! - Every other `/api/terms/*` route (restore, paste, say, transcript,
//!   move, a kept record's DELETE) answers 501 through the fallback.
//!
//! Left out: the keep pass that snapshots shells, the sweep's end, the
//! activity line "opened a shell", and moves. The tmux client's
//! environment also goes without `TMUX` and `TMUX_PANE`, where the Bun
//! server passes its own on: a server started inside a tmux pane would
//! otherwise find every attach refused as nested.

use axum::Json;
use axum::Router;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use canopy_auth::{AuthPeople, CallerBook, MintOpts, rights::CallerKind};
use canopy_core::backends::{config_self, self_name};
use canopy_core::exec::{ExecOptions, ExecResult, exec};
use canopy_core::host::parse_locator;
use canopy_core::keep::{
    KEEP_DAYS, agent_in, clean_label, expired_shells, forget_kept, list_kept, lost_shells,
};
use canopy_core::shellname::is_shell_command;
use canopy_core::store::flag;
use canopy_core::term::{
    INHERITED_ENV, PRIVATE_ENV, TRIGGER_ENV_PREFIX, TermSize, is_keystroke, is_term_id,
    parse_term_message, shell_args, shell_handle, term_env, term_place, term_size,
};
use canopy_core::tmux::{
    HISTORY_LINES, PaneInfo, TmuxMeta, TmuxSession, attach_args, capture_args, has_args,
    history_size_args, is_duplicate, keys_args, kill_args, label_args, list_args, new_session_args,
    no_server, pane_args, parse_pane, parse_sessions, place_args, prime_text, screen_args,
    text_args, tmux_argv,
};
use canopy_core::types::now_ms;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::OnceCell;

use crate::app::AppState;
use crate::gate::{GateCaller, Gatekeeper};
use crate::pty::{PtyCommand, PtyEvent, PtyProcess, spawn_on_pty};
use crate::routes::not_ported;
use crate::tree::TREES_SOURCE;

/// the close code for a socket naming a shell that is gone (`TERM_GONE`)
pub const TERM_GONE: u16 = 4404;
/// how long after a keystroke a shell counts as watched (`WATCH_SPAN`)
pub const WATCH_SPAN_MS: i64 = 2 * 60_000;
/// where tmux sits when PATH does not say (a launchd job gets a bare one)
const TMUX_PLACES: [&str; 3] = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
];

/// `CANOPY_API` off the address the server binds (`apiUrlFor`): loopback
/// for a loopback or wildcard bind, else that address itself.
pub fn api_url_for(bind: &str, port: u16) -> String {
    let any =
        matches!(bind, "0.0.0.0" | "::" | "[::]" | "localhost" | "::1") || bind.starts_with("127.");
    let host = if any {
        "127.0.0.1".to_string()
    } else if bind.contains(':') && !bind.starts_with('[') {
        format!("[{bind}]")
    } else {
        bind.to_string()
    };
    format!("http://{host}:{port}")
}

/// this process's own address, set once it listens
static API_URL: OnceLock<String> = OnceLock::new();

/// Records the address the server listens on, for the shells it starts.
pub fn listening(bind: &str, port: u16) {
    let _ = API_URL.set(api_url_for(bind, port));
}

/// The tmux binary, or None when there is none to find (`findTmux`).
pub fn find_tmux() -> Option<String> {
    crate::harnesses::find_binary("tmux").or_else(|| {
        TMUX_PLACES
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .map(|p| p.to_string())
    })
}

/// The environment the tmux commands and clients get: this process's, less
/// what canopy keeps from every shell (`INHERITED_ENV`, its secrets, the
/// trigger rules' secrets) and the outer tmux's names.
pub fn child_env(vars: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    vars.filter(|(k, _)| {
        !INHERITED_ENV.contains(&k.as_str())
            && !PRIVATE_ENV.contains(&k.as_str())
            && !k.starts_with(TRIGGER_ENV_PREFIX)
            && k != "TMUX"
            && k != "TMUX_PANE"
    })
    .collect()
}

/// One shell as `GET /api/terms` lists it (`TermInfo` in core/types.ts).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub repo_id: String,
    pub path: String,
    pub place: String,
    pub attached: bool,
    pub viewers: Vec<String>,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
}

/// One shell the server holds and the sockets on it, by key with the
/// device each belongs to. `ending` is shared with every socket task on it,
/// and doubles as the shell's identity: a socket's held shell is the one in
/// the map only while the two are the same `Arc`.
struct Live {
    info: TermInfo,
    sockets: HashMap<u64, Option<String>>,
    ending: Arc<AtomicBool>,
    last_input: Option<i64>,
}

impl Live {
    fn new(info: TermInfo) -> Live {
        Live {
            info,
            sockets: HashMap::new(),
            ending: Arc::new(AtomicBool::new(false)),
            last_input: None,
        }
    }

    fn ending(&self) -> bool {
        self.ending.load(Ordering::SeqCst)
    }
}

/// What the shells are started with.
pub struct TermsSetup {
    /// the argv front for canopy's tmux server, or None for none
    pub tmux: Option<Vec<String>>,
    /// the login shell a session runs (`userShell`)
    pub shell: String,
    /// the environment of every tmux command and client
    pub env: Vec<(String, String)>,
    pub book: Arc<CallerBook>,
    /// this server's own address, when it is not the process-wide one
    pub api_url: Option<String>,
}

pub struct Terms {
    tmux: Option<Vec<String>>,
    shell: String,
    env: Vec<(String, String)>,
    /// canopy's own `TZ`, handed to each new session
    tz: Mutex<Option<String>>,
    book: Arc<CallerBook>,
    api_url: Option<String>,
    live: Mutex<HashMap<String, Live>>,
    next_socket: AtomicU64,
    loaded: OnceCell<()>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// a JSON error with a status
fn refuse(status: u16, error: &str) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(json!({ "error": error }))).into_response()
}

impl Terms {
    pub fn new(s: TermsSetup) -> Terms {
        let tz = s
            .env
            .iter()
            .find(|(k, v)| k == "TZ" && !v.is_empty())
            .map(|(_, v)| v.clone());
        Terms {
            tmux: s.tmux,
            shell: s.shell,
            env: s.env,
            tz: Mutex::new(tz),
            book: s.book,
            api_url: s.api_url,
            live: Mutex::new(HashMap::new()),
            next_socket: AtomicU64::new(1),
            loaded: OnceCell::new(),
        }
    }

    /// As the Bun server's `tmuxBase()` finds it: tmux on this machine and
    /// not turned off, on `<config>/tmux.sock` with canopy's `lib/tmux.conf`.
    pub fn from_state(s: &AppState, book: Arc<CallerBook>) -> Terms {
        let tmux = if s.gates.tmux {
            find_tmux().map(|bin| {
                tmux_argv(
                    &bin,
                    &format!("{}/tmux.sock", s.config_dir),
                    &format!("{}/lib/tmux.conf", canopy_core::version::canopy_dir()),
                )
            })
        } else {
            None
        };
        Terms::new(TermsSetup {
            tmux,
            shell: crate::harnesses::user_shell(),
            env: child_env(std::env::vars()),
            book,
            api_url: None,
        })
    }

    #[cfg(test)]
    fn set_tz(&self, tz: Option<&str>) {
        *lock(&self.tz) = tz.map(String::from);
    }

    fn api_url(&self) -> Option<String> {
        self.api_url.clone().or_else(|| API_URL.get().cloned())
    }

    async fn run(&self, argv: &[String], timeout_ms: u64) -> ExecResult {
        exec(
            argv,
            &ExecOptions {
                timeout_ms: Some(timeout_ms),
                base: Some(self.env.clone()),
                ..ExecOptions::default()
            },
        )
        .await
    }

    /// the sessions canopy's server holds; none when it is not running
    async fn list_sessions(&self, base: &[String]) -> Result<Vec<TmuxSession>, String> {
        let r = self.run(&list_args(base), 10_000).await;
        if r.code != 0 {
            if no_server(&r.stderr) {
                return Ok(vec![]);
            }
            let why = r.stderr.trim();
            return Err(if why.is_empty() {
                "tmux could not list its sessions".into()
            } else {
                why.into()
            });
        }
        Ok(parse_sessions(&r.stdout, now_ms()))
    }

    async fn has_session(&self, base: &[String], id: &str) -> bool {
        self.run(&has_args(base, id), 10_000).await.code == 0
    }

    /// whether the tmux server answers at all (`serverUp`)
    async fn server_up(&self, base: &[String]) -> bool {
        self.run(&list_args(base), 10_000).await.code == 0
    }

    async fn new_session(
        &self,
        base: &[String],
        meta: &TmuxMeta,
        size: TermSize,
    ) -> Result<(), String> {
        let command = shell_args(&meta.path, &self.shell);
        let r = self
            .run(&new_session_args(base, meta, size, &command), 15_000)
            .await;
        if r.code != 0 && !is_duplicate(&r.stderr) {
            let why = r.stderr.trim();
            return Err(if why.is_empty() {
                "tmux could not start the shell".into()
            } else {
                why.into()
            });
        }
        Ok(())
    }

    /// What a new client is sent before tmux draws for it (`history`).
    async fn history(&self, base: &[String], id: &str, rows: u16) -> String {
        let size = self.run(&history_size_args(base, id), 10_000).await;
        let n = canopy_core::term::js_number(size.stdout.trim());
        if size.code != 0 || !n.is_finite() || n <= 0.0 {
            return String::new();
        }
        let r = self
            .run(&capture_args(base, id, HISTORY_LINES), 10_000)
            .await;
        if r.code == 0 {
            prime_text(&r.stdout, rows)
        } else {
            String::new()
        }
    }

    async fn pane_info(&self, base: &[String], id: &str) -> Option<PaneInfo> {
        let r = self.run(&pane_args(base, id), 10_000).await;
        (r.code == 0).then(|| parse_pane(&r.stdout))
    }

    /// Brings the map in line with tmux's sessions (`listTerms`): another
    /// canopy on the same config dir may have made or ended one. Without
    /// tmux there is nothing to read.
    async fn reconcile(&self) -> Result<(), String> {
        let Some(base) = &self.tmux else {
            return Ok(());
        };
        let sessions = self.list_sessions(base).await?;
        let mut gone = vec![];
        {
            let mut live = lock(&self.live);
            for s in &sessions {
                live.entry(s.id.clone()).or_insert_with(|| {
                    Live::new(TermInfo {
                        id: s.id.clone(),
                        repo_id: s.repo_id.clone(),
                        path: s.path.clone(),
                        place: s.place.clone(),
                        attached: false,
                        viewers: vec![],
                        started_at: s.created_at,
                        handle: s.handle.clone(),
                        task: s.task.clone(),
                        label: s.label.clone(),
                        who: None,
                    })
                });
            }
            live.retain(|id, _| {
                let seen = sessions.iter().any(|s| &s.id == id);
                if !seen {
                    gone.push(id.clone());
                }
                seen
            });
        }
        for id in gone {
            let _ = self.book.drop_term(&id);
        }
        Ok(())
    }

    /// The first reconcile, once: the shells the last server left on tmux,
    /// so a browser rejoining finds them held, then the shell tokens whose
    /// shell did not come back dropped. A tmux that will not answer leaves
    /// the tokens be.
    async fn ensure_loaded(&self) {
        self.loaded
            .get_or_init(|| async {
                if self.reconcile().await.is_ok() {
                    let held: std::collections::HashSet<String> =
                        lock(&self.live).keys().cloned().collect();
                    let _ = self.book.prune(&held);
                }
            })
            .await;
    }

    /// One shell as the list shows it (`termInfo`): attached when any
    /// socket is on it, the devices behind those sockets by name, and whose
    /// shell it is off its token.
    fn info_of(&self, live: &Live, devices: &[Value]) -> TermInfo {
        let mut viewers: Vec<String> = vec![];
        for device in live.sockets.values().flatten() {
            let name = devices
                .iter()
                .find(|d| d.get("id").and_then(Value::as_str) == Some(device.as_str()))
                .and_then(|d| d.get("name").and_then(Value::as_str));
            if let Some(n) = name
                && !viewers.iter().any(|v| v == n)
            {
                viewers.push(n.to_string());
            }
        }
        TermInfo {
            attached: !live.sockets.is_empty(),
            viewers,
            who: self.book.user_of_term(&live.info.id),
            ..live.info.clone()
        }
    }

    /// The shells, as the page reads them; tasks left out.
    fn infos(&self, s: &AppState, with_ending: bool) -> Vec<TermInfo> {
        let devices = s.presence.devices();
        let live = lock(&self.live);
        let mut list: Vec<&Live> = live
            .values()
            .filter(|l| l.info.task.is_none() && (with_ending || !l.ending()))
            .collect();
        list.sort_by_key(|l| (l.info.started_at, l.info.id.clone()));
        list.into_iter()
            .map(|l| self.info_of(l, &devices))
            .collect()
    }

    /// The shells to every stream (`tellTerms`), one being ended left out.
    fn tell_terms(&self, s: &AppState) {
        let terms = self.infos(s, false);
        let _ = s
            .events
            .send(json!({ "type": "terms", "terms": terms }).to_string());
    }

    fn live_ids(&self) -> Vec<String> {
        lock(&self.live).keys().cloned().collect()
    }

    /// The records offered for a restore: not expired, and answered by no
    /// live shell.
    fn lost(&self, config_dir: &str) -> Vec<canopy_core::keep::KeptShell> {
        let all = list_kept(config_dir);
        let gone = expired_shells(&all, now_ms() as f64, KEEP_DAYS);
        let left: Vec<_> = all.into_iter().filter(|k| !gone.contains(&k.id)).collect();
        lost_shells(&left, &self.live_ids())
    }

    /// Lets go of a shell here: out of the map, its token dropped.
    fn drop_live(&self, id: &str, held: Option<&Arc<AtomicBool>>) -> bool {
        let mut live = lock(&self.live);
        let same = match (live.get(id), held) {
            (Some(l), Some(h)) => Arc::ptr_eq(&l.ending, h),
            (Some(_), None) => true,
            (None, _) => false,
        };
        if same {
            live.remove(id);
            drop(live);
            let _ = self.book.drop_term(id);
        }
        same
    }

    /// `newProcessEnv` and `sessionEnv`: where the shell runs and a fresh
    /// token for its person, then canopy's `TZ`. None of it for an ssh line,
    /// which would leave them on this side of the connection.
    fn session_env(
        &self,
        s: &AppState,
        repo_id: &str,
        path: &str,
        id: &str,
        user: &str,
    ) -> Vec<(String, String)> {
        if parse_locator(path).host.is_some() {
            return vec![];
        }
        let raw = (s.config)().map(|c| c.raw).unwrap_or(Value::Null);
        let backend = self_name(config_self(&raw).as_deref(), &s.hostname);
        let mut env = vec![
            ("CANOPY_TERM".to_string(), id.to_string()),
            ("CANOPY_BACKEND".into(), backend),
            ("CANOPY_REPO".into(), repo_id.to_string()),
        ];
        if let Some(api) = self.api_url() {
            env.push(("CANOPY_API".into(), api));
        }
        // the book keeps hashes and cannot hand an old token back
        let _ = self.book.drop_term(id);
        let minted = self.book.mint(
            CallerKind::Shell,
            MintOpts::label(format!("shell {repo_id}"))
                .term(id)
                .user(user),
        );
        env.push(("CANOPY_TOKEN".into(), minted.token));
        if let Some(tz) = lock(&self.tz).clone() {
            env.push(("TZ".into(), tz));
        }
        env
    }
}

/// The agent a pane runs (`paneAgent`): what tmux says, and when that names
/// nothing and the pane is not at a shell prompt, the argv under it.
async fn pane_agent(pane: &PaneInfo) -> Option<&'static str> {
    let quick = agent_in(&pane.command, &pane.title, &[]);
    let Some(pid) = pane.pid else { return quick };
    if quick.is_some() || is_shell_command(&pane.command) {
        return quick;
    }
    let tree = tokio::task::spawn_blocking(move || canopy_core::procs::process_tree(pid))
        .await
        .unwrap_or_default();
    agent_in(&pane.command, &pane.title, &tree)
}

fn query(uri: &Uri) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (k, v) in form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()) {
        out.entry(k.into_owned()).or_insert_with(|| v.into_owned());
    }
    out
}

fn q<'a>(map: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    map.get(key).map(String::as_str)
}

/// `GET /api/terms`: every shell, tmux's sessions the truth.
async fn list(State(s): State<Arc<AppState>>, Extension(t): Extension<Arc<Terms>>) -> Response {
    t.ensure_loaded().await;
    if let Err(e) = t.reconcile().await {
        return refuse(500, &e);
    }
    Json(t.infos(&s, true)).into_response()
}

/// `GET /api/terms/kept`: whether shells are kept, and the records offered.
async fn kept(State(s): State<Arc<AppState>>, Extension(t): Extension<Arc<Terms>>) -> Response {
    t.ensure_loaded().await;
    if let Err(e) = t.reconcile().await {
        return refuse(500, &e);
    }
    let raw = match (s.config)() {
        Ok(c) => c.raw,
        Err(e) => return refuse(500, &e),
    };
    let kept: Vec<Value> = t.lost(&s.config_dir).into_iter().map(|k| k.json).collect();
    Json(json!({ "keeping": flag(&raw, "keepShells", false), "kept": kept })).into_response()
}

/// `DELETE /api/terms?term=`: ends a shell (`endTerm`).
async fn end(
    State(s): State<Arc<AppState>>,
    Extension(t): Extension<Arc<Terms>>,
    uri: Uri,
) -> Response {
    t.ensure_loaded().await;
    let qs = query(&uri);
    let term = q(&qs, "term").unwrap_or("").to_string();
    if !lock(&t.live).contains_key(&term) {
        // a task's session the map has not read yet is still a task
        let _ = t.reconcile().await;
    }
    let (held, task) = {
        let live = lock(&t.live);
        let l = live.get(&term);
        (
            l.map(|l| l.ending.clone()),
            l.is_some_and(|l| l.info.task.is_some()),
        )
    };
    if task {
        return refuse(400, "that is a task; stop it from its repo's tasks");
    }
    let Some(base) = t.tmux.clone() else {
        return refuse(404, "no such shell");
    };
    if held.is_none() && t.has_session(&base, &term).await {
        return not_ported(axum::http::Method::DELETE, uri).await;
    }
    // A tab's × asks without force, and an agent in the shell keeps it.
    if q(&qs, "force") != Some("1")
        && let Some(pane) = t.pane_info(&base, &term).await
        && pane_agent(&pane).await.is_some()
    {
        return refuse(409, "an agent is running in that shell");
    }
    let Some(held) = held else {
        return refuse(404, "no such shell");
    };
    held.store(true, Ordering::SeqCst);
    t.run(&kill_args(&base, &term), 10_000).await;
    t.drop_live(&term, Some(&held));
    forget_kept(&s.config_dir, &term);
    t.tell_terms(&s);
    Json(json!({ "ok": true })).into_response()
}

/// The shell a read names: held and not being ended.
fn held_shell(t: &Terms, term: &str) -> bool {
    lock(&t.live).get(term).is_some_and(|l| !l.ending())
}

/// `GET /api/terms/text`: the pane as plain text, for a copy.
async fn text(Extension(t): Extension<Arc<Terms>>, uri: Uri) -> Response {
    t.ensure_loaded().await;
    let qs = query(&uri);
    let term = q(&qs, "term").unwrap_or("");
    if !held_shell(&t, term) {
        return refuse(404, "no such shell");
    }
    let Some(base) = &t.tmux else {
        return Json(json!({ "text": null, "fullscreen": false })).into_response();
    };
    let Some(pane) = t.pane_info(base, term).await else {
        return refuse(502, "tmux did not answer");
    };
    let r = t
        .run(
            &text_args(base, term, pane.fullscreen, HISTORY_LINES),
            10_000,
        )
        .await;
    if r.code != 0 {
        return refuse(502, "tmux did not answer");
    }
    Json(json!({ "text": r.stdout, "fullscreen": pane.fullscreen })).into_response()
}

/// `GET /api/terms/screen`: the screen the pane shows now, for a peek.
async fn screen(Extension(t): Extension<Arc<Terms>>, uri: Uri) -> Response {
    t.ensure_loaded().await;
    let qs = query(&uri);
    let term = q(&qs, "term").unwrap_or("");
    if !held_shell(&t, term) {
        return refuse(404, "no such shell");
    }
    let Some(base) = &t.tmux else {
        return Json(json!({ "text": null })).into_response();
    };
    let r = t.run(&screen_args(base, term), 10_000).await;
    if r.code != 0 {
        return refuse(502, "tmux did not answer");
    }
    Json(json!({ "text": r.stdout })).into_response()
}

/// `GET /api/terms/watched`: whether a browser typed into it lately.
async fn watched(Extension(t): Extension<Arc<Terms>>, uri: Uri) -> Json<Value> {
    t.ensure_loaded().await;
    let qs = query(&uri);
    let at = lock(&t.live)
        .get(q(&qs, "term").unwrap_or(""))
        .filter(|l| l.info.task.is_none())
        .and_then(|l| l.last_input);
    Json(json!({ "watched": at.is_some_and(|at| now_ms() - at < WATCH_SPAN_MS) }))
}

/// `GET /api/terms/agent`: the agent running in a shell, or null.
async fn agent(Extension(t): Extension<Arc<Terms>>, uri: Uri) -> Response {
    t.ensure_loaded().await;
    let qs = query(&uri);
    let term = q(&qs, "term").unwrap_or("");
    let (held, task) = {
        let live = lock(&t.live);
        let l = live.get(term);
        (
            l.is_some_and(|l| !l.ending()),
            l.is_some_and(|l| l.info.task.is_some()),
        )
    };
    if task {
        return refuse(400, "that is a task, not a shell");
    }
    let Some(base) = t.tmux.as_ref().filter(|_| held) else {
        return Json(json!({ "agent": null })).into_response();
    };
    let agent = match t.pane_info(base, term).await {
        Some(pane) => pane_agent(&pane).await,
        None => None,
    };
    Json(json!({ "agent": agent })).into_response()
}

fn body_object(body: &[u8]) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_slice::<Value>(body).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// a shell a name or a move may go to: held, not ending, not a task
fn named_shell(t: &Terms, term: &str) -> bool {
    lock(&t.live)
        .get(term)
        .is_some_and(|l| !l.ending() && l.info.task.is_none())
}

/// `POST /api/terms/label`: names a shell by hand, or takes the name off.
async fn label(
    State(s): State<Arc<AppState>>,
    Extension(t): Extension<Arc<Terms>>,
    body: axum::body::Bytes,
) -> Response {
    t.ensure_loaded().await;
    let b = body_object(&body).unwrap_or_default();
    let (Some(term), Some(raw)) = (
        b.get("term").and_then(Value::as_str),
        b.get("label").and_then(Value::as_str),
    ) else {
        return refuse(400, "a shell in term and its name in label");
    };
    if !named_shell(&t, term) {
        return refuse(404, "no such shell");
    }
    let label = clean_label(raw);
    if let Some(base) = &t.tmux
        && t.run(
            &label_args(base, term, label.as_deref().unwrap_or("")),
            10_000,
        )
        .await
        .code
            != 0
    {
        return refuse(502, "tmux would not name that shell");
    }
    if let Some(l) = lock(&t.live).get_mut(term) {
        l.info.label = label.clone();
    }
    t.tell_terms(&s);
    let mut out = json!({ "ok": true });
    if let Some(l) = label {
        out["label"] = json!(l);
    }
    Json(out).into_response()
}

/// `POST /api/terms/place`: moves a shell to the strip or a repo's panel.
async fn place(
    State(s): State<Arc<AppState>>,
    Extension(t): Extension<Arc<Terms>>,
    body: axum::body::Bytes,
) -> Response {
    t.ensure_loaded().await;
    let b = body_object(&body).unwrap_or_default();
    let term = b.get("term").and_then(Value::as_str);
    let to = b
        .get("place")
        .and_then(Value::as_str)
        .filter(|p| *p == "panel" || *p == "strip");
    let (Some(term), Some(to)) = (term, to) else {
        return refuse(400, "a shell in term and panel or strip in place");
    };
    if !named_shell(&t, term) {
        return refuse(404, "no such shell");
    }
    if let Some(base) = &t.tmux
        && t.run(&place_args(base, term, to), 10_000).await.code != 0
    {
        return refuse(502, "tmux would not move that shell");
    }
    if let Some(l) = lock(&t.live).get_mut(term) {
        l.info.place = to.to_string();
    }
    t.tell_terms(&s);
    Json(json!({ "ok": true, "place": to })).into_response()
}

/// `POST /api/terms/keys`: Escape into a shell, which stops an agent's turn.
async fn keys(Extension(t): Extension<Arc<Terms>>, body: axum::body::Bytes) -> Response {
    t.ensure_loaded().await;
    let Some(b) = body_object(&body) else {
        return refuse(400, "malformed body");
    };
    let (Some(term), Some("escape")) = (
        b.get("term").and_then(Value::as_str),
        b.get("key").and_then(Value::as_str),
    ) else {
        return refuse(400, "a shell in term and escape in key");
    };
    // a live shell or a task's session (`steerableShell`)
    if !lock(&t.live).get(term).is_some_and(|l| !l.ending()) {
        return refuse(404, "no such shell");
    }
    let Some(base) = &t.tmux else {
        return refuse(400, "typing into a shell from here needs tmux shells");
    };
    if !t.has_session(base, term).await {
        return refuse(404, "no such shell");
    }
    t.run(&keys_args(base, term, &["Escape"], false), 10_000)
        .await;
    Json(json!({ "ok": true })).into_response()
}

/// What a terminal socket carries from the upgrade to its task.
struct Socket {
    repo_id: String,
    repo_name: String,
    path: String,
    id: String,
    place: String,
    attach: bool,
    /// a start that types an agent in, which this port refuses
    wants_agent: bool,
    label: Option<String>,
    size: TermSize,
    device: Option<String>,
    /// the person a shell this socket starts is minted for
    user: String,
}

/// `/api/term`: a shell in the browser, upgraded once the query checks out.
async fn term_socket(
    State(s): State<Arc<AppState>>,
    Extension(t): Extension<Arc<Terms>>,
    caller: Option<Extension<GateCaller>>,
    uri: Uri,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let qs = query(&uri);
    let repo_id = q(&qs, "id").unwrap_or("");
    let repo = s
        .result
        .read()
        .await
        .repos
        .iter()
        .find(|r| r.id == repo_id)
        .cloned();
    let Some(repo) = repo else {
        return refuse(404, &format!("unknown repo: {repo_id}"));
    };
    if repo.forge.is_some() {
        return refuse(
            400,
            &format!(
                "{} is on the forge; there is no folder to open a shell in",
                repo.name
            ),
        );
    }
    if q(&qs, "tree").is_some() || repo.source == TREES_SOURCE {
        return refuse(
            501,
            "a shell in a kept worktree is not in the Rust port yet",
        );
    }
    let id = q(&qs, "term").unwrap_or("");
    if !is_term_id(id) {
        return refuse(400, "a shell is named by 32 hex digits in term=");
    }
    let attach = q(&qs, "attach") == Some("1");
    let wants_agent = !attach && matches!(q(&qs, "start"), Some("agent" | "claude"));
    let device = q(&qs, "client")
        .filter(|d| d.len() == 16 && d.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .map(String::from);
    let label = if attach {
        None
    } else {
        clean_label(q(&qs, "label").unwrap_or(""))
    };
    let Some(base) = t.tmux.clone() else {
        return refuse(501, "a shell on a plain pty is not in the Rust port yet");
    };
    let caller = caller.and_then(|Extension(GateCaller(c, _))| c);
    let ctx = Socket {
        repo_id: repo.id.clone(),
        repo_name: repo.name.clone(),
        path: repo.path.clone(),
        id: id.to_string(),
        place: term_place(q(&qs, "place")).to_string(),
        attach,
        wants_agent,
        label,
        size: term_size(q(&qs, "cols"), q(&qs, "rows")),
        device,
        user: AuthPeople::id_of(&*s.people, caller.as_ref()),
    };
    match ws {
        Ok(ws) => ws.on_upgrade(move |socket| join(s, t, base, ctx, socket)),
        Err(_) => refuse(426, "a websocket is expected here"),
    }
}

type Sink = SplitSink<WebSocket, Message>;

async fn close(sink: &mut Sink, code: u16, reason: &str) {
    let mut cut: String = reason.chars().take(120).collect();
    while cut.len() > 123 {
        cut.pop();
    }
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: cut.into(),
        })))
        .await;
}

/// A socket onto a shell on tmux (`joinTmuxTerm`): the session made when
/// this is the first socket to name it, then what scrolled off before now,
/// then a client of the socket's own on the session.
async fn join(s: Arc<AppState>, t: Arc<Terms>, base: Vec<String>, ctx: Socket, socket: WebSocket) {
    let (mut sink, stream) = socket.split();
    t.ensure_loaded().await;
    let id = ctx.id.clone();
    let (held, task) = {
        let live = lock(&t.live);
        let l = live.get(&id);
        (
            l.map(|l| l.ending.clone()),
            l.is_some_and(|l| l.info.task.is_some()),
        )
    };
    // a task's session belongs to its hub: only an attach-only socket joins it
    if !ctx.attach && task {
        return close(&mut sink, TERM_GONE, "that is a task, not a shell").await;
    }
    // a name a lost shell was kept under comes back through a restore
    if held.is_none() && (ctx.attach || t.lost(&s.config_dir).iter().any(|k| k.id == id)) {
        return close(&mut sink, TERM_GONE, "that shell is gone").await;
    }
    if held.is_none() && ctx.wants_agent {
        return close(
            &mut sink,
            1011,
            "starting an agent in a shell is not in the Rust port yet",
        )
        .await;
    }
    let held = match held {
        Some(h) => {
            if !t.has_session(&base, &id).await {
                t.drop_live(&id, Some(&h));
                t.tell_terms(&s);
                return close(&mut sink, TERM_GONE, "that shell is gone").await;
            }
            h
        }
        None => {
            let local = parse_locator(&ctx.path).host.is_none();
            let handle = (s.gates.chan && local).then(|| shell_handle(&ctx.repo_name, &id));
            let meta = TmuxMeta {
                id: id.clone(),
                repo_id: ctx.repo_id.clone(),
                path: ctx.path.clone(),
                place: ctx.place.clone(),
                handle: handle.clone(),
                label: ctx.label.clone(),
                env: t.session_env(&s, &ctx.repo_id, &ctx.path, &id, &ctx.user),
            };
            if let Err(e) = t.new_session(&base, &meta, ctx.size).await {
                return close(&mut sink, 1011, &e).await;
            }
            let live = Live::new(TermInfo {
                id: id.clone(),
                repo_id: ctx.repo_id.clone(),
                path: ctx.path.clone(),
                place: ctx.place.clone(),
                attached: false,
                viewers: vec![],
                started_at: now_ms(),
                handle,
                task: None,
                label: ctx.label.clone(),
                who: None,
            });
            let h = live.ending.clone();
            lock(&t.live).insert(id.clone(), live);
            t.tell_terms(&s);
            h
        }
    };
    let missed = t.history(&base, &id, ctx.size.rows).await;
    if !missed.is_empty()
        && sink
            .send(Message::Binary(missed.into_bytes().into()))
            .await
            .is_err()
    {
        return;
    }
    let client = spawn_on_pty(
        &PtyCommand {
            argv: attach_args(&base, &id),
            cwd: None,
            env: term_env(&t.env),
        },
        ctx.size,
    );
    let client = match client {
        Ok(c) => c,
        Err(e) => return close(&mut sink, 1011, &e.to_string()).await,
    };
    let key = t.next_socket.fetch_add(1, Ordering::SeqCst);
    if let Some(l) = lock(&t.live).get_mut(&id)
        && Arc::ptr_eq(&l.ending, &held)
    {
        l.sockets.insert(key, ctx.device.clone());
    }
    t.tell_terms(&s);
    relay(s, t, base, id, key, held, client, sink, stream).await;
}

/// The socket's frames to its client and back until one side goes.
#[allow(clippy::too_many_arguments)]
async fn relay(
    s: Arc<AppState>,
    t: Arc<Terms>,
    base: Vec<String>,
    id: String,
    key: u64,
    held: Arc<AtomicBool>,
    mut client: PtyProcess,
    mut sink: Sink,
    mut stream: SplitStream<WebSocket>,
) {
    let unhook = || {
        if let Some(l) = lock(&t.live).get_mut(&id) {
            l.sockets.remove(&key);
        }
    };
    // the browser going away leaves the shell running; only its client goes
    let code = loop {
        tokio::select! {
            ev = client.next() => match ev {
                PtyEvent::Data(d) => {
                    if sink.send(Message::Binary(d.into())).await.is_err() {
                        unhook();
                        t.tell_terms(&s);
                        let code = client.hang_up().await;
                        break (code, false);
                    }
                }
                PtyEvent::Exit(code) => break (code, true),
            },
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(b))) => {
                    // a person at the keyboard, not the terminal answering a query
                    if is_keystroke(&b)
                        && let Some(l) = lock(&t.live).get_mut(&id)
                        && l.info.task.is_none()
                    {
                        l.last_input = Some(now_ms());
                    }
                    client.write(&b).await;
                }
                Some(Ok(Message::Text(text))) => {
                    if let Some(size) = parse_term_message(text.as_str()) {
                        client.resize(size);
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(_)) | Err(_)) | None => {
                    unhook();
                    t.tell_terms(&s);
                    let code = client.hang_up().await;
                    break (code, false);
                }
            },
        }
    };
    let (code, open) = code;
    unhook();
    let alive = !held.load(Ordering::SeqCst) && t.has_session(&base, &id).await;
    if alive {
        // the client went but the shell did not (a detach from inside): no
        // exit frame, so the browser rejoins and gets a new client
        if open {
            close(&mut sink, 1000, "the client detached").await;
        }
    } else {
        t.drop_live(&id, Some(&held));
        // A shell that exited leaves nothing worth restoring, but a session
        // can also be gone because its tmux server went, which is when what
        // it left is the whole point. The client exits 0 when its session
        // ended under a live server and 1 when the server went.
        if code == 0 || t.server_up(&base).await {
            forget_kept(&s.config_dir, &id);
        }
        if open {
            let _ = sink
                .send(Message::Text(json!({ "exit": code }).to_string().into()))
                .await;
            close(&mut sink, 1000, "the shell exited").await;
        }
    }
    t.tell_terms(&s);
}

/// The shell routes, over the Terms `from_state` makes for this server.
pub fn routes(state: &Arc<AppState>, keeper: &Arc<Gatekeeper>) -> Router<Arc<AppState>> {
    let t = Arc::new(Terms::from_state(state, keeper.gate.book.clone()));
    // the shells the last server left, read before a browser rejoins
    if let Ok(rt) = tokio::runtime::Handle::try_current() {
        let early = t.clone();
        rt.spawn(async move { early.ensure_loaded().await });
    }
    routes_with(t)
}

/// The shell routes over `t`.
pub fn routes_with(t: Arc<Terms>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/term", any(term_socket))
        .route("/api/terms", get(list).delete(end).fallback(not_ported))
        .route("/api/terms/kept", get(kept).fallback(not_ported))
        .route("/api/terms/text", get(text).fallback(not_ported))
        .route("/api/terms/screen", get(screen).fallback(not_ported))
        .route("/api/terms/watched", get(watched).fallback(not_ported))
        .route("/api/terms/agent", get(agent).fallback(not_ported))
        .route("/api/terms/label", post(label).fallback(not_ported))
        .route("/api/terms/place", post(place).fallback(not_ported))
        .route("/api/terms/keys", post(keys).fallback(not_ported))
        .layer(Extension(t))
}

#[cfg(test)]
mod tests {
    //! The shells behind the terminal websocket, against a real server on
    //! a scratch root with one repo, as src/server/term.test.ts drives the
    //! Bun server. Each test has a tmux server of its own on a socket under
    //! a short scratch folder (`-S`), killed when the test ends, so nothing
    //! here reaches another tmux server. The tmux tests say so and pass
    //! when this machine has no tmux.
    use super::*;
    use crate::app::{Setup, about};
    use crate::gated::Gates;
    use crate::people::People;
    use canopy_auth::{CallerGate, CallersMode, OriginPolicy};
    use canopy_core::store::CanopyConfig;
    use canopy_core::tmux::LIST_FORMAT;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message as Ws;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    /// A scratch tmux server on a socket under a short folder, ended when
    /// dropped. Every command carries its `-S`.
    struct Tmux {
        dir: tempfile::TempDir,
        base: Vec<String>,
        env: Vec<(String, String)>,
    }

    impl Tmux {
        fn new() -> Option<Tmux> {
            let Some(bin) = find_tmux() else {
                eprintln!("no tmux on this machine: the tmux test passes without running");
                return None;
            };
            let dir = tempfile::Builder::new()
                .prefix("ct")
                .tempdir_in("/tmp")
                .or_else(|_| tempfile::tempdir())
                .unwrap();
            let home = dir.path().join("home");
            std::fs::create_dir_all(&home).unwrap();
            let sock = dir.path().join("s");
            let conf = format!("{}/lib/tmux.conf", canopy_core::version::canopy_dir());
            let base = tmux_argv(&bin, sock.to_str().unwrap(), &conf);
            let env = vec![
                (
                    "PATH".to_string(),
                    std::env::var("PATH").unwrap_or_default(),
                ),
                ("HOME".into(), home.to_str().unwrap().into()),
                ("LANG".into(), "C.UTF-8".into()),
            ];
            Some(Tmux { dir, base, env })
        }

        fn run(&self, args: &[&str]) -> std::process::Output {
            std::process::Command::new(&self.base[0])
                .args(&self.base[1..])
                .args(args)
                .env_clear()
                .envs(self.env.iter().cloned())
                .output()
                .unwrap()
        }

        fn sessions(&self) -> Vec<TmuxSession> {
            let out = self.run(&["list-sessions", "-F", LIST_FORMAT]);
            parse_sessions(&String::from_utf8_lossy(&out.stdout), 0)
        }
    }

    impl Drop for Tmux {
        fn drop(&mut self) {
            let _ = self.run(&["kill-server"]);
        }
    }

    /// A scratch root with one repo, `app`, and its config dir.
    struct Root {
        dir: tempfile::TempDir,
    }

    impl Root {
        fn new() -> Root {
            let dir = tempfile::Builder::new()
                .prefix("cr")
                .tempdir_in("/tmp")
                .or_else(|_| tempfile::tempdir())
                .unwrap();
            let repo = dir.path().join("root/app");
            std::fs::create_dir_all(&repo).unwrap();
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&repo)
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .env("HOME", dir.path())
                .output()
                .unwrap();
            std::fs::create_dir_all(dir.path().join("config")).unwrap();
            Root { dir }
        }

        fn path(&self, rel: &str) -> String {
            self.dir.path().join(rel).to_str().unwrap().to_string()
        }
    }

    /// A server on a thread and runtime of its own, so stopping it ends
    /// every socket and client it holds, as a server going away does.
    struct Served {
        addr: String,
        terms: Arc<Terms>,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Served {
        fn stop(&mut self) {
            if let Some(s) = self.stop.take() {
                let _ = s.send(());
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    impl Drop for Served {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn serve(root: &Root, tmux: Option<&Tmux>) -> Served {
        let root_dir = root.path("root");
        let config_dir = root.path("config");
        let callers = root.path("callers.json");
        let base = tmux.map(|t| t.base.clone());
        let env = tmux.map(|t| t.env.clone()).unwrap_or_default();
        let (tx, rx) = std::sync::mpsc::channel();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let gates = Gates {
                    tmux: base.is_some(),
                    chan: false,
                    voice: false,
                    evaluator: false,
                };
                let state = Arc::new(
                    AppState::start(Setup {
                        root: root_dir,
                        config_dir: config_dir.clone(),
                        about: about("/r"),
                        config: Box::new(|| Ok(CanopyConfig::default())),
                        harnesses: Box::new(|| vec!["claude"]),
                        people: Arc::new(People::new(&config_dir)),
                        gates,
                    })
                    .await
                    .unwrap(),
                );
                let book = Arc::new(CallerBook::open(callers));
                let keeper = Arc::new(Gatekeeper {
                    gate: CallerGate::new(book.clone(), CallersMode::Log, Arc::new(|_: &str| {})),
                    policy: OriginPolicy::default(),
                    beyond_loopback: false,
                    loopback_wanted: false,
                    people: Some(state.people.clone()),
                });
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let terms = Arc::new(Terms::new(TermsSetup {
                    tmux: base,
                    shell: "/bin/sh".into(),
                    env,
                    book,
                    api_url: Some(format!("http://127.0.0.1:{}", addr.port())),
                }));
                let app = Router::new()
                    .merge(routes_with(terms.clone()))
                    .route("/api/{*rest}", any(crate::gated::fallback))
                    .with_state(state)
                    .layer(axum::middleware::from_fn_with_state(
                        keeper,
                        crate::gate::check,
                    ));
                tx.send((addr.to_string(), terms)).unwrap();
                let served = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                );
                tokio::select! {
                    _ = served => {}
                    _ = stopped => {}
                }
            });
            rt.shutdown_timeout(Duration::from_secs(2));
        });
        let (addr, terms) = rx.recv().unwrap();
        Served {
            addr,
            terms,
            stop: Some(stop),
            thread: Some(thread),
        }
    }

    /// One HTTP/1.1 request; the status and the body.
    async fn http(addr: &str, method: &str, path: &str, body: &str) -> (u16, String) {
        let raw = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(20), s.read_to_string(&mut out)).await;
        let status = out.get(9..12).and_then(|c| c.parse().ok()).unwrap_or(0);
        let body = out
            .split_once("\r\n\r\n")
            .map_or("", |(_, b)| b)
            .to_string();
        (status, body)
    }

    async fn terms_on(addr: &str) -> Value {
        let (status, body) = http(addr, "GET", "/api/terms", "").await;
        assert_eq!(status, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }

    async fn delete(addr: &str, id: &str) -> u16 {
        http(addr, "DELETE", &format!("/api/terms?term={id}"), "")
            .await
            .0
    }

    /// A socket that collects everything the server sends.
    struct Client {
        out: Arc<Mutex<String>>,
        frames: Arc<Mutex<Vec<String>>>,
        closed: Arc<Mutex<Option<(u16, String)>>>,
        tx: mpsc::UnboundedSender<Ws>,
    }

    impl Client {
        fn text(&self) -> String {
            lock(&self.out).clone()
        }

        fn send(&self, keys: &str) {
            let _ = self.tx.send(Ws::Binary(keys.as_bytes().to_vec().into()));
        }

        fn resize(&self, cols: u16, rows: u16) {
            let msg = json!({ "resize": { "cols": cols, "rows": rows } }).to_string();
            let _ = self.tx.send(Ws::Text(msg.into()));
        }

        fn close(&self) {
            let _ = self.tx.send(Ws::Close(None));
        }

        fn exited(&self) -> bool {
            lock(&self.frames).iter().any(|f| f.contains(r#""exit""#))
        }

        async fn closed(&self) -> (u16, String) {
            until(|| lock(&self.closed).is_some(), "the socket to close").await;
            lock(&self.closed).clone().unwrap_or_default()
        }
    }

    async fn connect(addr: &str, query: &[(&str, &str)]) -> Client {
        let mut q = form_urlencoded::Serializer::new(String::new());
        for (k, v) in [("id", "app"), ("cols", "80"), ("rows", "24")]
            .iter()
            .chain(query)
        {
            q.append_pair(k, v);
        }
        let url = format!("ws://{addr}/api/term?{}", q.finish());
        let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let (mut sink, mut stream) = ws.split();
        let out = Arc::new(Mutex::new(String::new()));
        let frames = Arc::new(Mutex::new(vec![]));
        let closed = Arc::new(Mutex::new(None));
        let (tx, mut rx) = mpsc::unbounded_channel::<Ws>();
        let (o, f, c) = (out.clone(), frames.clone(), closed.clone());
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    m = rx.recv() => match m {
                        Some(m) => { let _ = sink.send(m).await; }
                        None => return,
                    },
                    m = stream.next() => match m {
                        Some(Ok(Ws::Binary(b))) => lock(&o).push_str(&String::from_utf8_lossy(&b)),
                        Some(Ok(Ws::Text(t))) => lock(&f).push(t.to_string()),
                        Some(Ok(Ws::Close(frame))) => {
                            let got = frame.map_or((1005, String::new()), |fr| (u16::from(fr.code), fr.reason.to_string()));
                            lock(&c).get_or_insert(got);
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => {
                            lock(&c).get_or_insert((1006, String::new()));
                            return;
                        }
                    },
                }
            }
        });
        Client {
            out,
            frames,
            closed,
            tx,
        }
    }

    async fn until(pred: impl Fn() -> bool, what: &str) {
        for _ in 0..300 {
            if pred() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("gave up waiting for {what}");
    }

    async fn until_text(c: &Client, want: &str) {
        for _ in 0..300 {
            if c.text().contains(want) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("gave up waiting for {want:?} in {:?}", c.text());
    }

    /// the list until `pred` holds of it
    async fn until_terms(addr: &str, pred: impl Fn(&Value) -> bool, what: &str) -> Value {
        for _ in 0..100 {
            let list = terms_on(addr).await;
            if pred(&list) {
                return list;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("gave up waiting for {what}: {}", terms_on(addr).await);
    }

    fn ids(list: &Value) -> Vec<&str> {
        list.as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["id"].as_str())
            .collect()
    }

    fn find<'a>(list: &'a Value, id: &str) -> &'a Value {
        list.as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap_or(&Value::Null)
    }

    #[tokio::test]
    async fn a_shell_needs_a_well_formed_name() {
        let root = Root::new();
        let s = serve(&root, None);
        assert_eq!(
            http(&s.addr, "GET", "/api/term?id=app&term=t1", "").await.0,
            400
        );
        let (status, body) = http(&s.addr, "GET", "/api/term?id=nope&term=t1", "").await;
        assert_eq!(
            (status, body.as_str()),
            (404, r#"{"error":"unknown repo: nope"}"#)
        );
    }

    #[tokio::test]
    async fn outlives_its_socket_and_hands_the_next_one_what_it_missed() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let first = connect(&s.addr, &[("term", ID), ("place", "panel")]).await;
        first.send("printf 'held-%s\\n' one\n");
        until_text(&first, "held-one").await;
        let list = terms_on(&s.addr).await;
        assert_eq!(ids(&list), [ID]);
        assert_eq!(find(&list, ID)["repoId"], "app");
        assert_eq!(find(&list, ID)["place"], "panel");
        assert_eq!(find(&list, ID)["attached"], true);
        // the owner's token names no person, so neither does the list
        assert_eq!(find(&list, ID).get("who"), None);

        // a resize reaches the shell
        first.resize(132, 41);
        tokio::time::sleep(Duration::from_millis(300)).await;
        first.send("stty size\n");
        until_text(&first, "41 132").await;

        first.close();
        first.closed().await;
        // still there, nobody on it
        until_terms(
            &s.addr,
            |l| l[0]["attached"] == false,
            "the socket to leave",
        )
        .await;

        let second = connect(&s.addr, &[("term", ID), ("attach", "1")]).await;
        // the replay carries the line the first socket saw
        until_text(&second, "held-one").await;
        second.send("printf 'held-%s\\n' two\n");
        until_text(&second, "held-two").await;
        assert_eq!(terms_on(&s.addr).await[0]["attached"], true);

        // DELETE ends it: the socket hears the exit and closes
        assert_eq!(delete(&s.addr, ID).await, 200);
        let (code, _) = second.closed().await;
        assert_eq!(code, 1000);
        assert!(second.exited());
        assert_eq!(terms_on(&s.addr).await, json!([]));
        assert_eq!(tmux.sessions(), []);
    }

    #[tokio::test]
    async fn two_windows_on_one_shell_both_see_it_and_one_leaving_keeps_the_other() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let id = "abcdefabcdefabcdefabcdefabcdefab";
        let a = connect(&s.addr, &[("term", id)]).await;
        a.send("printf 'both-%s\\n' one\n");
        until_text(&a, "both-one").await;
        let b = connect(&s.addr, &[("term", id), ("attach", "1")]).await;
        until_text(&b, "both-one").await;
        b.send("printf 'both-%s\\n' two\n");
        until_text(&a, "both-two").await;
        until_text(&b, "both-two").await;

        a.close();
        a.closed().await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(lock(&b.closed).is_none());
        assert_eq!(find(&terms_on(&s.addr).await, id)["attached"], true);

        assert_eq!(delete(&s.addr, id).await, 200);
        b.closed().await;
    }

    #[tokio::test]
    async fn a_rejoin_for_a_name_the_server_does_not_hold_is_told_so() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let c = connect(
            &s.addr,
            &[
                ("term", "ffffffffffffffffffffffffffffffff"),
                ("attach", "1"),
            ],
        )
        .await;
        assert_eq!(c.closed().await, (TERM_GONE, "that shell is gone".into()));
        assert_eq!(terms_on(&s.addr).await, json!([]));
    }

    #[tokio::test]
    async fn ending_a_shell_that_is_not_there_is_a_404() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        assert_eq!(delete(&s.addr, ID).await, 404);
    }

    #[tokio::test]
    async fn a_shell_keeps_the_name_its_tab_gave_it_renamed_or_taken_off_later() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let id = "abcdefabcdefabcdefabcdefabcdef0a";
        let label = |name: &str, term: &str| {
            let body = json!({ "term": term, "label": name }).to_string();
            let addr = s.addr.clone();
            async move { http(&addr, "POST", "/api/terms/label", &body).await.0 }
        };
        let c = connect(&s.addr, &[("term", id), ("label", "  loot\tand  weapons ")]).await;
        c.send("printf 'named-%s\\n' one\n");
        until_text(&c, "named-one").await;
        assert_eq!(
            find(&terms_on(&s.addr).await, id)["label"],
            "loot and weapons"
        );

        assert_eq!(label("maps", id).await, 200);
        assert_eq!(find(&terms_on(&s.addr).await, id)["label"], "maps");
        // tmux holds it, so a server started over reads it back
        assert_eq!(tmux.sessions()[0].label.as_deref(), Some("maps"));

        assert_eq!(label("   ", id).await, 200);
        assert_eq!(find(&terms_on(&s.addr).await, id).get("label"), None);
        assert_eq!(tmux.sessions()[0].label, None);

        assert_eq!(label("x", "ffffffffffffffffffffffffffffffff").await, 404);
        assert_eq!(delete(&s.addr, id).await, 200);
        c.closed().await;
    }

    #[tokio::test]
    async fn a_shell_moves_between_the_strip_and_a_panel_and_every_device_hears_it() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let id = "abcdefabcdefabcdefabcdefabcdef0b";
        let place = |to: Value, term: &str| {
            let body = json!({ "term": term, "place": to }).to_string();
            let addr = s.addr.clone();
            async move { http(&addr, "POST", "/api/terms/place", &body).await.0 }
        };
        let c = connect(&s.addr, &[("term", id)]).await;
        c.send("printf 'placed-%s\\n' one\n");
        until_text(&c, "placed-one").await;
        assert_eq!(find(&terms_on(&s.addr).await, id)["place"], "strip");

        assert_eq!(place(json!("panel"), id).await, 200);
        assert_eq!(find(&terms_on(&s.addr).await, id)["place"], "panel");
        assert_eq!(tmux.sessions()[0].place, "panel");

        assert_eq!(place(json!("window"), id).await, 400);
        assert_eq!(
            place(json!("strip"), "ffffffffffffffffffffffffffffffff").await,
            404
        );
        assert_eq!(delete(&s.addr, id).await, 200);
        c.closed().await;
    }

    #[tokio::test]
    async fn a_pasted_image_is_not_in_the_rust_port_yet() {
        let root = Root::new();
        let s = serve(&root, None);
        for (method, path) in [
            ("POST", "/api/terms/paste?term=x"),
            ("POST", "/api/terms/restore"),
            ("POST", "/api/terms/say"),
            ("DELETE", "/api/terms/kept?term=x"),
            ("GET", "/api/terms/move/plan?term=x"),
        ] {
            let (status, body) = http(&s.addr, method, path, "{}").await;
            assert_eq!(status, 501, "{method} {path}: {body}");
        }
    }

    #[tokio::test]
    async fn draws_on_the_normal_screen_and_hands_a_new_socket_what_scrolled_off() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let id = "1111111111111111aaaaaaaaaaaaaaaa";
        let first = connect(&s.addr, &[("term", id)]).await;
        first.send("for i in $(seq 1 40); do echo scrolled-$i; done\n");
        until_text(&first, "scrolled-40").await;
        // canopy's config keeps tmux's client off the alternate screen
        assert!(!first.text().contains("?1049h"));
        first.close();
        first.closed().await;

        let second = connect(&s.addr, &[("term", id), ("attach", "1")]).await;
        // line 1 is long off a 24-row screen: it can only have come from history
        until_text(&second, "scrolled-1\r\n").await;
        until_text(&second, "scrolled-40").await;
        assert_eq!(delete(&s.addr, id).await, 200);
        second.closed().await;
    }

    #[tokio::test]
    async fn a_detach_from_inside_drops_the_socket_without_an_exit_and_a_rejoin_gets_a_new_client()
    {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let id = "2222222222222222bbbbbbbbbbbbbbbb";
        let first = connect(&s.addr, &[("term", id)]).await;
        first.send("printf 'still-%s\\n' here\n");
        until_text(&first, "still-here").await;
        // $TMUX in the shell names canopy's socket, so this is the socket's own client going
        first.send("tmux detach-client\n");
        let (code, _) = first.closed().await;
        assert_eq!(code, 1000);
        assert!(!first.exited());
        until_terms(
            &s.addr,
            |l| find(l, id)["attached"] == false,
            "the client to go",
        )
        .await;

        let second = connect(&s.addr, &[("term", id), ("attach", "1")]).await;
        until_text(&second, "still-here").await;
        second.send("printf 'back-%s\\n' again\n");
        until_text(&second, "back-again").await;
        assert_eq!(delete(&s.addr, id).await, 200);
        second.closed().await;
    }

    #[tokio::test]
    async fn a_new_session_knows_where_it_runs_for_an_agents_hook_to_say() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let id = "abcdefabcdefabcdefabcdefabcdef01";
        let c = connect(
            &s.addr,
            &[("term", id), ("place", "strip"), ("cols", "200")],
        )
        .await;
        c.send("echo \"at=$CANOPY_TERM|$CANOPY_REPO|$CANOPY_API|${#CANOPY_TOKEN}=\"\n");
        let port = s.addr.rsplit(':').next().unwrap().to_string();
        let said = format!("at={id}|app|http://127.0.0.1:{port}|");
        until_text(&c, &said).await;
        // a token the book holds for this shell
        let text = c.text();
        let length = text
            .rsplit(&said)
            .next()
            .and_then(|r| r.split('=').next())
            .unwrap_or("");
        assert!(length.parse::<usize>().is_ok_and(|n| n > 20), "{length:?}");
        let shells = |book: &CallerBook| {
            book.list()
                .into_iter()
                .filter(|c| c.kind == CallerKind::Shell && c.term.as_deref() == Some(id))
                .map(|c| c.label)
                .collect::<Vec<_>>()
        };
        assert_eq!(shells(&s.terms.book), ["shell app"]);
        assert_eq!(delete(&s.addr, id).await, 200);
        c.closed().await;
        // the token went with the shell
        assert_eq!(shells(&s.terms.book), Vec::<String>::new());
    }

    #[tokio::test]
    async fn a_new_session_gets_canopys_tz_even_when_the_tmux_server_has_none() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        // a session started first, with no TZ anywhere, holds the tmux server up
        let held = connect(&s.addr, &[("term", "abcdefabcdefabcdefabcdefabcdef02")]).await;
        held.send("printf 'up-%s\\n' now\n");
        until_text(&held, "up-now").await;
        s.terms.set_tz(Some("America/Los_Angeles"));
        let id = "abcdefabcdefabcdefabcdefabcdef03";
        let c = connect(&s.addr, &[("term", id), ("cols", "200")]).await;
        c.send("echo \"tz=$TZ=\"\n");
        until_text(&c, "tz=America/Los_Angeles=").await;
        for term in [id, "abcdefabcdefabcdefabcdefabcdef02"] {
            assert_eq!(delete(&s.addr, term).await, 200);
        }
    }

    #[tokio::test]
    async fn outlives_the_server_the_next_one_finds_it_and_a_socket_rejoins() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let mut s = serve(&root, Some(&tmux));
        let id = "fedcbafedcbafedcbafedcbafedcbafe";
        let first = connect(&s.addr, &[("term", id), ("place", "strip")]).await;
        first.send("printf 'kept-%s\\n' one\n");
        until_text(&first, "kept-one").await;

        s.stop();
        first.closed().await;
        // the session is still on tmux, with what canopy knows about it
        let left: Vec<(String, String, String)> = tmux
            .sessions()
            .into_iter()
            .map(|x| (x.id, x.repo_id, x.place))
            .collect();
        assert_eq!(
            left,
            [(id.to_string(), "app".to_string(), "strip".to_string())]
        );

        let s = serve(&root, Some(&tmux));
        let list = terms_on(&s.addr).await;
        assert_eq!(ids(&list), [id]);
        assert_eq!(list[0]["repoId"], "app");
        assert_eq!(list[0]["attached"], false);

        let second = connect(&s.addr, &[("term", id), ("attach", "1")]).await;
        // tmux repaints the screen on attach, and the line is still on it
        until_text(&second, "kept-one").await;
        second.send("printf 'kept-%s\\n' two\n");
        until_text(&second, "kept-two").await;

        assert_eq!(delete(&s.addr, id).await, 200);
        second.closed().await;
        assert_eq!(terms_on(&s.addr).await, json!([]));
        assert_eq!(tmux.sessions(), []);
    }

    #[tokio::test]
    async fn a_shell_on_a_plain_pty_is_not_in_the_rust_port_yet() {
        let root = Root::new();
        let s = serve(&root, None);
        let (status, body) = http(&s.addr, "GET", &format!("/api/term?id=app&term={ID}"), "").await;
        assert_eq!(status, 501, "{body}");
        assert_eq!(terms_on(&s.addr).await, json!([]));
        let (status, body) = http(&s.addr, "GET", "/api/terms/kept", "").await;
        assert_eq!(
            (status, body.as_str()),
            (200, r#"{"keeping":false,"kept":[]}"#)
        );
        assert_eq!(delete(&s.addr, ID).await, 404);
    }

    #[tokio::test]
    async fn a_shells_text_screen_keys_and_watch_read_its_pane() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        let gone = "ffffffffffffffffffffffffffffffff";
        let c = connect(&s.addr, &[("term", ID)]).await;
        c.send("printf 'peek-%s\\n' one\n");
        until_text(&c, "peek-one").await;
        let watched = |term: &str| {
            let (addr, term) = (s.addr.clone(), term.to_string());
            async move {
                let (_, b) =
                    http(&addr, "GET", &format!("/api/terms/watched?term={term}"), "").await;
                serde_json::from_str::<Value>(&b).unwrap()["watched"].clone()
            }
        };
        assert_eq!(watched(ID).await, true);
        assert_eq!(watched(gone).await, false);

        let (status, body) = http(&s.addr, "GET", &format!("/api/terms/text?term={ID}"), "").await;
        assert_eq!(status, 200);
        let text: Value = serde_json::from_str(&body).unwrap();
        assert!(
            text["text"].as_str().unwrap().contains("peek-one"),
            "{text}"
        );
        assert_eq!(text["fullscreen"], false);
        let (status, body) =
            http(&s.addr, "GET", &format!("/api/terms/screen?term={ID}"), "").await;
        assert_eq!(status, 200);
        assert!(body.contains("peek-one"), "{body}");
        assert_eq!(
            http(&s.addr, "GET", &format!("/api/terms/text?term={gone}"), "")
                .await
                .0,
            404
        );
        assert_eq!(
            http(
                &s.addr,
                "GET",
                &format!("/api/terms/screen?term={gone}"),
                ""
            )
            .await
            .0,
            404
        );

        let key = |term: &str, key: &str| {
            let body = json!({ "term": term, "key": key }).to_string();
            let addr = s.addr.clone();
            async move { http(&addr, "POST", "/api/terms/keys", &body).await.0 }
        };
        assert_eq!(key(ID, "escape").await, 200);
        assert_eq!(key(ID, "enter").await, 400);
        assert_eq!(key(gone, "escape").await, 404);
        assert_eq!(
            http(&s.addr, "POST", "/api/terms/keys", "nope").await.0,
            400
        );

        let (_, body) = http(&s.addr, "GET", &format!("/api/terms/agent?term={ID}"), "").await;
        assert_eq!(body, r#"{"agent":null}"#);
        assert_eq!(delete(&s.addr, ID).await, 200);
        c.closed().await;
    }

    #[tokio::test]
    async fn an_agent_in_the_shell_keeps_it_from_a_tabs_close_until_forced() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let s = serve(&root, Some(&tmux));
        // a process tmux reports as `claude`: sleep under that name
        let sleep = crate::harnesses::find_binary("sleep").unwrap_or_else(|| "/bin/sleep".into());
        let fake = tmux.dir.path().join("claude");
        std::os::unix::fs::symlink(&sleep, &fake).unwrap();
        let c = connect(&s.addr, &[("term", ID)]).await;
        c.send(&format!("{} 60\n", fake.display()));
        let agent = || {
            let addr = s.addr.clone();
            async move {
                http(&addr, "GET", &format!("/api/terms/agent?term={ID}"), "")
                    .await
                    .1
            }
        };
        let mut said = String::new();
        for _ in 0..100 {
            said = agent().await;
            if said.contains("claude") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(said, r#"{"agent":"claude"}"#);
        let (status, body) = http(&s.addr, "DELETE", &format!("/api/terms?term={ID}"), "").await;
        assert_eq!(
            (status, body.as_str()),
            (409, r#"{"error":"an agent is running in that shell"}"#)
        );
        assert_eq!(ids(&terms_on(&s.addr).await), [ID]);
        let (status, _) = http(
            &s.addr,
            "DELETE",
            &format!("/api/terms?term={ID}&force=1"),
            "",
        )
        .await;
        assert_eq!(status, 200);
        c.closed().await;
    }

    #[tokio::test]
    async fn a_tasks_session_is_never_a_shell() {
        let Some(tmux) = Tmux::new() else { return };
        let root = Root::new();
        let name = canopy_core::tmux::session_name(ID);
        let repo = root.path("root/app");
        let made = tmux.run(&[
            "new-session",
            "-d",
            "-s",
            &name,
            "-c",
            &repo,
            "sleep 600",
            ";",
            "set-option",
            "-t",
            &name,
            "@canopy_repo",
            "app",
            ";",
            "set-option",
            "-t",
            &name,
            "@canopy_path",
            &repo,
            ";",
            "set-option",
            "-t",
            &name,
            "@canopy_task",
            "dev",
        ]);
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stderr)
        );
        let s = serve(&root, Some(&tmux));
        assert_eq!(terms_on(&s.addr).await, json!([]));
        let c = connect(&s.addr, &[("term", ID)]).await;
        assert_eq!(
            c.closed().await,
            (TERM_GONE, "that is a task, not a shell".into())
        );
        let (status, body) = http(&s.addr, "DELETE", &format!("/api/terms?term={ID}"), "").await;
        assert_eq!(
            (status, body.as_str()),
            (
                400,
                r#"{"error":"that is a task; stop it from its repo's tasks"}"#
            )
        );
        let (_, body) = http(&s.addr, "GET", &format!("/api/terms/agent?term={ID}"), "").await;
        assert_eq!(body, r#"{"error":"that is a task, not a shell"}"#);
        assert_eq!(tmux.sessions().len(), 1);
    }

    #[test]
    fn the_api_address_is_loopback_for_a_loopback_or_wildcard_bind() {
        assert_eq!(api_url_for("0.0.0.0", 7850), "http://127.0.0.1:7850");
        assert_eq!(api_url_for("127.0.0.1", 7870), "http://127.0.0.1:7870");
        assert_eq!(api_url_for("::", 1), "http://127.0.0.1:1");
        assert_eq!(api_url_for("100.64.0.2", 7850), "http://100.64.0.2:7850");
        assert_eq!(api_url_for("fd00::2", 7850), "http://[fd00::2]:7850");
    }

    #[test]
    fn a_shells_tmux_never_inherits_the_outer_shells_names_or_secrets() {
        let vars = [
            ("PATH", "/bin"),
            ("CANOPY_TOKEN", "t"),
            ("TAILCHAN_AS", "a"),
            ("CANOPY_VAULT_TOKEN", "v"),
            ("CANOPY_TRIGGER_SENTRY", "s"),
            ("TMUX", "/tmp/x,1,0"),
            ("CANOPY_CONFIG_DIR", "/c"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let kept: Vec<String> = child_env(vars.into_iter())
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(kept, ["PATH", "CANOPY_CONFIG_DIR"]);
    }
}
