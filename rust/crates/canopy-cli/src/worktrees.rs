//! `canopy worktrees` (`src/cli/worktrees.ts`, FR-051): show this
//! backend's run, warm and kept trees, set a repo's warm count, prune its
//! orphans and stale slots, and make, sync, merge, clean up, remove and
//! find the trees kept by hand.

use crate::api::Caller;
use crate::ask::{
    Ask, AskError, Target, did_not_answer, encode_component, has, is_origin, shift, take,
};
use crate::out::Out;
use canopy_core::js::{field, list_at, num_at, str_at, truthy, truthy_at};
use canopy_core::pathx::resolve;
use canopy_core::treewords::tree_words;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// `WORKTREES_USAGE`.
pub const WORKTREES_USAGE: &str = "usage: canopy worktrees [repo] [--json] [--backend URL]
       canopy worktrees warm <repo> [N] [--backend URL]
       canopy worktrees prune [repo] [--backend URL]
       canopy worktrees add <repo> <branch> [--base REF] [--no-caches] [--no-sync] [--backend URL]
       canopy worktrees sync <repo> <branch> [--backend URL]
       canopy worktrees auto <repo> <branch> on|off [--backend URL]
       canopy worktrees merge <repo> <branch> [--no-squash] [--no-commit] [--keep] [--backend URL]
       canopy worktrees clean [repo] [--backend URL]
       canopy worktrees rm <repo> <branch> [--force] [--delete-branch] [--backend URL]
       canopy worktrees path <repo> <branch> [--backend URL]
       canopy worktrees start <repo> <run branch> [task] [--backend URL]
       canopy worktrees stop <repo> <run branch> [task] [--backend URL]
       canopy worktrees shell-init";

/// `MERGE_POLL`: how often `merge` asks after the tree.
pub const MERGE_POLL: Duration = Duration::from_millis(1_000);
/// `MERGE_WAIT`: how long it asks at most (the gates may take a while).
const MERGE_WAIT: Duration = Duration::from_millis(30 * 60_000);

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;
const MB: f64 = 1024.0 * 1024.0;
const GB: f64 = 1024.0 * MB;

/// `ageWord()`: "2h", "3d", "5m", "now".
pub fn age_word(ms: f64) -> String {
    let age = if ms.is_nan() { f64::NAN } else { ms.max(0.0) };
    if age < MINUTE {
        "now".into()
    } else if age < HOUR {
        format!("{}m", (age / MINUTE).floor())
    } else if age < DAY {
        format!("{}h", (age / HOUR).floor())
    } else {
        format!("{}d", canopy_core::store::js_number((age / DAY).floor()))
    }
}

/// `new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })`: the
/// shortest decimal that reads back as `x`, rounded half away from zero
/// to one place, its thousands grouped with commas.
fn intl_one_place(x: f64) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN".into()
        } else if x > 0.0 {
            "∞".into()
        } else {
            "-∞".into()
        };
    }
    let neg = x < 0.0;
    // Rust prints the shortest round-trip digits, never in exponent form
    let s = format!("{}", x.abs());
    let (whole, frac) = s.split_once('.').unwrap_or((&s, ""));
    let mut digits: Vec<u8> = whole.bytes().map(|b| b - b'0').collect();
    let first = frac.bytes().next().map_or(0, |b| b - b'0');
    digits.push(first);
    let up = frac.as_bytes().get(1).is_some_and(|b| *b >= b'5');
    if up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let tenth = digits.pop().unwrap_or(0);
    let int: String = digits.iter().map(|d| char::from(b'0' + d)).collect();
    let int = int.trim_start_matches('0');
    let int = if int.is_empty() { "0" } else { int };
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let body = if tenth == 0 {
        grouped
    } else {
        format!("{grouped}.{tenth}")
    };
    if neg && body != "0" {
        format!("-{body}")
    } else {
        body
    }
}

/// `sizeWord()`: "312 MB", "1.2 GB".
pub fn size_word(bytes: f64) -> String {
    let (unit, label) = if bytes >= GB { (GB, "GB") } else { (MB, "MB") };
    format!("{} {label}", intl_one_place(bytes / unit))
}

/// `named()`: a repo named by its id, its folder's name, or its id's last
/// part.
fn named(repo: &str, entry: &Value) -> bool {
    let id = field(entry, "repoId");
    let local = id.rsplit('|').next().unwrap_or(&id);
    let id_name = local.rsplit(['/', ':']).next().unwrap_or(local);
    let path = field(entry, "repoPath");
    let folder = path.rsplit('/').next().unwrap_or("");
    repo == id || repo == folder || repo == id_name
}

/// `hasKeptWorktrees()`.
fn has_kept_worktrees(repo: &Value) -> bool {
    num_at(repo, "want").is_some_and(|w| w > 0.0)
        || !list_at(repo, "runs").is_empty()
        || !list_at(repo, "warm").is_empty()
        || repo.get("refilling") != Some(&Value::Null)
        || !list_at(repo, "fails").is_empty()
        || !list_at(repo, "orphans").is_empty()
}

/// `keptTrees()`: the trees a backend keeps by hand for one repo; none when
/// the backend predates them.
fn kept_trees<'a>(trees: Option<&'a Value>, repo_id: &str) -> &'a [Value] {
    trees
        .and_then(|t| {
            list_at(t, "repos")
                .iter()
                .find(|r| str_at(r, "repoId") == Some(repo_id))
        })
        .map_or(&[][..], |r| list_at(r, "trees"))
}

fn tree_line(t: &Value) -> String {
    format!(
        "  tree    {}  {}  {}",
        field(t, "branch"),
        tree_words(t),
        field(t, "dir")
    )
}

fn trees_kept(n: usize) -> String {
    format!("{n} tree{} kept", if n == 1 { "" } else { "s" })
}

/// `worktreeLines()`: one repo at a time, its runs, kept trees, warm slots,
/// failures and orphans, then free disk.
pub fn worktree_lines(
    info: &Value,
    repo: Option<&str>,
    now: f64,
    trees: Option<&Value>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in list_at(info, "repos") {
        let id = field(entry, "repoId");
        seen.push(id.clone());
        let kept = kept_trees(trees, &id);
        if repo.is_some_and(|r| !named(r, entry)) {
            continue;
        }
        let has_kept = has_kept_worktrees(entry);
        if repo.is_none() && !has_kept && kept.is_empty() {
            continue;
        }
        if !has_kept {
            out.push(if kept.is_empty() {
                format!("{id}  nothing kept")
            } else {
                format!("{id}  {}", trees_kept(kept.len()))
            });
        } else {
            let file_warm = entry.get("fileWarm");
            let gates = match file_warm {
                Some(fw) if Some(fw) != entry.get("want") => {
                    format!(" (the gates file says {})", field(entry, "fileWarm"))
                }
                _ => String::new(),
            };
            out.push(format!("{id}  {} warm wanted{gates}", field(entry, "want")));
        }
        for run in list_at(entry, "runs") {
            out.push(format!(
                "  run     {}  {}  {}",
                field(run, "branch"),
                field(run, "state"),
                field(run, "dir")
            ));
            if let Some(task) = run.get("task").filter(|t| truthy(Some(t))) {
                let port = if task.get("port").is_some() {
                    format!("  :{}", field(task, "port"))
                } else {
                    String::new()
                };
                out.push(format!(
                    "  task    {}  {}{port}",
                    field(task, "name"),
                    field(task, "status")
                ));
            }
        }
        for t in kept {
            out.push(tree_line(t));
        }
        for warm in list_at(entry, "warm") {
            let base: String = field(warm, "base").chars().take(7).collect();
            out.push(format!(
                "  warm    {}  {base}  {}  {}",
                field(warm, "name"),
                age_word(now - num_at(warm, "madeAt").unwrap_or(f64::NAN)),
                size_word(num_at(warm, "size").unwrap_or(f64::NAN))
            ));
        }
        if truthy_at(entry, "refilling") {
            out.push(format!(
                "  warm    {}  refilling",
                field(entry, "refilling")
            ));
        }
        for failure in list_at(entry, "fails") {
            out.push(format!(
                "  warm    {}  failed {}x: {}",
                field(failure, "name"),
                field(failure, "fails"),
                field(failure, "why")
            ));
        }
        for orphan in list_at(entry, "orphans") {
            out.push(format!(
                "  orphan  {}",
                canopy_core::js::template(Some(orphan))
            ));
        }
    }
    // a repo the pool never lists but a tree was kept for
    for entry in trees.map_or(&[][..], |t| list_at(t, "repos")) {
        let id = field(entry, "repoId");
        let list = list_at(entry, "trees");
        if seen.contains(&id) || list.is_empty() {
            continue;
        }
        if repo.is_some_and(|r| !named(r, entry)) {
            continue;
        }
        out.push(format!("{id}  {}", trees_kept(list.len())));
        for t in list {
            out.push(tree_line(t));
        }
    }
    out.push(format!(
        "free {} under {}",
        size_word(num_at(info, "free").unwrap_or(f64::NAN)),
        field(info, "root")
    ));
    out
}

/// `branchIdOf()`: a run's branch id, from its id or its branch's name;
/// what nothing lists (a run still starting) is passed on.
pub fn branch_id_of(entry: Option<&Value>, name: &str) -> String {
    entry
        .and_then(|e| {
            list_at(e, "runs")
                .iter()
                .find(|r| str_at(r, "id") == Some(name) || str_at(r, "branch") == Some(name))
        })
        .and_then(|r| r.get("id").filter(|i| !i.is_null()))
        .map_or_else(|| name.to_string(), |i| canopy_core::js::template(Some(i)))
}

/// `treeTaskLine()`: what a start or stop left in the worktree.
pub fn tree_task_line(result: &Value, id: &str, name: Option<&str>, start: bool) -> String {
    let t = list_at(result, "trees").iter().find(|x| {
        x.get("tree")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            == Some(id)
            && name.is_none_or(|n| str_at(x, "name") == Some(n))
    });
    let Some(t) = t else {
        return format!(
            "{} {}",
            if start { "started" } else { "stopped" },
            name.unwrap_or("the dev task")
        );
    };
    let branch = t
        .get("tree")
        .map_or_else(|| "undefined".into(), |tr| field(tr, "branch"));
    if !start {
        return format!("stopped {} in {branch}", field(t, "name"));
    }
    let port = if t.get("port").is_some() {
        format!(":{}", field(t, "port"))
    } else {
        "a port of its own".into()
    };
    format!("{} on {port} in {branch}", field(t, "name"))
}

/// `SHELL_INIT`: the shell function `canopy worktrees shell-init` prints.
pub const SHELL_INIT: &str = r#"# canopy worktrees shell-init: cw changes into a kept worktree by branch
cw() {
  local dir
  if [ "$#" -eq 1 ]; then
    dir="$(canopy worktrees path "$(basename "$PWD")" "$1")" || return
  elif [ "$#" -eq 2 ]; then
    dir="$(canopy worktrees path "$1" "$2")" || return
  else
    echo "usage: cw [repo] <branch>" >&2
    return 2
  fi
  cd "$dir" || return
}
"#;

/// `isPathArgument()` in src/cli/run.ts.
fn is_path_argument(v: &str) -> bool {
    v == "."
        || v.starts_with('/')
        || v.starts_with("./")
        || v.starts_with("../")
        || v.starts_with('~')
}

/// `folderOf()` in src/cli/run.ts: a path argument as the real folder it
/// names; fails when there is none.
fn folder_of(arg: &str) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".into());
    let expanded = match arg.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
        _ => arg.to_string(),
    };
    std::fs::canonicalize(resolve(&expanded))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| format!("no such folder: {arg}"))
}

/// `repoIdIn()`: a repo by its id or its folder's name, or by a path ("."
/// or one that starts with /, ./, ../ or ~), which takes only the repo at
/// that folder.
pub fn repo_id_in(info: &Value, name: &str) -> Result<String, String> {
    let repos = list_at(info, "repos");
    if is_path_argument(name) {
        let path = folder_of(name)?;
        return repos
            .iter()
            .find(|e| str_at(e, "repoPath") == Some(path.as_str()))
            .map(|e| field(e, "repoId"))
            .ok_or_else(|| format!("no repo at {path}"));
    }
    let found: Vec<&Value> = repos.iter().filter(|e| named(name, e)).collect();
    match found.as_slice() {
        [one] => Ok(field(one, "repoId")),
        [] => Err(format!("no repo named {name}")),
        many => Err(format!(
            "{name} matches more than one repo: {}; use an id",
            many.iter()
                .map(|e| field(e, "repoId"))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// `requestFailed`: "home did not answer: …" or the error's own words.
fn request_failed(e: AskError) -> String {
    did_not_answer("home", &e)
}

/// a branch word that is there and is no flag
fn branch_ok(b: &Option<String>) -> bool {
    b.as_deref()
        .is_some_and(|b| !b.is_empty() && !b.starts_with("--"))
}

fn some_word(w: &Option<String>) -> bool {
    w.as_deref().is_some_and(|w| !w.is_empty())
}

/// `worktreesCommand()`: inspect or change the worktrees kept by the home
/// backend. `poll` is how long `merge` waits between asks.
pub(crate) async fn worktrees_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    poll: Duration,
) -> Result<(), String> {
    if argv.first().map(String::as_str) == Some("shell-init") {
        if argv.len() > 1 {
            return Err(WORKTREES_USAGE.into());
        }
        out.write(SHELL_INIT);
        return Ok(());
    }
    let mut args = argv;
    let backend_flag = args.iter().any(|a| a == "--backend");
    let given = take(&mut args, "--backend");
    if backend_flag && given.as_deref().is_none_or(|g| g.starts_with("--")) {
        return Err("--backend needs a value".into());
    }
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let home_target = Target::home(&home);
    let target = &home_target;
    let get_info = move || async move {
        ask.ask(target, "GET", "/api/worktrees", None)
            .await
            .map_err(request_failed)
    };
    // a backend from before the kept trees answers 404 here: then there are none
    let get_trees = move || async move {
        match ask.ask(target, "GET", "/api/trees", None).await {
            Ok(t) => Ok(Some(t)),
            Err(e @ AskError::Unreachable(_)) => Err(request_failed(e)),
            Err(_) => Ok(None),
        }
    };
    let post = move |path: String, body: Value| async move {
        ask.ask(target, "POST", &path, Some(&body))
            .await
            .map_err(request_failed)
    };

    match args.first().map(String::as_str) {
        Some("warm") => {
            args.remove(0);
            let repo = shift(&mut args);
            let n_arg = shift(&mut args);
            if !some_word(&repo) || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let n = match &n_arg {
                None => None,
                Some(a) => {
                    let ok = !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit());
                    let n: f64 = if ok {
                        a.parse().unwrap_or(f64::NAN)
                    } else {
                        f64::NAN
                    };
                    if !ok || !(0.0..=2.0).contains(&n) {
                        return Err("warm must be a whole number from 0 to 2".into());
                    }
                    Some(n as i64)
                }
            };
            let id = repo_id_in(&get_info().await?, repo.as_deref().unwrap_or(""))?;
            let mut body = json!({"repo": id});
            if let Some(n) = n {
                body["n"] = json!(n);
            }
            let r = post("/api/worktrees/warm".into(), body).await?;
            out.line(format!("{}: {} warm", field(&r, "repo"), field(&r, "want")));
            Ok(())
        }
        Some(verb @ ("prune" | "clean")) => {
            let verb = verb.to_string();
            args.remove(0);
            let repo = shift(&mut args);
            if repo.as_deref().is_some_and(|r| r.starts_with("--")) || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let body = match &repo {
                None => json!({}),
                Some(r) => json!({"repo": repo_id_in(&get_info().await?, r)?}),
            };
            if verb == "prune" {
                let r = post("/api/worktrees/prune".into(), body).await?;
                let removed = list_at(&r, "removed");
                if removed.is_empty() {
                    out.line("nothing to prune");
                }
                for line in removed {
                    out.line(canopy_core::js::template(Some(line)));
                }
                return Ok(());
            }
            let r = post("/api/trees/clean".into(), body).await?;
            let removed = list_at(&r, "removed");
            if removed.is_empty() {
                out.line("nothing to clean: no tree is merged into its base with nothing changed or open in it");
            }
            for t in removed {
                out.line(format!(
                    "removed {}  {}  and its branch",
                    field(t, "repoId"),
                    field(t, "branch")
                ));
            }
            Ok(())
        }
        Some("add") => {
            args.remove(0);
            let base_flag = args.iter().any(|a| a == "--base");
            let base = take(&mut args, "--base");
            if base_flag && base.as_deref().is_none_or(|b| b.starts_with("--")) {
                return Err("--base needs a ref".into());
            }
            let caches = !has(&mut args, "--no-caches");
            let sync = !has(&mut args, "--no-sync");
            let repo = shift(&mut args);
            let branch = shift(&mut args);
            if !some_word(&repo) || !branch_ok(&branch) || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let id = repo_id_in(&get_info().await?, repo.as_deref().unwrap_or(""))?;
            let mut body = json!({"repo": id, "branch": branch});
            if let Some(b) = base {
                body["base"] = json!(b);
            }
            body["caches"] = json!(caches);
            if !sync {
                body["sync"] = json!(false);
            }
            let r = post("/api/trees/add".into(), body).await?;
            let tree = r.get("tree").unwrap_or(&Value::Null);
            let port = if tree.get("port") != Some(&Value::Null) {
                format!("  :{}", field(tree, "port"))
            } else {
                String::new()
            };
            out.line(format!(
                "{}  {}{port}",
                field(tree, "branch"),
                field(tree, "dir")
            ));
            if str_at(tree, "state") == Some("preparing") {
                out.line("preparing: the setup line runs and the caches clone in the background; canopy worktrees shows when it is ready");
            }
            Ok(())
        }
        Some(verb @ ("sync" | "path")) => {
            let verb = verb.to_string();
            args.remove(0);
            let repo = shift(&mut args);
            let branch = shift(&mut args);
            if !some_word(&repo) || !branch_ok(&branch) || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let branch = branch.unwrap_or_default();
            let id = repo_id_in(&get_info().await?, repo.as_deref().unwrap_or(""))?;
            if verb == "path" {
                let trees = get_trees().await?;
                let tree = kept_trees(trees.as_ref(), &id).iter().find(|t| {
                    str_at(t, "branch") == Some(branch.as_str())
                        || str_at(t, "slug") == Some(branch.as_str())
                });
                let Some(tree) = tree else {
                    return Err(format!("{id} keeps no tree on {branch}"));
                };
                out.line(field(tree, "dir"));
                return Ok(());
            }
            // a sync that stopped answers 409 with why, which request_failed prints
            let r = post(
                "/api/trees/sync".into(),
                json!({"repo": id, "tree": branch}),
            )
            .await?;
            let tree = r.get("tree").unwrap_or(&Value::Null);
            out.line(format!(
                "synced {} onto {}  {}",
                field(tree, "branch"),
                field(tree, "base"),
                tree_words(tree)
            ));
            Ok(())
        }
        Some("auto") => {
            args.remove(0);
            let repo = shift(&mut args);
            let branch = shift(&mut args);
            let on = shift(&mut args);
            let on_off = matches!(on.as_deref(), Some("on" | "off"));
            if !some_word(&repo) || !branch_ok(&branch) || !on_off || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let id = repo_id_in(&get_info().await?, repo.as_deref().unwrap_or(""))?;
            let body = json!({"repo": id, "tree": branch, "sync": on.as_deref() == Some("on")});
            let r = post("/api/trees/auto".into(), body).await?;
            let tree = r.get("tree").unwrap_or(&Value::Null);
            out.line(if truthy_at(tree, "sync") {
                format!("{} follows {}", field(tree, "branch"), field(tree, "base"))
            } else {
                format!(
                    "{} stays where it is while {} moves",
                    field(tree, "branch"),
                    field(tree, "base")
                )
            });
            Ok(())
        }
        Some("merge") => {
            args.remove(0);
            let squash = !has(&mut args, "--no-squash");
            let commit = !has(&mut args, "--no-commit");
            let keep = has(&mut args, "--keep");
            let repo = shift(&mut args);
            let branch = shift(&mut args);
            if !some_word(&repo) || !branch_ok(&branch) || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let id = repo_id_in(&get_info().await?, repo.as_deref().unwrap_or(""))?;
            let mut body = json!({"repo": id, "tree": branch});
            if !squash {
                body["squash"] = json!(false);
            }
            if !commit {
                body["commit"] = json!(false);
            }
            if keep {
                body["keep"] = json!(true);
            }
            let r = post("/api/trees/merge".into(), body).await?;
            let tree = r.get("tree").unwrap_or(&Value::Null);
            let (name, base) = (field(tree, "branch"), field(tree, "base"));
            out.line(format!(
                "merging {name} into {base}{}…",
                if squash { ", squashed" } else { "" }
            ));
            // the merge runs on the backend; the list says when the tree is
            // gone, or why it stopped
            let until = Instant::now() + MERGE_WAIT;
            while Instant::now() < until {
                tokio::time::sleep(poll).await;
                let trees = get_trees().await?;
                let slug = tree.get("slug");
                let Some(now) = kept_trees(trees.as_ref(), &id)
                    .iter()
                    .find(|t| t.get("slug") == slug)
                else {
                    out.line(format!(
                        "merged {name} into {base}; the tree and its branch are gone"
                    ));
                    return Ok(());
                };
                if str_at(now, "state") == Some("merging") {
                    continue;
                }
                if truthy_at(now, "stopped") {
                    return Err(field(now, "stopped"));
                }
                out.line(format!(
                    "merged {name} into {base}; the tree stays at {}",
                    field(now, "dir")
                ));
                return Ok(());
            }
            Err(format!(
                "still merging after {} minutes; canopy worktrees shows how it ends",
                MERGE_WAIT.as_secs() / 60
            ))
        }
        Some("rm") => {
            args.remove(0);
            let force = has(&mut args, "--force");
            let delete_branch = has(&mut args, "--delete-branch");
            let repo = shift(&mut args);
            let branch = shift(&mut args);
            if !some_word(&repo) || !branch_ok(&branch) || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let branch = branch.unwrap_or_default();
            let id = repo_id_in(&get_info().await?, repo.as_deref().unwrap_or(""))?;
            let mut body = json!({"repo": id, "tree": branch});
            if force {
                body["force"] = json!(true);
            }
            if delete_branch {
                body["deleteBranch"] = json!(true);
            }
            let r = post("/api/trees/remove".into(), body).await?;
            out.line(format!(
                "removed {}{}",
                field(&r, "removed"),
                if delete_branch {
                    format!(" and the branch {branch}")
                } else {
                    String::new()
                }
            ));
            Ok(())
        }
        Some(action @ ("start" | "stop")) => {
            let start = action == "start";
            args.remove(0);
            let repo = shift(&mut args);
            let branch = shift(&mut args);
            let name = shift(&mut args);
            let flagged = name.as_deref().is_some_and(|n| n.starts_with("--"));
            if !some_word(&repo) || !branch_ok(&branch) || flagged || !args.is_empty() {
                return Err(WORKTREES_USAGE.into());
            }
            let info = get_info().await?;
            let id = repo_id_in(&info, repo.as_deref().unwrap_or(""))?;
            let entry = list_at(&info, "repos")
                .iter()
                .find(|r| str_at(r, "repoId") == Some(id.as_str()));
            let worktree = branch_id_of(entry, branch.as_deref().unwrap_or(""));
            let mut body =
                json!({"action": if start { "start" } else { "stop" }, "worktree": worktree});
            // an empty name is sent as none but still printed as given
            if let Some(n) = name.as_deref().filter(|n| !n.is_empty()) {
                body["name"] = json!(n);
            }
            let r = post(
                format!("/api/repos/tasks?id={}", encode_component(&id)),
                body,
            )
            .await?;
            out.line(tree_task_line(&r, &worktree, name.as_deref(), start));
            Ok(())
        }
        _ => {
            let json_flags = args.iter().filter(|a| *a == "--json").count();
            let as_json = has(&mut args, "--json");
            let repo = shift(&mut args);
            if json_flags > 1
                || repo.as_deref().is_some_and(|r| r.starts_with("--"))
                || !args.is_empty()
            {
                return Err(WORKTREES_USAGE.into());
            }
            let info = get_info().await?;
            // a path such as . names the repo at that folder, as for the other forms
            let shown = match &repo {
                Some(r) if is_path_argument(r) => Some(repo_id_in(&info, r)?),
                other => other.clone(),
            };
            let trees = get_trees().await?;
            if as_json {
                let mut all = info.clone();
                if let (Some(t), Some(m)) = (&trees, all.as_object_mut()) {
                    m.insert("trees".into(), t.clone());
                }
                out.line(serde_json::to_string_pretty(&all).unwrap_or_default());
            } else {
                out.lines(worktree_lines(
                    &info,
                    shown.as_deref(),
                    now_ms(),
                    trees.as_ref(),
                ));
            }
            Ok(())
        }
    }
}

fn now_ms() -> f64 {
    canopy_core::types::now_ms() as f64
}

#[cfg(test)]
mod tests;
