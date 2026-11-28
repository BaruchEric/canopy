//! The write half's cases from `src/core/git.test.ts` and every case of
//! `src/core/push-amend.test.ts`, on scratch repos.

use super::*;
use crate::git::{StatusOptions, get_status};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

/// git with these words; panics on a failure, returns stdout trimmed.
fn git_ok(words: &[&str]) -> String {
    let out = Command::new("git").args(words).output().expect("git runs");
    assert!(
        out.status.success(),
        "git {words:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// git -C dir with these words
fn at(dir: &str, words: &[&str]) -> String {
    let mut all = vec!["-C", dir];
    all.extend_from_slice(words);
    git_ok(&all)
}

fn write(path: &str, body: &str) {
    std::fs::write(path, body).expect("write");
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path).expect("read")
}

fn path(root: &TempDir, name: &str) -> String {
    root.path().join(name).to_string_lossy().into_owned()
}

const WHO: [&str; 4] = ["-c", "user.name=t", "-c", "user.email=t@t"];

fn commit_as_t(dir: &str, message: &str) {
    let mut words = WHO.to_vec();
    words.extend(["commit", "-q", "-m", message]);
    at(dir, &words);
}

async fn refusal(r: impl std::future::Future<Output = Result<String, GitError>>) -> String {
    match r.await {
        Ok(out) => panic!("expected a refusal, got {out}"),
        Err(e) => e.message().to_string(),
    }
}

static BEHIND_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\[rejected\].*(fetch first|non-fast-forward)").expect("regex")
});

// ---------- getDiff and getCommit ----------

#[tokio::test]
async fn get_diff_refuses_paths_that_leave_the_repo() {
    for bad in ["/etc/passwd", "../outside.txt", "a/../../outside"] {
        assert!(
            get_diff("/tmp", bad, &DiffTarget::Untracked).await.is_err(),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn get_diff_commit_target_refuses_a_hash_that_is_not_a_hash() {
    let e = get_diff(
        "/tmp",
        "a.ts",
        &DiffTarget::Commit {
            hash: "--output=/tmp/x".into(),
            orig: None,
        },
    )
    .await
    .unwrap_err();
    assert!(e.message().contains("invalid commit hash"), "{e}");
}

#[tokio::test]
async fn get_diff_commit_target_checks_the_rename_source_against_the_repo_too() {
    let e = get_diff(
        "/tmp",
        "a.ts",
        &DiffTarget::Commit {
            hash: "abcdef0".into(),
            orig: Some("../b".into()),
        },
    )
    .await
    .unwrap_err();
    assert!(e.message().contains("escapes"), "{e}");
}

#[tokio::test]
async fn get_commit_reads_one_commit_and_names_a_hash_it_never_saw() {
    let root = TempDir::new().unwrap();
    let dir = path(&root, "r");
    git_ok(&["init", "-q", "-b", "main", &dir]);
    write(&format!("{dir}/old.txt"), "hello\nworld\n");
    at(&dir, &["add", "old.txt"]);
    commit_as_t(&dir, "one");
    at(&dir, &["mv", "old.txt", "new name.txt"]);
    write(&format!("{dir}/pic.bin"), "\0\u{1}\u{2}");
    at(&dir, &["add", "-A"]);
    let mut words = WHO.to_vec();
    words.extend(["commit", "-q", "-m", "two", "-m", "the body\n"]);
    at(&dir, &words);
    let hash = at(&dir, &["rev-parse", "HEAD"]);
    let parent = at(&dir, &["rev-parse", "HEAD~1"]);
    let c = get_commit(&dir, &hash).await.unwrap();
    assert_eq!(c.hash, hash);
    assert_eq!(c.short, at(&dir, &["rev-parse", "--short", "HEAD"]));
    assert_eq!(
        (
            c.subject.as_str(),
            c.body.as_str(),
            c.author.as_str(),
            c.email.as_str()
        ),
        ("two", "the body", "t", "t@t")
    );
    assert!(c.at > 1_700_000_000);
    assert_eq!(c.parents, vec![parent]);
    let files: Vec<(&str, Option<&str>, &str, Option<i64>)> = c
        .files
        .iter()
        .map(|f| {
            (
                f.path.as_str(),
                f.orig.as_deref(),
                f.status.as_str(),
                f.added,
            )
        })
        .collect();
    assert_eq!(
        files,
        vec![
            ("new name.txt", Some("old.txt"), "R", Some(0)),
            ("pic.bin", None, "A", None),
        ]
    );
    let missing = get_commit(&dir, &"0".repeat(40)).await.unwrap_err();
    assert!(matches!(missing, GitError::UnknownCommit(_)), "{missing:?}");
    assert!(get_commit(&dir, "HEAD").await.is_err());
}

// ---------- isAccessDenied ----------

#[test]
fn is_access_denied_recognises_a_remote_refusing_us() {
    let denials = [
        "remote: Permission to ag-ui-protocol/ag-ui.git denied to BaruchEric.\nfatal: unable to access 'https://github.com/ag-ui-protocol/ag-ui/': The requested URL returned error: 403",
        "ERROR: Permission to BuilderIO/agent-native.git denied to BaruchEric.",
        "fatal: Authentication failed for 'https://github.com/x/y.git/'",
        "remote: Repository not found.",
    ];
    for d in denials {
        assert!(is_access_denied(d), "{d}");
    }
}

#[test]
fn is_access_denied_does_not_mistake_a_rejected_ref_for_a_refused_remote() {
    let rejections = [
        " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'origin'",
        "error: remote unpack failed: unable to create temporary object directory\n ! [remote rejected] HEAD -> master (unpacker error)",
        "fatal: The current branch main has no upstream branch.",
        "1403 files changed, 403 insertions(+)",
    ];
    for r in rejections {
        assert!(!is_access_denied(r), "{r}");
    }
}

// ---------- stale index locks ----------

#[test]
fn a_refusal_over_the_lock_reads_in_two_lines_a_timeout_and_a_plain_failure_as_they_are() {
    let refused = "error: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'. Please make sure all processes\nare terminated then try again. If it still fails, a git process\nmay have crashed in this repository earlier:\nremove the file manually to continue.";
    assert_eq!(
        net_error(refused, "pull", 1000).message(),
        "error: Unable to create '/r/.git/index.lock': File exists.\nAnother git process may be running, or one that died left this lock behind; canopy clears one over 10 minutes old."
    );
    assert!(
        net_error("From origin\n * main", "pull", NET_TIMEOUT_MS)
            .message()
            .ends_with("git pull ran past 15 minutes and was stopped.")
    );
    assert_eq!(net_error("", "push", 10).message(), "git push failed");
}

#[test]
fn gits_lock_refusal_reads_as_one() {
    assert!(is_locked_index(
        "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running"
    ));
    assert!(!is_locked_index("fatal: not a git repository"));
}

fn age(file: &str) {
    let f = std::fs::OpenOptions::new()
        .write(true)
        .open(file)
        .expect("open lock");
    f.set_modified(SystemTime::now() - Duration::from_secs(60 * 60))
        .expect("set mtime");
}

#[tokio::test]
async fn an_old_lock_goes_a_fresh_one_stays_and_no_lock_says_so() {
    let root = TempDir::new().unwrap();
    let dir = path(&root, "r");
    git_ok(&["init", "-q", &dir]);
    let lock = format!("{dir}/.git/index.lock");
    write(&lock, "");
    let e = clear_stale_lock(&dir).await.unwrap_err();
    assert!(e.message().contains("minutes old"), "{e}");
    age(&lock);
    assert_eq!(clear_stale_lock(&dir).await.unwrap(), lock);
    assert!(!std::path::Path::new(&lock).exists());
    let e = clear_stale_lock(&dir).await.unwrap_err();
    assert!(e.message().contains("no index.lock"), "{e}");
}

#[tokio::test]
async fn an_old_lock_a_live_git_still_holds_stays() {
    let root = TempDir::new().unwrap();
    let dir = path(&root, "r");
    git_ok(&["init", "-q", &dir]);
    write(&format!("{dir}/f.txt"), "one\n");
    at(&dir, &["add", "f.txt"]);
    commit_as_t(&dir, "one");
    write(&format!("{dir}/f.txt"), "two\n");
    // commit -a holds the lock for as long as its editor stays open
    let mut commit = Command::new("git")
        .args(["-C", &dir])
        .args(WHO)
        .args(["commit", "-a"])
        .env("GIT_EDITOR", "sleep 8;:")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn commit");
    let lock = format!("{dir}/.git/index.lock");
    for _ in 0..100 {
        if std::path::Path::new(&lock).exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    age(&lock);
    let e = clear_stale_lock(&dir).await;
    let _ = commit.kill();
    let _ = commit.wait();
    let e = e.unwrap_err();
    assert!(e.message().contains("git is still running"), "{e}");
}

// ---------- stageFile, commit, pull ----------

#[tokio::test]
async fn a_rename_goes_on_or_off_the_index_as_both_of_its_paths() {
    let root = TempDir::new().unwrap();
    let dir = path(&root, "r");
    git_ok(&["init", "-q", &dir]);
    write(&format!("{dir}/old.txt"), "hello\nworld\n");
    at(&dir, &["add", "old.txt"]);
    commit_as_t(&dir, "one");
    at(&dir, &["mv", "old.txt", "new.txt"]);
    let none = StatusOptions {
        tip_remotes: Some(vec![]),
    };
    let rows = |files: &[crate::types::RepoFile]| -> Vec<(String, String, String, Option<String>)> {
        files
            .iter()
            .map(|f| {
                (
                    f.index.clone(),
                    f.worktree.clone(),
                    f.path.clone(),
                    f.orig.clone(),
                )
            })
            .collect()
    };
    let row = get_status(&dir, &none).await.unwrap().files;
    assert_eq!(
        rows(&row),
        vec![(
            "R".into(),
            ".".into(),
            "new.txt".into(),
            Some("old.txt".into())
        )]
    );
    // unticking the one row takes the whole rename off: nothing is left
    // staged, where unstaging the new path alone kept "D old.txt" staged
    stage_file(&dir, "new.txt", true, Some("old.txt"))
        .await
        .unwrap();
    assert_eq!(at(&dir, &["diff", "--cached", "--name-status"]), "");
    // and ticking it again puts the rename back
    stage_file(&dir, "new.txt", false, Some("old.txt"))
        .await
        .unwrap();
    let again = get_status(&dir, &none).await.unwrap().files;
    assert_eq!(rows(&again), rows(&row));
    let e = stage_file(&dir, "new.txt", true, Some("../outside.txt"))
        .await
        .unwrap_err();
    assert!(e.message().contains("escapes"), "{e}");
}

#[tokio::test]
async fn unstaging_before_the_first_commit_drops_the_file_from_the_index() {
    let root = TempDir::new().unwrap();
    let dir = path(&root, "r");
    git_ok(&["init", "-q", &dir]);
    write(&format!("{dir}/a.txt"), "a\n");
    stage_file(&dir, "a.txt", false, None).await.unwrap();
    assert_eq!(at(&dir, &["diff", "--cached", "--name-only"]), "a.txt");
    stage_file(&dir, "a.txt", true, None).await.unwrap();
    assert_eq!(at(&dir, &["diff", "--cached", "--name-only"]), "");
}

#[tokio::test]
async fn commit_stages_everything_when_asked_and_keeps_gits_words_when_it_fails() {
    let root = TempDir::new().unwrap();
    let dir = path(&root, "r");
    git_ok(&["init", "-q", "-b", "main", &dir]);
    at(&dir, &["config", "user.name", "t"]);
    at(&dir, &["config", "user.email", "t@t"]);
    write(&format!("{dir}/a.txt"), "a\n");
    let e = commit(&dir, "nothing staged", false).await.unwrap_err();
    assert!(e.message().contains("nothing added to commit"), "{e}");
    let out = commit(&dir, "first", true).await.unwrap();
    assert!(out.starts_with("[main (root-commit) "), "{out}");
    assert!(out.contains("] first"), "{out}");
    assert_eq!(at(&dir, &["log", "--format=%s"]), "first");
}

#[tokio::test]
async fn pull_fast_forwards_and_says_why_it_cannot() {
    let root = TempDir::new().unwrap();
    let (origin, a, b) = (
        path(&root, "origin.git"),
        path(&root, "a"),
        path(&root, "b"),
    );
    git_ok(&["init", "-q", "--bare", "--initial-branch=main", &origin]);
    git_ok(&["clone", "-q", &origin, &a]);
    write(&format!("{a}/f.txt"), "one\n");
    at(&a, &["add", "f.txt"]);
    commit_as_t(&a, "one");
    at(&a, &["push", "-q", "origin", "HEAD:main"]);
    git_ok(&["clone", "-q", &origin, &b]);
    write(&format!("{a}/f.txt"), "two\n");
    at(&a, &["add", "f.txt"]);
    commit_as_t(&a, "two");
    at(&a, &["push", "-q", "origin", "HEAD:main"]);
    let out = pull(&b).await.unwrap();
    assert!(out.contains("Fast-forward"), "{out}");
    assert_eq!(read(&format!("{b}/f.txt")), "two\n");
    write(&format!("{b}/.git/index.lock"), "");
    write(&format!("{a}/f.txt"), "three\n");
    at(&a, &["add", "f.txt"]);
    commit_as_t(&a, "three");
    at(&a, &["push", "-q", "origin", "HEAD:main"]);
    let e = pull(&b).await.unwrap_err();
    assert!(
        e.message()
            .ends_with("canopy clears one over 10 minutes old."),
        "{e}"
    );
}

// ---------- push ----------

#[tokio::test]
async fn push_before_any_remote_says_what_is_wrong_with_the_folder_the_head_or_the_repo() {
    let root = TempDir::new().unwrap();
    let dir = path(&root, "work");
    // a folder that is not there, then one that is not a repo, keep git's words
    assert!(
        refusal(push(&path(&root, "missing")))
            .await
            .contains("cannot change to")
    );
    std::fs::create_dir(&dir).unwrap();
    assert!(refusal(push(&dir)).await.contains("not a git repository"));
    // a repo with no commits is on a branch, just one with nothing on it
    git_ok(&["init", "-q", &dir]);
    assert_eq!(refusal(push(&dir)).await, "no remote configured");
    write(&format!("{dir}/f.txt"), "one\n");
    at(&dir, &["add", "f.txt"]);
    commit_as_t(&dir, "one");
    at(&dir, &["checkout", "-q", "--detach"]);
    assert_eq!(
        refusal(push(&dir)).await,
        "detached HEAD — check out a branch first"
    );
}

#[tokio::test]
async fn a_peer_remote_is_fetch_only_and_another_remote_is_adopted_as_upstream() {
    let root = TempDir::new().unwrap();
    let (dir, peer, fork) = (
        path(&root, "work"),
        path(&root, "peer.git"),
        path(&root, "fork.git"),
    );
    git_ok(&["init", "-q", "-b", "main", &dir]);
    write(&format!("{dir}/f.txt"), "one\n");
    at(&dir, &["add", "f.txt"]);
    commit_as_t(&dir, "one");
    git_ok(&["init", "-q", "--bare", "--initial-branch=main", &peer]);
    at(&dir, &["remote", "add", "peer", &peer]);
    at(&dir, &["remote", "set-url", "--push", "peer", NO_PUSH]);
    assert_eq!(
        refusal(push(&dir)).await,
        "no remote to push to: peer remotes are fetch-only"
    );
    git_ok(&["init", "-q", "--bare", "--initial-branch=main", &fork]);
    at(&dir, &["remote", "add", "fork", &fork]);
    let out = push(&dir).await.unwrap();
    assert!(out.starts_with("pushed to fork\n"), "{out}");
    assert_eq!(
        at(&dir, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "fork/main"
    );
}

struct Diverged {
    _root: TempDir,
    work: String,
    fork: String,
}

fn commit_file(cwd: &str, file: &str, contents: &str, message: &str) {
    write(&format!("{cwd}/{file}"), contents);
    at(cwd, &["add", "--", file]);
    commit_as_t(cwd, message);
}

/// A clone `work` with a local commit while origin moved on: a bare
/// origin, a writer that pushed to it, and with `fork` a second remote.
fn diverged(fork: bool) -> Diverged {
    let root = TempDir::new().unwrap();
    let seed = path(&root, "seed");
    let origin = path(&root, "origin.git");
    let work = path(&root, "work");
    let origin_writer = path(&root, "origin-writer");
    let fork_dir = path(&root, "fork.git");
    let fork_writer = path(&root, "fork-writer");

    git_ok(&["init", "-q", "-b", "main", &seed]);
    write(&format!("{seed}/tracked.txt"), "alpha\nbeta\ngamma\n");
    at(&seed, &["add", "tracked.txt"]);
    commit_as_t(&seed, "base");
    git_ok(&["init", "-q", "--bare", "--initial-branch=main", &origin]);
    at(&seed, &["remote", "add", "origin", &origin]);
    at(&seed, &["push", "-q", "-u", "origin", "main"]);
    if fork {
        git_ok(&["init", "-q", "--bare", "--initial-branch=main", &fork_dir]);
        at(&seed, &["remote", "add", "fork", &fork_dir]);
        at(&seed, &["push", "-q", "-u", "fork", "main"]);
    }

    git_ok(&["clone", "-q", &origin, &work]);
    at(&work, &["config", "user.name", "t"]);
    at(&work, &["config", "user.email", "t@t"]);
    git_ok(&["clone", "-q", &origin, &origin_writer]);
    commit_file(
        &origin_writer,
        "origin-only.txt",
        "origin\n",
        "origin change",
    );
    at(&origin_writer, &["push", "-q", "origin", "main"]);

    if fork {
        at(&work, &["remote", "add", "fork", &fork_dir]);
        at(&work, &["fetch", "-q", "fork"]);
        git_ok(&["clone", "-q", &fork_dir, &fork_writer]);
        commit_file(&fork_writer, "fork-only.txt", "fork\n", "fork change");
        at(&fork_writer, &["push", "-q", "origin", "main"]);
    }

    commit_file(&work, "local-only.txt", "local\n", "local change");
    Diverged {
        _root: root,
        work,
        fork: fork_dir,
    }
}

fn refs(work: &str, names: &[&str]) -> Vec<String> {
    names.iter().map(|n| at(work, &["rev-parse", n])).collect()
}

#[tokio::test]
async fn still_rebases_and_pushes_when_the_destination_is_the_tracked_upstream() {
    let d = diverged(false);
    let out = push(&d.work).await.unwrap();
    assert!(out.contains("rebased onto the upstream first"), "{out}");
    assert_eq!(
        at(&d.work, &["rev-parse", "HEAD"]),
        at(&d.work, &["rev-parse", "refs/remotes/origin/main"])
    );
}

#[tokio::test]
async fn refuses_before_fetching_when_staged_and_unstaged_changes_are_mixed() {
    let d = diverged(false);
    let tracked = format!("{}/tracked.txt", d.work);
    write(&tracked, "alpha\nstaged\nbeta\ngamma\n");
    at(&d.work, &["add", "tracked.txt"]);
    write(&tracked, "alpha\nstaged\nbeta\nunstaged\ngamma\n");
    let before = refs(&d.work, &["HEAD", "refs/remotes/origin/main"]);
    let cached = at(&d.work, &["diff", "--cached", "--", "tracked.txt"]);
    let worktree = at(&d.work, &["diff", "--", "tracked.txt"]);
    let index = std::fs::read(format!("{}/.git/index", d.work)).unwrap();
    let message = refusal(push(&d.work)).await;
    assert!(BEHIND_WORDS.is_match(&message), "{message}");
    assert!(
        message.contains("The index has staged changes, so canopy left the rebase to you."),
        "{message}"
    );
    assert_eq!(refs(&d.work, &["HEAD", "refs/remotes/origin/main"]), before);
    assert_eq!(
        std::fs::read(format!("{}/.git/index", d.work)).unwrap(),
        index
    );
    assert_eq!(
        at(&d.work, &["diff", "--cached", "--", "tracked.txt"]),
        cached
    );
    assert_eq!(at(&d.work, &["diff", "--", "tracked.txt"]), worktree);
}

async fn no_rebase_when_set(setting: &str) {
    let d = diverged(true);
    at(&d.work, &["config", setting, "fork"]);
    let names = ["HEAD", "refs/remotes/origin/main", "refs/remotes/fork/main"];
    let before = refs(&d.work, &names);
    let message = refusal(push(&d.work)).await;
    assert!(BEHIND_WORDS.is_match(&message), "{message}");
    assert_eq!(refs(&d.work, &names), before);
}

#[tokio::test]
async fn does_not_rebase_when_branch_push_remote_sends_the_bare_push_away() {
    no_rebase_when_set("branch.main.pushRemote").await;
}

#[tokio::test]
async fn does_not_rebase_when_remote_push_default_sends_the_bare_push_away() {
    no_rebase_when_set("remote.pushDefault").await;
}

async fn no_rebase_with_urls(different_push_url: bool) {
    let d = diverged(true);
    if different_push_url {
        at(&d.work, &["config", "remote.origin.pushurl", &d.fork]);
    } else {
        at(&d.work, &["config", "--add", "remote.origin.url", &d.fork]);
    }
    let names = ["HEAD", "refs/remotes/origin/main"];
    let before = refs(&d.work, &names);
    let message = refusal(push(&d.work)).await;
    assert!(BEHIND_WORDS.is_match(&message), "{message}");
    assert_eq!(refs(&d.work, &names), before);
}

#[tokio::test]
async fn does_not_rebase_an_upstream_remote_with_a_different_push_url() {
    no_rebase_with_urls(true).await;
}

#[tokio::test]
async fn does_not_rebase_an_upstream_remote_with_multiple_urls() {
    no_rebase_with_urls(false).await;
}

#[tokio::test]
async fn does_not_rebase_a_matching_mode_push_that_can_reject_other_branches() {
    let d = diverged(false);
    at(&d.work, &["config", "push.default", "matching"]);
    let names = ["HEAD", "refs/remotes/origin/main"];
    let before = refs(&d.work, &names);
    let message = refusal(push(&d.work)).await;
    assert!(BEHIND_WORDS.is_match(&message), "{message}");
    assert_eq!(refs(&d.work, &names), before);
}

#[tokio::test]
async fn does_not_rebase_a_push_controlled_by_a_configured_refspec() {
    let d = diverged(false);
    at(&d.work, &["checkout", "-q", "-b", "side"]);
    at(
        &d.work,
        &[
            "config",
            "remote.origin.push",
            "refs/heads/side:refs/heads/main",
        ],
    );
    at(&d.work, &["checkout", "-q", "main"]);
    let names = ["HEAD", "refs/remotes/origin/main"];
    let before = refs(&d.work, &names);
    let message = refusal(push(&d.work)).await;
    assert!(BEHIND_WORDS.is_match(&message), "{message}");
    assert_eq!(refs(&d.work, &names), before);
}

// ---------- no login ----------

#[test]
fn is_no_login_is_git_asking_for_a_login_it_has_no_terminal_for() {
    assert!(is_no_login(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    ));
    assert!(is_no_login(
        "fatal: could not read Password for 'https://x@github.com': No such device or address"
    ));
    assert!(!is_no_login("remote: Permission to a/b.git denied to c."));
    assert!(!is_no_login("! [rejected] main -> main (fetch first)"));
}

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn no_login_advice_names_the_empty_gh_token_only_when_gh_is_the_helper() {
    let gh = [
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", "credential.https://github.com.helper"),
        ("GIT_CONFIG_VALUE_0", "!gh auth git-credential"),
    ];
    let with = |more: &[(&str, &str)]| {
        let mut all = gh.to_vec();
        all.extend_from_slice(more);
        no_login_advice(&env(&all))
    };
    assert!(with(&[("GH_TOKEN", "")]).contains("GH_TOKEN is empty"));
    assert!(with(&[]).contains("GH_TOKEN is empty"));
    assert!(with(&[("GH_TOKEN", "x")]).contains("no login for that remote"));
    assert!(with(&[("GITHUB_TOKEN", "x")]).contains("no login for that remote"));
    assert!(no_login_advice(&env(&[])).contains("no login for that remote"));
}

// ---------- push-amend.test.ts: a push rejected over an upstream amend ----------

struct Atlas {
    _root: TempDir,
    mac: String,
    gpd: String,
}

/// The atlas case (FR-048): a bare origin and two clones, `mac` and `gpd`.
/// The Mac commits "fix nav", gpd takes it from the Mac as a peer would
/// (fetched and fast-forwarded, never pushed), then the Mac amends it and
/// pushes the amend. `amend` is f.txt as the amend leaves it.
fn atlas(amend: &str) -> Atlas {
    let root = TempDir::new().unwrap();
    let origin = path(&root, "origin.git");
    let mac = path(&root, "mac");
    let gpd = path(&root, "gpd");
    git_ok(&["init", "-q", "--bare", "-b", "main", &origin]);
    for p in [&mac, &gpd] {
        git_ok(&["init", "-q", "-b", "main", p]);
        at(p, &["config", "user.name", "Test"]);
        at(p, &["config", "user.email", "test@example.invalid"]);
        at(p, &["config", "rerere.enabled", "false"]);
        at(p, &["remote", "add", "origin", &origin]);
    }
    amend_commit(&mac, "f.txt", "a\nb\nc\n", "base");
    at(&mac, &["push", "-qu", "origin", "main"]);
    at(&gpd, &["pull", "-q", "origin", "main"]);
    at(&gpd, &["branch", "-q", "--set-upstream-to", "origin/main"]);
    write(&format!("{mac}/f.txt"), "a\nb\nnew line\nc\n");
    at(&mac, &["commit", "-qam", "fix nav", "-m", "the body"]);
    at(&gpd, &["fetch", "-q", &mac, "main"]);
    at(&gpd, &["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    write(&format!("{mac}/f.txt"), amend);
    at(&mac, &["commit", "-qa", "--amend", "--no-edit"]);
    at(&mac, &["push", "-q"]);
    Atlas {
        _root: root,
        mac,
        gpd,
    }
}

const AMEND: &str = "a\nb\nnew line\nanother\nc\n";
const FAR_BELOW: &str = "a\nb\nnew line\nc\n\n\n\nfar below\n";

fn amend_commit(p: &str, file: &str, body: &str, message: &str) {
    write(&format!("{p}/{file}"), body);
    at(p, &["add", file]);
    at(p, &["commit", "-qm", message]);
}

fn short(h: &str) -> &str {
    &h[..7]
}

async fn push_err(dir: &str) -> GitError {
    match push(dir).await {
        Ok(out) => panic!("expected a refusal, got {out}"),
        Err(e) => e,
    }
}

#[tokio::test]
async fn names_the_amend_leaves_the_branch_and_dropping_the_stale_copy_keeps_the_work_after_it() {
    let a = atlas(AMEND);
    amend_commit(&a.gpd, "g.txt", "mine\n", "gpd work");
    let stale = at(&a.gpd, &["rev-parse", "HEAD~1"]);
    let before = at(&a.gpd, &["rev-parse", "HEAD"]);
    let amend = at(&a.mac, &["rev-parse", "HEAD"]);
    let GitError::StaleCopy { message, offer } = push_err(&a.gpd).await else {
        panic!("not a stale-copy refusal");
    };
    assert_eq!(
        *offer,
        StaleOffer {
            branch: "main".into(),
            upstream: "origin/main".into(),
            onto: amend.clone(),
            copies: vec![StaleCopy {
                stale: stale.clone(),
                copy: amend.clone(),
                subject: "fix nav".into()
            }],
            kept: 1
        }
    );
    assert!(BEHIND_WORDS.is_match(&message), "{message}");
    assert!(message.contains("hit a conflict in f.txt"), "{message}");
    assert!(
        message.contains(&format!(
            "Upstream holds an amended copy of {} fix nav ({}",
            short(&stale),
            short(&amend)
        )),
        "{message}"
    );
    assert_eq!(at(&a.gpd, &["rev-parse", "HEAD"]), before);
    assert_eq!(at(&a.gpd, &["status", "--porcelain"]), "");

    let moved = drop_stale_copies(&a.gpd, &newest_stale(&offer.copies), &offer.onto)
        .await
        .unwrap();
    assert_eq!(moved.kept, 1);
    assert!(
        moved.out.contains(&format!(
            "dropped {} fix nav: upstream holds its amend {}",
            short(&stale),
            short(&amend)
        )),
        "{}",
        moved.out
    );
    assert_eq!(
        at(&a.gpd, &["log", "--format=%s", "HEAD"]),
        "gpd work\nfix nav\nbase"
    );
    assert_eq!(at(&a.gpd, &["rev-parse", "HEAD~1"]), amend);
    assert_eq!(read(&format!("{}/f.txt", a.gpd)), AMEND);
    push(&a.gpd).await.unwrap();
    assert_eq!(
        at(&a.gpd, &["rev-parse", "origin/main"]),
        at(&a.gpd, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn with_nothing_after_the_stale_copy_the_branch_lands_on_the_amend() {
    let a = atlas(AMEND);
    let GitError::StaleCopy { offer, .. } = push_err(&a.gpd).await else {
        panic!("not a stale-copy refusal");
    };
    assert_eq!(offer.kept, 0);
    let moved = drop_stale_copies(&a.gpd, &newest_stale(&offer.copies), &offer.onto)
        .await
        .unwrap();
    assert_eq!(moved.kept, 0);
    assert_eq!(
        at(&a.gpd, &["rev-parse", "HEAD"]),
        at(&a.mac, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn an_amend_that_rewrote_the_commits_own_line_is_not_a_superset_so_nothing_is_offered() {
    let a = atlas("a\nb\nnew line, reworded\nc\n");
    let e = push_err(&a.gpd).await;
    assert!(matches!(e, GitError::Failed(_)), "{e:?}");
    assert!(e.message().contains("hit a conflict in f.txt"), "{e}");
    assert!(e.message().contains("leaves out lines"), "{e}");
}

#[tokio::test]
async fn an_amend_the_plain_rebase_gets_past_still_pushes_on_its_own() {
    let a = atlas(FAR_BELOW);
    amend_commit(&a.gpd, "g.txt", "mine\n", "gpd work");
    let out = push(&a.gpd).await.unwrap();
    assert!(out.contains("rebased onto the upstream first"), "{out}");
    assert_eq!(
        at(&a.gpd, &["log", "--format=%s", "origin/main"]),
        "gpd work\nfix nav\nbase"
    );
}

#[tokio::test]
async fn a_conflict_on_a_later_commit_of_its_own_gets_no_offer() {
    // the plain rebase drops the stale copy and stops on gpd's own commit
    let a = atlas(FAR_BELOW);
    amend_commit(
        &a.gpd,
        "f.txt",
        "a\nb\nnew line\nc\n\n\n\nmine below\n",
        "gpd work",
    );
    let e = push_err(&a.gpd).await;
    assert!(!matches!(e, GitError::StaleCopy { .. }), "{e:?}");
    assert!(e.message().contains("hit a conflict in f.txt"), "{e}");
    assert!(!e.message().contains("amended copy"), "{e}");
}

#[tokio::test]
async fn a_stale_copy_above_a_commit_upstream_lacks_is_refused_with_the_reason() {
    let a = atlas(AMEND);
    // gpd's own commit under its copy of fix nav: picked on top, message
    // and author time kept
    let fix_nav = at(&a.gpd, &["rev-parse", "HEAD"]);
    at(&a.gpd, &["reset", "-q", "--hard", "HEAD~1"]);
    amend_commit(&a.gpd, "g.txt", "mine\n", "gpd work");
    at(&a.gpd, &["cherry-pick", "--allow-empty", &fix_nav]);
    // the facts are read against the upstream as last fetched
    at(&a.gpd, &["fetch", "-q"]);
    let found = stale_copies(&a.gpd).await.unwrap();
    match &found.verdict {
        StaleVerdict::Refuse { why } => {
            assert!(why.contains("sits on 1 commit of your own"), "{why}")
        }
        v => panic!("not a refusal: {v:?}"),
    }
    let e = drop_stale_copies(
        &a.gpd,
        &at(&a.gpd, &["rev-parse", "HEAD"]),
        &at(&a.mac, &["rev-parse", "HEAD"]),
    )
    .await
    .unwrap_err();
    assert!(matches!(e, GitError::DropRefused(_)), "{e:?}");
}

#[tokio::test]
async fn a_dirty_tree_a_branch_that_moved_and_a_conflict_while_replaying_each_leave_the_branch() {
    let a = atlas(AMEND);
    // gpd's own edit of the line the amend added next to: replaying it onto
    // the amend conflicts
    amend_commit(
        &a.gpd,
        "f.txt",
        "a\nb\nnew line, edited here\nc\n",
        "gpd edit",
    );
    let GitError::StaleCopy { offer, .. } = push_err(&a.gpd).await else {
        panic!("not a stale-copy refusal");
    };
    let stale = newest_stale(&offer.copies);
    let before = at(&a.gpd, &["rev-parse", "HEAD"]);

    write(&format!("{}/f.txt", a.gpd), "uncommitted\n");
    let e = drop_stale_copies(&a.gpd, &stale, &offer.onto)
        .await
        .unwrap_err();
    assert!(e.message().contains("uncommitted changes to f.txt"), "{e}");
    at(&a.gpd, &["checkout", "--", "f.txt"]);

    let e = drop_stale_copies(&a.gpd, &stale, &before)
        .await
        .unwrap_err();
    assert!(e.message().contains("moved since canopy looked"), "{e}");

    let stopped = drop_stale_copies(&a.gpd, &stale, &offer.onto)
        .await
        .unwrap_err();
    assert!(matches!(stopped, GitError::DropRefused(_)), "{stopped:?}");
    let replaying =
        Regex::new(r"hit a conflict in f\.txt \(replaying [0-9a-f]{7} gpd edit\)").unwrap();
    assert!(replaying.is_match(stopped.message()), "{stopped}");
    assert_eq!(at(&a.gpd, &["rev-parse", "HEAD"]), before);
    assert_eq!(at(&a.gpd, &["status", "--porcelain"]), "");
    assert_eq!(
        at(&a.gpd, &["rev-parse", "origin/main"]),
        at(&a.mac, &["rev-parse", "HEAD"])
    );
}
