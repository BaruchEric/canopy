//! The transcript forms of `canopy run` (`src/cli/run-transcripts.ts`):
//! list the runs a backend keeps, show one (with `--wire`, its steps as the
//! replay folds them), export it as markdown, fork it, list the runs still
//! going, name, stop, steer or interrupt one, ask a side question beside
//! one and set its model, and prune the transcripts past their span.
//!
//! It holds the small pure helpers these lines need from src/core, which
//! nothing else in the port reads yet: `RUN_ID` (runlog.ts), `runSubject`
//! and `nameFailure` (runname.ts), `forkLine` (handoff.ts) and
//! `isRunActive` (types.ts).

use crate::api::Caller;
use crate::ask::{
    Ask, AskError, Target, did_not_answer, encode_component, has, is_origin, shift, take,
};
use crate::jsdate::iso_string;
use crate::out::Out;
use crate::run::RunEnv;
use canopy_core::diagnosis::locale_number;
use canopy_core::js::{
    field, list_at, num, num_at, number_string, str_at, template, to_fixed, truthy, truthy_at,
};
use canopy_core::pathx::{js_trim, pad_end, resolve_from};
use canopy_core::treelines::ago_f;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;

/// `RUN_USAGE`.
pub const RUN_USAGE: &str = "usage: canopy run <repo> <action> [-m note] [--times 1|2|3] [--profiles a,b,c] [--reviewers 2] [--auto-land] [--pr] [--priority interactive|normal|low] [--tools|--no-tools] [--loadout NAME] [--name \"words\"] [--backend URL] [--on NAME]
       canopy run [--backend URL]
       canopy run show <id> [--wire] [--backend URL]
       canopy run export <id> [--out file.md] [--backend URL]
       canopy run fork <id> [--at N] [--profile NAME] [-m note] [--backend URL]
       canopy run ls [--backend URL]
       canopy run name <id> <words…> [--backend URL]
       canopy run stop <id> [--backend URL]
       canopy run say <id> <words…> [--backend URL]
       canopy run interrupt <id> [words…] [--backend URL]
       canopy run side <id> <words…> [--model NAME] [--backend URL]
       canopy run model <id> <model> [--backend URL]
       canopy run prune [--backend URL]
       canopy run pickup <flow> [--backend URL] [--on NAME]";

/// `RUN_ID` in core/runlog.ts: `/^[A-Za-z0-9_-]{1,64}$/`.
pub fn is_run_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `isRunActive()` in core/types.ts: working, waiting or idle.
pub fn is_run_active(run: &Value) -> bool {
    matches!(str_at(run, "status"), Some("working" | "waiting" | "idle"))
}

/// `runSubject()` in core/runname.ts: the run's name, else its note's first
/// line, trimmed.
pub fn run_subject(run: &Value) -> String {
    if truthy_at(run, "name") {
        return field(run, "name");
    }
    let note = str_at(run, "note").unwrap_or("");
    js_trim(note.split('\n').next().unwrap_or("")).to_string()
}

/// `nameFailure()` in core/runname.ts: a backend from before run names has
/// no rename route and answers the server's plain 404, which names
/// nothing, so say what it means and what to do.
pub fn name_failure(message: &str) -> String {
    if message == "not found" {
        "this backend runs a canopy from before run names; deploy the current one to it and try again".into()
    } else {
        message.into()
    }
}

/// `nameFailure`'s twin for side questions, from runTranscriptCommand.
fn side_failure(message: &str) -> String {
    if message == "not found" {
        "this backend runs a canopy from before side questions; deploy the current one to it and try again".into()
    } else {
        message.into()
    }
}

/// `forkLine()` in core/handoff.ts: "forked from run 3f2a at step 41, the
/// transcript cut there and resumed".
pub fn fork_line(f: &Value) -> String {
    let at = field(f, "at");
    let where_ = if truthy_at(f, "step") {
        format!("at step {at}")
    } else {
        let one = num_at(f, "at") == Some(1.0);
        format!("at its end ({at} step{})", if one { "" } else { "s" })
    };
    let how = match str_at(f, "how") {
        Some("cut") => "the transcript cut there and resumed",
        Some("whole") => "the whole session resumed, the cut said in words",
        Some("brief") => "a brief of the steps to there",
        _ => "undefined",
    };
    format!("forked from run {} {where_}, {how}", field(f, "run"))
}

/// A number field as `-` would read it: a number as it is, null as 0, and
/// anything else as NaN (the fields here are always numbers).
fn number_in(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

/// `new Date(x).toISOString()`, or the words a Date that is not one gives.
fn iso(ms: f64) -> String {
    iso_string(ms).unwrap_or_else(|| "Invalid Date".into())
}

/// A comparator's answer as JavaScript's sort takes it: NaN is equal.
fn order(d: f64) -> Ordering {
    d.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
}

/// `keptLines()`: one line per kept run, newest first. `now` is unix
/// milliseconds.
pub fn kept_lines(heads: &[Value], now: f64) -> Vec<String> {
    let mut sorted: Vec<&Value> = heads.iter().collect();
    sorted.sort_by(|a, b| order(number_in(b.get("ended")) - number_in(a.get("ended"))));
    sorted
        .into_iter()
        .map(|head| {
            let cost = match head.get("cost") {
                Some(Value::Number(n)) => format!("${}", to_fixed(n.as_f64().unwrap_or(0.0), 2)),
                _ => "-".into(),
            };
            let name = if truthy_at(head, "name") {
                format!("  {}", field(head, "name"))
            } else {
                String::new()
            };
            format!(
                "{}  {}  {}  {}  {}  {cost}{name}",
                pad_end(&field(head, "id"), 8),
                pad_end(&ago_f(number_in(head.get("ended")) / 1000.0, now), 3),
                pad_end(&field(head, "repo"), 24),
                field(head, "verb"),
                pad_end(&field(head, "status"), 6),
            )
        })
        .collect()
}

/// `liveLines()`: one line per run still going, oldest first: id, how long
/// ago it started, repo, state, what it is, and the name it goes by
/// (FR-073). A side question says which run it sits beside (FR-077).
pub fn live_lines(runs: &[Value], now: f64) -> Vec<String> {
    let mut going: Vec<&Value> = runs.iter().filter(|r| is_run_active(r)).collect();
    going.sort_by(|a, b| order(number_in(a.get("startedAt")) - number_in(b.get("startedAt"))));
    going
        .into_iter()
        .map(|run| {
            let on = match run.get("branch") {
                Some(b) if truthy(Some(b)) => format!(" on {}", field(b, "name")),
                _ => String::new(),
            };
            let beside = match run.get("sideOf") {
                Some(s) if truthy(Some(s)) => format!(" beside {}", field(s, "run")),
                _ => String::new(),
            };
            let subject = run_subject(run);
            let subject = if subject.is_empty() {
                subject
            } else {
                format!("  {subject}")
            };
            format!(
                "{}  {}  {}  {}  {}{on}{beside}{subject}",
                pad_end(&field(run, "id"), 8),
                pad_end(&ago_f(number_in(run.get("startedAt")) / 1000.0, now), 3),
                pad_end(&field(run, "repoId"), 24),
                pad_end(&field(run, "status"), 7),
                field(run, "verb"),
            )
        })
        .collect()
}

/// `agentName()`: the harness by its product's name.
fn agent_name(harness: Option<&Value>) -> String {
    match harness.and_then(Value::as_str) {
        Some("claude") => "Claude Code".into(),
        Some("codex") => "Codex".into(),
        Some("antigravity") => "Antigravity".into(),
        _ => template(harness),
    }
}

/// `headLines()`: the run's export-style head.
fn head_lines(run: &Value, now: f64) -> Vec<String> {
    let started = number_in(run.get("startedAt"));
    let ended = run.get("endedAt");
    // `run.endedAt ?? Date.now()`, and "now" only when the field is absent
    let end = match ended {
        None | Some(Value::Null) => now,
        Some(v) => number_in(Some(v)),
    };
    let end_label = match ended {
        None => "now".to_string(),
        Some(v) => iso(number_in(Some(v))),
    };
    let elapsed = ((end - started) / 1000.0).floor().max(0.0);
    // `Math.max(0, NaN)` is NaN
    let elapsed = if (end - started).is_nan() {
        f64::NAN
    } else {
        elapsed
    };
    let seconds = elapsed % 60.0;
    let seconds = if seconds.is_finite() {
        format!("{:02}", seconds as i64)
    } else {
        number_string(seconds)
    };
    let duration = format!("{}:{seconds}", number_string((elapsed / 60.0).floor()));
    let result = run.get("result").filter(|r| !r.is_null());
    let cost = match result.and_then(|r| r.get("costUsd")) {
        Some(Value::Number(n)) => format!("${}", to_fixed(n.as_f64().unwrap_or(0.0), 2)),
        _ => match result.and_then(|r| r.get("tokens")) {
            Some(t) if truthy(Some(t)) => {
                format!("{} tokens", locale_number(number_in(t.get("total"))))
            }
            _ => "unknown".into(),
        },
    };
    let model = match result.and_then(|r| r.get("model")) {
        None | Some(Value::Null) => "unknown".to_string(),
        Some(m) => template(Some(m)),
    };
    let mut out = vec![
        format!(
            "{} in {} ({})",
            field(run, "verb"),
            field(run, "repoId"),
            if truthy_at(run, "kept") {
                "kept"
            } else {
                "live"
            }
        ),
        format!("run: {}", field(run, "id")),
    ];
    if truthy_at(run, "name") {
        out.push(format!("name: {}", field(run, "name")));
    }
    if let Some(side) = run.get("sideOf").filter(|s| truthy(Some(s))) {
        out.push(format!(
            "side question of: {} ({})",
            field(side, "run"),
            field(side, "title")
        ));
    }
    out.push(format!("action: {}", field(run, "action")));
    out.push(format!(
        "agent: {}, model {model}",
        agent_name(run.get("harness"))
    ));
    out.push(format!("when: {} to {end_label}, {duration}", iso(started)));
    out.push(format!("status: {}", field(run, "status")));
    out.push(format!("cost: {cost}"));
    if run.get("note").and_then(Value::as_str) != Some("") {
        out.push(format!("note: {}", field(run, "note")));
    }
    if let Some(b) = run.get("branch").filter(|b| truthy(Some(b))) {
        out.push(format!(
            "branch: {} onto {}, {}",
            field(b, "name"),
            field(b, "target"),
            field(b, "state")
        ));
    }
    out
}

/// `stepContent()`: what a step says.
fn step_content(step: &Value) -> String {
    match str_at(step, "kind") {
        Some("text" | "note" | "user") => match step.get("text") {
            None | Some(Value::Null) => String::new(),
            Some(t) => template(Some(t)),
        },
        Some("tool") => match step.get("tool") {
            Some(t) if truthy(Some(t)) => format!(
                "{}: {} ({})",
                field(t, "name"),
                field(t, "title"),
                field(t, "status")
            ),
            _ => String::new(),
        },
        // the exhaustive switch hands back the kind it did not know
        _ => field(step, "kind"),
    }
}

/// `showStep()`: a step's UTC time and words, a subagent's indented.
fn show_step(step: &Value) -> String {
    let at = iso(number_in(step.get("at")));
    let at = at.get(11..19).unwrap_or("");
    let indent = if truthy_at(step, "parent") {
        "    "
    } else {
        "  "
    };
    format!(
        "{indent}{at}  {}  {}",
        field(step, "kind"),
        step_content(step)
    )
}

/// `showLines()`: the run's export-style head followed by its timeline in
/// UTC. `now` stands in for a live run's end.
pub fn show_lines(run: &Value, now: f64) -> Vec<String> {
    let mut out = head_lines(run, now);
    out.extend(list_at(run, "steps").iter().map(show_step));
    out
}

/// `replayLines()`: `showLines` over the replay's steps: the record's own
/// with the prompts the wire shows the harness asking, or every step folded
/// back out of the wire when the record kept none of its own or trimmed its
/// oldest.
pub fn replay_lines(run: &Value, replay: &Value, now: f64) -> Vec<String> {
    let mut out = head_lines(run, now);
    out.push(if str_at(replay, "source") == Some("wire") {
        "steps: rebuilt from the wire, without canopy's own notes".into()
    } else {
        "steps: the record's, with the prompts its wire shows".into()
    });
    if truthy_at(replay, "cut") {
        out.push("the wire was cut at its size limit, so the steps stop short".into());
    }
    out.extend(list_at(replay, "steps").iter().map(show_step));
    out
}

/// Node's words for a failed `writeFile(path)`: the errno's code and
/// words, then the call and the path as given.
fn write_failure(e: &std::io::Error, call: &str, path: &str) -> String {
    use std::io::ErrorKind as K;
    let (code, words) = match e.kind() {
        K::NotFound => ("ENOENT", "no such file or directory"),
        K::PermissionDenied if e.raw_os_error() == Some(1) => ("EPERM", "operation not permitted"),
        K::PermissionDenied => ("EACCES", "permission denied"),
        K::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        K::NotADirectory => ("ENOTDIR", "not a directory"),
        K::InvalidFilename => ("ENAMETOOLONG", "name too long"),
        K::StorageFull => ("ENOSPC", "no space left on device"),
        K::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        _ => return e.to_string(),
    };
    if call == "open" {
        format!("{code}: {words}, open '{path}'")
    } else {
        format!("{code}: {words}, {call}")
    }
}

/// `writeFile(out, text, "utf8")`, read against the CLI's folder.
fn write_export(cwd: &str, file: &str, text: &str) -> Result<(), String> {
    use std::io::Write as _;
    let mut f = std::fs::File::create(resolve_from(cwd, file))
        .map_err(|e| write_failure(&e, "open", file))?;
    f.write_all(text.as_bytes())
        .map_err(|e| write_failure(&e, "write", file))
}

/// `runTranscriptCommand()`: every transcript form, against the home
/// backend only.
pub(crate) async fn transcript_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    env: &mut RunEnv,
) -> Result<(), String> {
    let mut args = argv;
    let backend_flag = args.iter().any(|a| a == "--backend");
    let given = take(&mut args, "--backend");
    let out_flag = args.iter().any(|a| a == "--out");
    let out_file = take(&mut args, "--out");
    if backend_flag && given.is_none() {
        return Err("--backend needs a value".into());
    }
    if out_flag
        && out_file
            .as_deref()
            .is_none_or(|f| f.is_empty() || f.starts_with('-'))
    {
        return Err("--out needs a file".into());
    }
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let target = Target::home(&home);
    let failed = |e: AskError| did_not_answer(&target.name, &e);
    let usage = || Err::<(), String>(RUN_USAGE.into());
    let id_ok = |id: &str| {
        if is_run_id(id) {
            Ok(())
        } else {
            Err(format!("invalid run id: {id}"))
        }
    };
    let sub = shift(&mut args);

    let Some(sub) = sub else {
        if !args.is_empty() || out_flag {
            return usage();
        }
        let heads = ask
            .ask(&target, "GET", "/api/runs?kept=1", None)
            .await
            .map_err(failed)?;
        let heads = heads.as_array().map_or(&[][..], Vec::as_slice);
        if heads.is_empty() {
            out.line("no kept runs");
        } else {
            out.lines(kept_lines(heads, env.now));
        }
        return Ok(());
    };

    match sub.as_str() {
        "show" => {
            let wire = has(&mut args, "--wire");
            let id = args.first().cloned().unwrap_or_default();
            if args.len() != 1 || id.is_empty() || out_flag {
                return usage();
            }
            id_ok(&id)?;
            let path = format!("/api/runs/{}", encode_component(&id));
            let run = ask.ask(&target, "GET", &path, None).await.map_err(failed)?;
            if !wire {
                out.lines(show_lines(&run, env.now));
                return Ok(());
            }
            let replay = ask
                .ask(&target, "GET", &format!("{path}/replay"), None)
                .await
                .map_err(failed)?;
            out.lines(replay_lines(&run, &replay, env.now));
            Ok(())
        }
        "export" => {
            let id = args.first().cloned().unwrap_or_default();
            if args.len() != 1 || id.is_empty() {
                return usage();
            }
            id_ok(&id)?;
            let path = format!("/api/runs/{}/export", encode_component(&id));
            let text = ask.ask_text(&target, &path).await.map_err(failed)?;
            match out_file {
                None => out.write(&text),
                Some(file) => {
                    write_export(&env.cwd, &file, &text)?;
                    out.line(format!("wrote {file}"));
                }
            }
            Ok(())
        }
        "fork" => {
            let id = shift(&mut args).unwrap_or_default();
            if id.is_empty() || out_flag {
                return usage();
            }
            id_ok(&id)?;
            let at_flag = args.iter().any(|a| a == "--at");
            let at = take(&mut args, "--at");
            // /^[1-9]\d*$/
            let at_ok = |a: &str| {
                a.as_bytes()
                    .first()
                    .is_some_and(|b| (b'1'..=b'9').contains(b))
                    && a.bytes().all(|b| b.is_ascii_digit())
            };
            if at_flag && !at.as_deref().is_some_and(at_ok) {
                return Err(
                    "--at needs a step's number, from 1, as canopy run show --wire counts them"
                        .into(),
                );
            }
            let profile_flag = args.iter().any(|a| a == "--profile");
            let profile = take(&mut args, "--profile").filter(|p| !p.is_empty());
            if profile_flag && profile.is_none() {
                return Err("--profile needs a profile's name".into());
            }
            let note_flag = args.iter().any(|a| a == "-m");
            let note = take(&mut args, "-m");
            if note_flag && note.is_none() {
                return Err("-m needs a note".into());
            }
            if !args.is_empty() {
                return usage();
            }
            let mut body = Map::new();
            body.insert("run".into(), json!(id));
            if let Some(a) = &at {
                body.insert("step".into(), num(a.parse().unwrap_or(f64::NAN)));
            }
            if let Some(p) = &profile {
                body.insert("profile".into(), json!(p));
            }
            if let Some(n) = note.filter(|n| !n.is_empty()) {
                body.insert("note".into(), json!(n));
            }
            let run = ask
                .ask(
                    &target,
                    "POST",
                    "/api/runs/fork",
                    Some(&Value::Object(body)),
                )
                .await
                .map_err(failed)?;
            out.line(format!("{} {}", field(&run, "id"), field(&run, "status")));
            if let Some(f) = run.get("forkOf").filter(|f| truthy(Some(f))) {
                out.line(fork_line(f));
            }
            Ok(())
        }
        // the runs still going, a name for one, and its end (FR-073)
        "ls" => {
            if !args.is_empty() || out_flag {
                return usage();
            }
            let runs = ask
                .ask(&target, "GET", "/api/runs", None)
                .await
                .map_err(failed)?;
            let lines = live_lines(runs.as_array().map_or(&[][..], Vec::as_slice), env.now);
            if lines.is_empty() {
                out.line("no runs going");
            } else {
                out.lines(lines);
            }
            Ok(())
        }
        "name" | "stop" => {
            let id = shift(&mut args).unwrap_or_default();
            if id.is_empty() || out_flag {
                return usage();
            }
            id_ok(&id)?;
            let name = js_trim(&args.join(" ")).to_string();
            if sub == "name" && name.is_empty() {
                return Err("canopy run name needs the name to give it".into());
            }
            if sub == "stop" && !name.is_empty() {
                return usage();
            }
            // a backend from before run names answers a rename with a bare 404
            let (path, body) = if sub == "name" {
                ("/api/runs/name", json!({"id": id, "name": name}))
            } else {
                ("/api/runs/stop", json!({"id": id}))
            };
            let run = ask
                .ask(&target, "POST", path, Some(&body))
                .await
                .map_err(|e| {
                    let words = did_not_answer(&target.name, &e);
                    if sub == "name" {
                        name_failure(&words)
                    } else {
                        words
                    }
                })?;
            if sub == "name" {
                // `${run.id} ${run.name ?? ""}`.trim()
                let named = match run.get("name") {
                    None | Some(Value::Null) => String::new(),
                    Some(n) => template(Some(n)),
                };
                out.line(js_trim(&format!("{} {named}", field(&run, "id"))));
            } else {
                out.line(format!("{} {}", field(&run, "id"), field(&run, "status")));
            }
            Ok(())
        }
        // a person's words into a live run: a chat's next turn, or a steer
        // into any run at work; interrupt stops the turn first, the words
        // going next
        "say" | "interrupt" => {
            let id = shift(&mut args).unwrap_or_default();
            if id.is_empty() || out_flag {
                return usage();
            }
            id_ok(&id)?;
            let text = js_trim(&args.join(" ")).to_string();
            if sub == "say" && text.is_empty() {
                return Err("canopy run say needs the words to send".into());
            }
            let mut body = Map::new();
            body.insert("id".into(), json!(id));
            if !text.is_empty() {
                body.insert("text".into(), json!(text));
            }
            let path = if sub == "say" {
                "/api/runs/say"
            } else {
                "/api/runs/interrupt"
            };
            let run = ask
                .ask(&target, "POST", path, Some(&Value::Object(body)))
                .await
                .map_err(failed)?;
            out.line(format!("{} {}", field(&run, "id"), field(&run, "status")));
            Ok(())
        }
        // a side question beside a run that is going: a chat forked from its
        // session, which leaves the run at work, and another model for that
        // chat's later messages (FR-077)
        "side" | "model" => {
            let id = shift(&mut args).unwrap_or_default();
            if id.is_empty() || out_flag {
                return usage();
            }
            id_ok(&id)?;
            // a backend from before side questions answers either with a bare 404
            let side_failed = |e: AskError| side_failure(&did_not_answer(&target.name, &e));
            if sub == "model" {
                let model = shift(&mut args).unwrap_or_default();
                if model.is_empty() || !args.is_empty() {
                    return usage();
                }
                let run = ask
                    .ask(
                        &target,
                        "POST",
                        "/api/runs/model",
                        Some(&json!({"id": id, "model": model})),
                    )
                    .await
                    .map_err(side_failed)?;
                // `run.agentSettings?.model ?? model`
                let now_model = match run.get("agentSettings").and_then(|s| s.get("model")) {
                    None | Some(Value::Null) => model,
                    Some(m) => template(Some(m)),
                };
                out.line(format!("{} {now_model}", field(&run, "id")));
                return Ok(());
            }
            let model_flag = args.iter().any(|a| a == "--model");
            let model = take(&mut args, "--model").filter(|m| !m.is_empty());
            if model_flag && model.is_none() {
                return Err("--model needs a model's name".into());
            }
            let text = js_trim(&args.join(" ")).to_string();
            if text.is_empty() {
                return Err("canopy run side needs the question to ask".into());
            }
            let mut body = Map::new();
            body.insert("id".into(), json!(id));
            body.insert("text".into(), json!(text));
            if let Some(m) = &model {
                body.insert("model".into(), json!(m));
            }
            let run = ask
                .ask(
                    &target,
                    "POST",
                    "/api/runs/side",
                    Some(&Value::Object(body)),
                )
                .await
                .map_err(side_failed)?;
            let side = field(&run, "id");
            out.line(format!("{side} {}", field(&run, "status")));
            out.line(format!(
                "a side question beside run {id}, which works on; read it with canopy run show {side}, go on with canopy run say {side} <words…>"
            ));
            Ok(())
        }
        "prune" => {
            if !args.is_empty() || out_flag {
                return usage();
            }
            let result = ask
                .ask(&target, "POST", "/api/runs/prune", None)
                .await
                .map_err(failed)?;
            out.line(format!(
                "removed {} transcripts, {} kept",
                list_at(&result, "removed").len(),
                field(&result, "kept")
            ));
            Ok(())
        }
        _ => usage(),
    }
}

#[cfg(test)]
mod tests;
