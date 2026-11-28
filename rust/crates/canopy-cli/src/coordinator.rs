//! `canopy coordinator` (`src/cli/coordinator.ts`): the live coordinators,
//! one goal's cards, and the steering verbs hold, resume, start and new.
//! The lines are pure; the cards' words come from canopy-core's
//! `coordinator.rs`. Each call goes to the home backend, or to the one
//! `--on` names, through `ask`; a new goal is a multipart form, sent at each
//! of the backend's addresses in turn through `ask::Client::request`.
//! Nothing here starts or stops a coordinator on its own: a new goal is
//! the server's to refuse (409 on a backend that runs none) or to start.

use crate::api::Caller;
use crate::ask::{
    Ask, Target, backend_targets, did_not_answer, encode_component, fetch_words, has, take,
};
use crate::out::Out;
use canopy_core::coordinator::{card_carries, card_counts};
use canopy_core::js::{field, list_at, pretty, template, truthy};
use canopy_core::pathx::{basename, js_len, js_trim, pad_end};
use canopy_core::types::is_run_active;
use reqwest::Method;
use serde_json::{Value, json};

/// `COORDINATOR_USAGE`.
pub const COORDINATOR_USAGE: &str = "usage: canopy coordinator [--json] [--backend URL | --on NAME]\n       canopy coordinator <run> [--json] [--backend URL | --on NAME]\n       canopy coordinator hold <run>\n       canopy coordinator resume <run>\n       canopy coordinator start <run> [id ...]\n       canopy coordinator new <goal> [--repo R ...] [--file PATH ...] [--model M] [--effort E] [--on NAME | --backend URL]";

/// `NewGoalArgs`: what `canopy coordinator new` reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NewGoalArgs {
    pub goal: String,
    pub repos: Vec<String>,
    pub files: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// `parseNewArgs()`: the goal's words, repeated --repo and --file, --model
/// and --effort, or what is wrong.
pub fn parse_new_args(argv: &[String]) -> Result<NewGoalArgs, String> {
    let mut words: Vec<&str> = Vec::new();
    let mut out = NewGoalArgs::default();
    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();
        i += 1;
        if !arg.starts_with("--") {
            words.push(arg);
            continue;
        }
        if !matches!(arg, "--repo" | "--file" | "--model" | "--effort") {
            return Err(format!("unknown flag {arg}"));
        }
        let Some(value) = argv.get(i).filter(|v| !v.is_empty()).cloned() else {
            return Err(format!("{arg} needs a value"));
        };
        i += 1;
        match arg {
            "--repo" => out.repos.push(value),
            "--file" => out.files.push(value),
            "--model" => out.model = Some(value),
            _ => out.effort = Some(value),
        }
    }
    out.goal = js_trim(&words.join(" ")).to_string();
    if out.goal.is_empty() {
        return Err(COORDINATOR_USAGE.into());
    }
    Ok(out)
}

/// One field of a form: text, or a file's name and bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormValue {
    Text(String),
    File { name: String, data: Vec<u8> },
}

/// A multipart form, its fields in the order they were added.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Form {
    pub fields: Vec<(String, FormValue)>,
}

#[cfg(test)]
impl Form {
    /// `form.get(name)`: the first field of that name.
    pub fn get(&self, name: &str) -> Option<&FormValue> {
        self.fields.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    /// `form.getAll(name)`.
    pub fn get_all(&self, name: &str) -> Vec<&FormValue> {
        self.fields
            .iter()
            .filter(|(n, _)| n == name)
            .map(|(_, v)| v)
            .collect()
    }
}

impl Form {
    /// The body as `multipart/form-data` with this boundary. A name or a
    /// file name escapes `"`, CR and LF as percent codes, as the HTML form
    /// encoder does; a file goes as `application/octet-stream`, the type
    /// of a `File` made without one.
    pub fn body(&self, boundary: &str) -> Vec<u8> {
        let esc = |s: &str| {
            s.replace('"', "%22")
                .replace('\r', "%0D")
                .replace('\n', "%0A")
        };
        let mut out: Vec<u8> = Vec::new();
        for (name, value) in &self.fields {
            out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            match value {
                FormValue::Text(t) => {
                    out.extend_from_slice(
                        format!(
                            "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
                            esc(name)
                        )
                        .as_bytes(),
                    );
                    out.extend_from_slice(t.as_bytes());
                }
                FormValue::File { name: file, data } => {
                    out.extend_from_slice(
                        format!(
                            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n",
                            esc(name),
                            esc(file)
                        )
                        .as_bytes(),
                    );
                    out.extend_from_slice(data);
                }
            }
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        out
    }
}

/// `newGoalForm()`: the multipart body `POST /api/coordinator/new` reads.
pub fn new_goal_form(args: &NewGoalArgs, files: Vec<(String, Vec<u8>)>) -> Form {
    let mut f = Form::default();
    f.fields
        .push(("goal".into(), FormValue::Text(args.goal.clone())));
    for repo in &args.repos {
        f.fields
            .push(("repos[]".into(), FormValue::Text(repo.clone())));
    }
    for (name, data) in files {
        f.fields
            .push(("files[]".into(), FormValue::File { name, data }));
    }
    if let Some(m) = &args.model {
        f.fields.push(("model".into(), FormValue::Text(m.clone())));
    }
    if let Some(e) = &args.effort {
        f.fields.push(("effort".into(), FormValue::Text(e.clone())));
    }
    f
}

/// `NEW_GOAL_HINT`: what to try when the backend asked runs no coordinator.
pub const NEW_GOAL_HINT: &str =
    "hint: this backend runs no coordinator; name one that does with --on <backend>";

/// `newGoalRefusal()`: a refused new goal in words: the server's, and the
/// hint to name a backend when the one asked runs no coordinator (its 409)
/// and the command named none.
pub fn new_goal_refusal(error: &str, status: u16, named: bool) -> String {
    if status == 409 && !named {
        format!("{error}\n{NEW_GOAL_HINT}")
    } else {
        error.to_string()
    }
}

/// `goalLink()`: the page that shows a goal; its own backend serves it, so
/// the id stays bare.
pub fn goal_link(base: &str, id: &str) -> String {
    format!(
        "{}/?view=manager&run={}",
        base.trim_end_matches('/'),
        encode_component(id)
    )
}

fn first_line(text: &str) -> String {
    js_trim(text.split('\n').next().unwrap_or("")).to_string()
}

fn is_live_coordinator(run: &Value) -> bool {
    run.get("action").and_then(Value::as_str) == Some("coordinate") && is_run_active(run)
}

/// `coordinatorLines()`: the live coordinators: id, repo, held or not, card
/// counts, the goal's first line.
pub fn coordinator_lines(runs: &[Value]) -> Vec<String> {
    runs.iter()
        .filter(|r| is_live_coordinator(r))
        .map(|run| {
            let fields = [
                run.get("id").cloned(),
                run.get("repoId").cloned(),
                Some(json!(if truthy(run.get("held")) { "held" } else { "" })),
                Some(json!(card_counts(list_at(run, "tasks")))),
                Some(json!(first_line(&field(run, "note")))),
            ];
            // Array.join prints a missing field as nothing
            fields
                .iter()
                .filter(|f| f.as_ref().and_then(Value::as_str) != Some(""))
                .map(|f| match f {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => template(Some(v)),
                })
                .collect::<Vec<_>>()
                .join("  ")
        })
        .collect()
}

/// `cardLines()`: one coordinator's cards, columns padded: id, state, repo,
/// loadout, workflow, after, files, tree, sprout, title. A project card's
/// repo reads new project, and its sprout's id gets a column.
pub fn card_lines(run: &Value) -> Vec<String> {
    let tasks = list_at(run, "tasks");
    let rows: Vec<[String; 9]> = tasks
        .iter()
        .map(|task| {
            let c = card_carries(task);
            [
                field(task, "id"),
                field(task, "state"),
                c.project.unwrap_or_else(|| field(task, "repo")),
                c.loadout.map(|l| l.0).unwrap_or_default(),
                c.workflow.unwrap_or_default(),
                c.after.unwrap_or_default(),
                c.files.unwrap_or_default(),
                c.tree.unwrap_or_default(),
                if truthy(task.get("sprout")) {
                    format!("sprout {}", field(task, "sprout"))
                } else {
                    String::new()
                },
            ]
        })
        .collect();
    let widths: Vec<usize> = (0..9)
        .map(|col| rows.iter().map(|r| js_len(&r[col])).max().unwrap_or(0))
        .collect();
    tasks
        .iter()
        .zip(&rows)
        .map(|(task, row)| {
            let mut cells: Vec<String> = row
                .iter()
                .enumerate()
                .filter(|(col, _)| widths[*col] > 0)
                .map(|(col, cell)| pad_end(cell, widths[col]))
                .collect();
            cells.push(field(task, "title"));
            cells.join("  ")
        })
        .collect()
}

/// A goal's form, sent at each of the backend's addresses in turn: the
/// first that answers other than a sign-in decides. Err is the line the
/// TypeScript fails with.
async fn send_goal(
    ask: &impl Ask,
    target: &Target,
    form: &Form,
    named: bool,
    out: &mut Out,
) -> Result<(), String> {
    let Some(client) = ask.client() else {
        return Err(format!("{} did not answer: no address", target.name));
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let boundary = format!("----canopyFormBoundary{nanos:x}{:x}", std::process::id());
    let body = form.body(&boundary);
    let mut tried: Vec<String> = Vec::new();
    for url in &target.urls {
        let full = format!("{url}/api/coordinator/new");
        let res = client
            .request(Method::POST, url, &full, None)
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body.clone())
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                continue;
            }
        };
        let status = res.status().as_u16();
        if status == 401 || (300..400).contains(&status) {
            tried.push(format!("{url}: needs a sign-in"));
            continue;
        }
        let text = res.text().await.unwrap_or_default();
        let answer: Value = serde_json::from_str(&text)
            .ok()
            .filter(|v: &Value| !v.is_null())
            .unwrap_or_else(|| json!({}));
        let id = answer.get("id");
        if !(200..300).contains(&status) || !truthy(id) {
            let error = match answer.get("error") {
                None | Some(Value::Null) => format!("{} answered {status}", target.name),
                Some(e) => template(Some(e)),
            };
            return Err(new_goal_refusal(&error, status, named));
        }
        let id = template(id);
        out.line(format!("{id}  {}", goal_link(url, &id)));
        return Ok(());
    }
    Err(format!(
        "{} did not answer: {}",
        target.name,
        if tried.is_empty() {
            "no address".to_string()
        } else {
            tried.join("; ")
        }
    ))
}

/// `coordinatorCommand()`.
pub(crate) async fn coordinator_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let backend_flag = args.iter().any(|a| a == "--backend");
    let given = take(&mut args, "--backend");
    let on_flag = args.iter().any(|a| a == "--on");
    let on = take(&mut args, "--on");
    if backend_flag && given.is_none() {
        return Err("--backend needs a value".into());
    }
    if on_flag && on.is_none() {
        return Err("--on needs a value".into());
    }
    if backend_flag && on_flag {
        return Err("use either --backend URL or --on NAME".into());
    }
    let as_json = has(&mut args, "--json");
    let home = caller.api_base(given.as_deref());
    let named = match &on {
        Some(name) => backend_targets(ask, &home, given.is_some(), Some(name))
            .await?
            .into_iter()
            .next(),
        None => None,
    };
    let target = named.unwrap_or_else(|| Target::home(&home));
    let failed = |e: crate::ask::AskError| did_not_answer(&target.name, &e);

    let sub = args.first().cloned();
    match sub.as_deref() {
        Some(verb @ ("hold" | "resume")) => {
            let run = args.get(1).filter(|r| !r.is_empty()).cloned();
            let Some(run) = run.filter(|_| args.len() == 2) else {
                return Err(COORDINATOR_USAGE.into());
            };
            let body = json!({"run": run, "held": verb == "hold"});
            ask.ask(&target, "POST", "/api/coordinator/hold", Some(&body))
                .await
                .map_err(failed)?;
            out.line(if verb == "hold" {
                format!("{run} held: no card starts until you resume it")
            } else {
                format!("{run} resumed")
            });
            return Ok(());
        }
        Some("new") => {
            let parsed = parse_new_args(&args[1..])?;
            let mut files: Vec<(String, Vec<u8>)> = Vec::new();
            for path in &parsed.files {
                // Bun.file(path).exists() is false for a folder too
                let data = match std::fs::metadata(path) {
                    Ok(m) if m.is_file() => std::fs::read(path).map_err(|e| e.to_string())?,
                    _ => return Err(format!("no such file: {path}")),
                };
                files.push((basename(path), data));
            }
            let form = new_goal_form(&parsed, files);
            return send_goal(ask, &target, &form, given.is_some() || on.is_some(), out).await;
        }
        Some("start") => {
            let Some(run) = args.get(1).filter(|r| !r.is_empty()).cloned() else {
                return Err(COORDINATOR_USAGE.into());
            };
            let ids: Vec<String> = args[2..].to_vec();
            let body = if ids.is_empty() {
                json!({ "run": run })
            } else {
                json!({ "run": run, "ids": ids })
            };
            ask.ask(&target, "POST", "/api/coordinator/start", Some(&body))
                .await
                .map_err(failed)?;
            out.line(if ids.is_empty() {
                format!("{run}: started every proposed card")
            } else {
                format!("{run}: started {}", ids.join(", "))
            });
            return Ok(());
        }
        _ => {}
    }

    if args.len() > 1 {
        return Err(COORDINATOR_USAGE.into());
    }
    let answer = ask
        .ask(&target, "GET", "/api/runs", None)
        .await
        .map_err(failed)?;
    let runs = answer.as_array().map_or(&[][..], Vec::as_slice);
    let Some(id) = sub else {
        let live: Vec<&Value> = runs.iter().filter(|r| is_live_coordinator(r)).collect();
        if as_json {
            out.line(pretty(&live));
        } else if live.is_empty() {
            out.line("no live coordinators");
        } else {
            out.lines(coordinator_lines(runs));
        }
        return Ok(());
    };
    let Some(run) = runs.iter().find(|r| {
        r.get("id").and_then(Value::as_str) == Some(id.as_str()) && is_live_coordinator(r)
    }) else {
        return Err(format!("no live coordinator {id}"));
    };
    if as_json {
        out.line(pretty(list_at(run, "tasks")));
        return Ok(());
    }
    let lines = card_lines(run);
    if lines.is_empty() {
        out.line(format!("{} has no cards yet", field(run, "id")));
    } else {
        out.lines(lines);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
