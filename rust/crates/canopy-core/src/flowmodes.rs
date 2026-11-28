//! `.canopy/workflows.json`'s workflow and step modes laid over a workflow
//! (`src/core/flowmodes.ts`, in part). Ported: `FLOW_MODES_FILE` and
//! `applyModes`, which the workflows list's graph reads. Not yet:
//! `parseFlowModes`, which reads the file at a repo's HEAD on the server.
//!
//! Modes are the JSON the file holds, `modes[workflow][step]`, the
//! workflow `"*"` for any workflow; a workflow is the JSON `parseWorkflow`
//! makes.

use serde_json::{Value, json};

pub const FLOW_MODES_FILE: &str = ".canopy/workflows.json";

/// `modes[key]` when the object has it as its own key.
fn own<'a>(modes: &'a Value, key: &str) -> Option<&'a Value> {
    modes.as_object()?.get(key)
}

/// `applyModes()`: the workflow with the repo's say over it, without
/// changing the input, and a warning for each entry of its own that names
/// no step.
pub fn apply_modes(wf: &Value, modes: &Value) -> (Value, Vec<String>) {
    let name = wf.get("name").and_then(Value::as_str).unwrap_or("");
    let empty = json!({});
    let specific = own(modes, name).filter(|v| !v.is_null()).unwrap_or(&empty);
    let wildcard = own(modes, "*").filter(|v| !v.is_null()).unwrap_or(&empty);
    let steps: &[Value] = wf
        .get("steps")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let step_name = |s: &Value| {
        s.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let names: Vec<String> = steps.iter().map(step_name).collect();
    let warnings: Vec<String> = specific
        .as_object()
        .map(|o| {
            o.keys()
                .filter(|k| !names.contains(k))
                .map(|k| format!("{FLOW_MODES_FILE}: modes.{name}.{k} names no step of {name}"))
                .collect()
        })
        .unwrap_or_default();
    let steps: Vec<Value> = steps
        .iter()
        .map(|step| {
            let n = step_name(step);
            let mode = own(specific, &n)
                .filter(|v| !v.is_null())
                .or_else(|| own(wildcard, &n).filter(|v| !v.is_null()));
            match mode {
                None => step.clone(),
                Some(mode) => {
                    let mut s = step.clone();
                    if let Some(o) = s.as_object_mut() {
                        o.insert("mode".into(), mode.clone());
                        o.insert("modeFrom".into(), json!("repo"));
                    }
                    s
                }
            }
        })
        .collect();
    let mut workflow = wf.clone();
    if let Some(o) = workflow.as_object_mut() {
        o.insert("steps".into(), json!(steps));
    }
    (workflow, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{WorkflowMeta, parse_workflow};

    const SHIP: &str = "---\nblurb: b\n---\n\n## Gates\ncheck: @gates\n\n## Commit\n\ncommit\n\n## Push\nmode: manual\n\npush\n";

    fn ship() -> Value {
        let e = parse_workflow(
            SHIP,
            &WorkflowMeta {
                name: "ship".into(),
                source: "bundled".into(),
                file: "/ship.md".into(),
            },
        );
        e["workflow"].clone()
    }

    fn column(wf: &Value, key: &str) -> Vec<Value> {
        wf["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.get(key).cloned().unwrap_or(Value::Null))
            .collect()
    }

    #[test]
    fn the_workflows_entry_wins_over_star_the_repos_say_is_marked_and_a_mode_can_go_back_to_auto() {
        let wf = ship();
        let (workflow, warnings) = apply_modes(
            &wf,
            &json!({"ship": {"Commit": "manual", "Push": "auto"}, "*": {"Commit": "auto", "Gates": "manual"}}),
        );
        assert_eq!(
            column(&workflow, "mode"),
            [json!("manual"), json!("manual"), json!("auto")]
        );
        assert_eq!(
            column(&workflow, "modeFrom"),
            [json!("repo"), json!("repo"), json!("repo")]
        );
        assert!(warnings.is_empty());
        assert_eq!(
            column(&wf, "mode"),
            [json!("auto"), json!("auto"), json!("manual")]
        );
        assert!(wf["steps"][0].get("modeFrom").is_none());
    }

    #[test]
    fn an_entry_that_names_no_step_is_a_warning_and_star_never_warns() {
        let (workflow, warnings) = apply_modes(
            &ship(),
            &json!({"ship": {"Deploy": "manual"}, "*": {"Nowhere": "manual"}}),
        );
        assert_eq!(
            warnings,
            [format!(
                "{FLOW_MODES_FILE}: modes.ship.Deploy names no step of ship"
            )]
        );
        assert_eq!(
            column(&workflow, "mode"),
            [json!("auto"), json!("auto"), json!("manual")]
        );
    }

    #[test]
    fn no_modes_leaves_the_workflow_as_it_was() {
        let wf = ship();
        assert_eq!(apply_modes(&wf, &json!({})), (wf, vec![]));
    }

    #[test]
    fn a_step_named_after_an_object_property_does_not_inherit_a_mode() {
        let mut wf = ship();
        wf["steps"][1]["name"] = json!("toString");
        let (workflow, _) = apply_modes(&wf, &json!({"ship": {"Commit": "manual"}}));
        assert_eq!(workflow["steps"][1]["mode"], "auto");
    }
}
