//! `canopy land`, `canopy queue` and `canopy collisions`
//! (`src/cli/land.ts`): a ready branch run (or one a restart stopped with
//! its work whole) into its repo's landing queue, every ready run of a repo
//! at once, where every queue stands and who edits the same files, over the
//! API of every backend the home one lists.

use crate::api::Caller;
use crate::ask::{
    Ask, AskError, Target, did_not_answer, has, listed_targets, shift, skipped_line, take,
};
use crate::out::Out;
use canopy_core::js::{field, join, list_at, str_at, truthy_at};
use canopy_core::landing::{
    SCORE_GATE, in_queue, land_word, queue_of, review_word, sent_back, stopped_whole,
};
use canopy_core::pathx::{js_sorted_unique, pad_end};
use canopy_core::touch::with_name;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

/// `LAND_USAGE`.
pub const LAND_USAGE: &str = "usage: canopy land <run> [--approve <id>] [--skip-judge] [--backend URL]\n       canopy land followup <branch> [-m words] [--backend URL]\n       canopy land --all [repo] [--backend URL]\n       canopy queue [repo] [--backend URL]\n       canopy collisions [repo] [--backend URL]";

/// `backWords()`: why an entry came back.
fn back_words(e: &Value) -> String {
    let gate = str_at(e, "gate");
    let reason = str_at(e, "reason");
    if str_at(e, "state") == Some("red") {
        if gate.is_some_and(|g| g.starts_with(SCORE_GATE)) {
            return reason.or(gate).unwrap_or("").to_string();
        }
        return format!("{} failed", gate.unwrap_or("a gate"));
    }
    reason.map_or_else(|| field(e, "state"), String::from)
}

/// `named()`: whether `repo` (an id or a folder's name) names this repo.
fn named(repo: Option<&str>, id: &str, path: &str) -> bool {
    let Some(repo) = repo else {
        return true;
    };
    let local = id.rsplit('|').next().unwrap_or(id);
    let id_name = local.rsplit(['/', ':']).next().unwrap_or(local);
    id == repo || path.rsplit('/').next() == Some(repo) || id_name == repo
}

/// The repo's folder, from its first entry and else its first run.
fn repo_path<'a>(info: &'a Value, id: &str) -> &'a str {
    let first = |key: &str| {
        list_at(info, key)
            .iter()
            .find(|x| str_at(x, "repoId") == Some(id))
            .and_then(|x| str_at(x, "repoPath"))
    };
    first("entries").or_else(|| first("runs")).unwrap_or("")
}

fn repo_ids(list: &[Value]) -> Vec<String> {
    list.iter().map(|x| field(x, "repoId")).collect()
}

/// The overlap line a queued entry or a ready run carries.
fn overlap_line(x: &Value) -> Option<String> {
    let o = x
        .get("overlap")
        .filter(|o| canopy_core::js::truthy(Some(o)))?;
    Some(format!(
        "    overlaps with {}: {}",
        field(o, "with"),
        join(list_at(o, "paths"), ", ")
    ))
}

/// `queueLines()`: where one backend's queues stand, a repo at a time.
pub fn queue_lines(info: &Value, repo: Option<&str>, backend: &str) -> Vec<String> {
    let at = if backend.is_empty() {
        String::new()
    } else {
        format!(" on {backend}")
    };
    let entries = list_at(info, "entries");
    let runs = list_at(info, "runs");
    let mut ids = repo_ids(entries);
    ids.extend(repo_ids(runs));
    let mut out = Vec::new();
    for id in js_sorted_unique(ids) {
        if !named(repo, &id, repo_path(info, &id)) {
            continue;
        }
        let mine: Vec<&Value> = entries
            .iter()
            .filter(|e| str_at(e, "repoId") == Some(id.as_str()))
            .collect();
        let queued = queue_of(entries, &id);
        let back: Vec<&Value> = mine.iter().copied().filter(|e| sent_back(e)).collect();
        let taken: HashSet<String> = mine
            .iter()
            .filter(|e| in_queue(e) || str_at(e, "state") == Some("landed") || sent_back(e))
            .map(|e| field(e, "id"))
            .collect();
        let free = |r: &&Value| {
            str_at(r, "repoId") == Some(id.as_str()) && !taken.contains(&field(r, "id"))
        };
        let ready: Vec<&Value> = runs
            .iter()
            .filter(free)
            .filter(|r| str_at(r, "state") == Some("ready"))
            .collect();
        let stopped: Vec<&Value> = runs
            .iter()
            .filter(free)
            .filter(|r| stopped_whole(r))
            .collect();
        if queued.len() + back.len() + ready.len() + stopped.len() == 0 {
            continue;
        }
        out.push(format!("{id}{at}"));
        for e in queued {
            let reason = str_at(e, "reason").unwrap_or("");
            let marks: Vec<&str> = [
                if truthy_at(e, "auto") {
                    "joined on its own"
                } else {
                    ""
                },
                if truthy_at(e, "approved") {
                    "approved"
                } else {
                    ""
                },
                reason,
            ]
            .into_iter()
            .filter(|m| !m.is_empty())
            .collect();
            let marks = if marks.is_empty() {
                String::new()
            } else {
                format!("  {}", marks.join(", "))
            };
            let bypass = if str_at(e, "state") == Some("judge") {
                format!("  land anyway: canopy land {} --skip-judge", field(e, "id"))
            } else {
                String::new()
            };
            out.push(format!(
                "  {} {}{marks}{bypass}",
                pad_end(&land_word(e, entries), 16),
                field(e, "branch")
            ));
            out.extend(overlap_line(e));
        }
        for e in back {
            let why = back_words(e);
            out.push(format!(
                "  {} {}  {}",
                pad_end(&land_word(e, entries), 16),
                field(e, "branch"),
                why.rsplit('\n').next().unwrap_or("")
            ));
        }
        let verdict = |r: &Value| {
            r.get("review")
                .filter(|v| canopy_core::js::truthy(Some(v)))
                .map_or_else(|| "sorting".to_string(), review_word)
        };
        for r in ready {
            out.push(format!(
                "  {} {}  {}  canopy land {}",
                pad_end("ready", 16),
                field(r, "branch"),
                verdict(r),
                field(r, "runId")
            ));
            out.extend(overlap_line(r));
        }
        for r in stopped {
            out.push(format!(
                "  {} {}  can land: {}  canopy land {}",
                pad_end("stopped", 16),
                field(r, "branch"),
                verdict(r),
                field(r, "runId")
            ));
            out.extend(overlap_line(r));
        }
    }
    out
}

/// `collisionLines()`: a repo at a time, a line for each pair editing the
/// same files now.
pub fn collision_lines(info: &Value, repo: Option<&str>, backend: &str) -> Vec<String> {
    let at = if backend.is_empty() {
        String::new()
    } else {
        format!(" on {backend}")
    };
    let collisions = list_at(info, "collisions");
    let mut out = Vec::new();
    for id in js_sorted_unique(repo_ids(collisions)) {
        if !named(repo, &id, repo_path(info, &id)) {
            continue;
        }
        out.push(format!("{id}{at}"));
        for c in collisions
            .iter()
            .filter(|c| str_at(c, "repoId") == Some(id.as_str()))
        {
            let with = c.get("with").unwrap_or(&Value::Null);
            out.push(format!(
                "  {} and {}: {}",
                field(c, "name"),
                with_name(with),
                join(list_at(c, "paths"), ", ")
            ));
        }
    }
    out
}

/// `approveLines()`: each sensitive file with why, how to look at the
/// diff, and the command that approves the id this sort gave.
pub fn approve_lines(rec: &Value) -> Vec<String> {
    let Some(review) = rec
        .get("review")
        .filter(|r| canopy_core::js::truthy(Some(r)))
    else {
        return vec![format!(
            "{} is not sorted yet; try again in a moment",
            field(rec, "branch")
        )];
    };
    let files = list_at(review, "files");
    let look: Vec<&Value> = files.iter().filter(|f| truthy_at(f, "sensitive")).collect();
    let shown: Vec<&Value> = if look.is_empty() {
        files.iter().collect()
    } else {
        look
    };
    let mut paths: Vec<String> = Vec::new();
    for f in &shown {
        let mut add = |p: String| {
            if !paths.contains(&p) {
                paths.push(p);
            }
        };
        if f.get("from").is_some() {
            add(field(f, "from"));
        }
        add(field(f, "path"));
    }
    let short = |key: &str| field(review, key).chars().take(12).collect::<String>();
    let mut out = vec![format!("{} {}:", field(rec, "branch"), review_word(review))];
    for f in &shown {
        let name = if f.get("from").is_some() {
            format!("{} -> {}", field(f, "from"), field(f, "path"))
        } else {
            field(f, "path")
        };
        let why = ["sensitive", "why", "cls"]
            .iter()
            .find_map(|k| f.get(*k).filter(|v| !v.is_null()))
            .map_or_else(
                || "undefined".into(),
                |v| canopy_core::js::template(Some(v)),
            );
        out.push(format!("  {name}  {why}"));
    }
    out.push(format!(
        "look: git -C {} diff {} {} -- {}",
        field(rec, "dir"),
        short("base"),
        short("head"),
        paths.join(" ")
    ));
    out.push(format!(
        "then: canopy land {} --approve {}",
        field(rec, "runId"),
        str_at(review, "sensitiveId").unwrap_or("?")
    ));
    out
}

/// `landCommand()`: `cmd` is land, queue or collisions.
pub(crate) async fn land_cmd(
    cmd: &str,
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    let home_target = Target::home(&home);
    let failed = |e: AskError| did_not_answer("home", &e);
    if cmd == "land" && has(&mut args, "--all") {
        let repo = shift(&mut args);
        if !args.is_empty() {
            return Err(LAND_USAGE.into());
        }
        let info = ask
            .ask(&home_target, "GET", "/api/landing", None)
            .await
            .map_err(failed)?;
        let ready: Vec<String> = list_at(&info, "runs")
            .iter()
            .filter(|r| {
                str_at(r, "state") == Some("ready")
                    && named(
                        repo.as_deref(),
                        str_at(r, "repoId").unwrap_or(""),
                        str_at(r, "repoPath").unwrap_or(""),
                    )
            })
            .map(|r| field(r, "repoId"))
            .collect();
        let repos = js_sorted_unique(ready);
        if repos.is_empty() {
            out.line(match repo.as_deref().filter(|r| !r.is_empty()) {
                Some(r) => format!("nothing ready in {r}"),
                None => "nothing ready to land".into(),
            });
            return Ok(());
        }
        for id in repos {
            let got = ask
                .ask(
                    &home_target,
                    "POST",
                    "/api/landing/land-all",
                    Some(&json!({ "repo": id })),
                )
                .await
                .map_err(failed)?;
            out.line(format!("{id}: {} queued", list_at(&got, "queued").len()));
            for s in list_at(&got, "skipped") {
                out.line(format!(
                    "  left for you: {}  {}",
                    field(s, "branch"),
                    field(s, "why")
                ));
            }
        }
        return Ok(());
    }
    if cmd == "land" && args.first().map(String::as_str) == Some("followup") {
        args.remove(0);
        let note_flag = args.iter().any(|a| a == "-m");
        let note = take(&mut args, "-m");
        if note_flag && note.is_none() {
            return Err("-m needs words".into());
        }
        let id = match shift(&mut args) {
            Some(id) if !id.is_empty() && args.is_empty() => id,
            _ => return Err(LAND_USAGE.into()),
        };
        let mut body = Map::new();
        body.insert("id".into(), json!(id));
        if let Some(n) = note {
            body.insert("note".into(), json!(n));
        }
        let got = ask
            .ask(
                &home_target,
                "POST",
                "/api/landing/followup",
                Some(&Value::Object(body)),
            )
            .await
            .map_err(failed)?;
        let run = got.get("run").unwrap_or(&Value::Null);
        out.line(field(run, "id"));
        return Ok(());
    }
    if cmd == "land" {
        let approve = take(&mut args, "--approve");
        let skip_judge = has(&mut args, "--skip-judge");
        let run = match shift(&mut args) {
            Some(r) if !r.is_empty() && args.is_empty() => r,
            _ => return Err(LAND_USAGE.into()),
        };
        let mut body = Map::new();
        body.insert("run".into(), json!(run));
        if let Some(a) = approve.filter(|a| !a.is_empty()) {
            body.insert("approve".into(), json!(a));
        }
        if skip_judge {
            body.insert("skipJudge".into(), json!(true));
        }
        let entry = match ask
            .ask(
                &home_target,
                "POST",
                "/api/landing/land",
                Some(&Value::Object(body)),
            )
            .await
        {
            Ok(entry) => entry,
            Err(e) => {
                if matches!(e, AskError::Unreachable(_))
                    || !e.message().contains("needs your approval")
                {
                    return Err(failed(e));
                }
                // the land sorted it again just now, so the record holds what to show
                let info = ask
                    .ask(&home_target, "GET", "/api/landing", None)
                    .await
                    .map_err(failed)?;
                let rec = list_at(&info, "runs").iter().find(|r| {
                    str_at(r, "id") == Some(run.as_str())
                        || str_at(r, "runId") == Some(run.as_str())
                });
                let Some(rec) = rec else {
                    return Err(failed(e));
                };
                out.lines(approve_lines(rec));
                return Err(
                    "it needs your approval; look at the files, then run the command above".into(),
                );
            }
        };
        let branch = field(&entry, "branch");
        let target = field(&entry, "target");
        out.line(if skip_judge {
            format!(
                "{branch}: queued again with the judge scenarios left out; the queue rebases it onto {target}, runs the gates and the command scenarios, and fast-forwards {target}"
            )
        } else {
            format!(
                "{branch}: {}; the queue rebases it onto {target}, runs the gates and fast-forwards {target}",
                land_word(&entry, std::slice::from_ref(&entry))
            )
        });
        return Ok(());
    }
    let repo = shift(&mut args);
    if !args.is_empty() {
        return Err(LAND_USAGE.into());
    }
    let targets = listed_targets(ask, &home, given.is_some()).await;
    let mut any = false;
    for t in &targets {
        let info = match ask.ask(t, "GET", "/api/landing", None).await {
            Ok(i) => i,
            Err(e) => {
                out.line(skipped_line(&t.name, &e));
                continue;
            }
        };
        let backend = if targets.len() > 1 {
            t.name.as_str()
        } else {
            ""
        };
        let lines = if cmd == "queue" {
            queue_lines(&info, repo.as_deref(), backend)
        } else {
            collision_lines(&info, repo.as_deref(), backend)
        };
        any |= !lines.is_empty();
        out.lines(lines);
    }
    if !any {
        let r = repo.as_deref().filter(|r| !r.is_empty());
        out.line(match (cmd == "collisions", r) {
            (true, Some(r)) => format!("no collisions in {r}"),
            (true, None) => "no collisions".into(),
            (false, Some(r)) => format!("nothing queued, sent back or ready in {r}"),
            (false, None) => "nothing queued, sent back or ready".into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
