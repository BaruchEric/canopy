//! First-load reads whose answer comes from settings, files and the machine
//! rather than live work (src/server/index.ts and the feature modules behind
//! it). Each answers only where canopy-server can say what the Bun server
//! would, and 501 otherwise, as do every other method on these paths:
//!
//! - `GET /api/history` (`loadHistory`): `{ available: false, reason }` when
//!   no claude-history CLI is found, the way `locateHistory` looks. With one
//!   found, the Bun server runs its reports, which this port does not.
//! - `GET /api/clips` (server/clips.ts): `clips.json` read back and pruned,
//!   `?ids=` as there. A file that will not read for a reason other than
//!   not being there answers 501, since the Bun server's 500 carries Node's
//!   own words for it.
//! - `GET /api/secrets` (server/secrets.ts): the reader's info while it can
//!   do nothing, with no secrets service's socket and no mini key and remote
//!   pinned in `secrets-config.json`, so it pulls nothing. A key on disk
//!   reads as locked; on a Mac the keychain may open it at the start, so
//!   that case answers 501. The relay to the service, and a reader that
//!   pulls from Forgejo, answer 501.
//! - `GET /api/ranger` (server/ranger.ts): its info on a backend without
//!   tmux, where the hub never starts it and only reads its settings, record
//!   and wakes. Where tmux runs, the hub watches a live session, so 501.
//! - `GET /api/kit` (server/kit.ts): the scan's answer when kit.json is not
//!   there, which names the file in Bun's words. Any kit.json that is there
//!   answers 501: a parse error carries JavaScriptCore's words, and a kit
//!   that parses is scanned across machines.
//! - `GET /api/worktrees` (server/warm.ts): the listing while the warm pool
//!   and the landing queue hold nothing: no landing run record, no folder
//!   under any repo's key in the worktrees root (a run's tree, an orphan or
//!   a warm slot), no warm record with entries, and no repo this machine
//!   keeps warm trees for (which the pool would start cutting). The root
//!   must be there unless no repo is local, since the Bun server holding the
//!   flows lock makes it at its start and answers its volume's free bytes.
//!   A gates file that is not JSON answers 501 (JavaScriptCore's words).
//!
//! Not here, and still 501: `/api/capacity`, whose readings fold in three
//! harness CLIs' own counts and a run's stream and whose held list reads
//! the starts five work hubs hold (triggers, flows, the coordinator, PR
//! fixes, landing fixes), all as of the hub's last refresh; and
//! `/api/triggers`, whose `keeping` says whether this server holds the flows
//! lock (canopy-server takes none), and whose events, polls and next fires
//! the lock holder runs.

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use canopy_core::backends::{config_self, self_name};
use canopy_core::clips::{CLIP_FILES_BUDGET, is_clip_id, parse_clips, prune_clips};
use canopy_core::gates::read_gates;
use canopy_core::history::{history_bin, locate_history};
use canopy_core::pathx::{join, normalize, resolve};
use canopy_core::ranger::{
    TELEGRAM_PLUGIN, normalize_ranger, parse_record, parse_wake, ranger_handle, ranger_term_id,
};
use canopy_core::types::{Repo, now_ms};
use canopy_core::warm::{WARM_RECORD, free_bytes, holds_nothing, warm_for};
use serde_json::{Map, Value, json};
use std::sync::Arc;

use crate::app::AppState;
use crate::routes::{config, not_ported, read};

/// What a read comes to.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Body(StatusCode, Value),
    /// a 200 the Bun server sends with `cache-control: no-store`
    NoStore(Value),
    NotPorted,
}

async fn reply(a: Answer, method: Method, uri: Uri) -> Response {
    match a {
        Answer::Body(status, body) => (status, Json(body)).into_response(),
        Answer::NoStore(body) => {
            ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
        }
        Answer::NotPorted => not_ported(method, uri).await,
    }
}

/// A blocking read off the async workers, as the port's file work goes.
async fn blocking<F: FnOnce() -> Answer + Send + 'static>(f: F) -> Answer {
    tokio::task::spawn_blocking(f).await.unwrap_or_else(|e| {
        Answer::Body(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": e.to_string() }),
        )
    })
}

fn env_raw(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// `readFile(file, "utf8")`: bytes that are not UTF-8 read as U+FFFD.
fn read_text(file: &str) -> std::io::Result<String> {
    std::fs::read(file).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `readJson()` in server/ranger.ts: the file as JSON, or None for any
/// failure to read or parse it.
fn read_json(file: &str) -> Option<Value> {
    read_text(file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

/* ---------- history ---------- */

/// `GET /api/history` with no CLI to read: the reason `locateHistory`
/// gives. `window` and `refresh` change nothing then.
pub fn history_answer(
    raw: &Value,
    home: &str,
    which: &dyn Fn(&str) -> Option<String>,
    now: f64,
) -> Answer {
    match locate_history(history_bin(raw), which, home) {
        Ok(_) => Answer::NotPorted,
        Err(reason) => Answer::Body(
            StatusCode::OK,
            json!({ "available": false, "reason": reason, "fetchedAt": canopy_core::screenlayouts::js_num(now) }),
        ),
    }
}

async fn history(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let raw = match config(&s).await {
        Ok(raw) => raw,
        Err(e) => return e.into_response(),
    };
    let a =
        blocking(move || history_answer(&raw, &home(), &crate::harnesses::which, now_ms() as f64))
            .await;
    reply(a, method, uri).await
}

/* ---------- clips ---------- */

/// `GET /api/clips[?ids=a,b]`: the clips past neither the age nor the cap,
/// newest first; with `ids`, only those.
pub fn clips_answer(config_dir: &str, query: &str, now: f64) -> Answer {
    let raw = match read_text(&join(config_dir, "clips.json")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::from("[]"),
        Err(_) => return Answer::NotPorted,
    };
    let all = serde_json::from_str::<Value>(&raw)
        .map(|v| parse_clips(&v))
        .unwrap_or_default();
    let (kept, _) = prune_clips(&all, now, CLIP_FILES_BUDGET);
    let want: Option<Vec<String>> = form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == "ids")
        .map(|(_, v)| {
            v.split(',')
                .filter(|id| is_clip_id(id))
                .map(String::from)
                .collect()
        });
    let clips: Vec<Value> = match want {
        Some(ids) => kept
            .into_iter()
            .filter(|c| {
                c["id"]
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|w| w == id))
            })
            .collect(),
        None => kept,
    };
    Answer::Body(StatusCode::OK, json!({ "clips": clips }))
}

async fn clips(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let dir = s.config_dir.clone();
    let query = uri.query().unwrap_or("").to_string();
    let a = blocking(move || clips_answer(&dir, &query, now_ms() as f64)).await;
    reply(a, method, uri).await
}

/* ---------- secrets ---------- */

/// `PIN` in core/secretlocal.ts: a raw ed25519 key in base64, 32 bytes.
fn is_pin(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 44
        && b[43] == b'='
        && b[..43]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
}

/// `readLocalConfig()`: whether a mini key and a remote are pinned, the two
/// a reader pulls with.
fn pinned(config_dir: &str) -> bool {
    let Some(v) = read_json(&join(config_dir, "secrets-config.json")) else {
        return false;
    };
    let pin = v.get("pin").and_then(Value::as_str).is_some_and(is_pin);
    let remote = v
        .get("remote")
        .and_then(Value::as_str)
        .is_some_and(|r| !r.is_empty());
    pin && remote
}

/// `GET /api/secrets` from a reader with nothing pinned (`SecretsReader.info`
/// after `start` found no pin): no file, no sinks, the lock as the key on
/// disk leaves it.
pub fn secrets_answer(
    config_dir: &str,
    backend: &str,
    env: &dyn Fn(&str) -> Option<String>,
    mac: bool,
) -> Answer {
    // the relay to the secrets service
    if env("CANOPY_SECRETS_SOCKET").is_some_and(|s| !s.is_empty()) {
        return Answer::NotPorted;
    }
    // a reader that pulls from Forgejo and verifies what it gets
    if pinned(config_dir) {
        return Answer::NotPorted;
    }
    let has_key = std::path::Path::new(&join(config_dir, "secrets-key.age")).exists();
    // a Mac's keychain may hold the passphrase that opens it at the start
    if has_key && mac {
        return Answer::NotPorted;
    }
    let origin = env("CANOPY_SECRETS_ORIGIN").unwrap_or_else(|| "https://canopy.beric.ca".into());
    Answer::NoStore(json!({
        "ok": false,
        "error": "no mini signing key pinned yet; run canopy secrets pin <key> --remote <url>",
        "backend": backend,
        "role": "reader",
        "head": null,
        "sinksAt": null,
        "refused": null,
        "lock": if has_key { "locked" } else { "none" },
        "recipient": null,
        "secrets": [],
        "sinks": [],
        "proposals": [],
        "passkeys": [],
        "session": false,
        "firstPasskey": false,
        "gate": format!("{origin}/?view=secrets"),
        "unpushed": 0,
    }))
}

fn backend_name(s: &AppState, raw: &Value) -> String {
    self_name(config_self(raw).as_deref(), &s.hostname)
}

async fn secrets(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let raw = match config(&s).await {
        Ok(raw) => raw,
        Err(e) => return e.into_response(),
    };
    let backend = backend_name(&s, &raw);
    let dir = s.config_dir.clone();
    let a =
        blocking(move || secrets_answer(&dir, &backend, &env_raw, cfg!(target_os = "macos"))).await;
    reply(a, method, uri).await
}

/* ---------- ranger ---------- */

/// What the ranger's info reads beyond its own folder.
pub struct RangerHere<'a> {
    pub config_dir: &'a str,
    pub root: &'a str,
    pub backend: &'a str,
    /// `claudeHome()`: `CLAUDE_CONFIG_DIR`, else `~/.claude`
    pub claude_home: &'a str,
    /// whether a broker is configured (`chan.cfg !== null`)
    pub broker: bool,
}

/// `RangerHub.info()` on a backend without tmux, as `start` leaves it:
/// off, or `no-tmux` when turned on; never running, so no transcript size,
/// start, retry or viewer.
pub fn ranger_answer(raw: &Value, here: &RangerHere) -> Answer {
    let settings = normalize_ranger(raw.get("ranger"));
    let dir = join(here.config_dir, "ranger");
    let rec = parse_record(read_json(&join(&dir, "state.json")).as_ref());
    let wakes: Vec<Value> = read_json(&join(&dir, "wakes.json"))
        .as_ref()
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(parse_wake).collect())
        .unwrap_or_default();
    let contested = read_json(&join(here.claude_home, "settings.json")).is_some_and(|s| {
        s.get("enabledPlugins").and_then(|p| p.get(TELEGRAM_PLUGIN)) == Some(&Value::Bool(true))
    });
    let on = settings["on"] == Value::Bool(true);
    let home = if settings["home"] == "root" {
        here.root.to_string()
    } else {
        join(&dir, "home")
    };
    let mut info = Map::new();
    info.insert("on".into(), json!(on));
    info.insert("state".into(), json!(if on { "no-tmux" } else { "off" }));
    info.insert("term".into(), json!(ranger_term_id(here.backend)));
    info.insert("handle".into(), json!(ranger_handle(&settings)));
    info.insert("backend".into(), json!(here.backend));
    info.insert("root".into(), json!(here.root));
    info.insert("home".into(), json!(home));
    info.insert("session".into(), rec["session"].clone());
    info.insert("transcript".into(), Value::Null);
    if let Some(at) = rec.get("sessionAt") {
        info.insert("sessionAt".into(), at.clone());
    }
    info.insert(
        "fails".into(),
        rec.get("fails").cloned().unwrap_or(json!(0)),
    );
    info.insert("restarts".into(), json!(0));
    if let Some(at) = rec.get("exitedAt") {
        let code = rec.get("exitCode").cloned().unwrap_or(Value::Null);
        info.insert("lastExit".into(), json!({ "at": at, "code": code }));
    }
    let telegram = match (settings["telegram"] == Value::Bool(true), contested) {
        (false, _) => "off",
        (true, true) => "contested",
        (true, false) => "owned",
    };
    info.insert("telegram".into(), json!(telegram));
    info.insert("settings".into(), settings);
    info.insert("wakes".into(), Value::Array(wakes));
    info.insert("viewers".into(), json!([]));
    info.insert("broker".into(), json!(here.broker));
    Answer::Body(StatusCode::OK, Value::Object(info))
}

/// `claudeHome()`: `CLAUDE_CONFIG_DIR` when it is not empty, else `~/.claude`.
fn claude_home() -> String {
    std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| join(&home(), ".claude"))
}

async fn ranger(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    if s.gates.tmux {
        return not_ported(method, uri).await;
    }
    // the hub reads its settings at its start; a config that will not read
    // leaves it unloaded, and every route says so
    let Ok(raw) = config(&s).await else {
        let error = "the ranger's settings and wakes could not be read; see the server log";
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": error })),
        )
            .into_response();
    };
    let backend = backend_name(&s, &raw);
    let (dir, root, broker) = (s.config_dir.clone(), s.root.clone(), s.gates.chan);
    let a = blocking(move || {
        let claude = claude_home();
        ranger_answer(
            &raw,
            &RangerHere {
                config_dir: &dir,
                root: &root,
                backend: &backend,
                claude_home: &claude,
                broker,
            },
        )
    })
    .await;
    reply(a, method, uri).await
}

/* ---------- kit ---------- */

/// `kitPath()`: `CANOPY_KIT` (empty counts as set, as `??` has it), else
/// `~/.claude/kit.json`.
fn kit_path() -> String {
    env_raw("CANOPY_KIT").unwrap_or_else(|| join(&home(), ".claude/kit.json"))
}

/// `GET /api/kit` once the scan has read kit.json: the error the Bun server
/// keeps when the file is not there, and 501 for any other.
pub fn kit_answer(path: &str) -> Answer {
    // a path Bun would name otherwise than as given is not answered
    if !path.starts_with('/') || normalize(path) != path {
        return Answer::NotPorted;
    }
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let error = format!("kit.json: ENOENT: no such file or directory, open '{path}'");
            Answer::Body(
                StatusCode::OK,
                json!({
                    "ok": false,
                    "error": error,
                    "machines": [],
                    "cells": [],
                    "loadouts": { "base": [], "loadouts": [], "errors": [error], "servers": [] },
                }),
            )
        }
        _ => Answer::NotPorted,
    }
}

async fn kit(method: Method, uri: Uri) -> Response {
    let a = blocking(move || kit_answer(&kit_path())).await;
    reply(a, method, uri).await
}

/* ---------- worktrees ---------- */

/// Whether a folder lists any entry ending in `.json`.
fn has_json(dir: &str) -> bool {
    std::fs::read_dir(dir).is_ok_and(|d| {
        d.flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".json"))
    })
}

/// Whether the worktrees root holds anything the pool or the landing queue
/// would list: a folder under a repo's key (a run's tree, an orphan or a
/// warm slot), or a warm record with entries.
fn root_holds_work(root: &str) -> bool {
    let Ok(keys) = std::fs::read_dir(root) else {
        return false;
    };
    for key in keys.flatten() {
        let key = key.path();
        let Ok(entries) = std::fs::read_dir(&key) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            // stat, not lstat: a link to a folder counts, as `listRunTreeDirs` has it
            if std::fs::metadata(e.path()).is_ok_and(|m| m.is_dir()) {
                return true;
            }
            if name == WARM_RECORD
                && !read_text(&e.path().to_string_lossy()).is_ok_and(|t| holds_nothing(&t))
            {
                return true;
            }
        }
    }
    false
}

/// `GET /api/worktrees` (`WarmPool.info`) while nothing is held: each local
/// repo with its count from the config, its gates file's `warm`, and no
/// runs, warm trees, refill, fails or orphans; the root and its volume's
/// free bytes.
pub fn worktrees_answer(raw: &Value, config_dir: &str, repos: &[Repo]) -> Answer {
    let local: Vec<&Repo> = repos
        .iter()
        .filter(|r| r.host.is_none() && r.path.starts_with('/'))
        .collect();
    let root = resolve(&join(config_dir, "worktrees"));
    let root_there = std::fs::metadata(&root).is_ok_and(|m| m.is_dir());
    if has_json(&join(config_dir, "landing/runs"))
        || root_holds_work(&root)
        || (!root_there && !local.is_empty())
        || local.iter().any(|r| warm_for(raw, &r.path) > 0.0)
    {
        return Answer::NotPorted;
    }
    let mut out = vec![];
    for r in local {
        let gates = match read_gates(&r.path) {
            Ok(g) => g,
            Err(e) if e.not_json => return Answer::NotPorted,
            Err(e) => {
                return Answer::Body(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": e.message }),
                );
            }
        };
        let mut repo = Map::new();
        repo.insert("repoId".into(), json!(r.id));
        repo.insert("repoPath".into(), json!(r.path));
        repo.insert("want".into(), json!(0));
        if let Some(w) = gates.get("warm") {
            repo.insert("fileWarm".into(), w.clone());
        }
        repo.insert("runs".into(), json!([]));
        repo.insert("warm".into(), json!([]));
        repo.insert("refilling".into(), Value::Null);
        repo.insert("fails".into(), json!([]));
        repo.insert("orphans".into(), json!([]));
        out.push(Value::Object(repo));
    }
    let free = free_bytes(&root).unwrap_or(0.0);
    Answer::Body(
        StatusCode::OK,
        json!({ "root": root, "free": canopy_core::screenlayouts::js_num(free), "repos": out }),
    )
}

async fn worktrees(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let raw = match config(&s).await {
        Ok(raw) => raw,
        Err(e) => return e.into_response(),
    };
    let repos = s.result.read().await.repos.clone();
    let dir = s.config_dir.clone();
    let a = blocking(move || worktrees_answer(&raw, &dir, &repos)).await;
    reply(a, method, uri).await
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/history", read(history))
        .route("/api/clips", read(clips))
        .route("/api/secrets", read(secrets))
        .route("/api/ranger", read(ranger))
        .route("/api/kit", read(kit))
        .route("/api/worktrees", read(worktrees))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(a: Answer) -> Value {
        match a {
            Answer::Body(StatusCode::OK, v) | Answer::NoStore(v) => v,
            other => panic!("not a 200: {other:?}"),
        }
    }

    fn dir() -> (tempfile::TempDir, String) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().to_str().unwrap().to_string();
        (d, p)
    }

    fn write(path: &str, text: &str) {
        let p = std::path::Path::new(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn history_without_a_cli_says_why_and_with_one_is_not_answered_here() {
        let (_d, home) = dir();
        let none = |_: &str| -> Option<String> { None };
        let a = body(history_answer(
            &json!({}),
            &home,
            &none,
            1_764_300_000_000.0,
        ));
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            format!(
                r#"{{"available":false,"reason":"{}","fetchedAt":1764300000000}}"#,
                canopy_core::history::NOT_FOUND
            )
        );
        let missing = json!({ "historyBin": "/nope/claude-history" });
        assert_eq!(
            body(history_answer(&missing, &home, &none, 1.0))["reason"],
            "historyBin in config points at /nope/claude-history, which does not exist"
        );
        let found = |_: &str| -> Option<String> { Some("/usr/bin/claude-history".into()) };
        assert_eq!(
            history_answer(&json!({}), &home, &found, 1.0),
            Answer::NotPorted
        );
    }

    #[test]
    fn clips_are_read_back_pruned_and_picked_by_id() {
        let (_d, cfg) = dir();
        assert_eq!(body(clips_answer(&cfg, "", 1.0)), json!({ "clips": [] }));
        let now = 100.0 * 86_400_000.0;
        let old = now - 15.0 * 86_400_000.0;
        write(
            &join(&cfg, "clips.json"),
            &json!([
                { "id": "c-aaaaaaaa", "text": "old", "source": "cli", "at": old },
                { "id": "c-bbbbbbbb", "text": "pinned", "source": "page", "at": old, "pinned": true },
                { "id": "c-cccccccc", "text": "new", "source": "clipboard", "at": now - 1.0 },
                { "id": "bad", "text": "x", "source": "cli", "at": now },
            ])
            .to_string(),
        );
        let all = body(clips_answer(&cfg, "", now));
        let ids: Vec<&str> = all["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["c-cccccccc", "c-bbbbbbbb"]);
        assert_eq!(all["clips"][0]["source"], "device");
        let some = body(clips_answer(&cfg, "ids=c-bbbbbbbb,c-aaaaaaaa,nope", now));
        assert_eq!(some["clips"].as_array().unwrap().len(), 1);
        assert_eq!(some["clips"][0]["id"], "c-bbbbbbbb");
        assert_eq!(
            body(clips_answer(&cfg, "ids=", now)),
            json!({ "clips": [] })
        );
        // a file that is not JSON is no clips
        write(&join(&cfg, "clips.json"), "{nope");
        assert_eq!(body(clips_answer(&cfg, "", now)), json!({ "clips": [] }));
        // one that will not read is the Bun server's 500, in Node's words
        std::fs::remove_file(join(&cfg, "clips.json")).unwrap();
        std::fs::create_dir(join(&cfg, "clips.json")).unwrap();
        assert_eq!(clips_answer(&cfg, "", now), Answer::NotPorted);
    }

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k: &str| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn with_nothing_pinned_it_says_what_to_run() {
        let (_d, cfg) = dir();
        let a = secrets_answer(&cfg, "mini", &env_of(&[]), false);
        let Answer::NoStore(info) = a else {
            panic!("{a:?}")
        };
        assert!(
            info["error"]
                .as_str()
                .unwrap()
                .contains("canopy secrets pin")
        );
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"ok":false,"error":"no mini signing key pinned yet; run canopy secrets pin <key> --remote <url>","backend":"mini","role":"reader","head":null,"sinksAt":null,"refused":null,"lock":"none","recipient":null,"secrets":[],"sinks":[],"proposals":[],"passkeys":[],"session":false,"firstPasskey":false,"gate":"https://canopy.beric.ca/?view=secrets","unpushed":0}"#
        );
        // a pin without a remote pulls nothing either
        let pin = format!("{}=", "A".repeat(43));
        write(
            &join(&cfg, "secrets-config.json"),
            &json!({ "pin": pin, "remote": null }).to_string(),
        );
        let origin = env_of(&[("CANOPY_SECRETS_ORIGIN", "")]);
        assert_eq!(
            body(secrets_answer(&cfg, "mini", &origin, false))["gate"],
            "/?view=secrets"
        );
    }

    #[test]
    fn a_key_on_disk_reads_locked_and_what_pulls_or_relays_is_not_answered_here() {
        let (_d, cfg) = dir();
        write(&join(&cfg, "secrets-key.age"), "wrapped");
        assert_eq!(
            body(secrets_answer(&cfg, "mini", &env_of(&[]), false))["lock"],
            "locked"
        );
        // a Mac's keychain may open it at the start
        assert_eq!(
            secrets_answer(&cfg, "mac", &env_of(&[]), true),
            Answer::NotPorted
        );
        let relay = env_of(&[("CANOPY_SECRETS_SOCKET", "/run/secrets.sock")]);
        assert_eq!(
            secrets_answer(&cfg, "mini", &relay, false),
            Answer::NotPorted
        );
        let empty = env_of(&[("CANOPY_SECRETS_SOCKET", "")]);
        assert!(matches!(
            secrets_answer(&cfg, "mini", &empty, false),
            Answer::NoStore(_)
        ));
        let pin = format!("{}=", "A".repeat(43));
        write(
            &join(&cfg, "secrets-config.json"),
            &json!({ "pin": pin, "remote": "ssh://git@forge/eric/secrets.git" }).to_string(),
        );
        assert_eq!(
            secrets_answer(&cfg, "mini", &env_of(&[]), false),
            Answer::NotPorted
        );
    }

    fn here<'a>(cfg: &'a str, claude: &'a str) -> RangerHere<'a> {
        RangerHere {
            config_dir: cfg,
            root: "/home/eric/dev",
            backend: "mini",
            claude_home: claude,
            broker: false,
        }
    }

    #[test]
    fn the_ranger_without_tmux_is_off_until_turned_on_and_then_no_tmux() {
        let (_d, cfg) = dir();
        let (_c, claude) = dir();
        let off = body(ranger_answer(&json!({}), &here(&cfg, &claude)));
        assert_eq!(
            serde_json::to_string(&off).unwrap(),
            format!(
                r#"{{"on":false,"state":"off","term":"{}","handle":"ranger","backend":"mini","root":"/home/eric/dev","home":"{cfg}/ranger/home","session":null,"transcript":null,"fails":0,"restarts":0,"telegram":"off","settings":{{"on":false,"profile":null,"handle":null,"telegram":false,"fresh":{{"daily":"04:00","maxMb":25}},"home":"own"}},"wakes":[],"viewers":[],"broker":false}}"#,
                ranger_term_id("mini")
            )
        );
        let raw = json!({ "ranger": { "on": true, "telegram": true, "home": "root", "handle": "ranger-mini" } });
        write(
            &join(&cfg, "ranger/state.json"),
            r#"{"session":"0123abcd-0123-0123-0123-0123456789ab","sessionAt":5,"exitedAt":9,"exitCode":1,"fails":2}"#,
        );
        write(
            &join(&cfg, "ranger/wakes.json"),
            r#"[{"id":"0000000a","by":"eric","prompt":"morning","created":1,"cron":"0 8 * * *","next":2},{"id":"bad"}]"#,
        );
        write(
            &join(&claude, "settings.json"),
            &json!({ "enabledPlugins": { TELEGRAM_PLUGIN: true } }).to_string(),
        );
        let on = body(ranger_answer(&raw, &here(&cfg, &claude)));
        assert_eq!(on["state"], "no-tmux");
        assert_eq!(on["handle"], "ranger-mini");
        assert_eq!(on["home"], "/home/eric/dev");
        assert_eq!(on["session"], "0123abcd-0123-0123-0123-0123456789ab");
        assert_eq!(on["sessionAt"], 5);
        assert_eq!(on["fails"], 2);
        assert_eq!(on["lastExit"], json!({ "at": 9, "code": 1 }));
        assert_eq!(on["telegram"], "contested");
        assert_eq!(on["wakes"].as_array().unwrap().len(), 1);
        assert_eq!(on.get("startedAt"), None);
    }

    #[test]
    fn kit_json_not_there_is_the_scans_error_and_any_other_is_not_answered_here() {
        let (_d, home) = dir();
        let path = format!("{home}/.claude/kit.json");
        let a = body(kit_answer(&path));
        let error = format!("kit.json: ENOENT: no such file or directory, open '{path}'");
        assert_eq!(
            a,
            json!({ "ok": false, "error": error, "machines": [], "cells": [], "loadouts": { "base": [], "loadouts": [], "errors": [error], "servers": [] } })
        );
        write(&path, "{}");
        assert_eq!(kit_answer(&path), Answer::NotPorted);
        assert_eq!(kit_answer("kit.json"), Answer::NotPorted);
        assert_eq!(kit_answer(""), Answer::NotPorted);
        assert_eq!(
            kit_answer(&format!("{home}/x/../kit.json")),
            Answer::NotPorted
        );
    }

    fn repo(id: &str, path: &str) -> Repo {
        Repo {
            id: id.into(),
            name: id.into(),
            path: path.into(),
            ..Default::default()
        }
    }

    #[test]
    fn the_worktrees_listing_while_nothing_is_held() {
        let (_d, cfg) = dir();
        let (_r, repos) = dir();
        let app = join(&repos, "app");
        let web = join(&repos, "web");
        write(
            &join(&app, ".canopy/gates.json"),
            r#"{"gates":[],"warm":1}"#,
        );
        std::fs::create_dir_all(&web).unwrap();
        let list = vec![
            repo("app", &app),
            repo("web", &web),
            Repo {
                host: Some("mini".into()),
                ..repo("far", "/srv/far")
            },
        ];
        // no root, and local repos: the Bun server holding the lock makes it
        assert_eq!(worktrees_answer(&json!({}), &cfg, &list), Answer::NotPorted);
        std::fs::create_dir_all(join(&cfg, "worktrees")).unwrap();
        let a = body(worktrees_answer(&json!({}), &cfg, &list));
        assert_eq!(a["root"], join(&cfg, "worktrees"));
        assert!(a["free"].as_f64().is_some_and(|n| n > 0.0));
        assert_eq!(
            a["repos"],
            json!([
                { "repoId": "app", "repoPath": app, "want": 0, "fileWarm": 1, "runs": [], "warm": [], "refilling": null, "fails": [], "orphans": [] },
                { "repoId": "web", "repoPath": web, "want": 0, "runs": [], "warm": [], "refilling": null, "fails": [], "orphans": [] },
            ])
        );
        // an empty record, as a lock holder's adopt leaves one, holds nothing
        write(
            &join(&cfg, "worktrees/app-1234abcd/warm.json"),
            r#"{"trees":[],"fails":[]}"#,
        );
        assert!(matches!(
            worktrees_answer(&json!({}), &cfg, &list),
            Answer::Body(StatusCode::OK, _)
        ));
        // no repo at all needs no root
        assert!(matches!(
            worktrees_answer(&json!({}), "/no/such/config", &[]),
            Answer::Body(StatusCode::OK, _)
        ));
    }

    #[test]
    fn the_worktrees_listing_is_not_answered_while_anything_is_held() {
        let (_d, cfg) = dir();
        let (_r, repos) = dir();
        let app = join(&repos, "app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(join(&cfg, "worktrees")).unwrap();
        let list = vec![repo("app", &app)];
        let held = |f: &dyn Fn()| {
            f();
            assert_eq!(worktrees_answer(&json!({}), &cfg, &list), Answer::NotPorted);
        };
        // a repo this machine keeps warm trees for
        let mut warm = Map::new();
        warm.insert(app.clone(), json!(1));
        assert_eq!(
            worktrees_answer(&json!({ "warm": warm }), &cfg, &list),
            Answer::NotPorted
        );
        // a warm record with a fail in it
        held(&|| {
            write(
                &join(&cfg, "worktrees/app-1/warm.json"),
                r#"{"trees":[],"fails":[{"dir":"x"}]}"#,
            )
        });
        std::fs::remove_dir_all(join(&cfg, "worktrees/app-1")).unwrap();
        // a run's tree or a warm slot under a repo's key
        held(&|| std::fs::create_dir_all(join(&cfg, "worktrees/app-1/r-1")).unwrap());
        std::fs::remove_dir_all(join(&cfg, "worktrees/app-1")).unwrap();
        // a landing run on record
        held(&|| write(&join(&cfg, "landing/runs/r-1.json"), "{}"));
        std::fs::remove_dir_all(join(&cfg, "landing")).unwrap();
        // a gates file that is not JSON (JavaScriptCore's words), and one
        // that is wrong, which the Bun server answers 500 with
        held(&|| write(&join(&app, ".canopy/gates.json"), "{"));
        write(&join(&app, ".canopy/gates.json"), "[]");
        assert_eq!(
            worktrees_answer(&json!({}), &cfg, &list),
            Answer::Body(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": ".canopy/gates.json must be an object" })
            )
        );
    }
}
