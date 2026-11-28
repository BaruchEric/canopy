//! A coordinator's cards in words (`src/core/coordinator.ts`): only what
//! `canopy coordinator` prints, the facts a card carries and the count of
//! cards by state. The planner, the queue and the settling of children stay
//! in the TypeScript. A card is read as the JSON `GET /api/runs` answers.

use crate::js::{field, list_at, template, truthy_at};
use serde_json::Value;

/// `NO_LOADOUT` (core/types.ts): the loadout that is none, not even the
/// one the repo, machine or kit would give.
pub const NO_LOADOUT: &str = "none";

/// `isProjectCard()`: a card that makes a new project in the incubator.
pub fn is_project_card(t: &Value) -> bool {
    t.get("action").and_then(Value::as_str) == Some("project")
}

/// `CardCarries`: what a card carries, in the words its facts line shows.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CardCarries {
    /// the loadout's word and its title
    pub loadout: Option<(String, String)>,
    pub workflow: Option<String>,
    pub after: Option<String>,
    pub files: Option<String>,
    pub tree: Option<String>,
    pub project: Option<String>,
}

/// `overrides()`: the fields of a loadout Eric changed on the card. A field
/// counts when it is there at all, null included, as `!== undefined` has it.
fn overrides(e: &Value) -> Vec<String> {
    let list = |v: &Value| {
        let l = v.as_array().map_or(&[][..], Vec::as_slice);
        if l.is_empty() {
            "none".to_string()
        } else {
            crate::js::join(l, ", ")
        }
    };
    let mut out = Vec::new();
    if let Some(m) = e.get("model") {
        out.push(format!("model {}", template(Some(m))));
    }
    if let Some(m) = e.get("effort") {
        out.push(format!("effort {}", template(Some(m))));
    }
    if let Some(s) = e.get("skills") {
        out.push(format!("skills {}", list(s)));
    }
    if let Some(s) = e.get("mcp") {
        out.push(format!("servers {}", list(s)));
    }
    if let Some(p) = e.get("provider") {
        out.push(format!("provider {}", template(Some(p))));
    }
    out
}

/// `cardCarries()`: the words a card's facts line adds: its loadout (with
/// "changed" when Eric overrode a field, the overrides in its title), its
/// workflow, "after t1, t3" for the cards it waits for, "files: shot.png,
/// notes.md" for the goal's files its worker takes (FR-067), "in tree
/// feat/x" for a card that runs in a kept worktree, and "new project" for a
/// card that makes one in the incubator.
pub fn card_carries(task: &Value) -> CardCarries {
    let mut out = CardCarries::default();
    let e = task.get("equip").filter(|e| !e.is_null());
    let loadout = e.and_then(|e| e.get("loadout"));
    if loadout.and_then(Value::as_str) == Some(NO_LOADOUT) {
        out.loadout = Some((
            "no loadout".into(),
            "no loadout, not even the one the repo, machine or kit would give it".into(),
        ));
    } else if let (Some(e), true) = (e, crate::js::truthy(loadout)) {
        let name = template(loadout);
        let set = overrides(e);
        let word = if set.is_empty() {
            name.clone()
        } else {
            format!("{name}, changed")
        };
        let mut title = vec![format!("loadout {name}")];
        title.extend(set);
        out.loadout = Some((word, title.join("; ")));
    }
    if truthy_at(task, "workflow") {
        out.workflow = Some(field(task, "workflow"));
    }
    let after = list_at(task, "after");
    if !after.is_empty() {
        out.after = Some(format!("after {}", crate::js::join(after, ", ")));
    }
    let files = list_at(task, "files");
    if !files.is_empty() {
        out.files = Some(format!("files: {}", crate::js::join(files, ", ")));
    }
    if truthy_at(task, "tree") {
        out.tree = Some(format!("in tree {}", field(task, "tree")));
    }
    if is_project_card(task) {
        out.project = Some("new project".into());
    }
    out
}

/// `cardCounts()`: the cards in a few words for the block's head: "3 cards
/// · 1 proposed, 2 running".
pub fn card_counts(tasks: &[Value]) -> String {
    let order = ["proposed", "queued", "running", "done", "failed", "dropped"];
    let parts: Vec<String> = order
        .iter()
        .map(|s| {
            let n = tasks
                .iter()
                .filter(|t| t.get("state").and_then(Value::as_str) == Some(s))
                .count();
            (s, n)
        })
        .filter(|(_, n)| *n > 0)
        .map(|(s, n)| format!("{n} {s}"))
        .collect();
    let head = format!(
        "{} {}",
        tasks.len(),
        if tasks.len() == 1 { "card" } else { "cards" }
    );
    if parts.is_empty() {
        head
    } else {
        format!("{head} · {}", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card(over: Value) -> Value {
        let mut t = json!({"id": "t1", "title": "x", "repo": "web", "note": "n", "action": "ask", "state": "queued"});
        if let (Some(m), Value::Object(o)) = (t.as_object_mut(), over) {
            m.extend(o);
        }
        t
    }

    #[test]
    fn the_facts_line_names_the_tree() {
        assert_eq!(
            card_carries(&card(json!({"tree": "feat/x"})))
                .tree
                .as_deref(),
            Some("in tree feat/x")
        );
        // FR-069: none says no loadout, and a provider override counts as a change
        assert_eq!(
            card_carries(&card(json!({"equip": {"loadout": "none"}})))
                .loadout
                .map(|l| l.0)
                .as_deref(),
            Some("no loadout")
        );
        assert_eq!(
            card_carries(&card(
                json!({"equip": {"loadout": "quick", "provider": "gw"}})
            ))
            .loadout,
            Some((
                "quick, changed".to_string(),
                "loadout quick; provider gw".to_string()
            ))
        );
    }

    #[test]
    fn is_project_card_and_the_facts_line_says_new_project() {
        let proj = card(json!({"action": "project", "repo": "~goal", "state": "proposed"}));
        let held = card(json!({"id": "t2", "state": "proposed"}));
        assert!(is_project_card(&proj));
        assert!(!is_project_card(&held));
        assert_eq!(card_carries(&proj).project.as_deref(), Some("new project"));
        assert_eq!(card_carries(&held).project, None);
    }

    #[test]
    fn the_counts_name_each_state_in_order_and_one_card_is_a_card() {
        let tasks = [
            card(json!({"state": "running"})),
            card(json!({"state": "proposed"})),
        ];
        assert_eq!(card_counts(&tasks), "2 cards · 1 proposed, 1 running");
        assert_eq!(card_counts(&tasks[..1]), "1 card · 1 running");
        assert_eq!(card_counts(&[]), "0 cards");
    }
}
