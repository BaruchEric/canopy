//! incubator.test.ts, case by case. The TypeScript serves a fake backend on
//! a port; here `ask::tests::Fake` stands in for it and keeps what it was
//! sent in the same shape.

use super::*;
use crate::ask::tests::Fake;
use crate::ask::{AskError, Target};
use std::sync::Mutex;

const PLAIN: Paint = Paint { color: false };
const BASE: &str = "http://127.0.0.1:9";

fn sprout(over: Value) -> Value {
    let mut v = json!({
        "id": "sp_0123456789ab", "slug": "coins", "title": "a coin counter", "status": "queued",
        "repoId": "_incubator/coins", "seedPath": "/x/_incubator/coins", "prepared": true, "inputs": [],
        "clarified": false, "reclarify": false, "flows": [], "spent": {"runs": 2, "workMs": 180_000},
        "createdAt": 1, "updatedAt": 1
    });
    for (k, x) in over.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

fn detail(s: Value) -> Value {
    json!({"sprout": s, "brief": null, "intent": "Count the quarters.\n",
           "inputsIndex": "- [1] text 001-text.md\n", "research": null, "retro": null})
}

fn away() -> Value {
    json!({"isolated": false, "mode": "runner", "waiting": "the stage runner is not answering", "unfenced": null, "login": null})
}

fn qs() -> Value {
    json!([
        {"question": "Who counts?", "header": "who", "options": [{"label": "staff", "description": "the attendant"}, {"label": "owner", "description": ""}], "multiSelect": false},
        {"question": "Which coins?", "header": "coins", "options": [{"label": "quarters", "description": ""}, {"label": "dimes", "description": ""}, {"label": "tokens", "description": ""}], "multiSelect": true},
        {"question": "Anything else?", "header": "else", "options": [], "multiSelect": false}
    ])
}

fn review() -> Value {
    json!({
        "head": "0123456789abcdef0123456789abcdef01234567", "base": "fedcba9876543210fedcba9876543210fedcba98",
        "remote": "https://github.com/eric/clms.git", "branch": "new/coins",
        "commits": [{"sha": "0123456789abcdef", "subject": "add the counter"}], "moreCommits": 0,
        "files": [{"path": "src/count.ts", "added": 3, "removed": 1}], "moreFiles": 0, "flagged": [], "at": 1
    })
}

/// One request the fake backend saw.
#[derive(Debug, Clone, PartialEq)]
struct Seen {
    method: String,
    path: String,
    id: Option<String>,
    body: Option<Value>,
}

#[derive(Default)]
struct Opts {
    /// None: a 404, as an older backend answers
    stages: Option<Option<Value>>,
    backends: Option<Value>,
    one: Option<Value>,
    list: Option<Value>,
}

/// A backend that answers the incubator's routes and keeps what it was sent.
fn fake(o: Opts, seen: &Mutex<Vec<Seen>>) -> impl Ask + '_ {
    Fake(
        move |_: &Target, method: &str, full: &str, body: Option<&Value>| {
            let (path, id) = match full.split_once("?id=") {
                Some((p, id)) => (p.to_string(), Some(id.to_string())),
                None => (full.to_string(), None),
            };
            seen.lock().unwrap().push(Seen {
                method: method.into(),
                path: path.clone(),
                id,
                body: body.cloned(),
            });
            let not_found = || {
                Err(AskError::Refused {
                    message: "not found".into(),
                    status: 404,
                })
            };
            match (path.as_str(), method) {
                ("/api/incubator/stages", _) => match &o.stages {
                    Some(None) => not_found(),
                    Some(Some(s)) => Ok(s.clone()),
                    None => {
                        let mut s = away();
                        s["isolated"] = json!(true);
                        s["waiting"] = Value::Null;
                        Ok(s)
                    }
                },
                ("/api/backends", _) => o.backends.clone().map_or_else(not_found, Ok),
                ("/api/incubator", "POST") => Ok(sprout(json!({"title": "made"}))),
                ("/api/incubator", "GET") => Ok(o.list.clone().unwrap_or_else(|| json!([]))),
                ("/api/incubator", "DELETE") => Ok(json!({"ok": true})),
                ("/api/incubator/one", _) => {
                    Ok(o.one.clone().unwrap_or_else(|| detail(sprout(json!({})))))
                }
                _ => Ok(sprout(json!({"status": "queued"}))),
            }
        },
    )
}

fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// a scratch memo file, removed on drop
struct Memo(std::path::PathBuf);

impl Memo {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("canopy-incubator-cli-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("memo.md"), "count the quarters").unwrap();
        Memo(dir)
    }

    fn path(&self) -> String {
        self.0.join("memo.md").to_string_lossy().into_owned()
    }
}

impl Drop for Memo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// a command's stdout, its stderr notes, and its result
async fn run_new(argv: &[&str], f: &impl Ask) -> (Result<(), String>, Out, Vec<String>) {
    let notes = Mutex::new(Vec::new());
    let note = |n: &str| notes.lock().unwrap().push(n.to_string());
    let mut out = Out::default();
    let r = new_cmd(words(argv), &Caller::default(), f, &mut out, &note, PLAIN).await;
    (r, out, notes.into_inner().unwrap())
}

async fn run_inc(argv: &[&str], f: &impl Ask) -> (Result<(), String>, Out) {
    let mut out = Out::default();
    let r = incubator_cmd(
        words(argv),
        &Caller::default(),
        f,
        &mut out,
        "/nonexistent",
        PLAIN,
    )
    .await;
    (r, out)
}

fn calls(seen: &Mutex<Vec<Seen>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|s| format!("{} {}", s.method, s.path))
        .collect()
}

// describe("canopy new")

#[tokio::test]
async fn asks_where_stages_run_before_it_sends_a_file_and_stops_in_the_servers_own_words_when_they_are_off()
 {
    let memo = Memo::new();
    let seen = Mutex::default();
    let f = fake(
        Opts {
            stages: Some(Some(
                json!({"isolated": false, "mode": "off", "waiting": null}),
            )),
            ..Default::default()
        },
        &seen,
    );
    let (r, _, _) = run_new(
        &["a coin counter", "--file", &memo.path(), "--backend", BASE],
        &f,
    )
    .await;
    assert_eq!(r, Err(NO_STAGES.into()));
    assert_eq!(calls(&seen), ["GET /api/incubator/stages"]);
}

#[tokio::test]
async fn prints_the_link_at_the_backends_public_origin_and_at_the_apis_when_the_backend_names_none()
{
    let memo = Memo::new();
    let listed = json!({"self": "mini", "backends": [{"name": "mac", "public": "https://mac.example"}, {"name": "mini", "public": "https://canopy.example/", "tailnet": "http://mini.ts:7850"}]});
    let seen = Mutex::default();
    let f = fake(
        Opts {
            backends: Some(listed),
            ..Default::default()
        },
        &seen,
    );
    let (r, out, _) = run_new(
        &["a coin counter", "--file", &memo.path(), "--backend", BASE],
        &f,
    )
    .await;
    assert_eq!(r, Ok(()));
    assert_eq!(
        out.printed().last().copied(),
        Some("https://canopy.example/?view=incubator&sprout=sp_0123456789ab")
    );
    let posted = seen
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.method == "POST")
        .cloned()
        .unwrap();
    assert_eq!(
        posted.body,
        Some(
            json!({"form": {"text": ["a coin counter"], "file": ["file:memo.md:count the quarters"], "via": ["cli"]}})
        )
    );
    let bare_seen = Mutex::default();
    let bare = fake(Opts::default(), &bare_seen);
    let (_, out, _) = run_new(&["a coin counter", "--backend", BASE], &bare).await;
    assert_eq!(
        out.printed().last().copied(),
        Some(format!("{BASE}/?view=incubator&sprout=sp_0123456789ab").as_str())
    );
}

#[tokio::test]
async fn an_older_backend_that_cannot_say_where_stages_run_still_gets_the_project() {
    let seen = Mutex::default();
    let f = fake(
        Opts {
            stages: Some(None),
            ..Default::default()
        },
        &seen,
    );
    let (r, out, _) = run_new(&["a coin counter", "--backend", BASE], &f).await;
    assert_eq!(r, Ok(()));
    assert!(out.printed()[0].contains("sp_0123456789ab"));
}

#[tokio::test]
async fn a_lone_repo_url_goes_as_the_repo_with_the_note_on_stderr_an_unknown_flag_sends_nothing() {
    let memo = Memo::new();
    let seen = Mutex::default();
    let f = fake(Opts::default(), &seen);
    let (r, out, err) = run_new(&["https://github.com/a/b", "--backend", BASE], &f).await;
    assert_eq!(r, Ok(()));
    let posted = seen
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.method == "POST")
        .cloned()
        .unwrap();
    assert_eq!(
        posted.body,
        Some(json!({"form": {"repo": ["https://github.com/a/b"], "via": ["cli"]}}))
    );
    assert_eq!(
        err,
        ["took https://github.com/a/b as --repo; pass it with --url to give it as a link"]
    );
    assert!(out.printed()[0].contains("sp_0123456789ab"));
    seen.lock().unwrap().clear();
    let (r, _, _) = run_new(
        &["a coin counter", "--fiel", &memo.path(), "--backend", BASE],
        &f,
    )
    .await;
    assert!(r.unwrap_err().contains("unknown flag --fiel"));
    assert!(seen.lock().unwrap().is_empty());
}

// describe("the lines")

#[test]
fn page_base_takes_the_public_origin_of_the_backends_own_entry_else_the_api_origin() {
    let api = "http://127.0.0.1:7850";
    let pb = |v: Value| page_base(api, Some(&v));
    assert_eq!(
        pb(
            json!({"self": "mini", "backends": [{"name": "mini", "public": "https://canopy.example"}]})
        ),
        "https://canopy.example"
    );
    assert_eq!(
        pb(json!({"self": "mini", "backends": [{"name": "mac", "public": "https://mac.example"}]})),
        api
    );
    assert_eq!(
        pb(
            json!({"self": "mini", "backends": [{"name": "mini", "tailnet": "http://mini.ts:7850"}]})
        ),
        api
    );
    assert_eq!(
        pb(json!({"self": "mini", "backends": [{"name": "mini", "public": "not a url"}]})),
        api
    );
    assert_eq!(page_base(api, None), api);
    assert_eq!(pb(json!({"error": "not found"})), api);
}

#[test]
fn a_queued_project_waits_in_its_backends_words_unless_it_is_being_prepared_or_bound_for_canopys_own_deploy()
 {
    let a = away();
    assert_eq!(
        wait_why(&sprout(json!({})), Some(&a)).as_deref(),
        Some("the stage runner is not answering")
    );
    assert_eq!(
        wait_why(&sprout(json!({"prepared": false})), Some(&a)),
        None
    );
    assert_eq!(
        wait_why(&sprout(json!({"status": "building"})), Some(&a)),
        None
    );
    assert_eq!(wait_why(&sprout(json!({})), None), None);
    let bound = sprout(json!({
        "clarified": true, "pick": {"kind": "new", "host": "vercel", "why": "w"},
        "flows": [{"workflow": "scout", "flowId": "f1", "outcome": "done"}, {"workflow": "build-new", "flowId": "f2", "outcome": "done"}]
    }));
    assert_eq!(wait_why(&bound, Some(&a)), None);
    assert_eq!(
        list_line(&sprout(json!({})), Some(&a)),
        "sp_0123456789ab  queued      a coin counter (waiting: the stage runner is not answering)"
    );
    assert_eq!(
        list_line(
            &sprout(json!({"status": "clarifying", "questions": qs()})),
            Some(&a)
        ),
        "sp_0123456789ab  clarifying  a coin counter (3 questions waiting)"
    );
}

#[test]
fn show_says_why_the_project_waits_and_lists_clarifys_questions_with_their_options_and_the_command_that_answers()
 {
    let a = away();
    let link = "https://canopy.example/?view=incubator&sprout=sp_0123456789ab";
    let lines = show_lines(
        &detail(sprout(json!({"status": "clarifying", "questions": qs()}))),
        Some(&a),
        link,
    );
    assert_eq!(
        lines[..3],
        [
            "a coin counter  _incubator/coins",
            "clarifying",
            "2 runs, 3 min of agent work"
        ]
    );
    for want in [
        "clarify asks 3 questions:",
        "1. Who counts?",
        "   1) staff: the attendant",
        "   2) owner",
        "2. Which coins? (pick any)",
        "3. Anything else?",
        "answer: canopy incubator answer sp_0123456789ab \"<1>\" \"<2>\" \"<3>\"",
        "or go on assumptions: canopy incubator answer sp_0123456789ab --skip",
        "Count the quarters.",
    ] {
        assert!(lines.iter().any(|l| l == want), "{want}");
    }
    assert_eq!(lines.last().map(String::as_str), Some(link));
    let waiting = show_lines(&detail(sprout(json!({}))), Some(&a), "L");
    assert_eq!(
        waiting[..3],
        [
            "a coin counter  _incubator/coins",
            "queued",
            "waiting: the stage runner is not answering"
        ]
    );
}

#[test]
fn show_gives_a_parked_projects_ways_on_a_hand_offs_review_and_its_yes_and_an_ended_ones_dismiss() {
    let a = away();
    let parked = show_lines(
        &detail(sprout(
            json!({"status": "parked", "parked": "Accept did not accept the work"}),
        )),
        Some(&a),
        "L",
    );
    assert_eq!(parked[1], "parked: Accept did not accept the work");
    for want in [
        "go on: canopy incubator resume sp_0123456789ab",
        "run the step again, or send the work back: canopy incubator resume sp_0123456789ab --retry",
        "end it: canopy incubator stop sp_0123456789ab",
    ] {
        assert!(parked.iter().any(|l| l == want), "{want}");
    }
    let approving = show_lines(
        &detail(sprout(json!({"status": "approving", "handOff": review()}))),
        Some(&a),
        "L",
    );
    assert!(
        approving
            .join("\n")
            .contains("Push new/coins to github.com/eric/clms, from fedcba987654 to 0123456789ab.")
    );
    assert!(
        approving
            .iter()
            .any(|l| l == "push it: canopy incubator handoff sp_0123456789ab --yes 0123456789ab")
    );
    let stopped = show_lines(&detail(sprout(json!({"status": "stopped"}))), Some(&a), "L");
    assert!(
        stopped
            .iter()
            .any(|l| l == "off the list: canopy incubator dismiss sp_0123456789ab")
    );
}

#[test]
fn answer_map_keys_each_answer_by_its_question_a_number_picks_an_option_several_where_any_may_be_picked_leaves_one()
 {
    let q = qs();
    let questions = q.as_array().unwrap();
    let map = |given: &[&str]| answer_map(questions, &words(given)).map(Value::Object);
    assert_eq!(
        map(&["2", "1,3", "open on Sundays"]),
        Ok(
            json!({"Who counts?": "owner", "Which coins?": "quarters, tokens", "Anything else?": "open on Sundays"})
        )
    );
    // out of range, or several where one is picked: the words as written
    assert_eq!(map(&["7", "", ""]), Ok(json!({"Who counts?": "7"})));
    assert_eq!(map(&["1,2"]), Ok(json!({"Who counts?": "1,2"})));
    assert_eq!(
        map(&["the night shift"]),
        Ok(json!({"Who counts?": "the night shift"}))
    );
    assert_eq!(
        map(&["1", "1", "x", "extra"]),
        Err("4 answers for 3 questions: give one per question, in order".into())
    );
    assert!(
        map(&["", " "])
            .unwrap_err()
            .starts_with("give an answer, or --skip")
    );
}

// describe("canopy incubator")

fn bodies(seen: &Mutex<Vec<Seen>>) -> Vec<(String, String, Option<String>, Option<Value>)> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s.method.clone(),
                s.path.clone(),
                s.id.clone(),
                s.body.clone(),
            )
        })
        .collect()
}

fn row(
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (String, String, Option<String>, Option<Value>) {
    (
        method.into(),
        path.into(),
        Some("sp_0123456789ab".into()),
        body,
    )
}

#[tokio::test]
async fn answer_reads_the_questions_then_posts_the_answers_keyed_by_each_skip_goes_on_assumptions()
{
    let seen = Mutex::default();
    let f = fake(
        Opts {
            one: Some(detail(sprout(
                json!({"status": "clarifying", "questions": qs()}),
            ))),
            ..Default::default()
        },
        &seen,
    );
    run_inc(
        &["answer", "sp_0123456789ab", "1", "2", "--backend", BASE],
        &f,
    )
    .await
    .0
    .unwrap();
    run_inc(
        &["answer", "sp_0123456789ab", "--skip", "--backend", BASE],
        &f,
    )
    .await
    .0
    .unwrap();
    assert_eq!(
        bodies(&seen),
        [
            row("GET", "/api/incubator/one", None),
            row(
                "POST",
                "/api/incubator/answer",
                Some(json!({"answers": {"Who counts?": "staff", "Which coins?": "dimes"}}))
            ),
            row("POST", "/api/incubator/answer", Some(json!({"skip": true}))),
        ]
    );
    let (r, _) = run_inc(
        &["answer", "sp_0123456789ab", "--skp", "--backend", BASE],
        &f,
    )
    .await;
    assert!(r.unwrap_err().contains("unknown flag --skp"));
    let (r, _) = run_inc(
        &[
            "answer",
            "sp_0123456789ab",
            "1",
            "--skip",
            "--backend",
            BASE,
        ],
        &f,
    )
    .await;
    assert_eq!(r, Err("give answers or --skip, not both".into()));
    let quiet_seen = Mutex::default();
    let quiet = fake(
        Opts {
            one: Some(detail(sprout(json!({"status": "researching"})))),
            ..Default::default()
        },
        &quiet_seen,
    );
    let (r, _) = run_inc(
        &["answer", "sp_0123456789ab", "1", "--backend", BASE],
        &quiet,
    )
    .await;
    assert_eq!(r, Err("this project has no open questions".into()));
    assert!(!calls(&quiet_seen).iter().any(|c| c.starts_with("POST")));
}

#[tokio::test]
async fn resume_resume_retry_stop_and_dismiss_call_the_routes_the_sheets_buttons_do() {
    let seen = Mutex::default();
    let f = fake(Opts::default(), &seen);
    let (_, out) = run_inc(&["resume", "sp_0123456789ab", "--backend", BASE], &f).await;
    assert_eq!(
        out.printed(),
        ["sp_0123456789ab  queued      a coin counter"]
    );
    // a flag before the id is not the id
    run_inc(
        &["resume", "--retry", "sp_0123456789ab", "--backend", BASE],
        &f,
    )
    .await
    .0
    .unwrap();
    run_inc(&["stop", "sp_0123456789ab", "--backend", BASE], &f)
        .await
        .0
        .unwrap();
    let (_, dismissed) = run_inc(&["dismiss", "sp_0123456789ab", "--backend", BASE], &f).await;
    assert_eq!(
        dismissed.printed(),
        [
            "sp_0123456789ab is off the list; its seed and vault note stay, and its record and raw inputs are deleted in two weeks"
        ]
    );
    assert_eq!(
        bodies(&seen),
        [
            row(
                "POST",
                "/api/incubator/resume",
                Some(json!({"choice": "continue"}))
            ),
            row(
                "POST",
                "/api/incubator/resume",
                Some(json!({"choice": "retry"}))
            ),
            row("POST", "/api/incubator/stop", Some(json!({}))),
            row("DELETE", "/api/incubator", None),
        ]
    );
    let (r, _) = run_inc(&["stop", "--backend", BASE], &f).await;
    assert_eq!(r, Err("usage: canopy incubator stop <id>".into()));
}

#[tokio::test]
async fn add_sends_words_links_and_files_as_the_intake_form_and_refuses_a_repo_or_an_unknown_flag()
{
    let memo = Memo::new();
    let seen = Mutex::default();
    let f = fake(Opts::default(), &seen);
    let m = memo.path();
    run_inc(
        &[
            "add",
            "sp_0123456789ab",
            "also",
            "dimes",
            "--url",
            "https://example.com/spec",
            "--file",
            &m,
            "--backend",
            BASE,
        ],
        &f,
    )
    .await
    .0
    .unwrap();
    assert_eq!(
        bodies(&seen),
        [row(
            "POST",
            "/api/incubator/input",
            Some(
                json!({"form": {"text": ["also dimes"], "url": ["https://example.com/spec"], "file": ["file:memo.md:count the quarters"], "via": ["cli"]}})
            )
        )]
    );
    let (r, _) = run_inc(
        &[
            "add",
            "sp_0123456789ab",
            "--repo",
            "https://github.com/a/b",
            "--backend",
            BASE,
        ],
        &f,
    )
    .await;
    assert!(r.unwrap_err().contains("unknown flag --repo"));
    let (r, _) = run_inc(&["add", "sp_0123456789ab", "--backend", BASE], &f).await;
    assert!(r.unwrap_err().contains("give words, --file or --url"));
}

#[tokio::test]
async fn handoff_yes_names_the_whole_head_the_short_one_show_printed_stands_for_no_gives_the_reason()
 {
    let seen = Mutex::default();
    let f = fake(
        Opts {
            one: Some(detail(sprout(
                json!({"status": "approving", "handOff": review()}),
            ))),
            ..Default::default()
        },
        &seen,
    );
    run_inc(
        &[
            "handoff",
            "sp_0123456789ab",
            "--yes",
            "0123456789ab",
            "--backend",
            BASE,
        ],
        &f,
    )
    .await
    .0
    .unwrap();
    run_inc(
        &[
            "handoff",
            "sp_0123456789ab",
            "--no",
            "not",
            "this",
            "week",
            "--backend",
            BASE,
        ],
        &f,
    )
    .await
    .0
    .unwrap();
    let posted: Vec<Option<Value>> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.method == "POST")
        .map(|s| s.body.clone())
        .collect();
    assert_eq!(
        posted,
        [
            Some(json!({"approve": true, "head": review()["head"]})),
            Some(json!({"approve": false, "head": "", "reason": "not this week"})),
        ]
    );
    let (r, _) = run_inc(
        &["handoff", "sp_0123456789ab", "--yes", "--backend", BASE],
        &f,
    )
    .await;
    assert!(r.unwrap_err().contains("--yes takes the head show printed"));
    let (r, _) = run_inc(&["handoff", "sp_0123456789ab", "--backend", BASE], &f).await;
    assert!(r.unwrap_err().contains("usage: canopy incubator handoff"));
}

#[tokio::test]
async fn show_prints_the_questions_the_wait_and_the_link_at_the_public_origin_list_says_why_a_queued_project_waits()
 {
    let seen = Mutex::default();
    let f = fake(
        Opts {
            stages: Some(Some(away())),
            backends: Some(
                json!({"self": "mini", "backends": [{"name": "mini", "public": "https://canopy.example"}]}),
            ),
            one: Some(detail(sprout(json!({})))),
            list: Some(json!([sprout(json!({}))])),
        },
        &seen,
    );
    let (r, shown) = run_inc(&["show", "sp_0123456789ab", "--backend", BASE], &f).await;
    assert_eq!(r, Ok(()));
    assert!(
        shown
            .printed()
            .contains(&"waiting: the stage runner is not answering")
    );
    assert_eq!(
        shown.printed().last().copied(),
        Some("https://canopy.example/?view=incubator&sprout=sp_0123456789ab")
    );
    let (_, listed) = run_inc(&["list", "--backend", BASE], &f).await;
    assert_eq!(
        listed.printed(),
        [
            "sp_0123456789ab  queued      a coin counter (waiting: the stage runner is not answering)"
        ]
    );
}

// beyond the TypeScript tests: the refusals said before any call, a
// backend that does not answer, and pick-check on a seed's files

#[tokio::test]
async fn the_backend_flag_and_a_backend_that_does_not_answer_are_refused_in_incubator_ts_words() {
    let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable(
            "ECONNREFUSED: Unable to connect. Is the computer able to access the url?".into(),
        ))
    });
    let (r, _) = run_inc(&["list", "--backend"], &down).await;
    assert_eq!(r, Err("--backend needs a value".into()));
    let (r, _) = run_inc(&["--backend", "mini"], &down).await;
    assert_eq!(
        r,
        Err("--backend must be an http(s) origin, got mini".into())
    );
    let (r, _) = run_inc(&["list", "--backend", BASE], &down).await;
    assert_eq!(
        r,
        Err(format!(
            "{BASE} did not answer: ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
        ))
    );
    let (r, _, _) = run_new(&["x", "--backend", BASE], &down).await;
    assert_eq!(
        r,
        Err(format!(
            "{BASE} did not answer: ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
        ))
    );
    let (r, _, _) = run_new(
        &["x", "--file", "/nonexistent/memo.md", "--backend", BASE],
        &down,
    )
    .await;
    assert_eq!(r, Err("no such file: /nonexistent/memo.md".into()));
}

#[tokio::test]
async fn pick_check_reads_the_pick_and_the_research_and_holds_the_limits() {
    let memo = Memo::new();
    let seed = memo.0.to_string_lossy().into_owned();
    let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable("down".into()))
    });
    let check = |seed: String| {
        let down = &down;
        async move {
            let mut out = Out::default();
            let r = incubator_cmd(
                words(&["pick-check"]),
                &Caller::default(),
                down,
                &mut out,
                &seed,
                PLAIN,
            )
            .await;
            (r, out)
        }
    };
    let (r, _) = check(seed.clone()).await;
    assert_eq!(
        r,
        Err(".canopy/pick.json is missing: research ends by writing it".into())
    );
    std::fs::create_dir_all(memo.0.join(".canopy")).unwrap();
    let pick = |text: &str| std::fs::write(memo.0.join(".canopy/pick.json"), text).unwrap();
    pick(r#"{"kind": "new", "host": "mini", "why": "small"}"#);
    let (r, _) = check(seed.clone()).await;
    assert_eq!(
        r,
        Err(format!(
            ".canopy/pick.json: {}",
            canopy_core::sprout::MINI_PARKED
        ))
    );
    pick(
        r#"{"kind": "renovate", "host": "vercel", "why": "w", "target": "https://github.com/a/b", "license": "AGPL-3.0"}"#,
    );
    let (r, _) = check(seed.clone()).await;
    assert_eq!(
        r,
        Err(".canopy/pick.json: AGPL-3.0 is not on the allowed license list".into())
    );
    pick("{nope");
    let (r, _) = check(seed.clone()).await;
    assert_eq!(r, Err(".canopy/pick.json: pick.json is not JSON".into()));
    pick(r#"{"kind": "new", "host": "vercel", "why": "nothing close exists"}"#);
    let (r, _) = check(seed.clone()).await;
    assert_eq!(
        r,
        Err(".canopy/research.md is missing: research writes it before the pick".into())
    );
    std::fs::write(memo.0.join(".canopy/research.md"), "# research\n").unwrap();
    let (r, out) = check(seed).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out.printed(), ["pick ok: new on vercel"]);
}
