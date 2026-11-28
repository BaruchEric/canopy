//! `canopy kit` (`src/cli/kit.ts`): each machine's kit as every backend
//! sees it, its problems and its plan, and applying that plan.

use crate::api::Caller;
#[cfg(test)]
use crate::ask::Target;
use crate::ask::{Ask, did_not_answer, has, shift, skipped_line, take};
use crate::out::Out;
use canopy_core::js::{field, list_at, str_at, truthy_at};
use serde_json::{Value, json};

/// `KIT_USAGE`.
pub const KIT_USAGE: &str =
    "usage: canopy kit [status|apply] [--machine m] [--dry-run] [--backend URL]";

/// The states a status line reports; ok, local and off are not problems.
const PROBLEMS: &[&str] = &[
    "missing",
    "drift",
    "foreign",
    "no-source",
    "noagent",
    "away",
    "not-allowed",
    "stale-allowance",
    "no-sink",
    "adoptable",
    "unsupported",
    "unresolved",
    "check-failed",
    "no-install",
];

/// `actionWord()`: pull, `mkdir <agent>`, or `<kind> <agent>/<name>`.
pub fn action_word(a: &Value) -> String {
    match str_at(a, "kind") {
        Some("pull") => "pull".into(),
        Some("mkdir") => format!("mkdir {}", field(a, "agent")),
        _ => format!(
            "{} {}/{}",
            field(a, "kind"),
            field(a, "agent"),
            field(a, "name")
        ),
    }
}

/// `kitStatusLines()`: per machine its store, its problems and its plan.
pub fn kit_status_lines(info: &Value, machine: Option<&str>) -> Vec<String> {
    if !truthy_at(info, "ok") {
        return vec![str_at(info, "error").unwrap_or("kit not read").to_string()];
    }
    let mut out = Vec::new();
    for m in list_at(info, "machines") {
        let name = str_at(m, "machine");
        if machine.is_some_and(|w| !w.is_empty() && Some(w) != name) {
            continue;
        }
        let seen = m.get("seen").unwrap_or(&Value::Null);
        let store = seen.get("store").filter(|s| truthy_at_value(s));
        if truthy_at(seen, "away") {
            out.push(format!(
                "{}  away: {}",
                field(m, "machine"),
                field(seen, "away")
            ));
        } else if let Some(s) = store {
            let mut bits = vec![str_at(s, "branch").unwrap_or("no branch").to_string()];
            if truthy_at(s, "ahead") {
                bits.push(format!("{} ahead", field(s, "ahead")));
            }
            if truthy_at(s, "behind") {
                bits.push(format!("{} behind", field(s, "behind")));
            }
            if truthy_at(s, "dirty") {
                bits.push(format!("{} changed", field(s, "dirty")));
            }
            if truthy_at(s, "fetchFailed") {
                bits.push("fetch failed".into());
            }
            out.push(format!(
                "{}  store {}",
                field(m, "machine"),
                bits.join(", ")
            ));
        }
        for c in list_at(info, "cells") {
            let state = str_at(c, "state").unwrap_or("");
            if c.get("machine") != m.get("machine") || !PROBLEMS.contains(&state) || state == "away"
            {
                continue;
            }
            // a tool's cell is the machine's and has no agent
            let who = if str_at(c, "kind") == Some("tool") {
                "tool".to_string()
            } else {
                field(c, "agent")
            };
            let why = if truthy_at(c, "why") {
                format!("  {}", field(c, "why"))
            } else {
                String::new()
            };
            out.push(format!(
                "  {who}  {}  {}{why}",
                field(c, "skill"),
                field(c, "state")
            ));
        }
        let plan = list_at(m, "plan");
        if !plan.is_empty() {
            let words: Vec<String> = plan.iter().map(action_word).collect();
            out.push(format!("  plan: {}", words.join(", ")));
        }
    }
    out
}

/// JavaScript truthiness of a value that is there.
fn truthy_at_value(v: &Value) -> bool {
    canopy_core::js::truthy(Some(v))
}

/// `kitApplyLines()`: what ran and what failed; a dry run's `done` holds
/// the plan, so it reads as what would run.
pub fn kit_apply_lines(r: &Value, dry_run: bool) -> Vec<String> {
    let machine = field(r, "machine");
    let mut out: Vec<String> = list_at(r, "done")
        .iter()
        .map(|a| {
            format!(
                "{machine}: {} {}",
                action_word(a),
                if dry_run { "would run" } else { "done" }
            )
        })
        .collect();
    for f in list_at(r, "failed") {
        let action = f.get("action").unwrap_or(&Value::Null);
        out.push(format!(
            "{machine}: {} failed: {}",
            action_word(action),
            field(f, "why")
        ));
    }
    out
}

/// `kitCommand()`.
pub(crate) async fn kit_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    let machine = take(&mut args, "--machine");
    let dry_run = has(&mut args, "--dry-run");
    let sub = shift(&mut args).unwrap_or_else(|| "status".into());
    let home = caller.api_base(given.as_deref());
    let targets = crate::ask::listed_targets(ask, &home, given.is_some()).await;
    if sub != "status" && sub != "apply" {
        return Err(KIT_USAGE.into());
    }
    let machine = machine.as_deref();
    let mut failed = false;
    for t in &targets {
        // one backend that cannot answer (unreachable, or a canopy from
        // before the kit) is named and skipped; the others still report
        let info = match ask.ask(t, "GET", "/api/kit", None).await {
            Ok(i) => i,
            Err(e) => {
                out.line(skipped_line(&t.name, &e));
                failed = true;
                continue;
            }
        };
        if !truthy_at(&info, "ok") {
            // machine lines name themselves; a whole backend's error needs its name
            out.line(format!(
                "{}: {}",
                t.name,
                str_at(&info, "error").unwrap_or("kit not read")
            ));
            if sub == "apply" {
                failed = true;
            }
            continue;
        }
        if sub == "status" {
            out.lines(kit_status_lines(&info, machine));
            continue;
        }
        for m in list_at(&info, "machines") {
            let name = str_at(m, "machine");
            let skip_machine = machine.is_some_and(|w| !w.is_empty() && Some(w) != name);
            let seen = m.get("seen").unwrap_or(&Value::Null);
            if skip_machine || truthy_at(seen, "away") || list_at(m, "plan").is_empty() {
                continue;
            }
            let body = json!({ "machine": m.get("machine"), "dryRun": dry_run });
            let r = ask
                .ask(t, "POST", "/api/kit/apply", Some(&body))
                .await
                .map_err(|e| did_not_answer(&t.name, &e))?;
            out.lines(kit_apply_lines(&r, dry_run));
            if !list_at(&r, "failed").is_empty() {
                failed = true;
            }
        }
    }
    if failed {
        out.failed = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::AskError;
    use crate::ask::tests::Fake;

    fn info() -> Value {
        json!({
            "ok": true, "error": null,
            "machines": [{
                "machine": "mac",
                "seen": {"machine": "mac", "at": 1, "away": null, "home": "/h", "store": {"tracked": [], "branch": "main", "ahead": 0, "behind": 2, "dirty": 3, "fetchFailed": false}, "targets": [], "sources": {}},
                "plan": [{"kind": "pull"}, {"kind": "link", "agent": "codex", "name": "ship", "link": "../../.claude/skills/ship"}],
            }],
            "cells": [
                {"machine": "mac", "agent": "codex", "skill": "ship", "state": "missing", "why": ""},
                {"machine": "mac", "agent": "codex", "skill": "qnap", "state": "foreign", "why": "a dir canopy did not place"},
                {"machine": "mac", "agent": "claude", "skill": "ship", "state": "ok", "why": ""},
            ],
        })
    }

    #[test]
    fn status_says_the_store_the_problems_and_the_plan() {
        assert_eq!(
            kit_status_lines(&info(), None),
            [
                "mac  store main, 2 behind, 3 changed",
                "  codex  ship  missing",
                "  codex  qnap  foreign  a dir canopy did not place",
                "  plan: pull, link codex/ship",
            ]
        );
        let mut tool = info();
        tool["cells"] = json!([{"machine": "mac", "agent": "", "skill": "jq", "state": "no-install", "why": "missing, and kit.json has no install line for darwin", "kind": "tool"}]);
        assert!(
            kit_status_lines(&tool, None).contains(
                &"  tool  jq  no-install  missing, and kit.json has no install line for darwin"
                    .to_string()
            )
        );
        assert_eq!(
            kit_status_lines(
                &json!({"ok": false, "error": "kit.json: bad", "machines": [], "cells": []}),
                None
            ),
            ["kit.json: bad"]
        );
        assert!(kit_status_lines(&info(), Some("mini")).is_empty());
    }

    fn bare_machine(plan: Value, cells: Value) -> Value {
        json!({"ok": true, "error": null, "cells": cells, "machines": [{"machine": "mac",
            "seen": {"machine": "mac", "at": 1, "away": null, "home": "/h", "store": null, "targets": [], "sources": {}},
            "plan": plan}]})
    }

    #[test]
    fn server_cells_print_like_skills_and_every_mcp_problem_state_prints() {
        let one = bare_machine(
            json!([{"kind": "mcp-set", "agent": "codex", "name": "github"}]),
            json!([{"machine": "mac", "agent": "claude", "skill": "github", "state": "not-allowed", "why": "not allowed; allow it from the kit view", "kind": "mcp"}]),
        );
        assert_eq!(
            kit_status_lines(&one, None),
            [
                "  claude  github  not-allowed  not allowed; allow it from the kit view",
                "  plan: mcp-set codex/github"
            ]
        );
        let states = [
            "not-allowed",
            "stale-allowance",
            "no-sink",
            "adoptable",
            "unsupported",
            "unresolved",
            "ok",
            "local",
            "off",
        ];
        let cells: Vec<Value> = states
            .iter()
            .map(|s| json!({"machine": "mac", "agent": "codex", "skill": s, "state": s, "why": "", "kind": "mcp"}))
            .collect();
        let want: Vec<String> = states[..6]
            .iter()
            .map(|s| format!("  codex  {s}  {s}"))
            .collect();
        assert_eq!(
            kit_status_lines(&bare_machine(json!([]), json!(cells)), None),
            want
        );
    }

    #[tokio::test]
    async fn a_backend_whose_kit_json_cannot_be_read_is_named_on_its_error_line() {
        let fake = Fake(|t: &Target, _: &str, p: &str, _: Option<&Value>| {
            if p == "/api/backends" {
                return Ok(
                    json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}]}),
                );
            }
            if t.name == "mini" {
                return Ok(
                    json!({"ok": false, "error": "kit.json: ENOENT", "machines": [], "cells": []}),
                );
            }
            Ok(info())
        });
        let mut out = Out::default();
        kit_cmd(vec!["status".into()], &Caller::default(), &fake, &mut out)
            .await
            .unwrap();
        assert_eq!(out.printed().last(), Some(&"mini: kit.json: ENOENT"));
    }

    #[test]
    fn apply_lines_and_words() {
        assert_eq!(
            action_word(&json!({"kind": "remove", "agent": "codex", "name": "x"})),
            "remove codex/x"
        );
        assert_eq!(
            kit_apply_lines(
                &json!({"machine": "mac", "done": [{"kind": "pull"}], "failed": [{"action": {"kind": "mkdir", "agent": "hermes"}, "why": "cannot make /x"}]}),
                false
            ),
            ["mac: pull done", "mac: mkdir hermes failed: cannot make /x"]
        );
        assert_eq!(
            kit_apply_lines(
                &json!({"machine": "mini", "done": [{"kind": "mcp-set", "agent": "codex", "name": "github"}], "failed": []}),
                true
            ),
            ["mini: mcp-set codex/github would run"]
        );
    }

    #[tokio::test]
    async fn a_backend_with_no_kit_is_named_and_skipped() {
        let fake = Fake(|t: &Target, _: &str, p: &str, _: Option<&Value>| {
            if p == "/api/backends" {
                return Ok(
                    json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}]}),
                );
            }
            if t.name == "mini" {
                return Err(AskError::Refused {
                    message: "not found".into(),
                    status: 404,
                });
            }
            Ok(info())
        });
        let mut out = Out::default();
        kit_cmd(vec!["status".into()], &Caller::default(), &fake, &mut out)
            .await
            .unwrap();
        let printed = out.printed();
        assert_eq!(printed[0], "mac  store main, 2 behind, 3 changed");
        assert_eq!(printed.last(), Some(&"mini: not found"));
        assert!(out.failed);
        let mut out = Out::default();
        assert_eq!(
            kit_cmd(vec!["what".into()], &Caller::default(), &fake, &mut out)
                .await
                .unwrap_err(),
            KIT_USAGE
        );
    }
}
