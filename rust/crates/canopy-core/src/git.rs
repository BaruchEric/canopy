//! Reading a repo through git: status, elsewhere, log and the parsers for
//! git's porcelain output (`src/core/git.ts`, the read half; writes such as
//! commit, push and pull are not ported yet, see docs/rust-port.md).

use crate::exec::{ExecOptions, ExecResult, GitTimeout, git, git_with, on_host};
use crate::host::{parse_locator, to_locator};
use crate::pathx::{join, js_trim, normalize, resolve_from};
use crate::seedgit::{seed_roots_now, seeds_root_of};
use crate::types::{
    BRANCH_WIP_CAP, BranchPush, BranchWip, Elsewhere, GitUser, LastCommit, Lines, LogEntry,
    RemoteTip, RepoFile, RepoStatus, StashWip, WorktreeWip,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// `Number(s) || 0` for the integers git prints.
pub fn js_int(s: &str) -> i64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0;
    }
    t.parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .map_or(0, |n| n as i64)
}

/// Resolve a repo-relative path, refusing anything that escapes the repo.
/// The check is lexical, so a remote repo's path serves as well.
pub fn repo_relative(repo_path: &str, file: &str) -> Result<String, String> {
    if file.is_empty() || file.starts_with('/') || file.contains('\0') {
        return Err(format!("invalid path: {file}"));
    }
    let root = normalize(&parse_locator(repo_path).path);
    let full = resolve_from(&root, file);
    if full != root && !full.starts_with(&format!("{}/", root.trim_end_matches('/'))) {
        return Err(format!("path escapes the repo: {file}"));
    }
    Ok(full)
}

/// Undo git's C-style path quoting. Even with core.quotePath=false git wraps
/// paths holding `"`, `\` or control characters in quotes and octal-escapes
/// the raw bytes; left as-is those names match no file on disk.
pub fn unquote_path(p: &str) -> String {
    if p.chars().count() < 2 || !p.starts_with('"') || !p.ends_with('"') {
        return p.to_string();
    }
    let chars: Vec<char> = p[1..p.len() - 1].chars().collect();
    let mut bytes: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch != '\\' {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            i += 1;
            continue;
        }
        i += 1;
        let Some(&next) = chars.get(i) else { break };
        let simple = match next {
            'a' => Some(7),
            'b' => Some(8),
            't' => Some(9),
            'n' => Some(10),
            'v' => Some(11),
            'f' => Some(12),
            'r' => Some(13),
            '"' => Some(34),
            '\\' => Some(92),
            _ => None,
        };
        if let Some(b) = simple {
            bytes.push(b);
            i += 1;
            continue;
        }
        if ('0'..='7').contains(&next) {
            let octal: String = chars[i..]
                .iter()
                .take(3)
                .take_while(|c| ('0'..='7').contains(*c))
                .collect();
            if let Ok(v) = u32::from_str_radix(&octal, 8) {
                bytes.push(v as u8);
                i += octal.chars().count();
                continue;
            }
        }
        let mut buf = [0u8; 4];
        bytes.extend_from_slice(next.encode_utf8(&mut buf).as_bytes());
        i += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Split into n fields on single spaces; the last field keeps its spaces.
fn split_n(line: &str, n: usize) -> Vec<&str> {
    let mut out = Vec::with_capacity(n);
    let mut rest = line;
    for _ in 0..n.saturating_sub(1) {
        let Some(sp) = rest.find(' ') else { break };
        out.push(&rest[..sp]);
        rest = &rest[sp + 1..];
    }
    out.push(rest);
    out
}

/// `git status --porcelain=v2 --branch`, before the commit and the user.
#[derive(Debug, Clone, PartialEq)]
pub struct Porcelain {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<RepoFile>,
}

static AB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\+(\d+) -(\d+)").unwrap());

fn xy(f: &[&str]) -> (String, String) {
    let xy = f.get(1).copied().unwrap_or("..");
    let mut c = xy.chars();
    (
        c.next().unwrap_or('.').to_string(),
        c.next().unwrap_or('.').to_string(),
    )
}

fn file(
    path: &str,
    orig: Option<String>,
    (index, worktree): (String, String),
    untracked: bool,
    conflicted: bool,
) -> RepoFile {
    RepoFile {
        path: unquote_path(path),
        orig,
        index,
        worktree,
        untracked,
        conflicted,
        mtime: None,
    }
}

/// Parse `git status --porcelain=v2 --branch` output.
pub fn parse_porcelain_v2(text: &str) -> Porcelain {
    let mut p = Porcelain {
        branch: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        files: vec![],
    };
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Some(h) = line.strip_prefix("# branch.head ") {
            p.branch = h.to_string();
        } else if let Some(u) = line.strip_prefix("# branch.upstream ") {
            p.upstream = Some(u.to_string());
        } else if line.starts_with("# branch.ab ") {
            if let Some(m) = AB.captures(line) {
                p.ahead = js_int(&m[1]);
                p.behind = js_int(&m[2]);
            }
        } else if line.starts_with("1 ") {
            let f = split_n(line, 9);
            p.files.push(file(
                f.get(8).copied().unwrap_or(""),
                None,
                xy(&f),
                false,
                false,
            ));
        } else if line.starts_with("2 ") {
            let f = split_n(line, 10);
            let last = f.get(9).copied().unwrap_or("");
            let mut parts = last.split('\t');
            let path = parts.next().unwrap_or("");
            let orig = parts.next().map(unquote_path);
            p.files.push(file(path, orig, xy(&f), false, false));
        } else if line.starts_with("u ") {
            let f = split_n(line, 11);
            p.files.push(file(
                f.get(10).copied().unwrap_or(""),
                None,
                xy(&f),
                false,
                true,
            ));
        } else if let Some(path) = line.strip_prefix("? ") {
            p.files
                .push(file(path, None, (".".into(), ".".into()), true, false));
        }
    }
    p
}

/// Parse `git config --get-regexp '^user\.(name|email)$'`: global before
/// local, and the last one wins, as it does for a commit.
pub fn parse_user_config(text: &str) -> Option<GitUser> {
    let (mut name, mut email) = (String::new(), String::new());
    for line in text.split('\n') {
        let kv = split_n(line, 2);
        let value = kv.get(1).copied().unwrap_or("");
        match kv[0] {
            "user.name" => name = js_trim(value).to_string(),
            "user.email" => email = js_trim(value).to_string(),
            _ => {}
        }
    }
    if name.is_empty() && email.is_empty() {
        None
    } else {
        Some(GitUser { name, email })
    }
}

/// The remote-tracking refs the checkout does not contain, newest first,
/// under every remote or just the ones named. The count leaves room for
/// each remote's HEAD symref, which the parser skips.
pub fn tip_args(remotes: Option<&[String]>) -> Vec<String> {
    let mut a: Vec<String> = [
        "for-each-ref",
        "--sort=-committerdate",
        "--no-merged=HEAD",
        "--count=8",
        "--format=%(refname:short)%00%(objectname:short)%00%(committerdate:unix)%00%(subject)%00%(symref)",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    match remotes {
        Some(rs) => a.extend(rs.iter().map(|r| format!("refs/remotes/{r}"))),
        None => a.push("refs/remotes".into()),
    }
    a
}

/// The first real branch out of `tip_args` output: `origin/HEAD` is a
/// symref to the default branch and says nothing of its own.
pub fn parse_remote_tip(text: &str) -> Option<RemoteTip> {
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\0').collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("");
        if !get(4).is_empty() || get(0).is_empty() || get(1).is_empty() {
            continue;
        }
        return Some(RemoteTip {
            reference: get(0).into(),
            hash: get(1).into(),
            subject: get(3).into(),
            at: js_int(get(2)),
        });
    }
    None
}

/// One entry of `git worktree list --porcelain`; the first is the main one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: String,
    /// None when detached
    pub branch: Option<String>,
    pub bare: bool,
    /// git's own word that the folder is gone
    pub prunable: bool,
}

pub fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    let mut out: Vec<WorktreeEntry> = Vec::new();
    for line in text.split('\n') {
        if let Some(p) = line.strip_prefix("worktree ") {
            out.push(WorktreeEntry {
                path: p.to_string(),
                branch: None,
                bare: false,
                prunable: false,
            });
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        if let Some(b) = line.strip_prefix("branch ") {
            cur.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "bare" {
            cur.bare = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            cur.prunable = true;
        }
    }
    out
}

/// The local branches HEAD lacks commits from, newest first. With `counts`
/// each line also says how far it is ahead of HEAD, which only git 2.41
/// and later can (`%(ahead-behind:)`); an older git fails the whole read.
pub fn branch_wip_args(counts: bool) -> Vec<String> {
    vec![
        "for-each-ref".into(),
        "--sort=-committerdate".into(),
        "--no-merged=HEAD".into(),
        format!(
            "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)%00%(worktreepath){}",
            if counts {
                "%00%(ahead-behind:HEAD)"
            } else {
                ""
            }
        ),
        "refs/heads".into(),
    ]
}

/// A branch line of `branch_wip_args` output, with where it is checked out.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchLine {
    pub wip: BranchWip,
    /// the worktree it is checked out in, "" when none
    pub worktree: String,
}

static AHEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ahead (\d+)").unwrap());

fn parse_push(upstream: &str, track: &str) -> BranchPush {
    if upstream.is_empty() {
        return BranchPush::Local;
    }
    if track == "gone" {
        return BranchPush::Gone {
            reference: upstream.into(),
        };
    }
    let unpushed = AHEAD.captures(track).map_or(0, |m| js_int(&m[1]));
    BranchPush::Upstream {
        reference: upstream.into(),
        unpushed,
    }
}

pub fn parse_branch_wip(text: &str) -> Vec<BranchLine> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\0').collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("");
        if get(0).is_empty() {
            continue;
        }
        // `Number(ab.split(" ")[0])`, kept only when finite
        let unmerged = f.get(6).and_then(|ab| {
            let first = ab.split(' ').next().unwrap_or("");
            let t = js_trim(first);
            if t.is_empty() {
                Some(0)
            } else {
                t.parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .map(|n| n as i64)
            }
        });
        out.push(BranchLine {
            wip: BranchWip {
                name: get(0).into(),
                push: parse_push(get(1), get(2)),
                at: js_int(get(3)),
                subject: get(4).into(),
                unmerged,
            },
            worktree: get(5).into(),
        });
    }
    out
}

/// `git stash list --format=%ct%x00%gs`, newest first
pub fn parse_stash(text: &str) -> Option<StashWip> {
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    let first = lines.first()?;
    let mut f = first.split('\0');
    let ct = f.next().unwrap_or("");
    let subject = f.next().unwrap_or("");
    Some(StashWip {
        count: lines.len() as i64,
        subject: subject.into(),
        at: js_int(ct),
    })
}

/// Entries in `git status --porcelain=v2` output without `--branch`.
pub fn count_status_entries(text: &str) -> usize {
    text.split('\n')
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .count()
}

/// At most this many linked worktrees get their tree read per status.
const WORKTREE_CAP: usize = 12;

fn realpath_or(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
}

/// What the repo holds outside this checkout: dirty or unmerged linked
/// worktrees, unmerged branches checked out nowhere, the stash. Read only
/// from a main checkout, since every linked worktree shares the same refs.
/// Never fails; a read that fails leaves its part out.
pub async fn read_elsewhere(repo_path: &str) -> Option<Elsewhere> {
    read_elsewhere_in(repo_path, &crate::store::config_dir()).await
}

/// `read_elsewhere` with canopy's config dir given, whose `builds/` and
/// `worktrees/` hold canopy's own worktrees, which the card leaves out.
pub async fn read_elsewhere_in(repo_path: &str, config_dir: &str) -> Option<Elsewhere> {
    let loc = parse_locator(repo_path);
    let host = loc.host.as_deref();
    let seeds = if host.is_none() {
        seed_roots_now()
    } else {
        vec![]
    };
    // a seed's worktree list is agent-written and may point anywhere
    if seeds_root_of(&loc.path, &seeds).is_some() {
        return None;
    }
    let wip_args = branch_wip_args(true);
    let (dirs, list, refs, stashes) = tokio::join!(
        git(
            repo_path,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-dir",
                "--git-common-dir"
            ]
        ),
        git(repo_path, &["worktree", "list", "--porcelain"]),
        git(repo_path, &wip_args),
        git(repo_path, &["stash", "list", "--format=%ct%x00%gs"]),
    );
    let dir_out = js_trim(&dirs.stdout).to_string();
    let mut d = dir_out.split('\n');
    let git_dir = d.next().unwrap_or("");
    let common_dir = d.next();
    if dirs.code != 0 || git_dir.is_empty() || Some(git_dir) != common_dir {
        return None;
    }
    // fails on an unborn HEAD too, which has nothing unmerged anyway
    let branch_text = if refs.code == 0 {
        refs.stdout
    } else {
        let r = git(repo_path, &branch_wip_args(false)).await;
        if r.code == 0 { r.stdout } else { String::new() }
    };
    let lines = parse_branch_wip(&branch_text);
    let unmerged_of: HashMap<&str, i64> = lines
        .iter()
        .map(|b| (b.wip.name.as_str(), b.wip.unmerged.unwrap_or(0)))
        .collect();
    // git prints real paths, so a config dir reached through a symlink is
    // matched in both spellings
    let builds: Vec<String> = if host.is_none() {
        ["builds", "worktrees"]
            .iter()
            .flat_map(|sub| {
                let at = join(config_dir, sub);
                let real = realpath_or(&at);
                [format!("{at}/"), format!("{real}/")]
            })
            .collect()
    } else {
        vec![]
    };
    let linked: Vec<WorktreeEntry> = if list.code == 0 {
        parse_worktree_list(&list.stdout)
    } else {
        vec![]
    }
    .into_iter()
    .skip(1)
    .filter(|w| !w.bare && !w.prunable)
    .filter(|w| {
        !builds.iter().any(|b| w.path.starts_with(b)) && seeds_root_of(&w.path, &seeds).is_none()
    })
    .take(WORKTREE_CAP)
    .collect();
    let read: HashSet<String> = linked.iter().map(|w| w.path.clone()).collect();
    let counted = futures_join_all(linked.iter().map(|w| {
        let at_path = to_locator(host, &w.path);
        let unmerged = w
            .branch
            .as_ref()
            .map_or(0, |b| unmerged_of.get(b.as_str()).copied().unwrap_or(0));
        let w = w.clone();
        async move {
            let (r, log) = tokio::join!(
                git(
                    &at_path,
                    &[
                        "-c",
                        "core.quotePath=false",
                        "status",
                        "--porcelain=v2",
                        "-uall"
                    ]
                ),
                git(&at_path, &["log", "-1", "--format=%ct"]),
            );
            let files = if r.code == 0 {
                parse_porcelain_v2(&r.stdout).files
            } else {
                vec![]
            };
            let times = file_mtimes(
                &at_path,
                &files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
            )
            .await;
            let base = if log.code == 0 {
                js_int(&log.stdout)
            } else {
                0
            };
            let at = times
                .iter()
                .fold(base, |latest, t| latest.max(t.unwrap_or(0)));
            WorktreeWip {
                path: w.path,
                branch: w.branch,
                files: files.len() as i64,
                unmerged,
                at: if at > 0 { Some(at) } else { None },
            }
        }
    }))
    .await;
    let worktrees: Vec<WorktreeWip> = counted
        .into_iter()
        .filter(|w| w.files > 0 || w.unmerged > 0)
        .collect();
    // a branch is told under its worktree only when that worktree was read
    let branches: Vec<BranchWip> = lines
        .into_iter()
        .filter(|b| !read.contains(&b.worktree))
        // a live run worktree's branch is the landing section's to show
        .filter(|b| {
            !(!b.worktree.is_empty()
                && builds.iter().any(|at| b.worktree.starts_with(at))
                && std::path::Path::new(&b.worktree).exists())
        })
        .take(BRANCH_WIP_CAP)
        .map(|b| b.wip)
        .collect();
    let stash = if stashes.code == 0 {
        parse_stash(&stashes.stdout)
    } else {
        None
    };
    if worktrees.is_empty() && branches.is_empty() && stash.is_none() {
        return None;
    }
    Some(Elsewhere {
        worktrees,
        branches,
        stash,
    })
}

/// Await every future, keeping their order (`Promise.all`).
pub(crate) async fn futures_join_all<F: std::future::Future>(
    futs: impl IntoIterator<Item = F>,
) -> Vec<F::Output> {
    let mut out = Vec::new();
    let handles: Vec<_> = futs.into_iter().collect();
    // a local join keeps borrows simple; the futures run concurrently
    let mut pinned: Vec<std::pin::Pin<Box<F>>> = handles.into_iter().map(Box::pin).collect();
    let mut done: Vec<Option<F::Output>> = (0..pinned.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (i, f) in pinned.iter_mut().enumerate() {
            if done[i].is_some() {
                continue;
            }
            match f.as_mut().poll(cx) {
                std::task::Poll::Ready(v) => done[i] = Some(v),
                std::task::Poll::Pending => pending = true,
            }
        }
        if pending {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(())
        }
    })
    .await;
    out.extend(done.into_iter().map(|v| v.expect("every future finished")));
    out
}

/// One line per path given, in order: the file's mtime in unix seconds, or
/// an empty line when it is gone. GNU stat first, BSD stat when that fails.
pub const MTIME_SCRIPT: &str = r#"cd "$0" && for f; do stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f" 2>/dev/null || echo; done"#;

static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+$").unwrap());

/// The script's output back into one entry per path asked about.
pub fn parse_mtimes(text: &str, n: usize) -> Vec<Option<i64>> {
    let lines: Vec<&str> = text.split('\n').collect();
    (0..n)
        .map(|i| {
            let v = lines.get(i).map_or("", |l| js_trim(l));
            if DIGITS.is_match(v) {
                Some(js_int(v))
            } else {
                None
            }
        })
        .collect()
}

/// More changed files than this get no time: a repo with an unignored
/// node_modules would otherwise stat tens of thousands of files per event.
const MTIME_CAP: usize = 2000;

async fn file_mtimes(repo_path: &str, paths: &[String]) -> Vec<Option<i64>> {
    use std::os::unix::fs::MetadataExt;
    let loc = parse_locator(repo_path);
    let want = &paths[..paths.len().min(MTIME_CAP)];
    let times: Vec<Option<i64>> = match &loc.host {
        // up to MTIME_CAP stats block, so they run off the async workers
        None => {
            let (dir, want) = (loc.path.clone(), want.to_vec());
            tokio::task::spawn_blocking(move || {
                want.iter()
                    .map(|p| std::fs::metadata(join(&dir, p)).ok().map(|m| m.mtime()))
                    .collect()
            })
            .await
            .unwrap_or_default()
        }
        Some(h) => {
            let mut cmd: Vec<String> = vec![
                "sh".into(),
                "-c".into(),
                MTIME_SCRIPT.into(),
                loc.path.clone(),
            ];
            cmd.extend(want.iter().cloned());
            let r = on_host(Some(h), &cmd, &ExecOptions::default()).await;
            if r.code == 0 {
                parse_mtimes(&r.stdout, want.len())
            } else {
                vec![]
            }
        }
    };
    (0..paths.len())
        .map(|i| times.get(i).copied().flatten())
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct StatusOptions {
    /// the remotes whose branches can be the tip: every remote when None,
    /// none when empty (the caller has not decided which are the user's)
    pub tip_remotes: Option<Vec<String>>,
}

fn none_ok() -> ExecResult {
    ExecResult {
        code: 1,
        ..Default::default()
    }
}

pub async fn get_status(repo_path: &str, opts: &StatusOptions) -> Result<RepoStatus, String> {
    let tips = async {
        match &opts.tip_remotes {
            Some(r) if r.is_empty() => none_ok(),
            other => git(repo_path, &tip_args(other.as_deref())).await,
        }
    };
    let (st, log, cfg, tips, elsewhere, numstat) = tokio::join!(
        // -uall lists untracked files one by one; without it a new folder
        // arrives as one "dir/" entry no per-file diff can render
        git(
            repo_path,
            &[
                "-c",
                "core.quotePath=false",
                "status",
                "--porcelain=v2",
                "--branch",
                "-uall"
            ]
        ),
        git(repo_path, &["log", "-1", "--pretty=%h%x00%s%x00%ct"]),
        // exits 1 when nothing matches, which just means no identity
        git(
            repo_path,
            &["config", "--get-regexp", r"^user\.(name|email)$"]
        ),
        tips,
        read_elsewhere(repo_path),
        // the plumbing diff-index against HEAD, since porcelain diff
        // refreshes the index and writes it back
        git(
            repo_path,
            &[
                "diff-index",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--"
            ]
        ),
    );
    if st.code != 0 {
        let msg = js_trim(&st.stderr);
        return Err(if msg.is_empty() {
            "git status failed".into()
        } else {
            msg.to_string()
        });
    }
    let mut p = parse_porcelain_v2(&st.stdout);
    let lines = if numstat.code == 0 && p.files.iter().any(|f| !f.untracked) {
        Some(sum_numstat(&parse_numstat_z(&numstat.stdout)))
    } else {
        None
    };
    if !p.files.is_empty() {
        let times = file_mtimes(
            repo_path,
            &p.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        )
        .await;
        for (f, t) in p.files.iter_mut().zip(times) {
            f.mtime = t;
        }
    }
    let last_commit = {
        let t = js_trim(&log.stdout);
        if log.code == 0 && !t.is_empty() {
            let mut f = t.split('\0');
            let hash = f.next().unwrap_or("").to_string();
            let subject = f.next().unwrap_or("").to_string();
            let at = js_int(f.next().unwrap_or("0"));
            Some(LastCommit { hash, subject, at })
        } else {
            None
        }
    };
    let user = if cfg.code == 0 {
        parse_user_config(&cfg.stdout)
    } else {
        None
    };
    let tip = if tips.code == 0 {
        parse_remote_tip(&tips.stdout)
    } else {
        None
    };
    Ok(RepoStatus {
        branch: p.branch,
        upstream: p.upstream,
        ahead: p.ahead,
        behind: p.behind,
        files: p.files,
        last_commit,
        user,
        tip,
        elsewhere,
        lines,
    })
}

/// How many of a branch's commits the changes section's drill lists.
const DRILL_LOG: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElsewhereDetail {
    pub commits: Vec<LogEntry>,
    /// commits past the ones listed
    pub more: i64,
    pub files: Vec<RepoFile>,
}

/// What the drill shows for a worktree or branch the status's Elsewhere
/// named. The server passes only a name or path it found there, never one a
/// page sent, so neither reaches git as anything but a branch under refs/heads.
pub async fn elsewhere_detail(
    repo_path: &str,
    branch: Option<&str>,
    worktree: Option<&str>,
) -> ElsewhereDetail {
    let host = parse_locator(repo_path).host;
    let range = branch.map(|b| format!("HEAD..refs/heads/{b}"));
    let log = async {
        match &range {
            Some(r) => Some(
                git(
                    repo_path,
                    &[
                        "log",
                        &format!("-{DRILL_LOG}"),
                        "--pretty=%h%x00%s%x00%an%x00%ar%x00%H",
                        r,
                        "--",
                    ],
                )
                .await,
            ),
            None => None,
        }
    };
    let count = async {
        match &range {
            Some(r) => Some(git(repo_path, &["rev-list", "--count", r, "--"]).await),
            None => None,
        }
    };
    let tree = async {
        match worktree {
            Some(w) => Some(
                git(
                    &to_locator(host.as_deref(), w),
                    &[
                        "-c",
                        "core.quotePath=false",
                        "status",
                        "--porcelain=v2",
                        "-unormal",
                    ],
                )
                .await,
            ),
            None => None,
        }
    };
    let (log, count, tree) = tokio::join!(log, count, tree);
    let commits = match &log {
        Some(l) if l.code == 0 => parse_log(&l.stdout, &HashSet::new()),
        _ => vec![],
    };
    let total = match &count {
        Some(c) if c.code == 0 => js_int(&c.stdout),
        _ => commits.len() as i64,
    };
    let files = match &tree {
        Some(t) if t.code == 0 => parse_porcelain_v2(&t.stdout).files,
        _ => vec![],
    };
    ElsewhereDetail {
        more: (total - commits.len() as i64).max(0),
        commits,
        files,
    }
}

/// Every remote-tracking ref with its hash, one string; the same before and
/// after a fetch means the fetch brought nothing.
pub async fn remote_refs(repo_path: &str) -> String {
    let r = git(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            "refs/remotes",
        ],
    )
    .await;
    if r.code == 0 { r.stdout } else { String::new() }
}

/// A fetch may sit on a dead host or a credential lookup; a minute is long
/// enough for a real one and short enough that four stuck ones do not stall
/// a whole refresh.
const FETCH_TIMEOUT: u64 = 60_000;

/// Fetch every remote, or just the ones named, pruning branches gone from
/// them. Never prompts. The answer is whether any remote-tracking ref moved,
/// and the error when the fetch failed.
pub async fn fetch_repo(repo_path: &str, remotes: Option<&[String]>) -> (bool, Option<String>) {
    if remotes.is_some_and(|r| r.is_empty()) {
        return (false, None);
    }
    let before = remote_refs(repo_path).await;
    let mut args: Vec<String> = vec!["fetch".into()];
    match remotes {
        Some(rs) => {
            args.push("--multiple".into());
            args.extend(rs.iter().cloned());
        }
        None => args.push("--all".into()),
    }
    args.extend(["--prune".to_string(), "--quiet".to_string()]);
    let r = git_with(
        repo_path,
        &args,
        GitTimeout::from(FETCH_TIMEOUT),
        &[("GIT_TERMINAL_PROMPT", "0")],
    )
    .await;
    let changed = before != remote_refs(repo_path).await;
    if r.code == 0 {
        return (changed, None);
    }
    let msg = js_trim(&r.stderr);
    (
        changed,
        Some(if msg.is_empty() {
            format!("git fetch exited {}", r.code)
        } else {
            msg.to_string()
        }),
    )
}

pub async fn get_log(repo_path: &str, n: usize) -> Vec<LogEntry> {
    let count = format!("-{n}");
    let args = [
        "log",
        count.as_str(),
        "--pretty=%h%x00%s%x00%an%x00%ar%x00%H",
    ];
    let (r, out) = tokio::join!(git(repo_path, &args), unpushed_hashes(repo_path, n),);
    if r.code != 0 {
        return vec![];
    }
    parse_log(&r.stdout, &out)
}

fn hash_set(text: &str) -> HashSet<String> {
    text.split('\n')
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// The full hashes of the newest `n` commits a push would send: past the
/// upstream, or, with no upstream, on no remote-tracking branch. A repo with
/// no remote at all has nowhere to push, so nothing is unpushed.
async fn unpushed_hashes(repo_path: &str, n: usize) -> HashSet<String> {
    let up = git(
        repo_path,
        &["rev-list", &format!("--max-count={n}"), "@{upstream}..HEAD"],
    )
    .await;
    if up.code == 0 {
        return hash_set(&up.stdout);
    }
    let remotes = git(repo_path, &["remote"]).await;
    if remotes.code != 0 || js_trim(&remotes.stdout).is_empty() {
        return HashSet::new();
    }
    let all = git(
        repo_path,
        &[
            "rev-list",
            &format!("--max-count={n}"),
            "HEAD",
            "--not",
            "--remotes",
        ],
    )
    .await;
    if all.code == 0 {
        hash_set(&all.stdout)
    } else {
        HashSet::new()
    }
}

/// `git log --pretty=%h%x00%s%x00%an%x00%ar%x00%H` lines, each flagged when
/// its full hash is among `unpushed`.
pub fn parse_log(stdout: &str, unpushed: &HashSet<String>) -> Vec<LogEntry> {
    stdout
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            let get = |i: usize| f.get(i).copied().unwrap_or("").to_string();
            LogEntry {
                hash: get(0),
                subject: get(1),
                author: get(2),
                when: get(3),
                unpushed: unpushed.contains(&get(4)),
            }
        })
        .collect()
}

static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{4,40}$").unwrap());

/// A hash as the UI sends it back: abbreviated or full, nothing else.
pub fn is_hash(s: &str) -> bool {
    HASH.is_match(s)
}

/// Split the fields of git's `-z` output, dropping the empty tail.
fn z_fields(text: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = text.split('\0').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    parts
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Numstat {
    pub path: String,
    pub orig: Option<String>,
    pub added: Option<i64>,
    pub deleted: Option<i64>,
}

/// Parse `--numstat -z`: `added\tdeleted\tpath`, `-` for both on a binary
/// file; a rename has an empty path and carries both paths as the next two
/// fields.
pub fn parse_numstat_z(text: &str) -> Vec<Numstat> {
    let fields = z_fields(text);
    let count = |s: &str| if s == "-" { None } else { Some(js_int(s)) };
    let mut out = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let parts: Vec<&str> = fields[i].split('\t').collect();
        let get = |k: usize| parts.get(k).copied().unwrap_or("");
        if !get(2).is_empty() {
            out.push(Numstat {
                path: get(2).into(),
                orig: None,
                added: count(get(0)),
                deleted: count(get(1)),
            });
        } else {
            let orig = fields.get(i + 1).copied().unwrap_or("").to_string();
            let dest = fields.get(i + 2).copied().unwrap_or("").to_string();
            i += 2;
            out.push(Numstat {
                path: dest,
                orig: Some(orig),
                added: count(get(0)),
                deleted: count(get(1)),
            });
        }
        i += 1;
    }
    out
}

/// The lines a numstat adds and removes in all; a binary file counts as none.
pub fn sum_numstat(rows: &[Numstat]) -> Lines {
    Lines {
        added: rows.iter().map(|r| r.added.unwrap_or(0)).sum(),
        deleted: rows.iter().map(|r| r.deleted.unwrap_or(0)).sum(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameStatus {
    pub status: String,
    pub path: String,
    pub orig: Option<String>,
}

/// Parse `--name-status -z`: a status letter, then the path; a rename or
/// copy carries a similarity score (`R075`) and two paths.
pub fn parse_name_status_z(text: &str) -> Vec<NameStatus> {
    let fields = z_fields(text);
    let mut out = Vec::new();
    let mut i = 0;
    let at = |k: usize| fields.get(k).copied().unwrap_or("").to_string();
    while i < fields.len() {
        let status = fields[i]
            .chars()
            .next()
            .map_or("X".to_string(), |c| c.to_string());
        if status == "R" || status == "C" {
            out.push(NameStatus {
                status,
                orig: Some(at(i + 1)),
                path: at(i + 2),
            });
            i += 3;
        } else {
            out.push(NameStatus {
                status,
                path: at(i + 1),
                orig: None,
            });
            i += 2;
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig: Option<String>,
    /// git's status letter: M A D R C T U, or X for anything it cannot name
    pub status: String,
    /// None for a binary file, where lines mean nothing
    pub added: Option<i64>,
    pub deleted: Option<i64>,
}

/// Join the two listings on path; a path only numstat knows keeps status X.
pub fn commit_files(numstat: &[Numstat], names: &[NameStatus]) -> Vec<CommitFile> {
    let status: HashMap<&str, &NameStatus> = names.iter().map(|n| (n.path.as_str(), n)).collect();
    numstat
        .iter()
        .map(|n| {
            let s = status.get(n.path.as_str());
            CommitFile {
                path: n.path.clone(),
                orig: n.orig.clone().or_else(|| s.and_then(|s| s.orig.clone())),
                status: s.map_or("X".to_string(), |s| s.status.clone()),
                added: n.added,
                deleted: n.deleted,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::exec;

    const SAMPLE: &str = "# branch.oid 1234abcd\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 aaaa bbbb src/app with spaces.ts\n1 A. N... 000000 100644 100644 0000 cccc new.ts\n2 R. N... 100644 100644 100644 dddd eeee R100 renamed.ts\told name.ts\nu UU N... 100644 100644 100644 100644 ffff gggg hhhh conflict.ts\n? untracked file.md";

    #[test]
    fn remote_tips() {
        let line = |r: &str, symref: &str| {
            [r, "0e1d6fd", "1790000000", "tailcat: the pieces", symref].join("\0")
        };
        assert_eq!(
            parse_remote_tip(&format!(
                "{}\n{}\n",
                line("origin/claude/tailcat", ""),
                line("forgejo/main", "")
            )),
            Some(RemoteTip {
                reference: "origin/claude/tailcat".into(),
                hash: "0e1d6fd".into(),
                subject: "tailcat: the pieces".into(),
                at: 1790000000
            })
        );
        assert_eq!(
            parse_remote_tip(&format!(
                "{}\n{}",
                line("origin/HEAD", "refs/remotes/origin/main"),
                line("origin/main", "")
            ))
            .unwrap()
            .reference,
            "origin/main"
        );
        assert_eq!(parse_remote_tip(""), None);
        assert_eq!(
            parse_remote_tip(&line("origin/HEAD", "refs/remotes/origin/main")),
            None
        );
    }

    #[test]
    fn user_config() {
        let u = |n: &str, e: &str| {
            Some(GitUser {
                name: n.into(),
                email: e.into(),
            })
        };
        assert_eq!(
            parse_user_config("user.name Eric Baruch\nuser.email eric@example.com\n"),
            u("Eric Baruch", "eric@example.com")
        );
        assert_eq!(
            parse_user_config(
                "user.name Eric Baruch\nuser.email eric@example.com\nuser.email eric@work.example"
            ),
            u("Eric Baruch", "eric@work.example")
        );
        assert_eq!(
            parse_user_config("user.email eric@example.com"),
            u("", "eric@example.com")
        );
        assert_eq!(parse_user_config(""), None);
        assert_eq!(parse_user_config("user.signingkey ABC"), None);
    }

    #[test]
    fn porcelain_v2() {
        let st = parse_porcelain_v2(SAMPLE);
        assert_eq!(
            (
                st.branch.as_str(),
                st.upstream.as_deref(),
                st.ahead,
                st.behind
            ),
            ("main", Some("origin/main"), 2, 1)
        );
        assert_eq!(
            st.files[0],
            RepoFile {
                path: "src/app with spaces.ts".into(),
                orig: None,
                index: ".".into(),
                worktree: "M".into(),
                untracked: false,
                conflicted: false,
                mtime: None
            }
        );
        assert_eq!(st.files[1].index, "A");
        assert_eq!(
            (st.files[2].path.as_str(), st.files[2].orig.as_deref()),
            ("renamed.ts", Some("old name.ts"))
        );
        assert!(st.files[3].conflicted);
        assert_eq!(
            (st.files[4].path.as_str(), st.files[4].untracked),
            ("untracked file.md", true)
        );
        // the JSON leaves `orig` out, as JSON.stringify drops undefined
        assert!(
            !serde_json::to_string(&st.files[0])
                .unwrap()
                .contains("orig")
        );
    }

    #[test]
    fn c_quoted_paths_decode() {
        let q = parse_porcelain_v2(
            "? \"caf\\303\\251.txt\"\n? \"quo\\\"te.txt\"\n? \"back\\\\slash.txt\"\n2 R. N... 100644 100644 100644 dddd eeee R100 \"n\\303\\251w.ts\"\t\"\\303\\266ld.ts\"",
        );
        assert_eq!(
            q.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["café.txt", "quo\"te.txt", "back\\slash.txt", "néw.ts"]
        );
        assert_eq!(q.files[3].orig.as_deref(), Some("öld.ts"));
    }

    #[test]
    fn detached_head_and_no_upstream() {
        let d = parse_porcelain_v2("# branch.oid 999\n# branch.head (detached)\n");
        assert_eq!(
            (d.branch.as_str(), d.upstream, d.ahead, d.files.len()),
            ("(detached)", None, 0, 0)
        );
    }

    #[test]
    fn path_containment() {
        for bad in ["/etc/passwd", "../outside.txt", "a/../../outside", ""] {
            assert!(repo_relative("/tmp", bad).is_err(), "{bad}");
        }
        assert_eq!(repo_relative("/tmp/r", "a/b").unwrap(), "/tmp/r/a/b");
        assert_eq!(repo_relative("ssh://h/tmp/r", "a").unwrap(), "/tmp/r/a");
    }

    #[test]
    fn hashes() {
        assert!(is_hash("cb914ee"));
        assert!(is_hash("5a4a6c6fe2cc739eae26d55effca9d0581fdf5f6"));
        for bad in ["", "abc", "HEAD", "main", "--output=x", "cb914ee\n"] {
            assert!(!is_hash(bad), "{bad:?}");
        }
    }

    const NUMSTAT: &str = "1\t0\t\0old.txt\0new name.txt\0-\t-\tpic.bin\0";
    const NAMES: &str = "R075\0old.txt\0new name.txt\0M\0pic.bin\0";

    #[test]
    fn commit_listings() {
        assert_eq!(
            parse_numstat_z(NUMSTAT),
            vec![
                Numstat {
                    path: "new name.txt".into(),
                    orig: Some("old.txt".into()),
                    added: Some(1),
                    deleted: Some(0)
                },
                Numstat {
                    path: "pic.bin".into(),
                    orig: None,
                    added: None,
                    deleted: None
                },
            ]
        );
        assert_eq!(
            parse_name_status_z(NAMES),
            vec![
                NameStatus {
                    status: "R".into(),
                    path: "new name.txt".into(),
                    orig: Some("old.txt".into())
                },
                NameStatus {
                    status: "M".into(),
                    path: "pic.bin".into(),
                    orig: None
                },
            ]
        );
        assert_eq!(
            commit_files(&parse_numstat_z(NUMSTAT), &parse_name_status_z(NAMES)),
            vec![
                CommitFile {
                    path: "new name.txt".into(),
                    orig: Some("old.txt".into()),
                    status: "R".into(),
                    added: Some(1),
                    deleted: Some(0)
                },
                CommitFile {
                    path: "pic.bin".into(),
                    orig: None,
                    status: "M".into(),
                    added: None,
                    deleted: None
                },
            ]
        );
        assert!(parse_numstat_z("").is_empty());
        assert!(parse_name_status_z("").is_empty());
        assert_eq!(
            commit_files(&parse_numstat_z("2\t2\ta.ts\0"), &[]),
            vec![CommitFile {
                path: "a.ts".into(),
                orig: None,
                status: "X".into(),
                added: Some(2),
                deleted: Some(2)
            }]
        );
    }

    #[test]
    fn mtimes_parse() {
        assert_eq!(
            parse_mtimes("1700000000\n\n1700000001\n", 3),
            vec![Some(1700000000), None, Some(1700000001)]
        );
        assert_eq!(parse_mtimes("stat: illegal option\n", 2), vec![None, None]);
        assert!(parse_mtimes("", 0).is_empty());
    }

    #[test]
    fn line_sums() {
        assert_eq!(
            sum_numstat(&parse_numstat_z(concat!(
                "3\t1\ta.ts\0-\t-\tlogo.png\0",
                "2\t0\t\0old.ts\0new.ts\0"
            ))),
            Lines {
                added: 5,
                deleted: 1
            }
        );
        assert_eq!(
            sum_numstat(&[]),
            Lines {
                added: 0,
                deleted: 0
            }
        );
    }

    #[test]
    fn worktree_lists() {
        let text = "worktree /r\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/a\nHEAD bbbb\nbranch refs/heads/feat/x\nlocked\n\nworktree /tmp/gone\nHEAD cccc\ndetached\nprunable gitdir file points to non-existent location\n";
        let e = |p: &str, b: Option<&str>, prunable: bool| WorktreeEntry {
            path: p.into(),
            branch: b.map(String::from),
            bare: false,
            prunable,
        };
        assert_eq!(
            parse_worktree_list(text),
            vec![
                e("/r", Some("main"), false),
                e("/r/.claude/worktrees/a", Some("feat/x"), false),
                e("/tmp/gone", None, true)
            ]
        );
    }

    #[test]
    fn branch_wip_lines() {
        let line = |f: &[&str]| f.join("\0");
        let text = [
            line(&["local", "", "", "200", "only here", "", "3 0"]),
            line(&["pushed", "origin/pushed", "", "150", "even", "", "1 4"]),
            line(&[
                "ahead",
                "origin/ahead",
                "ahead 2, behind 1",
                "120",
                "two more",
                "/r/wt",
                "5 1",
            ]),
            line(&[
                "gone",
                "origin/gone",
                "gone",
                "100",
                "deleted there",
                "",
                "1 0",
            ]),
        ]
        .join("\n");
        let got = parse_branch_wip(&text);
        let bw = |name: &str, push: BranchPush, at: i64, subject: &str, unmerged: Option<i64>| {
            BranchWip {
                name: name.into(),
                push,
                at,
                subject: subject.into(),
                unmerged,
            }
        };
        assert_eq!(
            got[0],
            BranchLine {
                wip: bw("local", BranchPush::Local, 200, "only here", Some(3)),
                worktree: "".into()
            }
        );
        assert_eq!(
            got[1].wip.push,
            BranchPush::Upstream {
                reference: "origin/pushed".into(),
                unpushed: 0
            }
        );
        assert_eq!(
            got[2],
            BranchLine {
                wip: bw(
                    "ahead",
                    BranchPush::Upstream {
                        reference: "origin/ahead".into(),
                        unpushed: 2
                    },
                    120,
                    "two more",
                    Some(5)
                ),
                worktree: "/r/wt".into()
            }
        );
        assert_eq!(
            got[3].wip.push,
            BranchPush::Gone {
                reference: "origin/gone".into()
            }
        );
        assert_eq!(
            parse_branch_wip(&format!("{}\n", line(&["b", "", "", "1", "s", ""]))),
            vec![BranchLine {
                wip: bw("b", BranchPush::Local, 1, "s", None),
                worktree: "".into()
            }]
        );
    }

    #[test]
    fn stashes() {
        assert_eq!(
            parse_stash("300\0WIP on main: abc one\n200\0On main: two\n"),
            Some(StashWip {
                count: 2,
                subject: "WIP on main: abc one".into(),
                at: 300
            })
        );
        assert_eq!(parse_stash(""), None);
    }

    #[test]
    fn log_lines() {
        let line =
            |h: &str, full: &str| [h, "subject: with, words", "t", "2 hours ago", full].join("\0");
        let a = "a".repeat(40);
        let unpushed: HashSet<String> = [a.clone()].into();
        let got = parse_log(
            &format!(
                "{}\n{}\n",
                line("aaaaaaa", &a),
                line("bbbbbbb", &"b".repeat(40))
            ),
            &unpushed,
        );
        assert!(got[0].unpushed && !got[1].unpushed);
        assert_eq!(
            serde_json::to_value(&got[1]).unwrap(),
            serde_json::json!({"hash":"bbbbbbb","subject":"subject: with, words","author":"t","when":"2 hours ago"})
        );
        assert!(parse_log("", &HashSet::new()).is_empty());
    }

    // ---- against real repos ----

    async fn run(dir: &str, args: &[&str]) -> ExecResult {
        let mut argv = vec![
            "git",
            "-C",
            dir,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
        ];
        argv.extend_from_slice(args);
        exec(&argv, &ExecOptions::default()).await
    }

    fn tmp() -> (tempfile::TempDir, String) {
        let t = tempfile::tempdir().unwrap();
        let p = std::fs::canonicalize(t.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (t, p)
    }

    fn touch_at(path: &str, secs: i64) {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    fn no_tips() -> StatusOptions {
        StatusOptions {
            tip_remotes: Some(vec![]),
        }
    }

    #[tokio::test]
    async fn a_status_counts_tracked_changes_against_head() {
        let (_t, dir) = tmp();
        run(&dir, &["init", "-q"]).await;
        std::fs::write(format!("{dir}/f.txt"), "one\ntwo\n").unwrap();
        run(&dir, &["add", "f.txt"]).await;
        run(&dir, &["commit", "-q", "-m", "one"]).await;
        assert_eq!(get_status(&dir, &no_tips()).await.unwrap().lines, None);
        std::fs::write(format!("{dir}/f.txt"), "one\nthree\nfour\n").unwrap();
        run(&dir, &["add", "f.txt"]).await;
        std::fs::write(format!("{dir}/f.txt"), "one\nthree\nfour\nfive\n").unwrap();
        std::fs::write(format!("{dir}/new.txt"), "a\nb\n").unwrap();
        let st = get_status(&dir, &no_tips()).await.unwrap();
        assert_eq!(st.files.len(), 2);
        assert_eq!(
            st.lines,
            Some(Lines {
                added: 3,
                deleted: 1
            })
        );
        assert!(st.files.iter().all(|f| f.mtime.is_some()));
        assert_eq!(st.last_commit.as_ref().unwrap().subject, "one");
    }

    #[tokio::test]
    async fn get_status_leaves_the_index_alone() {
        let (_t, dir) = tmp();
        run(&dir, &["init", "-q"]).await;
        std::fs::write(format!("{dir}/f.txt"), "one\n").unwrap();
        run(&dir, &["add", "f.txt"]).await;
        run(&dir, &["commit", "-q", "-m", "one"]).await;
        let later = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 60;
        touch_at(&format!("{dir}/f.txt"), later);
        let before = std::fs::read(format!("{dir}/.git/index")).unwrap();
        let st = get_status(&dir, &no_tips()).await.unwrap();
        assert!(st.files.is_empty());
        assert_eq!(std::fs::read(format!("{dir}/.git/index")).unwrap(), before);
        // the control: plain git status does write it
        exec(
            &["git", "-C", &dir, "status", "--porcelain"],
            &ExecOptions::default(),
        )
        .await;
        assert_ne!(std::fs::read(format!("{dir}/.git/index")).unwrap(), before);
    }

    #[tokio::test]
    async fn a_status_outside_a_repo_is_an_error() {
        let (_t, dir) = tmp();
        assert!(get_status(&dir, &no_tips()).await.is_err());
    }

    #[tokio::test]
    async fn elsewhere_timestamps_detached_worktrees() {
        let (_t, root) = tmp();
        let main = format!("{root}/main");
        let wt = format!("{root}/wt");
        exec(
            &["git", "init", "-q", "-b", "main", &main],
            &ExecOptions::default(),
        )
        .await;
        std::fs::write(format!("{main}/f.txt"), "one\n").unwrap();
        std::fs::write(format!("{main}/.gitignore"), "ignored\n").unwrap();
        run(&main, &["add", "."]).await;
        run(&main, &["commit", "-q", "-m", "one"]).await;
        let committed = js_int(&run(&main, &["log", "-1", "--format=%ct"]).await.stdout);
        run(&main, &["worktree", "add", "-q", "--detach", &wt]).await;
        std::fs::write(format!("{wt}/f.txt"), "changed\n").unwrap();
        touch_at(&format!("{wt}/f.txt"), committed + 60);
        std::fs::create_dir_all(format!("{wt}/new folder")).unwrap();
        let untracked = format!("{wt}/new folder/a \"quoted\" file.txt");
        std::fs::write(&untracked, "new\n").unwrap();
        touch_at(&untracked, committed + 120);
        std::fs::write(format!("{wt}/ignored"), "ignored\n").unwrap();
        touch_at(&format!("{wt}/ignored"), committed + 180);
        let cfg = format!("{root}/config");
        let w = |files: i64, at: i64| WorktreeWip {
            path: wt.clone(),
            branch: None,
            files,
            unmerged: 0,
            at: Some(at),
        };
        assert_eq!(
            read_elsewhere_in(&main, &cfg).await.unwrap().worktrees,
            vec![w(2, committed + 120)]
        );
        std::fs::remove_file(&untracked).unwrap();
        assert_eq!(
            read_elsewhere_in(&main, &cfg).await.unwrap().worktrees[0].at,
            Some(committed + 60)
        );
        std::fs::remove_file(format!("{wt}/f.txt")).unwrap();
        assert_eq!(
            read_elsewhere_in(&main, &cfg).await.unwrap().worktrees,
            vec![w(1, committed)]
        );
    }

    #[tokio::test]
    async fn elsewhere_finds_a_dirty_worktree_an_unmerged_branch_and_the_stash() {
        let (_t, root) = tmp();
        let main = format!("{root}/main");
        let wt = format!("{root}/wt");
        let cfg = format!("{root}/config");
        exec(
            &["git", "init", "-q", "-b", "main", &main],
            &ExecOptions::default(),
        )
        .await;
        std::fs::write(format!("{main}/f.txt"), "one\n").unwrap();
        run(&main, &["add", "f.txt"]).await;
        run(&main, &["commit", "-q", "-m", "one"]).await;
        assert_eq!(read_elsewhere_in(&main, &cfg).await, None);
        run(&main, &["checkout", "-q", "-b", "idea"]).await;
        std::fs::write(format!("{main}/g.txt"), "idea\n").unwrap();
        run(&main, &["add", "g.txt"]).await;
        run(&main, &["commit", "-q", "-m", "an idea"]).await;
        run(&main, &["checkout", "-q", "main"]).await;
        run(&main, &["worktree", "add", "-q", "-b", "agent", &wt]).await;
        std::fs::write(format!("{wt}/new.txt"), "wip\n").unwrap();
        let edited_at = 2_000_000_000;
        touch_at(&format!("{wt}/new.txt"), edited_at);
        std::fs::write(format!("{main}/f.txt"), "two\n").unwrap();
        run(&main, &["stash", "push", "-q", "-m", "parked"]).await;
        let e = read_elsewhere_in(&main, &cfg).await.unwrap();
        assert_eq!(
            e.worktrees,
            vec![WorktreeWip {
                path: wt.clone(),
                branch: Some("agent".into()),
                files: 1,
                unmerged: 0,
                at: Some(edited_at)
            }]
        );
        assert_eq!(
            e.branches
                .iter()
                .map(|b| (b.name.as_str(), b.unmerged, b.subject.as_str()))
                .collect::<Vec<_>>(),
            vec![("idea", Some(1), "an idea")]
        );
        assert_eq!(e.branches[0].push, BranchPush::Local);
        let stash = e.stash.unwrap();
        assert_eq!(
            (stash.count, stash.subject.as_str()),
            (1, "On main: parked")
        );
        let idea = elsewhere_detail(&main, Some("idea"), None).await;
        assert_eq!(
            idea.commits
                .iter()
                .map(|c| c.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["an idea"]
        );
        assert_eq!((idea.more, idea.files.len()), (0, 0));
        let agent = elsewhere_detail(&main, Some("agent"), Some(&wt)).await;
        assert!(agent.commits.is_empty());
        assert_eq!(
            agent
                .files
                .iter()
                .map(|f| (f.path.as_str(), f.untracked))
                .collect::<Vec<_>>(),
            vec![("new.txt", true)]
        );
        // the linked worktree's own card does not repeat what the main one shows
        assert_eq!(read_elsewhere_in(&wt, &cfg).await, None);
        // a worktree folder deleted without a prune: its branch's commits still show, now as a branch
        run(&wt, &["add", "new.txt"]).await;
        run(&wt, &["commit", "-q", "-m", "agent work"]).await;
        let committed = js_int(&run(&wt, &["log", "-1", "--format=%ct"]).await.stdout);
        let w0 = read_elsewhere_in(&main, &cfg)
            .await
            .unwrap()
            .worktrees
            .remove(0);
        assert_eq!((w0.files, w0.unmerged, w0.at), (0, 1, Some(committed)));
        std::fs::remove_dir_all(&wt).unwrap();
        let after = read_elsewhere_in(&main, &cfg).await.unwrap();
        assert!(after.worktrees.is_empty());
        assert!(
            after
                .branches
                .iter()
                .any(|b| b.name == "agent" && b.unmerged == Some(1))
        );
    }

    #[tokio::test]
    async fn a_branch_runs_worktree_is_the_landing_sections() {
        let (_t, root) = tmp();
        let cfg = format!("{root}/config");
        let main = format!("{root}/main");
        let wt = format!("{cfg}/worktrees/main-1234abcd/ab12cd34");
        exec(
            &["git", "init", "-q", "-b", "main", &main],
            &ExecOptions::default(),
        )
        .await;
        std::fs::write(format!("{main}/f.txt"), "one\n").unwrap();
        run(&main, &["add", "f.txt"]).await;
        run(&main, &["commit", "-q", "-m", "one"]).await;
        run(
            &main,
            &["worktree", "add", "-q", "-b", "run/x-ab12cd34", &wt],
        )
        .await;
        std::fs::write(format!("{wt}/g.txt"), "run\n").unwrap();
        run(&wt, &["add", "g.txt"]).await;
        run(&wt, &["commit", "-q", "-m", "run work"]).await;
        std::fs::write(format!("{wt}/h.txt"), "more\n").unwrap();
        assert_eq!(read_elsewhere_in(&main, &cfg).await, None);
    }

    #[tokio::test]
    async fn log_marks_unpushed_commits() {
        let (_t, root) = tmp();
        let origin = format!("{root}/origin.git");
        let work = format!("{root}/work");
        exec(
            &[
                "git",
                "init",
                "-q",
                "--bare",
                "--initial-branch=main",
                &origin,
            ],
            &ExecOptions::default(),
        )
        .await;
        exec(
            &["git", "clone", "-q", &origin, &work],
            &ExecOptions::default(),
        )
        .await;
        std::fs::write(format!("{work}/a"), "a\n").unwrap();
        run(&work, &["add", "a"]).await;
        run(&work, &["commit", "-q", "-m", "pushed"]).await;
        run(&work, &["push", "-q", "-u", "origin", "main"]).await;
        std::fs::write(format!("{work}/b"), "b\n").unwrap();
        run(&work, &["add", "b"]).await;
        run(&work, &["commit", "-q", "-m", "local"]).await;
        let log = get_log(&work, 20).await;
        assert_eq!(
            log.iter()
                .map(|e| (e.subject.as_str(), e.unpushed))
                .collect::<Vec<_>>(),
            vec![("local", true), ("pushed", false)]
        );
    }
}
