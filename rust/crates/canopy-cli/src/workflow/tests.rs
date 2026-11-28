//! workflow.test.ts's cases: the show lines with and without the repo's
//! modes, DOT, the list, the check lines, and the command against a fake
//! backend.

use super::*;
use crate::ask::AskError;
use crate::ask::tests::Fake;
use canopy_core::flowgraph::{ModesRead, workflow_graph};
use serde_json::json;
use std::sync::Mutex;

const FAN_TEXT: &str = "---
blurb: b
---

## Build
tools: git-commit

build

## Lint
after: Build
tools: read
gate: verdict

lint

## Docs
after: Build
tools: read
check: bun test
retries: 1
back: Build

docs

## Ship
after: Lint, Docs
when: verdict done, check pass
mode: manual

ship
";

fn meta(name: &str, source: &str, file: &str) -> WorkflowMeta {
    WorkflowMeta {
        name: name.into(),
        source: source.into(),
        file: file.into(),
    }
}

fn fan() -> Value {
    let e = parse_workflow(FAN_TEXT, &meta("fan", "user", "/c/workflows/fan.md"));
    assert_eq!(e["ok"], true, "{}", e["error"]);
    e["workflow"].clone()
}

fn modes(m: Value) -> ModesRead {
    ModesRead::Ok(m)
}

#[test]
fn show_lines_a_line_per_step_indented_by_depth_with_what_it_waits_for_when_mode_and_gate() {
    assert_eq!(
        show_lines(&fan(), None),
        [
            "fan  user  /c/workflows/fan.md",
            "Build",
            "  Lint    after Build · gate verdict",
            "  Docs    after Build · check bun test · retries 1, back Build",
            "    Ship  after Lint, Docs · when verdict done, check pass · manual",
        ]
    );
}

#[test]
fn show_lines_the_repos_modes_are_marked_repo_with_its_warnings_and_a_broken_files_refusal() {
    let wf = fan();
    let graph = workflow_graph(
        &wf,
        &modes(json!({"fan": {"Ship": "auto", "Gone": "manual"}, "*": {"Build": "manual"}})),
    );
    let lines = show_lines(&wf, Some(&graph));
    assert_eq!(lines[1], "Build     manual (repo)");
    assert_eq!(
        lines[4],
        "    Ship  after Lint, Docs · when verdict done, check pass · auto (repo)"
    );
    assert_eq!(
        lines[5],
        "warning: .canopy/workflows.json: modes.fan.Gone names no step of fan"
    );
    let broken = workflow_graph(
        &wf,
        &ModesRead::Bad(".canopy/workflows.json must be an object".into()),
    );
    assert_eq!(
        show_lines(&wf, Some(&broken)).last().unwrap(),
        "modes: .canopy/workflows.json must be an object; a flow of fan is refused until it is fixed"
    );
}

#[test]
fn dot_text_a_box_per_step_after_as_arrows_with_the_condition_back_dashed() {
    let wf = fan();
    let graph = workflow_graph(&wf, &modes(json!({"*": {"Build": "manual"}})));
    assert_eq!(
        dot_text(&wf, Some(&graph)),
        [
            "digraph \"fan\" {",
            "  rankdir=LR;",
            "  node [shape=box];",
            "  \"Build\" [label=\"Build\\nmanual (repo)\", style=bold];",
            "  \"Lint\" [label=\"Lint\\ngate verdict\"];",
            "  \"Docs\";",
            "  \"Ship\" [label=\"Ship\\nmanual\", style=bold];",
            "  \"Build\" -> \"Lint\";",
            "  \"Build\" -> \"Docs\";",
            "  \"Lint\" -> \"Ship\" [label=\"when verdict done, check pass\"];",
            "  \"Docs\" -> \"Ship\" [label=\"when verdict done, check pass\"];",
            "  \"Docs\" -> \"Build\" [style=dashed, label=\"back\"];",
            "}",
        ]
        .join("\n")
    );
    let odd = parse_workflow(
        "---\nblurb: b\n---\n\n## Say \"hi\" \\ go\n\nx\n",
        &meta("odd", "user", "/odd.md"),
    );
    assert_eq!(odd["ok"], true);
    assert!(dot_text(&odd["workflow"], None).contains("  \"Say \\\"hi\\\" \\\\ go\";"));
}

#[test]
fn list_lines_source_and_shape_the_repos_say_problems_under_the_entry_a_broken_file_once() {
    let wf = fan();
    let chain = parse_workflow(
        "---\nblurb: b\n---\n\n## One\n\none\n",
        &meta("one", "bundled", "/one.md"),
    );
    assert_eq!(chain["ok"], true);
    let graph = workflow_graph(
        &wf,
        &modes(json!({"fan": {"Build": "manual", "Gone": "auto"}})),
    );
    let entries = [
        json!({"ok": true, "workflow": chain["workflow"]}),
        json!({"ok": true, "workflow": wf, "graph": graph}),
        json!({"ok": false, "name": "bad", "source": "repo", "file": "/r/.canopy/workflows/bad.md", "error": "step Fix: after names no step called Nope"}),
    ];
    assert_eq!(
        list_lines("workflows for app", &entries),
        [
            "workflows for app",
            "  one  bundled  1 step",
            "  fan  user     4 steps as a graph, Ship manual, Build manual (repo)",
            "                warning: .canopy/workflows.json: modes.fan.Gone names no step of fan",
            "  bad  repo     does not parse: step Fix: after names no step called Nope",
        ]
    );
    let held = [
        json!({"ok": true, "workflow": wf, "graph": workflow_graph(&wf, &ModesRead::Bad("x is not JSON".into()))}),
    ];
    assert_eq!(
        list_lines("workflows for app", &held).last().unwrap(),
        "modes: x is not JSON; every flow on this repo is refused until it is fixed"
    );
    assert_eq!(
        list_lines("workflows for app", &[]),
        ["workflows for app: no workflows"]
    );
}

#[test]
fn check_lines_the_steps_when_it_parses_the_error_when_it_does_not() {
    let (ok, lines) = check_lines(&parse_workflow(FAN_TEXT, &meta("fan", "user", "/fan.md")));
    assert!(ok);
    assert_eq!(lines[0], "/fan.md: ok, 4 steps");
    assert_eq!(lines[1], "Build");
    let bad = check_lines(&parse_workflow(
        &FAN_TEXT.replace("after: Lint, Docs", "after: Lint, Nope"),
        &meta("fan", "user", "/fan.md"),
    ));
    assert_eq!(
        bad,
        (
            false,
            vec!["/fan.md: step Ship: after names no step called Nope".to_string()]
        )
    );
}

/// A temporary folder, removed when it goes.
struct Dir(std::path::PathBuf);

impl Dir {
    fn new() -> Dir {
        let d = std::env::temp_dir().join(format!(
            "canopy-workflow-cli-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Dir(d)
    }
    fn join(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Got {
    lines: Vec<String>,
    asked: Vec<String>,
    failed: Option<String>,
}

/// The command against a fake backend that answers `answers[path]`, else
/// 404: what it printed, the paths it asked for, and the failure if any.
async fn drive(argv: &[&str], answers: Value) -> Got {
    let asked = Mutex::new(Vec::new());
    let fake = Fake(|_: &Target, _: &str, p: &str, _: Option<&Value>| {
        asked.lock().unwrap().push(p.to_string());
        let path = p.split('?').next().unwrap_or(p);
        answers.get(path).cloned().ok_or(AskError::Refused {
            message: "not found".into(),
            status: 404,
        })
    });
    let mut args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    args.extend(["--backend".to_string(), "http://127.0.0.1:1".to_string()]);
    let mut out = Out::default();
    let failed = workflow_cmd(args, &Caller::default(), &fake, &mut out)
        .await
        .err();
    // the command logs once, so its one console.log is the whole text
    let text = out.text.strip_suffix('\n').unwrap_or(&out.text);
    Got {
        lines: if out.text.is_empty() {
            Vec::new()
        } else {
            vec![text.to_string()]
        },
        asked: asked.into_inner().unwrap(),
        failed,
    }
}

#[tokio::test]
async fn check_on_a_broken_file_fails_with_its_error_and_on_a_good_one_prints_its_steps() {
    let dir = Dir::new();
    let bad = dir.join("bad.md");
    std::fs::write(
        &bad,
        FAN_TEXT.replace("when: verdict done, check pass", "when: judge meets"),
    )
    .unwrap();
    let got = drive(&["check", &bad], json!({})).await;
    assert_eq!(
        got.failed.as_deref(),
        Some(
            format!("{bad}: step Ship: when judge meets needs a step before it with gate: judge")
                .as_str()
        )
    );
    assert!(got.asked.is_empty());
    let good = dir.join("fan.md");
    std::fs::write(&good, FAN_TEXT).unwrap();
    let fine = drive(&["check", &good], json!({})).await;
    assert_eq!(fine.failed, None);
    assert_eq!(
        fine.lines[0].split('\n').next().unwrap(),
        format!("{good}: ok, 4 steps")
    );
    let none = dir.join("none.md");
    assert_eq!(
        drive(&["check", &none], json!({})).await.failed,
        Some(format!("no such file: {none}"))
    );
}

#[tokio::test]
async fn show_repo_asks_the_backend_for_the_repos_list_and_draws_its_graph() {
    let wf = fan();
    let list = json!([{"ok": true, "workflow": wf, "graph": workflow_graph(&wf, &modes(json!({"fan": {"Ship": "auto"}})))}]);
    let answers = json!({ "/api/repos/workflows": list });
    let got = drive(&["show", "fan", "--repo", "web/app"], answers.clone()).await;
    assert_eq!(got.failed, None);
    assert_eq!(got.asked, ["/api/repos/workflows?id=web%2Fapp"]);
    assert_eq!(
        got.lines[0].split('\n').next_back().unwrap(),
        "    Ship  after Lint, Docs · when verdict done, check pass · auto (repo)"
    );
    let dot = drive(
        &["show", "fan", "--repo", "web/app", "--dot"],
        answers.clone(),
    )
    .await;
    assert!(dot.lines[0].starts_with("digraph \"fan\" {"));
    let missing = drive(&["show", "nope", "--repo", "web/app"], answers).await;
    assert_eq!(
        missing.failed.as_deref(),
        Some("no workflow called nope in the workflows for web/app")
    );
}

#[tokio::test]
async fn list_repo_prints_the_backends_entries_a_bad_word_is_the_usage() {
    let got = drive(
        &["list", "--repo", "app"],
        json!({"/api/repos/workflows": [{"ok": true, "workflow": fan()}]}),
    )
    .await;
    assert_eq!(got.failed, None);
    assert_eq!(got.asked, ["/api/repos/workflows?id=app"]);
    assert_eq!(
        got.lines,
        ["workflows for app\n  fan  user     4 steps as a graph, Ship manual"]
    );
    assert!(
        drive(&["draw"], json!({}))
            .await
            .failed
            .unwrap()
            .starts_with("usage: canopy workflow show")
    );
    assert_eq!(
        drive(&["list", "--repo"], json!({}))
            .await
            .failed
            .as_deref(),
        Some("--repo needs a repo id or a path")
    );
}

#[tokio::test]
async fn a_repo_by_path_is_the_one_the_backend_scans_there_and_a_backend_that_is_down_says_so() {
    let dir = Dir::new();
    let real = std::fs::canonicalize(&dir.0)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let answers = json!({
        "/api/tree": {"repos": [{"id": "web/app", "path": real}]},
        "/api/repos/workflows": [],
    });
    let got = drive(&["list", "--repo", &dir.join("")], answers).await;
    assert_eq!(got.failed, None);
    assert_eq!(
        got.asked,
        ["/api/tree", "/api/repos/workflows?id=web%2Fapp"]
    );
    assert_eq!(got.lines, ["workflows for web/app: no workflows"]);
    let elsewhere = drive(
        &["list", "--repo", &dir.join("")],
        json!({"/api/tree": {"repos": []}}),
    )
    .await;
    assert_eq!(elsewhere.failed, Some(format!("home does not scan {real}")));
    let nowhere = dir.join("gone");
    assert_eq!(
        drive(&["list", "--repo", &nowhere], json!({})).await.failed,
        Some(format!("no such folder: {nowhere}"))
    );
    let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable("http://127.0.0.1:1: refused".into()))
    });
    let mut out = Out::default();
    let args = ["list", "--repo", "app", "--backend", "http://127.0.0.1:1"]
        .map(String::from)
        .to_vec();
    assert_eq!(
        workflow_cmd(args, &Caller::default(), &down, &mut out).await,
        Err("home did not answer: http://127.0.0.1:1: refused".into())
    );
}

#[test]
fn the_machines_list_reads_the_users_folder_and_leaves_out_unlisted_workflows() {
    let dir = Dir::new();
    std::fs::create_dir_all(dir.0.join("workflows")).unwrap();
    std::fs::write(
        dir.0.join("workflows/tidy.md"),
        "---\nblurb: tidy\n---\n\n## Tidy\n\nTidy.\n",
    )
    .unwrap();
    std::fs::write(
        dir.0.join("workflows/quiet.md"),
        "---\nblurb: q\nlisted: false\n---\n\n## Q\n\nq\n",
    )
    .unwrap();
    let caller = Caller {
        config_dir: dir.join(""),
        ..Caller::default()
    };
    let fake = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable("no request expected".into()))
    });
    let mut out = Out::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    rt.block_on(workflow_cmd(vec!["list".into()], &caller, &fake, &mut out))
        .unwrap();
    let text = out.printed().join("\n");
    assert!(text.starts_with("bundled and user workflows on this machine\n  commit "));
    assert!(text.contains("\n  tidy "));
    assert!(!text.contains("quiet"));
    assert!(!text.contains("issue-fix"));
}
