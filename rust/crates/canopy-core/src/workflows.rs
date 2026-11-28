//! Workflow files from the three places they live (`src/core/workflows.ts`,
//! in part): bundled first, the user's second, the repo's own last, later
//! ones replacing earlier ones with the same name. Ported: `loadWorkflows`
//! with the bundled order, and `findWorkflow`. Not yet:
//! `readFlowModes`, which reads a repo's modes file at HEAD for the server.

use crate::pathx::{basename, join, js_cmp};
use crate::workflow::{WorkflowMeta, parse_workflow};
use serde_json::{Value, json};

/// `BUNDLED_DIR`: lib/workflows in canopy's own checkout.
pub fn bundled_dir() -> String {
    join(&crate::version::canopy_dir(), "lib/workflows")
}

/// Bundled files in the order the menu shows them.
const BUNDLED_ORDER: &[&str] = &[
    "commit",
    "push",
    "ship",
    "deploy",
    "review",
    "clarify",
    "scout",
    "build-new",
    "renovate",
    "extend",
    "retro",
    "spec",
    "spec-converge",
    "sentry-fix",
    "sentry-triage-fix",
    "linear-issue",
    "issue-fix",
];

/// `basename(n, ".md")`.
fn stem(n: &str) -> String {
    let b = basename(n);
    match b.strip_suffix(".md") {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => b,
    }
}

/// `BUNDLED_ORDER.indexOf(name)`: -1 for a file the list does not name,
/// which sorts it first.
fn bundled_rank(n: &str) -> i64 {
    let s = stem(n);
    BUNDLED_ORDER
        .iter()
        .position(|o| *o == s)
        .map_or(-1, |i| i as i64)
}

fn read_dir(dir: &str, source: &str) -> Vec<Value> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".md"))
        .collect();
    names.sort_by(|a, b| js_cmp(a, b));
    if source == "bundled" {
        names.sort_by_key(|n| bundled_rank(n));
    }
    names
        .iter()
        .map(|n| {
            let meta = WorkflowMeta {
                name: stem(n),
                source: source.into(),
                file: join(dir, n),
            };
            match std::fs::read(&meta.file) {
                Ok(bytes) => parse_workflow(&String::from_utf8_lossy(&bytes), &meta),
                Err(e) => json!({
                    "ok": false,
                    "name": meta.name,
                    "source": meta.source,
                    "file": meta.file,
                    "error": e.to_string(),
                }),
            }
        })
        .collect()
}

/// `entryName()`: a workflow's name when it parsed, else its file's.
pub fn entry_name(e: &Value) -> String {
    let named = if crate::js::truthy(e.get("ok")) {
        e.get("workflow").and_then(|w| w.get("name"))
    } else {
        e.get("name")
    };
    crate::js::template(named)
}

/// `findWorkflow()`: the workflow by that name, when it parsed.
pub fn find_workflow<'a>(entries: &'a [Value], name: &str) -> Option<&'a Value> {
    let e = entries.iter().find(|e| entry_name(e) == name)?;
    if crate::js::truthy(e.get("ok")) {
        e.get("workflow")
    } else {
        None
    }
}

/// `loadWorkflows()`: the bundled folder, the user's under `config_dir`,
/// and a local repo's `.canopy/workflows` (None for a repo on another
/// host, which gets none), in menu order; an override replaces in place.
pub fn load_workflows(bundled: &str, config_dir: &str, repo: Option<&str>) -> Vec<Value> {
    let mut lists = vec![
        read_dir(bundled, "bundled"),
        read_dir(&join(config_dir, "workflows"), "user"),
    ];
    if let Some(path) = repo {
        lists.push(read_dir(&join(path, ".canopy/workflows"), "repo"));
    }
    let mut merged: Vec<(String, Value)> = Vec::new();
    for e in lists.into_iter().flatten() {
        let name = entry_name(&e);
        match merged.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = e,
            None => merged.push((name, e)),
        }
    }
    merged.into_iter().map(|(_, e)| e).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(std::path::PathBuf);

    impl Dir {
        fn new(tag: &str) -> Dir {
            // one folder per call: the tests run side by side
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let d =
                std::env::temp_dir().join(format!("canopy-wf-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Dir(d)
        }
        fn s(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
        fn write(&self, rel: &str, text: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The TypeScript's beforeAll: a user review that overrides the bundled
    /// one, a broken user file, and a repo's own tidy.
    fn setup() -> (Dir, Dir) {
        let cfg = Dir::new("cfg");
        let repo = Dir::new("repo");
        cfg.write(
            "workflows/review.md",
            "---\nblurb: my own review\n---\n\n## Look\n\nRead the diff.\n",
        );
        cfg.write(
            "workflows/broken.md",
            "---\nname: broken\n---\n\n## Do\n\nx\n",
        );
        repo.write(
            ".canopy/workflows/tidy.md",
            "---\nblurb: tidy this repo\n---\n\n## Tidy\n\nTidy.\n",
        );
        (cfg, repo)
    }

    #[test]
    fn bundled_then_user_then_repo_later_winning_by_name_broken_files_stay_listed() {
        let (cfg, repo) = setup();
        let list = load_workflows(&bundled_dir(), &cfg.s(), Some(&repo.s()));
        let names: Vec<String> = list.iter().map(entry_name).collect();
        assert_eq!(
            names,
            [
                "commit",
                "push",
                "ship",
                "deploy",
                "review",
                "clarify",
                "scout",
                "build-new",
                "renovate",
                "extend",
                "retro",
                "spec",
                "spec-converge",
                "sentry-fix",
                "sentry-triage-fix",
                "linear-issue",
                "issue-fix",
                "broken",
                "tidy"
            ]
        );
        let review = find_workflow(&list, "review").unwrap();
        assert_eq!(review["source"], "user");
        assert_eq!(review["blurb"], "my own review");
        assert_eq!(find_workflow(&list, "commit").unwrap()["source"], "bundled");
        assert_eq!(find_workflow(&list, "tidy").unwrap()["source"], "repo");
        let broken = list.iter().find(|e| e["ok"] == false).unwrap();
        assert!(broken["error"].as_str().unwrap().contains("blurb"));
        assert!(find_workflow(&list, "broken").is_none());
    }

    #[test]
    fn a_remote_repo_gets_no_repo_level_files() {
        let (cfg, _repo) = setup();
        let list = load_workflows(&bundled_dir(), &cfg.s(), None);
        assert!(
            !list
                .iter()
                .any(|e| e["ok"] == true && entry_name(e) == "tidy")
        );
        assert_eq!(find_workflow(&list, "review").unwrap()["source"], "user");
    }

    #[test]
    fn every_bundled_workflow_parses_and_has_the_expected_shape() {
        let (cfg, _repo) = setup();
        let list = load_workflows(&bundled_dir(), &cfg.s(), Some("/nonexistent"));
        let ship = find_workflow(&list, "ship").unwrap();
        let steps: Vec<&str> = ship["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(steps, ["Gates", "Docs", "Commit", "Push"]);
        assert_eq!(ship["steps"][0]["check"], "@gates");
        assert_eq!(ship["when"], "dirty-or-unpushed");
        let commit = find_workflow(&list, "commit").unwrap();
        assert_eq!(commit["when"], "dirty");
        assert_eq!(commit["expectsChange"], true);
        assert_eq!(find_workflow(&list, "push").unwrap()["when"], "unpushed");
        assert_eq!(find_workflow(&list, "deploy").unwrap()["when"], "any");
        let review = find_workflow(&list, "review").unwrap();
        assert!(
            !review["steps"][0]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t == "Bash(git commit:*)")
        );
    }
}
