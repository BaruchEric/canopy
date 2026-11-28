//! `canopy workflow` (`src/cli/workflow.ts`): a workflow's graph as
//! indented text or Graphviz DOT, a file checked before a flow runs it, and
//! the workflows a repo can run with their problems (FR-034). With --repo
//! the backend answers, adding the repo's own folder and its
//! `.canopy/workflows.json` as HEAD holds it; without, this machine's
//! bundled and user folders are read. Entries are the JSON a backend sends
//! or canopy-core's `parse_workflow` makes, read as the TypeScript reads
//! them.

use crate::api::Caller;
use crate::ask::{Ask, Target, did_not_answer, encode_component, has, shift, take};
use crate::out::Out;
use canopy_core::flowgraph::{graph_of, graph_step, is_chain};
use canopy_core::js::{field, list_at, num_at, str_at, truthy, truthy_at};
use canopy_core::pathx::{basename, js_len, pad_end, resolve};
use canopy_core::workflow::{WorkflowMeta, parse_workflow};
use canopy_core::workflows::{entry_name, load_workflows};
use serde_json::Value;

/// `WORKFLOW_USAGE`.
pub const WORKFLOW_USAGE: &str =
    "usage: canopy workflow show <name> [--repo R] [--dot] [--backend URL]
       canopy workflow check <file>
       canopy workflow list [--repo R] [--backend URL]";

/// `stepsOf()`: the steps as the repo would run them, the graph's when the
/// backend sent one, else the file's own.
fn steps_of(wf: &Value, graph: Option<&Value>) -> Vec<Value> {
    match graph.and_then(|g| g.get("steps")).filter(|s| !s.is_null()) {
        Some(steps) => steps.as_array().cloned().unwrap_or_default(),
        None => list_at(wf, "steps").iter().map(graph_step).collect(),
    }
}

/// `${list.join(", ")}` for a list of strings.
fn joined(s: &Value, key: &str) -> String {
    canopy_core::js::join(list_at(s, key), ", ")
}

fn mode_word(s: &Value) -> Option<String> {
    if str_at(s, "modeFrom") == Some("repo") {
        return Some(format!("{} (repo)", field(s, "mode")));
    }
    (str_at(s, "mode") == Some("manual")).then(|| "manual".into())
}

/// `facts()`: what a step says beyond its name, in the order a reader asks:
/// what it waits for, when it runs, who releases it, what decides after it.
fn facts(s: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if !list_at(s, "after").is_empty() {
        out.push(format!("after {}", joined(s, "after")));
    }
    let when = list_at(s, "when");
    if !(when.len() == 1 && when[0] == "always") {
        out.push(format!("when {}", joined(s, "when")));
    }
    if let Some(mode) = mode_word(s) {
        out.push(mode);
    }
    if str_at(s, "gate") != Some("continue") {
        out.push(format!("gate {}", field(s, "gate")));
    }
    if truthy_at(s, "check") {
        out.push(format!("check {}", field(s, "check")));
    }
    if num_at(s, "retries").is_some_and(|r| r > 0.0) {
        let back = if s.get("back") != s.get("name") {
            format!(", back {}", field(s, "back"))
        } else {
            String::new()
        };
        out.push(format!("retries {}{back}", field(s, "retries")));
    }
    out
}

/// `showLines()`: one line per step in heading order, indented by its
/// column, then what the repo's modes file says about this workflow.
pub fn show_lines(wf: &Value, graph: Option<&Value>) -> Vec<String> {
    let steps = steps_of(wf, graph);
    let columns = graph_of(&steps);
    let lead: Vec<String> = steps
        .iter()
        .map(|s| {
            let name = str_at(s, "name").unwrap_or("");
            format!(
                "{}{}",
                "  ".repeat(columns.depth_of(name).unwrap_or(0)),
                field(s, "name")
            )
        })
        .collect();
    let width = lead.iter().map(|l| js_len(l)).max().unwrap_or(0) + 2;
    let mut out = vec![format!(
        "{}  {}  {}",
        field(wf, "name"),
        field(wf, "source"),
        field(wf, "file")
    )];
    for (s, head) in steps.iter().zip(&lead) {
        let said = facts(s);
        out.push(if said.is_empty() {
            head.clone()
        } else {
            format!("{}{}", pad_end(head, width), said.join(" · "))
        });
    }
    if let Some(g) = graph {
        if truthy_at(g, "error") {
            out.push(format!(
                "modes: {}; a flow of {} is refused until it is fixed",
                field(g, "error"),
                field(wf, "name")
            ));
        }
        for w in list_at(g, "warnings") {
            out.push(format!("warning: {}", canopy_core::js::template(Some(w))));
        }
    }
    out
}

/// `quote()`: a DOT string, backslashes and quotes escaped.
fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `dotText()`: the graph as Graphviz DOT: a box per step, labelled with
/// its mode and gate when they are not the plain ones, `after` as arrows
/// (labelled with the step's `when`), `back` as dashed arrows. canopy does
/// not render it.
pub fn dot_text(wf: &Value, graph: Option<&Value>) -> String {
    let steps = steps_of(wf, graph);
    let columns = graph_of(&steps);
    let mut lines = vec![
        format!("digraph {} {{", quote(&field(wf, "name"))),
        "  rankdir=LR;".to_string(),
        "  node [shape=box];".to_string(),
    ];
    for s in &steps {
        let name = field(s, "name");
        let mut extra: Vec<String> = mode_word(s).into_iter().collect();
        if str_at(s, "gate") != Some("continue") {
            extra.push(format!("gate {}", field(s, "gate")));
        }
        let mut attrs = Vec::new();
        if !extra.is_empty() {
            let label = std::iter::once(name.clone())
                .chain(extra)
                .collect::<Vec<_>>()
                .join("\n");
            attrs.push(format!("label={}", quote(&label).replace('\n', "\\n")));
        }
        if str_at(s, "mode") == Some("manual") {
            attrs.push("style=bold".into());
        }
        lines.push(format!("  {}{};", quote(&name), bracket(&attrs)));
    }
    for e in &columns.edges {
        let attrs: Vec<String> = if e.kind == "back" {
            vec!["style=dashed".into(), "label=\"back\"".into()]
        } else if let Some(when) = &e.when {
            vec![format!(
                "label={}",
                quote(&format!("when {}", when.join(", ")))
            )]
        } else {
            Vec::new()
        };
        lines.push(format!(
            "  {} -> {}{};",
            quote(&e.from),
            quote(&e.to),
            bracket(&attrs)
        ));
    }
    lines.push("}".into());
    lines.join("\n")
}

/// ` [a, b]`, or nothing for no attributes.
fn bracket(attrs: &[String]) -> String {
    if attrs.is_empty() {
        String::new()
    } else {
        format!(" [{}]", attrs.join(", "))
    }
}

/// `listLines()`: a line per workflow with its source and shape, the
/// repo's say on its steps, and under it what is wrong with it; a modes
/// file that cannot be read once at the end, since it holds every flow.
pub fn list_lines(title: &str, entries: &[Value]) -> Vec<String> {
    if entries.is_empty() {
        return vec![format!("{title}: no workflows")];
    }
    let width = entries
        .iter()
        .map(|e| js_len(&entry_name(e)))
        .max()
        .unwrap_or(0)
        + 2;
    let pad = " ".repeat(2 + width + 9);
    let mut out = vec![title.to_string()];
    let mut broken: Option<Value> = None;
    for e in entries {
        let ok = truthy_at(e, "ok");
        let wf = e.get("workflow").unwrap_or(&Value::Null);
        let source = if ok {
            field(wf, "source")
        } else {
            field(e, "source")
        };
        let head = format!(
            "  {}{}",
            pad_end(&entry_name(e), width),
            pad_end(&source, 9)
        );
        if !ok {
            out.push(format!("{head}does not parse: {}", field(e, "error")));
            continue;
        }
        let graph = e.get("graph").filter(|g| !g.is_null());
        let steps = steps_of(wf, graph);
        let n = steps.len();
        let shape = format!(
            "{n} {}{}",
            if n == 1 { "step" } else { "steps" },
            if is_chain(&steps) { "" } else { " as a graph" }
        );
        let mut said = vec![shape];
        said.extend(
            steps
                .iter()
                .filter(|s| {
                    str_at(s, "mode") == Some("manual") && str_at(s, "modeFrom") != Some("repo")
                })
                .map(|s| format!("{} manual", field(s, "name"))),
        );
        if let Some(modes) = graph
            .and_then(|g| g.get("modes"))
            .and_then(Value::as_object)
        {
            said.extend(modes.iter().map(|(step, mode)| {
                format!("{step} {} (repo)", canopy_core::js::template(Some(mode)))
            }));
        }
        out.push(format!("{head}{}", said.join(", ")));
        if let Some(g) = graph {
            for w in list_at(g, "warnings") {
                out.push(format!(
                    "{pad}warning: {}",
                    canopy_core::js::template(Some(w))
                ));
            }
        }
        if broken.is_none() {
            broken = graph
                .and_then(|g| g.get("error"))
                .filter(|v| !v.is_null())
                .cloned();
        }
    }
    if truthy(broken.as_ref()) {
        out.push(format!(
            "modes: {}; every flow on this repo is refused until it is fixed",
            canopy_core::js::template(broken.as_ref())
        ));
    }
    out
}

/// `checkLines()`: a file read as a workflow, the graph when it parses,
/// else its error.
pub fn check_lines(entry: &Value) -> (bool, Vec<String>) {
    if !truthy_at(entry, "ok") {
        return (
            false,
            vec![format!(
                "{}: {}",
                field(entry, "file"),
                field(entry, "error")
            )],
        );
    }
    let wf = &entry["workflow"];
    let n = list_at(wf, "steps").len();
    let mut lines = vec![format!(
        "{}: ok, {n} {}",
        field(wf, "file"),
        if n == 1 { "step" } else { "steps" }
    )];
    lines.extend(show_lines(wf, None).into_iter().skip(1));
    (true, lines)
}

/// `isPath()`: an argument that names a folder rather than a repo's id.
fn is_path(v: &str) -> bool {
    v == "."
        || v.starts_with('/')
        || v.starts_with("./")
        || v.starts_with("../")
        || v.starts_with('~')
}

/// `home()`: a leading `~` as $HOME.
fn home(v: &str) -> String {
    match v.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let h = std::env::var("HOME").unwrap_or_else(|_| "~".into());
            format!("{h}{rest}")
        }
        _ => v.to_string(),
    }
}

/// `basename(path, ".md")`.
fn stem(path: &str) -> String {
    let b = basename(path);
    match b.strip_suffix(".md") {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => b,
    }
}

/// `workflowCommand()`.
pub(crate) async fn workflow_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    // the bare flag first, so `--repo --dot` leaves --repo with no repo
    let dot = has(&mut args, "--dot");
    let repo_flag = args.iter().any(|a| a == "--repo");
    let repo_arg = take(&mut args, "--repo");
    if repo_flag && repo_arg.as_deref().is_none_or(|r| r.starts_with('-')) {
        return Err("--repo needs a repo id or a path".into());
    }
    let target = Target::home(&caller.api_base(given.as_deref()));

    let sub = shift(&mut args);
    match sub.as_deref() {
        Some("show") => {
            let name = shift(&mut args);
            let Some(name) = name.filter(|n| !n.is_empty() && args.is_empty()) else {
                return Err(WORKFLOW_USAGE.into());
            };
            let (title, list) = entries(repo_arg.as_deref(), caller, ask, &target).await?;
            let Some(entry) = list.iter().find(|e| entry_name(e) == name) else {
                return Err(format!("no workflow called {name} in the {title}"));
            };
            if !truthy_at(entry, "ok") {
                return Err(format!("{name} does not parse: {}", field(entry, "error")));
            }
            let wf = &entry["workflow"];
            let graph = entry.get("graph").filter(|g| !g.is_null());
            out.line(if dot {
                dot_text(wf, graph)
            } else {
                show_lines(wf, graph).join("\n")
            });
            Ok(())
        }
        Some("check") => {
            let file = shift(&mut args);
            let Some(file) = file.filter(|f| !f.is_empty()) else {
                return Err(WORKFLOW_USAGE.into());
            };
            if !args.is_empty() || dot || repo_arg.is_some() {
                return Err(WORKFLOW_USAGE.into());
            }
            let path = resolve(&home(&file));
            let text = std::fs::read(&path)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .map_err(|_| format!("no such file: {file}"))?;
            let meta = WorkflowMeta {
                name: stem(&path),
                source: "user".into(),
                file: path,
            };
            let (ok, lines) = check_lines(&parse_workflow(&text, &meta));
            if !ok {
                return Err(lines.join("\n"));
            }
            out.line(lines.join("\n"));
            Ok(())
        }
        Some("list") => {
            if !args.is_empty() || dot {
                return Err(WORKFLOW_USAGE.into());
            }
            let (title, list) = entries(repo_arg.as_deref(), caller, ask, &target).await?;
            out.line(list_lines(&title, &list).join("\n"));
            Ok(())
        }
        _ => Err(WORKFLOW_USAGE.into()),
    }
}

/// The backend's list for --repo, else this machine's bundled and user
/// workflows, with the title the lines name them by.
async fn entries(
    repo_arg: Option<&str>,
    caller: &Caller,
    ask: &impl Ask,
    target: &Target,
) -> Result<(String, Vec<Value>), String> {
    let Some(arg) = repo_arg else {
        let list = load_workflows(
            &canopy_core::workflows::bundled_dir(),
            &caller.config_dir,
            None,
        )
        .into_iter()
        .filter(|e| {
            !truthy_at(e, "ok")
                || e.get("workflow").and_then(|w| w.get("listed")) != Some(&Value::Bool(false))
        })
        .collect();
        return Ok(("bundled and user workflows on this machine".into(), list));
    };
    let id = repo_id(arg, ask, target).await?;
    let list = ask
        .ask(
            target,
            "GET",
            &format!("/api/repos/workflows?id={}", encode_component(&id)),
            None,
        )
        .await
        .map_err(|e| did_not_answer("home", &e))?;
    Ok((
        format!("workflows for {id}"),
        list.as_array().cloned().unwrap_or_default(),
    ))
}

/// The repo's id: as given, or the one the backend scans at a path.
async fn repo_id(arg: &str, ask: &impl Ask, target: &Target) -> Result<String, String> {
    if !is_path(arg) {
        return Ok(arg.to_string());
    }
    let path = std::fs::canonicalize(resolve(&home(arg)))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| format!("no such folder: {arg}"))?;
    let tree = ask
        .ask(target, "GET", "/api/tree", None)
        .await
        .map_err(|e| did_not_answer("home", &e))?;
    list_at(&tree, "repos")
        .iter()
        .find(|r| str_at(r, "path") == Some(path.as_str()))
        .map(|r| field(r, "id"))
        .ok_or_else(|| format!("home does not scan {path}"))
}

#[cfg(test)]
mod tests;
