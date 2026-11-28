//! The landing queue (`src/core/landing.ts`). Only the words `canopy queue`
//! and `canopy land` print are here: which entries sit in a queue and in
//! what order, what came back, and a sort's verdict. The queue's loop and
//! its store stay in the TypeScript. Entries and runs are read as the JSON
//! `GET /api/landing` answers.

use crate::js::{field, list_at, num_at, str_at, truthy_at};
use crate::pathx::js_cmp;
use serde_json::Value;

/// `SCORE_GATE`: the gate a red entry carries when its satisfaction score
/// sent it back.
pub const SCORE_GATE: &str = "satisfaction ";

/// `WORKING`: the states the loop is working an entry through.
const WORKING: &[&str] = &["rebasing", "setup", "gate", "scenarios", "landing"];

fn state(e: &Value) -> &str {
    str_at(e, "state").unwrap_or("")
}

/// `inQueue()`: waiting its turn, being worked, or holding its place.
pub fn in_queue(e: &Value) -> bool {
    matches!(state(e), "queued" | "waiting" | "judge") || WORKING.contains(&state(e))
}

/// `sentBack()`: conflict, red or moved.
pub fn sent_back(e: &Value) -> bool {
    matches!(state(e), "conflict" | "red" | "moved")
}

/// `stoppedWhole()`: a run a restart stopped whose worktree the hub last
/// found whole.
pub fn stopped_whole(r: &Value) -> bool {
    state(r) == "stopped"
        && r.get("whole")
            .and_then(|w| w.get("ok"))
            .and_then(Value::as_bool)
            == Some(true)
}

/// `queueOf()`: a repo's queue in order, by when each joined and then by
/// id. The TypeScript breaks a tie with localeCompare; ids are lower-case
/// ASCII, where that is the code-unit order used here.
pub fn queue_of<'a>(entries: &'a [Value], repo_id: &str) -> Vec<&'a Value> {
    let mut out: Vec<&Value> = entries
        .iter()
        .filter(|e| str_at(e, "repoId") == Some(repo_id) && in_queue(e))
        .collect();
    out.sort_by(|a, b| {
        let qa = num_at(a, "queuedAt").unwrap_or(f64::NAN);
        let qb = num_at(b, "queuedAt").unwrap_or(f64::NAN);
        let d = qa - qb;
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            js_cmp(str_at(a, "id").unwrap_or(""), str_at(b, "id").unwrap_or(""))
        }
    });
    out
}

/// `ordinal()`: 1st, 2nd, 3rd, then 4th and on (11th, 21th: the
/// TypeScript's own words).
fn ordinal(n: usize) -> String {
    match n {
        1 => "1st".into(),
        2 => "2nd".into(),
        3 => "3rd".into(),
        _ => format!("{n}th"),
    }
}

/// `landWord()`: an entry's state in a few words.
pub fn land_word(e: &Value, entries: &[Value]) -> String {
    let gate = || str_at(e, "gate");
    match state(e) {
        "queued" => {
            let repo = str_at(e, "repoId").unwrap_or("");
            let id = str_at(e, "id");
            let pos = queue_of(entries, repo)
                .iter()
                .position(|x| str_at(x, "id") == id)
                .map_or(0, |i| i + 1);
            if pos > 0 {
                format!("queued {}", ordinal(pos))
            } else {
                "queued".into()
            }
        }
        "gate" => format!("gate: {}", gate().unwrap_or("?")),
        "scenarios" => format!("scenario: {}", gate().unwrap_or("?")),
        "judge" => "needs a judge".into(),
        "setup" => "setting up".into(),
        "landing" => "landing".into(),
        "red" => format!("red: {}", gate().unwrap_or("gate")),
        "moved" => "main kept moving".into(),
        _ => field(e, "state"),
    }
}

/// `reviewWord()`: what a sort says, with its why.
pub fn review_word(r: &Value) -> String {
    let why = if truthy_at(r, "why") {
        format!(": {}", field(r, "why"))
    } else {
        String::new()
    };
    match str_at(r, "verdict") {
        Some("auto") => "lands on its own".into(),
        Some("land") => format!("needs your land{why}"),
        _ => {
            let n = list_at(r, "files")
                .iter()
                .filter(|f| truthy_at(f, "sensitive"))
                .count();
            if n > 0 {
                format!(
                    "needs your approval: {n} sensitive file{}",
                    if n == 1 { "" } else { "s" }
                )
            } else {
                format!("needs your approval{why}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_queue_runs_in_the_order_entries_joined() {
        let entries = vec![
            json!({"id": "b", "repoId": "r", "state": "queued", "queuedAt": 2}),
            json!({"id": "a", "repoId": "r", "state": "gate", "gate": "test", "queuedAt": 1}),
            json!({"id": "c", "repoId": "r", "state": "red", "queuedAt": 0}),
            json!({"id": "d", "repoId": "s", "state": "queued", "queuedAt": 0}),
        ];
        let ids: Vec<&str> = queue_of(&entries, "r")
            .iter()
            .filter_map(|e| str_at(e, "id"))
            .collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(land_word(&entries[0], &entries), "queued 2nd");
        assert_eq!(land_word(&entries[1], &entries), "gate: test");
        assert_eq!(land_word(&entries[2], &entries), "red: gate");
        assert!(sent_back(&entries[2]));
        assert!(!in_queue(&entries[2]));
    }

    #[test]
    fn a_sort_in_a_few_words() {
        assert_eq!(
            review_word(&json!({"verdict": "auto", "files": []})),
            "lands on its own"
        );
        assert_eq!(
            review_word(&json!({"verdict": "land", "why": "big", "files": []})),
            "needs your land: big"
        );
        assert_eq!(
            review_word(
                &json!({"verdict": "approve", "files": [{"sensitive": "auth"}, {"path": "x"}]})
            ),
            "needs your approval: 1 sensitive file"
        );
        assert_eq!(
            review_word(&json!({"verdict": "approve", "why": "new dep", "files": []})),
            "needs your approval: new dep"
        );
        assert!(stopped_whole(
            &json!({"state": "stopped", "whole": {"ok": true}})
        ));
        assert!(!stopped_whole(&json!({"state": "stopped"})));
    }
}
