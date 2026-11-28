//! `canopy work` (`src/cli/work.ts`): the backends' branch work items, and
//! reading, annotating, closing or exporting one, over the HTTP API.

use crate::api::Caller;
use crate::ask::{
    Ask, Target, did_not_answer, encode_component, form_query, has, is_origin, listed_targets,
    shift, skipped_line, take,
};
use crate::out::Out;
use canopy_core::js::{field, join, list_at, num_at};
use canopy_core::pathx::{js_trim, pad_end};
use canopy_core::work::{WORK_STATES, from_word, is_work_id, note_stamp, work_id_of};
use serde_json::{Map, Value, json};

/// `WORK_USAGE`.
pub const WORK_USAGE: &str = "usage: canopy work [list] [--repo R] [--state S] [--backend URL]\n       canopy work show <id> [--backend URL]\n       canopy work note [<id>] \"<text>\" [--backend URL]\n       canopy work close <id> --landed | --dropped [-m why] [--backend URL]\n       canopy work export <id> [--backend URL]";

/// `words()`: the values joined, or "none".
fn words(values: &[Value]) -> String {
    if values.is_empty() {
        "none".into()
    } else {
        join(values, ", ")
    }
}

/// `listLines()`: one line per item, with the backend as a heading when
/// asked.
pub fn list_lines(items: &[Value], backend: &str) -> Vec<String> {
    let mut out = Vec::new();
    if !backend.is_empty() {
        out.push(backend.to_string());
    }
    for item in items {
        let newest = list_at(item, "notes")
            .last()
            .map(|n| format!("  · {}: {}", field(n, "by"), field(n, "text")))
            .unwrap_or_default();
        out.push(format!(
            "{}  {} {} {}{newest}",
            field(item, "id"),
            pad_end(&field(item, "state"), 8),
            pad_end(&join(list_at(item, "repos"), ","), 18),
            field(item, "title")
        ));
    }
    out
}

/// `showLines()`: the whole item, its source, branches, runs, links and
/// dated notes.
pub fn show_lines(item: &Value) -> Vec<String> {
    let prs: Vec<Value> = list_at(item, "prs")
        .iter()
        .map(|pr| json!(format!("#{} {}", field(pr, "number"), field(pr, "url"))))
        .collect();
    let from = item.get("from").unwrap_or(&Value::Null);
    let mut out = vec![
        format!("{}  {}", field(item, "id"), field(item, "title")),
        format!(
            "state: {}   repos: {}   from: {}",
            field(item, "state"),
            words(list_at(item, "repos")),
            from_word(from)
        ),
        format!(
            "branches: {}   runs: {}   PRs: {}   events: {}",
            words(list_at(item, "branches")),
            words(list_at(item, "runs")),
            words(&prs),
            words(list_at(item, "events"))
        ),
        "notes:".into(),
    ];
    let notes = list_at(item, "notes");
    if notes.is_empty() {
        out.push("  (none yet)".into());
    }
    for note in notes {
        out.push(format!(
            "  {}  {}  {}",
            note_stamp(num_at(note, "at").unwrap_or(f64::NAN)),
            field(note, "by"),
            field(note, "text")
        ));
    }
    out
}

/// `currentBranch(cwd)`: the branch the folder is on, or None.
async fn current_branch(dir: &str) -> Option<String> {
    let r = canopy_core::exec::git(dir, &["symbolic-ref", "-q", "--short", "HEAD"]).await;
    let b = js_trim(&r.stdout);
    (r.code == 0 && !b.is_empty()).then(|| b.to_string())
}

/// `workCommand()`. `cwd` is the folder `work note` reads the branch of.
pub(crate) async fn work_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    cwd: &str,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let home_target = Target::home(&home);
    let home_error = |e| did_not_answer("home", &e);
    let sub = match args.first().map(String::as_str) {
        Some("list" | "show" | "note" | "close" | "export") => args.remove(0),
        _ => "list".into(),
    };
    match sub.as_str() {
        "list" => {
            let repo = take(&mut args, "--repo");
            let state = take(&mut args, "--state");
            if state.as_deref().is_some_and(|s| !WORK_STATES.contains(&s)) || !args.is_empty() {
                return Err(WORK_USAGE.into());
            }
            let mut q: Vec<(&str, &str)> = Vec::new();
            if let Some(r) = &repo {
                q.push(("repo", r));
            }
            if let Some(s) = &state {
                q.push(("state", s));
            }
            let path = if q.is_empty() {
                "/api/work".to_string()
            } else {
                format!("/api/work?{}", form_query(&q))
            };
            let targets = listed_targets(ask, &home, given.is_some()).await;
            let mut any = false;
            for t in &targets {
                match ask.ask(t, "GET", &path, None).await {
                    Ok(info) => {
                        let items = list_at(&info, "items");
                        if items.is_empty() {
                            continue;
                        }
                        let backend = if targets.len() > 1 {
                            t.name.as_str()
                        } else {
                            ""
                        };
                        out.lines(list_lines(items, backend));
                        any = true;
                    }
                    Err(e) => out.line(skipped_line(&t.name, &e)),
                }
            }
            if !any {
                out.line("no work items");
            }
            Ok(())
        }
        "show" => {
            let id = one_id(&mut args)?;
            let path = format!("/api/work/one?id={}", encode_component(&id));
            let item = ask
                .ask(&home_target, "GET", &path, None)
                .await
                .map_err(home_error)?;
            out.lines(show_lines(&item));
            Ok(())
        }
        "note" => {
            let id = match args.first() {
                Some(first) if is_work_id(first) => Some(args.remove(0)),
                _ => work_id_of(current_branch(cwd).await.as_deref()),
            };
            let Some(id) = id else {
                return Err("no work id given, and this folder is not on a run/w-… branch".into());
            };
            let text = js_trim(&args.join(" ")).to_string();
            if text.is_empty() {
                return Err(WORK_USAGE.into());
            }
            ask.ask(
                &home_target,
                "POST",
                "/api/work/note",
                Some(&json!({ "id": id, "text": text })),
            )
            .await
            .map_err(home_error)?;
            out.line(format!("noted on {id}"));
            Ok(())
        }
        "close" => {
            let landed = has(&mut args, "--landed");
            let dropped = has(&mut args, "--dropped");
            let id = shift(&mut args);
            let reason_flag = args.iter().any(|a| a == "-m");
            let reason = take(&mut args, "-m");
            let id = match id {
                Some(id)
                    if landed != dropped
                        && is_work_id(&id)
                        && args.is_empty()
                        && !(reason_flag && reason.is_none()) =>
                {
                    id
                }
                _ => return Err(WORK_USAGE.into()),
            };
            let state = if landed { "landed" } else { "dropped" };
            let mut body = Map::new();
            body.insert("id".into(), json!(id));
            body.insert("state".into(), json!(state));
            if let Some(r) = reason {
                body.insert("reason".into(), json!(r));
            }
            ask.ask(
                &home_target,
                "POST",
                "/api/work/close",
                Some(&Value::Object(body)),
            )
            .await
            .map_err(home_error)?;
            out.line(format!("{id} closed as {state}"));
            Ok(())
        }
        _ => {
            let id = one_id(&mut args)?;
            // the markdown as the backend wrote it, with its own final newline
            let path = format!("/api/work/export?id={}", encode_component(&id));
            let markdown = ask
                .ask_text(&home_target, &path)
                .await
                .map_err(home_error)?;
            out.write(&markdown);
            Ok(())
        }
    }
}

/// The one work id `show` and `export` take, and nothing after it.
fn one_id(args: &mut Vec<String>) -> Result<String, String> {
    match shift(args) {
        Some(id) if is_work_id(&id) && args.is_empty() => Ok(id),
        _ => Err(WORK_USAGE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::AskError;
    use crate::ask::tests::Fake;
    use std::sync::Mutex;

    fn item() -> Value {
        json!({
            "id": "w-test2345", "title": "Add a test", "repos": ["dev-tools/canopy"], "state": "review",
            "from": {"kind": "note"}, "runs": ["r1", "fix1"], "branches": ["b1"],
            "prs": [{"number": 7, "url": "https://github.com/o/r/pull/7"}], "events": [],
            "notes": [
                {"at": 1_793_008_800_000_i64, "by": "canopy", "text": "branch ready, lands on its own"},
                {"at": 1_793_009_100_000_i64, "by": "canopy", "text": "PR #7 opened"},
            ],
            "createdAt": 1, "updatedAt": 2,
        })
    }

    #[test]
    fn list_lines_one_per_item() {
        assert_eq!(
            list_lines(&[item()], ""),
            ["w-test2345  review   dev-tools/canopy   Add a test  · canopy: PR #7 opened"]
        );
        let mut quiet = item();
        quiet["notes"] = json!([]);
        quiet["state"] = json!("open");
        assert_eq!(
            list_lines(&[quiet], "mini"),
            ["mini", "w-test2345  open     dev-tools/canopy   Add a test"]
        );
        assert!(list_lines(&[], "").is_empty());
    }

    #[test]
    fn show_lines_the_whole_item() {
        assert_eq!(
            show_lines(&item()),
            [
                "w-test2345  Add a test",
                "state: review   repos: dev-tools/canopy   from: a note",
                "branches: b1   runs: r1, fix1   PRs: #7 https://github.com/o/r/pull/7   events: none",
                "notes:",
                "  2026-10-26 10:00  canopy  branch ready, lands on its own",
                "  2026-10-26 10:05  canopy  PR #7 opened",
            ]
        );
        let mut bare = item();
        for k in ["notes", "prs", "runs", "branches"] {
            bare[k] = json!([]);
        }
        bare["from"] = json!({"kind": "trigger", "event": "e1"});
        assert_eq!(
            show_lines(&bare)[1..],
            [
                "state: review   repos: dev-tools/canopy   from: trigger event e1",
                "branches: none   runs: none   PRs: none   events: none",
                "notes:",
                "  (none yet)",
            ]
        );
    }

    #[tokio::test]
    async fn notes_closes_and_exports_go_to_home() {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{m} {p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
            Ok::<Value, AskError>(if p.starts_with("/api/work/export") {
                json!("# w-test2345\n")
            } else {
                item()
            })
        });
        let c = Caller::default();
        let run = |argv: &[&str]| argv.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut out = Out::default();
        work_cmd(
            run(&["note", "w-test2345", "looks", "good"]),
            &c,
            &fake,
            &mut out,
            "/",
        )
        .await
        .unwrap();
        work_cmd(
            run(&["close", "w-test2345", "--dropped", "-m", "no"]),
            &c,
            &fake,
            &mut out,
            "/",
        )
        .await
        .unwrap();
        work_cmd(run(&["export", "w-test2345"]), &c, &fake, &mut out, "/")
            .await
            .unwrap();
        assert_eq!(
            out.text,
            "noted on w-test2345\nw-test2345 closed as dropped\n# w-test2345\n"
        );
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "POST /api/work/note {\"id\":\"w-test2345\",\"text\":\"looks good\"}",
                "POST /api/work/close {\"id\":\"w-test2345\",\"state\":\"dropped\",\"reason\":\"no\"}",
                "GET /api/work/export?id=w-test2345 ",
            ]
        );
        let mut out = Out::default();
        seen.lock().unwrap().clear();
        work_cmd(run(&["show", "w-test2345"]), &c, &fake, &mut out, "/")
            .await
            .unwrap();
        assert_eq!(out.printed(), show_lines(&item()));
        assert_eq!(*seen.lock().unwrap(), ["GET /api/work/one?id=w-test2345 "]);
        for bad in [
            &["export", "nope"][..],
            &["close", "w-test2345"],
            &["close", "w-test2345", "--landed", "--dropped"],
            &["close", "-m", "why", "w-test2345", "--landed"],
            &["show", "nope"],
            &["list", "--state", "lost"],
        ] {
            let mut out = Out::default();
            assert_eq!(
                work_cmd(run(bad), &c, &fake, &mut out, "/")
                    .await
                    .unwrap_err(),
                WORK_USAGE,
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn list_asks_every_backend_with_its_filters() {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|t: &Target, _: &str, p: &str, _: Option<&Value>| {
            if p == "/api/backends" {
                return Ok::<Value, AskError>(
                    json!({"self": "home", "backends": [{"name": "mini", "tailnet": "http://mini"}]}),
                );
            }
            seen.lock().unwrap().push(format!("{} {p}", t.name));
            let mut it = item();
            if t.name == "mini" {
                it["id"] = json!("w-test2346");
                it["title"] = json!("Another item");
            }
            Ok(json!({"items": [it], "archived": 0}))
        });
        let mut out = Out::default();
        let argv = ["list", "--repo", "dev-tools/canopy", "--state", "review"];
        let args = argv.iter().map(|s| s.to_string()).collect();
        work_cmd(args, &Caller::default(), &fake, &mut out, "/")
            .await
            .unwrap();
        assert_eq!(
            out.printed(),
            [
                "home",
                "w-test2345  review   dev-tools/canopy   Add a test  · canopy: PR #7 opened",
                "mini",
                "w-test2346  review   dev-tools/canopy   Another item  · canopy: PR #7 opened",
            ]
        );
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "home /api/work?repo=dev-tools%2Fcanopy&state=review",
                "mini /api/work?repo=dev-tools%2Fcanopy&state=review",
            ]
        );
    }

    #[tokio::test]
    async fn note_reads_the_work_id_from_the_current_run_branch() {
        let dir = std::env::temp_dir().join(format!("canopy-work-cli-{}", std::process::id()));
        let d = dir.to_string_lossy().into_owned();
        let git = |a: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(a)
                .output()
                .is_ok_and(|o| o.status.success());
            assert!(ok, "git {a:?}");
        };
        git(&["init", "-q", "-b", "main", &d]);
        git(&["-C", &d, "checkout", "-q", "-b", "run/w-test2345-the-task"]);
        let bodies = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, _: &str, _: &str, b: Option<&Value>| {
            bodies.lock().unwrap().push(b.cloned().unwrap_or_default());
            Ok::<Value, AskError>(item())
        });
        let mut out = Out::default();
        let args = vec!["note".to_string(), "remember the setup".to_string()];
        let r = work_cmd(args, &Caller::default(), &fake, &mut out, &d).await;
        let _ = std::fs::remove_dir_all(&dir);
        r.unwrap();
        assert_eq!(
            *bodies.lock().unwrap(),
            [json!({"id": "w-test2345", "text": "remember the setup"})]
        );
        assert_eq!(out.printed(), ["noted on w-test2345"]);
    }
}
