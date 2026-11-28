//! `canopy groups` (`src/cli/groups.ts`): best-of-N runs and their members
//! on every backend, and picking a group's winner on the backend that holds
//! it.

use crate::api::Caller;
use crate::ask::{
    Ask, AskError, Target, did_not_answer, every_target, is_origin, shift, skipped_line, take,
};
use crate::out::Out;
use canopy_core::group::group_word;
use canopy_core::js::{field, list_at, str_at, truthy_at};
use canopy_core::pathx::basename;
use serde_json::{Value, json};

/// `GROUPS_USAGE`.
pub const GROUPS_USAGE: &str = "usage: canopy groups [repo] [--backend URL] [--on NAME]\n       canopy groups pick <group> <run> [--backend URL] [--on NAME]";

/// `commandTargets()`: home alone for --backend, the one --on names, else
/// every backend home lists.
async fn command_targets(
    ask: &impl Ask,
    home: &str,
    given: bool,
    on: Option<&str>,
) -> Result<Vec<Target>, String> {
    if !is_origin(home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    if given && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }
    if given {
        return Ok(vec![Target::home(home)]);
    }
    let all = match every_target(ask, home).await {
        Ok(all) => all,
        // --on needs the list, so its failure is the command's
        Err(e) if on.is_some() => return Err(did_not_answer("home", &e)),
        Err(_) => vec![Target::home(home)],
    };
    let Some(name) = on else {
        return Ok(all);
    };
    match all.iter().find(|t| t.name == name) {
        Some(t) => Ok(vec![t.clone()]),
        None => Err(format!(
            "no backend named {name}; the home backend lists {}",
            all.iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// `repoMatches()`: the repo by id, path, folder name or the id's last part.
fn repo_matches(repo: Option<&str>, group: &Value) -> bool {
    let Some(repo) = repo else {
        return true;
    };
    let id = str_at(group, "repoId").unwrap_or("");
    let path = str_at(group, "repoPath").unwrap_or("");
    let local = id.rsplit('|').next().unwrap_or(id);
    let id_name = local.rsplit(['/', ':']).next().unwrap_or(local);
    repo == id || repo == path || repo == basename(path) || repo == id_name
}

/// `groupLines()`: a header per group and a line per member, from the live
/// landing row for its branch and state while the dry score is pending.
pub fn group_lines(info: &Value, repo: Option<&str>, backend: &str) -> Vec<String> {
    let at = if backend.is_empty() {
        String::new()
    } else {
        format!(" on {backend}")
    };
    let runs = list_at(info, "runs");
    let mut out = Vec::new();
    for group in list_at(info, "groups")
        .iter()
        .filter(|g| repo_matches(repo, g))
    {
        out.push(format!(
            "{}  {}  {}{at}",
            field(group, "id"),
            group_word(group),
            field(group, "repoId")
        ));
        for member in list_at(group, "members") {
            let run = runs.iter().find(|c| {
                c.get("id") == member.get("origin") || c.get("runId") == member.get("run")
            });
            let score = group
                .get("scores")
                .zip(str_at(member, "origin"))
                .and_then(|(s, o)| s.get(o));
            let pick = |key: &str| {
                run.and_then(|r| r.get(key))
                    .filter(|v| !v.is_null())
                    .or_else(|| score.and_then(|s| s.get(key)).filter(|v| !v.is_null()))
            };
            let branch = pick("branch").map_or_else(
                || field(member, "origin"),
                |v| canopy_core::js::template(Some(v)),
            );
            let state = pick("state").map_or_else(
                || "unknown".to_string(),
                |v| canopy_core::js::template(Some(v)),
            );
            let profile = if truthy_at(member, "profile") {
                format!("  {}", field(member, "profile"))
            } else {
                String::new()
            };
            out.push(format!("  {branch}  {state}{profile}"));
        }
    }
    out
}

/// `pickGroup()`: the winner, on the backend named or the one that has the
/// group.
async fn pick_group(
    ask: &impl Ask,
    group_id: &str,
    run: &str,
    targets: &[Target],
    direct: bool,
    out: &mut Out,
) -> Result<(), String> {
    let selected = if direct {
        targets.first().cloned()
    } else {
        let mut results: Vec<(&Target, Result<Value, AskError>)> = Vec::new();
        for t in targets {
            results.push((t, ask.ask(t, "GET", "/api/groups", None).await));
        }
        let matches: Vec<&Target> = results
            .iter()
            .filter_map(|(t, r)| r.as_ref().ok().map(|groups| (t, groups)))
            .flat_map(|(t, groups)| {
                groups
                    .as_array()
                    .map_or(&[][..], Vec::as_slice)
                    .iter()
                    .filter(|g| str_at(g, "id") == Some(group_id))
                    .map(move |_| *t)
            })
            .collect();
        if matches.len() > 1 {
            let names: Vec<&str> = matches.iter().map(|t| t.name.as_str()).collect();
            return Err(format!(
                "{group_id} is on {}; say which with --on NAME",
                names.join(" and ")
            ));
        }
        match matches.first() {
            Some(t) => Some((*t).clone()),
            None => {
                let errors: Vec<String> = results
                    .iter()
                    .filter_map(|(t, r)| {
                        r.as_ref()
                            .err()
                            .map(|e| format!("{}: {}", t.name, e.message()))
                    })
                    .collect();
                if !errors.is_empty() {
                    return Err(format!("could not find {group_id}; {}", errors.join("; ")));
                }
                return Err(format!("no group {group_id}; canopy groups lists them"));
            }
        }
    };
    let Some(selected) = selected else {
        return Err(GROUPS_USAGE.into());
    };
    ask.ask(
        &selected,
        "POST",
        "/api/groups/pick",
        Some(&json!({ "group": group_id, "run": run })),
    )
    .await
    .map_err(|e| did_not_answer(&selected.name, &e))?;
    let on = if direct {
        String::new()
    } else {
        format!(" on {}", selected.name)
    };
    out.line(format!("picked {run} in {group_id}{on}"));
    Ok(())
}

/// `groupsCommand()`.
pub(crate) async fn groups_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let backend_flag = args.iter().any(|a| a == "--backend");
    let given = take(&mut args, "--backend");
    let on_flag = args.iter().any(|a| a == "--on");
    let on = take(&mut args, "--on");
    if backend_flag && given.is_none() {
        return Err("--backend needs a value".into());
    }
    if on_flag && on.is_none() {
        return Err("--on needs a value".into());
    }
    let home = caller.api_base(given.as_deref());
    let targets = command_targets(ask, &home, given.is_some(), on.as_deref()).await?;
    if args.first().map(String::as_str) == Some("pick") {
        args.remove(0);
        let group = shift(&mut args).filter(|g| !g.is_empty());
        let run = shift(&mut args).filter(|r| !r.is_empty());
        let (Some(group), Some(run)) = (group, run) else {
            return Err(GROUPS_USAGE.into());
        };
        if !args.is_empty() {
            return Err(GROUPS_USAGE.into());
        }
        let direct = given.is_some() || on.is_some();
        return pick_group(ask, &group, &run, &targets, direct, out).await;
    }
    let repo = shift(&mut args);
    if !args.is_empty() {
        return Err(GROUPS_USAGE.into());
    }
    let mut any = false;
    for t in &targets {
        match ask.ask(t, "GET", "/api/landing", None).await {
            Ok(info) => {
                let backend = if targets.len() > 1 {
                    t.name.as_str()
                } else {
                    ""
                };
                let lines = group_lines(&info, repo.as_deref(), backend);
                any |= !lines.is_empty();
                out.lines(lines);
            }
            Err(e) => out.line(skipped_line(&t.name, &e)),
        }
    }
    if !any {
        out.line(match repo.as_deref().filter(|r| !r.is_empty()) {
            Some(r) => format!("no groups in {r}"),
            None => "no groups".into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;
    use std::sync::Mutex;

    fn group() -> Value {
        json!({"id": "g-1234abcd", "repoId": "app", "repoPath": "/work/app", "action": "ask", "note": "add a file", "expectedMembers": 1, "members": [{"run": "run-1", "origin": "origin-1", "profile": null}], "state": "working", "autoLand": false, "startedAt": 1})
    }

    fn landing() -> Value {
        json!({"runs": [{"id": "origin-1", "group": "g-1234abcd", "runId": "run-1", "repoId": "app", "repoPath": "/work/app", "branch": "feature/add-a-file", "target": "main", "base": "abc123", "dir": "/work/app/.worktrees/run-1", "note": "add a file", "verb": "ask", "harness": "codex", "state": "working", "startedAt": 1}], "entries": [], "orphans": [], "groups": [group()]})
    }

    #[tokio::test]
    async fn the_list_names_each_member_branch_and_state() {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, _: Option<&Value>| {
            seen.lock().unwrap().push(format!("{m} {p}"));
            Ok(landing())
        });
        let caller = Caller::default();
        let mut out = Out::default();
        let args = ["app", "--backend", "http://x:1"]
            .map(String::from)
            .to_vec();
        groups_cmd(args, &caller, &fake, &mut out).await.unwrap();
        assert_eq!(seen.into_inner().unwrap(), ["GET /api/landing"]);
        assert_eq!(
            out.printed(),
            ["g-1234abcd  working  app", "  feature/add-a-file  working"]
        );
    }

    #[tokio::test]
    async fn pick_goes_to_the_backend_that_holds_the_group() {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|t: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{} {m} {p} {}",
                t.name,
                b.map(Value::to_string).unwrap_or_default()
            ));
            Ok(match (t.name.as_str(), p) {
                (_, "/api/backends") => {
                    json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}]})
                }
                ("mini", "/api/groups") => json!([group()]),
                ("mini", _) => group(),
                _ => json!([]),
            })
        });
        let mut out = Out::default();
        let args = ["pick", "g-1234abcd", "run-1"].map(String::from).to_vec();
        groups_cmd(args, &Caller::default(), &fake, &mut out)
            .await
            .unwrap();
        assert_eq!(
            seen.into_inner().unwrap(),
            [
                "home GET /api/backends ",
                "mac GET /api/groups ",
                "mini GET /api/groups ",
                "mini POST /api/groups/pick {\"group\":\"g-1234abcd\",\"run\":\"run-1\"}",
            ]
        );
        assert_eq!(out.printed(), ["picked run-1 in g-1234abcd on mini"]);
    }

    #[test]
    fn a_member_names_its_profile() {
        let info = json!({"groups": [{"id": "g-1", "repoId": "app", "repoPath": "/r/app", "state": "working", "members": [{"run": "r1", "origin": "o1", "profile": "codex-fast"}, {"run": "r2", "origin": "o2", "profile": null}]}], "runs": []});
        let lines = group_lines(&info, None, "");
        assert_eq!(lines[1], "  o1  unknown  codex-fast");
        assert_eq!(lines[2], "  o2  unknown");
        assert!(group_lines(&info, Some("app"), "").len() == 3);
        assert!(group_lines(&info, Some("other"), "").is_empty());
    }
}
