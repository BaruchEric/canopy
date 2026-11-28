//! `canopy new` and `canopy incubator` (`src/cli/incubator.ts`): start a
//! project, list the projects, show one with its questions and why it
//! waits, and answer it the way the page's sheet does: answer or skip
//! clarify's questions, resume, stop, dismiss, add input, and say yes or no
//! to a hand-off. `pick-check` is scout's check in a seed, run on the
//! seed's own files.
//!
//! Every call goes through `Ask::fetch` and is read as incubator.ts's own
//! `call` reads it: "<backend> did not answer: <why>", a body that is not
//! JSON as `{}`, and the backend's `error` (else "the backend answered N")
//! as the failure. Where the stages run is asked with an 8-second timeout
//! and the page's origin with a 3-second one, as the TypeScript does.

use crate::api::Caller;
use crate::ask::{Ask, Body, Part, encode_component, has, is_origin, take};
use crate::newargs::{IntakeArgs, parse_add_args, parse_new_args, sprout_link};
use crate::out::Out;
use crate::render::Paint;
use canopy_core::clips::js_slice;
use canopy_core::js::{
    field, list_at, num_at, number_of, number_string, pretty, round, str_at, template, truthy_at,
};
use canopy_core::pathx::{JS_S, basename, js_trim, pad_end};
use canopy_core::sprout::{
    hand_off_text, is_own_step, next_workflow, parse_pick, phase_refusal, pick_refusal,
    sprout_ended,
};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;
use std::time::Duration;

/// `NO_STAGES` (src/server/incubator.ts): what a new project is told on a
/// backend with stages off and its queue live.
pub const NO_STAGES: &str = "this backend has nowhere to run a stage, so a project started here would never start: start it on a backend whose incubator says stages isolated, or set CANOPY_INCUBATOR_UNISOLATED=1 here and restart canopy";

/// `INCUBATOR_USAGE`.
pub fn incubator_usage() -> String {
    crate::help::verb_help("incubator").unwrap_or_else(|| {
        "usage: canopy incubator [list] | show <id> | answer | resume | stop | dismiss | add | handoff | pick-check".into()
    })
}

/// `pageBase()`: the origin a link to the page is built on: the backend's
/// public origin, as its own entry in `GET /api/backends` names it, else
/// the API origin the CLI reached.
pub fn page_base(api: &str, listed: Option<&Value>) -> String {
    let Some(listed) = listed.filter(|v| v.is_object()) else {
        return api.into();
    };
    let (Some(me), Some(backends)) = (
        listed.get("self").and_then(Value::as_str),
        listed.get("backends").and_then(Value::as_array),
    ) else {
        return api.into();
    };
    let own = backends
        .iter()
        .find(|b| b.is_object() && b.get("name").and_then(Value::as_str) == Some(me));
    let public = own
        .and_then(|b| b.get("public"))
        .and_then(Value::as_str)
        .map_or(String::new(), |p| p.trim_end_matches('/').to_string());
    if is_origin(&public) {
        public
    } else {
        api.into()
    }
}

/// `pageOrigin()`: the page's origin as the backend names it, else the API
/// origin.
async fn page_origin(api: &str, ask: &impl Ask) -> String {
    match ask
        .fetch(
            "GET",
            api,
            "/api/backends",
            None,
            Some(Duration::from_millis(3_000)),
        )
        .await
    {
        Ok(r) if r.ok() => match r.json() {
            Some(v) => page_base(api, Some(&v)),
            None => api.into(),
        },
        Ok(_) => api.into(),
        Err(_) => api.into(),
    }
}

/// `readStages()`: where the backend's stages run, or None when it did not
/// say (an older backend, a sign-in gate); Err with Bun's words when it
/// does not answer at all.
async fn read_stages(backend: &str, ask: &impl Ask) -> Result<Option<Value>, String> {
    let r = ask
        .fetch(
            "GET",
            backend,
            "/api/incubator/stages",
            None,
            Some(Duration::from_millis(8_000)),
        )
        .await?;
    if !r.ok() {
        return Ok(None);
    }
    Ok(r.json()
        .filter(|b| b.is_object() && b.get("mode").is_some_and(Value::is_string)))
}

/// `call()`: one request to the backend, JSON or a form; a refusal fails
/// the command in the server's words.
async fn call(
    backend: &str,
    method: &str,
    path: &str,
    body: Option<Body<'_>>,
    ask: &impl Ask,
) -> Result<Value, String> {
    let r = ask
        .fetch(method, backend, path, body, None)
        .await
        .map_err(|e| format!("{backend} did not answer: {e}"))?;
    let out = r.json().unwrap_or_else(|| json!({}));
    if !r.ok() {
        return Err(match out.get("error") {
            None | Some(Value::Null) => format!("the backend answered {}", r.status),
            some => template(some),
        });
    }
    Ok(out)
}

/// `waitWhy()`: why a queued project is not starting, in its backend's
/// words, or None: a project still being prepared, or bound for canopy's
/// own deploy or hand-off, waits for no stage.
pub fn wait_why(s: &Value, st: Option<&Value>) -> Option<String> {
    if str_at(s, "status") != Some("queued")
        || !truthy_at(s, "prepared")
        || is_own_step(&next_workflow(s))
    {
        return None;
    }
    match st?.get("waiting") {
        None | Some(Value::Null) => None,
        some => Some(template(some)),
    }
}

/// `listLine()`: one project on one line: id, status, title, and what it
/// waits on.
pub fn list_line(s: &Value, st: Option<&Value>) -> String {
    let wait = wait_why(s, st);
    let n = list_at(s, "questions").len();
    let why = if truthy_at(s, "parked") {
        format!(" ({})", field(s, "parked"))
    } else if n > 0 {
        format!(
            " ({n} {} waiting)",
            if n == 1 { "question" } else { "questions" }
        )
    } else {
        match wait.filter(|w| !w.is_empty()) {
            Some(w) => format!(" (waiting: {w})"),
            None => String::new(),
        }
    };
    format!(
        "{}  {} {}{why}",
        field(s, "id"),
        pad_end(&field(s, "status"), 11),
        field(s, "title")
    )
}

/// `questionLines()`: clarify's open questions, numbered, each with its
/// numbered options, and how to answer them.
pub fn question_lines(id: &str, questions: &[Value]) -> Vec<String> {
    let mut out = vec![format!(
        "clarify asks {}:",
        if questions.len() == 1 {
            "one question".to_string()
        } else {
            format!("{} questions", questions.len())
        }
    )];
    for (i, q) in questions.iter().enumerate() {
        let options = list_at(q, "options");
        let any = if !options.is_empty() && truthy_at(q, "multiSelect") {
            " (pick any)"
        } else {
            ""
        };
        out.push(format!("{}. {}{any}", i + 1, field(q, "question")));
        for (j, o) in options.iter().enumerate() {
            let about = if truthy_at(o, "description") {
                format!(": {}", field(o, "description"))
            } else {
                String::new()
            };
            out.push(format!("   {}) {}{about}", j + 1, field(o, "label")));
        }
    }
    let slots: Vec<String> = (1..=questions.len())
        .map(|i| format!("\"<{i}>\""))
        .collect();
    out.push(format!(
        "answer: canopy incubator answer {id} {}",
        slots.join(" ")
    ));
    out.push(format!(
        "or go on assumptions: canopy incubator answer {id} --skip"
    ));
    out
}

/// `showLines()`: one project at length: where it stands and why it
/// waits, what it needs from you and the command that gives it, its intent
/// and inputs, and the link to its sheet.
pub fn show_lines(d: &Value, st: Option<&Value>, link: &str) -> Vec<String> {
    let s = d.get("sprout").unwrap_or(&Value::Null);
    let spent = s.get("spent").unwrap_or(&Value::Null);
    let minutes = round(num_at(spent, "workMs").unwrap_or(f64::NAN) / 60_000.0);
    let id = field(s, "id");
    let status = str_at(s, "status");
    let parked = if truthy_at(s, "parked") {
        format!(": {}", field(s, "parked"))
    } else {
        String::new()
    };
    let mut out = vec![
        format!("{}  {}", field(s, "title"), field(s, "repoId")),
        format!("{}{parked}", field(s, "status")),
    ];
    if let Some(wait) = wait_why(s, st).filter(|w| !w.is_empty()) {
        out.push(format!("waiting: {wait}"));
    }
    let runs = spent.get("runs");
    out.push(format!(
        "{} {}, {} min of agent work",
        template(runs),
        if runs.and_then(Value::as_f64) == Some(1.0) {
            "run"
        } else {
            "runs"
        },
        number_string(minutes)
    ));
    let questions = list_at(s, "questions");
    if status == Some("clarifying") && !questions.is_empty() {
        out.push(String::new());
        out.extend(question_lines(&id, questions));
    }
    if status == Some("approving") && truthy_at(s, "handOff") {
        let h = &s["handOff"];
        out.push(String::new());
        out.push(hand_off_text(h));
        out.push(String::new());
        out.push(format!(
            "push it: canopy incubator handoff {id} --yes {}",
            js_slice(&field(h, "head"), 12)
        ));
        out.push(format!(
            "decline: canopy incubator handoff {id} --no \"<reason>\""
        ));
    }
    if status == Some("parked") {
        out.push(String::new());
        out.push(format!("go on: canopy incubator resume {id}"));
        out.push(format!(
            "run the step again, or send the work back: canopy incubator resume {id} --retry"
        ));
        out.push(format!("end it: canopy incubator stop {id}"));
    }
    if sprout_ended(s) {
        out.push(String::new());
        out.push(format!("off the list: canopy incubator dismiss {id}"));
    }
    if truthy_at(d, "intent") {
        out.push(String::new());
        out.push(js_trim(&field(d, "intent")).to_string());
    }
    out.push(String::new());
    out.push(js_trim(&field(d, "inputsIndex")).to_string());
    out.push(String::new());
    out.push(link.into());
    out
}

/// `/^\d+(\s*,\s*\d+)*$/`
static NUMBERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^[0-9]+(?:{JS_S}*,{JS_S}*[0-9]+)*$")).unwrap());

/// `picked()`: a number in range picks that option; where any may be
/// picked, numbers split by commas pick each.
fn picked(q: &Value, raw: &str) -> Option<String> {
    let options = list_at(q, "options");
    if options.is_empty() || !NUMBERS.is_match(raw) {
        return None;
    }
    let mut nums: Vec<f64> = Vec::new();
    for n in raw.split(',') {
        let n = number_of(js_trim(n));
        if !nums.contains(&n) {
            nums.push(n);
        }
    }
    if nums.len() > 1 && !truthy_at(q, "multiSelect") {
        return None;
    }
    if nums.iter().any(|n| *n < 1.0 || *n > options.len() as f64) {
        return None;
    }
    Some(
        nums.iter()
            .map(|n| field(&options[*n as usize - 1], "label"))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// `answerMap()`: the answers `POST /api/incubator/answer` reads, keyed by
/// each question's text, from the command's words in question order. A
/// number picks that option ("1,3" where any may be picked), "" leaves the
/// question unanswered, and anything else is the answer as written.
pub fn answer_map(questions: &[Value], given: &[String]) -> Result<Map<String, Value>, String> {
    if given.len() > questions.len() {
        let qs = if questions.len() == 1 {
            "one question".to_string()
        } else {
            format!("{} questions", questions.len())
        };
        return Err(format!(
            "{} answers for {qs}: give one per question, in order",
            given.len()
        ));
    }
    let mut answers = Map::new();
    for (i, q) in questions.iter().enumerate() {
        let raw = js_trim(given.get(i).map_or("", String::as_str));
        if !raw.is_empty() {
            let answer = picked(q, raw).unwrap_or_else(|| raw.to_string());
            answers.insert(field(q, "question"), Value::String(answer));
        }
    }
    if answers.is_empty() {
        return Err(format!(
            "give an answer, or --skip to go on assumptions\n{}",
            incubator_usage()
        ));
    }
    Ok(answers)
}

/// `Bun.file(path).exists()`: true for a file, false for a directory or
/// nothing.
fn exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| !m.is_dir())
}

/// `missingFile()`: the first of the paths that is not a file.
fn missing_file(paths: &[String]) -> Option<&String> {
    paths.iter().find(|p| !exists(p))
}

/// `intakeForm()`: the multipart body the intake routes read, its files
/// read from disk (`missing_file` checks them first).
fn intake_form(a: &IntakeArgs) -> Result<Vec<Part>, String> {
    let text = |name: &str, value: &str| Part::Text {
        name: name.into(),
        value: value.into(),
    };
    let mut form = Vec::new();
    if !a.text.is_empty() {
        form.push(text("text", &a.text));
    }
    for u in &a.urls {
        form.push(text("url", u));
    }
    if let Some(r) = a.repo.as_deref().filter(|r| !r.is_empty()) {
        form.push(text("repo", r));
    }
    for path in &a.files {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        form.push(Part::File {
            name: "file".into(),
            filename: basename(path),
            mime: crate::clips::bun_type(path).into(),
            bytes,
        });
    }
    form.push(text("via", "cli"));
    Ok(form)
}

/// `newCommand()`. The note on how a lone url was taken goes to stderr as
/// it is decided, through `note`.
pub(crate) async fn new_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    note: &dyn Fn(&str),
    p: Paint,
) -> Result<(), String> {
    let parsed = parse_new_args(&argv, caller.env_api.as_deref())?;
    if let Some(missing) = missing_file(&parsed.files) {
        return Err(format!("no such file: {missing}"));
    }
    let b = parsed.backend.clone().unwrap_or_default();
    // asked before a file is read or sent: a backend with nowhere to run a
    // stage would refuse the project only after the whole upload
    let stages = read_stages(&b, ask)
        .await
        .map_err(|e| format!("{b} did not answer: {e}"))?;
    if stages.as_ref().and_then(|s| str_at(s, "mode")) == Some("off") {
        return Err(NO_STAGES.into());
    }
    if let Some(n) = &parsed.note {
        note(&p.dim(n));
    }
    let form = intake_form(&parsed)?;
    let s = call(&b, "POST", "/api/incubator", Some(Body::Form(&form)), ask).await?;
    if !truthy_at(&s, "id") {
        return Err("the backend answered with no project".into());
    }
    let title = match s.get("title") {
        None | Some(Value::Null) => String::new(),
        some => template(some),
    };
    out.line(format!("{} {title}", p.moss(&field(&s, "id"))));
    let page = page_origin(&b, ask).await;
    out.line(p.sky(&sprout_link(&page, &field(&s, "id"))));
    Ok(())
}

/// `unknownFlag()`: the first word that reads as a flag.
fn unknown_flag(words: &[String]) -> Option<&String> {
    words.iter().find(|w| w.starts_with("--"))
}

/// `incubatorCommand()`. `cwd` is where pick-check reads the seed's files.
pub(crate) async fn incubator_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    cwd: &str,
    p: Paint,
) -> Result<(), String> {
    let backend_flag = args.iter().any(|a| a == "--backend");
    let given = take(&mut args, "--backend");
    if backend_flag && given.is_none() {
        return Err("--backend needs a value".into());
    }
    let backend = caller.api_base(given.as_deref());
    if !is_origin(&backend) {
        return Err(format!(
            "--backend must be an http(s) origin, got {backend}"
        ));
    }
    let b = backend.as_str();
    let as_json = has(&mut args, "--json");
    let sub = args.first().cloned().unwrap_or_else(|| "list".into());
    // the id, read once a subcommand has taken its own flags out, so a flag
    // before it is not the id
    let id_arg = |args: &[String]| -> String {
        let word = args.get(1).cloned().unwrap_or_default();
        if word.starts_with("--") {
            String::new()
        } else {
            word
        }
    };
    let one = |id: &str| format!("?id={}", encode_component(id));
    // the id of a command that takes it and nothing else
    let only = |args: &[String], usage: &str| -> Result<String, String> {
        let id = id_arg(args);
        if !id.is_empty() && args.len() == 2 {
            Ok(id)
        } else {
            Err(usage.into())
        }
    };

    match sub.as_str() {
        "list" => {
            if args.len() > 1 {
                return Err(incubator_usage());
            }
            let list = call(b, "GET", "/api/incubator", None, ask).await?;
            let stages = read_stages(b, ask).await.ok().flatten();
            if as_json {
                out.line(pretty(&list));
                return Ok(());
            }
            let items = list.as_array().map_or(&[][..], Vec::as_slice);
            if items.is_empty() {
                out.line(p.dim("nothing in the incubator"));
            }
            for s in items {
                out.line(list_line(s, stages.as_ref()));
            }
            Ok(())
        }
        "show" => {
            let id = only(&args, "usage: canopy incubator show <id> [--json]")?;
            let d = call(
                b,
                "GET",
                &format!("/api/incubator/one{}", one(&id)),
                None,
                ask,
            )
            .await?;
            let stages = read_stages(b, ask).await.ok().flatten();
            let page = page_origin(b, ask).await;
            if as_json {
                out.line(pretty(&d));
                return Ok(());
            }
            let sprout_id = d
                .get("sprout")
                .map_or("undefined".into(), |s| field(s, "id"));
            let lines = show_lines(&d, stages.as_ref(), &sprout_link(&page, &sprout_id));
            let (head, rest) = lines
                .split_first()
                .map_or(("", &[][..]), |(h, r)| (h.as_str(), r));
            out.line(p.bold(head));
            if let Some((last, middle)) = rest.split_last() {
                for line in middle {
                    out.line(line);
                }
                out.line(p.sky(last));
            } else {
                out.line(p.sky(""));
            }
            Ok(())
        }
        "answer" => {
            let usage = "usage: canopy incubator answer <id> \"<answer>\"... | --skip";
            let skip = has(&mut args, "--skip");
            let words: Vec<String> = args.iter().skip(2).cloned().collect();
            let id = id_arg(&args);
            let odd = unknown_flag(&words);
            if id.is_empty() || odd.is_some() {
                return Err(match odd {
                    Some(f) => format!("unknown flag {f}\n{usage}"),
                    None => usage.into(),
                });
            }
            let path = format!("/api/incubator/answer{}", one(&id));
            if skip {
                if !words.is_empty() {
                    return Err("give answers or --skip, not both".into());
                }
                let s = call(
                    b,
                    "POST",
                    &path,
                    Some(Body::Json(&json!({"skip": true}))),
                    ask,
                )
                .await?;
                out.line(list_line(&s, None));
                return Ok(());
            }
            if words.is_empty() {
                return Err(usage.into());
            }
            let d = call(
                b,
                "GET",
                &format!("/api/incubator/one{}", one(&id)),
                None,
                ask,
            )
            .await?;
            let s = d.get("sprout").unwrap_or(&Value::Null);
            let questions = if str_at(s, "status") == Some("clarifying") {
                list_at(s, "questions")
            } else {
                &[]
            };
            if questions.is_empty() {
                return Err("this project has no open questions".into());
            }
            let answers = answer_map(questions, &words)?;
            let body = json!({ "answers": answers });
            let s = call(b, "POST", &path, Some(Body::Json(&body)), ask).await?;
            out.line(list_line(&s, None));
            Ok(())
        }
        "resume" => {
            let retry = has(&mut args, "--retry");
            let id = only(&args, "usage: canopy incubator resume <id> [--retry]")?;
            let body = json!({"choice": if retry { "retry" } else { "continue" }});
            let path = format!("/api/incubator/resume{}", one(&id));
            let s = call(b, "POST", &path, Some(Body::Json(&body)), ask).await?;
            out.line(list_line(&s, None));
            Ok(())
        }
        "stop" => {
            let id = only(&args, "usage: canopy incubator stop <id>")?;
            let path = format!("/api/incubator/stop{}", one(&id));
            let s = call(b, "POST", &path, Some(Body::Json(&json!({}))), ask).await?;
            out.line(list_line(&s, None));
            Ok(())
        }
        "dismiss" => {
            let id = only(&args, "usage: canopy incubator dismiss <id>")?;
            call(
                b,
                "DELETE",
                &format!("/api/incubator{}", one(&id)),
                None,
                ask,
            )
            .await?;
            out.line(format!("{id} is off the list; its seed and vault note stay, and its record and raw inputs are deleted in two weeks"));
            Ok(())
        }
        "add" => {
            let id = id_arg(&args);
            let parsed = parse_add_args(&args[args.len().min(2)..]);
            let parsed = match parsed {
                Err(e) => return Err(e),
                Ok(_) if id.is_empty() => return Err(incubator_usage()),
                Ok(a) => a,
            };
            if let Some(missing) = missing_file(&parsed.files) {
                return Err(format!("no such file: {missing}"));
            }
            let form = intake_form(&parsed)?;
            let path = format!("/api/incubator/input{}", one(&id));
            let s = call(b, "POST", &path, Some(Body::Form(&form)), ask).await?;
            out.line(list_line(&s, None));
            Ok(())
        }
        "handoff" => {
            let usage = "usage: canopy incubator handoff <id> --yes <head> | --no [\"<reason>\"]";
            let yes = args.iter().any(|a| a == "--yes");
            let head = take(&mut args, "--yes");
            let no = has(&mut args, "--no");
            let words: Vec<String> = args.iter().skip(2).cloned().collect();
            let id = id_arg(&args);
            if id.is_empty() || yes == no || unknown_flag(&words).is_some() {
                return Err(usage.into());
            }
            let path = format!("/api/incubator/handoff{}", one(&id));
            if yes {
                let head = head.unwrap_or_default();
                if head.is_empty()
                    || !head.bytes().all(|c| c.is_ascii_hexdigit())
                    || !words.is_empty()
                {
                    return Err(format!(
                        "{usage}\n--yes takes the head show printed, so the yes is for the commits you looked at"
                    ));
                }
                // a yes holds for the head it names alone: show prints twelve characters of it
                let d = call(
                    b,
                    "GET",
                    &format!("/api/incubator/one{}", one(&id)),
                    None,
                    ask,
                )
                .await?;
                let at = d.get("sprout").and_then(|s| s.get("handOff")).map_or(
                    String::new(),
                    |h| match h.get("head") {
                        None | Some(Value::Null) => String::new(),
                        some => template(some),
                    },
                );
                let full = if head.len() >= 7 && at.starts_with(&head) {
                    at
                } else {
                    head
                };
                let body = json!({"approve": true, "head": full});
                let s = call(b, "POST", &path, Some(Body::Json(&body)), ask).await?;
                out.line(list_line(&s, None));
                return Ok(());
            }
            let reason = js_trim(&words.join(" ")).to_string();
            let mut body = json!({"approve": false, "head": ""});
            if !reason.is_empty() {
                body["reason"] = json!(reason);
            }
            let s = call(b, "POST", &path, Some(Body::Json(&body)), ask).await?;
            out.line(list_line(&s, None));
            Ok(())
        }
        "pick-check" => {
            // run by scout's check in the seed: what canopy will read after scout, read now
            let pick_file = canopy_core::pathx::join(cwd, ".canopy/pick.json");
            if !exists(&pick_file) {
                return Err(".canopy/pick.json is missing: research ends by writing it".into());
            }
            let text = std::fs::read(&pick_file).map_err(|e| e.to_string())?;
            let pick = parse_pick(&String::from_utf8_lossy(&text))
                .map_err(|e| format!(".canopy/pick.json: {e}"))?;
            if let Some(refused) = pick_refusal(&pick).or_else(|| phase_refusal(&pick)) {
                return Err(format!(".canopy/pick.json: {refused}"));
            }
            if !exists(&canopy_core::pathx::join(cwd, ".canopy/research.md")) {
                return Err(
                    ".canopy/research.md is missing: research writes it before the pick".into(),
                );
            }
            out.line(format!("pick ok: {} on {}", pick.kind, pick.host));
            Ok(())
        }
        _ => Err(incubator_usage()),
    }
}

#[cfg(test)]
mod tests;
