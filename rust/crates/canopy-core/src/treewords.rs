//! The words for a kept worktree (`src/core/treewords.ts`): `treeWords`,
//! the row `canopy worktrees` prints for a tree, read off the backend's
//! JSON. The refusals, the branch-name check and the tree cards stay in the
//! TypeScript.

use crate::js::{field, num_at, str_at, truthy_at};
use serde_json::Value;

/// `treeWords()`: the tree's standing against its base, its changed files,
/// its port, its state, what stopped its merge or sync (the first line),
/// what its following waits on, whether it stopped following its base, and
/// its shells.
pub fn tree_words(t: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    let state = str_at(t, "state");
    let n = |k: &str| num_at(t, k);
    if state == Some("preparing") {
        parts.push("preparing".into());
    }
    if state == Some("merging") {
        parts.push("merging".into());
    }
    if state == Some("failed") {
        let why = if truthy_at(t, "why") {
            let w = field(t, "why");
            let last = w.split('\n').rfind(|l| !l.is_empty()).unwrap_or("");
            format!(": {last}")
        } else {
            String::new()
        };
        parts.push(format!("setup failed{why}"));
    }
    let stopped = truthy_at(t, "stopped");
    if stopped {
        let s = field(t, "stopped");
        parts.push(
            s.split('\n')
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .to_string(),
        );
    }
    if truthy_at(t, "waiting") {
        parts.push(format!("sync waits on {}", field(t, "waiting")));
    }
    let above = |k: &str| n(k).is_some_and(|x| x > 0.0);
    let zero = |k: &str| n(k) == Some(0.0);
    if above("ahead") {
        parts.push(format!("↑{}", field(t, "ahead")));
    }
    if above("behind") {
        parts.push(format!("↓{}", field(t, "behind")));
    }
    if above("files") {
        parts.push(format!("●{}", field(t, "files")));
    }
    if zero("ahead") && zero("behind") && zero("files") && state == Some("ready") && !stopped {
        parts.push("clean".into());
    }
    if t.get("port") != Some(&Value::Null) {
        parts.push(format!(":{}", field(t, "port")));
    }
    if t.get("sync") == Some(&Value::Bool(false)) {
        parts.push("sync off".into());
    }
    if above("shells") {
        let one = n("shells") == Some(1.0);
        parts.push(format!(
            "{} shell{}",
            field(t, "shells"),
            if one { "" } else { "s" }
        ));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree(over: Value) -> Value {
        let mut t = json!({"slug": "feat-x", "dir": "/t/canopy-abc/feat-x", "branch": "feat/x", "base": "main",
            "port": 7912, "madeAt": 0, "caches": true, "state": "ready", "sync": true, "head": "abc1234",
            "ahead": 0, "behind": 0, "files": 0, "shells": 0});
        if let (Some(m), Value::Object(o)) = (t.as_object_mut(), over) {
            m.extend(o);
        }
        t
    }

    #[test]
    fn a_trees_row_in_words() {
        assert_eq!(tree_words(&tree(json!({}))), "clean :7912");
        assert_eq!(
            tree_words(&tree(json!({"ahead": 2, "files": 1, "shells": 1}))),
            "↑2 ●1 :7912 1 shell"
        );
        assert_eq!(
            tree_words(&tree(json!({"state": "preparing", "port": null}))),
            "preparing"
        );
        assert_eq!(
            tree_words(&tree(
                json!({"state": "failed", "why": "a\nbun install exited 1\n", "port": null, "behind": 3, "sync": false, "shells": 2})
            )),
            "setup failed: bun install exited 1 ↓3 sync off 2 shells"
        );
        assert_eq!(
            tree_words(&tree(
                json!({"stopped": "\nmerge stopped: gate test exited 1\nmore", "waiting": "a run"})
            )),
            "merge stopped: gate test exited 1 sync waits on a run :7912"
        );
        assert_eq!(
            tree_words(&tree(json!({"state": "merging"}))),
            "merging :7912"
        );
    }
}
