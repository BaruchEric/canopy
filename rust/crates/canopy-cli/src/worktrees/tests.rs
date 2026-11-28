//! worktrees.test.ts's cases. Its Bun.serve backend is a fake here that
//! keeps the same answers and records each request's method, path and body.

use super::*;
use crate::ask::tests::Fake;
use std::sync::Mutex;

const H: f64 = 3_600_000.0;

fn info() -> Value {
    json!({
        "root": "/w",
        "free": 42.1 * GB,
        "repos": [
            {
                "repoId": "dev-tools/canopy",
                "repoPath": "/dev/dev-tools/canopy",
                "want": 2,
                "fileWarm": 1,
                "runs": [{"dir": "/w/canopy-abc/ab12cd34", "id": "ab12cd34", "runId": "r1", "branch": "run/fix-x-ab12cd34", "state": "working"}],
                "warm": [{"dir": "/w/canopy-abc/warm-1", "name": "warm-1", "base": "1ac8fe7deadbeef", "madeAt": 1000.0 - 2.0 * H, "size": 312 * 1_048_576, "lockfile": null}],
                "refilling": "warm-2",
                "fails": [],
                "orphans": ["/w/canopy-abc/zz"],
            },
            {"repoId": "x", "repoPath": "/dev/x", "want": 1, "runs": [], "warm": [], "refilling": null, "fails": [{"name": "warm-1", "why": "bun install exited 1", "at": 5, "fails": 2}], "orphans": []},
            {"repoId": "quiet", "repoPath": "/dev/quiet", "want": 0, "runs": [], "warm": [], "refilling": null, "fails": [], "orphans": []},
        ],
    })
}

fn tree(over: Value) -> Value {
    let mut t = json!({
        "slug": "feat-x", "dir": "/t/canopy-abc/feat-x", "branch": "feat/x", "base": "main",
        "port": 7912, "madeAt": 0, "caches": true, "state": "ready", "sync": true,
        "head": "abc1234", "ahead": 0, "behind": 0, "files": 0, "shells": 0,
    });
    if let (Some(m), Value::Object(o)) = (t.as_object_mut(), over) {
        m.extend(o);
    }
    t
}

fn trees() -> Value {
    json!({
        "root": "/t",
        "ports": "7900-7949",
        "repos": [
            {"repoId": "dev-tools/canopy", "repoPath": "/dev/dev-tools/canopy", "trees": [tree(json!({"ahead": 2, "files": 1, "shells": 1}))]},
            {"repoId": "x", "repoPath": "/dev/x", "trees": []},
            {"repoId": "quiet", "repoPath": "/dev/quiet", "trees": [tree(json!({"slug": "fix", "dir": "/t/quiet-abc/fix", "branch": "fix", "port": null, "state": "preparing", "head": ""}))]},
        ],
    })
}

#[test]
fn worktree_lines_list_each_repo_then_free_disk() {
    assert_eq!(
        worktree_lines(&info(), None, 1000.0, None),
        [
            "dev-tools/canopy  2 warm wanted (the gates file says 1)",
            "  run     run/fix-x-ab12cd34  working  /w/canopy-abc/ab12cd34",
            "  warm    warm-1  1ac8fe7  2h  312 MB",
            "  warm    warm-2  refilling",
            "  orphan  /w/canopy-abc/zz",
            "x  1 warm wanted",
            "  warm    warm-1  failed 2x: bun install exited 1",
            "free 42.1 GB under /w",
        ]
    );
    assert_eq!(
        worktree_lines(&info(), Some("quiet"), 1000.0, None),
        ["quiet  nothing kept", "free 42.1 GB under /w"]
    );
    assert_eq!(
        worktree_lines(&info(), Some("canopy"), 1000.0, None)[0],
        "dev-tools/canopy  2 warm wanted (the gates file says 1)"
    );
}

#[test]
fn worktree_lines_lists_the_kept_trees_under_their_repo_and_a_repo_with_only_trees() {
    let t = trees();
    assert_eq!(
        worktree_lines(&info(), None, 1000.0, Some(&t)),
        [
            "dev-tools/canopy  2 warm wanted (the gates file says 1)",
            "  run     run/fix-x-ab12cd34  working  /w/canopy-abc/ab12cd34",
            "  tree    feat/x  ↑2 ●1 :7912 1 shell  /t/canopy-abc/feat-x",
            "  warm    warm-1  1ac8fe7  2h  312 MB",
            "  warm    warm-2  refilling",
            "  orphan  /w/canopy-abc/zz",
            "x  1 warm wanted",
            "  warm    warm-1  failed 2x: bun install exited 1",
            "quiet  1 tree kept",
            "  tree    fix  preparing  /t/quiet-abc/fix",
            "free 42.1 GB under /w",
        ]
    );
    assert_eq!(
        worktree_lines(&info(), Some("quiet"), 1000.0, Some(&t)),
        [
            "quiet  1 tree kept",
            "  tree    fix  preparing  /t/quiet-abc/fix",
            "free 42.1 GB under /w"
        ]
    );
    // a repo the pool never listed
    let mut elsewhere = trees();
    elsewhere["repos"] = json!([{"repoId": "y", "repoPath": "/dev/y", "trees": [tree(json!({}))]}]);
    let mut none = info();
    none["repos"] = json!([]);
    assert_eq!(
        worktree_lines(&none, None, 1000.0, Some(&elsewhere)),
        [
            "y  1 tree kept",
            "  tree    feat/x  clean :7912  /t/canopy-abc/feat-x",
            "free 42.1 GB under /w"
        ]
    );
}

#[test]
fn age_word_and_size_word() {
    assert_eq!(
        [
            age_word(10_000.0),
            age_word(5.0 * 60_000.0),
            age_word(2.0 * H),
            age_word(72.0 * H)
        ],
        ["now", "5m", "2h", "3d"]
    );
    assert_eq!(
        [size_word(312.0 * 1_048_576.0), size_word(1.2 * GB)],
        ["312 MB", "1.2 GB"]
    );
}

#[test]
fn size_word_rounds_and_groups_as_intl_does() {
    assert_eq!(intl_one_place(0.15), "0.2");
    assert_eq!(intl_one_place(1.45), "1.5");
    assert_eq!(intl_one_place(0.95), "1");
    assert_eq!(intl_one_place(1234.5), "1,234.5");
    assert_eq!(intl_one_place(1_234_567.89), "1,234,567.9");
    assert_eq!(intl_one_place(999.96), "1,000");
    assert_eq!(intl_one_place(0.04), "0");
    assert_eq!(intl_one_place(f64::NAN), "NaN");
    assert_eq!(age_word(f64::NAN), "NaNd");
    assert_eq!(age_word(-5.0), "now");
}

fn run_sync(args: &[&str], ask: &impl Ask) -> (Result<(), String>, String) {
    let caller = caller();
    let mut out = Out::default();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let r = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(worktrees_cmd(args, &caller, ask, &mut out, Duration::ZERO));
    (r, out.text)
}

fn caller() -> Caller {
    Caller {
        config_dir: "/nonexistent/canopy-worktrees-test".into(),
        env_api: Some("http://home:7".into()),
        ..Default::default()
    }
}

fn nobody() -> impl Ask {
    Fake(
        |_: &Target, m: &str, p: &str, _: Option<&Value>| -> Result<Value, AskError> {
            panic!("asked {m} {p}")
        },
    )
}

#[test]
fn shell_init_prints_a_cw_function_that_cds_by_branch_and_needs_no_backend() {
    let (r, out) = run_sync(&["shell-init"], &nobody());
    assert_eq!(r, Ok(()));
    assert_eq!(out, SHELL_INIT);
    assert!(SHELL_INIT.contains(r#"cd "$dir" || return"#));
    assert!(SHELL_INIT.contains(r#"canopy worktrees path "$(basename "$PWD")" "$1""#));
    let (r, _) = run_sync(&["shell-init", "extra"], &nobody());
    assert!(r.unwrap_err().contains("usage"));
}

/// The TypeScript test's server: what it answers, what it saw.
struct Server {
    trees_known: bool,
    feat_gone: bool,
    fix_stopped: bool,
    seen: Vec<Value>,
}

impl Server {
    fn answer(&mut self, m: &str, p: &str, body: Option<&Value>) -> Result<Value, AskError> {
        let mut s = json!({"method": m, "path": p});
        if let Some(b) = body {
            s["body"] = b.clone();
        }
        self.seen.push(s);
        let b = body.cloned().unwrap_or(Value::Null);
        let refused = |msg: &str, status: u16| {
            Err(AskError::Refused {
                message: msg.into(),
                status,
            })
        };
        match (m, p) {
            ("GET", "/api/worktrees") => Ok(info()),
            (_, "/api/worktrees/warm") => {
                let n = b.get("n").cloned().unwrap_or(json!(1));
                Ok(json!({"repo": b["repo"], "want": n}))
            }
            (_, "/api/worktrees/prune") => Ok(
                json!({"removed": if b.get("repo").is_some() { json!([]) } else { json!(["/w/orphan", "/w/stale-warm"]) }}),
            ),
            ("GET", "/api/trees") => {
                if !self.trees_known {
                    return refused("not found", 404);
                }
                let mut t = trees();
                for r in t["repos"].as_array_mut().unwrap() {
                    if r["repoId"] == "dev-tools/canopy" && self.feat_gone {
                        r["trees"] = json!([]);
                    } else if r["repoId"] == "quiet" && self.fix_stopped {
                        for x in r["trees"].as_array_mut().unwrap() {
                            x["state"] = json!("ready");
                            x["stopped"] = json!("merge stopped: gate test exited 1");
                        }
                    }
                }
                Ok(t)
            }
            (_, "/api/trees/add") => Ok(
                json!({"tree": tree(json!({"branch": b["branch"], "slug": "new", "dir": "/t/canopy-abc/new", "state": "preparing", "port": 7903}))}),
            ),
            (_, "/api/trees/remove") => {
                if b["tree"] == "feat/x" && !truthy(b.get("force")) {
                    return refused(
                        "the tree holds 1 changed file; remove it with force to lose that",
                        409,
                    );
                }
                Ok(json!({"removed": "feat-x"}))
            }
            (_, "/api/trees/merge") => {
                let fix = b["tree"] == "fix";
                if fix {
                    self.fix_stopped = true;
                } else if !truthy(b.get("keep")) {
                    self.feat_gone = true;
                }
                let all = trees();
                let mut t = if fix {
                    all["repos"][2]["trees"][0].clone()
                } else {
                    all["repos"][0]["trees"][0].clone()
                };
                t["state"] = json!("merging");
                Ok(json!({"tree": t}))
            }
            (_, "/api/trees/clean") => Ok(
                json!({"removed": if b.get("repo").is_some() { json!([]) } else { json!([{"repoId": "dev-tools/canopy", "slug": "feat-x", "branch": "feat/x"}]) }}),
            ),
            (_, "/api/trees/sync") => {
                if b["tree"] == "fix" {
                    return refused(
                        "sync stopped: the rebase onto main stopped on a.txt and was aborted; rebase by hand in the tree",
                        409,
                    );
                }
                Ok(json!({"tree": tree(json!({"ahead": 2, "files": 1, "shells": 1}))}))
            }
            (_, "/api/trees/auto") => Ok(json!({"tree": tree(json!({"sync": b["sync"]}))})),
            _ => refused("unexpected request", 404),
        }
    }
}

#[test]
fn the_worktrees_cli_uses_the_home_backend_resolves_repo_names_and_sends_exact_bodies() {
    let server = Mutex::new(Server {
        trees_known: false,
        feat_gone: false,
        fix_stopped: false,
        seen: Vec::new(),
    });
    let fake = Fake(|t: &Target, m: &str, p: &str, b: Option<&Value>| {
        assert_eq!(t, &Target::home("http://home:7"));
        server.lock().unwrap().answer(m, p, b)
    });
    let ok = |args: &[&str], want: &[&str]| {
        let (r, out) = run_sync(args, &fake);
        assert_eq!(r, Ok(()), "{args:?}");
        let lines: String = want.iter().map(|l| format!("{l}\n")).collect();
        assert_eq!(out, lines, "{args:?}");
    };
    let refused = |args: &[&str], words: &str| {
        let (r, _) = run_sync(args, &fake);
        let e = r.unwrap_err();
        assert!(e.contains(words), "{args:?}: {e}");
    };

    ok(
        &["quiet"],
        &["quiet  nothing kept", "free 42.1 GB under /w"],
    );
    let (_, out) = run_sync(&["--json"], &fake);
    assert_eq!(
        out,
        format!("{}\n", serde_json::to_string_pretty(&info()).unwrap())
    );

    server.lock().unwrap().trees_known = true;
    ok(
        &["quiet"],
        &[
            "quiet  1 tree kept",
            "  tree    fix  preparing  /t/quiet-abc/fix",
            "free 42.1 GB under /w",
        ],
    );
    let (_, out) = run_sync(&["--json"], &fake);
    let mut both = info();
    both["trees"] = trees();
    assert_eq!(
        out,
        format!("{}\n", serde_json::to_string_pretty(&both).unwrap())
    );

    ok(&["warm", "canopy"], &["dev-tools/canopy: 1 warm"]);
    ok(
        &["warm", "dev-tools/canopy", "2"],
        &["dev-tools/canopy: 2 warm"],
    );
    ok(&["prune"], &["/w/orphan", "/w/stale-warm"]);
    ok(&["prune", "canopy"], &["nothing to prune"]);
    ok(
        &[
            "add",
            "canopy",
            "feat/y",
            "--base",
            "v2",
            "--no-caches",
            "--no-sync",
        ],
        &[
            "feat/y  /t/canopy-abc/new  :7903",
            "preparing: the setup line runs and the caches clone in the background; canopy worktrees shows when it is ready",
        ],
    );
    ok(&["path", "canopy", "feat/x"], &["/t/canopy-abc/feat-x"]);
    ok(&["path", "quiet", "fix"], &["/t/quiet-abc/fix"]);
    refused(
        &["path", "canopy", "nope"],
        "dev-tools/canopy keeps no tree on nope",
    );
    refused(&["rm", "canopy", "feat/x"], "remove it with force");
    ok(
        &["rm", "canopy", "feat/x", "--force", "--delete-branch"],
        &["removed feat-x and the branch feat/x"],
    );
    ok(
        &["merge", "canopy", "feat/x", "--keep", "--no-squash"],
        &[
            "merging feat/x into main…",
            "merged feat/x into main; the tree stays at /t/canopy-abc/feat-x",
        ],
    );
    ok(
        &["merge", "canopy", "feat/x"],
        &[
            "merging feat/x into main, squashed…",
            "merged feat/x into main; the tree and its branch are gone",
        ],
    );
    let (r, out) = run_sync(&["merge", "quiet", "fix", "--no-commit"], &fake);
    assert_eq!(r, Err("merge stopped: gate test exited 1".into()));
    assert_eq!(out, "merging fix into main, squashed…\n");
    ok(
        &["clean"],
        &["removed dev-tools/canopy  feat/x  and its branch"],
    );
    ok(
        &["clean", "canopy"],
        &["nothing to clean: no tree is merged into its base with nothing changed or open in it"],
    );
    ok(
        &["sync", "canopy", "feat/x"],
        &["synced feat/x onto main  ↑2 ●1 :7912 1 shell"],
    );
    refused(
        &["sync", "quiet", "fix"],
        "sync stopped: the rebase onto main stopped on a.txt",
    );
    ok(
        &["auto", "canopy", "feat/x", "off"],
        &["feat/x stays where it is while main moves"],
    );
    ok(
        &["auto", "canopy", "feat/x", "on"],
        &["feat/x follows main"],
    );

    let g = |p: &str| json!({"method": "GET", "path": p});
    let post = |p: &str, b: Value| json!({"method": "POST", "path": p, "body": b});
    let w = || g("/api/worktrees");
    let t = || g("/api/trees");
    let want = vec![
        w(),
        t(),
        w(),
        t(),
        w(),
        t(),
        w(),
        t(),
        w(),
        post("/api/worktrees/warm", json!({"repo": "dev-tools/canopy"})),
        w(),
        post(
            "/api/worktrees/warm",
            json!({"repo": "dev-tools/canopy", "n": 2}),
        ),
        post("/api/worktrees/prune", json!({})),
        w(),
        post("/api/worktrees/prune", json!({"repo": "dev-tools/canopy"})),
        w(),
        post(
            "/api/trees/add",
            json!({"repo": "dev-tools/canopy", "branch": "feat/y", "base": "v2", "caches": false, "sync": false}),
        ),
        w(),
        t(),
        w(),
        t(),
        w(),
        t(),
        w(),
        post(
            "/api/trees/remove",
            json!({"repo": "dev-tools/canopy", "tree": "feat/x"}),
        ),
        w(),
        post(
            "/api/trees/remove",
            json!({"repo": "dev-tools/canopy", "tree": "feat/x", "force": true, "deleteBranch": true}),
        ),
        w(),
        post(
            "/api/trees/merge",
            json!({"repo": "dev-tools/canopy", "tree": "feat/x", "squash": false, "keep": true}),
        ),
        t(),
        w(),
        post(
            "/api/trees/merge",
            json!({"repo": "dev-tools/canopy", "tree": "feat/x"}),
        ),
        t(),
        w(),
        post(
            "/api/trees/merge",
            json!({"repo": "quiet", "tree": "fix", "commit": false}),
        ),
        t(),
        post("/api/trees/clean", json!({})),
        w(),
        post("/api/trees/clean", json!({"repo": "dev-tools/canopy"})),
        w(),
        post(
            "/api/trees/sync",
            json!({"repo": "dev-tools/canopy", "tree": "feat/x"}),
        ),
        w(),
        post("/api/trees/sync", json!({"repo": "quiet", "tree": "fix"})),
        w(),
        post(
            "/api/trees/auto",
            json!({"repo": "dev-tools/canopy", "tree": "feat/x", "sync": false}),
        ),
        w(),
        post(
            "/api/trees/auto",
            json!({"repo": "dev-tools/canopy", "tree": "feat/x", "sync": true}),
        ),
    ];
    let seen = server.lock().unwrap().seen.clone();
    assert_eq!(seen, want);
    // the bodies go in the order the TypeScript writes their keys
    let add = seen.iter().find(|s| s["path"] == "/api/trees/add").unwrap();
    assert_eq!(
        add["body"].to_string(),
        r#"{"repo":"dev-tools/canopy","branch":"feat/y","base":"v2","caches":false,"sync":false}"#
    );
}

#[test]
fn a_backend_that_does_not_answer_is_named_home_and_one_without_trees_still_lists() {
    let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable("http://home:7: ECONNREFUSED".into()))
    });
    assert_eq!(
        run_sync(&[], &down).0,
        Err("home did not answer: http://home:7: ECONNREFUSED".into())
    );
    assert_eq!(
        run_sync(&["x", "--backend", "http://x/y"], &nobody()).0,
        Err("--backend must be an http(s) origin, got http://x/y".into())
    );
    assert_eq!(
        run_sync(&["--backend"], &nobody()).0,
        Err("--backend needs a value".into())
    );
    assert_eq!(
        run_sync(&["add", "a", "b", "--base"], &nobody()).0,
        Err("--base needs a ref".into())
    );
    assert_eq!(
        run_sync(&["warm", "a", "3"], &nobody()).0,
        Err("warm must be a whole number from 0 to 2".into())
    );
    // trees unreachable after the pool answered is a failure too
    let half = Fake(|_: &Target, _: &str, p: &str, _: Option<&Value>| {
        if p == "/api/trees" {
            Err(AskError::Unreachable("gone".into()))
        } else {
            Ok(info())
        }
    });
    assert_eq!(
        run_sync(&[], &half).0,
        Err("home did not answer: gone".into())
    );
    let names = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        let mut i = info();
        i["repos"][1]["repoId"] = json!("other/canopy");
        i["repos"][1]["repoPath"] = json!("/elsewhere/canopy");
        Ok(i)
    });
    assert_eq!(
        run_sync(&["warm", "canopy"], &names).0,
        Err("canopy matches more than one repo: dev-tools/canopy, other/canopy; use an id".into())
    );
    assert_eq!(
        run_sync(&["warm", "nope"], &names).0,
        Err("no repo named nope".into())
    );
}

#[test]
fn invalid_worktree_arguments_are_refused_before_contacting_the_backend() {
    let base = "http://home:7";
    for args in [
        &["warm", "canopy", "3", "--backend", base][..],
        &["warm", "canopy", "0.5", "--backend", base],
        &["warm", "--backend", base],
        &["prune", "canopy", "extra", "--backend", base],
        &["add", "canopy", "--backend", base],
        &["add", "canopy", "feat", "--base", "--backend", base],
        &["add", "canopy", "feat", "extra", "--backend", base],
        &["rm", "canopy", "--backend", base],
        &["merge", "canopy", "--backend", base],
        &["merge", "canopy", "feat", "extra", "--backend", base],
        &["sync", "canopy", "--backend", base],
        &["sync", "canopy", "feat", "extra", "--backend", base],
        &["auto", "canopy", "feat", "--backend", base],
        &["auto", "canopy", "feat", "maybe", "--backend", base],
        &["clean", "canopy", "extra", "--backend", base],
        &["path", "canopy", "--backend", base],
        &["--backend"],
        &["--backend", base, "--backend", base],
    ] {
        // the fake panics on any request
        assert!(run_sync(args, &nobody()).0.is_err(), "{args:?}");
    }
}

#[test]
fn a_runs_branch_is_found_by_id_or_by_name_and_what_nothing_lists_passes_through() {
    let i = info();
    let entry = &i["repos"][0];
    assert_eq!(branch_id_of(Some(entry), "ab12cd34"), "ab12cd34");
    assert_eq!(branch_id_of(Some(entry), "run/fix-x-ab12cd34"), "ab12cd34");
    assert_eq!(branch_id_of(Some(entry), "run/later"), "run/later");
    assert_eq!(branch_id_of(None, "ab12cd34"), "ab12cd34");
}

#[test]
fn a_start_says_the_task_and_port_a_stop_says_the_task_and_an_unlisted_task_still_answers() {
    let t = json!({"id": "ab12cd34", "dir": "/w/x", "branch": "run/x"});
    let r = json!({"tasks": [], "errors": [], "trees": [{"name": "dev", "port": 7901, "tree": t}]});
    assert_eq!(
        tree_task_line(&r, "ab12cd34", None, true),
        "dev on :7901 in run/x"
    );
    assert_eq!(
        tree_task_line(&r, "ab12cd34", Some("dev"), false),
        "stopped dev in run/x"
    );
    let none = json!({"tasks": [], "errors": [], "trees": []});
    assert_eq!(
        tree_task_line(&none, "ab12cd34", None, false),
        "stopped the dev task"
    );
}

#[test]
fn start_and_stop_send_the_runs_branch_id_and_the_task_name() {
    let seen = Mutex::new(Vec::new());
    let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
        seen.lock()
            .unwrap()
            .push((m.to_string(), p.to_string(), b.cloned()));
        if m == "GET" {
            return Ok(info());
        }
        Ok(
            json!({"trees": [{"name": "dev", "port": 7901, "tree": {"id": "ab12cd34", "branch": "run/fix-x-ab12cd34"}}]}),
        )
    });
    let (r, out) = run_sync(&["start", "canopy", "run/fix-x-ab12cd34"], &fake);
    assert_eq!(r, Ok(()));
    assert_eq!(out, "dev on :7901 in run/fix-x-ab12cd34\n");
    let (_, out) = run_sync(&["stop", "canopy", "ab12cd34", "web"], &fake);
    assert_eq!(out, "stopped web\n");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen[1].1, "/api/repos/tasks?id=dev-tools%2Fcanopy");
    assert_eq!(
        seen[1].2.as_ref().unwrap().to_string(),
        r#"{"action":"start","worktree":"ab12cd34"}"#
    );
    assert_eq!(
        seen[3].2.as_ref().unwrap().to_string(),
        r#"{"action":"stop","worktree":"ab12cd34","name":"web"}"#
    );
    assert!(
        run_sync(&["start", "canopy", "x", "--json"], &nobody())
            .0
            .is_err()
    );
}

#[test]
fn a_runs_task_shows_under_the_run_with_its_port() {
    let mut with_task = info();
    with_task["repos"] = json!([with_task["repos"][0].clone()]);
    with_task["repos"][0]["runs"][0]["task"] =
        json!({"name": "dev", "status": "running", "port": 7901});
    assert!(
        worktree_lines(&with_task, None, 1000.0, None)
            .join("\n")
            .contains("task    dev  running  :7901")
    );
}

#[test]
fn a_path_names_the_repo_at_that_folder_never_a_repo_whose_id_ends_in_it() {
    let made = std::env::temp_dir().join(format!("canopy-wt-path-{}", std::process::id()));
    std::fs::create_dir_all(&made).unwrap();
    let dir = std::fs::canonicalize(&made)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut repos = info();
    repos["repos"] = json!([
        // dotclaude's id is "claude:.", whose last part is "."
        {"repoId": "claude:.", "repoPath": "/home/u/.claude", "want": 0, "runs": [], "warm": [], "refilling": null, "fails": [], "orphans": []},
        {"repoId": "dev-tools/canopy", "repoPath": dir, "want": 0, "runs": [], "warm": [], "refilling": null, "fails": [], "orphans": []},
    ]);
    assert_eq!(repo_id_in(&repos, &dir), Ok("dev-tools/canopy".into()));
    let cwd = std::env::current_dir().unwrap();
    let rel = canopy_core::pathx::relative(&cwd.to_string_lossy(), &dir);
    assert_eq!(
        repo_id_in(&repos, &format!("./{rel}")),
        Ok("dev-tools/canopy".into())
    );
    assert_eq!(repo_id_in(&repos, "canopy"), Ok("dev-tools/canopy".into()));
    let nope = format!("{dir}/nope");
    assert_eq!(
        repo_id_in(&repos, &nope),
        Err(format!("no such folder: {nope}"))
    );
    let tmp = std::env::temp_dir()
        .to_string_lossy()
        .trim_end_matches('/')
        .to_string();
    let real_tmp = std::fs::canonicalize(&tmp)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        repo_id_in(&repos, &tmp),
        Err(format!("no repo at {real_tmp}"))
    );
    std::fs::remove_dir_all(&made).unwrap();
}
