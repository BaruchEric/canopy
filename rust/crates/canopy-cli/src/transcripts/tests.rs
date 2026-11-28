//! run-transcripts.test.ts's cases, with core's tests of `forkLine`
//! (handoff.test.ts), `runSubject` and `nameFailure` (runname.test.ts) and
//! `RUN_ID` (runlog.test.ts). Its Bun.serve backends are the fake in
//! run/tests.rs; the three askText cases run against loopback stubs on a
//! free port, as ask.rs's own tests do.

use super::*;
use crate::api::Caller;
use crate::ask::tests::{Stub, json_answer};
use crate::ask::{AskError, Client};
use crate::run::tests::{BACKEND, Got, argv, run_in, with_backend};

const NOW: f64 = 1_793_016_000_000.0; // Date.UTC(2026, 9, 26, 12)
const H: f64 = 3_600_000.0;
const STEP_1: f64 = 1_793_005_201_000.0; // Date.UTC(2026, 9, 26, 9, 0, 1)

fn head(over: Value) -> Value {
    let mut h = json!({
        "id": "ab12cd34", "repo": "dev-tools/canopy", "action": "build", "verb": "Build",
        "harness": "claude", "status": "done", "started": NOW - 3.0 * H, "ended": NOW - 2.0 * H,
        "cost": 0.42,
    });
    merge(&mut h, over);
    h
}

fn merge(into: &mut Value, over: Value) {
    if let (Some(m), Value::Object(o)) = (into.as_object_mut(), over) {
        for (k, v) in o {
            if v.is_null() && k.starts_with('-') {
                m.remove(&k[1..]);
            } else {
                m.insert(k, v);
            }
        }
    }
}

fn run() -> Value {
    json!({
        "id": "ab12cd34", "repoId": "dev-tools/canopy", "action": "build", "verb": "Build",
        "progress": "", "expectsChange": true, "chat": false, "harness": "claude", "note": "",
        "status": "done", "startedAt": NOW - 3.0 * H, "endedAt": NOW - 2.0 * H,
        "steps": [
            {"id": "1", "at": STEP_1, "kind": "text", "text": "Looking."},
            {"id": "2", "at": STEP_1 + 1000.0, "kind": "tool", "tool": {"name": "Bash", "title": "git status", "status": "ok"}},
            {"id": "3", "at": STEP_1 + 2000.0, "kind": "text", "text": "Found.", "parent": "2"},
        ],
        "prompt": null,
        "result": {"text": "ok", "costUsd": 0.42, "durationMs": H, "turns": 1},
        "kept": true,
    })
}

/// `run` with fields changed; a key "-x" with a null value drops x, as
/// the TS's spreads of `undefined` leave a field out.
fn run_with(over: Value) -> Value {
    let mut r = run();
    merge(&mut r, over);
    r
}

#[test]
fn replay_lines_shows_the_head_where_the_steps_came_from_and_the_replays_steps() {
    let steps = json!([
        {"id": "w1", "at": STEP_1, "kind": "tool", "tool": {"name": "Bash", "title": "git push", "status": "ok"}},
        {"id": "ask1", "at": STEP_1 + 1000.0, "kind": "note", "text": "asked: git push"},
    ]);
    let lines = replay_lines(
        &run_with(json!({"steps": []})),
        &json!({"source": "wire", "steps": steps, "asks": ["ask1"], "cut": true}),
        NOW,
    );
    assert_eq!(
        lines[..2],
        ["Build in dev-tools/canopy (kept)", "run: ab12cd34"]
    );
    assert_eq!(
        lines[lines.len() - 4..],
        [
            "steps: rebuilt from the wire, without canopy's own notes",
            "the wire was cut at its size limit, so the steps stop short",
            "  09:00:01  tool  Bash: git push (ok)",
            "  09:00:02  note  asked: git push",
        ]
    );
    let r = run();
    let shown = show_lines(&r, NOW);
    let n = list_at(&r, "steps").len();
    let mut want: Vec<String> = shown[..shown.len() - n].to_vec();
    want.push("steps: the record's, with the prompts its wire shows".into());
    want.extend(shown[shown.len() - n..].iter().cloned());
    assert_eq!(
        replay_lines(
            &r,
            &json!({"source": "record", "steps": r["steps"], "asks": [], "cut": false}),
            NOW
        ),
        want
    );
}

#[test]
fn kept_lines_sorts_newest_first_and_formats_the_age_repo_status_and_cost() {
    assert_eq!(
        kept_lines(
            &[
                head(
                    json!({"id": "older", "ended": NOW - 50.0 * H, "cost": null, "status": "failed"})
                ),
                head(json!({})),
            ],
            NOW
        ),
        [
            "ab12cd34  2h   dev-tools/canopy          Build  done    $0.42",
            "older     2d   dev-tools/canopy          Build  failed  -",
        ]
    );
}

#[test]
fn show_lines_prints_the_run_head_and_indents_a_subagents_timeline_step() {
    let lines = show_lines(&run(), NOW);
    assert_eq!(
        lines[..2],
        ["Build in dev-tools/canopy (kept)", "run: ab12cd34"]
    );
    assert_eq!(
        lines[lines.len() - 3..],
        [
            "  09:00:01  text  Looking.",
            "  09:00:02  tool  Bash: git status (ok)",
            "    09:00:03  text  Found.",
        ]
    );
    // the whole head, as the TypeScript printed it
    assert_eq!(
        lines[..lines.len() - 3],
        [
            "Build in dev-tools/canopy (kept)",
            "run: ab12cd34",
            "action: build",
            "agent: Claude Code, model unknown",
            "when: 2026-10-26T09:00:00.000Z to 2026-10-26T10:00:00.000Z, 60:00",
            "status: done",
            "cost: $0.42",
        ]
    );
}

#[tokio::test]
async fn ask_text_retries_a_sign_in_gate_and_returns_the_next_backends_text_unchanged() {
    let gate = Stub::start(|_| json_answer(401, json!({"error": "sign in"}))).await;
    let export_text = "# Build\n\nredacted: <redacted:CANOPY_TOKEN>\n";
    let backend = Stub::start(move |_| {
        (
            200,
            vec![("content-type".into(), "text/markdown".into())],
            export_text.into(),
        )
    })
    .await;
    let c = Client::new(Caller {
        config_dir: "/nonexistent/canopy-cli-test".into(),
        ..Default::default()
    });
    let t = Target {
        name: "home".into(),
        urls: vec![gate.url.clone(), backend.url.clone()],
    };
    assert_eq!(c.ask_text(&t, "/export").await.unwrap(), export_text);
    assert_eq!(backend.paths().len(), 1);
}

#[tokio::test]
async fn ask_text_keeps_canopys_json_need_refusal_on_401_and_403() {
    for status in [401, 403] {
        let refused = Stub::start(move |_| json_answer(status, json!({"need": "run"}))).await;
        let fallback = Stub::start(|_| (200, vec![], "unexpected".into())).await;
        let c = Client::new(Caller::default());
        let t = Target {
            name: "home".into(),
            urls: vec![refused.url.clone(), fallback.url.clone()],
        };
        assert_eq!(
            c.ask_text(&t, "/export").await.unwrap_err().message(),
            "home refused: it needs the run right"
        );
        assert!(fallback.paths().is_empty());
    }
}

#[tokio::test]
async fn ask_text_surfaces_a_text_error_body() {
    let server = Stub::start(|_| (503, vec![], "transcript is unavailable".into())).await;
    let c = Client::new(Caller::default());
    assert_eq!(
        c.ask_text(&Target::home(&server.url), "/export")
            .await
            .unwrap_err()
            .message(),
        "transcript is unavailable"
    );
}

/// A scratch folder for an export, removed on drop.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("canopy-run-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Scratch(p)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn run_command_lists_shows_exports_verbatim_writes_an_export_and_prunes() {
    let export_text = "# Build in canopy\n\nsecret <redacted:CANOPY_TOKEN>\n";
    let answer = |m: &str, p: &str, _: Option<&Value>| match (m, p) {
        ("GET", "/api/runs?kept=1") => Ok(json!([head(json!({}))])),
        ("GET", "/api/runs/ab12cd34") => Ok(run()),
        ("GET", "/api/runs/ab12cd34/replay") => {
            Ok(json!({"source": "record", "steps": run()["steps"], "asks": [], "cut": false}))
        }
        ("GET", "/api/runs/ab12cd34/export") => Ok(json!(export_text)),
        ("POST", "/api/runs/prune") => Ok(json!({"removed": ["old1", "old2"], "kept": 1})),
        _ => Err(AskError::Refused {
            message: "unexpected route".into(),
            status: 404,
        }),
    };
    let dir = Scratch::new("export");
    let cwd = dir.path();
    let go = |a: &[&str]| run_in(with_backend(a), &cwd, NOW, answer);
    let listed = go(&[]).await;
    assert_eq!(
        listed.lines,
        [kept_lines(&[head(json!({}))], NOW)[0].clone()]
    );
    let shown = go(&["show", "ab12cd34"]).await;
    assert_eq!(
        shown.lines[..2],
        ["Build in dev-tools/canopy (kept)", "run: ab12cd34"]
    );
    let wired = go(&["show", "ab12cd34", "--wire"]).await;
    assert!(
        wired
            .lines
            .contains(&"steps: the record's, with the prompts its wire shows".to_string())
    );
    let exported = go(&["export", "ab12cd34"]).await;
    assert_eq!(exported.text, export_text);
    let written = go(&["export", "ab12cd34", "--out", "run.md"]).await;
    assert_eq!(
        std::fs::read_to_string(dir.0.join("run.md")).unwrap(),
        export_text
    );
    assert_eq!(written.lines, ["wrote run.md"]);
    let pruned = go(&["prune"]).await;
    assert_eq!(pruned.lines, ["removed 2 transcripts, 1 kept"]);
    let routes: Vec<String> = [listed, shown, wired, exported, written, pruned]
        .iter()
        .flat_map(|g| g.seen.iter().map(|(m, p, _)| format!("{m} {p}")))
        .collect();
    assert_eq!(
        routes,
        [
            "GET /api/runs?kept=1",
            "GET /api/runs/ab12cd34",
            "GET /api/runs/ab12cd34",
            "GET /api/runs/ab12cd34/replay",
            "GET /api/runs/ab12cd34/export",
            "GET /api/runs/ab12cd34/export",
            "POST /api/runs/prune",
        ]
    );
    // a folder that is not there, in Node's words
    let failed = go(&["export", "ab12cd34", "--out", "nodir/run.md"]).await;
    assert_eq!(
        failed.failed(),
        Some("ENOENT: no such file or directory, open 'nodir/run.md'")
    );
    let failed = go(&["export", "ab12cd34", "--out", "."]).await;
    assert_eq!(
        failed.failed(),
        Some("EISDIR: illegal operation on a directory, open '.'")
    );
}

#[tokio::test]
async fn run_command_forks_a_run_at_a_step_with_a_profile_and_a_note_and_says_how_it_forked_fr_043_plan_3()
 {
    let answer = |m: &str, p: &str, b: Option<&Value>| {
        if m != "POST" || p != "/api/runs/fork" {
            return Err(AskError::Refused {
                message: "unexpected route".into(),
                status: 404,
            });
        }
        let at = b.and_then(|b| num_at(b, "step")).unwrap_or(3.0);
        let mut fork =
            json!({"run": "ab12cd34", "at": at, "how": if at < 3.0 { "cut" } else { "whole" }});
        if at < 3.0 {
            fork["step"] = json!(number_string(at));
        }
        Ok(run_with(
            json!({"id": "ef56ab78", "status": "working", "-kept": null, "forkOf": fork}),
        ))
    };
    let go = |a: &[&str]| run_in(with_backend(a), "/", NOW, answer);
    let one = go(&[
        "fork",
        "ab12cd34",
        "--at",
        "2",
        "--profile",
        "deep",
        "-m",
        "try grep",
    ])
    .await;
    let two = go(&["fork", "ab12cd34"]).await;
    assert_eq!(
        [&one, &two].map(|g| g.seen[0].2.clone()),
        [
            Some(json!({"run": "ab12cd34", "step": 2, "profile": "deep", "note": "try grep"})),
            Some(json!({"run": "ab12cd34"}))
        ]
    );
    assert_eq!(
        [one.lines, two.lines].concat(),
        [
            "ef56ab78 working",
            "forked from run ab12cd34 at step 2, the transcript cut there and resumed",
            "ef56ab78 working",
            "forked from run ab12cd34 at its end (3 steps), the whole session resumed, the cut said in words",
        ]
    );
    for (a, why) in [
        (
            with_backend(&["fork", "ab12cd34", "--at", "zero"]),
            "--at needs a step's number, from 1, as canopy run show --wire counts them",
        ),
        (
            with_backend(&["fork", "ab12cd34", "--profile"]),
            "--profile needs a profile's name",
        ),
        (with_backend(&["fork", "ab12cd34", "extra"]), RUN_USAGE),
        (with_backend(&["fork", "x/y"]), "invalid run id: x/y"),
        (argv(&["fork"]), RUN_USAGE),
    ] {
        let g = run_in(a.clone(), "/", NOW, answer).await;
        assert_eq!(g.result, Err(why.into()), "{a:?}");
        assert!(g.seen.is_empty(), "{a:?} asked the backend");
    }
}

#[tokio::test]
async fn run_command_says_when_there_are_no_kept_runs() {
    let got = run_in(with_backend(&[]), "/", NOW, |_, _, _| Ok(json!([]))).await;
    assert_eq!(got.lines, ["no kept runs"]);
}

#[tokio::test]
async fn run_command_uses_the_shared_usage_for_an_incomplete_transcript_form() {
    let got = run_in(argv(&["show"]), "/", NOW, |_, _, _| Ok(json!({}))).await;
    assert_eq!(got.failed(), Some(RUN_USAGE));
}

#[tokio::test]
async fn transcript_ids_fail_locally_before_any_http_read() {
    let long = "a".repeat(65);
    for sub in ["show", "export"] {
        for id in [".", "..", "x/y", "x?query", long.as_str()] {
            let got = run_in(with_backend(&[sub, id]), "/", NOW, |_, _, _| Ok(json!({}))).await;
            assert_eq!(got.failed(), Some(format!("invalid run id: {id}").as_str()));
            assert!(got.seen.is_empty());
        }
    }
}

#[tokio::test]
async fn missing_or_flag_like_output_filenames_fail_locally_before_any_http_read() {
    for filename in [None, Some(""), Some("--bad")] {
        let mut a = with_backend(&["export", "ab12cd34", "--out"]);
        a.extend(filename.map(String::from));
        let got = run_in(a, "/", NOW, |_, _, _| Ok(json!("export"))).await;
        assert_eq!(got.failed(), Some("--out needs a file"));
        assert!(got.seen.is_empty());
    }
}

#[tokio::test]
async fn run_command_says_words_into_a_live_run_and_interrupts_its_turn_the_servers_refusal_its_own_fr_066()
 {
    let answer = |_: &str, p: &str, b: Option<&Value>| {
        let has_text = b.is_some_and(|b| b.get("text").is_some());
        if p == "/api/runs/interrupt" && !has_text {
            return Err(AskError::Refused {
                message: "a job stops its turn only for a message to go on with; stop ends the run"
                    .into(),
                status: 409,
            });
        }
        if p == "/api/runs/say" || p == "/api/runs/interrupt" {
            return Ok(run_with(json!({"-kept": null, "status": "working"})));
        }
        Err(AskError::Refused {
            message: "unexpected route".into(),
            status: 404,
        })
    };
    let go = |a: &[&str]| run_in(with_backend(a), "/", NOW, answer);
    let said = go(&["say", "ab12cd34", "use", "bun", "here"]).await;
    let stopped = go(&["interrupt", "ab12cd34", "do", "this", "instead"]).await;
    let bare = go(&["interrupt", "ab12cd34"]).await;
    assert!(
        bare.failed()
            .is_some_and(|f| f.starts_with("a job stops its turn only for a message"))
    );
    let calls: Vec<(String, Option<Value>)> = [&said, &stopped, &bare]
        .iter()
        .flat_map(|g| g.seen.iter().map(|(_, p, b)| (p.clone(), b.clone())))
        .collect();
    assert_eq!(
        calls,
        [
            (
                "/api/runs/say".to_string(),
                Some(json!({"id": "ab12cd34", "text": "use bun here"}))
            ),
            (
                "/api/runs/interrupt".to_string(),
                Some(json!({"id": "ab12cd34", "text": "do this instead"}))
            ),
            (
                "/api/runs/interrupt".to_string(),
                Some(json!({"id": "ab12cd34"}))
            ),
        ]
    );
    assert_eq!(
        [said.lines, stopped.lines].concat(),
        ["ab12cd34 working", "ab12cd34 working"]
    );
    let words = go(&["say", "ab12cd34"]).await;
    assert_eq!(
        words.failed(),
        Some("canopy run say needs the words to send")
    );
    let bad = go(&["say", "x/y", "hi"]).await;
    assert_eq!(bad.failed(), Some("invalid run id: x/y"));
    assert!(words.seen.is_empty() && bad.seen.is_empty());
}

/// A run still going: `run` with no kept, end or result, and no steps.
fn live(over: Value) -> Value {
    let mut r = run_with(
        json!({"-kept": null, "-endedAt": null, "-result": null, "steps": [], "status": "working"}),
    );
    merge(&mut r, over);
    r
}

#[test]
fn live_lines_lists_the_runs_still_going_oldest_first_each_with_its_name_fr_073() {
    assert_eq!(
        live_lines(
            &[
                live(
                    json!({"id": "22222222", "status": "idle", "chat": true, "verb": "chat", "name": "peer sync", "startedAt": NOW - 2.0 * H})
                ),
                live(
                    json!({"id": "11111111", "verb": "ask", "note": "look at the build\nand more", "startedAt": NOW - 5.0 * H})
                ),
                live(
                    json!({"id": "33333333", "verb": "propose", "name": "top bar", "startedAt": NOW - H, "branch": {"name": "run/top-bar", "target": "main", "base": "b", "dir": "/w", "origin": "o", "state": "working"}})
                ),
                live(json!({"id": "44444444", "status": "done"})),
                live(
                    json!({"id": "55555555", "verb": "chat", "chat": true, "status": "idle", "startedAt": NOW})
                ),
            ],
            NOW
        ),
        [
            "11111111  5h   dev-tools/canopy          working  ask  look at the build",
            "22222222  2h   dev-tools/canopy          idle     chat  peer sync",
            "33333333  1h   dev-tools/canopy          working  propose on run/top-bar  top bar",
            "55555555  0m   dev-tools/canopy          idle     chat",
        ]
    );
}

#[test]
fn a_kept_runs_line_and_head_carry_its_name() {
    assert!(
        kept_lines(&[head(json!({"name": "peer sync"}))], NOW)[0].ends_with("$0.42  peer sync")
    );
    assert_eq!(
        show_lines(&run_with(json!({"name": "peer sync"})), NOW)[..3],
        [
            "Build in dev-tools/canopy (kept)",
            "run: ab12cd34",
            "name: peer sync"
        ]
    );
}

#[tokio::test]
async fn run_command_lists_names_and_stops_live_runs_fr_073() {
    let going = run_with(
        json!({"-kept": null, "-endedAt": null, "status": "working", "name": "slow build"}),
    );
    let answer = |m: &str, p: &str, b: Option<&Value>| {
        if m == "GET" && p == "/api/runs" {
            let mut done = going.clone();
            merge(&mut done, json!({"id": "ffffffff", "status": "done"}));
            return Ok(json!([going.clone(), done]));
        }
        let body = b.cloned().unwrap_or(Value::Null);
        let id = str_at(&body, "id").unwrap_or("");
        // "eeeeeeee" stands for a backend from before run names: the route is not there
        if p == "/api/runs/name" && id == "eeeeeeee" {
            return Err(AskError::Refused {
                message: "not found".into(),
                status: 404,
            });
        }
        if p == "/api/runs/name" {
            if id == "00000000" {
                return Err(AskError::Refused {
                    message: "no such run".into(),
                    status: 404,
                });
            }
            let mut named = going.clone();
            named["name"] = body["name"].clone();
            return Ok(named);
        }
        if p == "/api/runs/stop" {
            let mut stopped = going.clone();
            stopped["status"] = json!("stopped");
            return Ok(stopped);
        }
        Err(AskError::Refused {
            message: "unexpected route".into(),
            status: 404,
        })
    };
    let go = |a: &[&str]| run_in(with_backend(a), "/", NOW, answer);
    let listed = go(&["ls"]).await;
    assert_eq!(listed.lines, live_lines(std::slice::from_ref(&going), NOW));
    assert!(listed.lines[0].ends_with("Build  slow build"));
    let named = go(&["name", "ab12cd34", "the", "landing", "queue"]).await;
    let stopped = go(&["stop", "ab12cd34"]).await;
    assert_eq!(
        [&named, &stopped].map(|g| (g.seen[0].1.clone(), g.seen[0].2.clone())),
        [
            (
                "/api/runs/name".to_string(),
                Some(json!({"id": "ab12cd34", "name": "the landing queue"}))
            ),
            (
                "/api/runs/stop".to_string(),
                Some(json!({"id": "ab12cd34"}))
            ),
        ]
    );
    assert_eq!(
        [named.lines, stopped.lines].concat(),
        ["ab12cd34 the landing queue", "ab12cd34 stopped"]
    );
    assert_eq!(
        go(&["name", "00000000", "x"]).await.failed(),
        Some("no such run")
    );
    assert_eq!(
        go(&["name", "eeeeeeee", "x"]).await.failed(),
        Some(
            "this backend runs a canopy from before run names; deploy the current one to it and try again"
        )
    );
    assert_eq!(
        go(&["name", "ab12cd34"]).await.failed(),
        Some("canopy run name needs the name to give it")
    );
    assert_eq!(
        go(&["name", "x/y", "hi"]).await.failed(),
        Some("invalid run id: x/y")
    );
    assert_eq!(
        go(&["stop", "ab12cd34", "extra"]).await.failed(),
        Some(RUN_USAGE)
    );
    assert_eq!(go(&["ls", "extra"]).await.failed(), Some(RUN_USAGE));
}

#[tokio::test]
async fn run_command_asks_a_side_question_beside_a_run_and_sets_its_model_fr_077() {
    let side = run_with(json!({
        "id": "5ide0001", "-kept": null, "-endedAt": null, "action": "chat", "verb": "chat",
        "chat": true, "status": "working", "sideOf": {"run": "ab12cd34", "title": "slow build"},
        "agentSettings": {"harness": "claude", "model": "default", "effort": "default"},
    }));
    let answer = |_: &str, p: &str, b: Option<&Value>| {
        let body = b.cloned().unwrap_or(Value::Null);
        let id = str_at(&body, "id").unwrap_or("");
        // "eeeeeeee" stands for a backend from before side questions: the route is not there
        if id == "eeeeeeee" {
            return Err(AskError::Refused {
                message: "not found".into(),
                status: 404,
            });
        }
        if p == "/api/runs/side" {
            if id == "00000000" {
                return Err(AskError::Refused {
                    message: "the run has no session to fork yet: ask once it has begun".into(),
                    status: 409,
                });
            }
            return Ok(side.clone());
        }
        if p == "/api/runs/model" {
            let mut s = side.clone();
            s["agentSettings"]["model"] = body["model"].clone();
            return Ok(s);
        }
        Err(AskError::Refused {
            message: "unexpected route".into(),
            status: 404,
        })
    };
    let go = |a: &[&str]| run_in(with_backend(a), "/", NOW, answer);
    let asked = go(&[
        "side",
        "ab12cd34",
        "what",
        "does",
        "retryBackoff",
        "default",
        "to?",
    ])
    .await;
    let port = go(&["side", "ab12cd34", "and the port?", "--model", "haiku"]).await;
    // the flag may sit among the words
    let host = go(&[
        "side", "ab12cd34", "--model", "haiku", "and", "the", "host?",
    ])
    .await;
    let model = go(&["model", "5ide0001", "sonnet"]).await;
    let calls: Vec<(String, Option<Value>)> = [&asked, &port, &host, &model]
        .iter()
        .flat_map(|g| g.seen.iter().map(|(_, p, b)| (p.clone(), b.clone())))
        .collect();
    assert_eq!(
        calls,
        [
            (
                "/api/runs/side".to_string(),
                Some(json!({"id": "ab12cd34", "text": "what does retryBackoff default to?"}))
            ),
            (
                "/api/runs/side".to_string(),
                Some(json!({"id": "ab12cd34", "text": "and the port?", "model": "haiku"}))
            ),
            (
                "/api/runs/side".to_string(),
                Some(json!({"id": "ab12cd34", "text": "and the host?", "model": "haiku"}))
            ),
            (
                "/api/runs/model".to_string(),
                Some(json!({"id": "5ide0001", "model": "sonnet"}))
            ),
        ]
    );
    assert_eq!(
        asked.lines,
        [
            "5ide0001 working",
            "a side question beside run ab12cd34, which works on; read it with canopy run show 5ide0001, go on with canopy run say 5ide0001 <words…>",
        ]
    );
    assert_eq!(model.lines, ["5ide0001 sonnet"]);
    let failed = |g: Got| g.result.unwrap_err();
    assert!(failed(go(&["side", "00000000", "hi"]).await).contains("no session to fork yet"));
    assert_eq!(
        failed(go(&["side", "eeeeeeee", "hi"]).await),
        "this backend runs a canopy from before side questions; deploy the current one to it and try again"
    );
    assert!(
        failed(go(&["model", "eeeeeeee", "sonnet"]).await)
            .contains("runs a canopy from before side questions")
    );
    let quiet = [
        (
            &["side", "ab12cd34"][..],
            "canopy run side needs the question to ask",
        ),
        (&["side", "x/y", "hi"][..], "invalid run id: x/y"),
        (
            &["side", "ab12cd34", "hi", "--model"][..],
            "--model needs a model's name",
        ),
        (&["model", "5ide0001"][..], RUN_USAGE),
        (&["model", "5ide0001", "sonnet", "extra"][..], RUN_USAGE),
    ];
    for (a, why) in quiet {
        let g = go(a).await;
        assert_eq!(g.failed(), Some(why), "{a:?}");
        assert!(g.seen.is_empty(), "{a:?} asked the backend");
    }
}

#[test]
fn a_side_questions_lines_say_which_run_it_sits_beside() {
    let side = run_with(json!({
        "id": "5ide0001", "action": "chat", "verb": "chat", "chat": true, "status": "idle",
        "name": "retry default", "startedAt": NOW - H, "sideOf": {"run": "ab12cd34", "title": "slow build"},
    }));
    let mut going = side.clone();
    merge(
        &mut going,
        json!({"-kept": null, "-endedAt": null, "-result": null}),
    );
    assert_eq!(
        live_lines(&[going], NOW),
        ["5ide0001  1h   dev-tools/canopy          idle     chat beside ab12cd34  retry default"]
    );
    assert_eq!(
        show_lines(&side, NOW)[..4],
        [
            "chat in dev-tools/canopy (kept)",
            "run: 5ide0001",
            "name: retry default",
            "side question of: ab12cd34 (slow build)"
        ]
    );
}

#[test]
fn fork_line() {
    assert_eq!(
        super::fork_line(&json!({"run": "3f2a", "step": "s41", "at": 41, "how": "cut"})),
        "forked from run 3f2a at step 41, the transcript cut there and resumed"
    );
    assert_eq!(
        super::fork_line(&json!({"run": "3f2a", "at": 12, "how": "brief"})),
        "forked from run 3f2a at its end (12 steps), a brief of the steps to there"
    );
    assert!(
        super::fork_line(&json!({"run": "3f2a", "step": "s1", "at": 1, "how": "whole"}))
            .contains("the whole session resumed")
    );
    assert_eq!(
        super::fork_line(&json!({"run": "3f2a", "at": 1, "how": "whole"})),
        "forked from run 3f2a at its end (1 step), the whole session resumed, the cut said in words"
    );
}

#[test]
fn a_run_goes_by_its_name_else_its_notes_first_line_else_its_verb() {
    // runTitle waits on the runs port; runSubject's half
    assert_eq!(
        run_subject(&json!({"name": "peer sync", "note": "x"})),
        "peer sync"
    );
    assert_eq!(run_subject(&json!({"note": ""})), "");
    assert_eq!(
        run_subject(&json!({"note": "  look at peers \nand more"})),
        "look at peers"
    );
}

#[test]
fn an_older_backends_bare_404_on_a_rename_says_what_it_means_any_other_message_stays() {
    assert_eq!(
        name_failure("not found"),
        "this backend runs a canopy from before run names; deploy the current one to it and try again"
    );
    assert_eq!(
        name_failure("unknown run: ab12cd34"),
        "unknown run: ab12cd34"
    );
    assert_eq!(name_failure("the run has ended"), "the run has ended");
}

#[test]
fn invalid_ids_are_refused_before_paths_and_torn_or_structurally_invalid_snapshots_read_null() {
    // the snapshot reads wait on the run log's port; RUN_ID's half
    let long = "a".repeat(65);
    for id in ["../escape", "a/b", "a b", "", long.as_str()] {
        assert!(!is_run_id(id), "{id}");
    }
    for id in ["ab12cd34", "A-b_9", &"a".repeat(64)] {
        assert!(is_run_id(id), "{id}");
    }
}

#[test]
fn a_live_head_runs_to_now_and_counts_tokens_when_there_is_no_cost() {
    let r = live(json!({
        "harness": "codex", "name": "", "note": "fix it",
        "result": {"text": "", "durationMs": 1, "turns": 1, "model": "gpt-5", "tokens": {"input": 1, "cachedInput": 0, "output": 1, "reasoning": 0, "total": 1234567}},
        "branch": {"name": "run/fix", "target": "main", "base": "b", "dir": "/w", "origin": "o", "state": "working"},
    }));
    assert_eq!(
        show_lines(&r, NOW - 3.0 * H + 61_500.0),
        [
            "Build in dev-tools/canopy (live)",
            "run: ab12cd34",
            "action: build",
            "agent: Codex, model gpt-5",
            "when: 2026-10-26T09:00:00.000Z to now, 1:01",
            "status: working",
            "cost: 1,234,567 tokens",
            "note: fix it",
            "branch: run/fix onto main, working",
        ]
    );
    // a note that is not there prints as undefined, as the template does
    let bare = live(json!({"-note": null, "harness": "antigravity"}));
    let lines = show_lines(&bare, NOW);
    assert!(lines.contains(&"note: undefined".to_string()));
    assert!(lines.contains(&"agent: Antigravity, model unknown".to_string()));
    assert!(lines.contains(&"cost: unknown".to_string()));
}

#[tokio::test]
async fn the_bare_listing_and_ls_say_none_and_a_backend_that_did_not_answer_is_named() {
    let got = run_in(with_backend(&["ls"]), "/", NOW, |_, _, _| Ok(json!([]))).await;
    assert_eq!(got.lines, ["no runs going"]);
    let got = run_in(with_backend(&[]), "/", NOW, |_, _, _| {
        Err(AskError::Unreachable(format!("{BACKEND}: refused")))
    })
    .await;
    assert_eq!(
        got.failed(),
        Some(format!("home did not answer: {BACKEND}: refused").as_str())
    );
    for (a, why) in [
        (argv(&["--backend"]), "--backend needs a value".to_string()),
        (
            argv(&["show", "x", "--backend", "http://x/y"]),
            "--backend must be an http(s) origin, got http://x/y".into(),
        ),
        (with_backend(&["show", "x", "--out", "f"]), RUN_USAGE.into()),
        (with_backend(&["prune", "x"]), RUN_USAGE.into()),
        // --out takes no value for the dispatch, so f is the first word:
        // a start of repo --out
        (
            with_backend(&["--out", "f"]),
            "unknown run action: f".into(),
        ),
        (with_backend(&["--wire"]), RUN_USAGE.into()),
        (
            with_backend(&["say", "x", "hi", "--out", "f"]),
            RUN_USAGE.into(),
        ),
        (
            with_backend(&["show", "x", "--on", "mini"]),
            RUN_USAGE.into(),
        ),
    ] {
        let g = run_in(a.clone(), "/", NOW, |_, _, _| Ok(json!({}))).await;
        assert_eq!(g.failed(), Some(why.as_str()), "{a:?}");
        assert!(g.seen.is_empty(), "{a:?} asked the backend");
    }
}
