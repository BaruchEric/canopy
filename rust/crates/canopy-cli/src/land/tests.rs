//! land.test.ts's cases. The TypeScript builds its entries with the
//! queue's own `enqueue` and `advance`, which are not ported; these write
//! the entries those calls make.

use super::*;
use crate::ask::tests::Fake;
use std::sync::Mutex;

fn rec(id: &str, over: Value) -> Value {
    let mut r = json!({
        "id": id, "runId": format!("r-{id}"), "repoId": "dev-tools/canopy",
        "repoPath": "/dev/dev-tools/canopy", "branch": format!("run/x-{id}"), "target": "main",
        "base": "b0", "dir": format!("/w/{id}"), "note": "n", "verb": "Ask", "harness": "claude",
        "state": "ready", "startedAt": 1,
    });
    merge(&mut r, over);
    r
}

/// `entryFor(rec(id), at)` with `over` laid on, as `advance` leaves it.
fn entry(id: &str, at: u64, over: Value) -> Value {
    let mut e = json!({
        "id": id, "repoId": "dev-tools/canopy", "repoPath": "/dev/dev-tools/canopy",
        "branch": format!("run/x-{id}"), "target": "main", "dir": format!("/w/{id}"), "note": "n",
        "state": "queued", "tries": 0, "queuedAt": at, "updatedAt": at,
    });
    merge(&mut e, over);
    e
}

fn merge(v: &mut Value, over: Value) {
    if let (Some(m), Value::Object(o)) = (v.as_object_mut(), over) {
        m.extend(o);
    }
}

fn sorted(verdict: &str, over: Value) -> Value {
    let mut r = json!({"verdict": verdict, "files": [], "base": "b0b0b0b0b0b0b0", "head": "h1h1h1h1h1h1h1", "at": 1});
    merge(&mut r, over);
    r
}

#[test]
fn a_queue_in_order_then_what_came_back_then_what_is_ready() {
    let entries = json!([
        entry("a", 1, json!({"state": "gate", "gate": "lint"})),
        entry("b", 2, json!({})),
        entry(
            "c",
            3,
            json!({"state": "red", "gate": "test", "reason": "lots\n1 fail"})
        ),
    ]);
    let info = json!({"runs": [rec("a", json!({})), rec("b", json!({})), rec("c", json!({})), rec("d", json!({})), rec("e", json!({"state": "working"}))], "entries": entries, "orphans": []});
    assert_eq!(
        queue_lines(&info, None, ""),
        [
            "dev-tools/canopy",
            "  gate: lint       run/x-a",
            "  queued 2nd       run/x-b",
            "  red: test        run/x-c  test failed",
            "  ready            run/x-d  sorting  canopy land r-d",
        ]
    );
    assert_eq!(
        queue_lines(&info, Some("canopy"), "mini")[0],
        "dev-tools/canopy on mini"
    );
    assert!(queue_lines(&info, Some("other"), "").is_empty());
}

#[test]
fn an_overlap_under_its_line_and_the_collisions() {
    let entries = json!([entry(
        "a",
        1,
        json!({"overlap": {"with": "Ask run k", "paths": ["a.ts"]}})
    )]);
    let c = json!({"id": "x+checkout", "repoId": "dev-tools/canopy", "run": "x", "name": "run/x-x", "with": {"kind": "checkout"}, "paths": ["c.ts"], "at": 1});
    let info = json!({"runs": [rec("a", json!({}))], "entries": entries, "orphans": [], "collisions": [c]});
    assert_eq!(
        queue_lines(&info, None, ""),
        [
            "dev-tools/canopy",
            "  queued 1st       run/x-a",
            "    overlaps with Ask run k: a.ts"
        ]
    );
    let collided = [
        "dev-tools/canopy",
        "  run/x-x and your uncommitted changes: c.ts",
    ];
    assert_eq!(collision_lines(&info, None, ""), collided);
    assert_eq!(
        collision_lines(&info, Some("canopy"), "mini"),
        [
            "dev-tools/canopy on mini",
            "  run/x-x and your uncommitted changes: c.ts"
        ]
    );
    let mut bare = info.clone();
    bare["runs"] = json!([]);
    bare["entries"] = json!([]);
    assert_eq!(collision_lines(&bare, Some("canopy"), ""), collided);
    assert!(collision_lines(&info, Some("other"), "").is_empty());
    let ready = json!({"runs": [rec("d", json!({"overlap": {"with": "run/x-e", "paths": ["a.ts", "notes.md"]}}))], "entries": [], "orphans": []});
    assert_eq!(
        queue_lines(&ready, None, ""),
        [
            "dev-tools/canopy",
            "  ready            run/x-d  sorting  canopy land r-d",
            "    overlaps with run/x-e: a.ts, notes.md"
        ]
    );
}

#[test]
fn each_ready_verdict_and_an_entry_that_joined_on_its_own() {
    let entries = json!([
        entry("a", 1, json!({"auto": true})),
        entry("b", 2, json!({"approved": "p1"}))
    ]);
    let info = json!({"runs": [
        rec("a", json!({})), rec("b", json!({})),
        rec("c", json!({"review": sorted("auto", json!({}))})),
        rec("d", json!({"review": sorted("land", json!({"why": "no gates to run"}))})),
        rec("e", json!({"review": sorted("approve", json!({"files": [{"path": "s.ts", "cls": "logic", "sensitive": "x"}]}))})),
    ], "entries": entries, "orphans": []});
    assert_eq!(
        queue_lines(&info, None, ""),
        [
            "dev-tools/canopy",
            "  queued 1st       run/x-a  joined on its own",
            "  queued 2nd       run/x-b  approved",
            "  ready            run/x-c  lands on its own  canopy land r-c",
            "  ready            run/x-d  needs your land: no gates to run  canopy land r-d",
            "  ready            run/x-e  needs your approval: 1 sensitive file  canopy land r-e",
        ]
    );
}

#[test]
fn a_stopped_run_can_land_only_when_its_work_is_whole() {
    let info = json!({"runs": [
        rec("a", json!({"state": "stopped", "whole": {"ok": true}, "review": sorted("land", json!({}))})),
        rec("b", json!({"state": "stopped", "whole": {"ok": false, "why": "changes left uncommitted"}})),
        rec("c", json!({"state": "stopped"})),
        rec("q", json!({"state": "stopped", "whole": {"ok": true}})),
    ], "entries": [entry("q", 1, json!({}))], "orphans": []});
    assert_eq!(
        queue_lines(&info, None, ""),
        [
            "dev-tools/canopy",
            "  queued 1st       run/x-q",
            "  stopped          run/x-a  can land: needs your land  canopy land r-a"
        ]
    );
}

#[test]
fn an_approval_names_the_files_how_to_look_and_the_command() {
    let review = sorted(
        "approve",
        json!({"sensitiveId": "abc123", "files": [
            {"path": "README.md", "cls": "docs"},
            {"path": "scripts/go.sh", "cls": "logic", "sensitive": "matches scripts/** in .canopy/review.json"},
            {"path": "tools/x.sh", "from": "scripts/x.sh", "cls": "logic", "why": "renamed from scripts/x.sh", "sensitive": "moved from scripts/x.sh: matches scripts/**"},
        ]}),
    );
    assert_eq!(
        approve_lines(&rec("a", json!({ "review": review }))),
        [
            "run/x-a needs your approval: 2 sensitive files:",
            "  scripts/go.sh  matches scripts/** in .canopy/review.json",
            "  scripts/x.sh -> tools/x.sh  moved from scripts/x.sh: matches scripts/**",
            "look: git -C /w/a diff b0b0b0b0b0b0 h1h1h1h1h1h1 -- scripts/go.sh scripts/x.sh tools/x.sh",
            "then: canopy land r-a --approve abc123",
        ]
    );
    assert_eq!(
        approve_lines(&rec("b", json!({}))),
        ["run/x-b is not sorted yet; try again in a moment"]
    );
}

#[test]
fn a_judge_hold_names_the_bypass_and_a_low_score_its_observations() {
    let held = entry(
        "a",
        1,
        json!({"state": "judge", "gate": "refund", "reason": "scenario refund needs a judge: no gateway key", "updatedAt": 2}),
    );
    let low = entry(
        "b",
        1,
        json!({"state": "red", "gate": "satisfaction 0.73 < 1", "reason": "scenario refund: partly\nrefund 42: no", "updatedAt": 2}),
    );
    let lines = queue_lines(
        &json!({"runs": [], "entries": [held, low], "orphans": []}),
        None,
        "",
    );
    assert!(lines[1].contains("needs a judge"));
    assert!(lines[1].contains("land anyway: canopy land a --skip-judge"));
    assert!(lines[2].contains("satisfaction 0.73 < 1"));
    assert!(lines[2].contains("refund 42: no"));
    assert!(!lines[2].contains("failed"));
}

/// The command against a fake home: what it printed, what it posted, and
/// its failure.
async fn drive(
    argv: &[&str],
    answer: impl Fn(&str, &str) -> Result<Value, AskError>,
) -> (String, Vec<String>, Option<String>) {
    let seen = Mutex::new(Vec::new());
    let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
        if m == "POST" {
            seen.lock().unwrap().push(format!(
                "{p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
        }
        answer(m, p)
    });
    let mut out = Out::default();
    let args = argv.iter().map(|s| s.to_string()).collect();
    let r = land_cmd("land", args, &Caller::default(), &fake, &mut out).await;
    (out.text, seen.into_inner().unwrap(), r.err())
}

#[tokio::test]
async fn skip_judge_posts_the_bypass() {
    let (text, posted, failed) = drive(&["r-a", "--skip-judge"], |_, _| {
        Ok(entry("a", 1, json!({})))
    })
    .await;
    assert_eq!(failed, None);
    assert_eq!(
        posted,
        ["/api/landing/land {\"run\":\"r-a\",\"skipJudge\":true}"]
    );
    assert_eq!(
        text,
        "run/x-a: queued again with the judge scenarios left out; the queue rebases it onto main, runs the gates and the command scenarios, and fast-forwards main\n"
    );
}

#[tokio::test]
async fn followup_posts_the_id_and_note_and_prints_the_run() {
    let (text, posted, failed) = drive(&["followup", "run/x-a", "-m", "tidy"], |_, _| {
        Ok(json!({"run": {"id": "r-new"}}))
    })
    .await;
    assert_eq!(failed, None);
    assert_eq!(
        posted,
        ["/api/landing/followup {\"id\":\"run/x-a\",\"note\":\"tidy\"}"]
    );
    assert_eq!(text, "r-new\n");
    let (_, _, failed) = drive(&["followup", "run/x-a"], |_, _| {
        Err(AskError::Refused {
            message: "no branch run/x-a".into(),
            status: 404,
        })
    })
    .await;
    assert_eq!(failed.as_deref(), Some("no branch run/x-a"));
    let (_, _, failed) = drive(&["followup", "b", "-m"], |_, _| Ok(json!({}))).await;
    assert_eq!(failed.as_deref(), Some("-m needs words"));
}

#[tokio::test]
async fn a_land_that_needs_an_approval_prints_the_files_then_fails() {
    let review = sorted(
        "approve",
        json!({"sensitiveId": "s1", "files": [{"path": "a.sh", "cls": "logic", "sensitive": "scripts"}]}),
    );
    let (text, _, failed) = drive(&["r-a"], move |m, _| {
        if m == "POST" {
            Err(AskError::Refused {
                message: "it needs your approval: 1 sensitive file; look at the files and approve"
                    .into(),
                status: 409,
            })
        } else {
            Ok(json!({"runs": [rec("a", json!({ "review": review.clone() }))]}))
        }
    })
    .await;
    assert_eq!(
        text,
        "run/x-a needs your approval: 1 sensitive file:\n  a.sh  scripts\nlook: git -C /w/a diff b0b0b0b0b0b0 h1h1h1h1h1h1 -- a.sh\nthen: canopy land r-a --approve s1\n"
    );
    assert_eq!(
        failed.as_deref(),
        Some("it needs your approval; look at the files, then run the command above")
    );
}
