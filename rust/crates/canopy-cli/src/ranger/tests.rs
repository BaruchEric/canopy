//! cron.test.ts's leadingWhen cases, and the ranger case's lines, usages
//! and calls against a fake backend (index.ts has no test of its own for
//! this case).

use super::*;
use crate::ask::tests::Fake;
use crate::ask::{AskError, Target};
use std::sync::Mutex;

const PLAIN: Paint = Paint { color: false };

fn words(line: &str) -> Vec<String> {
    if line.is_empty() {
        vec![]
    } else {
        line.split(' ').map(String::from).collect()
    }
}

fn w(line: &str) -> Option<(String, Vec<String>)> {
    leading_when(&words(line))
}

fn lead(when: &str, rest: &[&str]) -> Option<(String, Vec<String>)> {
    Some((when.into(), rest.iter().map(|s| s.to_string()).collect()))
}

// describe("leadingWhen")

#[test]
fn a_time_typed_unquoted_takes_the_words_it_needs_and_the_prompt_is_the_rest() {
    assert_eq!(
        w("in 30m check the deploy"),
        lead("in 30m", &["check", "the", "deploy"])
    );
    assert_eq!(
        w("in 1 day look again"),
        lead("in 1 day", &["look", "again"])
    );
    assert_eq!(w("at 14:00 standup"), lead("at 14:00", &["standup"]));
    assert_eq!(w("14:00 standup"), lead("14:00", &["standup"]));
    assert_eq!(
        w("2026-10-11 09:00 the release"),
        lead("2026-10-11 09:00", &["the", "release"])
    );
    assert_eq!(
        w("2026-10-11T09:00:00Z the release"),
        lead("2026-10-11T09:00:00Z", &["the", "release"])
    );
}

#[test]
fn a_time_quoted_into_one_word_still_reads_and_every_one_it_takes_parses() {
    assert_eq!(
        leading_when(&["in 30m".to_string(), "check".to_string()]),
        lead("in 30m", &["check"])
    );
    // parseWhen is cron.rs's; each line still finds its time here
    for line in [
        "in 30m x",
        "in 1 day x",
        "at 14:00 x",
        "14:00 x",
        "2026-10-11 09:00 x",
    ] {
        assert!(w(line).is_some(), "{line}");
    }
}

#[test]
fn no_time_at_the_front_is_null_for_the_server_to_refuse_as_typed() {
    assert_eq!(w("tomorrow check"), None);
    assert_eq!(w("in thirty minutes"), None);
    assert_eq!(leading_when(&[]), None);
}

// the ranger case

fn info(over: Value) -> Value {
    let mut v = json!({
        "on": false, "state": "off", "term": "ranger", "handle": "ranger-mini", "backend": "mini",
        "root": "/r", "home": "/r", "session": null, "transcript": null, "fails": 0, "restarts": 0,
        "telegram": "off", "settings": {"on": false}, "wakes": [], "viewers": [], "broker": false
    });
    for (k, x) in over.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

#[test]
fn the_status_names_the_handle_the_state_the_conversation_telegram_and_each_wake() {
    assert_eq!(
        show_lines(&info(json!({})), PLAIN),
        ["@ranger-mini on mini: off"]
    );
    let lines = show_lines(
        &info(json!({
            "state": "running", "why": "since 9:00", "session": "s-1", "transcriptBytes": 2560,
            "telegram": "owned",
            "wakes": [
                {"id": "0a1b2c3d", "by": "eric", "prompt": "check the deploy", "cron": "0 8 * * *", "created": 1},
                {"id": "4e5f6a7b", "by": "run", "prompt": "look at it", "run": "r-1", "created": 1},
                {"id": "8c9d0e1f", "by": "ranger", "prompt": "again", "at": 0, "next": 0, "created": 1}
            ]
        })),
        PLAIN,
    );
    assert_eq!(lines[0], "@ranger-mini on mini: running (since 9:00)");
    assert_eq!(lines[1], "conversation s-1, 3 KB");
    assert_eq!(lines[2], "telegram: owned");
    assert_eq!(
        lines[3],
        "  0a1b2c3d  cron 0 8 * * *         by eric  check the deploy"
    );
    assert_eq!(
        lines[4],
        "  4e5f6a7b  when run r-1 ends      by run  look at it"
    );
    assert!(lines[5].starts_with("  8c9d0e1f  ") && lines[5].ends_with("by ranger  again"));
}

/// A backend whose ranger is off, and the calls it was sent.
fn fake(seen: &Mutex<Vec<String>>) -> impl Ask + '_ {
    Fake(
        move |_: &Target, method: &str, path: &str, body: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{method} {path} {}",
                body.map_or(String::new(), Value::to_string)
            ));
            match (method, path) {
                ("GET", "/api/ranger") => Ok(info(json!({}))),
                ("POST", "/api/ranger/restart") | ("POST", "/api/ranger/fresh") => {
                    Err(AskError::Refused {
                        message: "the ranger is off; turn it on first".into(),
                        status: 409,
                    })
                }
                ("DELETE", p) if p.starts_with("/api/ranger/wakes?id=") => Err(AskError::Refused {
                    message: format!("no wake {}", &p["/api/ranger/wakes?id=".len()..]),
                    status: 404,
                }),
                ("POST", "/api/ranger/wakes") => Ok(
                    json!({"id": "0a1b2c3d", "by": "eric", "prompt": "x", "run": "r-9", "created": 1}),
                ),
                _ => Ok(json!({})),
            }
        },
    )
}

async fn run(argv: &[&str], f: &impl Ask) -> (Result<(), String>, Out) {
    let mut out = Out::default();
    let args = argv.iter().map(|s| s.to_string()).collect();
    let r = ranger_cmd(args, &Caller::default(), f, &mut out, PLAIN).await;
    (r, out)
}

#[tokio::test]
async fn status_restart_and_fresh_unwake_and_the_usages_say_what_the_typescript_says() {
    let seen = Mutex::default();
    let f = fake(&seen);
    let (r, out) = run(&[], &f).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out.printed(), ["@ranger-mini on mini: off"]);
    assert_eq!(
        run(&["restart"], &f).await.0,
        Err("the ranger is off; turn it on first".into())
    );
    assert_eq!(
        run(&["fresh"], &f).await.0,
        Err("the ranger is off; turn it on first".into())
    );
    assert_eq!(
        run(&["unwake", "a b"], &f).await.0,
        Err("no wake a%20b".into())
    );
    assert_eq!(run(&["unwake"], &f).await.0, Err(UNWAKE_USAGE.into()));
    assert_eq!(run(&["say", " "], &f).await.0, Err(SAY_USAGE.into()));
    assert_eq!(run(&["wake"], &f).await.0, Err(WAKE_USAGE.into()));
    assert_eq!(
        run(&["wake", "in", "30m"], &f).await.0,
        Err(WAKE_USAGE.into())
    );
    assert_eq!(
        run(&["wake", "--cron", "0 8 * * *"], &f).await.0,
        Err(WAKE_USAGE.into())
    );
    assert_eq!(run(&["what"], &f).await.0, Err(USAGE.into()));
    assert_eq!(
        run(&["--backend", "mini"], &f).await.0,
        Err("--backend must be an http(s) origin, got mini".into())
    );
    // the refusals before a call sent nothing
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [
            "GET /api/ranger ",
            "POST /api/ranger/restart ",
            "POST /api/ranger/fresh ",
            "DELETE /api/ranger/wakes?id=a%20b ",
        ]
    );
}

#[tokio::test]
async fn a_wake_carries_its_time_its_cron_or_its_run_and_say_goes_to_the_rangers_handle() {
    let seen = Mutex::default();
    let f = fake(&seen);
    let (r, out) = run(&["wake", "--run", "r-9", "look", "again"], &f).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out.printed(), ["0a1b2c3d when run r-9 ends"]);
    run(&["wake", "in", "30m", "check", "it"], &f)
        .await
        .0
        .unwrap();
    run(&["wake", "--cron", "0 8 * * *", "morning"], &f)
        .await
        .0
        .unwrap();
    run(&["wake", "tomorrow", "check"], &f).await.0.unwrap();
    let (_, said) = run(&["say", "hello", "there"], &f).await;
    assert_eq!(said.printed(), ["sent to @ranger-mini"]);
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [
            r#"POST /api/ranger/wakes {"prompt":"look again","by":"eric","run":"r-9"}"#,
            r#"POST /api/ranger/wakes {"prompt":"check it","by":"eric","when":"in 30m"}"#,
            r#"POST /api/ranger/wakes {"prompt":"morning","by":"eric","cron":"0 8 * * *"}"#,
            r#"POST /api/ranger/wakes {"prompt":"check","by":"eric","when":"tomorrow"}"#,
            "GET /api/ranger ",
            r#"POST /api/tailchan/send {"target":"@ranger-mini","body":"hello there"}"#,
        ]
    );
}
