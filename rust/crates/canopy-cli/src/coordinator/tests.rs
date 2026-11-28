//! coordinator.test.ts's cases. The TypeScript serves its runs and takes
//! the posts on a Bun server; here the fake backend answers `ask`, and a
//! stub on loopback takes the new goal's form, which goes through the
//! client itself.

use super::*;
use crate::ask::tests::{Fake, Stub, json_answer};
use crate::ask::{AskError, Client};
use std::sync::Mutex;

fn card(id: &str, over: Value) -> Value {
    let mut t = json!({"id": id, "title": format!("card {id}"), "repo": "playground/x", "note": "", "action": "propose", "state": "proposed"});
    if let (Some(m), Value::Object(o)) = (t.as_object_mut(), over) {
        m.extend(o);
    }
    t
}

fn coord(id: &str, over: Value) -> Value {
    let mut r = json!({"id": id, "action": "coordinate", "status": "working", "repoId": "playground/x", "note": "ship the thing\nsecond line", "tasks": []});
    if let (Some(m), Value::Object(o)) = (r.as_object_mut(), over) {
        m.extend(o);
    }
    r
}

fn caller() -> Caller {
    Caller {
        config_dir: "/nonexistent/canopy-coordinator-test".into(),
        env_api: Some("http://home:7".into()),
        ..Default::default()
    }
}

fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn coordinator_lines_lists_only_live_coordinators_id_repo_held_counts_goals_first_line() {
    let runs = [
        coord(
            "c1",
            json!({"held": true, "tasks": [card("t1", json!({})), card("t2", json!({"state": "running"}))]}),
        ),
        coord("c2", json!({"status": "done"})),
        coord("r1", json!({"action": "ask"})),
    ];
    assert_eq!(
        coordinator_lines(&runs),
        ["c1  playground/x  held  2 cards · 1 proposed, 1 running  ship the thing"]
    );
    assert_eq!(
        coordinator_lines(&[coord("c3", json!({}))]),
        ["c3  playground/x  0 cards  ship the thing"]
    );
}

#[test]
fn card_lines_pads_the_columns_id_state_repo_loadout_workflow_after_title() {
    let tasks = json!([
        card(
            "t1",
            json!({"state": "queued", "title": "sync the spec", "workflow": "spec", "after": ["t2"], "equip": {"loadout": "quick"}})
        ),
        card("t2", json!({"title": "write it"})),
    ]);
    assert_eq!(
        card_lines(&coord("c1", json!({ "tasks": tasks }))),
        [
            "t1  queued    playground/x  quick  spec  after t2  sync the spec".to_string(),
            format!("t2  proposed  playground/x{}write it", " ".repeat(25)),
        ]
    );
    assert!(card_lines(&coord("c1", json!({}))).is_empty());
}

#[test]
fn card_lines_shows_the_goals_files_a_card_takes_after_the_cards_it_waits_for() {
    let tasks = json!([
        card(
            "t1",
            json!({"title": "favicon", "files": ["shot.png", "notes.md"]})
        ),
        card("t2", json!({"title": "other"})),
    ]);
    assert_eq!(
        card_lines(&coord("c1", json!({ "tasks": tasks }))),
        [
            "t1  proposed  playground/x  files: shot.png, notes.md  favicon".to_string(),
            format!("t2  proposed  playground/x{}other", " ".repeat(29)),
        ]
    );
}

#[test]
fn card_lines_reads_new_project_for_a_project_cards_repo_and_adds_its_sprout_column() {
    let tasks = json!([
        card(
            "t1",
            json!({"title": "a shop", "repo": "~goal", "action": "project", "sprout": "sp_0123456789ab"})
        ),
        card("t2", json!({"title": "other"})),
    ]);
    assert_eq!(
        card_lines(&coord("c1", json!({ "tasks": tasks }))),
        [
            "t1  proposed  new project   sprout sp_0123456789ab  a shop".to_string(),
            format!("t2  proposed  playground/x{}other", " ".repeat(26)),
        ]
    );
}

#[test]
fn card_lines_puts_the_tree_a_card_runs_in_after_the_files_column() {
    let tasks = json!([
        card(
            "t1",
            json!({"title": "tree work", "files": ["a.md"], "tree": "feat/x"})
        ),
        card("t2", json!({"title": "other"})),
    ]);
    assert_eq!(
        card_lines(&coord("c1", json!({ "tasks": tasks }))),
        [
            "t1  proposed  playground/x  files: a.md  in tree feat/x  tree work".to_string(),
            format!("t2  proposed  playground/x{}other", " ".repeat(31)),
        ]
    );
}

/// The fake: GET answers the runs, a POST is kept and answered as the
/// server's hold and start answer.
async fn run(
    argv: &[&str],
    runs: Value,
    posted: &Mutex<Vec<(String, Value)>>,
) -> (Vec<String>, Result<(), String>) {
    let fake = Fake(
        |_: &Target, method: &str, path: &str, body: Option<&Value>| -> Result<Value, AskError> {
            if method == "GET" {
                return Ok(runs.clone());
            }
            posted
                .lock()
                .unwrap()
                .push((path.to_string(), body.cloned().unwrap_or(Value::Null)));
            Ok(json!({"ok": true, "held": true, "tasks": []}))
        },
    );
    let mut out = Out::default();
    let r = coordinator_cmd(words(argv), &caller(), &fake, &mut out).await;
    (out.printed().iter().map(|s| s.to_string()).collect(), r)
}

#[tokio::test]
async fn hold_and_resume_post_run_held_start_posts_ids_or_none() {
    let posted: Mutex<Vec<(String, Value)>> = Mutex::default();
    let said = [
        run(&["hold", "c1"], json!([]), &posted).await.0,
        run(&["resume", "c1"], json!([]), &posted).await.0,
        run(&["start", "c1"], json!([]), &posted).await.0,
        run(&["start", "c1", "t1", "t2"], json!([]), &posted)
            .await
            .0,
    ];
    assert_eq!(
        *posted.lock().unwrap(),
        [
            (
                "/api/coordinator/hold".to_string(),
                json!({"run": "c1", "held": true})
            ),
            (
                "/api/coordinator/hold".to_string(),
                json!({"run": "c1", "held": false})
            ),
            ("/api/coordinator/start".to_string(), json!({"run": "c1"})),
            (
                "/api/coordinator/start".to_string(),
                json!({"run": "c1", "ids": ["t1", "t2"]})
            ),
        ]
    );
    assert_eq!(
        said,
        [
            vec!["c1 held: no card starts until you resume it".to_string()],
            vec!["c1 resumed".to_string()],
            vec!["c1: started every proposed card".to_string()],
            vec!["c1: started t1, t2".to_string()],
        ]
    );
}

#[tokio::test]
async fn coordinator_run_prints_its_cards_an_unknown_run_fails() {
    let posted = Mutex::default();
    let runs = json!([coord("c1", json!({"tasks": [card("t1", json!({}))]}))]);
    assert_eq!(
        run(&["c1"], runs.clone(), &posted).await,
        (
            vec!["t1  proposed  playground/x  card t1".to_string()],
            Ok(())
        )
    );
    assert_eq!(
        run(&["nope"], runs.clone(), &posted).await.1,
        Err("no live coordinator nope".into())
    );
    assert_eq!(
        run(&[], runs.clone(), &posted).await.0,
        ["c1  playground/x  1 card · 1 proposed  ship the thing"]
    );
    assert_eq!(
        run(&[], json!([]), &posted).await.0,
        ["no live coordinators"]
    );
    let empty = json!([coord("c2", json!({}))]);
    assert_eq!(
        run(&["c2"], empty.clone(), &posted).await.0,
        ["c2 has no cards yet"]
    );
    let json_lines = run(&["c1", "--json"], runs, &posted).await.0.join("\n");
    assert_eq!(
        serde_json::from_str::<Value>(&json_lines).unwrap(),
        json!([card("t1", json!({}))])
    );
    assert_eq!(run(&["--json"], json!([]), &posted).await.0, ["[]"]);
}

#[tokio::test]
async fn the_flags_and_the_usage_are_refused_in_the_typescripts_words() {
    let posted = Mutex::default();
    for (argv, want) in [
        (&["--backend"][..], "--backend needs a value"),
        (&["--on"][..], "--on needs a value"),
        (
            &["--on", "x", "--backend", "http://a:1"][..],
            "use either --backend URL or --on NAME",
        ),
        (&["hold"][..], COORDINATOR_USAGE),
        (&["resume", "c1", "extra"][..], COORDINATOR_USAGE),
        (&["start"][..], COORDINATOR_USAGE),
        (&["c1", "extra"][..], COORDINATOR_USAGE),
        (&["new"][..], COORDINATOR_USAGE),
        (&["new", "goal", "--wat", "x"][..], "unknown flag --wat"),
        (
            &["new", "goal", "--file", "/nonexistent/a.png"][..],
            "no such file: /nonexistent/a.png",
        ),
        (&["new", "goal", "--file", "/tmp"][..], "no such file: /tmp"),
        (
            &["--on", "nosuch"][..],
            "no backend named nosuch; the home backend lists home",
        ),
    ] {
        assert_eq!(
            run(argv, json!([]), &posted).await.1,
            Err(want.to_string()),
            "{argv:?}"
        );
    }
    assert!(posted.lock().unwrap().is_empty());
}

#[test]
fn parse_new_args_reads_the_goal_repeated_repo_and_file_and_model_and_effort() {
    assert_eq!(
        parse_new_args(&words(&[
            "fix the cart",
            "--repo",
            "web/shop",
            "--repo",
            "canopy",
            "--file",
            "a.png",
            "--model",
            "sonnet"
        ])),
        Ok(NewGoalArgs {
            goal: "fix the cart".into(),
            repos: words(&["web/shop", "canopy"]),
            files: words(&["a.png"]),
            model: Some("sonnet".into()),
            effort: None,
        })
    );
    assert_eq!(
        parse_new_args(&words(&["--effort", "high", "ship it"])),
        Ok(NewGoalArgs {
            goal: "ship it".into(),
            effort: Some("high".into()),
            ..Default::default()
        })
    );
    assert_eq!(
        parse_new_args(&words(&["a", "goal", "words"])),
        Ok(NewGoalArgs {
            goal: "a goal words".into(),
            ..Default::default()
        })
    );
}

#[test]
fn parse_new_args_refuses_no_goal_a_flag_without_a_value_and_an_unknown_flag() {
    let none = parse_new_args(&[]).unwrap_err();
    assert!(none.starts_with("usage:"));
    assert!(none.contains("canopy coordinator new <goal>"));
    assert_eq!(
        parse_new_args(&words(&["goal", "--repo"])),
        Err("--repo needs a value".into())
    );
    assert_eq!(
        parse_new_args(&words(&["goal", "--wat", "x"])),
        Err("unknown flag --wat".into())
    );
}

#[test]
fn new_goal_form_puts_goal_repos_files_model_and_effort_in_the_form() {
    let args = NewGoalArgs {
        goal: "g".into(),
        repos: words(&["a", "b"]),
        model: Some("opus".into()),
        ..Default::default()
    };
    let form = new_goal_form(&args, vec![("x.txt".into(), b"hi".to_vec())]);
    assert_eq!(form.get("goal"), Some(&FormValue::Text("g".into())));
    assert_eq!(
        form.get_all("repos[]"),
        [&FormValue::Text("a".into()), &FormValue::Text("b".into())]
    );
    assert_eq!(
        form.get_all("files[]"),
        [&FormValue::File {
            name: "x.txt".into(),
            data: b"hi".to_vec()
        }]
    );
    assert_eq!(form.get("model"), Some(&FormValue::Text("opus".into())));
    assert_eq!(form.get("effort"), None);
    let body = String::from_utf8(form.body("XX")).unwrap();
    assert!(body.starts_with("--XX\r\nContent-Disposition: form-data; name=\"goal\"\r\n\r\ng\r\n"));
    assert!(body.contains("name=\"files[]\"; filename=\"x.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nhi\r\n"));
    assert!(body.ends_with("--XX--\r\n"));
}

#[test]
fn new_goal_refusal_adds_the_on_hint_to_a_409_when_no_backend_was_named_and_nothing_else() {
    let why = "the coordinator runs only where an isolated coordinator runner is set up (docs/deploy.md, The coordinator)";
    assert_eq!(
        new_goal_refusal(why, 409, false),
        format!("{why}\n{NEW_GOAL_HINT}")
    );
    assert!(NEW_GOAL_HINT.contains("--on <backend>"));
    assert_eq!(new_goal_refusal(why, 409, true), why);
    assert_eq!(
        new_goal_refusal("write the goal first", 400, false),
        "write the goal first"
    );
}

async fn send(argv: Vec<String>, home: &str) -> (Vec<String>, Result<(), String>) {
    let c = Caller {
        config_dir: "/nonexistent/canopy-coordinator-test".into(),
        env_api: Some(home.into()),
        ..Default::default()
    };
    let client = Client::new(c.clone());
    let mut out = Out::default();
    let r = coordinator_cmd(argv, &c, &client, &mut out).await;
    (out.printed().iter().map(|s| s.to_string()).collect(), r)
}

#[tokio::test]
async fn coordinator_new_a_refusal_from_the_home_backend_names_on_and_one_from_a_named_backend_does_not()
 {
    let msg = "the coordinator runs only where an isolated coordinator runner is set up";
    let refuse = Stub::start(move |_| json_answer(409, json!({ "error": msg }))).await;
    assert_eq!(
        send(words(&["new", "ship it"]), &refuse.url).await.1,
        Err(format!("{msg}\n{NEW_GOAL_HINT}"))
    );
    assert_eq!(
        send(
            words(&["new", "ship it", "--backend", &refuse.url]),
            "http://127.0.0.1:1"
        )
        .await
        .1,
        Err(msg.to_string())
    );
}

#[tokio::test]
async fn coordinator_new_sends_the_form_and_prints_the_goals_link() {
    let take = Stub::start(|_| json_answer(201, json!({"id": "c0ffee12"}))).await;
    let file = std::env::temp_dir().join(format!("canopy-goal-{}.txt", std::process::id()));
    std::fs::write(&file, "notes").unwrap();
    let path = file.to_string_lossy().into_owned();
    let (lines, r) = send(
        words(&[
            "new", "ship", "it", "--repo", "app", "--file", &path, "--effort", "high",
        ]),
        &take.url,
    )
    .await;
    let _ = std::fs::remove_file(&file);
    r.unwrap();
    assert_eq!(
        lines,
        [format!("c0ffee12  {}/?view=manager&run=c0ffee12", take.url)]
    );
    let seen = take.seen.lock().unwrap().clone();
    assert_eq!(seen[0].path, "/api/coordinator/new");
    let body = &seen[0].body;
    assert!(body.contains("name=\"goal\"\r\n\r\nship it\r\n"));
    assert!(body.contains("name=\"repos[]\"\r\n\r\napp\r\n"));
    assert!(body.contains(&format!(
        "filename=\"canopy-goal-{}.txt\"",
        std::process::id()
    )));
    assert!(body.contains("name=\"effort\"\r\n\r\nhigh\r\n"));
    let down = send(words(&["new", "x"]), "http://127.0.0.1:1").await.1;
    assert!(
        down.as_ref()
            .unwrap_err()
            .starts_with("home did not answer: http://127.0.0.1:1: ECONNREFUSED"),
        "{down:?}"
    );
}
