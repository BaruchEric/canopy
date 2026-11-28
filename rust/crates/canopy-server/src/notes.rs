//! Quick notes and reminders, the server half (FR-020, `src/server/notes.ts`):
//! the file, the routes under `/api/notes`, the `notes` frame, and the
//! delivery of a reminder that came due. The rules are core's `notes.rs`.
//!
//! Every route is the Bun server's, answered here in full:
//! `GET /api/notes` (the list as last read), `POST /api/notes` (add),
//! `POST /api/notes/edit`, `POST /api/notes/done` and
//! `DELETE /api/notes?id=`, with the same refusals, statuses and words; any
//! other method or path under `/api/notes` is its 404. A 500 carries Bun's
//! words for the file system error (`fserr.rs`).
//!
//! The file is `<config dir>/notes.json`, one array, read again before
//! every write and written whole through a temp file
//! (`notes.json.tmp-<pid>-<8 hex>`) and a rename, as the TypeScript writes
//! it: two-space JSON and a newline, each note's fields in the order
//! JavaScript gave them, the mode a plain `writeFile` gives. Writes run one
//! at a time, each on a fresh read, as `change()` chains them. Every change
//! sends every stream `{"type":"notes","notes":[...]}`, the whole list.
//!
//! Reminders are delivered on the trigger engine's clock (`TICK_EVERY` in
//! `src/server/triggers.ts`, 30 seconds, the first a period after the
//! start), the one part of that engine ported: rules, events and the daily
//! line do not run here. The Bun server delivers only while it holds the
//! flows lock; canopy-server takes no lock and runs on a config dir of its
//! own, so it delivers there. A server on the same dir that delivered first
//! leaves nothing due, since each tick reads the file again.
//!
//! Two differences, both outside what a note can hold in practice: a text
//! cut at 600 UTF-16 units through a surrogate pair ends in U+FFFD here
//! where JavaScript keeps half the pair (core's `note_text`), and a body
//! serde cannot parse (a number past f64, a lone surrogate) is read as `{}`
//! where `JSON.parse` would read it. People's folder scopes are not ported
//! (`gate.rs`), so a scoped person's stream hears the notes frame too.

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use canopy_core::cron::parse_when;
use canopy_core::fserr::{bun_message, bun_rename_message};
use canopy_core::js::num;
use canopy_core::notes::{is_note_id, mint_note_id, note_text, parse_file, remind_due};
use canopy_core::pathx::{join, js_trim};
use canopy_core::types::now_ms;
use serde_json::{Map, Value, json};
use std::borrow::Cow;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, broadcast};

use crate::app::AppState;

/// `TICK_EVERY` in triggers.ts: how often reminders are looked at.
pub const TICK_EVERY: Duration = Duration::from_millis(30_000);

type NowFn = dyn Fn() -> f64 + Send + Sync;
type MintFn = dyn Fn() -> String + Send + Sync;

/// A repo the backend has, by id and path, for a note's `repo`.
pub type RepoRef = (String, String);

/// Why a route did not do what it was asked: a refusal with its status,
/// or a failure (500).
enum Fail {
    Refused(u16, String),
    Broke(String),
}

impl From<String> for Fail {
    fn from(e: String) -> Self {
        Fail::Broke(e)
    }
}

fn refused(status: u16, words: &str) -> Fail {
    Fail::Refused(status, words.into())
}

/// The list as last read, and whether it has been read.
#[derive(Default)]
struct Held {
    notes: Vec<Value>,
    loaded: bool,
}

/// The notes hub (`NotesHub`).
pub struct Notes {
    dir: String,
    file: String,
    events: broadcast::Sender<String>,
    /// held for each change, so writes go one after another
    held: Mutex<Held>,
    now: Box<NowFn>,
    mint: Box<MintFn>,
}

/// Blocking file work off the async threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// `read()`: no file is no notes, and so is a file that is not JSON. Any
/// other failure is not an empty list: the write after this read would put
/// one note over all the others.
fn read_file(file: &str) -> Result<Vec<Value>, String> {
    use std::io::Read as _;
    let mut f = match std::fs::File::open(file) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(bun_message(&e, "open", file)),
    };
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| bun_message(&e, "read", ""))?;
    // Bun's utf8 read puts U+FFFD for bytes that are not UTF-8
    Ok(parse_file(&String::from_utf8_lossy(&bytes)))
}

/// `write()`: the whole list through a temp file and a rename. Two servers
/// on one config dir can be two containers with the same pid, so the temp
/// name carries a random part too.
fn write_file(dir: &str, file: &str, notes: &[Value]) -> Result<(), String> {
    use rand::Rng as _;
    std::fs::create_dir_all(dir).map_err(|e| bun_message(&e, "mkdir", dir))?;
    let tmp = format!(
        "{file}.tmp-{}-{:08x}",
        std::process::id(),
        rand::rng().next_u32()
    );
    let text = serde_json::to_string_pretty(notes).map_err(|e| e.to_string())?;
    let r = std::fs::write(&tmp, format!("{text}\n"))
        .map_err(|e| bun_message(&e, "open", &tmp))
        .and_then(|()| std::fs::rename(&tmp, file).map_err(|e| bun_rename_message(&e, &tmp, file)));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

/// `repoAtPath` after the id: the repo at that path, or whose real path it
/// is.
fn repo_at(repos: &[RepoRef], r: &str) -> Option<String> {
    let real = |p: &str| {
        std::fs::canonicalize(p)
            .ok()
            .and_then(|p| p.to_str().map(str::to_string))
            .unwrap_or_else(|| p.to_string())
    };
    repos
        .iter()
        .find(|(id, _)| id == r)
        .or_else(|| repos.iter().find(|(_, path)| path == r))
        .or_else(|| {
            repos
                .iter()
                .find(|(_, path)| path.starts_with('/') && real(path) == r)
        })
        .map(|(id, _)| id.clone())
}

fn same_id(n: &Value, id: &str) -> bool {
    n.get("id").and_then(Value::as_str) == Some(id)
}

/// The note with each one of that id put back as `next`.
fn replaced(notes: &[Value], id: &str, next: &Value) -> Vec<Value> {
    notes
        .iter()
        .map(|n| {
            if same_id(n, id) {
                next.clone()
            } else {
                n.clone()
            }
        })
        .collect()
}

impl Notes {
    /// The hub on `<dir>/notes.json`, on the wall clock and random ids.
    pub fn new(dir: &str, events: broadcast::Sender<String>) -> Notes {
        Notes::with(
            dir,
            events,
            Box::new(|| now_ms() as f64),
            Box::new(mint_note_id),
        )
    }

    /// The same with its clock and ids handed in, for the tests.
    pub fn with(
        dir: &str,
        events: broadcast::Sender<String>,
        now: Box<NowFn>,
        mint: Box<MintFn>,
    ) -> Notes {
        Notes {
            dir: dir.to_string(),
            file: join(dir, "notes.json"),
            events,
            held: Mutex::new(Held::default()),
            now,
            mint,
        }
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    async fn read(&self) -> Result<Vec<Value>, String> {
        let file = self.file.clone();
        blocking(move || read_file(&file)).await
    }

    /// `list()`: the list as last read; the file is read once, then kept in
    /// step by the writes.
    pub async fn list(&self) -> Result<Vec<Value>, String> {
        let mut held = self.held.lock().await;
        if !held.loaded {
            held.notes = self.read().await?;
            held.loaded = true;
        }
        Ok(held.notes.clone())
    }

    /// `change()`: the file read again, `f` applied, the result written and
    /// broadcast when `f` returns a list. A failure is logged and handed
    /// back.
    async fn change<T>(
        &self,
        f: impl FnOnce(&[Value]) -> (Option<Vec<Value>>, T),
    ) -> Result<T, String> {
        let mut held = self.held.lock().await;
        let done = async {
            let fresh = self.read().await?;
            let (out, t) = f(&fresh);
            held.loaded = true;
            let Some(out) = out else {
                held.notes = fresh;
                return Ok(t);
            };
            let (dir, file, list) = (self.dir.clone(), self.file.clone(), out.clone());
            blocking(move || write_file(&dir, &file, &list)).await?;
            held.notes = out;
            let frame = json!({ "type": "notes", "notes": &held.notes }).to_string();
            // no stream listening is not an error
            let _ = self.events.send(frame);
            Ok(t)
        }
        .await;
        if let Err(e) = &done {
            eprintln!("notes: {e}");
        }
        done
    }

    /// `whenOf()`: unix ms as given, or a time as typed read on this
    /// server's clock (`in 30m`, `14:00`, an ISO date and time).
    fn when_of(&self, at: &Value) -> Result<f64, Fail> {
        let now = self.now();
        if let Some(n) = at.as_f64() {
            if !n.is_finite() || n <= now {
                return Err(refused(400, "at must be a time in the future, in unix ms"));
            }
            return Ok(n);
        }
        let Some(text) = at.as_str().filter(|t| !js_trim(t).is_empty()) else {
            return Err(refused(
                400,
                "at must be a time: in 30m, 14:00, or a date and time",
            ));
        };
        parse_when(text, now).map_err(|e| Fail::Refused(400, e))
    }

    /// `repoOf()`: a repo id or path as the backend's id for it.
    async fn repo_of(r: &Value, repos: &[RepoRef]) -> Result<String, Fail> {
        let Some(r) = r.as_str().map(js_trim).filter(|r| !r.is_empty()) else {
            return Err(refused(400, "repo must be a repo id or path"));
        };
        let (want, list) = (r.to_string(), repos.to_vec());
        let found = blocking(move || Ok(repo_at(&list, &want))).await?;
        found.ok_or_else(|| Fail::Refused(404, format!("no repo {r} on this backend")))
    }

    async fn add(&self, body: &Map<String, Value>, repos: &[RepoRef]) -> Result<Value, Fail> {
        let text = body
            .get("text")
            .and_then(Value::as_str)
            .map(note_text)
            .unwrap_or_default();
        if text.is_empty() {
            return Err(refused(400, "text is required"));
        }
        let mut note = Map::new();
        note.insert("id".into(), json!((self.mint)()));
        note.insert("text".into(), json!(text));
        note.insert("createdAt".into(), num(self.now()));
        if let Some(r) = body.get("repo").filter(|v| !v.is_null()) {
            note.insert("repoId".into(), json!(Self::repo_of(r, repos).await?));
        }
        if let Some(at) = body.get("at").filter(|v| !v.is_null()) {
            note.insert("due".into(), num(self.when_of(at)?));
        }
        let note = Value::Object(note);
        self.change(|notes| {
            let mut out = notes.to_vec();
            out.push(note.clone());
            (Some(out), ())
        })
        .await?;
        Ok(note)
    }

    /// `edit()`: text, repo and time by id; `repo: null` and `at: null`
    /// clear them. A moved time clears the delivery mark, so the reminder
    /// comes back once more.
    async fn edit(&self, body: &Map<String, Value>, repos: &[RepoRef]) -> Result<Value, Fail> {
        let Some(id) = body
            .get("id")
            .and_then(Value::as_str)
            .filter(|i| is_note_id(i))
        else {
            return Err(refused(400, "id must be a note id"));
        };
        let text = match body.get("text") {
            None => None,
            Some(Value::String(s)) => Some(note_text(s)),
            Some(_) => Some(String::new()),
        };
        if text.as_deref() == Some("") {
            return Err(refused(400, "text cannot be empty"));
        }
        let repo = match body.get("repo") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(r) => Some(Some(Self::repo_of(r, repos).await?)),
        };
        let due = match body.get("at") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(at) => Some(Some(self.when_of(at)?)),
        };
        let out = self
            .change(|notes| {
                let Some(cur) = notes.iter().find(|n| same_id(n, id)) else {
                    return (None, None);
                };
                let mut next = cur.clone();
                if let Some(m) = next.as_object_mut() {
                    if let Some(t) = text {
                        m.insert("text".into(), json!(t));
                    }
                    match repo {
                        Some(None) => {
                            m.shift_remove("repoId");
                        }
                        Some(Some(r)) => {
                            m.insert("repoId".into(), json!(r));
                        }
                        None => {}
                    }
                    let was = cur.get("due").and_then(Value::as_f64);
                    match due {
                        Some(None) => {
                            m.shift_remove("due");
                            m.shift_remove("remindedAt");
                        }
                        Some(Some(d)) if was != Some(d) => {
                            m.insert("due".into(), num(d));
                            m.shift_remove("remindedAt");
                        }
                        _ => {}
                    }
                }
                (Some(replaced(notes, id, &next)), Some(next))
            })
            .await?;
        out.ok_or_else(|| refused(404, "no note by that id"))
    }

    async fn done(&self, id: Option<&Value>) -> Result<Value, Fail> {
        let Some(id) = id.and_then(Value::as_str).filter(|i| is_note_id(i)) else {
            return Err(refused(400, "id must be a note id"));
        };
        let out = self
            .change(|notes| {
                let Some(cur) = notes.iter().find(|n| same_id(n, id)) else {
                    return (None, None);
                };
                if cur.get("doneAt").is_some() {
                    return (None, Some(cur.clone()));
                }
                let mut next = cur.clone();
                if let Some(m) = next.as_object_mut() {
                    m.insert("doneAt".into(), num(self.now()));
                }
                (Some(replaced(notes, id, &next)), Some(next))
            })
            .await?;
        out.ok_or_else(|| refused(404, "no note by that id"))
    }

    async fn remove(&self, id: Option<&str>) -> Result<(), Fail> {
        let Some(id) = id.filter(|i| is_note_id(i)) else {
            return Err(refused(400, "id must be a note id"));
        };
        let found = self
            .change(|notes| {
                if !notes.iter().any(|n| same_id(n, id)) {
                    return (None, false);
                }
                let left = notes.iter().filter(|n| !same_id(n, id)).cloned().collect();
                (Some(left), true)
            })
            .await?;
        if found {
            Ok(())
        } else {
            Err(refused(404, "no note by that id"))
        }
    }

    /// `remind()`: the reminders whose time has come, each delivered once:
    /// marked in the file and broadcast, which the inbox reads as a row.
    pub async fn remind(&self, now: f64) -> Result<Vec<Value>, String> {
        self.change(|notes| {
            let r = remind_due(notes, now);
            match r.notes {
                Cow::Borrowed(_) => (None, r.delivered),
                Cow::Owned(list) => (Some(list), r.delivered),
            }
        })
        .await
    }

    /// `handle()`: one request under `/api/notes`, as its status and JSON.
    /// `repos` is what a note's `repo` may name.
    pub async fn handle(
        &self,
        method: &Method,
        path: &str,
        query: &str,
        body: &[u8],
        repos: &[RepoRef],
    ) -> (u16, Value) {
        let body = || -> Map<String, Value> {
            match serde_json::from_slice(body) {
                Ok(Value::Object(m)) => m,
                _ => Map::new(),
            }
        };
        let answer = match (method.as_str(), path) {
            ("GET", "/api/notes") => self
                .list()
                .await
                .map_err(Fail::Broke)
                .map(|notes| json!({ "notes": notes })),
            ("POST", "/api/notes") => self.add(&body(), repos).await,
            ("POST", "/api/notes/edit") => self.edit(&body(), repos).await,
            ("POST", "/api/notes/done") => self.done(body().get("id")).await,
            ("DELETE", "/api/notes") => {
                let id = form_urlencoded::parse(query.as_bytes())
                    .find(|(k, _)| k == "id")
                    .map(|(_, v)| v.into_owned());
                self.remove(id.as_deref())
                    .await
                    .map(|()| json!({ "ok": true }))
            }
            _ => Err(refused(404, "not found")),
        };
        match answer {
            Ok(v) => (200, v),
            Err(Fail::Refused(status, words)) => (status, json!({ "error": words })),
            Err(Fail::Broke(e)) => (500, json!({ "error": e })),
        }
    }
}

/// The reminders looked at every `every`, the first a period from now, as
/// the trigger engine's `setInterval` does. The clock is set when this is
/// called, not when the future first runs.
pub fn remind_every(notes: Arc<Notes>, every: Duration) -> impl Future<Output = ()> + Send {
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    async move {
        loop {
            tick.tick().await;
            let now = notes.now();
            // a failed write is logged and tried next tick
            if let Err(e) = notes.remind(now).await {
                eprintln!("triggers: the notes' reminders: {e}");
            }
        }
    }
}

/// Every request under `/api/notes`. Only an add or an edit can name a
/// repo, so only a POST copies the scan's repos.
async fn route(State(s): State<Arc<AppState>>, method: Method, uri: Uri, body: Bytes) -> Response {
    let repos: Vec<RepoRef> = if method == Method::POST {
        s.result
            .read()
            .await
            .repos
            .iter()
            .map(|r| (r.id.clone(), r.path.clone()))
            .collect()
    } else {
        Vec::new()
    };
    let (status, answer) = s
        .notes
        .handle(
            &method,
            uri.path(),
            uri.query().unwrap_or(""),
            &body,
            &repos,
        )
        .await;
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(answer)).into_response()
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/notes", any(route))
        .route("/api/notes/", any(route))
        .route("/api/notes/{*rest}", any(route))
}

#[cfg(test)]
mod tests;
