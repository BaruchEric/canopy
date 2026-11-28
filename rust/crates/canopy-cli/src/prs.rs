//! `canopy pr` and `canopy prs` (FR-011, `src/cli/pr.ts`): open a PR for a
//! ready branch run, rebase one by hand (FR-035), and list every PR branch
//! runs opened with where its checks stand, over the API of every backend
//! the home one lists.

use crate::api::Caller;
use crate::ask::{Ask, AskError, Target, has, listed_targets, take};
use crate::issues::not_answered;
use canopy_core::pathx::{js_sorted_unique, pad_end};
use canopy_core::pr::checks_word;
use serde::Deserialize;
use serde_json::{Value, json};

/// `PR_USAGE`.
pub const PR_USAGE: &str = "usage: canopy pr <run> [--draft] [--backend URL]\n       canopy pr rebase <run> [--backend URL]\n       canopy prs [repo] [--backend URL]";

/// The fields of a PR watch (`PrWatch`) the CLI reads.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PrWatch {
    pub repo_id: String,
    pub repo_path: String,
    pub branch: String,
    pub target: String,
    pub number: f64,
    pub url: String,
    pub auto_fix: bool,
    pub auto_merge: bool,
    pub pushed: String,
    pub gave_up: Option<String>,
    pub error: Option<String>,
    pub fixing: Option<Fixing>,
    pub state: Option<PrState>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Fixing {
    pub run: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct PrState {
    pub status: String,
    pub draft: bool,
    pub checks: Vec<PrCheck>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct PrCheck {
    pub state: String,
}

/// `named()`: whether `repo` (an id or a folder's name) names this repo.
fn named(repo: Option<&str>, id: &str, path: &str) -> bool {
    repo.is_none_or(|r| id == r || path.rsplit('/').next() == Some(r))
}

/// `statusWord()`
fn status_word(w: &PrWatch) -> String {
    match &w.state {
        None => "not read".into(),
        Some(s) if s.status == "open" && s.draft => "draft".into(),
        Some(s) => s.status.clone(),
    }
}

/// `prsLines()`: one backend's PRs, a repo at a time: number, where it
/// stands, its checks, its branch, the toggles that are on and its link,
/// with a line under it when auto-fix gave up or the last read failed.
pub fn prs_lines(prs: &[PrWatch], repo: Option<&str>, backend: &str) -> Vec<String> {
    let where_ = if backend.is_empty() {
        String::new()
    } else {
        format!(" on {backend}")
    };
    let mut out = Vec::new();
    for id in js_sorted_unique(prs.iter().map(|w| w.repo_id.clone()).collect()) {
        let mut mine: Vec<&PrWatch> = prs
            .iter()
            .filter(|w| w.repo_id == id && named(repo, &id, &w.repo_path))
            .collect();
        if mine.is_empty() {
            continue;
        }
        mine.sort_by(|a, b| {
            (a.number - b.number)
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out.push(format!("{id}{where_}"));
        for w in mine {
            let on: Vec<&str> = [(w.auto_fix, "auto-fix"), (w.auto_merge, "auto-merge")]
                .iter()
                .filter(|(set, _)| *set)
                .map(|(_, word)| *word)
                .collect();
            let on = on.join(", ");
            let checks = w.state.as_ref().map_or_else(String::new, |s| {
                let states: Vec<&str> = s.checks.iter().map(|c| c.state.as_str()).collect();
                checks_word(&states)
            });
            let toggles = if on.is_empty() {
                String::new()
            } else {
                format!("  {on}")
            };
            out.push(format!(
                "  {} {} {} {}{toggles}  {}",
                pad_end(&format!("#{}", w.number), 4),
                pad_end(&status_word(w), 8),
                pad_end(&checks, 19),
                w.branch,
                w.url
            ));
            if let Some(g) = w.gave_up.as_deref().filter(|g| !g.is_empty()) {
                out.push(format!("       auto-fix gave up: {g}"));
            }
            if let Some(e) = w.error.as_deref().filter(|e| !e.is_empty()) {
                out.push(format!("       {e}"));
            }
        }
    }
    out
}

fn watch_of(v: Value) -> PrWatch {
    serde_json::from_value(v).unwrap_or_default()
}

/// `prCommand()`: the lines to print, or the failure.
pub(crate) async fn pr_cmd(
    cmd: &str,
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
) -> Result<Vec<String>, String> {
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    let home_target = Target::home(&home);
    let failed = |e: AskError| match e {
        AskError::Unreachable(m) => format!("home did not answer: {m}"),
        other => other.message().to_string(),
    };
    let shift = |a: &mut Vec<String>| (!a.is_empty()).then(|| a.remove(0));
    if cmd == "pr" && args.first().map(String::as_str) == Some("rebase") {
        args.remove(0);
        let run = shift(&mut args).filter(|r| !r.is_empty());
        let (Some(run), true) = (run, args.is_empty()) else {
            return Err(PR_USAGE.into());
        };
        let w = watch_of(
            ask.ask(
                &home_target,
                "POST",
                "/api/prs/rebase",
                Some(&json!({ "run": run })),
            )
            .await
            .map_err(failed)?,
        );
        if let Some(g) = w.gave_up.as_deref().filter(|g| !g.is_empty()) {
            return Err(format!("{}: {g}", w.branch));
        }
        if let Some(e) = w.error.as_deref().filter(|e| !e.is_empty()) {
            return Err(format!("{}: {e}", w.branch));
        }
        return Ok(vec![match &w.fixing {
            Some(f) => format!(
                "{}: rebasing onto {} stopped on conflicts; fix run {} is on them",
                w.branch, w.target, f.run
            ),
            None => format!(
                "{}: rebased onto {} and pushed ({})",
                w.branch,
                w.target,
                w.pushed.chars().take(7).collect::<String>()
            ),
        }]);
    }
    if cmd == "pr" {
        let draft = has(&mut args, "--draft");
        let run = shift(&mut args).filter(|r| !r.is_empty());
        let (Some(run), true) = (run, args.is_empty()) else {
            return Err(PR_USAGE.into());
        };
        let body = if draft {
            json!({ "run": run, "draft": true })
        } else {
            json!({ "run": run })
        };
        let w = watch_of(
            ask.ask(&home_target, "POST", "/api/prs/open", Some(&body))
                .await
                .map_err(failed)?,
        );
        let opened = if draft { "opened as a draft" } else { "opened" };
        return Ok(vec![format!(
            "{}: PR #{} {opened} against {}: {}",
            w.branch, w.number, w.target, w.url
        )]);
    }
    let repo = shift(&mut args);
    if !args.is_empty() {
        return Err(PR_USAGE.into());
    }
    let targets = listed_targets(ask, &home, given.is_some()).await;
    let mut out = Vec::new();
    let mut any = false;
    for t in &targets {
        let prs: Vec<PrWatch> = match ask.ask(t, "GET", "/api/prs", None).await {
            Ok(Value::Array(ws)) => ws.into_iter().map(watch_of).collect(),
            Ok(_) => Vec::new(),
            Err(e) => {
                out.push(format!("{}: {}", t.name, not_answered(&e)));
                continue;
            }
        };
        let backend = if targets.len() > 1 {
            t.name.as_str()
        } else {
            ""
        };
        let lines = prs_lines(&prs, repo.as_deref(), backend);
        any |= !lines.is_empty();
        out.extend(lines);
    }
    if !any {
        out.push(match repo.as_deref().filter(|r| !r.is_empty()) {
            Some(r) => format!("no PRs from branch runs in {r}"),
            None => "no PRs from branch runs".into(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;

    fn watch(over: Value) -> Value {
        let mut base = json!({
            "id": "b1", "runId": "r1", "repoId": "dev-tools/canopy",
            "repoPath": "/dev/dev-tools/canopy", "branch": "run/x-b1", "target": "main",
            "dir": "/w/b1", "note": "n", "slug": "o/r", "remote": "origin", "number": 12,
            "url": "https://github.com/o/r/pull/12", "autoFix": false, "autoMerge": false,
            "pushed": "h1", "attempts": {}, "seenComment": 0, "openedAt": 1, "updatedAt": 1
        });
        for (k, v) in over.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    fn state(over: Value) -> Value {
        let mut base = json!({
            "number": 12, "url": "https://github.com/o/r/pull/12", "status": "open",
            "draft": false, "additions": 40, "deletions": 12, "files": 3, "head": "h1",
            "mergeable": "MERGEABLE", "mergeState": "CLEAN", "review": "none",
            "checks": [{"name": "test", "state": "pass"}]
        });
        for (k, v) in over.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn each_repos_prs_with_checks_toggles_and_what_needs_a_look() {
        let prs: Vec<PrWatch> = [
            watch(json!({"state": state(json!({}))})),
            watch(json!({"id":"b2","number":13,"branch":"run/x-b2","autoFix":true,"autoMerge":true,"gaveUp":"test failed 3 times","state":state(json!({"number":13,"checks":[{"name":"test","state":"fail"}]}))})),
            watch(json!({"id":"b3","number":14,"branch":"run/x-b3","state":state(json!({"number":14,"status":"merged"}))})),
            watch(json!({"id":"b4","repoId":"web-apps/tally","repoPath":"/dev/web-apps/tally","number":3,"branch":"run/x-b4"})),
        ]
        .into_iter()
        .map(watch_of)
        .collect();
        assert_eq!(
            prs_lines(&prs, None, ""),
            [
                "dev-tools/canopy",
                "  #12  open     checks passed       run/x-b1  https://github.com/o/r/pull/12",
                "  #13  open     checks: 1 failed    run/x-b2  auto-fix, auto-merge  https://github.com/o/r/pull/12",
                "       auto-fix gave up: test failed 3 times",
                "  #14  merged   checks passed       run/x-b3  https://github.com/o/r/pull/12",
                "web-apps/tally",
                "  #3   not read                     run/x-b4  https://github.com/o/r/pull/12",
            ]
        );
        assert_eq!(
            prs_lines(&prs, Some("tally"), "mini")[0],
            "web-apps/tally on mini"
        );
        assert!(prs_lines(&prs, Some("other"), "").is_empty());
    }

    fn words(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn pr_rebase_posts_the_run_and_prints_the_new_head() {
        let calls = std::sync::Mutex::new(Vec::<(String, String, Option<Value>)>::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            calls.lock().unwrap().push((m.into(), p.into(), b.cloned()));
            Ok(watch(json!({"pushed": "h2h2h2h2h2h2h2h2h2h2"})))
        });
        let c = Caller::default();
        assert_eq!(
            pr_cmd("pr", words(&["rebase", "b1"]), &c, &fake)
                .await
                .unwrap(),
            ["run/x-b1: rebased onto main and pushed (h2h2h2h)"]
        );
        assert_eq!(
            *calls.lock().unwrap(),
            [(
                "POST".to_string(),
                "/api/prs/rebase".to_string(),
                Some(json!({"run": "b1"}))
            )]
        );
        assert_eq!(
            pr_cmd("pr", words(&["rebase"]), &c, &fake).await,
            Err(PR_USAGE.into())
        );
        let refused = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err(AskError::Refused {
                message: "the head moved since canopy pushed".into(),
                status: 409,
            })
        });
        assert_eq!(
            pr_cmd("pr", words(&["rebase", "b1"]), &c, &refused).await,
            Err("the head moved since canopy pushed".into())
        );
        let stopped = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Ok(watch(
                json!({"gaveUp": "the branch moved on GitHub since canopy pushed; rebase it yourself"}),
            ))
        });
        assert_eq!(
            pr_cmd("pr", words(&["rebase", "b1"]), &c, &stopped).await,
            Err(
                "run/x-b1: the branch moved on GitHub since canopy pushed; rebase it yourself"
                    .into()
            )
        );
        let conflict = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Ok(watch(json!({"fixing": {"run": "f9", "key": "rebase:abc"}})))
        });
        assert_eq!(
            pr_cmd("pr", words(&["rebase", "b1"]), &c, &conflict)
                .await
                .unwrap(),
            ["run/x-b1: rebasing onto main stopped on conflicts; fix run f9 is on them"]
        );
        let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err(AskError::Unreachable(
                "http://127.0.0.1:7850: ECONNREFUSED".into(),
            ))
        });
        assert_eq!(
            pr_cmd("pr", words(&["rebase", "b1"]), &c, &down).await,
            Err("home did not answer: http://127.0.0.1:7850: ECONNREFUSED".into())
        );
    }

    #[tokio::test]
    async fn pr_opens_and_prs_lists_or_says_there_are_none() {
        let fake = Fake(
            |_: &Target, m: &str, p: &str, b: Option<&Value>| match (m, p) {
                ("POST", _) => {
                    assert_eq!(b, Some(&json!({"run": "b1", "draft": true})));
                    Ok(watch(json!({})))
                }
                (_, "/api/backends") => Ok(json!({})),
                _ => Ok(json!([])),
            },
        );
        let c = Caller::default();
        assert_eq!(
            pr_cmd("pr", words(&["b1", "--draft"]), &c, &fake)
                .await
                .unwrap(),
            ["run/x-b1: PR #12 opened as a draft against main: https://github.com/o/r/pull/12"]
        );
        assert_eq!(
            pr_cmd("pr", words(&[]), &c, &fake).await,
            Err(PR_USAGE.into())
        );
        assert_eq!(
            pr_cmd("prs", words(&[]), &c, &fake).await.unwrap(),
            ["no PRs from branch runs"]
        );
        assert_eq!(
            pr_cmd("prs", words(&["tally"]), &c, &fake).await.unwrap(),
            ["no PRs from branch runs in tally"]
        );
        assert_eq!(
            pr_cmd("prs", words(&["a", "b"]), &c, &fake).await,
            Err(PR_USAGE.into())
        );
    }
}
