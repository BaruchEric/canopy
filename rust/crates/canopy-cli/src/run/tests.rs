//! run.test.ts's cases, with core's tests of `parsePriority`. Its
//! Bun.serve backends are a fake here that keeps the same answers and
//! records each request's method, path and body. A start never reaches a
//! real backend: every one goes to the fake.

use super::*;
use crate::ask::tests::Fake;
use std::sync::Mutex;

pub(crate) fn argv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

pub(crate) const BACKEND: &str = "http://b.invalid:1";

/// One request the fake saw: method, path and body.
pub(crate) type Seen = (String, String, Option<Value>);

/// What a command left: its result, its stdout as printed, the lines it
/// said on stderr after them, and the requests it made.
pub(crate) struct Got {
    pub result: Result<(), String>,
    pub text: String,
    pub lines: Vec<String>,
    pub warned: Vec<String>,
    pub seen: Vec<Seen>,
}

impl Got {
    pub fn failed(&self) -> Option<&str> {
        self.result.as_ref().err().map(String::as_str)
    }

    /// Each request as "METHOD /path", its query left off.
    pub fn routes(&self) -> Vec<String> {
        self.seen
            .iter()
            .map(|(m, p, _)| format!("{m} {}", p.split('?').next().unwrap_or("")))
            .collect()
    }
}

/// `canopy run <argv>` against a fake that answers with `answer`, run in
/// the folder `cwd` at the time `now`.
pub(crate) async fn run_in<F>(a: Vec<String>, cwd: &str, now: f64, answer: F) -> Got
where
    F: Fn(&str, &str, Option<&Value>) -> Result<Value, AskError>,
{
    let seen: Mutex<Vec<Seen>> = Mutex::default();
    let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
        seen.lock()
            .unwrap()
            .push((m.to_string(), p.to_string(), b.cloned()));
        answer(m, p, b)
    });
    let mut out = Out::default();
    let mut env = RunEnv {
        cwd: cwd.into(),
        now,
        warned: Vec::new(),
    };
    let result = run_cmd(a, &Caller::default(), &fake, &mut out, &mut env).await;
    Got {
        result,
        lines: out.printed().iter().map(|l| l.to_string()).collect(),
        text: out.text,
        warned: env.warned,
        seen: seen.into_inner().unwrap(),
    }
}

/// `run_in` from / at the epoch.
async fn run_on<F>(a: Vec<String>, answer: F) -> Got
where
    F: Fn(&str, &str, Option<&Value>) -> Result<Value, AskError>,
{
    run_in(a, "/", 0.0, answer).await
}

/// The arguments with `--backend` pointed at the fake.
pub(crate) fn with_backend(a: &[&str]) -> Vec<String> {
    let mut v = argv(a);
    v.extend(argv(&["--backend", BACKEND]));
    v
}

fn not_found() -> AskError {
    AskError::Refused {
        message: "not found".into(),
        status: 404,
    }
}

#[test]
fn parse_run_args_reads_a_grouped_branch_run_and_its_flags() {
    assert_eq!(
        parse_run_args(&argv(&[
            "app",
            "ask",
            "-m",
            "add a file",
            "--times",
            "3",
            "--auto-land",
            "--pr"
        ])),
        Ok(RunArgs {
            repo: "app".into(),
            action: "ask".into(),
            note: "add a file".into(),
            times: 3,
            explicit_times: true,
            auto_land: true,
            pr: true,
            ..RunArgs::default()
        })
    );
}

#[test]
fn parse_run_args_keeps_a_single_branch_run_as_the_default_and_rejects_invalid_times() {
    assert_eq!(
        parse_run_args(&argv(&["app", "ask"])),
        Ok(RunArgs {
            repo: "app".into(),
            action: "ask".into(),
            times: 1,
            ..RunArgs::default()
        })
    );
    assert_eq!(
        parse_run_args(&argv(&["app", "ask", "--times", "4"])),
        Err("--times must be 1, 2, or 3".into())
    );
    assert_eq!(
        parse_run_args(&argv(&["app", "ask", "--times"])),
        Err("--times needs a value".into())
    );
}

#[test]
fn parse_run_args_reads_priority_and_refuses_a_word_it_does_not_know_fr_036() {
    let p = parse_run_args(&argv(&["app", "ask", "--priority", "low"])).unwrap();
    assert_eq!(
        (p.repo.as_str(), p.action.as_str(), p.priority.as_deref()),
        ("app", "ask", Some("low"))
    );
    let refused = Err("--priority must be interactive, normal or low".to_string());
    assert_eq!(
        parse_run_args(&argv(&["app", "ask", "--priority", "urgent"])),
        refused
    );
    assert_eq!(
        parse_run_args(&argv(&["app", "ask", "--priority"])),
        refused
    );
    assert_eq!(
        parse_run_args(&argv(&["app", "ask"])).unwrap().priority,
        None
    );
}

#[test]
fn parse_priority_and_later_priority() {
    // laterPriority waits on the capacity port; parsePriority's half
    let got: Vec<Option<&str>> = ["interactive", "normal", "low", "high", "3", ""]
        .iter()
        .map(|w| parse_priority(w))
        .collect();
    assert_eq!(
        got,
        [
            Some("interactive"),
            Some("normal"),
            Some("low"),
            None,
            None,
            None
        ]
    );
}

#[test]
fn run_dispatch_hands_transcript_subcommands_to_the_supplied_handler() {
    for a in [
        argv(&["show", "run-1"]),
        argv(&["export", "run-2"]),
        argv(&["prune"]),
        argv(&[]),
    ] {
        assert_eq!(route(&a), Route::Transcripts, "{a:?}");
    }
    assert_eq!(route(&argv(&["app", "ask"])), Route::Start);
    assert_eq!(route(&argv(&["pickup", "f-1"])), Route::Pickup);
}

#[tokio::test]
async fn canopy_run_dispatch_sends_the_group_body_to_the_selected_backend() {
    let got = run_on(
        with_backend(&[
            "app",
            "ask",
            "-m",
            "add a file",
            "--times",
            "3",
            "--auto-land",
            "--pr",
        ]),
        |_, _, _| {
            Ok(json!({
                "id": "g-1234abcd", "repoId": "app", "repoPath": "/work/app", "action": "ask",
                "note": "add a file", "expectedMembers": 3, "members": [], "state": "working",
                "autoLand": true, "startedAt": 1,
            }))
        },
    )
    .await;
    assert_eq!(got.result, Ok(()));
    assert_eq!(
        got.seen,
        [(
            "POST".to_string(),
            "/api/repos/run?id=app".to_string(),
            Some(
                json!({"action": "ask", "note": "add a file", "branch": true, "times": 3, "autoLand": true, "pr": true})
            )
        )]
    );
    assert_eq!(got.lines, ["g-1234abcd working"]);
}

#[tokio::test]
async fn canopy_run_without_times_keeps_the_single_branch_run_request() {
    let got = run_on(with_backend(&["app", "ask"]), |_, _, _| {
        Ok(json!({"id": "run-1", "status": "working"}))
    })
    .await;
    assert_eq!(
        got.seen,
        [(
            "POST".to_string(),
            "/api/repos/run?id=app".to_string(),
            Some(json!({"action": "ask", "note": "", "branch": true}))
        )]
    );
    assert_eq!(got.lines, ["run-1 working"]);
}

#[test]
fn parse_run_args_reads_a_profile_per_member_an_empty_name_being_the_job_route() {
    let p = parse_run_args(&argv(&[
        "app",
        "ask",
        "--times",
        "3",
        "--profiles",
        "fast,,deep",
        "--reviewers",
        "2",
    ]))
    .unwrap();
    assert_eq!(
        p.profiles,
        Some(vec![Some("fast".into()), None, Some("deep".into())])
    );
    assert_eq!(p.reviewers, Some(2));
    let p = parse_run_args(&argv(&["app", "ask", "--times", "3", "--profiles", "fast"])).unwrap();
    assert_eq!(p.profiles, Some(vec![Some("fast".into())]));
}

#[test]
fn parse_run_args_keeps_reviewers_1_off_the_body() {
    let p = parse_run_args(&argv(&["app", "ask", "--times", "2", "--reviewers", "1"])).unwrap();
    assert_eq!(p.reviewers, None);
    assert!(start_body(&p).get("reviewers").is_none());
}

#[test]
fn parse_run_args_refuses_group_flags_without_a_group_and_bad_values() {
    let refused = |a: &[&str]| parse_run_args(&argv(a)).unwrap_err();
    assert_eq!(
        refused(&["app", "ask", "--profiles", "fast"]),
        "--profiles requires --times 2 or 3"
    );
    assert_eq!(
        refused(&["app", "ask", "--reviewers", "2"]),
        "--reviewers requires --times 2 or 3"
    );
    assert_eq!(
        refused(&["app", "ask", "--times", "2", "--reviewers", "3"]),
        "--reviewers must be 1 or 2"
    );
    assert_eq!(
        refused(&["app", "ask", "--times", "2", "--profiles"]),
        "--profiles needs a list of names"
    );
    assert_eq!(
        refused(&["app", "ask", "--times", "2", "--profiles", "a,b,c"]),
        "--profiles names 3 members; --times says 2"
    );
}

#[test]
fn run_dispatch_skips_the_new_flags_values_when_it_looks_for_a_subcommand() {
    assert_eq!(
        route(&argv(&["--profiles", "show", "--reviewers", "2"])),
        Route::Transcripts
    );
}

#[tokio::test]
async fn canopy_run_sends_each_members_profile_and_the_reviewers_in_the_body() {
    let got = run_on(
        with_backend(&[
            "app",
            "ask",
            "-m",
            "n",
            "--times",
            "2",
            "--profiles",
            ",fast",
            "--reviewers",
            "2",
        ]),
        |_, _, _| {
            Ok(json!({"id": "g-1234abcd", "repoId": "app", "repoPath": "/work/app", "action": "ask", "note": "n", "expectedMembers": 2, "members": [], "state": "working", "autoLand": false, "startedAt": 1}))
        },
    )
    .await;
    let bodies: Vec<Option<Value>> = got.seen.into_iter().map(|(_, _, b)| b).collect();
    assert_eq!(
        bodies,
        [Some(
            json!({"action": "ask", "note": "n", "branch": true, "times": 2, "profiles": [null, "fast"], "reviewers": 2})
        )]
    );
}

#[test]
fn parse_run_args_reads_tools_and_no_tools_and_leaves_the_settings_alone_without_either_fr_038() {
    let tools = |a: &[&str]| parse_run_args(&argv(a)).map(|p| p.canopy_tools);
    assert_eq!(tools(&["app", "ask", "--tools"]), Ok(Some(true)));
    assert_eq!(tools(&["app", "ask", "--no-tools"]), Ok(Some(false)));
    let plain = parse_run_args(&argv(&["app", "ask"])).unwrap();
    assert!(start_body(&plain).get("canopyTools").is_none());
    assert_eq!(
        tools(&["app", "ask", "--tools", "--no-tools"]),
        Err("use either --tools or --no-tools".into())
    );
}

#[test]
fn parse_child_args_wants_a_repo_a_note_and_a_parent() {
    assert_eq!(
        parse_child_args(&argv(&[
            "child", "app", "--note", "a part", "--parent", "abcd1234"
        ])),
        Ok(ChildArgs {
            repo: "app".into(),
            note: "a part".into(),
            parent: "abcd1234".into(),
            ..ChildArgs::default()
        })
    );
    let p = parse_child_args(&argv(&[
        "child", "app", "--note", "x", "--parent", "p", "--action", "propose", "--on", "mini",
    ]))
    .unwrap();
    assert_eq!(
        (p.action.as_deref(), p.on.as_deref()),
        (Some("propose"), Some("mini"))
    );
    for bad in [
        argv(&[]),
        argv(&["child"]),
        argv(&["child", "app"]),
        argv(&["child", "app", "--note", "x"]),
        argv(&["child", "app", "--note", " ", "--parent", "p"]),
        argv(&["other", "app", "--note", "x", "--parent", "p"]),
    ] {
        assert_eq!(parse_child_args(&bad), Err(RUNS_USAGE.into()), "{bad:?}");
    }
}

#[test]
fn loadout_names_the_runs_loadout() {
    assert_eq!(
        parse_run_args(&argv(&["canopy", "ask", "--loadout", "docs"]))
            .unwrap()
            .loadout
            .as_deref(),
        Some("docs")
    );
}

#[test]
fn j_is_refused() {
    for (a, why) in [
        (
            argv(&["canopy", "ask", "--loadout"]),
            "--loadout needs a name",
        ),
        (
            argv(&["canopy", "ask", "--loadout", "docs", "--times", "2"]),
            "--loadout starts one run; use --profiles for a group",
        ),
    ] {
        assert_eq!(parse_run_args(&a), Err(why.into()), "{a:?}");
    }
}

/// `loadoutBackend()`: a backend that answers GET /api/loadouts with
/// `loadouts` (a refusal, or a list) and a start with `run`.
async fn loadout_backend(loadouts: Result<Value, AskError>, run: Value, a: &[&str]) -> Got {
    run_on(with_backend(a), move |_, p, _| {
        if p == "/api/loadouts" {
            loadouts.clone()
        } else {
            Ok(run.clone())
        }
    })
    .await
}

#[tokio::test]
async fn loadout_against_a_backend_that_predates_loadouts_refuses_before_anything_starts() {
    let got = loadout_backend(
        Err(not_found()),
        json!({"id": "run-1", "status": "working"}),
        &["app", "ask", "--loadout", "docs"],
    )
    .await;
    assert_eq!(
        got.failed(),
        Some(format!("{BACKEND} predates loadouts; redeploy it").as_str())
    );
    assert_eq!(got.routes(), ["GET /api/loadouts"]);
}

#[tokio::test]
async fn loadout_fails_loudly_when_the_started_run_came_back_without_its_equip() {
    let got = loadout_backend(
        Ok(json!({"base": [], "errors": [], "loadouts": [{"name": "docs"}]})),
        json!({"id": "run-1", "status": "working"}),
        &["app", "ask", "--loadout", "docs"],
    )
    .await;
    assert_eq!(got.routes(), ["GET /api/loadouts", "POST /api/repos/run"]);
    assert_eq!(
        got.failed(),
        Some(
            format!(
                "run run-1 started on {BACKEND} without loadout docs; stop it and redeploy {BACKEND}"
            )
            .as_str()
        )
    );
    assert!(got.lines.is_empty());
}

#[tokio::test]
async fn loadout_prints_the_run_when_it_came_back_with_its_equip() {
    let equip = json!({"loadout": "docs", "model": "haiku", "effort": "low", "skills": [], "mcp": [], "off": 3});
    let got = loadout_backend(
        Ok(json!({"base": [], "errors": [], "loadouts": [{"name": "docs"}]})),
        json!({"id": "run-1", "status": "working", "equip": equip}),
        &["app", "ask", "--loadout", "docs"],
    )
    .await;
    assert_eq!(got.failed(), None);
    assert_eq!(got.lines, ["run-1 working"]);
}

#[tokio::test]
async fn a_run_without_loadout_never_asks_for_the_loadouts() {
    let got = loadout_backend(
        Err(not_found()),
        json!({"id": "run-1", "status": "working"}),
        &["app", "ask"],
    )
    .await;
    assert_eq!(got.failed(), None);
    assert_eq!(got.routes(), ["POST /api/repos/run"]);
}

#[tokio::test]
async fn canopy_run_pickup_posts_id_and_prints_the_flows_id_and_status() {
    let got = run_on(with_backend(&["pickup", "f-1"]), |_, _, _| {
        Ok(json!({"id": "f-1", "status": "working"}))
    })
    .await;
    assert_eq!(
        got.seen,
        [(
            "POST".to_string(),
            "/api/flows/pickup".to_string(),
            Some(json!({"id": "f-1"}))
        )]
    );
    assert_eq!(got.lines, ["f-1 working"]);
}

#[test]
fn parse_run_args_takes_a_name_for_one_run_and_refuses_it_for_a_group_or_a_coordinator_fr_073() {
    let p = parse_run_args(&argv(&[
        "app",
        "ask",
        "-m",
        "look",
        "--name",
        " slow build ",
    ]))
    .unwrap();
    assert_eq!(
        (p.repo.as_str(), p.action.as_str(), p.note.as_str()),
        ("app", "ask", "look")
    );
    assert_eq!(p.name.as_deref(), Some("slow build"));
    let refused = |a: &[&str]| parse_run_args(&argv(a)).unwrap_err();
    assert_eq!(
        refused(&["app", "ask", "--name"]),
        "--name needs the run's name"
    );
    assert_eq!(
        refused(&["app", "ask", "--name", "  "]),
        "--name needs the run's name"
    );
    assert_eq!(
        refused(&["app", "ask", "--name", "x", "--times", "2"]),
        "--name names one run; a group's members share its note"
    );
    assert_eq!(
        refused(&["app", "coordinate", "--name", "x"]),
        "a coordinator takes no name"
    );
}

#[tokio::test]
async fn name_says_so_when_the_backend_started_the_run_without_it_as_one_from_before_run_names_does()
 {
    let named = loadout_backend(
        Err(not_found()),
        json!({"id": "run-1", "status": "working", "name": "slow build"}),
        &["app", "ask", "--name", "slow build"],
    )
    .await;
    assert_eq!(named.failed(), None);
    assert_eq!(named.lines, ["run-1 working"]);
    assert!(named.warned.is_empty());
    let old = loadout_backend(
        Err(not_found()),
        json!({"id": "run-2", "status": "working"}),
        &["app", "ask", "--name", "slow build"],
    )
    .await;
    assert_eq!(old.failed(), None);
    assert_eq!(old.lines, ["run-2 working"]);
    assert_eq!(
        old.warned,
        [format!(
            "run run-2 started without its name: {BACKEND} runs a canopy from before run names; redeploy it, then canopy run name run-2 slow build"
        )]
    );
}

#[test]
fn the_run_dispatcher_sends_ls_name_and_stop_to_the_transcript_handler() {
    for a in [
        argv(&["ls"]),
        argv(&["name", "ab12cd34", "slow", "build"]),
        argv(&["stop", "ab12cd34"]),
    ] {
        assert_eq!(route(&a), Route::Transcripts, "{a:?}");
    }
}

#[tokio::test]
async fn a_named_backend_comes_from_the_home_list_and_a_path_from_the_tree() {
    let caller = Caller {
        env_api: Some("http://home.invalid".into()),
        ..Caller::default()
    };
    let dir = std::env::temp_dir().join(format!("canopy-runpick-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("shop")).unwrap();
    let real = std::fs::canonicalize(dir.join("shop"))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let tree = json!({"repos": [{"id": "web/shop", "path": real}]});
    let fake = Fake(|t: &Target, _: &str, p: &str, _: Option<&Value>| match p {
        "/api/backends" => Ok::<Value, AskError>(
            json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini.invalid"}]}),
        ),
        "/api/tree" if t.name == "mini" => Ok(tree.clone()),
        _ => Err(AskError::Refused {
            message: "no".into(),
            status: 404,
        }),
    });
    let mini = selected_target(&fake, &caller, None, Some("mini"))
        .await
        .unwrap();
    assert_eq!(mini.urls, ["http://mini.invalid"]);
    assert_eq!(
        selected_target(&fake, &caller, None, Some("pi"))
            .await
            .unwrap_err(),
        "no backend named pi; the home backend lists mac, mini"
    );
    assert_eq!(
        selected_target(&fake, &caller, None, None).await.unwrap(),
        Target::home("http://home.invalid")
    );
    assert_eq!(
        selected_target(&fake, &caller, Some("http://x/y"), None)
            .await
            .unwrap_err(),
        "--backend must be an http(s) origin, got http://x/y"
    );
    let d = dir.to_string_lossy().into_owned();
    assert_eq!(
        repo_id(&fake, "./shop", &mini, &d).await.unwrap(),
        "web/shop"
    );
    assert_eq!(repo_id(&fake, "shop", &mini, &d).await.unwrap(), "shop");
    assert_eq!(
        repo_id(&fake, "./nope", &mini, &d).await.unwrap_err(),
        "no such folder: ./nope"
    );
    assert_eq!(
        repo_id(&fake, ".", &mini, &format!("{d}/shop/.."))
            .await
            .unwrap_err(),
        format!(
            "mini does not scan {}",
            std::fs::canonicalize(&dir).unwrap().to_string_lossy()
        )
    );
    let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err::<Value, AskError>(AskError::Unreachable("http://home.invalid: refused".into()))
    });
    assert_eq!(
        selected_target(&down, &caller, None, Some("mini"))
            .await
            .unwrap_err(),
        "home did not answer: http://home.invalid: refused"
    );
    assert_eq!(
        repo_id(&down, "./shop", &mini, &d).await.unwrap_err(),
        "mini did not answer: http://home.invalid: refused"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_start_refuses_before_the_backend_is_asked() {
    for (a, why) in [
        (argv(&["app"]), RUN_USAGE.to_string()),
        (argv(&["app", "ask", "extra"]), RUN_USAGE.to_string()),
        (argv(&["app", "build"]), "unknown run action: build".into()),
        (
            argv(&["app", "ask", "--backend"]),
            "--backend needs a value".into(),
        ),
        (argv(&["app", "ask", "--on"]), "--on needs a value".into()),
        (argv(&["app", "ask", "-m"]), "-m needs a note".into()),
        (
            argv(&["app", "ask", "--backend", "http://x/y"]),
            "--backend must be an http(s) origin, got http://x/y".into(),
        ),
        (
            argv(&["app", "ask", "--backend", "http://x", "--on", "m"]),
            "use either --backend URL or --on NAME".into(),
        ),
        (
            argv(&["app", "ask", "--times", "1.5"]),
            "--times must be 1, 2, or 3".into(),
        ),
        (
            argv(&["app", "ask", "--auto-land"]),
            "--auto-land requires --times 2 or 3".into(),
        ),
        (
            argv(&["pickup", "--backend", "http://x", "--on", "m"]),
            "use either --backend URL or --on NAME".into(),
        ),
        (argv(&["pickup"]), RUN_USAGE.into()),
        (argv(&["pickup", "f-1", "f-2"]), RUN_USAGE.into()),
        (argv(&["-m", "x", "pickup", "f-1"]), RUN_USAGE.into()),
    ] {
        let got = run_on(a.clone(), |_, _, _| Ok(json!({}))).await;
        assert_eq!(got.failed(), Some(why.as_str()), "{a:?}");
        assert!(got.seen.is_empty(), "{a:?} asked the backend");
    }
}

#[tokio::test]
async fn a_start_reads_a_path_from_the_tree_and_names_a_backend_that_did_not_answer() {
    let tree = json!({"repos": [{"id": "web/app", "path": "/"}]});
    let got = run_on(with_backend(&["/", "ask", "-m", "x"]), move |m, p, _| {
        Ok(match (m, p) {
            ("GET", "/api/tree") => tree.clone(),
            _ => json!({"id": "run-1", "status": "working"}),
        })
    })
    .await;
    assert_eq!(got.routes(), ["GET /api/tree", "POST /api/repos/run"]);
    assert_eq!(got.seen[1].1, "/api/repos/run?id=web%2Fapp");
    let got = run_on(with_backend(&["app", "ask"]), |_, _, _| {
        Err(AskError::Unreachable("http://b.invalid:1: refused".into()))
    })
    .await;
    assert_eq!(
        got.failed(),
        Some("home did not answer: http://b.invalid:1: refused")
    );
    let got = run_on(with_backend(&["app", "ask", "--times", "2"]), |_, _, _| {
        Ok(json!({"id": "run-1", "status": "working"}))
    })
    .await;
    assert_eq!(
        got.failed(),
        Some("the backend did not return a group record")
    );
}

#[tokio::test]
async fn runs_child_starts_beside_its_parent_and_says_on_which_branch() {
    let seen: Mutex<Vec<Seen>> = Mutex::default();
    let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
        seen.lock()
            .unwrap()
            .push((m.to_string(), p.to_string(), b.cloned()));
        Ok::<Value, AskError>(json!({"id": "c-1", "branch": {"name": "run/part-c-1"}}))
    });
    let mut out = Out::default();
    let caller = Caller::default();
    let a = argv(&[
        "child",
        "app",
        "--note",
        "a part",
        "--parent",
        "ab12cd34",
        "--action",
        "propose",
        "--backend",
        BACKEND,
    ]);
    runs_cmd(a, &caller, &fake, &mut out, "/").await.unwrap();
    assert_eq!(
        out.printed(),
        ["started run c-1 on run/part-c-1, child of ab12cd34"]
    );
    assert_eq!(
        seen.lock().unwrap()[0],
        (
            "POST".to_string(),
            "/api/runs/child".to_string(),
            Some(
                json!({"repo": "app", "note": "a part", "parent": "ab12cd34", "action": "propose"})
            )
        )
    );
    let bare = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Ok::<Value, AskError>(json!({"id": "c-2"}))
    });
    let mut out = Out::default();
    let a = argv(&["child", "app", "--note", "x", "--parent", "p"]);
    runs_cmd(a, &caller, &bare, &mut out, "/").await.unwrap();
    assert_eq!(out.printed(), ["started run c-2 on its branch, child of p"]);
    let refused = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err::<Value, AskError>(AskError::Refused {
            message: "no run p on this backend".into(),
            status: 404,
        })
    });
    let a = argv(&["child", "app", "--note", "x", "--parent", "p"]);
    assert_eq!(
        runs_cmd(a, &caller, &refused, &mut Out::default(), "/").await,
        Err("no run p on this backend".into())
    );
    let a = argv(&[
        "child",
        "app",
        "--note",
        "x",
        "--parent",
        "p",
        "--backend",
        "x",
    ]);
    assert_eq!(
        runs_cmd(a, &caller, &refused, &mut Out::default(), "/").await,
        Err("--backend must be an http(s) origin, got x".into())
    );
}
