//! harnessshare.test.ts, the cases on what `canopy costs --share` prints.
//! `barWidths`, `cardsOf`, `harnessSlot` and `weekKey` are not ported, so
//! their asserts are not here.

use super::*;
use crate::costsheet::CostLine;
use serde_json::{Value, json};

fn repo(id: &str, harness: bool) -> Value {
    let name = id.rsplit('|').next().unwrap_or(id);
    let mut r = json!({"id": id, "name": name, "path": format!("/dev/{id}"), "group": "", "source": "root", "status": null});
    if harness {
        r["harness"] = json!(true);
    }
    r
}

fn canopy_card() -> RepoCard {
    RepoCard {
        key: "github.com/e/canopy".into(),
        name: "canopy".into(),
        checkouts: vec![repo("canopy", true), repo("mini|canopy", false)],
    }
}

fn web_card() -> RepoCard {
    RepoCard {
        key: "github.com/e/web".into(),
        name: "web".into(),
        checkouts: vec![repo("web", false)],
    }
}

fn cards() -> Vec<RepoCard> {
    vec![canopy_card(), web_card()]
}

fn days() -> Vec<String> {
    (0..18).map(|i| format!("2026-10-{:02}", i + 10)).collect()
}

fn between(day: &str, from: &str, to: &str) -> bool {
    day >= from && day <= to
}

fn history_row(
    days: &[String],
    spend: impl Fn(&str) -> f64,
    sessions: impl Fn(&str) -> f64,
) -> Value {
    let daily: Vec<f64> = days.iter().map(|d| spend(d)).collect();
    let day_sessions: Vec<f64> = days.iter().map(|d| sessions(d)).collect();
    json!({
        "project": "fixture", "sessions": day_sessions.iter().sum::<f64>(), "costUsd": daily.iter().sum::<f64>(),
        "tokens": 0, "commits": 0, "first": null, "last": null, "days": daily, "daySessions": day_sessions,
    })
}

fn history() -> Value {
    let days = days();
    json!({
        "available": true,
        "days": days,
        "maxDay": 3,
        "fetchedAt": 0,
        "repos": {
            "canopy": history_row(
                &days,
                |d| if between(d, "2026-10-12", "2026-10-18") { 1.0 } else if between(d, "2026-10-19", "2026-10-25") { 3.0 } else if d == "2026-10-26" { 2.0 } else { 0.0 },
                |d| if d >= "2026-10-21" { 2.0 } else { 0.0 },
            ),
            // this checkout beats canopy on the Oct 12 week alone but is
            // smaller over the entire overview, so weekly sums use canopy
            "mini|canopy": history_row(&days, |d| if between(d, "2026-10-12", "2026-10-18") { 2.0 } else { 0.0 }, |_| 1.0),
            "web": history_row(&days, |d| if d >= "2026-10-12" { 1.0 } else { 0.0 }, |_| 1.0),
        },
    })
}

fn cost_line(key: &str, usd: f64, est: f64) -> CostLine {
    CostLine {
        usd,
        est,
        ..CostLine::new(key, key)
    }
}

fn sheet() -> Vec<CostLine> {
    vec![
        cost_line("github.com/e/canopy", 20.0, 1.0),
        cost_line("github.com/e/web", 10.0, 0.0),
        cost_line("\u{0}none", 0.0, 2.0),
        cost_line("name:gone", 0.5, 0.0),
    ]
}

#[test]
fn share_defaults_match_the_product_line() {
    assert_eq!((WEEKS, HARNESS_SHARE_MAX), (8, 25.0));
}

#[test]
fn percentage_and_warning_tone_use_the_displayed_whole_percent() {
    assert_eq!(
        [pct(Some(0.234)), pct(Some(1.0)), pct(None)],
        ["23%", "100%", "—"]
    );
    assert_eq!(share_tone(Some(0.25), 25.0), Some(ShareTone::Rust));
    assert_eq!(share_tone(Some(0.249), 25.0), Some(ShareTone::Rust));
    assert_eq!(share_tone(Some(0.244), 25.0), Some(ShareTone::Moss));
    assert_eq!(share_tone(Some(0.9), 0.0), None);
    assert_eq!(share_tone(None, 25.0), None);
}

#[test]
fn harness_share_sums_line_dollars_and_window_sessions_from_each_cards_busiest_checkout() {
    let h = history();
    assert_eq!(
        harness_share(&sheet(), Some(&h), 7, &cards()),
        HarnessShare {
            usd: Split {
                harness: 21.0,
                rest: 12.5
            },
            sessions: Split {
                harness: 14.0,
                rest: 7.0
            },
            share: Some(21.0 / 33.5),
            session_share: Some(14.0 / 21.0),
        }
    );
}

#[test]
fn one_marked_checkout_makes_its_entire_card_harness() {
    let marked_on_mini = RepoCard {
        checkouts: vec![repo("canopy", false), repo("mini|canopy", true)],
        ..canopy_card()
    };
    assert!(is_harness_card(&marked_on_mini));
    let h = history();
    assert_eq!(
        harness_share(&sheet(), Some(&h), 7, &[marked_on_mini, web_card()]).usd,
        Split {
            harness: 21.0,
            rest: 12.5
        }
    );
}

#[test]
fn unmapped_harness_history_keeps_its_dollars_and_has_no_sessions() {
    let devhub = RepoCard {
        key: "rel:devhub".into(),
        name: "devhub".into(),
        checkouts: vec![repo("devhub", true)],
    };
    let h = history();
    assert_eq!(
        harness_share(
            &[cost_line("rel:devhub", 3.0, 0.0)],
            Some(&h),
            7,
            &[devhub, web_card()]
        ),
        HarnessShare {
            usd: Split {
                harness: 3.0,
                rest: 0.0
            },
            sessions: Split {
                harness: 0.0,
                rest: 7.0
            },
            share: Some(1.0),
            session_share: Some(0.0),
        }
    );
}

#[test]
fn no_spending_or_archive_sessions_has_no_shares() {
    assert_eq!(
        harness_share(&[], None, 7, &cards()),
        HarnessShare {
            usd: Split::default(),
            sessions: Split::default(),
            share: None,
            session_share: None,
        }
    );
}

fn week(from: &str, harness: f64, rest: f64, share: Option<f64>) -> HarnessWeek {
    HarnessWeek {
        from: from.into(),
        harness,
        rest,
        share,
    }
}

#[test]
fn harness_weeks_use_monday_boundaries_partial_weeks_and_one_overview_leading_checkout() {
    let h = history();
    assert_eq!(
        harness_weeks(Some(&h), &cards(), WEEKS),
        [
            week("2026-10-05", 0.0, 0.0, None),
            week("2026-10-12", 7.0, 7.0, Some(0.5)),
            week("2026-10-19", 21.0, 7.0, Some(0.75)),
            week("2026-10-26", 2.0, 2.0, Some(0.5)),
        ]
    );
}

#[test]
fn custom_and_default_caps_retain_the_newest_weeks() {
    let h = history();
    let froms: Vec<String> = harness_weeks(Some(&h), &cards(), 3)
        .into_iter()
        .map(|w| w.from)
        .collect();
    assert_eq!(froms, ["2026-10-12", "2026-10-19", "2026-10-26"]);

    // 70 days from 2026-01-05, counted with the calendar
    let long_days: Vec<String> = (0..70)
        .map(|i| {
            let (y, m, d) = civil_from_days(days_from_civil(2026, 1, 5) + i);
            format!("{y}-{m:02}-{d:02}")
        })
        .collect();
    let values: Vec<f64> = long_days.iter().map(|_| 1.0).collect();
    let long_history = json!({
        "available": true, "days": long_days, "maxDay": 1, "fetchedAt": 0,
        "repos": {"canopy": {"project": "fixture", "sessions": 0, "costUsd": 70, "tokens": 0, "commits": 0,
            "first": null, "last": null, "days": values, "daySessions": long_days.iter().map(|_| 0).collect::<Vec<_>>()}},
    });
    let only_harness = RepoCard {
        key: "canopy".into(),
        name: "canopy".into(),
        checkouts: vec![repo("canopy", true)],
    };
    let newest = harness_weeks(Some(&long_history), &[only_harness], WEEKS);
    assert_eq!(newest.len(), WEEKS);
    assert_eq!(newest[0].from, "2026-01-19");
    assert_eq!(newest.last().map(|w| w.from.as_str()), Some("2026-03-09"));
}

#[test]
fn an_absent_or_unavailable_overview_has_no_weeks() {
    assert!(harness_weeks(None, &cards(), WEEKS).is_empty());
    let down = json!({"available": false, "reason": "down", "fetchedAt": 0});
    assert!(harness_weeks(Some(&down), &cards(), WEEKS).is_empty());
}

#[test]
fn reads_local_mondays() {
    assert_eq!(week_from("2026-10-10"), "2026-10-05");
    assert_eq!(week_from("2026-10-26"), "2026-10-26");
    assert_eq!(week_from("2026-11-01"), "2026-10-26");
    assert_eq!(week_from("2027-01-01"), "2026-12-28");
    assert_eq!(week_from("2024-03-01"), "2024-02-26");
    assert_eq!(week_from("nope"), "NaN-NaN-NaN");
}

#[test]
fn names_marked_cards() {
    assert_eq!(harness_names(&cards()), ["canopy"]);
}
