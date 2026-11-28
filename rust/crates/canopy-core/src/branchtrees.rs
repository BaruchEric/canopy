//! Worktrees kept by hand (FR-051, `src/core/branchtrees.ts`): the record a
//! repo's trees folder holds (`parseTreesRecord`), the folders beside it
//! (`listTreeDirs`) and where a tree stands against its base
//! (`treeStatus`), which is what `GET /api/trees` lists. Making, preparing,
//! merging, syncing and removing trees, slugs and ports stay in the
//! TypeScript.

use crate::exec::git;
use crate::git::count_status_entries;
use crate::js::num as js_num;
use crate::jsjson::{self, Unheld};
use crate::pathx::{join, js_cmp};
use serde_json::{Map, Value, json};

/// the record's file name in a repo's trees folder
pub const TREES_RECORD: &str = "trees.json";
/// the ports a tree's shells get when `CANOPY_TREE_PORTS` is unset
pub const TREE_PORTS_DEFAULT: &str = "7900-7949";

const STATES: [&str; 4] = ["preparing", "ready", "failed", "merging"];

/// One tree as the record keeps it: the fields the server reads, and the
/// entry as `parseTreesRecord` builds it, in its key order.
#[derive(Debug, Clone, PartialEq)]
pub struct TreeRecord {
    pub slug: String,
    pub branch: String,
    pub base: String,
    pub state: String,
    pub sync: bool,
    pub synced_to: Option<String>,
    pub json: Value,
}

/// `parseTreesRecord()`: entries that lack a slug or a branch are dropped
/// rather than failing the file; junk reads as no trees.
pub fn parse_trees_record(text: &str) -> Result<Vec<TreeRecord>, Unheld> {
    let Some(raw) = jsjson::parse(text)? else {
        return Ok(vec![]);
    };
    let Some(list) = raw.get("trees").and_then(Value::as_array) else {
        return Ok(vec![]);
    };
    let mut out = vec![];
    for t in list {
        let (Some(slug), Some(branch)) = (
            t.get("slug").and_then(Value::as_str),
            t.get("branch").and_then(Value::as_str),
        ) else {
            continue;
        };
        let str_of = |k: &str| t.get(k).and_then(Value::as_str);
        let state = str_of("state")
            .filter(|s| STATES.contains(s))
            .unwrap_or("ready");
        let base = str_of("base").unwrap_or("");
        let port = t
            .get("port")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && n.fract() == 0.0)
            .map_or(Value::Null, js_num);
        let made_at = t.get("madeAt").and_then(Value::as_f64).unwrap_or(0.0);
        let sync = t.get("sync") != Some(&Value::Bool(false));
        let synced_to = str_of("syncedTo").filter(|s| !s.is_empty());
        let mut o = Map::new();
        o.insert("slug".into(), json!(slug));
        o.insert("branch".into(), json!(branch));
        o.insert("base".into(), json!(base));
        o.insert("port".into(), port);
        o.insert("madeAt".into(), js_num(made_at));
        o.insert(
            "caches".into(),
            json!(t.get("caches") != Some(&Value::Bool(false))),
        );
        o.insert("state".into(), json!(state));
        if let Some(why) = str_of("why").filter(|_| state == "failed") {
            o.insert("why".into(), json!(why));
        }
        if let Some(stopped) = str_of("stopped").filter(|s| !s.is_empty()) {
            o.insert("stopped".into(), json!(stopped));
        }
        o.insert("sync".into(), json!(sync));
        if let Some(s) = synced_to {
            o.insert("syncedTo".into(), json!(s));
        }
        out.push(TreeRecord {
            slug: slug.into(),
            branch: branch.into(),
            base: base.into(),
            state: state.into(),
            sync,
            synced_to: synced_to.map(Into::into),
            json: Value::Object(o),
        });
    }
    Ok(out)
}

/// `listTreeDirs()`: the folders under a repo's trees folder (`repo_dir`,
/// the root joined with the repo's key), the record aside, sorted.
pub fn list_tree_dirs(repo_dir: &str) -> Vec<String> {
    let Ok(names) = std::fs::read_dir(repo_dir) else {
        return vec![];
    };
    let mut dirs: Vec<String> = names
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != TREES_RECORD)
        .map(|n| join(repo_dir, &n))
        .filter(|d| std::fs::metadata(d).is_ok_and(|m| m.is_dir()))
        .collect();
    dirs.sort_by(|a, b| js_cmp(a, b));
    dirs
}

/// `Number(s) || 0` for the counts git prints.
fn count(s: Option<&str>) -> f64 {
    s.and_then(|x| x.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

/// `treeStatus()`: HEAD short, ahead and behind of its base (both zero when
/// the base is gone or none is named), changed entries and the last
/// commit's time, as `{ head, ahead, behind, files, at? }`.
pub async fn tree_status(dir: &str, base: &str) -> Map<String, Value> {
    let range = format!("{base}...HEAD");
    let counts = async {
        if base.is_empty() {
            None
        } else {
            Some(git(dir, &["rev-list", "--left-right", "--count", &range]).await)
        }
    };
    let (head, counts, status, log) = tokio::join!(
        git(dir, &["rev-parse", "--short", "HEAD"]),
        counts,
        git(
            dir,
            &[
                "-c",
                "core.quotePath=false",
                "status",
                "--porcelain=v2",
                "-uall"
            ]
        ),
        git(dir, &["log", "-1", "--format=%ct"]),
    );
    let (behind, ahead) = match counts.filter(|c| c.code == 0) {
        Some(c) => {
            let mut w = c.stdout.split_whitespace();
            (count(w.next()), count(w.next()))
        }
        None => (0.0, 0.0),
    };
    let at = if log.code == 0 {
        count(Some(log.stdout.trim())) * 1000.0
    } else {
        0.0
    };
    let mut o = Map::new();
    let head = if head.code == 0 {
        head.stdout.trim()
    } else {
        ""
    };
    o.insert("head".into(), json!(head));
    o.insert("ahead".into(), js_num(ahead));
    o.insert("behind".into(), js_num(behind));
    let files = if status.code == 0 {
        count_status_entries(&status.stdout)
    } else {
        0
    };
    o.insert("files".into(), json!(files));
    if at > 0.0 {
        o.insert("at".into(), js_num(at));
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{ExecOptions, exec};

    #[test]
    fn junk_reads_as_empty_and_bad_entries_are_dropped() {
        assert_eq!(parse_trees_record("not json"), Ok(vec![]));
        assert_eq!(parse_trees_record("[]"), Ok(vec![]));
        let text = json!({ "trees": [{ "slug": "a" }, 3, { "branch": "b" }] }).to_string();
        assert_eq!(parse_trees_record(&text), Ok(vec![]));
    }

    #[test]
    fn an_entry_keeps_its_fields_defaults_the_rest_and_why_only_when_failed() {
        let text = json!({ "trees": [
            { "slug": "feat", "branch": "feat", "base": "main", "port": 7912, "madeAt": 5, "caches": false, "state": "failed", "why": "bun install exited 1" },
            { "slug": "x", "branch": "x", "why": "stale", "state": "ready" },
            { "slug": "y", "branch": "y", "state": "bogus", "port": "no", "sync": false },
        ] })
        .to_string();
        let rec: Vec<Value> = parse_trees_record(&text)
            .unwrap()
            .into_iter()
            .map(|t| t.json)
            .collect();
        assert_eq!(
            Value::Array(rec).to_string(),
            json!([
                { "slug": "feat", "branch": "feat", "base": "main", "port": 7912, "madeAt": 5, "caches": false, "state": "failed", "why": "bun install exited 1", "sync": true },
                { "slug": "x", "branch": "x", "base": "", "port": null, "madeAt": 0, "caches": true, "state": "ready", "sync": true },
                { "slug": "y", "branch": "y", "base": "", "port": null, "madeAt": 0, "caches": true, "state": "ready", "sync": false },
            ])
            .to_string()
        );
        let kept = json!({ "trees": [{ "slug": "z", "branch": "z", "port": 7.5, "stopped": "merge stopped", "syncedTo": "abc" }] }).to_string();
        let z = &parse_trees_record(&kept).unwrap()[0];
        assert_eq!(z.json["port"], Value::Null);
        assert_eq!(z.json["stopped"], "merge stopped");
        assert_eq!(z.synced_to.as_deref(), Some("abc"));
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
        let r = exec(&argv, &ExecOptions::default()).await;
        assert_eq!(r.code, 0, "git {args:?}: {}", r.stderr);
        r.stdout.trim().to_string()
    }

    async fn commit(dir: &str, name: &str, body: &str) {
        std::fs::write(format!("{dir}/{name}"), body).unwrap();
        sh(dir, &["add", "-A"]).await;
        sh(dir, &["commit", "-q", "-m", &format!("c {name}")]).await;
    }

    #[tokio::test]
    async fn status_counts_ahead_behind_and_changed_files_against_the_base() {
        let t = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(t.path()).unwrap();
        let root = root.to_str().unwrap();
        let r = format!("{root}/r1");
        exec(
            &["git", "init", "-q", "-b", "main", &r],
            &ExecOptions::default(),
        )
        .await;
        commit(&r, "a.txt", "one\n").await;
        let trees = format!("{root}/t1/r1-key");
        let dir = format!("{trees}/feat");
        sh(&r, &["worktree", "add", "-q", "-b", "feat", &dir, "main"]).await;
        std::fs::write(format!("{trees}/{TREES_RECORD}"), "{}").unwrap();
        assert_eq!(list_tree_dirs(&trees), vec![dir.clone()]);
        let fresh = tree_status(&dir, "main").await;
        assert_eq!(
            (
                fresh["ahead"].clone(),
                fresh["behind"].clone(),
                fresh["files"].clone()
            ),
            (json!(0), json!(0), json!(0))
        );
        let head = fresh["head"].as_str().unwrap();
        assert!(
            head.len() >= 7 && head.bytes().all(|b| b.is_ascii_hexdigit()),
            "{head}"
        );
        assert!(fresh["at"].as_f64().is_some_and(|a| a > 0.0));
        commit(&dir, "b.txt", "two\n").await;
        commit(&r, "c.txt", "three\n").await;
        std::fs::write(format!("{dir}/d.txt"), "dirty\n").unwrap();
        let moved = tree_status(&dir, "main").await;
        assert_eq!(
            (
                moved["ahead"].clone(),
                moved["behind"].clone(),
                moved["files"].clone()
            ),
            (json!(1), json!(1), json!(1))
        );
        let no_base = tree_status(&dir, "").await;
        assert_eq!(
            (
                no_base["ahead"].clone(),
                no_base["behind"].clone(),
                no_base["files"].clone()
            ),
            (json!(0), json!(0), json!(1))
        );
        assert_eq!(
            list_tree_dirs(&format!("{root}/none")),
            Vec::<String>::new()
        );
    }
}
