//! capacity.test.ts, case by case, then the command against a fake
//! backend. Bun runs those tests in UTC, so the zone here is UTC too.

use super::*;
use crate::ask::AskError;
use crate::ask::tests::Fake;
use std::cell::RefCell;

// 2026-10-26 12:00, 15:00 and Thursday 2026-10-29 15:00, UTC
const NOW: f64 = 1_793_016_000_000.0;
const AT_3PM: f64 = 1_793_026_800_000.0;
const THU_3PM: f64 = 1_793_286_000_000.0;

fn plain() -> Palette {
    Palette { color: false }
}

fn lines(name: &str, info: &Value) -> Vec<String> {
    capacity_lines(name, info, NOW, &TimeZone::UTC, plain(), &mut |_, s| {
        s.to_string()
    })
}

/// `DEFAULT_CAPACITY`, with the dollar figure given.
fn settings(usd: Value) -> Value {
    json!({"lowHold": 0.7, "normalHold": 0.9, "weeklyLowHold": 0.85, "observedFiveHourUsd": usd})
}

/// `emptyCapacity(harness)`, then the fields given.
fn reading(harness: &str, over: Value) -> Value {
    let mut c = json!({"harness": harness, "fiveHour": null, "weekly": null, "source": "unknown", "hit": null});
    for (k, v) in over.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

fn window(used: f64, resets_at: Option<f64>) -> Value {
    json!({"used": used, "resetsAt": resets_at, "readAt": NOW})
}

#[test]
fn window_line_the_share_and_its_reset_or_no_reading() {
    let utc = TimeZone::UTC;
    assert_eq!(
        window_line("5h", Some(&window(0.32, Some(AT_3PM))), NOW, &utc),
        "5h 32% · resets 15:00"
    );
    assert_eq!(
        window_line("week", Some(&window(0.61, Some(THU_3PM))), NOW, &utc),
        "week 61% · resets Thu"
    );
    assert_eq!(
        window_line("5h", Some(&window(0.4, None)), NOW, &utc),
        "5h 40%"
    );
    assert_eq!(
        window_line("week", Some(&Value::Null), NOW, &utc),
        "week no reading"
    );
}

#[test]
fn a_backend_each_harness_a_standing_hit_the_held_starts_and_the_thresholds() {
    // what limitHit("You've hit your limit · resets 3pm", NOW) returns
    let hit = json!({"window": "fiveHour", "at": NOW, "resetsAt": AT_3PM, "text": "You've hit your limit · resets 3pm"});
    let info = json!({
        "capacity": [
            reading("claude", json!({"fiveHour": window(0.3, None), "source": "observed", "hit": hit})),
            reading("codex", json!({})),
        ],
        "held": [{"id": "trigger:e1", "what": "SHOP-1: the crash", "repoId": "web/shop", "priority": "low", "why": "waiting for capacity: the 5-hour window is spent (resets 15:00)", "since": NOW}],
        "settings": settings(json!(40)),
    });
    assert_eq!(
        lines("mini", &info),
        [
            "mini",
            "  claude  5h 30%   week no reading  (observed from the ledger)",
            "          limit hit, resets 15:00: You've hit your limit · resets 3pm",
            "  codex   no reading  (no reading)",
            "  held for capacity: 1",
            "    trigger:e1  low    SHOP-1: the crash (web/shop): waiting for capacity: the 5-hour window is spent (resets 15:00)",
            "  holds: low past 70%, normal past 90%, low past 85% of the week; $40 a 5-hour window",
        ]
    );
}

#[test]
fn a_runs_count_is_said_as_one_and_a_window_it_lacks_reads_as_none() {
    let info = json!({
        "capacity": [
            reading("claude", json!({"weekly": window(0.56, Some(THU_3PM)), "source": "run"})),
            reading("codex", json!({"fiveHour": window(0.4, Some(AT_3PM)), "weekly": window(0.03, Some(THU_3PM)), "source": "run"})),
        ],
        "held": [],
        "settings": settings(Value::Null),
    });
    assert_eq!(
        lines("mac", &info)[1..3],
        [
            "  claude  5h no reading   week 56% · resets Thu  (read from a run)",
            "  codex   5h 40% · resets 15:00   week 3% · resets Thu  (read from a run)",
        ]
    );
    let cli_info = json!({
        "capacity": [reading("antigravity", json!({"fiveHour": window(0.04, Some(AT_3PM)), "weekly": window(0.02, Some(THU_3PM)), "source": "cli"}))],
        "held": [],
        "settings": settings(Value::Null),
    });
    assert_eq!(
        lines("mac", &cli_info)[1],
        "  antigravity 5h 4% · resets 15:00   week 2% · resets Thu  (read from the CLI)"
    );
    assert_eq!(
        lines("mac", &cli_info).last().map(String::as_str),
        Some(
            "  holds: low past 70%, normal past 90%, low past 85% of the week; no observed dollar figure"
        )
    );
}

#[test]
fn the_tone_follows_the_holds() {
    let mut tones: Vec<Tone> = Vec::new();
    for used in [0.5, 0.75, 0.95] {
        let info = json!({
            "capacity": [reading("claude", json!({"fiveHour": window(used, None), "source": "observed"}))],
            "held": [],
            "settings": settings(Value::Null),
        });
        capacity_lines("m", &info, NOW, &TimeZone::UTC, plain(), &mut |tone, s| {
            tones.push(tone);
            s.to_string()
        });
    }
    assert_eq!(tones, [Tone::Moss, Tone::Lichen, Tone::Rust]);
}

#[test]
fn hold_arg_reads_a_fraction_or_a_percentage() {
    assert_eq!(
        ["0.7", "70%", "1", "0", "120%", "x"].map(hold_arg),
        [Some(0.7), Some(0.7), Some(1.0), None, None, None]
    );
}

fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn parse_set_args_turns_the_flags_into_a_patch_or_says_what_is_wrong() {
    assert_eq!(
        parse_set_args(&words(&["--low", "60%", "--usd", "40"])),
        Ok(json!({"lowHold": 0.6, "observedFiveHourUsd": 40}))
    );
    assert_eq!(
        parse_set_args(&words(&["--usd", "none"])),
        Ok(json!({"observedFiveHourUsd": null}))
    );
    assert_eq!(
        parse_set_args(&words(&["--normal", "2"])),
        Err("--normal needs a hold above 0 and at most 1 (0.7 or 70%)".into())
    );
    assert_eq!(
        parse_set_args(&words(&["--usd", "-1"])),
        Err("--usd needs a dollar figure above 0, or none".into())
    );
    assert_eq!(
        parse_set_args(&[]),
        Err("name one of --low, --normal, --weekly or --usd".into())
    );
    assert_eq!(
        parse_set_args(&words(&["--low", "0.5", "extra"])),
        Err("unknown words: extra".into())
    );
}

#[test]
fn a_number_on_the_command_line_reads_as_javascripts_number_reads_it() {
    let got = [
        "5.",
        ".5",
        " 0x10 ",
        "-0x10",
        "1e3",
        "",
        "Infinity",
        "inf",
        "0b11",
        "0o17",
        "1_0",
        "+.5e1",
        "\u{a0}5",
        "0x",
        "1e",
        ".",
        "+",
        "-Infinity",
    ]
    .map(js_number_of);
    let want = [
        5.0,
        0.5,
        16.0,
        f64::NAN,
        1000.0,
        0.0,
        f64::INFINITY,
        f64::NAN,
        3.0,
        15.0,
        f64::NAN,
        5.0,
        5.0,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NEG_INFINITY,
    ];
    for (g, w) in got.iter().zip(want) {
        assert!(g == &w || (g.is_nan() && w.is_nan()), "{g} != {w}");
    }
}

#[test]
fn a_reset_on_another_day_is_its_weekday_and_midnight_is_two_zeros() {
    let utc = TimeZone::UTC;
    // 2026-10-27 00:05 UTC, read on the 27th and on the 26th
    let past_midnight = 1_793_059_500_000.0;
    assert_eq!(reset_word(past_midnight, past_midnight, &utc), "00:05");
    assert_eq!(reset_word(past_midnight, NOW, &utc), "Tue");
    // the same instant in Tokyo is 09:05 on the 27th
    let tokyo = TimeZone::fixed(jiff::tz::offset(9));
    assert_eq!(reset_word(past_midnight, past_midnight, &tokyo), "09:05");
    assert_eq!(reset_word(f64::NAN, NOW, &utc), "Invalid Date");
}

fn caller() -> Caller {
    Caller {
        config_dir: "/nonexistent/canopy-cli-test".into(),
        env_api: Some("http://home.test".into()),
        ..Default::default()
    }
}

fn mini_info() -> Value {
    json!({"capacity": [reading("claude", json!({}))], "held": [], "settings": settings(Value::Null)})
}

async fn run(args: &[&str], fake: &impl Ask) -> (Out, Result<(), String>) {
    let mut out = Out::default();
    let r = capacity_cmd(
        words(args),
        &caller(),
        fake,
        &mut out,
        NOW,
        &TimeZone::UTC,
        false,
    )
    .await;
    (out, r)
}

#[tokio::test]
async fn the_listing_asks_every_backend_and_names_one_that_does_not_answer() {
    let fake = Fake(|t: &Target, _: &str, p: &str, _: Option<&Value>| {
        if p == "/api/backends" {
            return Ok(
                json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}]}),
            );
        }
        if t.name == "mini" {
            return Err(AskError::Unreachable("http://mini: ECONNREFUSED".into()));
        }
        Ok(mini_info())
    });
    let (out, r) = run(&[], &fake).await;
    r.unwrap();
    assert_eq!(
        out.printed(),
        [
            "mac",
            "  claude  no reading  (no reading)",
            "  holds: low past 70%, normal past 90%, low past 85% of the week; no observed dollar figure",
            "mini",
            "  no answer: http://mini: ECONNREFUSED",
        ]
    );
    // as JSON, only the backends that answered, by name
    let (out, r) = run(&["--json"], &fake).await;
    r.unwrap();
    let parsed: Value = serde_json::from_str(&out.text).unwrap();
    assert_eq!(parsed, json!({"mac": mini_info()}));
    assert!(out.text.starts_with("{\n  \"mac\": {\n    \"capacity\": ["));
}

#[tokio::test]
async fn read_release_and_set_speak_to_one_backend() {
    let seen: RefCell<Vec<String>> = RefCell::default();
    let fake = Fake(|t: &Target, m: &str, p: &str, b: Option<&Value>| {
        seen.borrow_mut().push(format!(
            "{} {m} {p} {}",
            t.name,
            b.map(Value::to_string).unwrap_or_default()
        ));
        if p == "/api/backends" {
            return Ok(
                json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}]}),
            );
        }
        Ok(mini_info())
    });
    let (out, r) = run(&["read"], &fake).await;
    r.unwrap();
    assert_eq!(out.printed()[0], "home");
    let (out, r) = run(&["release", "flow:f1", "--on", "mini"], &fake).await;
    r.unwrap();
    assert_eq!(
        out.printed(),
        ["flow:f1 started as interactive; 0 still held"]
    );
    let (out, r) = run(&["set", "--weekly", "80%", "--json"], &fake).await;
    r.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&out.text).unwrap(),
        mini_info()
    );
    assert_eq!(
        *seen.borrow(),
        [
            "home POST /api/capacity/read {}",
            "home GET /api/backends ",
            "mini POST /api/capacity/release {\"id\":\"flow:f1\"}",
            "home POST /api/capacity {\"weeklyLowHold\":0.8}",
        ]
    );
}

#[tokio::test]
async fn the_usages_and_a_backend_that_does_not_answer() {
    let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable(
            "http://home.test: ECONNREFUSED".into(),
        ))
    });
    for (args, want) in [
        (&["what"][..], CAPACITY_USAGE),
        (&["list", "x"], CAPACITY_USAGE),
        (&["--low", "0.5"], CAPACITY_USAGE),
        (&["read", "x"], CAPACITY_USAGE),
        (&["release"], CAPACITY_USAGE),
        (&["release", "a", "b"], CAPACITY_USAGE),
        (&["set"], "name one of --low, --normal, --weekly or --usd"),
        (&["--backend"], "--backend needs a value"),
        (&["--on"], "--on needs a value"),
        (&["--backend", "--on", "x"], "--on needs a value"),
    ] {
        let (_, r) = run(args, &down).await;
        assert_eq!(r, Err(want.to_string()), "{args:?}");
    }
    let (_, r) = run(&["read"], &down).await;
    assert_eq!(
        r,
        Err("home did not answer: http://home.test: ECONNREFUSED".into())
    );
    let (_, r) = run(&["--on", "far"], &down).await;
    assert_eq!(
        r,
        Err("no backend named far; the home backend lists home".into())
    );
}
