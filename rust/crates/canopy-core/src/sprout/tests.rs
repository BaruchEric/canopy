//! The cases of sprout.test.ts that cover what sprout.rs ports.

use super::*;
use serde_json::json;

fn gh(owner: &str, name: &str) -> Option<GithubRepo> {
    Some(GithubRepo {
        owner: owner.into(),
        name: name.into(),
    })
}

// describe("urlWithoutSecret")

#[test]
fn an_http_s_url_loses_its_userinfo_an_ssh_url_its_password_only_anything_else_is_as_given() {
    assert_eq!(
        url_without_secret("https://x:tok3n@github.com/a/b.git"),
        "https://github.com/a/b.git"
    );
    assert_eq!(
        url_without_secret("HTTP://tok3n@host:8080/r?q=a@b"),
        "HTTP://host:8080/r?q=a@b"
    );
    assert_eq!(
        url_without_secret("https://a:p@ss@host/r"),
        "https://host/r"
    );
    assert_eq!(
        url_without_secret("ssh://git:secret@host/r.git"),
        "ssh://git@host/r.git"
    );
    assert_eq!(
        url_without_secret("ssh://git@host/r.git"),
        "ssh://git@host/r.git"
    );
    assert_eq!(
        url_without_secret("git@github.com:a/b.git"),
        "git@github.com:a/b.git"
    );
    assert_eq!(
        url_without_secret("https://github.com/a/b"),
        "https://github.com/a/b"
    );
}

#[test]
fn a_password_holding_a_raw_slash_question_mark_or_hash_still_goes() {
    assert_eq!(url_without_secret("https://u:p/q@host/x"), "https://host/x");
    assert_eq!(url_without_secret("https://u:p?q@host/x"), "https://host/x");
    assert_eq!(url_without_secret("https://u:p#q@host/x"), "https://host/x");
    assert_eq!(
        url_without_secret("https://u:p/q@r@host/x"),
        "https://host/x"
    );
    assert_eq!(
        url_without_secret("https://u:p/q@host/x@y"),
        "https://host/x@y"
    );
    assert_eq!(url_without_secret("https://u:p/q@host"), "https://host");
    assert_eq!(
        url_without_secret("ssh://git:se/cret@host/r.git"),
        "ssh://git@host/r.git"
    );
}

#[test]
fn an_at_in_the_path_query_or_after_a_port_is_left_alone_and_so_is_the_scp_form() {
    for url in [
        "https://host/x@y",
        "https://medium.com/@user/post",
        "https://registry.npmjs.org/@scope/pkg",
        "https://host/a@b/c",
        "https://host:8080/a@b",
        "https://host:8080/r?q=a@b",
        "https://host?a=b:c@d",
        "https://host/p:q@r",
        "https://[::1]:8080/a@b",
        "https://[::1]/a@b",
        "git@host:x/y",
    ] {
        assert_eq!(url_without_secret(url), url);
    }
}

// describe("the pick")

fn pick(extra: Value) -> String {
    let mut base = json!({"kind": "new", "host": "vercel", "why": "nothing close exists"});
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base.to_string()
}

#[test]
fn a_new_pick_on_vercel_reads_back_with_its_why_clipped_to_one_line() {
    let p = parse_pick(&pick(
        json!({"why": format!("fits\n  the stack {}", "x".repeat(600)), "extra": 1}),
    ))
    .unwrap();
    assert_eq!(p.kind, "new");
    assert_eq!(p.host, "vercel");
    assert!(p.why.starts_with("fits the stack x"));
    assert_eq!(p.why.len(), 500);
    assert_eq!((p.target, p.license), (None, None));
}

#[test]
fn not_json_not_an_object_a_kind_or_host_off_the_list_and_no_why_are_refused_with_the_reason() {
    assert_eq!(parse_pick("{nope"), Err("pick.json is not JSON".into()));
    assert_eq!(parse_pick("[]"), Err("pick.json must be an object".into()));
    assert_eq!(
        parse_pick(&pick(json!({"kind": "fork"}))),
        Err("kind must be one of new, renovate, extend".into())
    );
    assert_eq!(
        parse_pick(&pick(json!({"host": "netlify"}))),
        Err("host must be one of vercel, vercel+firebase, vercel+convex, mini".into())
    );
    assert_eq!(
        parse_pick(&pick(json!({"why": "  "}))),
        Err("why must say in a sentence why this pick".into())
    );
}

#[test]
fn a_renovate_pick_needs_an_https_target_kept_without_its_secret_a_new_pick_drops_any_target() {
    let needs = Err("a renovate pick needs target: the upstream's https url".to_string());
    assert_eq!(
        parse_pick(&pick(json!({"kind": "renovate", "license": "MIT"}))),
        needs
    );
    assert_eq!(
        parse_pick(&pick(
            json!({"kind": "renovate", "license": "MIT", "target": "/home/eric/dev/x"})
        )),
        needs
    );
    let r = parse_pick(&pick(
        json!({"kind": "renovate", "license": "MIT", "target": "https://u:tok@github.com/a/b"}),
    ))
    .unwrap();
    assert_eq!(r.target.as_deref(), Some("https://github.com/a/b"));
    let n = parse_pick(&pick(json!({"target": "https://github.com/a/b"}))).unwrap();
    assert_eq!(n.target, None);
    assert_eq!(
        parse_pick(&pick(json!({"kind": "extend"}))),
        Err("an extend pick needs target: the repo it extends".into())
    );
}

fn picked(kind: &str, host: &str, license: Option<&str>) -> Pick {
    Pick {
        kind: kind.into(),
        host: host.into(),
        why: "w".into(),
        target: Some("https://github.com/a/b".into()),
        license: license.map(String::from),
    }
}

#[test]
fn pick_refusal_holds_the_license_rules() {
    assert_eq!(
        pick_refusal(&picked("renovate", "vercel", None)).as_deref(),
        Some("a renovate pick needs the upstream's SPDX license")
    );
    assert_eq!(
        pick_refusal(&picked("renovate", "vercel", Some("AGPL-3.0"))).as_deref(),
        Some("AGPL-3.0 is not on the allowed license list")
    );
    assert_eq!(
        pick_refusal(&picked("renovate", "vercel", Some("MIT"))),
        None
    );
    assert_eq!(pick_refusal(&picked("new", "vercel", None)), None);
}

#[test]
fn phase_refusal_new_and_renovate_on_vercel_or_vercel_firebase_convex_and_mini_park_extend_never_deploys()
 {
    for host in ["vercel", "vercel+firebase"] {
        assert_eq!(phase_refusal(&picked("new", host, None)), None);
        assert_eq!(phase_refusal(&picked("renovate", host, Some("MIT"))), None);
    }
    assert_eq!(
        phase_refusal(&picked("new", "vercel+convex", None)).as_deref(),
        Some(CONVEX_PARKED)
    );
    assert_eq!(
        phase_refusal(&picked("renovate", "mini", Some("MIT"))).as_deref(),
        Some(MINI_PARKED)
    );
    for host in ["vercel", "vercel+convex", "mini"] {
        assert_eq!(phase_refusal(&picked("extend", host, None)), None);
    }
}

#[test]
fn github_repo_reads_a_github_com_remote_in_each_form_and_nothing_else() {
    assert_eq!(
        github_repo("https://github.com/eric/clms"),
        gh("eric", "clms")
    );
    assert_eq!(
        github_repo("https://github.com/eric/clms.git"),
        gh("eric", "clms")
    );
    assert_eq!(
        github_repo("https://x:tok@github.com/eric/clms.git/"),
        gh("eric", "clms")
    );
    assert_eq!(
        github_repo("git@github.com:eric/clms.git"),
        gh("eric", "clms")
    );
    assert_eq!(
        github_repo("ssh://git@github.com/eric/clms"),
        gh("eric", "clms")
    );
    for bad in [
        "https://gitlab.com/eric/clms",
        "https://github.com/eric",
        "https://github.com/eric/clms/tree/main",
        "https://github.com.evil.io/eric/clms",
        "http://github.com/eric/clms",
        "/home/eric/dev/clms",
        "https://github.com/-x/clms",
        "https://github.com/eric/..",
        "",
    ] {
        assert_eq!(github_repo(bad), None, "{bad}");
    }
}

#[test]
fn repo_page_reads_a_page_inside_a_github_repo_as_the_repo_to_clone_and_the_page_to_keep() {
    let repo = "https://github.com/drowzeys/Imagination-Studio";
    for rest in [
        "/blob/main/TUTORIAL.md",
        "/tree/main/docs",
        "/issues/12",
        "/pull/3/files",
        "/releases/tag/v1",
        "?tab=readme-ov-file",
        "#readme",
        "/blob/main/a%20b.md?plain=1#L3",
    ] {
        let page = format!("{repo}{rest}");
        assert_eq!(repo_page(&page), Some((repo.to_string(), page.clone())));
    }
    let p = "http://www.github.com/eric/clms.git/blob/main/README.md";
    assert_eq!(
        repo_page(p),
        Some(("https://github.com/eric/clms".into(), p.into()))
    );
    let p = "https://x:tok@github.com/eric/clms/tree/main";
    assert_eq!(
        repo_page(p),
        Some(("https://x:tok@github.com/eric/clms".into(), p.into()))
    );
    let p = "https://raw.githubusercontent.com/eric/clms/main/README.md";
    assert_eq!(
        repo_page(p),
        Some(("https://github.com/eric/clms".into(), p.into()))
    );
}

#[test]
fn repo_page_leaves_a_plain_repo_url_another_host_and_githubs_own_pages_alone() {
    for plain in [
        "https://github.com/eric/clms",
        "https://github.com/eric/clms/",
        "https://github.com/eric/clms.git",
        "git@github.com:eric/clms.git",
        "https://github.com/eric",
        "https://gitlab.com/group/sub/repo/-/blob/main/x.md",
        "https://git.beric.ca/eric/canopy/src/branch/main/README.md",
        "https://github.com.evil.io/eric/clms/blob/main/x",
        "https://github.com/orgs/acme/repositories",
        "https://github.com/settings/tokens/new",
        "https://github.com/-x/clms/blob/main/x",
        "https://github.com/eric/../blob/main/x",
        "",
    ] {
        assert_eq!(repo_page(plain), None, "{plain}");
    }
}

// describe("slots and stages") and describe("the chain")

fn sprout(extra: Value) -> Value {
    let mut base = json!({
        "id": "sp_0123456789ab", "slug": "s", "title": "t", "status": "queued", "repoId": "_incubator/s",
        "seedPath": "/r/_incubator/s", "prepared": false, "inputs": [], "clarified": false, "reclarify": false,
        "flows": [], "spent": {"runs": 0, "workMs": 0}, "createdAt": 1, "updatedAt": 1
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn done(workflow: &str, n: u32) -> Value {
    json!({"workflow": workflow, "flowId": format!("f{n}"), "outcome": "done"})
}

#[test]
fn a_running_stage_holds_a_slot_waiting_on_answers_queued_parked_and_ended_do_not() {
    // holdsSlot is not ported; its test's last two lines are sproutEnded's
    assert!(sprout_ended(&sprout(json!({"status": "stopped"}))));
    assert!(!sprout_ended(&sprout(json!({"status": "parked"}))));
}

#[test]
fn clarify_first_again_after_new_input_then_scout() {
    assert_eq!(next_workflow(&sprout(json!({}))), "clarify");
    assert_eq!(
        next_workflow(&sprout(json!({"clarified": true, "reclarify": true}))),
        "clarify"
    );
    assert_eq!(next_workflow(&sprout(json!({"clarified": true}))), "scout");
}

fn chain(extra: Value) -> Value {
    let mut s = sprout(json!({"prepared": true, "clarified": true}));
    for (k, v) in extra.as_object().unwrap() {
        s[k] = v.clone();
    }
    s
}

#[test]
fn clarify_then_scout_then_build_new_then_canopys_ship() {
    let pick = json!({"kind": "new", "host": "vercel", "why": "w"});
    assert_eq!(
        next_workflow(&chain(json!({"clarified": false}))),
        "clarify"
    );
    assert_eq!(
        next_workflow(&chain(json!({"reclarify": true, "pick": pick}))),
        "clarify"
    );
    assert_eq!(
        next_workflow(&chain(json!({"flows": [done("clarify", 1)]}))),
        "scout"
    );
    assert_eq!(
        next_workflow(&chain(
            json!({"pick": pick, "flows": [done("clarify", 1), done("scout", 2)]})
        )),
        "build-new"
    );
    assert_eq!(
        next_workflow(&chain(json!({"pick": pick, "flows": [
            done("clarify", 1), done("scout", 2), done("build-new", 3)
        ]}))),
        SHIP
    );
}

#[test]
fn a_renovate_pick_builds_with_renovate_then_ships_an_extend_builds_with_extend_then_hands_off() {
    let flows = || vec![done("clarify", 1), done("scout", 2)];
    let with = |extra: Value| {
        let mut f = flows();
        if !extra.is_null() {
            f.push(extra);
        }
        f
    };
    let renovate = json!({"kind": "renovate", "host": "vercel", "why": "w", "target": "https://github.com/a/b", "license": "MIT"});
    let extend = json!({"kind": "extend", "host": "vercel", "why": "w", "target": "web-apps/clms"});
    assert_eq!(
        next_workflow(&chain(json!({"pick": renovate, "flows": flows()}))),
        "renovate"
    );
    assert_eq!(
        next_workflow(&chain(
            json!({"pick": renovate, "flows": with(done("renovate", 3))})
        )),
        SHIP
    );
    assert_eq!(
        next_workflow(&chain(json!({"pick": extend, "flows": flows()}))),
        "extend"
    );
    assert_eq!(
        next_workflow(&chain(
            json!({"pick": extend, "flows": with(done("extend", 3))})
        )),
        HAND_OFF
    );
    assert_eq!(
        next_workflow(&chain(
            json!({"pick": extend, "flows": with(done("build-new", 3))})
        )),
        "extend"
    );
    assert!(is_own_step(HAND_OFF) && is_own_step(SHIP) && !is_own_step("extend"));
}

#[test]
fn a_build_from_before_the_newest_scout_does_not_count() {
    let pick = json!({"kind": "new", "host": "vercel", "why": "w"});
    let flows = json!([
        done("clarify", 1),
        done("scout", 2),
        done("build-new", 3),
        done("clarify", 4),
        done("scout", 5)
    ]);
    assert_eq!(
        next_workflow(&chain(json!({"pick": pick, "flows": flows}))),
        "build-new"
    );
    assert_eq!(last_done(&chain(json!({"flows": flows})), "scout"), 4);
    assert_eq!(last_done(&chain(json!({"flows": flows})), "retro"), -1);
}

#[test]
fn the_text_puts_the_flagged_changes_first_and_escapes_what_the_agent_named() {
    let text = hand_off_text(&json!({
        "head": "h".repeat(40),
        "base": "b".repeat(40),
        "remote": "https://github.com/eric/clms.git",
        "branch": "new/s",
        "commits": [{"sha": "c".repeat(40), "subject": "add it"}],
        "moreCommits": 2,
        "files": [
            {"path": "a.ts", "added": 3, "removed": 1},
            {"path": "img.png", "added": null, "removed": null}
        ],
        "moreFiles": 0,
        "flagged": ["vercel.json: deploy config"],
        "at": 1
    }));
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(
        lines[0],
        "Push new/s to github.com/eric/clms, from bbbbbbbbbbbb to hhhhhhhhhhhh."
    );
    let at = |l: &str| lines.iter().position(|x| *x == l).unwrap();
    assert!(at("! vercel.json: deploy config") < at("3 commits:"));
    assert!(text.contains("  and 2 more"));
    assert!(text.contains("  +3 -1 a.ts"));
    assert!(text.contains("  bin img.png"));
    // showPath is not ported: the review's paths reach the CLI already escaped
}
