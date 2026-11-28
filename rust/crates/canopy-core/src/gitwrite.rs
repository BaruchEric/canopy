//! Changing a repo through git, and the drill's reads of one commit: the
//! write half of `src/core/git.ts` (git.rs has the read half). A commit's
//! detail, one file's diff, staging, commit, push with its fallback remotes
//! and the rebase after a rejected push, the stale-copy offer (FR-048),
//! pull, and clearing a stale index lock.

use crate::exec::{ExecOptions, ExecResult, GitTimeout, git, git_with, on_host};
use crate::git::{
    CommitFile, commit_files, is_hash, js_int, parse_name_status_z, parse_numstat_z, repo_relative,
};
use crate::host::parse_locator;
use crate::pathx::{js_len, js_trim};
use crate::peers::NO_PUSH;
use crate::seedgit::{seed_roots_now, seeds_root_of};
use crate::stalecopy::{
    COMMIT_FORMAT, Pairing, StaleCopy, StaleOffer, StaleVerdict, judge_copies, lines_left_out,
    newest_stale, offer_words, pair_copies, parse_commits,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;
use std::time::Instant;

/// What a git write refuses with. Every kind carries the words to show;
/// the kind is what a caller acts on (the server's status code, the CLI's
/// `--drop-stale` hint).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitError {
    /// git's own words, or canopy's
    Failed(String),
    /// `get_commit` on a hash git has never seen
    UnknownCommit(String),
    /// a push refused because upstream holds an amended copy of local
    /// commits; `offer` is what dropping them takes
    StaleCopy {
        message: String,
        offer: Box<StaleOffer>,
    },
    /// a drop of stale copies that canopy would not start, or that stopped
    /// and was put back
    DropRefused(String),
}

impl GitError {
    pub fn message(&self) -> &str {
        match self {
            GitError::Failed(m) | GitError::UnknownCommit(m) | GitError::DropRefused(m) => m,
            GitError::StaleCopy { message, .. } => message,
        }
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for GitError {}

impl From<String> for GitError {
    fn from(m: String) -> Self {
        GitError::Failed(m)
    }
}

fn failed(m: impl Into<String>) -> GitError {
    GitError::Failed(m.into())
}

/// `s.trim() || fallback`
fn or(s: &str, fallback: &str) -> String {
    let t = js_trim(s);
    if t.is_empty() { fallback } else { t }.to_string()
}

fn lines(s: &str) -> Vec<String> {
    s.split('\n')
        .map(|l| js_trim(l).to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn args(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

/// Several git calls in one repo at once, the answers in the order asked.
async fn git_all(repo: &str, calls: Vec<Vec<String>>) -> Vec<ExecResult> {
    let mut set = tokio::task::JoinSet::new();
    let n = calls.len();
    for (i, a) in calls.into_iter().enumerate() {
        let repo = repo.to_string();
        set.spawn(async move { (i, git(&repo, &a).await) });
    }
    let mut out = vec![ExecResult::fail(1, "git did not finish"); n];
    while let Some(done) = set.join_next().await {
        if let Ok((i, r)) = done {
            out[i] = r;
        }
    }
    out
}

const SHOW: &[&str] = &["show", "--format=", "--diff-merges=first-parent", "-M"];

fn show(rest: &[&str]) -> Vec<String> {
    SHOW.iter().chain(rest).map(|s| s.to_string()).collect()
}

/// Everything the drill shows for one commit: the message in full, who and
/// when, and each file with its line counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitDetail {
    /// full 40-character hash
    pub hash: String,
    pub short: String,
    pub subject: String,
    /// the message after the subject, trimmed; empty when there is none
    pub body: String,
    pub author: String,
    pub email: String,
    /// committer time, unix seconds
    pub at: i64,
    pub parents: Vec<String>,
    pub files: Vec<CommitFile>,
}

static UNKNOWN_REV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)unknown revision|bad object|bad revision").expect("regex"));

pub async fn get_commit(repo_path: &str, hash: &str) -> Result<CommitDetail, GitError> {
    if !is_hash(hash) {
        return Err(failed(format!("invalid commit hash: {hash}")));
    }
    let head_args = [
        "show",
        "--no-patch",
        "--pretty=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%ct%x00%P",
        hash,
    ];
    let (numstat_args, names_args) = (
        show(&["--numstat", "-z", hash]),
        show(&["--name-status", "-z", hash]),
    );
    let (head, numstat, names) = tokio::join!(
        git(repo_path, &head_args),
        git(repo_path, &numstat_args),
        git(repo_path, &names_args),
    );
    if head.code != 0 {
        let why = js_trim(&head.stderr);
        // Git says "unknown revision" for a hash it has never seen; anything
        // else (an unreadable repo, say) is a different failure and keeps its text.
        if why.is_empty() || UNKNOWN_REV.is_match(why) {
            return Err(GitError::UnknownCommit(format!(
                "no commit {hash} in this repo"
            )));
        }
        return Err(failed(why));
    }
    let f: Vec<&str> = head.stdout.split('\0').collect();
    let at = |i: usize, d: &'static str| f.get(i).copied().unwrap_or(d);
    Ok(CommitDetail {
        hash: at(0, "").into(),
        short: at(1, "").into(),
        subject: at(2, "").into(),
        body: js_trim(at(3, "")).into(),
        author: at(4, "").into(),
        email: at(5, "").into(),
        at: js_int(at(6, "0")),
        parents: js_trim(at(7, ""))
            .split(' ')
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect(),
        files: commit_files(
            &parse_numstat_z(&numstat.stdout),
            &parse_name_status_z(&names.stdout),
        ),
    })
}

/// Which diff of a file to show: the working tree against the index or HEAD,
/// a file git does not track yet, or what one commit did to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffTarget {
    Worktree {
        staged: bool,
    },
    Untracked,
    Commit {
        hash: String,
        /// the path before a rename, so git can pair the two sides
        orig: Option<String>,
    },
}

/// Diff for one file. Untracked files render as an all-added diff.
pub async fn get_diff(
    repo_path: &str,
    file: &str,
    target: &DiffTarget,
) -> Result<String, GitError> {
    // `file` arrives straight from a query param: never let it leave the
    // repo. Validate, then hand git the original relative path so the diff
    // header still reads b/<file> rather than an absolute path.
    repo_relative(repo_path, file)?;
    match target {
        DiffTarget::Untracked => {
            let r = git(repo_path, &["diff", "--no-index", "--", "/dev/null", file]).await;
            // --no-index exits 1 on differences; the output is still the diff
            Ok(r.stdout)
        }
        DiffTarget::Worktree { staged } => {
            let mut a = vec!["diff"];
            if *staged {
                a.push("--cached");
            }
            a.extend(["--", file]);
            let r = git(repo_path, &a).await;
            Ok(if r.code == 0 { r.stdout } else { r.stderr })
        }
        DiffTarget::Commit { hash, orig } => {
            if !is_hash(hash) {
                return Err(failed(format!("invalid commit hash: {hash}")));
            }
            let mut paths = vec![file];
            if let Some(o) = orig {
                repo_relative(repo_path, o)?;
                paths.push(o);
            }
            let mut a = show(&[hash, "--"]);
            a.extend(paths.iter().map(|p| p.to_string()));
            let r = git(repo_path, &a).await;
            Ok(if r.code == 0 { r.stdout } else { r.stderr })
        }
    }
}

static NO_HEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)resolve 'HEAD'|unknown revision").expect("regex"));

/// Stage or unstage one row of the changes list. A rename's row is both of
/// its paths: unstaging the new one alone left the old one's deletion staged,
/// so the next commit deleted it without adding the new one.
pub async fn stage_file(
    repo_path: &str,
    file: &str,
    unstage: bool,
    orig: Option<&str>,
) -> Result<(), GitError> {
    repo_relative(repo_path, file)?;
    if let Some(o) = orig {
        repo_relative(repo_path, o)?;
    }
    let mut paths = vec![file];
    paths.extend(orig);
    let with = |head: &[&str]| -> Vec<String> {
        head.iter()
            .chain(["--"].iter())
            .chain(paths.iter())
            .map(|s| s.to_string())
            .collect()
    };
    if !unstage {
        let r = git(repo_path, &with(&["add"])).await;
        if r.code != 0 {
            return Err(failed(or(&r.stderr, "git stage failed")));
        }
        return Ok(());
    }
    let mut r = git(repo_path, &with(&["restore", "--staged"])).await;
    // Before the first commit there is no HEAD to restore from; dropping the
    // file from the index is the same thing on an unborn branch.
    if r.code != 0 && NO_HEAD.is_match(&r.stderr) {
        r = git(repo_path, &with(&["rm", "--cached"])).await;
    }
    if r.code != 0 {
        return Err(failed(or(&r.stderr, "git unstage failed")));
    }
    Ok(())
}

pub async fn commit(repo_path: &str, message: &str, stage_all: bool) -> Result<String, GitError> {
    if stage_all {
        let a = git(repo_path, &["add", "-A"]).await;
        if a.code != 0 {
            return Err(failed(or(&a.stderr, "git add failed")));
        }
    }
    let r = git(repo_path, &["commit", "-m", message]).await;
    if r.code != 0 {
        return Err(failed(or(
            &format!("{}{}", r.stdout, r.stderr),
            "git commit failed",
        )));
    }
    Ok(js_trim(&r.stdout).to_string())
}

static ACCESS_DENIED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)permission[^\n\r\x{2028}\x{2029}]+denied|(?:error|status)[^\n]{0,12}(?-u:\b)403(?-u:\b)|authentication failed|not authorized|access denied|repository not found",
    )
    .expect("regex")
});

/// Whether the remote refused *us*, as opposed to rejecting the ref. Only this
/// warrants trying a different remote: a non-fast-forward means we are behind,
/// and retrying elsewhere would push a stale branch somewhere new. Narrow on
/// purpose: a server-side unpack failure is a broken remote, not a wrong one.
/// A 403 counts only where git frames it as a status, so a bare "403"
/// elsewhere in push output (hook chatter, diff stats) cannot trigger a retry.
pub fn is_access_denied(stderr: &str) -> bool {
    ACCESS_DENIED.is_match(stderr)
}

struct Targets {
    tracked: String,
    ordered: Vec<String>,
    fetch_only: usize,
}

/// Push targets, most-preferred first: whatever the branch tracks, then every
/// other pushable remote. Peer remotes are fetch-only. Forks commonly track a
/// read-only upstream while the writable copy sits on a differently named
/// remote.
async fn push_targets(repo_path: &str, branch: &str) -> Targets {
    let listed = git(repo_path, &["remote"]).await;
    let remotes = if listed.code == 0 {
        lines(&listed.stdout)
    } else {
        vec![]
    };
    let cfg = git(
        repo_path,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .await;
    let tracked = if cfg.code == 0 {
        js_trim(&cfg.stdout).to_string()
    } else {
        String::new()
    };
    let urls = remotes
        .iter()
        .map(|r| args(&["remote", "get-url", "--push", "--all", r]))
        .collect();
    let push_remote_key = format!("branch.{branch}.pushRemote");
    let push_remote_args = ["config", "--get", &push_remote_key];
    let (push_remote, push_default, urls) = tokio::join!(
        git(repo_path, &push_remote_args),
        git(repo_path, &["config", "--get", "remote.pushDefault"]),
        git_all(repo_path, urls),
    );
    let pushable: Vec<String> = remotes
        .iter()
        .zip(urls)
        .filter(|(_, u)| !(u.code == 0 && u.stdout.split('\n').any(|l| js_trim(l) == NO_PUSH)))
        .map(|(r, _)| r.clone())
        .collect();
    // A plain `git push` to the tracked remote already honors pushRemote and
    // pushDefault; when the tracked one is a peer, they still pick the first try.
    let configured: Vec<String> = if !tracked.is_empty() && !pushable.contains(&tracked) {
        [push_remote, push_default]
            .iter()
            .map(|r| {
                if r.code == 0 {
                    js_trim(&r.stdout).to_string()
                } else {
                    String::new()
                }
            })
            .collect()
    } else {
        vec![]
    };
    let first = std::iter::once(&tracked)
        .chain(configured.iter())
        .find(|r| !r.is_empty() && pushable.contains(r))
        .cloned();
    let ordered = match first {
        Some(f) => std::iter::once(f.clone())
            .chain(pushable.iter().filter(|r| **r != f).cloned())
            .collect(),
        None => pushable.clone(),
    };
    Targets {
        tracked,
        ordered,
        fetch_only: remotes.len() - pushable.len(),
    }
}

fn elapsed_ms(t0: Instant) -> u64 {
    t0.elapsed().as_millis() as u64
}

pub async fn push(repo_path: &str) -> Result<String, GitError> {
    // Exit 1 is a detached HEAD. Any other failure (no such folder, not a
    // repo) keeps git's own words, and a repo with no commits yet is on its
    // branch, so the push says what is missing.
    let head = git(repo_path, &["symbolic-ref", "-q", "--short", "HEAD"]).await;
    if head.code == 1 {
        return Err(failed("detached HEAD — check out a branch first"));
    }
    if head.code != 0 {
        return Err(failed(or(&head.stderr, "git could not read HEAD")));
    }
    let branch = js_trim(&head.stdout).to_string();
    let Targets {
        tracked,
        ordered,
        fetch_only,
    } = push_targets(repo_path, &branch).await;
    if ordered.is_empty() {
        return Err(failed(if fetch_only > 0 {
            "no remote to push to: peer remotes are fetch-only"
        } else {
            "no remote configured"
        }));
    }

    let mut last_err = String::new();
    for remote in &ordered {
        // Adopt a remote as upstream only when the branch has none. If it
        // already tracks something we cannot push to, quietly repointing it
        // would hide how far behind that upstream we are.
        let to = format!("HEAD:{branch}");
        let a = if *remote == tracked {
            args(&["push"])
        } else if !tracked.is_empty() {
            args(&["push", remote, &to])
        } else {
            args(&["push", "-u", remote, &to])
        };
        let t0 = Instant::now();
        let r = git_with(repo_path, &a, GitTimeout::from(NET_TIMEOUT_MS), &[]).await;
        if r.code == 0 {
            let out = js_trim(&format!("{}{}", r.stdout, r.stderr)).to_string();
            return Ok(if *remote == tracked {
                out
            } else {
                format!("pushed to {remote}\n{out}")
            });
        }
        last_err = or(&r.stderr, "git push failed");
        if *remote == tracked && is_behind(&last_err) && can_rebase_rejected_push(repo_path).await {
            return rebase_and_push(repo_path, &last_err).await;
        }
        if !is_access_denied(&last_err) {
            last_err = net_error(&last_err, "push", elapsed_ms(t0))
                .message()
                .to_string();
            break;
        }
    }
    // Every remote refused us. Say so plainly: the fallback cannot help a
    // clone whose only remote belongs to someone else.
    if is_access_denied(&last_err) {
        let tried = if ordered.len() == 1 {
            format!("its only remote ({})", ordered[0])
        } else {
            format!("all {} remotes ({})", ordered.len(), ordered.join(", "))
        };
        return Err(failed(format!(
            "{last_err}\n\nNo remote accepted this push — tried {tried}. Fork the repo, then add your copy as a remote to push this branch."
        )));
    }
    if is_no_login(&last_err) {
        let env: HashMap<String, String> = if parse_locator(repo_path).host.is_some() {
            HashMap::new()
        } else {
            std::env::vars().collect()
        };
        return Err(failed(format!("{last_err}\n\n{}", no_login_advice(&env))));
    }
    Err(failed(last_err))
}

static BEHIND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[rejected\][^\n\r\x{2028}\x{2029}]*\((?:fetch first|non-fast-forward)\)")
        .expect("regex")
});

/// The remote rejected the ref because it has commits we lack: "fetch first"
/// when we never saw them, "non-fast-forward" when we fetched and are behind.
pub fn is_behind(stderr: &str) -> bool {
    BEHIND.is_match(stderr)
}

/// Bare `git push` can use a different remote, branch, or set of refspecs
/// from the configured upstream. Only recover when git resolves that push
/// back to the exact upstream and its config describes one ordinary branch
/// push.
async fn can_rebase_rejected_push(repo_path: &str) -> bool {
    let (upstream, push, push_default) = tokio::join!(
        git(repo_path, &["rev-parse", "--symbolic-full-name", "@{u}"]),
        git(repo_path, &["rev-parse", "--symbolic-full-name", "@{push}"]),
        git(repo_path, &["config", "--get", "push.default"]),
    );
    if upstream.code != 0 || push.code != 0 {
        return false;
    }
    let upstream_ref = js_trim(&upstream.stdout);
    if upstream_ref != js_trim(&push.stdout) || !upstream_ref.starts_with("refs/remotes/") {
        return false;
    }
    if push_default.code != 0 && push_default.code != 1 {
        return false;
    }
    // Git's unset default is `simple`; all three modes below can push only
    // the current branch, provided @{push} resolved to @{u} above.
    // `matching` can reject some other branch while leaving this one alone.
    let mode = if push_default.code == 0 {
        js_trim(&push_default.stdout)
    } else {
        "simple"
    };
    if !["simple", "upstream", "current"].contains(&mode) {
        return false;
    }

    let listed = git(repo_path, &["remote"]).await;
    if listed.code != 0 {
        return false;
    }
    // Remote names may contain slashes, so choose the longest exact prefix
    // (the first of equals, as a stable sort leaves them).
    let mut remote: Option<String> = None;
    for name in lines(&listed.stdout) {
        if upstream_ref.starts_with(&format!("refs/remotes/{name}/"))
            && remote.as_deref().is_none_or(|r| js_len(&name) > js_len(r))
        {
            remote = Some(name);
        }
    }
    let Some(remote) = remote else {
        return false;
    };

    let got = git_all(
        repo_path,
        vec![
            args(&["config", "--get-all", &format!("remote.{remote}.push")]),
            args(&[
                "config",
                "--bool",
                "--get",
                &format!("remote.{remote}.mirror"),
            ]),
            args(&["config", "--bool", "--get", "push.followTags"]),
            args(&[
                "config",
                "--bool",
                "--get",
                &format!("remote.{remote}.followTags"),
            ]),
            args(&["config", "--get", "push.recurseSubmodules"]),
            args(&["remote", "get-url", "--all", &remote]),
            args(&["remote", "get-url", "--push", "--all", &remote]),
        ],
    )
    .await;
    let [
        refspec,
        mirror,
        push_follow_tags,
        remote_follow_tags,
        recurse_submodules,
        fetch_urls,
        push_urls,
    ] = got.as_slice()
    else {
        return false;
    };
    // A configured refspec can push other branches; a mirror can push every
    // ref. Either can make a rejection unrelated to the current branch.
    if refspec.code != 1 {
        return false;
    }
    let unset_or_false =
        |r: &ExecResult| r.code == 1 || (r.code == 0 && js_trim(&r.stdout) == "false");
    if !unset_or_false(mirror)
        || !unset_or_false(push_follow_tags)
        || !unset_or_false(remote_follow_tags)
    {
        return false;
    }
    if recurse_submodules.code != 1
        && !(recurse_submodules.code == 0 && js_trim(&recurse_submodules.stdout) == "no")
    {
        return false;
    }
    if fetch_urls.code != 0 || push_urls.code != 0 {
        return false;
    }
    let fetch_list = lines(&fetch_urls.stdout);
    let push_list = lines(&push_urls.stdout);
    fetch_list.len() == 1 && push_list.len() == 1 && fetch_list[0] == push_list[0]
}

/// A push the tracked upstream turned down for being behind: fetch, rebase
/// the local commits onto the upstream and push once more. Several machines
/// commit to the same repos, so this is the common case, and the rebase
/// drops a local commit whose change is already upstream instead of pushing
/// a copy. Local merge commits stop it (a plain rebase would flatten them),
/// and so does a conflict, after which the branch is put back as it was.
async fn rebase_and_push(repo_path: &str, rejected: &str) -> Result<String, GitError> {
    let refuse =
        |why: &str| -> Result<String, GitError> { Err(failed(format!("{rejected}\n\n{why}"))) };
    // `rebase --autostash` can restore partially staged work with a different
    // index/worktree split. Leave the branch and index alone when anything is
    // staged; the user can commit or unstage it before retrying.
    let staged = git(repo_path, &["diff", "--cached", "--quiet"]).await;
    if staged.code == 1 {
        return refuse(
            "The index has staged changes, so canopy left the rebase to you. Commit or unstage them, then retry.",
        );
    }
    if staged.code != 0 {
        return refuse(
            "Canopy could not confirm that the index is clean, so it left the rebase to you.",
        );
    }
    let net = GitTimeout::from(NET_TIMEOUT_MS);
    let t0 = Instant::now();
    let fetched = git_with(repo_path, &["fetch", "--quiet"], net, &[]).await;
    if fetched.code != 0 {
        return Err(net_error(&fetched.stderr, "fetch", elapsed_ms(t0)));
    }
    let merges = git(repo_path, &["rev-list", "--merges", "@{u}..HEAD"]).await;
    if !js_trim(&merges.stdout).is_empty() {
        return refuse(
            "The branch is behind its upstream and has merge commits of its own, so canopy left the rebase to you.",
        );
    }
    let rebased = git_with(repo_path, &["rebase", "--autostash", "@{u}"], net, &[]).await;
    if rebased.code != 0 {
        // the commit the rebase stopped on, read before the abort clears it
        let (conflicts, stopped) = tokio::join!(
            git(repo_path, &["diff", "--name-only", "--diff-filter=U"]),
            git(repo_path, &["rev-parse", "-q", "--verify", "REBASE_HEAD"]),
        );
        git(repo_path, &["rebase", "--abort"]).await;
        let files: Vec<&str> = js_trim(&conflicts.stdout)
            .split('\n')
            .filter(|f| !f.is_empty())
            .collect();
        let why = if files.is_empty() {
            format!(
                "Rebasing onto the upstream failed, and canopy put the branch back as it was:\n{}",
                js_trim(&format!("{}{}", rebased.stdout, rebased.stderr))
            )
        } else {
            format!(
                "Rebasing onto the upstream hit a conflict in {}. canopy put the branch back as it was.",
                files.join(", ")
            )
        };
        // FR-048: upstream may hold an amend of a local commit, which the
        // rebase replays onto its own newer copy. A stop on a later commit
        // is that commit's own conflict, so it gets no offer.
        let found = stale_copies(repo_path).await;
        let on = (stopped.code == 0).then(|| js_trim(&stopped.stdout).to_string());
        if let Some(f) = &found
            && let StaleVerdict::Drop { copies, kept } = &f.verdict
        {
            let offer = offer_of(f, copies, *kept);
            if on
                .as_ref()
                .is_none_or(|on| offer.copies.iter().any(|c| c.stale == *on))
            {
                return Err(GitError::StaleCopy {
                    message: format!("{rejected}\n\n{why}\n{}", offer_words(&offer)),
                    offer: Box::new(offer),
                });
            }
        }
        return match found.map(|f| f.verdict) {
            Some(StaleVerdict::Refuse { why: also }) => refuse(&format!("{why}\n{also}")),
            _ => refuse(&why),
        };
    }
    let mut notes = rebase_notes(repo_path, &rebased).await;
    let t1 = Instant::now();
    let again = git_with(repo_path, &["push"], net, &[]).await;
    if again.code != 0 {
        return Err(net_error(&again.stderr, "push", elapsed_ms(t1)));
    }
    let mut out = vec!["rebased onto the upstream first".to_string()];
    out.append(&mut notes);
    out.push(js_trim(&format!("{}{}", again.stdout, again.stderr)).to_string());
    Ok(out.join("\n"))
}

static DROPPED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"previously applied commit ([0-9a-f]+)|dropping ([0-9a-f]+) [^\n\r\x{2028}\x{2029}]*already upstream")
        .expect("regex")
});

/// What a finished rebase said worth repeating. A commit already upstream
/// reads "skipped previously applied commit <hash>" when git spots it up
/// front, "dropping <hash> ... already upstream" when it empties out
/// mid-pick. An autostash that came back with conflicts says its changes
/// are safe in the stash.
async fn rebase_notes(repo_path: &str, rebased: &ExecResult) -> Vec<String> {
    let all = format!("{}{}", rebased.stdout, rebased.stderr);
    let said: Vec<&str> = all.split(['\r', '\n']).collect();
    let dropped: Vec<String> = said
        .iter()
        .filter_map(|l| DROPPED.captures(l))
        .flat_map(|m| {
            [m.get(1), m.get(2)]
                .into_iter()
                .flatten()
                .map(|g| g.as_str().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .collect();
    let named = git_all(
        repo_path,
        dropped
            .iter()
            .map(|h| args(&["log", "-1", "--format=%h %s", h]))
            .collect(),
    )
    .await;
    let mut notes: Vec<String> = dropped
        .iter()
        .zip(named)
        .map(|(hash, n)| {
            let name = if n.code == 0 {
                js_trim(&n.stdout).to_string()
            } else {
                hash.chars().take(7).collect()
            };
            format!("dropped {name}: already upstream")
        })
        .collect();
    notes.extend(
        said.iter()
            .filter(|l| l.contains("safe in the stash"))
            .map(|l| js_trim(l).to_string()),
    );
    notes
}

/// What `stale_copies` found: the verdict and where the branch stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleFacts {
    pub verdict: StaleVerdict,
    pub branch: String,
    pub upstream: String,
    pub onto: String,
}

fn offer_of(f: &StaleFacts, copies: &[StaleCopy], kept: i64) -> StaleOffer {
    StaleOffer {
        branch: f.branch.clone(),
        upstream: f.upstream.clone(),
        onto: f.onto.clone(),
        copies: copies.to_vec(),
        kept,
    }
}

/// Upstream's amended copies of the branch's commits, judged by
/// `judge_copies` (stalecopy.rs) over what git says here: the commits on
/// each side of the merge base with `@{u}`, and for each matched pair the
/// files the local commit changed and the diff from it to its copy. Reads
/// only, against the remote-tracking ref as last fetched. None when there is
/// no branch, no upstream, or no shared history.
pub async fn stale_copies(repo_path: &str) -> Option<StaleFacts> {
    let (head, name, tip) = tokio::join!(
        git(repo_path, &["symbolic-ref", "-q", "--short", "HEAD"]),
        git(repo_path, &["rev-parse", "--abbrev-ref", "@{u}"]),
        git(repo_path, &["rev-parse", "-q", "--verify", "@{u}^{commit}"]),
    );
    if head.code != 0 || name.code != 0 || tip.code != 0 {
        return None;
    }
    let onto = js_trim(&tip.stdout).to_string();
    let base = git(repo_path, &["merge-base", "HEAD", &onto]).await;
    if base.code != 0 {
        return None;
    }
    let base = js_trim(&base.stdout);
    let format = format!("--format={COMMIT_FORMAT}");
    let since = |to: &str| {
        args(&[
            "log",
            "--no-show-signature",
            "--reverse",
            &format,
            &format!("{base}..{to}"),
        ])
    };
    let logs = git_all(repo_path, vec![since("HEAD"), since(&onto)]).await;
    let [mine, theirs] = logs.as_slice() else {
        return None;
    };
    if mine.code != 0 || theirs.code != 0 {
        return None;
    }
    let local = parse_commits(&mine.stdout);
    let pairing = pair_copies(&local, &parse_commits(&theirs.stdout));
    let mut left_out: HashMap<String, Vec<String>> = HashMap::new();
    if let Pairing::Pairs(pairs) = &pairing {
        for pair in pairs {
            let (s, c) = (pair.stale.hash.as_str(), pair.copy.hash.as_str());
            let got = git_all(
                repo_path,
                vec![
                    args(&[
                        "diff-tree",
                        "-r",
                        "--root",
                        "--no-commit-id",
                        "--name-only",
                        "--no-renames",
                        "-z",
                        s,
                    ]),
                    args(&[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--numstat",
                        "--no-renames",
                        "-z",
                        s,
                        c,
                    ]),
                ],
            )
            .await;
            if let [paths, numstat] = got.as_slice()
                && paths.code == 0
                && numstat.code == 0
            {
                let named: Vec<String> = paths
                    .stdout
                    .split('\0')
                    .filter(|p| !p.is_empty())
                    .map(String::from)
                    .collect();
                left_out.insert(s.to_string(), lines_left_out(&named, &numstat.stdout));
            }
        }
    }
    Some(StaleFacts {
        verdict: judge_copies(&local, &pairing, &left_out),
        branch: js_trim(&head.stdout).to_string(),
        upstream: js_trim(&name.stdout).to_string(),
        onto,
    })
}

/// What a drop of stale copies did, and how many commits are left to push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dropped {
    pub out: String,
    pub kept: i64,
}

/// Drops the stale copies a refused push offered (`GitError::StaleCopy`):
/// the branch moved onto the upstream tip with `git rebase --onto <tip>
/// <newest stale> <branch>`, so the commits after them are replayed and
/// kept. `stale` and `onto` are what the offer named; the facts are read
/// again and the move goes on only when they give the same offer. Refused
/// on a detached HEAD (a rebase in progress has one) or uncommitted changes
/// to tracked files; a conflict aborts the rebase and leaves the branch as
/// it was.
pub async fn drop_stale_copies(
    repo_path: &str,
    stale: &str,
    onto: &str,
) -> Result<Dropped, GitError> {
    let head = git(repo_path, &["symbolic-ref", "-q", "--short", "HEAD"]).await;
    if head.code == 1 {
        return Err(GitError::DropRefused(
            "HEAD is detached (a rebase may be in progress), so canopy left the branch alone."
                .into(),
        ));
    }
    if head.code != 0 {
        return Err(failed(or(&head.stderr, "git could not read HEAD")));
    }
    let status = git(
        repo_path,
        &["status", "--porcelain=v1", "--untracked-files=no"],
    )
    .await;
    if status.code != 0 {
        return Err(failed(or(&status.stderr, "git status failed")));
    }
    let dirty: Vec<String> = status
        .stdout
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().skip(3).collect())
        .collect();
    if !dirty.is_empty() {
        let named = if dirty.len() > 5 {
            format!("{} and {} more", dirty[..5].join(", "), dirty.len() - 5)
        } else {
            dirty.join(", ")
        };
        return Err(GitError::DropRefused(format!(
            "The working tree has uncommitted changes to {named}. Commit or stash them, then drop the stale copy."
        )));
    }
    let found = stale_copies(repo_path).await;
    let (found, copies, kept) = match found {
        None => {
            return Err(GitError::DropRefused(
                "Upstream holds no amended copy of a local commit now. Push again to look afresh."
                    .into(),
            ));
        }
        Some(f) => match f.verdict.clone() {
            StaleVerdict::None => {
                return Err(GitError::DropRefused(
                    "Upstream holds no amended copy of a local commit now. Push again to look afresh."
                        .into(),
                ));
            }
            StaleVerdict::Refuse { why } => return Err(GitError::DropRefused(why)),
            StaleVerdict::Drop { copies, kept } => (f, copies, kept),
        },
    };
    let offer = offer_of(&found, &copies, kept);
    if newest_stale(&offer.copies) != stale || offer.onto != onto {
        return Err(GitError::DropRefused(format!(
            "{} or {} moved since canopy looked. Push again to look afresh.",
            offer.branch, offer.upstream
        )));
    }
    let r = git_with(
        repo_path,
        &["rebase", "--onto", &offer.onto, stale, &offer.branch],
        GitTimeout::from(120_000),
        &[("GIT_EDITOR", "true")],
    )
    .await;
    if r.code != 0 {
        // HEAD was on a branch before, so any rebase state now is this one's
        let (conflicts, stopped) = tokio::join!(
            git(repo_path, &["diff", "--name-only", "--diff-filter=U"]),
            git(repo_path, &["log", "-1", "--format=%h %s", "REBASE_HEAD"]),
        );
        git(repo_path, &["rebase", "--abort"]).await;
        let files: Vec<&str> = js_trim(&conflicts.stdout)
            .split('\n')
            .filter(|f| !f.is_empty())
            .collect();
        let at = if stopped.code == 0 && !js_trim(&stopped.stdout).is_empty() {
            format!(" (replaying {})", js_trim(&stopped.stdout))
        } else {
            String::new()
        };
        return Err(GitError::DropRefused(if files.is_empty() {
            format!(
                "Moving {} onto {} failed, and canopy put the branch back as it was:\n{}",
                offer.branch,
                offer.upstream,
                js_trim(&format!("{}{}", r.stdout, r.stderr))
            )
        } else {
            format!(
                "Moving {} onto {} hit a conflict in {}{at}. canopy put the branch back as it was.",
                offer.branch,
                offer.upstream,
                files.join(", ")
            )
        }));
    }
    let left = git(
        repo_path,
        &["rev-list", "--count", &format!("{}..HEAD", offer.onto)],
    )
    .await;
    let kept = if left.code == 0 {
        js_int(&left.stdout)
    } else {
        offer.kept
    };
    let short = |h: &str| h.chars().take(7).collect::<String>();
    let mut out: Vec<String> = offer
        .copies
        .iter()
        .map(|c| {
            format!(
                "dropped {} {}: upstream holds its amend {}",
                short(&c.stale),
                c.subject,
                short(&c.copy)
            )
        })
        .collect();
    out.push(format!(
        "moved {} onto {}{}",
        offer.branch,
        offer.upstream,
        if kept > 0 {
            format!(
                ", {kept} commit{} replayed on top",
                if kept == 1 { "" } else { "s" }
            )
        } else {
            String::new()
        }
    ));
    out.extend(rebase_notes(repo_path, &r).await);
    Ok(Dropped {
        out: out.join("\n"),
        kept,
    })
}

static NO_LOGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)could not read (?:username|password)").expect("regex"));

/// git wanted a username or password and had no terminal to ask on
/// (`GIT_TERMINAL_PROMPT=0`, or no tty at all): no credentials here, which
/// is not the remote refusing us.
pub fn is_no_login(stderr: &str) -> bool {
    NO_LOGIN.is_match(stderr)
}

static HELPER_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^credential\..*helper$").expect("regex"));
static GH_HELPER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)gh auth git-credential(?-u:\b)").expect("regex"));

/// What to do about a push git had no login for. In canopy's containers gh
/// is git's credential helper (GIT_CONFIG_* in docker-compose.yml) and
/// GH_TOKEN is its only login, so an empty GH_TOKEN is the gap, not a
/// missing helper. `env` is the server's own; pass an empty map for a repo
/// on another host.
pub fn no_login_advice(env: &HashMap<String, String>) -> &'static str {
    let get = |k: &str| env.get(k).map_or("", String::as_str);
    // Number(x ?? 0): NaN runs no rounds
    let count = match js_trim(get("GIT_CONFIG_COUNT")) {
        "" => 0.0,
        n => n.parse::<f64>().unwrap_or(f64::NAN),
    };
    let mut gh_helper = false;
    let mut i = 0u32;
    while f64::from(i) < count {
        if HELPER_KEY.is_match(get(&format!("GIT_CONFIG_KEY_{i}")))
            && GH_HELPER.is_match(get(&format!("GIT_CONFIG_VALUE_{i}")))
        {
            gh_helper = true;
        }
        i += 1;
    }
    if gh_helper && get("GH_TOKEN").is_empty() && get("GITHUB_TOKEN").is_empty() {
        return "gh is git's credential helper here, but GH_TOKEN is empty, so gh had no login to hand over. Set GH_TOKEN in this backend's .env and recreate its containers (docs/deploy.md, Configure).";
    }
    "This machine has no login for that remote, so git could not ask for one. Push from a machine that has one, or give git a credential helper here."
}

/// How long a push or a pull may take. A clone months behind a busy
/// upstream fetches tens of thousands of commits, which ran past the two
/// minutes this used to be; the server never times a request out.
pub const NET_TIMEOUT_MS: u64 = 15 * 60_000;

/// git's own words after its output, when it failed: a lock gets canopy's
/// offer to clear it, and a run stopped at the timeout says so, since the
/// output alone reads like a fetch that went fine.
pub fn net_error(stderr: &str, what: &str, took_ms: u64) -> GitError {
    let words = or(stderr, &format!("git {what} failed"));
    if is_locked_index(&words) {
        // git's line naming the lock, then one sentence for its two
        // paragraphs of advice, which assume a terminal
        let line = words
            .split('\n')
            .find(|l| is_locked_index(l))
            .map_or(words.as_str(), js_trim);
        return failed(format!(
            "{line}\nAnother git process may be running, or one that died left this lock behind; canopy clears one over {STALE_LOCK_MIN} minutes old."
        ));
    }
    if took_ms >= NET_TIMEOUT_MS {
        return failed(format!(
            "{words}\n\ngit {what} ran past {} minutes and was stopped.",
            NET_TIMEOUT_MS / 60_000
        ));
    }
    failed(words)
}

pub async fn pull(repo_path: &str) -> Result<String, GitError> {
    let t0 = Instant::now();
    // --no-rebase: with pull.rebase=true in the user's config, git takes the
    // rebase path despite --ff-only and refuses any dirty tree before it even
    // fetches. A fast-forward never needs a rebase, and it carries unstaged
    // edits along unless upstream touches the same files.
    let r = git_with(
        repo_path,
        &["pull", "--ff-only", "--no-rebase"],
        GitTimeout::from(NET_TIMEOUT_MS),
        &[],
    )
    .await;
    if r.code != 0 {
        return Err(net_error(&r.stderr, "pull", elapsed_ms(t0)));
    }
    Ok(js_trim(&r.stdout).to_string())
}

/// A lock younger than this may still be in use, so it is never cleared.
/// Age alone does not make one stale: `git commit -a` holds the lock for as
/// long as its editor stays open, so `clear_stale_lock` also looks for a git
/// process at work in the repo.
pub const STALE_LOCK_MIN: u64 = 10;

/// A shell script that prints the pid of a git process whose working folder
/// is the repo top in $1 or under it, and exits 0; exits 1 when there is
/// none, 2 when it cannot tell (no /proc and no lsof). /proc on Linux, lsof
/// on macOS. No single quotes, since remote_command quotes each word with
/// them for ssh, and the case patterns open with "(" because bash 3.2 (the
/// Mac's sh) misreads a bare ")" inside $(...).
const GIT_AT_WORK: &str = r#"PATH="$PATH:/usr/sbin:/sbin"
top=$(cd "$1" && pwd -P) || exit 2
if [ -r /proc/self/stat ]; then
  for d in /proc/[0-9]*; do
    read -r c 2>/dev/null < "$d/comm" || continue
    case "$c" in (git|git-*) ;; (*) continue ;; esac
    w=$(readlink "$d/cwd" 2>/dev/null) || continue
    case "$w" in ("$top"|"$top"/*) echo "${d#/proc/}"; exit 0 ;; esac
  done
  exit 1
fi
command -v lsof >/dev/null 2>&1 || exit 2
found=$(lsof -a -c git -d cwd -Fpcn 2>/dev/null | while IFS= read -r l; do
  case "$l" in
    (p*) p=${l#p}; c= ;;
    (c*) c=${l#c} ;;
    (n*) case "$c" in (git|git-*) ;; (*) continue ;; esac
      case "${l#n}" in ("$top"|"$top"/*) echo "$p"; break ;; esac ;;
  esac
done)
[ -n "$found" ] && { echo "$found"; exit 0; }
exit 1"#;

static LOCKED_INDEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"index\.lock'?: File exists").expect("regex"));

/// git refused because another process holds, or held, the index lock
pub fn is_locked_index(stderr: &str) -> bool {
    LOCKED_INDEX.is_match(stderr)
}

/// Remove the repo's index.lock when it is older than STALE_LOCK_MIN minutes
/// and no git process is at work in the repo, and say which file went.
/// Refuses when there is none, when it is younger, when git still runs there
/// (a commit waiting on its editor keeps an old lock live) or that cannot be
/// told, and for a seed, whose git belongs to its agents. The path comes
/// from git (`--git-path`), so a submodule's or a worktree's lock is found
/// where git keeps it; `find -mmin` reads its age the same on macOS and
/// Linux, here or over ssh, and removes it in the same call, so a fresh lock
/// that replaced it in between is left alone.
pub async fn clear_stale_lock(repo_path: &str) -> Result<String, GitError> {
    let loc = parse_locator(repo_path);
    let host = loc.host.as_deref();
    if host.is_none() && seeds_root_of(&loc.path, &seed_roots_now()).is_some() {
        return Err(failed(
            "a seed's git is its agents': canopy leaves its lock alone",
        ));
    }
    let r = git(repo_path, &["rev-parse", "--git-path", "index.lock"]).await;
    let rel = js_trim(&r.stdout);
    if r.code != 0 || rel.is_empty() {
        return Err(failed(or(&r.stderr, "git could not say where the lock is")));
    }
    let lock = if rel.starts_with('/') {
        rel.to_string()
    } else {
        format!("{}/{rel}", loc.path.trim_end_matches('/'))
    };
    let none = ExecOptions::default();
    let found = on_host(host, &["find", &lock, "-maxdepth", "0"], &none).await;
    if found.code != 0 || js_trim(&found.stdout).is_empty() {
        return Err(failed("there is no index.lock to clear"));
    }
    let age = format!("+{STALE_LOCK_MIN}");
    let old = on_host(
        host,
        &["find", &lock, "-maxdepth", "0", "-mmin", &age],
        &none,
    )
    .await;
    if js_trim(&old.stdout).is_empty() {
        return Err(failed(format!(
            "the lock is under {STALE_LOCK_MIN} minutes old, so git may still be using it"
        )));
    }
    let top = git(repo_path, &["rev-parse", "--show-toplevel"]).await;
    let top_dir = js_trim(&top.stdout);
    if top.code != 0 || top_dir.is_empty() {
        return Err(failed(or(
            &top.stderr,
            "git could not say where the repo's top is",
        )));
    }
    let busy = on_host(
        host,
        &["sh", "-c", GIT_AT_WORK, "sh", top_dir],
        &ExecOptions {
            timeout_ms: Some(30_000),
            ..Default::default()
        },
    )
    .await;
    if busy.code == 0 {
        return Err(failed(format!(
            "git is still running in this repo (process {}), perhaps a commit waiting on its editor: finish or quit it first",
            js_trim(&busy.stdout).split('\n').next().unwrap_or("")
        )));
    }
    if busy.code != 1 {
        return Err(failed(
            "canopy cannot tell whether a git process still holds the lock here, so it leaves it",
        ));
    }
    let gone = on_host(
        host,
        &[
            "find",
            &lock,
            "-maxdepth",
            "0",
            "-mmin",
            &age,
            "-delete",
            "-print",
        ],
        &none,
    )
    .await;
    if gone.code != 0 {
        return Err(failed(or(&gone.stderr, "could not remove the lock")));
    }
    if js_trim(&gone.stdout).is_empty() {
        return Err(failed(
            "the lock changed while canopy looked at it; try again",
        ));
    }
    Ok(lock)
}

#[cfg(test)]
mod tests;
