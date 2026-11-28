//! A workflow's steps as a graph (FR-034), all of `src/core/flowgraph.ts`:
//! the column each step sits in, the edges between them, and the repo's
//! modes laid over them. The CLI's `workflow` turns the columns into
//! indented text and Graphviz DOT.
//!
//! A step here is the JSON a workflow holds or a backend sends (`GraphStep`
//! in types.ts: name, after, when, mode, modeFrom, gate, check, retries,
//! back), read as JavaScript reads it.

use crate::flowmodes::apply_modes;
use serde_json::{Map, Value, json};

/// `after`: the step `to` waits for `from`. `back`: `from`'s retries send
/// the flow back to `to`, an earlier step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    /// "after" or "back"
    pub kind: &'static str,
    /// on an `after` edge into a step with conditions: the step's `when`
    pub when: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepColumns {
    /// step names by column, left to right; a column's own order puts each
    /// step near the steps it waits for
    pub columns: Vec<Vec<String>>,
    /// each step's column, in heading order: the longest `after` path from
    /// a step that waits for none
    pub depth: Vec<(String, usize)>,
    pub edges: Vec<GraphEdge>,
}

impl StepColumns {
    /// `depth[name]`.
    pub fn depth_of(&self, name: &str) -> Option<usize> {
        self.depth.iter().find(|(n, _)| n == name).map(|(_, d)| *d)
    }
}

fn name_of(s: &Value) -> &str {
    s.get("name").and_then(Value::as_str).unwrap_or("")
}

fn strings(s: &Value, key: &str) -> Vec<String> {
    s.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().map_or_else(|| v.to_string(), String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn conditional(when: &[String]) -> bool {
    !(when.len() == 1 && when[0] == "always")
}

/// `isChain()`: whether the steps run as a chain, each waiting for the one
/// above with no condition. A chain keeps the strip; anything else gets the
/// graph.
pub fn is_chain(steps: &[Value]) -> bool {
    steps.iter().enumerate().all(|(i, s)| {
        let after = strings(s, "after");
        let chained = match i.checked_sub(1) {
            Some(above) => after.len() == 1 && after[0] == name_of(&steps[above]),
            None => after.is_empty(),
        };
        chained && !conditional(&strings(s, "when"))
    })
}

/// `graphOf()`: the columns and edges for steps as the parser leaves them.
/// `after` names earlier headings only, so one pass in heading order finds
/// every depth. A name `after` does not find (an old record's step) counts
/// as a root.
pub fn graph_of(steps: &[Value]) -> StepColumns {
    let mut depth: Vec<(String, usize)> = Vec::new();
    let get = |depth: &[(String, usize)], name: &str| {
        depth.iter().find(|(n, _)| n == name).map(|(_, d)| *d)
    };
    for s in steps {
        let mut d = 0;
        for name in strings(s, "after") {
            if let Some(before) = get(&depth, &name) {
                d = d.max(before + 1);
            }
        }
        match depth.iter_mut().find(|(n, _)| n == name_of(s)) {
            Some(slot) => slot.1 = d,
            None => depth.push((name_of(s).to_string(), d)),
        }
    }
    let count = steps
        .iter()
        .map(|s| get(&depth, name_of(s)).unwrap_or(0) + 1)
        .max()
        .unwrap_or(0);
    let mut columns: Vec<Vec<String>> = vec![Vec::new(); count];
    // each step's place in its column, centred on 0, so columns of different
    // heights compare as the picture centres them
    let mut place: Vec<(String, f64)> = Vec::new();
    for (c, column) in columns.iter_mut().enumerate() {
        let here: Vec<&Value> = steps
            .iter()
            .filter(|s| get(&depth, name_of(s)) == Some(c))
            .collect();
        let pull = |s: &Value| -> f64 {
            let at: Vec<f64> = strings(s, "after")
                .iter()
                .filter_map(|n| place.iter().find(|(p, _)| p == n).map(|(_, v)| *v))
                .collect();
            if at.is_empty() {
                0.0
            } else {
                at.iter().sum::<f64>() / at.len() as f64
            }
        };
        let mut ordered: Vec<(f64, &Value)> = here.iter().map(|s| (pull(s), *s)).collect();
        // a stable sort keeps heading order among steps that pull the same way
        if c > 0 {
            ordered.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        }
        let col: Vec<String> = ordered
            .iter()
            .map(|(_, s)| name_of(s).to_string())
            .collect();
        let mid = (col.len() as f64 - 1.0) / 2.0;
        for (row, name) in col.iter().enumerate() {
            let at = row as f64 - mid;
            match place.iter_mut().find(|(p, _)| p == name) {
                Some(slot) => slot.1 = at,
                None => place.push((name.clone(), at)),
            }
        }
        *column = col;
    }
    let names: Vec<&str> = steps.iter().map(name_of).collect();
    let mut edges = Vec::new();
    for s in steps {
        let when = strings(s, "when");
        for from in strings(s, "after") {
            if !names.contains(&from.as_str()) {
                continue;
            }
            edges.push(GraphEdge {
                from,
                to: name_of(s).to_string(),
                kind: "after",
                when: conditional(&when).then(|| when.clone()),
            });
        }
    }
    for s in steps {
        let retries = s.get("retries").and_then(Value::as_f64).unwrap_or(0.0);
        let back = s.get("back").and_then(Value::as_str).unwrap_or("");
        if retries > 0.0 && back != name_of(s) && names.contains(&back) {
            edges.push(GraphEdge {
                from: name_of(s).to_string(),
                to: back.to_string(),
                kind: "back",
                when: None,
            });
        }
    }
    StepColumns {
        columns,
        depth,
        edges,
    }
}

/// `graphStep()`: the fields of a step the graph reads.
pub fn graph_step(s: &Value) -> Value {
    let mut out = Map::new();
    let copy = |out: &mut Map<String, Value>, key: &str| {
        out.insert(key.into(), s.get(key).cloned().unwrap_or(Value::Null));
    };
    copy(&mut out, "name");
    copy(&mut out, "after");
    copy(&mut out, "when");
    copy(&mut out, "mode");
    if crate::js::truthy(s.get("modeFrom")) {
        copy(&mut out, "modeFrom");
    }
    for key in ["gate", "check", "retries", "back"] {
        copy(&mut out, key);
    }
    Value::Object(out)
}

/// The modes file as read at HEAD: its modes, or why it cannot be read.
pub enum ModesRead {
    Ok(Value),
    Bad(String),
}

/// `workflowGraph()`: what the workflows list carries for one workflow: its
/// steps with the repo's modes laid over, the repo's word on each step it
/// decides, and the file's warnings. A file that cannot be read leaves the
/// workflow's own modes and says why.
pub fn workflow_graph(wf: &Value, read: &ModesRead) -> Value {
    let steps_of = |w: &Value| -> Vec<Value> {
        w.get("steps")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(graph_step).collect())
            .unwrap_or_default()
    };
    match read {
        ModesRead::Bad(error) => json!({
            "steps": steps_of(wf),
            "modes": {},
            "warnings": [],
            "error": error,
        }),
        ModesRead::Ok(modes) => {
            let (workflow, warnings) = apply_modes(wf, modes);
            let mut decided = Map::new();
            for s in workflow
                .get("steps")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
            {
                if s.get("modeFrom").and_then(Value::as_str) == Some("repo") {
                    decided.insert(
                        name_of(s).to_string(),
                        s.get("mode").cloned().unwrap_or(Value::Null),
                    );
                }
            }
            json!({ "steps": steps_of(&workflow), "modes": decided, "warnings": warnings })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flowmodes::FLOW_MODES_FILE;
    use crate::workflow::{WorkflowMeta, parse_workflow};

    fn wf(text: &str) -> Value {
        let e = parse_workflow(
            text,
            &WorkflowMeta {
                name: "fan".into(),
                source: "user".into(),
                file: "/fan.md".into(),
            },
        );
        assert_eq!(e["ok"], true, "{}", e["error"]);
        e["workflow"].clone()
    }

    fn fan() -> Value {
        wf("---
blurb: b
---

## Build
tools: git-commit

build

## Lint
after: Build
tools: read

lint

## Docs
after: Build
tools: read
check: true
retries: 1
back: Build

docs

## Ship
after: Lint, Docs
when: check pass
mode: manual

ship
")
    }

    fn steps(w: &Value) -> Vec<Value> {
        w["steps"].as_array().unwrap().clone()
    }

    fn cols(g: &StepColumns) -> Vec<Vec<&str>> {
        g.columns
            .iter()
            .map(|c| c.iter().map(String::as_str).collect())
            .collect()
    }

    fn depths(g: &StepColumns) -> Vec<(&str, usize)> {
        g.depth.iter().map(|(n, d)| (n.as_str(), *d)).collect()
    }

    fn edge(from: &str, to: &str, kind: &'static str, when: Option<&[&str]>) -> GraphEdge {
        GraphEdge {
            from: from.into(),
            to: to.into(),
            kind,
            when: when.map(|w| w.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn columns_by_depth_edges_for_after_and_back_the_condition_on_the_edges_into_its_step() {
        let g = graph_of(&steps(&fan()));
        assert_eq!(
            cols(&g),
            [vec!["Build"], vec!["Lint", "Docs"], vec!["Ship"]]
        );
        assert_eq!(
            depths(&g),
            [("Build", 0), ("Lint", 1), ("Docs", 1), ("Ship", 2)]
        );
        assert_eq!(
            g.edges,
            [
                edge("Build", "Lint", "after", None),
                edge("Build", "Docs", "after", None),
                edge("Lint", "Ship", "after", Some(&["check pass"])),
                edge("Docs", "Ship", "after", Some(&["check pass"])),
                edge("Docs", "Build", "back", None),
            ]
        );
    }

    #[test]
    fn a_chain_is_one_column_per_step() {
        let chain = wf(
            "---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\ncheck: true\nretries: 2\n\nc\n",
        );
        let g = graph_of(&steps(&chain));
        assert_eq!(cols(&g), [vec!["A"], vec!["B"], vec!["C"]]);
        // retries on its own step go nowhere else, so no back edge
        let e: Vec<(&str, &str, &str)> = g
            .edges
            .iter()
            .map(|e| (e.from.as_str(), e.to.as_str(), e.kind))
            .collect();
        assert_eq!(e, [("A", "B", "after"), ("B", "C", "after")]);
    }

    #[test]
    fn the_longest_path_sets_the_depth_and_a_column_follows_the_rows_of_what_its_steps_wait_for() {
        let w = wf(
            "---\nblurb: b\n---\n\n## A\n\na\n\n## B\nafter: A\n\nb\n\n## C\nafter: A\n\nc\n\n## E\nafter: C\n\ne\n\n## D\nafter: B\n\nd\n\n## F\nafter: A, D\n\nf\n",
        );
        let g = graph_of(&steps(&w));
        assert_eq!(
            depths(&g),
            [("A", 0), ("B", 1), ("C", 1), ("E", 2), ("D", 2), ("F", 3)]
        );
        // D waits for B, the upper one, so it goes above E though its heading comes later
        assert_eq!(
            cols(&g),
            [vec!["A"], vec!["B", "C"], vec!["D", "E"], vec!["F"]]
        );
    }

    #[test]
    fn two_roots_share_the_first_column_in_heading_order() {
        let w =
            wf("---\nblurb: b\n---\n\n## A\n\na\n\n## B\nafter: A\n\nb\n\n## C\nafter: A\n\nc\n");
        let mut roots = steps(&w);
        roots[1]["after"] = json!([]);
        assert_eq!(cols(&graph_of(&roots)), [vec!["A", "B"], vec!["C"]]);
    }

    #[test]
    fn a_name_after_does_not_find_counts_as_a_root_rather_than_breaking_the_picture() {
        let mut s = steps(&fan());
        s[1]["after"] = json!(["Gone"]);
        let g = graph_of(&s);
        assert_eq!(g.depth_of("Lint"), Some(0));
        assert!(!g.edges.iter().any(|e| e.from == "Gone"));
    }

    #[test]
    fn every_bundled_workflow_is_a_chain_but_ship_and_sentry_triage_fix_and_the_fan_is_not() {
        let dir = format!("{}/lib/workflows", crate::version::canopy_dir());
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let n = path.file_name().unwrap().to_string_lossy().into_owned();
            let Some(name) = n.strip_suffix(".md") else {
                continue;
            };
            let e = parse_workflow(
                &std::fs::read_to_string(&path).unwrap(),
                &WorkflowMeta {
                    name: name.into(),
                    source: "bundled".into(),
                    file: n.clone(),
                },
            );
            assert_eq!(e["ok"], true, "{n}: {}", e["error"]);
            let s = steps(&e["workflow"]);
            let columns: Option<Vec<Vec<&str>>> = match name {
                "ship" => Some(vec![vec!["Gates", "Docs"], vec!["Commit"], vec!["Push"]]),
                "sentry-triage-fix" => Some(vec![
                    vec!["Triage"],
                    vec!["Fix"],
                    vec!["Gates"],
                    vec!["Mend"],
                    vec!["Commit"],
                ]),
                _ => None,
            };
            assert_eq!(is_chain(&s), columns.is_none(), "{n}");
            if let Some(c) = columns {
                assert_eq!(cols(&graph_of(&s)), c, "{n}");
            }
        }
        assert!(!is_chain(&steps(&fan())));
    }

    #[test]
    fn a_condition_alone_makes_a_graph_a_manual_mode_alone_does_not() {
        let chain = wf("---\nblurb: b\n---\n\n## A\ncheck: true\n\n## B\nmode: manual\n\nb\n");
        assert!(is_chain(&steps(&chain)));
        let when = wf("---\nblurb: b\n---\n\n## A\ncheck: true\n\n## B\nwhen: check fail\n\nb\n");
        assert!(!is_chain(&steps(&when)));
    }

    #[test]
    fn lays_the_repos_modes_over_the_steps_and_says_which_ones_it_decided() {
        let g = workflow_graph(
            &fan(),
            &ModesRead::Ok(
                json!({"fan": {"Ship": "auto", "Nope": "manual"}, "*": {"Build": "manual"}}),
            ),
        );
        let rows: Vec<(Value, Value, Value)> = g["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["name"].clone(),
                    s["mode"].clone(),
                    s.get("modeFrom").cloned().unwrap_or(Value::Null),
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (json!("Build"), json!("manual"), json!("repo")),
                (json!("Lint"), json!("auto"), Value::Null),
                (json!("Docs"), json!("auto"), Value::Null),
                (json!("Ship"), json!("auto"), json!("repo")),
            ]
        );
        assert_eq!(g["modes"], json!({"Build": "manual", "Ship": "auto"}));
        assert_eq!(
            g["warnings"],
            json!([format!(
                "{FLOW_MODES_FILE}: modes.fan.Nope names no step of fan"
            )])
        );
        assert!(g.get("error").is_none());
        assert!(g["steps"][0].get("body").is_none());
    }

    #[test]
    fn a_file_that_cannot_be_read_keeps_the_files_own_modes_and_says_why() {
        let w = fan();
        let error = format!("{FLOW_MODES_FILE} must be an object");
        let g = workflow_graph(&w, &ModesRead::Bad(error.clone()));
        let own: Vec<Value> = steps(&w).iter().map(graph_step).collect();
        assert_eq!(
            g,
            json!({"steps": own, "modes": {}, "warnings": [], "error": error})
        );
        assert_eq!(g["steps"][3]["mode"], "manual");
    }
}
