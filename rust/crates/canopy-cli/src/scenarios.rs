//! `canopy scenarios` (`src/cli/scenarios.ts`): a repo's holdout scenarios,
//! listed, added and run, over the API of the backend that holds them.

use crate::api::Caller;
use crate::ask::{Ask, Target, did_not_answer, encode_component, has, shift, take};
use crate::out::Out;
use canopy_core::js::{field, list_at, num_at, str_at, to_fixed, truthy_at};
use canopy_core::pathx::{js_trim, pad_end};
use serde_json::{Map, Value, json};
use std::time::Duration;

/// `SCENARIOS_USAGE`.
pub const SCENARIOS_USAGE: &str = "usage: canopy scenarios <repo> [--backend URL]\n       canopy scenarios <repo> add <name> [--judge] [--run CMD] [--backend URL]\n       canopy scenarios <repo> run [<run>] [--backend URL]";

/// `MAX_TIMEOUT` in core/scenario.ts: the seconds a whole pass may take.
const MAX_TIMEOUT: u64 = 1800;

/// `listLines()`: one line per scenario, `name  kind`; a file that does not
/// read as `file  unreadable`; a line that says how to add one when empty.
pub fn list_lines(repo: &str, got: &Value) -> Vec<String> {
    let names = list_at(got, "names");
    let errors = list_at(got, "errors");
    if names.is_empty() && errors.is_empty() {
        return vec![format!(
            "no scenarios for {repo}; add one with canopy scenarios {repo} add <name>"
        )];
    }
    let mut out = vec![repo.to_string()];
    for n in names {
        out.push(format!(
            "  {} {}",
            pad_end(&field(n, "name"), 16),
            field(n, "kind")
        ));
    }
    for e in errors {
        out.push(format!("  {} unreadable", pad_end(&field(e, "file"), 16)));
    }
    out
}

/// `runLines()`: `scenarios 2/3 · 0.67`, then a line per result.
pub fn run_lines(run: &Value) -> Vec<String> {
    let skipped = list_at(run, "skipped").len();
    let mut out = vec![format!(
        "scenarios {}/{} · {}{}",
        field(run, "passed"),
        field(run, "total"),
        to_fixed(num_at(run, "score").unwrap_or(f64::NAN), 2),
        if skipped > 0 {
            format!(" · {skipped} left out")
        } else {
            String::new()
        }
    )];
    for r in list_at(run, "results") {
        let name = field(r, "name");
        if str_at(r, "kind") == Some("command") {
            out.push(if truthy_at(r, "ok") {
                format!("  ok   {name}")
            } else {
                let tail = str_at(r, "tail").unwrap_or("");
                format!("  red  {name}  {}", tail.rsplit('\n').next().unwrap_or(""))
            });
            continue;
        }
        let word = num_at(r, "p").map_or_else(|| "unjudged".to_string(), |p| to_fixed(p, 2));
        let why = str_at(r, "why").or_else(|| str_at(r, "unjudged"));
        out.push(format!(
            "  {} {name}{}",
            pad_end(&word, 4),
            why.filter(|w| !w.is_empty())
                .map(|w| format!("  {w}"))
                .unwrap_or_default()
        ));
    }
    out
}

/// `scenariosCommand()`.
pub(crate) async fn scenarios_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    // the bare flag first, so `--run --judge` leaves --run with no shell line
    let judge = has(&mut args, "--judge");
    let run_flag = args.iter().any(|a| a == "--run");
    let run_cmd = take(&mut args, "--run");
    let home = caller.api_base(given.as_deref());
    let target = Target::home(&home);
    let failed = |e| did_not_answer("home", &e);
    let repo = match shift(&mut args) {
        Some(r) if !r.is_empty() => r,
        _ => return Err(SCENARIOS_USAGE.into()),
    };
    match shift(&mut args).as_deref() {
        None => {
            if judge || run_cmd.is_some() {
                return Err(SCENARIOS_USAGE.into());
            }
            let path = format!("/api/scenarios/names?repo={}", encode_component(&repo));
            let got = ask.ask(&target, "GET", &path, None).await.map_err(failed)?;
            out.lines(list_lines(&repo, &got));
            Ok(())
        }
        Some("add") => {
            let name = match shift(&mut args) {
                Some(n) if !n.is_empty() && args.is_empty() => n,
                _ => return Err(SCENARIOS_USAGE.into()),
            };
            if run_flag && run_cmd.as_deref().is_none_or(|c| js_trim(c).is_empty()) {
                return Err("--run needs a shell line".into());
            }
            let mut body = Map::new();
            body.insert("repo".into(), json!(repo));
            body.insert("name".into(), json!(name));
            if judge {
                body.insert("kind".into(), json!("judge"));
            }
            if let Some(c) = &run_cmd {
                body.insert("run".into(), json!(c));
            }
            let got = ask
                .ask(
                    &target,
                    "POST",
                    "/api/scenarios",
                    Some(&Value::Object(body)),
                )
                .await
                .map_err(failed)?;
            out.line(format!("wrote {}", field(&got, "path")));
            Ok(())
        }
        Some("run") => {
            let run = shift(&mut args);
            if !args.is_empty() || judge || run_cmd.is_some() {
                return Err(SCENARIOS_USAGE.into());
            }
            let mut body = Map::new();
            body.insert("repo".into(), json!(repo));
            if let Some(r) = run.filter(|r| !r.is_empty()) {
                body.insert("run".into(), json!(r));
            }
            // the server bounds a whole pass at MAX_TIMEOUT seconds; a minute
            // more lets its answer arrive
            let got = ask
                .ask_within(
                    &target,
                    "POST",
                    "/api/scenarios/run",
                    Some(&Value::Object(body)),
                    Duration::from_secs(MAX_TIMEOUT + 60),
                )
                .await
                .map_err(failed)?;
            if num_at(&got, "total") == Some(0.0) {
                out.line(format!("no scenarios for {repo}"));
                return Ok(());
            }
            let lines = run_lines(&got);
            let passed = num_at(&got, "passed").unwrap_or(f64::NAN);
            let total = num_at(&got, "total").unwrap_or(f64::NAN);
            if passed < total {
                return Err(lines.join("\n"));
            }
            out.lines(lines);
            Ok(())
        }
        Some(_) => Err(SCENARIOS_USAGE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::AskError;
    use crate::ask::tests::Fake;
    use std::sync::Mutex;

    #[test]
    fn list_lines_name_each_scenario() {
        let got = json!({"names": [{"name": "checkout", "kind": "command"}, {"name": "refund", "kind": "judge"}], "errors": [{"file": "x.md"}]});
        assert_eq!(
            list_lines("dev-tools/canopy", &got),
            [
                "dev-tools/canopy",
                "  checkout         command",
                "  refund           judge",
                "  x.md             unreadable",
            ]
        );
        assert_eq!(
            list_lines("r", &json!({"names": [], "errors": []})),
            ["no scenarios for r; add one with canopy scenarios r add <name>"]
        );
    }

    #[test]
    fn run_lines_say_what_passed() {
        let run = json!({"head": "h", "at": 1, "total": 3, "passed": 1, "score": 1.0 / 3.0, "results": [{"name": "a", "kind": "command", "ok": true, "tail": "fine"}, {"name": "b", "kind": "command", "ok": false, "tail": "lots\n1 fail"}]});
        assert_eq!(
            run_lines(&run),
            ["scenarios 1/3 · 0.33", "  ok   a", "  red  b  1 fail"]
        );
        let judged = json!({"head": "h", "at": 1, "total": 2, "passed": 1, "score": 0.45, "results": [{"name": "mail", "kind": "judge", "ok": true, "p": 0.9}, {"name": "refund", "kind": "judge", "ok": false, "unjudged": "no gateway key"}], "skipped": ["other"]});
        assert_eq!(
            run_lines(&judged),
            [
                "scenarios 1/2 · 0.45 · 1 left out",
                "  0.90 mail",
                "  unjudged refund  no gateway key"
            ]
        );
    }

    /// the command against a fake backend: what it printed, what it
    /// posted, and its failure
    async fn drive(argv: &[&str], answer: Value) -> (Vec<String>, Vec<Value>, Option<String>) {
        let posted = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, _: &str, b: Option<&Value>| {
            if m == "POST" {
                posted
                    .lock()
                    .unwrap()
                    .push(b.cloned().unwrap_or(Value::Null));
            }
            Ok::<Value, AskError>(answer.clone())
        });
        let mut out = Out::default();
        let args = argv.iter().map(|s| s.to_string()).collect();
        let r = scenarios_cmd(args, &Caller::default(), &fake, &mut out).await;
        let lines = out.printed().into_iter().map(String::from).collect();
        (lines, posted.into_inner().unwrap(), r.err())
    }

    #[tokio::test]
    async fn add_with_run_and_no_shell_line_fails_before_asking() {
        let (_, posted, failed) =
            drive(&["r", "add", "n", "--run"], json!({"path": "/x/n.md"})).await;
        assert_eq!(failed.as_deref(), Some("--run needs a shell line"));
        assert!(posted.is_empty());
        // a flag right after --run is not its shell line
        let (_, posted, failed) = drive(
            &["r", "add", "n", "--run", "--judge"],
            json!({"path": "/x/n.md"}),
        )
        .await;
        assert_eq!(failed.as_deref(), Some("--run needs a shell line"));
        assert!(posted.is_empty());
    }

    #[tokio::test]
    async fn add_judge_creates_a_judge_scenario() {
        let (lines, posted, failed) = drive(
            &["r", "add", "story", "--judge"],
            json!({"path": "/x/story.md"}),
        )
        .await;
        assert_eq!(failed, None);
        assert_eq!(lines, ["wrote /x/story.md"]);
        assert_eq!(
            posted,
            [json!({"repo": "r", "name": "story", "kind": "judge"})]
        );
        let (lines, posted, _) = drive(
            &["r", "add", "n", "--run", "make n"],
            json!({"path": "/x/n.md"}),
        )
        .await;
        assert_eq!(lines, ["wrote /x/n.md"]);
        assert_eq!(posted, [json!({"repo": "r", "name": "n", "run": "make n"})]);
    }

    #[tokio::test]
    async fn run_on_an_empty_set_says_there_are_none() {
        let empty =
            json!({"head": "h", "at": 1, "total": 0, "passed": 0, "score": 1, "results": []});
        let (lines, _, failed) = drive(&["r", "run"], empty).await;
        assert_eq!(failed, None);
        assert_eq!(lines, ["no scenarios for r"]);
    }

    #[tokio::test]
    async fn a_red_run_fails_with_its_lines() {
        let red = json!({"head": "h", "at": 1, "total": 1, "passed": 0, "score": 0, "results": [{"name": "a", "kind": "command", "ok": false, "tail": "boom"}]});
        let (lines, _, failed) = drive(&["r", "run"], red).await;
        assert!(lines.is_empty());
        assert_eq!(
            failed.as_deref(),
            Some("scenarios 0/1 · 0.00\n  red  a  boom")
        );
        let (_, _, failed) = drive(&[], json!({})).await;
        assert_eq!(failed.as_deref(), Some(SCENARIOS_USAGE));
        let (_, _, failed) = drive(&["r", "run", "--judge"], json!({})).await;
        assert_eq!(failed.as_deref(), Some(SCENARIOS_USAGE));
    }
}
