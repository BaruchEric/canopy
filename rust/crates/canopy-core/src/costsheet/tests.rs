//! costsheet.test.ts, the cases on what `canopy costs` prints: the words,
//! the archive's Claude dollars per card, and the sheet's totals and its
//! lines by service and by repo. The by-run lines, the details and the
//! session lines are not ported, so their asserts are not here.

use super::*;
use serde_json::{Value, json};

fn repo(id: &str) -> Value {
    let name = id.rsplit(':').next().unwrap_or(id);
    json!({"id": id, "name": name, "path": format!("/repo/{id}"), "group": "", "source": "launch", "status": null})
}

fn cards() -> Vec<RepoCard> {
    vec![
        RepoCard {
            key: "github.com/e/api".into(),
            name: "api".into(),
            checkouts: vec![repo("api"), repo("mini:api")],
        },
        RepoCard {
            key: "github.com/e/web".into(),
            name: "web".into(),
            checkouts: vec![repo("web")],
        },
    ]
}

fn hist(days: &[f64]) -> Value {
    json!({
        "project": "fixture", "sessions": days.len(), "costUsd": days.iter().sum::<f64>(),
        "tokens": 0, "commits": 0, "first": null, "last": null,
        "days": days, "daySessions": days.iter().map(|_| 1).collect::<Vec<_>>(),
    })
}

fn history() -> Value {
    json!({
        "available": true,
        "days": ["2026-10-18", "2026-10-19", "2026-10-20"],
        "maxDay": 5,
        // the mini's archive maps the same sessions to its checkout
        "repos": {"api": hist(&[1.0, 2.0, 3.0]), "mini:api": hist(&[1.0, 2.0, 3.0]), "web": hist(&[0.0, 0.0, 0.5])},
        "fetchedAt": 0,
    })
}

/// `row(over)`: a voice row with nothing on it, then the fields given.
fn row(over: Value) -> Value {
    let mut r = json!({
        "at": 1, "service": "voice", "provider": "openai", "model": null, "repo": null, "repoName": null,
        "run": null, "label": null, "session": null, "usd": null, "tokens": null, "seconds": null,
        "repoId": null, "estUsd": null, "backend": "mac", "qid": null,
    });
    for (k, v) in over.as_object().unwrap() {
        r[k] = v.clone();
    }
    r
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 0.005, "{a} is not close to {b}");
}

#[test]
fn a_cards_claude_dollars_are_its_largest_checkouts_over_the_window() {
    let h = history();
    assert_eq!(
        claude_by_card(Some(&h), 1, &cards()),
        [
            ("github.com/e/api".to_string(), 3.0),
            ("github.com/e/web".to_string(), 0.5)
        ]
    );
    let all = claude_by_card(Some(&h), 30, &cards());
    assert_eq!(
        all.iter()
            .find(|(k, _)| k == "github.com/e/api")
            .map(|(_, v)| *v),
        Some(6.0)
    );
    let down = json!({"available": false, "reason": "no index", "fetchedAt": 0});
    assert!(claude_by_card(Some(&down), 7, &cards()).is_empty());
}

#[test]
fn canopys_claude_rows_are_not_added_to_the_archives_total() {
    let rows = vec![
        row(
            json!({"service": "claude", "provider": "anthropic", "usd": 0.4, "run": "r1", "label": "chat", "qid": "api", "repoName": "api", "at": 5}),
        ),
        row(
            json!({"service": "codex", "provider": "openai", "model": "gpt-6", "tokens": {"input": 900, "cachedInput": 0, "output": 100, "reasoning": 0, "total": 1000}, "estUsd": 0.25, "run": "r2", "label": "fix", "qid": "web", "at": 6}),
        ),
        row(
            json!({"service": "voice", "provider": "elevenlabs", "seconds": 120, "run": "r1", "label": "voice call", "qid": "api", "at": 7}),
        ),
        row(
            json!({"service": "speech", "provider": "speech", "seconds": 4, "label": "dictation", "at": 8}),
        ),
    ];
    let h = history();
    let sheet = cost_sheet(&rows, Some(&h), 1, &cards());
    close(sheet.usd, 3.5);
    close(sheet.est, 0.25);
    assert_eq!(sheet.unpriced, 2.0);
    let labels: Vec<&str> = sheet.services.iter().map(|l| l.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "Claude Code",
            "Codex · openai",
            "Voice · elevenlabs",
            "Dictation · speech"
        ]
    );
    let repos: Vec<(&str, f64, f64, f64)> = sheet
        .repos
        .iter()
        .map(|l| (l.label.as_str(), l.usd, l.est, l.seconds))
        .collect();
    assert_eq!(
        repos,
        [
            ("api", 3.0, 0.0, 120.0),
            ("web", 0.5, 0.25, 0.0),
            ("no repo", 0.0, 0.0, 4.0)
        ]
    );
}

#[test]
fn google_antigravity_usage_stays_its_own_cost_service() {
    let rows = vec![row(
        json!({"service": "antigravity", "provider": "google", "tokens": {"input": 10, "cachedInput": 0, "output": 2, "reasoning": 0, "total": 12}, "run": "r-agy", "label": "ask"}),
    )];
    let sheet = cost_sheet(&rows, None, 7, &cards());
    let keys: Vec<&str> = sheet.services.iter().map(|l| l.key.as_str()).collect();
    assert_eq!(keys, ["antigravity:google"]);
    assert_eq!(
        (sheet.services[0].tokens, sheet.services[0].unpriced),
        (12.0, 1.0)
    );
}

#[test]
fn custom_providers_stay_distinct_in_service_lines() {
    let rows = vec![row(json!({
        "service": "codex", "provider": "team_1", "model": "gpt-custom",
        "tokens": {"input": 1000, "cachedInput": 200, "output": 100, "reasoning": 0, "total": 1100},
        "estUsd": 0.04, "run": "r-custom", "label": "review", "qid": "api",
        "agentSettings": {"harness": "codex", "model": "gpt-selected", "effort": "high", "provider": "team_1"},
        "flowStep": {"workflow": "release", "step": "review", "source": "user"},
    }))];
    let sheet = cost_sheet(&rows, None, 7, &cards());
    let s = &sheet.services[0];
    assert_eq!(
        (s.label.as_str(), s.tokens, s.est),
        ("Codex · team_1", 1100.0, 0.04)
    );
}

#[test]
fn claude_rows_keep_archive_dollars_and_canopy_token_usage_together() {
    let rows = vec![row(
        json!({"service": "claude", "provider": "anthropic", "tokens": {"input": 100, "cachedInput": 20, "output": 10, "reasoning": 0, "total": 110}, "run": "r-claude", "qid": "api"}),
    )];
    let h = history();
    let sheet = cost_sheet(&rows, Some(&h), 1, &cards());
    let s = &sheet.services[0];
    assert_eq!(
        (s.label.as_str(), s.usd, s.tokens),
        ("Claude Code", 3.5, 110.0)
    );
}

#[test]
fn custom_claude_provider_usage_is_not_added_twice_when_its_repo_is_in_history() {
    let rows = vec![row(
        json!({"service": "claude", "provider": "bedrock", "model": "claude-sonnet-5", "usd": 0.25, "run": "r-bedrock", "qid": "api"}),
    )];
    let h = history();
    let sheet = cost_sheet(&rows, Some(&h), 1, &cards());
    close(sheet.usd, 3.5);
    let labels: Vec<&str> = sheet.services.iter().map(|l| l.label.as_str()).collect();
    assert_eq!(labels, ["Claude Code"]);
    let without = cost_sheet(
        &[row(
            json!({"service": "claude", "provider": "bedrock", "usd": 0.25}),
        )],
        None,
        1,
        &cards(),
    );
    close(without.usd, 0.25);
    assert_eq!(without.services[0].label, "Claude Code · bedrock");
}

#[test]
fn a_claude_row_the_archive_has_nothing_for_counts() {
    let mut quiet = history();
    quiet["repos"] = json!({"api": hist(&[0.0, 0.0, 2.0])});
    let rows = vec![
        row(
            json!({"service": "claude", "provider": "anthropic", "usd": 0.3, "run": "r1", "qid": "api"}),
        ),
        row(
            json!({"service": "claude", "provider": "anthropic", "usd": 0.5, "run": "r2", "qid": "web"}),
        ),
        row(
            json!({"service": "claude", "provider": "anthropic", "usd": 0.25, "run": "r3", "repoName": "gone"}),
        ),
    ];
    let sheet = cost_sheet(&rows, Some(&quiet), 1, &cards());
    close(sheet.services[0].usd, 2.75);
    let repos: Vec<(&str, f64)> = sheet
        .repos
        .iter()
        .map(|l| (l.label.as_str(), l.usd))
        .collect();
    assert_eq!(repos, [("api", 2.0), ("web", 0.5), ("gone", 0.25)]);
}

#[test]
fn without_the_archive_claude_is_canopys_own_runs() {
    let rows = vec![row(
        json!({"service": "claude", "provider": "anthropic", "usd": 0.4, "run": "r1", "qid": "api"}),
    )];
    let down = json!({"available": false, "reason": "down", "fetchedAt": 0});
    let sheet = cost_sheet(&rows, Some(&down), 7, &cards());
    assert!(!sheet.archive);
    close(sheet.usd, 0.4);
    assert_eq!(
        (sheet.repos[0].label.as_str(), sheet.repos[0].usd),
        ("api", 0.4)
    );
}

#[test]
fn usage_words_says_tokens_and_minutes() {
    assert_eq!(
        usage_words(12_300.0, 252.0, |n| format!("{}k", js_number(n / 1000.0))),
        "12.3k tokens · 4.2 min"
    );
    assert_eq!(usage_words(0.0, 20.0, js_number), "20 s");
}

#[test]
fn the_currency_and_token_words_keep_their_display_format() {
    assert_eq!(
        [
            usd_word(None),
            usd_word(Some(12.345)),
            usd_word(Some(123.45))
        ],
        ["n/a", "$12.35", "$123"]
    );
    assert_eq!(
        [
            tokens_word(123.0),
            tokens_word(1_234.0),
            tokens_word(1_234_567.0),
            tokens_word(1_234_567_890.0)
        ],
        ["123", "1.2k", "1.2M", "1.23B"]
    );
}

#[test]
fn claude_leads_names_each_cards_costliest_checkout_the_costliest_card_first() {
    let h = history();
    let leads: Vec<(String, String, f64)> = claude_leads(Some(&h), 1, &cards())
        .into_iter()
        .map(|l| (l.name, l.id, l.usd))
        .collect();
    assert_eq!(
        leads,
        [
            ("api".to_string(), "api".to_string(), 3.0),
            ("web".into(), "web".into(), 0.5)
        ]
    );
}
