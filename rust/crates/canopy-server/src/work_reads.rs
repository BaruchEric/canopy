//! The work-state reads the page makes on its first load: the incubator's
//! projects, stages and advice, the landing queue, the kept worktrees, the
//! PR watch and the work ledger. The Bun server's answers come from hubs
//! that take records back at its start (only the server holding the flows
//! lock, `flows/owner.lock`, takes them) and then change them as runs,
//! flows and passes go. This port runs none of that, so each route answers
//! only where its answer is the Bun server's own, and 501 otherwise:
//!
//! - `/api/incubator/advice` reads `incubator/improvements.json` as both
//!   kinds of Bun server do (`offered` in core/retro.ts), always.
//! - `/api/incubator` is `[]` while no sprout record is on disk. With one,
//!   the keeper's restore requeues and pumps stages, so it is 501.
//! - `/api/incubator/stages` says "stages off" (or "unisolated" with
//!   `CANOPY_INCUBATOR_UNISOLATED=1`) with nothing waiting, while no stage
//!   runner is set (`CANOPY_STAGE_SOCKET`), no sprout record is on disk and
//!   no flows lock is there for another canopy to hold. Otherwise its
//!   fields are the runner's hello and the keeper's live queue: 501.
//! - `/api/landing` is the empty queue with the notices `landing/notices.json`
//!   keeps, while nothing would bring a branch run back or start one: no
//!   landing run, queue or group record, no run worktree under `worktrees/`
//!   (an orphan the keeper would look into with git), no flow record and no
//!   trigger event queued. Collisions come from live runs, so there are none.
//! - `/api/prs` is `[]` under the same quiet and with no `prs/` record; a
//!   record's watch is read from GitHub on the keeper's loop.
//! - `/api/work` is the ledger under `work/` under the same quiet, where
//!   every item's facts are empty: the items as stored, unless an open one
//!   holds a state other than "open", which the keeper would rewrite.
//! - `/api/trees` is the kept trees (core/branchtrees.ts) where the keeper's
//!   adopt would change no record (every tree's folder there and listed by
//!   git, none caught preparing or merging, no unrecorded worktree on a
//!   branch) and its follow pass would rebase none (no tree that follows a
//!   base whose commit moved past `syncedTo`), with no tmux to hold shells
//!   in them. With trees on record and a flows lock present it is 501, since
//!   a canopy without the lock lists none.
//! - `/api/health` is not here: every check is a live probe or a piece's own
//!   report with its clock, and no subset is the Bun server's list, so it
//!   stays 501 in the fallback.
//!
//! Every other method on these paths, and `/api/incubator/one`,
//! `/api/landing/diff` and `/api/work/one`, answer 501.

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use canopy_core::branchtrees::{
    TREE_PORTS_DEFAULT, TREES_RECORD, TreeRecord, list_tree_dirs, parse_trees_record, tree_status,
};
use canopy_core::exec::git;
use canopy_core::git::parse_worktree_list;
use canopy_core::jsjson::{self, Unheld};
use canopy_core::pathx::{basename, join, resolve};
use canopy_core::retro::{offered, parse_improvements};
use canopy_core::types::Repo;
use canopy_core::work::{WORK_STATES, WorkFacts, state_of};
use canopy_core::workstore::{read_work_items, work_dir};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use crate::app::AppState;
use crate::routes::not_ported;
use crate::tree::repo_key;

use crate::routes::read;

/// An answer, or None where it would not be the Bun server's (501).
type Answer = Option<Value>;

async fn answer(a: Answer, method: Method, uri: Uri) -> Response {
    match a {
        Some(v) => Json(v).into_response(),
        None => not_ported(method, uri).await,
    }
}

/// File work off the async workers; a task that panicked is a 501.
async fn blocking<F: FnOnce() -> Answer + Send + 'static>(f: F) -> Answer {
    tokio::task::spawn_blocking(f).await.ok().flatten()
}

use crate::routes::has_json;

/// Whether the flows lock is there: some canopy took it, and whether one
/// still holds it is not this port's to tell, so whether a Bun server here
/// would keep the records is not known.
fn lock_present(config_dir: &str) -> bool {
    Path::new(&join(config_dir, "flows/owner.lock")).exists()
}

/// `isSproutId`: `sp_` and twelve lowercase hex digits.
fn is_sprout_id(name: &str) -> bool {
    name.len() == 15
        && name.starts_with("sp_")
        && name[3..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether `incubator/` holds a sprout's record. Any one counts, whatever
/// root it was written for or however it reads, which can only make the
/// route say 501 where the Bun server would have listed nothing.
fn sprout_records(config_dir: &str) -> bool {
    let store = join(config_dir, "incubator");
    std::fs::read_dir(&store).is_ok_and(|d| {
        d.flatten().any(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            is_sprout_id(&name) && Path::new(&join(&join(&store, &name), "sprout.json")).is_file()
        })
    })
}

/// Whether `triggers/events.json` keeps an event queued, which the trigger
/// hub starts as a run when it takes the events back.
fn queued_trigger_events(config_dir: &str) -> bool {
    let Ok(text) = jsjson::read_text(&join(config_dir, "triggers/events.json")) else {
        return false;
    };
    match jsjson::parse(&text) {
        Err(Unheld) => true,
        Ok(None) => false,
        Ok(Some(v)) => v
            .get("events")
            .and_then(Value::as_array)
            .is_some_and(|list| {
                list.iter().any(|e| {
                    e.get("id").is_some_and(Value::is_string)
                        && e.get("key").is_some_and(Value::is_string)
                        && e.get("status").and_then(Value::as_str) == Some("queued")
                })
            }),
    }
}

/// Nothing the keeper takes back at its start would start a run: no flow
/// record and no trigger event queued.
fn quiet(config_dir: &str) -> bool {
    !has_json(&join(config_dir, "flows")) && !queued_trigger_events(config_dir)
}

/// Whether `landing/` keeps a branch run, a queue or a best-of-N group.
fn landing_records(config_dir: &str) -> bool {
    ["runs", "queue", "groups"]
        .iter()
        .any(|sub| has_json(&join(&join(config_dir, "landing"), sub)))
}

/// `isWarmName` (core/warm.ts): a warm slot's folder, `warm-<n>`.
fn is_warm_name(name: &str) -> bool {
    name.strip_prefix("warm-").is_some_and(|n| {
        !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// Whether `listRunTreeDirs` finds a run's worktree under `worktrees/`.
fn run_tree_dirs(config_dir: &str) -> bool {
    let Ok(keys) = std::fs::read_dir(join(config_dir, "worktrees")) else {
        return false;
    };
    keys.flatten().any(|k| {
        std::fs::read_dir(k.path()).is_ok_and(|ids| {
            ids.flatten().any(|id| {
                !is_warm_name(&id.file_name().to_string_lossy())
                    && std::fs::metadata(id.path()).is_ok_and(|m| m.is_dir())
            })
        })
    })
}

/* ---------- the incubator ---------- */

async fn incubator(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let dir = s.config_dir.clone();
    let a = blocking(move || (!sprout_records(&dir)).then(|| json!([]))).await;
    answer(a, method, uri).await
}

/// `{ ...stagesNow(), notKeeping }` on a keeper with no stage runner and no
/// sprouts: nothing waits, no fence or login to speak of.
fn stages_answer(config_dir: &str, socket: Option<String>, unisolated: bool) -> Answer {
    if socket.is_some_and(|v| !v.is_empty())
        || sprout_records(config_dir)
        || lock_present(config_dir)
    {
        return None;
    }
    let mode = if unisolated { "unisolated" } else { "off" };
    Some(
        json!({ "isolated": false, "mode": mode, "waiting": null, "unfenced": null, "login": null, "notKeeping": null }),
    )
}

async fn stages(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let dir = s.config_dir.clone();
    let socket = std::env::var("CANOPY_STAGE_SOCKET").ok();
    let unisolated = std::env::var("CANOPY_INCUBATOR_UNISOLATED").as_deref() == Ok("1");
    let a = blocking(move || stages_answer(&dir, socket, unisolated)).await;
    answer(a, method, uri).await
}

/// The improvements list's offers; a file that will not read is empty.
fn advice_answer(config_dir: &str) -> Answer {
    let Ok(text) = jsjson::read_text(&join(config_dir, "incubator/improvements.json")) else {
        return Some(json!([]));
    };
    match parse_improvements(&text) {
        Err(Unheld) => None,
        Ok(None) => Some(json!([])),
        Ok(Some(entries)) => Some(Value::Array(offered(&entries))),
    }
}

async fn advice(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let dir = s.config_dir.clone();
    let a = blocking(move || advice_answer(&dir)).await;
    answer(a, method, uri).await
}

/* ---------- the landing queue and the PR watch ---------- */

/// `MAX_NOTICES` (core/landing.ts)
const MAX_NOTICES: usize = 50;

/// The notices the keeper reads back (`adoptRecords`): those with an id,
/// newest first, at most fifty. None where the Bun server's start would
/// fail on the file (not JSON), where a notice has no number for its time
/// (JavaScript's sort coerces it), or where a canopy without the lock
/// would have read none.
fn kept_notices(config_dir: &str) -> Option<Vec<Value>> {
    let Ok(text) = jsjson::read_text(&join(config_dir, "landing/notices.json")) else {
        return Some(vec![]);
    };
    let v = jsjson::parse(&text).ok()??;
    let Some(list) = v.as_array() else {
        return Some(vec![]);
    };
    let mut notices: Vec<&Value> = list
        .iter()
        .filter(|n| n.is_object() && n.get("id").is_some_and(Value::is_string))
        .collect();
    if notices.is_empty() {
        return Some(vec![]);
    }
    if lock_present(config_dir) || notices.iter().any(|n| !n["at"].is_number()) {
        return None;
    }
    let at = |n: &Value| n["at"].as_f64().unwrap_or(0.0);
    notices.sort_by(|a, b| {
        (at(b) - at(a))
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(
        notices
            .into_iter()
            .take(MAX_NOTICES)
            .map(jsjson::to_js)
            .collect(),
    )
}

fn landing_answer(config_dir: &str) -> Answer {
    if !quiet(config_dir) || landing_records(config_dir) || run_tree_dirs(config_dir) {
        return None;
    }
    let notices = kept_notices(config_dir)?;
    Some(
        json!({ "runs": [], "entries": [], "orphans": [], "notices": notices, "collisions": [], "groups": [] }),
    )
}

async fn landing(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let dir = s.config_dir.clone();
    let a = blocking(move || landing_answer(&dir)).await;
    answer(a, method, uri).await
}

fn prs_answer(config_dir: &str) -> Answer {
    let quietly =
        quiet(config_dir) && !landing_records(config_dir) && !has_json(&join(config_dir, "prs"));
    quietly.then(|| json!([]))
}

async fn prs(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let dir = s.config_dir.clone();
    let a = blocking(move || prs_answer(&dir)).await;
    answer(a, method, uri).await
}

/* ---------- the work ledger ---------- */

/// `GET /api/work?repo=&state=`'s list, where every item's facts are empty.
fn work_answer(config_dir: &str, repo: Option<String>, state: Option<String>) -> Answer {
    if !quiet(config_dir) || landing_records(config_dir) {
        return None;
    }
    let items = read_work_items(&work_dir(config_dir)).ok()?;
    if !items.is_empty() && lock_present(config_dir) {
        return None;
    }
    let none = WorkFacts::default();
    let moves = items.iter().any(|i| {
        let stored = i["state"].as_str().unwrap_or("");
        state_of(stored, i.get("closedAt").is_some(), &none) != stored
    });
    if moves {
        return None;
    }
    let mut items: Vec<Value> = items
        .into_iter()
        .filter(|i| {
            repo.as_ref().is_none_or(|r| {
                i["repos"]
                    .as_array()
                    .is_some_and(|rs| rs.iter().any(|x| x.as_str() == Some(r)))
            })
        })
        .filter(|i| {
            state
                .as_ref()
                .is_none_or(|st| i["state"].as_str() == Some(st))
        })
        .collect();
    let updated = |i: &Value| i["updatedAt"].as_f64().unwrap_or(0.0);
    items.sort_by(|a, b| {
        (updated(b) - updated(a))
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let items: Vec<Value> = items.iter().map(jsjson::to_js).collect();
    Some(json!({ "items": items, "archived": 0 }))
}

/// The first value of a query parameter, decoded as `URLSearchParams` does.
fn param(uri: &Uri, key: &str) -> Option<String> {
    form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

async fn work(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let state = param(&uri, "state");
    if let Some(st) = &state
        && !WORK_STATES.contains(&st.as_str())
    {
        let error = format!("state must be one of {}", WORK_STATES.join(", "));
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let repo = param(&uri, "repo").filter(|r| !r.is_empty());
    let dir = s.config_dir.clone();
    let a = blocking(move || work_answer(&dir, repo, state)).await;
    answer(a, method, uri).await
}

/* ---------- the kept worktrees ---------- */

/// `real()`: the path with its links followed, else resolved as it stands.
fn real(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| resolve(path))
}

/// One repo with trees on record or folders beside its record.
struct RepoTrees {
    repo: Repo,
    repo_dir: String,
    trees: Vec<TreeRecord>,
    dirs: Vec<String>,
}

/// Each local repo's record and folders, as `adopt` reads them; None where
/// a record would not read (the Bun server's start fails on it, or it holds
/// what serde_json cannot).
fn trees_on_disk(root: &str, repos: Vec<Repo>) -> Option<Vec<RepoTrees>> {
    let mut out = vec![];
    for repo in repos {
        let repo_dir = join(root, &repo_key(&repo.path));
        let file = join(&repo_dir, TREES_RECORD);
        let trees = if Path::new(&file).exists() {
            parse_trees_record(&jsjson::read_text(&file).ok()?).ok()?
        } else {
            vec![]
        };
        let dirs = list_tree_dirs(&repo_dir);
        if trees.is_empty() && dirs.is_empty() {
            continue;
        }
        out.push(RepoTrees {
            repo,
            repo_dir,
            trees,
            dirs,
        });
    }
    Some(out)
}

/// `revOf()`: the commit a ref names, or None.
async fn rev_of(path: &str, reference: &str) -> Option<String> {
    let spec = format!("{reference}^{{commit}}");
    let r = git(path, &["rev-parse", "-q", "--verify", &spec]).await;
    let out = r.stdout.trim();
    (r.code == 0 && !out.is_empty()).then(|| out.to_string())
}

/// Whether the keeper's adopt would take this repo's record as it stands,
/// and its follow pass would leave every tree where it is.
async fn settled(rt: &RepoTrees) -> bool {
    let list = git(&rt.repo.path, &["worktree", "list", "--porcelain"]).await;
    let mut listed: HashMap<String, Option<String>> = HashMap::new();
    if list.code == 0 {
        for w in parse_worktree_list(&list.stdout).into_iter().skip(1) {
            if !w.bare && !w.prunable {
                listed.insert(real(&w.path), w.branch);
            }
        }
    }
    for t in &rt.trees {
        let dir = join(&rt.repo_dir, &t.slug);
        if !rt.dirs.contains(&dir) || !listed.contains_key(&real(&dir)) {
            return false;
        }
        if t.state == "merging" || t.state == "preparing" {
            return false;
        }
    }
    for dir in &rt.dirs {
        let slug = basename(dir);
        if rt.trees.iter().any(|t| t.slug == slug) {
            continue;
        }
        if listed
            .get(&real(dir))
            .is_some_and(|b| b.as_deref().is_some_and(|b| !b.is_empty()))
        {
            return false;
        }
    }
    for t in &rt.trees {
        let dir = join(&rt.repo_dir, &t.slug);
        let follows =
            t.sync && (t.state == "ready" || t.state == "failed") && Path::new(&dir).exists();
        if follows
            && let Some(at) = rev_of(&rt.repo.path, &t.base).await
            && t.synced_to.as_deref() != Some(at.as_str())
        {
            return false;
        }
    }
    true
}

async fn trees(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let root = resolve(&join(&s.config_dir, "trees"));
    let ports = std::env::var("CANOPY_TREE_PORTS").unwrap_or_else(|_| TREE_PORTS_DEFAULT.into());
    let local: Vec<Repo> = s
        .result
        .read()
        .await
        .repos
        .iter()
        .filter(|r| r.host.is_none() && r.path.starts_with('/'))
        .cloned()
        .collect();
    let at = root.clone();
    let on_disk = tokio::task::spawn_blocking(move || trees_on_disk(&at, local))
        .await
        .ok()
        .flatten();
    let Some(on_disk) = on_disk else {
        return not_ported(method, uri).await;
    };
    if !on_disk.is_empty() && (lock_present(&s.config_dir) || s.gates.tmux) {
        return not_ported(method, uri).await;
    }
    let mut repos = vec![];
    for rt in &on_disk {
        if !settled(rt).await {
            return not_ported(method, uri).await;
        }
        if rt.trees.is_empty() {
            continue;
        }
        let mut trees = vec![];
        for t in &rt.trees {
            let dir = join(&rt.repo_dir, &t.slug);
            let mut tree = t.json.as_object().cloned().unwrap_or_default();
            tree.insert("dir".into(), json!(dir));
            let st = if Path::new(&dir).exists() {
                tree_status(&dir, &t.base).await
            } else {
                json!({ "head": "", "ahead": 0, "behind": 0, "files": 0 })
                    .as_object()
                    .cloned()
                    .unwrap_or_default()
            };
            tree.extend(st);
            // without tmux no shell outlives a restart, so none sits in a tree
            tree.insert("shells".into(), json!(0));
            trees.push(Value::Object(tree));
        }
        repos.push(json!({ "repoId": rt.repo.id, "repoPath": rt.repo.path, "trees": trees }));
    }
    Json(json!({ "root": root, "ports": ports, "repos": repos })).into_response()
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/incubator", read(incubator))
        .route("/api/incubator/stages", read(stages))
        .route("/api/incubator/advice", read(advice))
        .route("/api/landing", read(landing))
        .route("/api/prs", read(prs))
        .route("/api/work", read(work))
        .route("/api/trees", read(trees))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> (tempfile::TempDir, String) {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().to_str().unwrap().to_string();
        (t, p)
    }

    fn put(base: &str, rel: &str, text: &str) {
        let path = join(base, rel);
        std::fs::create_dir_all(canopy_core::pathx::dirname(&path)).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn the_stages_say_off_until_a_runner_a_sprout_or_a_lock_makes_them_live() {
        let (_t, c) = dir();
        let off = stages_answer(&c, None, false).unwrap();
        assert_eq!(
            off.to_string(),
            r#"{"isolated":false,"mode":"off","waiting":null,"unfenced":null,"login":null,"notKeeping":null}"#
        );
        assert_eq!(
            stages_answer(&c, Some(String::new()), true).unwrap()["mode"],
            "unisolated"
        );
        assert_eq!(
            stages_answer(&c, Some("/run/stage.sock".into()), false),
            None
        );
        put(&c, "flows/owner.lock", r#"{"pid":1,"token":"t"}"#);
        assert_eq!(stages_answer(&c, None, false), None);
        let (_u, c) = dir();
        put(&c, "incubator/sp_0123456789ab/sprout.json", "{}");
        assert_eq!(stages_answer(&c, None, false), None);
        // a folder that is no sprout's is not a record
        let (_v, c) = dir();
        put(&c, "incubator/sp_nothex/sprout.json", "{}");
        put(&c, "incubator/improvements.json", "{}");
        assert!(stages_answer(&c, None, false).is_some());
    }

    #[test]
    fn the_landing_queue_is_empty_with_its_notices_only_while_nothing_brings_a_run_back() {
        let (_t, c) = dir();
        assert_eq!(
            landing_answer(&c).unwrap().to_string(),
            r#"{"runs":[],"entries":[],"orphans":[],"notices":[],"collisions":[],"groups":[]}"#
        );
        put(
            &c,
            "landing/notices.json",
            r#"[{"id":"a","at":1.0,"text":"old"},{"id":"b","at":3,"text":"new"},{"at":2},"x",{"id":"c","at":2}]"#,
        );
        let notices = &landing_answer(&c).unwrap()["notices"];
        assert_eq!(
            notices.to_string(),
            r#"[{"id":"b","at":3,"text":"new"},{"id":"c","at":2},{"id":"a","at":1,"text":"old"}]"#
        );
        // a warm slot is no orphan; a run's worktree is
        put(&c, "worktrees/app-1234abcd/warm-1/f", "");
        assert!(landing_answer(&c).is_some());
        put(&c, "worktrees/app-1234abcd/run-1/f", "");
        assert_eq!(landing_answer(&c), None);
        for rel in [
            "landing/runs/r.json",
            "landing/queue/q.json",
            "landing/groups/g.json",
            "flows/f.json",
        ] {
            let (_u, c) = dir();
            put(&c, rel, "{}");
            assert_eq!(landing_answer(&c), None, "{rel}");
        }
        // a queued trigger event starts a run at the start; a stopped one does not
        let (_u, c) = dir();
        put(
            &c,
            "triggers/events.json",
            r#"{"events":[{"id":"e","key":"k","status":"stopped"}]}"#,
        );
        assert!(landing_answer(&c).is_some());
        put(
            &c,
            "triggers/events.json",
            r#"{"events":[{"id":"e","key":"k","status":"queued"}]}"#,
        );
        assert_eq!(landing_answer(&c), None);
        // a notices file that is not JSON fails the Bun server's start
        let (_v, c) = dir();
        put(&c, "landing/notices.json", "[");
        assert_eq!(landing_answer(&c), None);
        // with the lock there, a canopy without it reads no notices
        put(&c, "landing/notices.json", r#"[{"id":"a","at":1}]"#);
        put(&c, "flows/owner.lock", "{}");
        assert_eq!(landing_answer(&c), None);
        put(&c, "landing/notices.json", "[]");
        assert!(landing_answer(&c).is_some());
    }

    #[test]
    fn no_pr_is_watched_until_a_record_or_a_run_could_bring_one() {
        let (_t, c) = dir();
        assert_eq!(prs_answer(&c), Some(json!([])));
        put(&c, "prs/p.json", "{}");
        assert_eq!(prs_answer(&c), None);
    }

    fn item(id: &str, state: &str, updated: f64, repos: &[&str], closed: bool) -> Value {
        let mut v = json!({ "id": id, "title": id, "repos": repos, "state": state, "from": { "kind": "note" }, "runs": [], "branches": [], "prs": [], "events": [], "notes": [], "createdAt": 1, "updatedAt": updated });
        if closed {
            v["closedAt"] = json!(updated);
        }
        v
    }

    #[test]
    fn the_ledger_is_listed_newest_first_with_its_filters_while_no_fact_would_move_an_item() {
        let (_t, c) = dir();
        assert_eq!(
            work_answer(&c, None, None),
            Some(json!({ "items": [], "archived": 0 }))
        );
        for v in [
            item("w-testaaaa", "open", 5.0, &["app"], false),
            item("w-testbbbb", "dropped", 9.0, &["web"], true),
            item("w-testcccc", "open", 7.0, &["app", "web"], false),
        ] {
            put(
                &c,
                &format!("work/{}.json", v["id"].as_str().unwrap()),
                &v.to_string(),
            );
        }
        let ids = |a: Answer| -> Vec<Value> {
            a.unwrap()["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i["id"].clone())
                .collect()
        };
        assert_eq!(
            ids(work_answer(&c, None, None)),
            vec![
                json!("w-testbbbb"),
                json!("w-testcccc"),
                json!("w-testaaaa")
            ]
        );
        assert_eq!(
            ids(work_answer(&c, Some("app".into()), None)),
            vec![json!("w-testcccc"), json!("w-testaaaa")]
        );
        assert_eq!(
            ids(work_answer(&c, None, Some("dropped".into()))),
            vec![json!("w-testbbbb")]
        );
        // an open item stored as working would be rewritten at the start
        put(
            &c,
            "work/w-testdddd.json",
            &item("w-testdddd", "working", 1.0, &["app"], false).to_string(),
        );
        assert_eq!(work_answer(&c, None, None), None);
        std::fs::remove_file(join(&c, "work/w-testdddd.json")).unwrap();
        put(&c, "landing/runs/r.json", "{}");
        assert_eq!(work_answer(&c, None, None), None);
        std::fs::remove_file(join(&c, "landing/runs/r.json")).unwrap();
        put(&c, "flows/owner.lock", "{}");
        assert_eq!(work_answer(&c, None, None), None);
    }

    #[test]
    fn advice_is_the_improvements_lists_offers_and_a_broken_file_is_none() {
        let (_t, c) = dir();
        assert_eq!(advice_answer(&c), Some(json!([])));
        put(&c, "incubator/improvements.json", "{");
        assert_eq!(advice_answer(&c), Some(json!([])));
        put(
            &c,
            "incubator/improvements.json",
            r#"{"entries":{"k":{"key":"k","lesson":"a  lesson","from":[{"id":"sp_1","title":"One","at":4}]}}}"#,
        );
        assert_eq!(
            advice_answer(&c).unwrap().to_string(),
            r#"[{"key":"k","lesson":"a lesson","count":1,"titles":["One"],"lastAt":4}]"#
        );
    }

    async fn sh(dir: &str, args: &[&str]) -> String {
        let mut argv = vec![
            "git",
            "-C",
            dir,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
        ];
        argv.extend_from_slice(args);
        let r = canopy_core::exec::exec(&argv, &canopy_core::exec::ExecOptions::default()).await;
        assert_eq!(r.code, 0, "git {args:?}: {}", r.stderr);
        r.stdout.trim().to_string()
    }

    /// GET or POST on a served router; the status and the body.
    async fn call(addr: &str, method: &str, path: &str) -> (u16, Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        let raw = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        );
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut reply = String::new();
        s.read_to_string(&mut reply).await.unwrap();
        let status = reply[9..12].parse().unwrap();
        let body = reply.split_once("\r\n\r\n").map_or("", |(_, b)| b);
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn the_kept_trees_answer_while_the_keepers_start_would_change_none() {
        let t = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(t.path()).unwrap();
        let base = base.to_str().unwrap();
        let root = format!("{base}/root");
        let config = format!("{base}/config");
        let app = format!("{root}/app");
        std::fs::create_dir_all(&config).unwrap();
        canopy_core::exec::exec(
            &["git", "init", "-q", "-b", "main", &app],
            &canopy_core::exec::ExecOptions::default(),
        )
        .await;
        std::fs::write(format!("{app}/a.txt"), "one\n").unwrap();
        sh(&app, &["add", "-A"]).await;
        sh(&app, &["commit", "-q", "-m", "one"]).await;
        let repo_dir = format!("{config}/trees/{}", repo_key(&app));
        let tree = format!("{repo_dir}/feat");
        sh(
            &app,
            &["worktree", "add", "-q", "-b", "feat", &tree, "main"],
        )
        .await;
        let record = |extra: Value| {
            let mut t = json!({ "slug": "feat", "branch": "feat", "base": "main", "port": 7901, "madeAt": 5, "caches": false, "state": "ready", "sync": false });
            if let (Some(o), Some(x)) = (t.as_object_mut(), extra.as_object()) {
                o.extend(x.clone());
            }
            std::fs::write(
                format!("{repo_dir}/{TREES_RECORD}"),
                json!({ "trees": [t] }).to_string(),
            )
            .unwrap();
        };
        record(json!({}));
        let off = crate::gated::Gates {
            tmux: false,
            chan: false,
            voice: false,
            evaluator: false,
        };
        let state = Arc::new(
            AppState::start(crate::app::Setup {
                root: root.clone(),
                config_dir: config.clone(),
                about: json!({}),
                config: Box::new(|| Ok(canopy_core::store::CanopyConfig::default())),
                harnesses: Box::new(Vec::new),
                people: Arc::new(crate::people::People::new(&config)),
                gates: off,
            })
            .await
            .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let router = routes().with_state(state);
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (status, body) = call(&addr, "GET", "/api/trees").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["root"], json!(format!("{config}/trees")));
        assert_eq!(body["ports"], "7900-7949");
        assert_eq!(body["repos"][0]["repoPath"], json!(app));
        let got = &body["repos"][0]["trees"][0];
        let keys: Vec<&String> = got.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "slug", "branch", "base", "port", "madeAt", "caches", "state", "sync", "dir",
                "head", "ahead", "behind", "files", "at", "shells"
            ]
        );
        assert_eq!(
            (
                got["dir"].clone(),
                got["ahead"].clone(),
                got["files"].clone(),
                got["shells"].clone()
            ),
            (json!(tree), json!(0), json!(0), json!(0))
        );
        assert_eq!(call(&addr, "POST", "/api/trees").await.0, 501);

        // a tree that follows a base it was never synced to would be rebased
        record(json!({ "sync": true }));
        assert_eq!(call(&addr, "GET", "/api/trees").await.0, 501);
        let main = sh(&app, &["rev-parse", "main"]).await;
        record(json!({ "sync": true, "syncedTo": main }));
        assert_eq!(call(&addr, "GET", "/api/trees").await.0, 200);
        // one caught preparing fails at the start
        record(json!({ "state": "preparing" }));
        assert_eq!(call(&addr, "GET", "/api/trees").await.0, 501);
        // one whose folder git no longer lists is dropped
        record(json!({ "slug": "gone", "branch": "gone" }));
        assert_eq!(call(&addr, "GET", "/api/trees").await.0, 501);
        // an unrecorded worktree on a branch is adopted
        std::fs::remove_file(format!("{repo_dir}/{TREES_RECORD}")).unwrap();
        assert_eq!(call(&addr, "GET", "/api/trees").await.0, 501);
        // and with no tree at all the list is empty, lock or not
        sh(&app, &["worktree", "remove", "--force", &tree]).await;
        put(&config, "flows/owner.lock", "{}");
        let (status, body) = call(&addr, "GET", "/api/trees").await;
        assert_eq!((status, body["repos"].clone()), (200, json!([])));
        // with trees on record and the lock there, a canopy without it lists none
        sh(&app, &["worktree", "add", "-q", &tree, "feat"]).await;
        record(json!({}));
        assert_eq!(call(&addr, "GET", "/api/trees").await.0, 501);
    }

    #[test]
    fn a_warm_slot_is_warm_and_a_number_is_whole() {
        assert!(is_warm_name("warm-1"));
        assert!(is_warm_name("warm-12"));
        assert!(!is_warm_name("warm-0"));
        assert!(!is_warm_name("warm-01"));
        assert!(!is_warm_name("warm-"));
        assert!(!is_warm_name("run-1"));
        assert!(is_sprout_id("sp_0123456789ab"));
        assert!(!is_sprout_id("sp_0123456789AB"));
    }
}
