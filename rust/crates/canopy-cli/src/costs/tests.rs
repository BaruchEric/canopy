//! costs.test.ts, case by case. The two cases that start Bun servers hand
//! in a fake backend that answers as those servers do.

use super::*;
use crate::ask::Target;
use crate::ask::tests::Fake;
use canopy_core::harnessshare::Split;
use serde_json::json;
use std::cell::RefCell;

fn line(key: &str, label: &str) -> CostLine {
    CostLine::new(key, label)
}

fn plain() -> Palette {
    Palette { color: false }
}

#[test]
fn days_of_reads_one_seven_or_thirty() {
    assert_eq!(
        [None, Some("1"), Some("7"), Some("30"), Some("5"), Some("x")].map(days_of),
        [Some(7), Some(1), Some(7), Some(30), None, None]
    );
}

#[test]
fn cost_lines_the_total_by_service_by_repo() {
    let sheet = CostSheet {
        usd: 41.2,
        est: 0.25,
        unpriced: 2.0,
        archive: true,
        services: vec![
            CostLine {
                usd: 38.1,
                tokens: 1_200_000.0,
                ..line("claude:anthropic", "Claude Code")
            },
            CostLine {
                est: 0.25,
                tokens: 1000.0,
                ..line("codex:openai", "Codex · openai")
            },
            CostLine {
                unpriced: 2.0,
                seconds: 30.0,
                ..line("speech:speech", "Dictation · speech")
            },
        ],
        repos: vec![CostLine {
            usd: 3.0,
            seconds: 120.0,
            ..line("github.com/e/api", "api")
        }],
    };
    assert_eq!(
        cost_lines(&sheet, 7, 15),
        [
            "7 days: $41.20 + ≈ $0.25 + 2 unpriced",
            "by service",
            "  Claude Code                    $38.10  1.2M tokens",
            "  Codex · openai                ≈ $0.25  1.0k tokens",
            "  Dictation · speech            unpriced  30 s",
            "by repo",
            "  api                             $3.00  2.0 min",
        ]
    );
    let empty = CostSheet {
        services: vec![],
        repos: vec![],
        ..sheet.clone()
    };
    assert_eq!(
        cost_lines(&empty, 1, 15)[..3],
        [
            "today: $41.20 + ≈ $0.25 + 2 unpriced",
            "by service",
            "  nothing"
        ]
    );
    let three = CostSheet {
        repos: vec![sheet.repos[0].clone(), line("b", "b"), line("c", "c")],
        ..sheet.clone()
    };
    assert_eq!(
        cost_lines(&three, 30, 2).last().map(String::as_str),
        Some("  … and 1 more")
    );
}

fn share() -> HarnessShare {
    HarnessShare {
        usd: Split {
            harness: 9.48,
            rest: 31.72,
        },
        sessions: Split {
            harness: 15.0,
            rest: 33.0,
        },
        share: Some(9.48 / 41.2),
        session_share: Some(15.0 / 48.0),
    }
}

fn weeks() -> Vec<HarnessWeek> {
    let week = |from: &str, harness: f64, rest: f64, share: Option<f64>| HarnessWeek {
        from: from.into(),
        harness,
        rest,
        share,
    };
    vec![
        week("2026-10-05", 0.0, 0.0, None),
        week("2026-10-12", 7.0, 7.0, Some(0.5)),
        week("2026-10-19", 21.0, 7.0, Some(0.75)),
        week("2026-10-26", 2.0, 2.0, Some(0.5)),
    ]
}

#[test]
fn share_line() {
    assert_eq!(
        super::share_line(plain(), &share()),
        "tooling 23% of $41.20 · 31% of 48 sessions"
    );
    let none = HarnessShare {
        usd: Split::default(),
        sessions: Split::default(),
        share: None,
        session_share: None,
    };
    assert_eq!(
        super::share_line(plain(), &none),
        "tooling — of $0.00 · — of 0 sessions"
    );
    // with colour on, the share past the line is rust and under it moss
    let painted = super::share_line(Palette { color: true }, &share());
    assert_eq!(
        painted,
        "tooling \x1b[38;2;147;201;139m23%\x1b[0m of $41.20 · \x1b[38;2;201;123;95m31%\x1b[0m of 48 sessions"
    );
}

#[test]
fn share_lines_the_figure_with_the_names_then_the_weeks() {
    let names = vec!["canopy".to_string(), "devhub".to_string()];
    assert_eq!(
        share_lines(plain(), &share(), &weeks(), &names, 25.0),
        [
            "tooling 23% of $41.20 · 31% of 48 sessions  (canopy, devhub)",
            "week          tooling      rest  share",
            "2026-10-05      $0.00     $0.00      —",
            "2026-10-12      $7.00     $7.00    50%",
            "2026-10-19     $21.00     $7.00    75%",
            "2026-10-26      $2.00     $2.00    50%  so far",
        ]
    );
    assert_eq!(
        share_lines(plain(), &share(), &[], &[], 25.0),
        [
            "tooling 23% of $41.20 · 31% of 48 sessions  (no repo is marked as tooling)",
            "  no week to show: claude-history has no spend in these repos",
        ]
    );
}

fn caller() -> Caller {
    Caller {
        config_dir: "/nonexistent/canopy-cli-test".into(),
        env_api: Some("http://home.test".into()),
        ..Default::default()
    }
}

fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn costs_rejects_a_day_count_outside_1_7_and_30() {
    let fake = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| Ok(json!({})));
    for args in [
        &["--days", "5"][..],
        &["--days"],
        &["--share", "stray"],
        &["--backend"],
        &["--on"],
        &["--backend", "--share"],
    ] {
        let mut out = Out::default();
        assert_eq!(
            costs_cmd(words(args), &caller(), &fake, &mut out, false).await,
            Err(COSTS_USAGE.to_string()),
            "{args:?}"
        );
    }
    let mut out = Out::default();
    assert_eq!(
        costs_cmd(
            words(&["--backend", "http://x/y"]),
            &caller(),
            &fake,
            &mut out,
            false
        )
        .await,
        Err("--backend must be an http(s) origin, got http://x/y".into())
    );
}

fn repo(id: &str, name: &str, remote: &str, harness: bool) -> Value {
    let mut r = json!({"id": id, "name": name, "path": format!("/{name}"), "group": "", "source": "launch", "status": null, "remotes": [remote]});
    if harness {
        r["harness"] = json!(true);
    }
    r
}

fn tree(repos: Vec<Value>) -> Value {
    json!({"root": "/", "sources": [], "repos": repos, "scannedAt": 0, "backend": {}})
}

fn archive(id: &str, amount: f64, sessions: f64) -> Value {
    json!({
        "available": true, "days": ["2026-10-26"], "maxDay": amount, "fetchedAt": 0,
        "repos": {id: {"project": id, "sessions": sessions, "costUsd": amount, "tokens": 0, "commits": 0,
            "first": null, "last": null, "days": [amount], "daySessions": [sessions]}},
    })
}

fn cost_row(service: &str, repo_id: &str, repo_name: &str, usd: f64) -> Value {
    json!({
        "at": 1, "service": service, "provider": if service == "codex" { "openai" } else { service },
        "model": null, "repo": format!("/{repo_name}"), "repoName": repo_name, "run": null, "label": null,
        "session": null, "usd": usd, "tokens": {"input": 0, "cachedInput": 0, "output": 0, "reasoning": 0, "total": 0},
        "seconds": null, "repoId": repo_id, "estUsd": null,
    })
}

/// Two archives' repos in one overview, as the TS spreads them.
fn both(a: Value, b: Value) -> Value {
    let mut out = a;
    for (k, v) in b["repos"].as_object().unwrap() {
        out["repos"][k] = v.clone();
    }
    out
}

#[tokio::test]
async fn costs_runs_across_listed_backends_and_merges_qualified_repos() {
    let canopy_remote = "https://github.com/eric/canopy";
    let api_remote = "https://github.com/eric/api";
    let devhub_remote = "https://github.com/eric/devhub";
    let requests: RefCell<Vec<String>> = RefCell::default();
    let fake = Fake(|t: &Target, m: &str, p: &str, _: Option<&Value>| {
        requests.borrow_mut().push(format!("{} {m} {p}", t.name));
        let path = p.split('?').next().unwrap_or(p);
        let answer = match (t.name.as_str(), path) {
            (_, "/api/backends") => json!({"self": "mac", "backends": [
                {"name": "mini", "tailnet": "http://mini.test"},
                {"name": "devhub", "tailnet": "http://devhub.test"},
            ]}),
            ("mini", "/api/tree") => tree(vec![
                repo("repo", "canopy on mini", canopy_remote, false),
                repo("api", "api", api_remote, false),
                repo("runner", "runner", "https://github.com/eric/runner", true),
            ]),
            ("mini", "/api/history") => both(archive("repo", 3.0, 3.0), archive("api", 2.0, 1.0)),
            ("mini", "/api/costs") => {
                json!({"since": 0, "rows": [cost_row("codex", "repo", "canopy", 5.0)], "priced": false})
            }
            ("devhub", "/api/tree") => tree(vec![repo("dev", "devhub", devhub_remote, true)]),
            ("devhub", "/api/history") => archive("dev", 4.0, 1.0),
            ("devhub", "/api/costs") => {
                json!({"since": 0, "rows": [cost_row("voice", "dev", "devhub", 2.0)], "priced": false})
            }
            (_, "/api/tree") => tree(vec![
                repo("repo", "canopy", canopy_remote, true),
                repo("api", "api", api_remote, false),
            ]),
            (_, "/api/history") => both(archive("repo", 1.0, 2.0), archive("api", 2.0, 1.0)),
            (_, "/api/costs") => {
                json!({"since": 0, "rows": [cost_row("codex", "repo", "canopy", 3.0), cost_row("speech", "api", "api", 4.0)], "priced": false})
            }
            _ => {
                return Err(AskError::Refused {
                    message: "not found".into(),
                    status: 404,
                });
            }
        };
        Ok(answer)
    });
    let mut out = Out::default();
    costs_cmd(
        words(&["--days", "30", "--share"]),
        &caller(),
        &fake,
        &mut out,
        false,
    )
    .await
    .unwrap();
    let seen = requests.borrow();
    for want in [
        "home GET /api/backends",
        "mac GET /api/costs?days=30",
        "mini GET /api/tree",
        "mini GET /api/history?window=90d",
        "mini GET /api/costs?days=30",
        "devhub GET /api/costs?days=30",
    ] {
        assert!(seen.iter().any(|s| s == want), "no {want} in {seen:?}");
    }
    let printed = out.printed();
    let all = printed.join("\n");
    assert!(all.contains("30 days: $23.00"));
    assert!(all.contains("tooling 74% of $23.00 · 80% of 5 sessions  (canopy, runner, devhub)"));
    assert!(all.contains("  canopy                         $11.00"));
    assert_eq!(
        printed.iter().filter(|l| l.contains("  canopy ")).count(),
        1
    );
    // the whole of what the TypeScript printed for this fixture
    assert_eq!(
        printed,
        [
            "30 days: $23.00",
            "by service",
            "  Claude Code                     $9.00",
            "  Codex · openai                  $8.00",
            "  Dictation · speech              $4.00",
            "  Voice · voice                   $2.00",
            "by repo",
            "  canopy                         $11.00",
            "  devhub                          $6.00",
            "  api                             $6.00",
            "tooling 74% of $23.00 · 80% of 5 sessions  (canopy, runner, devhub)",
            "week          tooling      rest  share",
            "2026-10-26      $7.00     $2.00    78%  so far",
        ]
    );
}

#[tokio::test]
async fn costs_names_a_backend_after_excluding_it_when_any_required_endpoint_fails() {
    let requests: RefCell<Vec<String>> = RefCell::default();
    let fake = Fake(|t: &Target, m: &str, p: &str, _: Option<&Value>| {
        requests.borrow_mut().push(format!("{} {m} {p}", t.name));
        let path = p.split('?').next().unwrap_or(p);
        let answer = match (t.name.as_str(), path) {
            (_, "/api/backends") => {
                json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini.test"}]})
            }
            ("mini", "/api/history") => {
                return Err(AskError::Refused {
                    message: "archive offline".into(),
                    status: 503,
                });
            }
            ("mini", "/api/tree") => tree(vec![]),
            ("mini", "/api/costs") => json!({"since": 0, "rows": [], "priced": false}),
            (_, "/api/tree") => tree(vec![]),
            (_, "/api/history") => {
                json!({"available": false, "reason": "no archive", "fetchedAt": 0})
            }
            (_, "/api/costs") => json!({"since": 0, "rows": [], "priced": false}),
            _ => {
                return Err(AskError::Refused {
                    message: "not found".into(),
                    status: 404,
                });
            }
        };
        Ok(answer)
    });
    let mut out = Out::default();
    costs_cmd(
        words(&["--days", "1", "--share"]),
        &caller(),
        &fake,
        &mut out,
        false,
    )
    .await
    .unwrap();
    let seen = requests.borrow();
    assert!(seen.iter().any(|s| s == "mac GET /api/costs?days=1"));
    assert!(seen.iter().any(|s| s == "mini GET /api/history?window=90d"));
    assert_eq!(
        out.printed().last(),
        Some(&"not counted: mini: archive offline")
    );
    assert_eq!(
        out.printed(),
        [
            "today: $0.00",
            "by service",
            "  nothing",
            "by repo",
            "  nothing",
            "tooling — of $0.00 · — of 0 sessions  (no repo is marked as tooling)",
            "  no week to show: claude-history has no spend in these repos",
            "not counted: mini: archive offline",
        ]
    );
}

#[tokio::test]
async fn no_backend_answering_is_a_failure() {
    let fake = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable(
            "http://home.test: ECONNREFUSED".into(),
        ))
    });
    let mut out = Out::default();
    assert_eq!(
        costs_cmd(vec![], &caller(), &fake, &mut out, false).await,
        Err("no backend answered".into())
    );
    assert_eq!(out.text, "");
}
