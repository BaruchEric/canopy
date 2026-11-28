//! `canopy issues` (`src/cli/issues.ts`): every GitHub and Forgejo issue a
//! trigger rule took and where each stands, over the API of every backend
//! the home one lists.

use crate::api::Caller;
use crate::ask::{Ask, AskError, Target, has, listed_targets, take};
use canopy_core::pathx::{js_sorted_unique, pad_end};
use serde::Deserialize;
use serde_json::Value;

/// `ISSUES_USAGE`.
pub const ISSUES_USAGE: &str = "usage: canopy issues [repo] [--needs-you] [--backend URL]";

/// The fields of a trigger event (`TriggerEvent`) the lines read.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueEvent {
    pub service: String,
    pub key: String,
    pub short: Option<String>,
    pub repo_id: String,
    pub status: String,
    pub branch: Option<String>,
    pub pr: Option<PrRef>,
    pub reason: Option<String>,
    pub needs_you: Option<String>,
    pub last_at: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct PrRef {
    pub number: f64,
}

/// `issueLines()`: one backend's forge issues, a repo at a time and newest
/// first: the issue, its state, its branch, its PR, and what it needs of
/// Eric, else why it stopped. `repo` keeps one repo by id; `needs_only`
/// keeps the issues that wait on him.
pub fn issue_lines(
    events: &[IssueEvent],
    repo: Option<&str>,
    backend: &str,
    needs_only: bool,
) -> Vec<String> {
    let where_ = if backend.is_empty() {
        String::new()
    } else {
        format!(" on {backend}")
    };
    let events: Vec<&IssueEvent> = events
        .iter()
        .filter(|e| e.service == "github" || e.service == "forgejo")
        .filter(|e| repo.is_none_or(|r| e.repo_id == r))
        .filter(|e| !needs_only || e.needs_you.is_some())
        .collect();
    let repos = js_sorted_unique(events.iter().map(|e| e.repo_id.clone()).collect());
    let mut out = Vec::new();
    for id in repos {
        out.push(format!("{id}{where_}"));
        let mut mine: Vec<&&IssueEvent> = events.iter().filter(|e| e.repo_id == id).collect();
        mine.sort_by(|a, b| {
            (b.last_at - a.last_at)
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for e in mine {
            let pr =
                e.pr.as_ref()
                    .map_or_else(|| "-".to_string(), |p| format!("#{}", p.number));
            out.push(format!(
                "  {} {} {} {} {}",
                pad_end(e.short.as_deref().unwrap_or(&e.key), 10),
                pad_end(&e.status, 8),
                pad_end(e.branch.as_deref().unwrap_or("-"), 12),
                pad_end(&pr, 6),
                e.needs_you
                    .as_deref()
                    .or(e.reason.as_deref())
                    .unwrap_or("-")
            ));
        }
    }
    out
}

/// `issuesCommand()`: the lines to print, or the usage. A backend that does
/// not answer is a line of its own, as the TypeScript prints it.
pub(crate) async fn issues_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
) -> Result<Vec<String>, String> {
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    let needs_only = has(&mut args, "--needs-you");
    let repo = if args.is_empty() {
        None
    } else {
        Some(args.remove(0))
    };
    if !args.is_empty() {
        return Err(ISSUES_USAGE.into());
    }
    let targets: Vec<Target> = listed_targets(ask, &home, given.is_some()).await;
    let mut out = Vec::new();
    let mut any = false;
    for t in &targets {
        let info = match ask.ask(t, "GET", "/api/triggers", None).await {
            Ok(v) => v,
            Err(e) => {
                out.push(format!("{}: {}", t.name, not_answered(&e)));
                continue;
            }
        };
        let events: Vec<IssueEvent> = info
            .get("events")
            .and_then(Value::as_array)
            .map(|es| {
                es.iter()
                    .map(|e| serde_json::from_value(e.clone()).unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default();
        let backend = if targets.len() > 1 {
            t.name.as_str()
        } else {
            ""
        };
        let lines = issue_lines(&events, repo.as_deref(), backend, needs_only);
        any |= !lines.is_empty();
        out.extend(lines);
    }
    if !any {
        let what = if needs_only { "wait on you" } else { "taken" };
        out.push(match repo.as_deref().filter(|r| !r.is_empty()) {
            Some(r) => format!("no GitHub or Forgejo issues {what} in {r}"),
            None => format!("no GitHub or Forgejo issues {what}"),
        });
    }
    Ok(out)
}

/// What a listing verb prints for a backend that failed it: "did not
/// answer: ..." when nothing answered, else the refusal's own words.
pub(crate) fn not_answered(e: &AskError) -> String {
    match e {
        AskError::Unreachable(m) => format!("did not answer: {m}"),
        other => other.message().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;
    use serde_json::json;

    fn ev(over: Value) -> IssueEvent {
        let mut base = json!({
            "id": "e1", "rule": "gh", "source": "github", "service": "github",
            "key": "12", "short": "#12", "title": "Login loops", "note": "",
            "repoId": "web/shop", "workflow": "issue-fix", "status": "working",
            "count": 1, "firstAt": 1, "lastAt": 1
        });
        for (k, v) in over.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn nothing_taken_is_no_lines() {
        assert!(issue_lines(&[], None, "", false).is_empty());
    }

    #[test]
    fn forge_rows_newest_first_under_their_repo() {
        let events = vec![
            ev(
                json!({"id":"a","status":"review","branch":"br1","pr":{"number":3,"url":"u"},"lastAt":5}),
            ),
            ev(
                json!({"id":"b","service":"forgejo","source":"forgejo","key":"7","short":"#7","status":"ready","branch":"br2","reason":"main moved under it","lastAt":9}),
            ),
            ev(
                json!({"id":"c","key":"13","short":"#13","status":"failed","reason":"no worktree","lastAt":2,"repoId":"web/api"}),
            ),
            ev(
                json!({"id":"s","service":"sentry","source":"sentry","key":"4242","short":"SHOP-1A","status":"merged"}),
            ),
            ev(
                json!({"id":"l","service":"linear","source":"linear","key":"ENG-7","short":"ENG-7","status":"working"}),
            ),
        ];
        assert_eq!(
            issue_lines(&events, None, "", false),
            [
                "web/api",
                "  #13        failed   -            -      no worktree",
                "web/shop",
                "  #7         ready    br2          -      main moved under it",
                "  #12        review   br1          #3     -",
            ]
        );
        assert_eq!(
            issue_lines(&events, Some("web/api"), "mini", false),
            [
                "web/api on mini",
                "  #13        failed   -            -      no worktree"
            ]
        );
        assert!(issue_lines(&events, Some("web/none"), "", false).is_empty());
    }

    #[test]
    fn the_last_column_is_what_it_needs_and_needs_you_keeps_only_those() {
        let events = vec![
            ev(
                json!({"id":"a","status":"review","branch":"br1","pr":{"number":3,"url":"u"},"needsYou":"auto-fix gave up: x","lastAt":5}),
            ),
            ev(
                json!({"id":"b","key":"7","short":"#7","status":"ready","branch":"br2","reason":"main moved under it","lastAt":9}),
            ),
            ev(
                json!({"id":"c","key":"13","short":"#13","status":"rebasing","branch":"br3","pr":{"number":4,"url":"u"},"lastAt":2}),
            ),
        ];
        assert_eq!(
            issue_lines(&events, None, "", false),
            [
                "web/shop",
                "  #7         ready    br2          -      main moved under it",
                "  #12        review   br1          #3     auto-fix gave up: x",
                "  #13        rebasing br3          #4     -",
            ]
        );
        assert_eq!(
            issue_lines(&events, None, "", true),
            [
                "web/shop",
                "  #12        review   br1          #3     auto-fix gave up: x"
            ]
        );
    }

    fn words(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn asks_every_listed_backend_and_says_which_did_not_answer() {
        let fake = Fake(|t: &Target, _: &str, path: &str, _: Option<&Value>| {
            if path == "/api/backends" {
                return Ok(
                    json!({"self":"home","backends":[{"name":"mini","tailnet":"http://mini:7850"}]}),
                );
            }
            if t.name == "mini" {
                return Err(AskError::Unreachable(
                    "http://mini:7850: ECONNREFUSED".into(),
                ));
            }
            Ok(
                json!({"events":[{"service":"github","key":"12","short":"#12","repoId":"web/shop","status":"working","branch":"br1","lastAt":1}]}),
            )
        });
        let c = Caller::default();
        assert_eq!(
            issues_cmd(vec![], &c, &fake).await.unwrap(),
            [
                "web/shop on home",
                "  #12        working  br1          -      -",
                "mini: did not answer: http://mini:7850: ECONNREFUSED",
            ]
        );
        assert_eq!(
            issues_cmd(words(&["--backend", "http://x:1"]), &c, &fake)
                .await
                .unwrap(),
            ["web/shop", "  #12        working  br1          -      -"]
        );
    }

    #[tokio::test]
    async fn a_refusal_is_its_own_line_and_a_second_word_is_the_usage() {
        let refusing = Fake(|_: &Target, _: &str, path: &str, _: Option<&Value>| {
            if path == "/api/backends" {
                return Ok(json!({"self":"home","backends":[]}));
            }
            Err(AskError::Denied(
                "home refused: it needs the read right".into(),
            ))
        });
        let c = Caller::default();
        assert_eq!(
            issues_cmd(vec![], &c, &refusing).await.unwrap(),
            [
                "home: home refused: it needs the read right",
                "no GitHub or Forgejo issues taken"
            ]
        );
        let empty =
            Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| Ok(json!({"events": []})));
        assert_eq!(
            issues_cmd(words(&["web/none"]), &c, &empty).await.unwrap(),
            ["no GitHub or Forgejo issues taken in web/none"]
        );
        assert_eq!(
            issues_cmd(words(&["web/api", "--needs-you"]), &c, &empty)
                .await
                .unwrap(),
            ["no GitHub or Forgejo issues wait on you in web/api"]
        );
        assert_eq!(
            issues_cmd(words(&["a", "b"]), &c, &empty).await,
            Err(ISSUES_USAGE.into())
        );
    }
}
