//! Seeds are written by agents, `.git` included, and canopy runs git in
//! them. A config key like core.fsmonitor, a filter driver, an include or an
//! ext:: url turns that git call into a program the agent chose, run as
//! canopy. So every git call canopy makes in a seed is refused unless the
//! `.git` git would use holds only keys canopy and plain commits write, and
//! carries flags and a ceiling that turn the rest off. (`src/core/seedgit.ts`)

use regex::Regex;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

/// laid on every git call canopy makes in a seed
pub const SEED_GIT_FLAGS: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.ext.allow=never",
    // a committed gitlink with a `.git` folder beside it would run that
    // folder's config on status
    "-c",
    "diff.ignoreSubmodules=all",
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.recurseSubmodules=false",
    // a .git git cannot use sends it on to the folder itself as a bare repo
    "-c",
    "safe.bareRepository=explicit",
];

static ALLOWED: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$",
        // a project's install sets it; SEED_GIT_FLAGS lays /dev/null over it on every call
        r"^core\.hookspath$",
        // a subsection keeps its dots (branch.release-1.2.merge), so `.+`
        r"^remote\..+\.(url|fetch|pushurl|tagopt|prune)$",
        r"^branch\..+\.(remote|merge|rebase|pushremote|description|vscode-merge-base)$",
        r"^user\.(name|email)$",
        r"^extensions\.objectformat$",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

static URL_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(url|pushurl)$").unwrap());

/// a url git would hand to a transport helper or read as a flag
fn bad_url(v: &str) -> bool {
    v.contains("::") || v.trim_start().starts_with('-')
}

/// what is wrong with a seed's config, from `git config --list --null`'s
/// pairs, or None when every key is one canopy expects
pub fn seed_config_refusal(entries: &[(String, String)]) -> Option<String> {
    for (raw, value) in entries {
        let key = raw.to_lowercase();
        if !ALLOWED.iter().any(|re| re.is_match(&key)) {
            return Some(format!(
                "its .git/config sets {key}; if you set it yourself, git config --unset-all {key} lets canopy back in"
            ));
        }
        if URL_KEY.is_match(&key) && bad_url(value) {
            return Some(format!(
                "its .git/config sets {key} to a command, not an address"
            ));
        }
    }
    None
}

fn with_sep(r: &str) -> String {
    if r.ends_with('/') {
        r.to_string()
    } else {
        format!("{r}/")
    }
}

/// whether `path` is inside one of the seeds dirs, not the dir itself
pub fn under_seeds(path: &str, roots: &[String]) -> bool {
    !path.contains("://") && roots.iter().any(|r| path.starts_with(&with_sep(r)))
}

/// the seeds dir `path` is, or None
pub fn seeds_dir_of(path: &str, roots: &[String]) -> Option<String> {
    if path.contains("://") {
        return None;
    }
    let bare = |p: &str| {
        if p.len() > 1 && p.ends_with('/') {
            p[..p.len() - 1].to_string()
        } else {
            p.to_string()
        }
    };
    roots.iter().find(|r| bare(r) == bare(path)).cloned()
}

/// the seeds dir `path` sits under, or None
pub fn seeds_root_of(path: &str, roots: &[String]) -> Option<String> {
    if path.contains("://") {
        return None;
    }
    roots
        .iter()
        .find(|r| path.starts_with(&with_sep(r)))
        .cloned()
}

/// the seed `path` sits in: the first folder under its seeds dir, or None
pub fn seed_top_of(path: &str, roots: &[String]) -> Option<String> {
    let root = seeds_root_of(path, roots)?;
    let base = with_sep(&root);
    let first = path[base.len()..].split('/').next().unwrap_or("");
    if first.is_empty() {
        None
    } else {
        Some(format!("{base}{first}"))
    }
}

static SEED_ROOTS: RwLock<Vec<String>> = RwLock::new(Vec::new());

/// the seeds dirs, set once by the server; tests set their own
pub fn set_seed_roots(roots: &[String]) {
    if let Ok(mut r) = SEED_ROOTS.write() {
        *r = roots.to_vec();
    }
    if let Ok(mut m) = MEMO.lock() {
        m.clear();
    }
}

pub fn seed_roots_now() -> Vec<String> {
    SEED_ROOTS.read().map(|r| r.clone()).unwrap_or_default()
}

/// what git() answers in a seed while it is busy
pub const SEED_BUSY: &str = "canopy waits for the stage running in this seed";

/// what git() answers in a seed on an isolated backend while the stage
/// runner, which runs every git call there, is away or unfenced
pub const SEED_AWAY: &str =
    "canopy reads this seed through the stage runner, which cannot run it now";

/// whether a git error is a seed held for now, which a reader waits out
pub fn seed_held(text: Option<&str>) -> bool {
    text.is_some_and(|t| t.contains(SEED_BUSY) || t.contains(SEED_AWAY))
}

type BusyHook = Arc<dyn Fn(&str) -> bool + Send + Sync>;
static BUSY: RwLock<Option<BusyHook>> = RwLock::new(None);

/// set once by the server: a seed with a stage process alive in it
pub fn set_seed_busy(busy: Option<BusyHook>) {
    if let Ok(mut b) = BUSY.write() {
        *b = busy;
    }
}

pub fn seed_busy(path: &str) -> bool {
    BUSY.read()
        .ok()
        .and_then(|b| b.as_ref().map(|f| f(path)))
        .unwrap_or(false)
}

/// what makes a seed busy, as the server knows it
pub struct SeedStages<'a> {
    /// canopy's seed git runs in the stages container
    pub isolated: bool,
    /// the seeds with a check running, by the seed's own path
    pub checks: &'a HashMap<String, usize>,
    pub alive_in: &'a dyn Fn(&str) -> bool,
    pub alive_any: &'a dyn Fn() -> bool,
}

/// Whether canopy holds off its git at `path`. Isolated, only the seed's
/// own stages hold it; unisolated, any stage alive anywhere holds every seed.
pub fn seed_busy_for(path: &str, roots: &[String], s: &SeedStages<'_>) -> bool {
    let Some(top) = seed_top_of(path, roots) else {
        return false;
    };
    if !s.isolated {
        return !s.checks.is_empty() || (s.alive_any)();
    }
    s.checks.contains_key(&top) || (s.alive_in)(&top)
}

/// how long canopy's own write to a seed waits for the stages to go quiet
pub const SEED_QUIET_MAX: Duration = Duration::from_secs(2 * 60 * 60);

/// Settles once `seed_busy(path)` is false, or fails after `max`.
pub async fn when_seeds_quiet(path: &str, max: Duration, poll: Duration) -> Result<(), String> {
    let deadline = Instant::now() + max;
    while seed_busy(path) {
        if Instant::now() >= deadline {
            return Err(format!(
                "{SEED_BUSY}: the seeds were still busy after {} min",
                (max.as_secs_f64() / 60.0).round()
            ));
        }
        tokio::time::sleep(
            poll.min(
                deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1)),
            ),
        )
        .await;
    }
    Ok(())
}

/// keyed on ctime too: `touch -r` puts an mtime back, nothing puts a ctime back
#[derive(Clone, PartialEq)]
struct Stamp {
    ctime: (i64, i64),
    mtime: (i64, i64),
    ino: u64,
    size: u64,
}

/// a folder's config verdict, kept while its stamp holds
type Memo = HashMap<String, (Stamp, Option<String>)>;
static MEMO: LazyLock<Mutex<Memo>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `--list --null` output as key/value pairs: `key\nvalue\0`
fn parse_list(out: &str) -> Vec<(String, String)> {
    out.split('\0')
        .filter(|r| !r.is_empty())
        .map(|rec| match rec.find('\n') {
            None => (rec.to_string(), String::new()),
            Some(i) => (rec[..i].to_string(), rec[i + 1..].to_string()),
        })
        .collect()
}

fn lstat(p: &str) -> Option<std::fs::Metadata> {
    std::fs::symlink_metadata(p).ok()
}

/// the `.git` git would use from `path`: the first one walking up to the
/// seed's top folder, which the ceiling keeps git from walking past
fn dot_git_for(path: &str, root: &str) -> Option<String> {
    let mut dir = path.to_string();
    loop {
        let candidate = crate::pathx::join(&dir, ".git");
        if lstat(&candidate).is_some() {
            return Some(candidate);
        }
        let up = crate::pathx::dirname(&dir);
        if up == dir || up == root || !up.starts_with(&format!("{root}/")) {
            return None;
        }
        dir = up;
    }
}

/// None when canopy may run git at `path`, else why not. A path outside
/// every seeds dir is always None.
pub async fn guard_seed(path: &str) -> Option<String> {
    let roots = seed_roots_now();
    let root = seeds_root_of(path, &roots)?;
    let root = root.strip_suffix('/').unwrap_or(&root).to_string();
    // not a repo yet: the ceiling stops git at the seeds dir
    let dot_git = dot_git_for(path, &root)?;
    let st = lstat(&dot_git)?;
    if st.file_type().is_symlink() {
        return Some("its .git is a symlink".into());
    }
    if !st.is_dir() {
        return Some("its .git is a gitfile pointing elsewhere".into());
    }
    // git passes over a .git with no HEAD and walks on, to a .git this guard never judged
    if !lstat(&format!("{dot_git}/HEAD")).is_some_and(|m| m.is_file()) {
        return Some("its .git is not a whole repository (no HEAD)".into());
    }
    if lstat(&format!("{dot_git}/commondir")).is_some() {
        return Some("its .git has a commondir, which points git at another config".into());
    }
    if lstat(&format!("{dot_git}/config.worktree")).is_some() {
        return Some("its .git has a config.worktree".into());
    }
    let file = format!("{dot_git}/config");
    let fst = lstat(&file)?;
    if fst.file_type().is_symlink() {
        return Some("its .git/config is a symlink".into());
    }
    let stamp = Stamp {
        ctime: (fst.ctime(), fst.ctime_nsec()),
        mtime: (fst.mtime(), fst.mtime_nsec()),
        ino: fst.ino(),
        size: fst.size(),
    };
    if let Some((seen, refusal)) = MEMO.lock().ok().and_then(|m| m.get(&file).cloned())
        && seen == stamp
    {
        return refusal;
    }
    // straight to the process, not through exec's git(), which calls this guard
    let out = tokio::process::Command::new("git")
        .args([
            "config",
            "--file",
            &file,
            "--no-includes",
            "--list",
            "--null",
        ])
        .env_clear()
        .env(
            "PATH",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("HOME", "/nonexistent")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await;
    let refusal = match out {
        Ok(o) if o.status.success() => {
            seed_config_refusal(&parse_list(&String::from_utf8_lossy(&o.stdout)))
        }
        _ => Some("its .git/config does not parse".into()),
    };
    if let Ok(mut m) = MEMO.lock() {
        m.insert(file, (stamp, refusal.clone()));
    }
    refusal
}

/// why canopy will not run git at `path` (the seeds dir itself, or a seed
/// the guard refuses), or None; a path outside every seeds dir is None
pub async fn seed_git_refusal(path: &str) -> Option<String> {
    if seeds_dir_of(path, &seed_roots_now()).is_some() {
        return Some(
            "canopy runs no git in the seeds folder itself; the seeds folder is never a repo"
                .into(),
        );
    }
    guard_seed(path)
        .await
        .map(|r| format!("canopy will not run git in this seed: {r}"))
}

#[cfg(test)]
pub(crate) static SEED_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{ExecOptions, ExecResult, SeedGitHook, exec, git, git_with, set_seed_git};
    use std::future::Future;
    use std::pin::Pin;

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn ok() -> Vec<(String, String)> {
        kv(&[
            ("core.repositoryformatversion", "0"),
            ("core.filemode", "true"),
            ("core.bare", "false"),
            ("core.logallrefupdates", "true"),
            ("remote.upstream.url", "https://github.com/a/b.git"),
            (
                "remote.upstream.fetch",
                "+refs/heads/*:refs/remotes/upstream/*",
            ),
            ("remote.mini.pushurl", "canopy-peer-no-push"),
            ("remote.mini.tagopt", "--no-tags"),
            ("branch.main.remote", "upstream"),
            ("branch.main.merge", "refs/heads/main"),
            ("branch.release-1.2.merge", "refs/heads/release-1.2"),
            ("branch.main.vscode-merge-base", "origin/main"),
            ("remote.mini.prune", "true"),
            ("user.name", "canopy"),
            ("user.email", "canopy@mini"),
            ("extensions.objectformat", "sha1"),
            ("core.hookspath", ".githooks"),
        ])
    }

    #[test]
    fn what_canopy_and_a_plain_commit_write_passes() {
        assert_eq!(seed_config_refusal(&ok()), None);
    }

    #[test]
    fn dangerous_keys_refuse_named() {
        for (key, value) in [
            ("core.fsmonitor", "./x"),
            ("core.sshcommand", "sh -c x"),
            ("core.pager", "sh"),
            ("filter.lfs.clean", "sh -c x"),
            ("diff.x.textconv", "sh"),
            ("include.path", "/tmp/evil"),
            ("includeif.gitdir:/.path", "/tmp/evil"),
            ("remote.upstream.uploadpack", "sh"),
            ("url.ext::sh.insteadof", "https://"),
            ("extensions.worktreeconfig", "true"),
            ("alias.st", "!sh"),
        ] {
            let mut e = ok();
            e.push((key.into(), value.into()));
            assert!(seed_config_refusal(&e).unwrap().contains(key), "{key}");
        }
    }

    #[test]
    fn urls_that_are_commands_or_flags_refuse() {
        assert!(
            seed_config_refusal(&kv(&[("remote.x.url", "ext::sh -c id")]))
                .unwrap()
                .contains("remote.x.url")
        );
        assert!(
            seed_config_refusal(&kv(&[("remote.x.url", "-oProxyCommand=id")]))
                .unwrap()
                .contains("remote.x.url")
        );
        assert!(
            seed_config_refusal(&kv(&[("remote.x.pushurl", "fd::3")]))
                .unwrap()
                .contains("remote.x.pushurl")
        );
    }

    #[test]
    fn keys_compare_lowercased_and_name_the_undo() {
        assert!(
            seed_config_refusal(&kv(&[("Core.FsMonitor", "x")]))
                .unwrap()
                .contains("core.fsmonitor")
        );
        assert!(
            seed_config_refusal(&kv(&[("core.pager", "less")]))
                .unwrap()
                .contains("git config --unset-all core.pager")
        );
        assert!(
            seed_config_refusal(&kv(&[("branch.a.b.uploadpack", "sh")]))
                .unwrap()
                .contains("branch.a.b.uploadpack")
        );
        assert!(
            seed_config_refusal(&kv(&[("remote.x.y.receivepack", "sh")]))
                .unwrap()
                .contains("remote.x.y.receivepack")
        );
    }

    #[test]
    fn under_seeds_and_seed_top() {
        let r = vec!["/w/_incubator".to_string()];
        assert!(under_seeds("/w/_incubator/coin", &r));
        assert!(under_seeds("/w/_incubator/coin/sub", &r));
        assert!(!under_seeds("/w/_incubator", &r));
        assert!(!under_seeds("/w/_incubatorx/coin", &r));
        assert!(!under_seeds("ssh://mini/w/_incubator/coin", &r));
        assert_eq!(
            seed_top_of("/w/_incubator/coin", &r).as_deref(),
            Some("/w/_incubator/coin")
        );
        assert_eq!(
            seed_top_of("/w/_incubator/coin/src/lib", &r).as_deref(),
            Some("/w/_incubator/coin")
        );
        assert_eq!(seed_top_of("/w/_incubator", &r), None);
        assert_eq!(seed_top_of("/w/other/coin", &r), None);
    }

    #[test]
    fn seed_busy_for_isolated_and_not() {
        let roots = vec!["/r/_incubator".to_string()];
        let alive = ["/r/_incubator/beta".to_string()];
        let checks: HashMap<String, usize> = [("/r/_incubator/gamma".to_string(), 1)].into();
        let none: HashMap<String, usize> = HashMap::new();
        let alive_in = |s: &str| alive.iter().any(|a| a == s);
        let alive_any = || true;
        let dead_any = || false;
        let w = SeedStages {
            isolated: true,
            checks: &checks,
            alive_in: &alive_in,
            alive_any: &alive_any,
        };
        assert!(seed_busy_for("/r/_incubator/beta", &roots, &w));
        assert!(seed_busy_for("/r/_incubator/beta/src", &roots, &w));
        assert!(seed_busy_for("/r/_incubator/gamma", &roots, &w));
        assert!(!seed_busy_for("/r/_incubator/alpha", &roots, &w));
        let u = SeedStages {
            isolated: false,
            checks: &none,
            alive_in: &alive_in,
            alive_any: &alive_any,
        };
        assert!(seed_busy_for("/r/_incubator/alpha", &roots, &u));
        let c = SeedStages {
            isolated: false,
            checks: &checks,
            alive_in: &alive_in,
            alive_any: &dead_any,
        };
        assert!(seed_busy_for("/r/_incubator/alpha", &roots, &c));
        let q = SeedStages {
            isolated: false,
            checks: &none,
            alive_in: &alive_in,
            alive_any: &dead_any,
        };
        assert!(!seed_busy_for("/r/_incubator/alpha", &roots, &q));
        assert!(!seed_busy_for("/r/app", &roots, &u));
        assert!(seed_held(Some(SEED_BUSY)));
        assert!(seed_held(Some(&format!(
            "{SEED_AWAY}: the stage runner is not answering"
        ))));
        assert!(!seed_held(Some("fatal: not a git repository")));
        assert!(!seed_held(None));
    }

    // ---- the guard on real seeds ----

    struct World {
        _tmp: tempfile::TempDir,
        root: String,
        seeds: String,
    }

    impl World {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let root = std::fs::canonicalize(tmp.path())
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let seeds = format!("{root}/_incubator");
            std::fs::create_dir_all(&seeds).unwrap();
            set_seed_roots(std::slice::from_ref(&seeds));
            Self {
                _tmp: tmp,
                root,
                seeds,
            }
        }
        fn marker(&self) -> String {
            format!("{}/ran", self.root)
        }
        fn ran(&self) -> bool {
            let was = std::path::Path::new(&self.marker()).exists();
            let _ = std::fs::remove_file(self.marker());
            was
        }
        fn filter(&self) -> String {
            format!("sh -c 'touch {}; cat'", self.marker())
        }
        async fn seed(&self, name: &str) -> String {
            let dir = format!("{}/{name}", self.seeds);
            std::fs::create_dir_all(&dir).unwrap();
            assert_eq!(
                run(&["git", "init", "-q", "-b", "main"], &dir).await.code,
                0
            );
            std::fs::write(format!("{dir}/a.txt"), "a\n").unwrap();
            dir
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            set_seed_roots(&[]);
        }
    }

    async fn run(argv: &[&str], cwd: &str) -> ExecResult {
        exec(
            argv,
            &ExecOptions {
                cwd: Some(cwd.into()),
                ..Default::default()
            },
        )
        .await
    }

    async fn commit(dir: &str) {
        assert_eq!(
            run(
                &[
                    "git",
                    "-c",
                    "user.name=a",
                    "-c",
                    "user.email=a@b",
                    "add",
                    "."
                ],
                dir
            )
            .await
            .code,
            0
        );
        assert_eq!(
            run(
                &[
                    "git",
                    "-c",
                    "user.name=a",
                    "-c",
                    "user.email=a@b",
                    "commit",
                    "-qm",
                    "s"
                ],
                dir
            )
            .await
            .code,
            0
        );
    }

    fn append(file: &str, text: &str) {
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(file)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }

    #[tokio::test]
    async fn the_guard_on_real_seeds() {
        let _lock = SEED_TEST_LOCK.lock().await;
        let w = World::new();

        // a clean seed reads as before
        let dir = w.seed("clean").await;
        assert_eq!(guard_seed(&dir).await, None);
        let r = git(&dir, &["status", "--porcelain=v2"]).await;
        assert_eq!(r.code, 0);
        assert!(r.stdout.contains("a.txt"));

        // an fsmonitor the agent wrote never runs, and the reason names it
        let dir = w.seed("fsmon").await;
        let mon = format!("{}/mon.sh", w.root);
        std::fs::write(&mon, format!("#!/bin/sh\ntouch {}\n", w.marker())).unwrap();
        run(&["chmod", "755", &mon], &w.root).await;
        append(
            &format!("{dir}/.git/config"),
            &format!("[core]\n\tfsmonitor = {mon}\n"),
        );
        let r = git(&dir, &["status", "--porcelain=v2"]).await;
        assert_eq!(r.code, 128);
        assert!(r.stderr.contains("core.fsmonitor"));
        assert!(!w.ran());

        // a hooks path the project's install set is let through, and its hooks never run
        let dir = w.seed("hookspath").await;
        std::fs::create_dir_all(format!("{dir}/.githooks")).unwrap();
        for h in [
            format!("{dir}/.githooks/pre-commit"),
            format!("{dir}/.githooks/post-commit"),
            format!("{dir}/.git/hooks/post-commit"),
        ] {
            std::fs::write(&h, format!("#!/bin/sh\ntouch {}\n", w.marker())).unwrap();
            run(&["chmod", "755", &h], &dir).await;
        }
        assert_eq!(
            run(&["git", "config", "core.hooksPath", ".githooks"], &dir)
                .await
                .code,
            0
        );
        assert_eq!(guard_seed(&dir).await, None);
        assert_eq!(git(&dir, &["add", "a.txt"]).await.code, 0);
        assert_eq!(
            git(
                &dir,
                &[
                    "-c",
                    "user.name=a",
                    "-c",
                    "user.email=a@b",
                    "commit",
                    "-qm",
                    "s"
                ]
            )
            .await
            .code,
            0
        );
        assert!(!w.ran());

        // an include is refused without being followed
        let dir = w.seed("incl").await;
        let evil = format!("{}/evil.cfg", w.root);
        std::fs::write(&evil, format!("[core]\n\tfsmonitor = {mon}\n")).unwrap();
        append(
            &format!("{dir}/.git/config"),
            &format!("[include]\n\tpath = {evil}\n"),
        );
        assert!(guard_seed(&dir).await.unwrap().contains("include.path"));

        // a key added after a clean read is caught on the next call
        let dir = w.seed("later").await;
        assert_eq!(guard_seed(&dir).await, None);
        tokio::time::sleep(Duration::from_millis(5)).await;
        append(
            &format!("{dir}/.git/config"),
            "[filter \"x\"]\n\tclean = sh\n",
        );
        assert!(guard_seed(&dir).await.unwrap().contains("filter.x.clean"));

        // a same-size swap with the old mtime put back is still caught
        let dir = w.seed("forged").await;
        let file = format!("{dir}/.git/config");
        append(&file, "[user]\n\tname = abcdefgh\n");
        run(&["touch", "-t", "202601010000", &file], &dir).await;
        assert_eq!(guard_seed(&dir).await, None);
        let text = std::fs::read_to_string(&file).unwrap();
        let swapped = text.replace("[user]\n\tname = abcdefgh\n", "[alias]\n\tzz = !sh -c xy\n");
        assert_eq!(swapped.len(), text.len());
        tokio::time::sleep(Duration::from_millis(20)).await;
        std::fs::write(&file, swapped).unwrap();
        run(&["touch", "-t", "202601010000", &file], &dir).await;
        assert!(guard_seed(&dir).await.unwrap().contains("alias.zz"));

        // a gitfile .git refuses
        let dir = format!("{}/gitfile", w.seeds);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/.git"), "gitdir: /tmp/elsewhere\n").unwrap();
        assert!(guard_seed(&dir).await.unwrap().contains("gitfile"));

        // a symlinked .git refuses
        let real = w.seed("linktarget-not-a-seed").await;
        let dir = format!("{}/linked", w.seeds);
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(format!("{real}/.git"), format!("{dir}/.git")).unwrap();
        assert!(guard_seed(&dir).await.unwrap().contains("symlink"));

        // a commondir that points git at another config refuses, and its filter never runs
        let dir = w.seed("common").await;
        std::fs::write(format!("{dir}/.gitattributes"), "* filter=x\n").unwrap();
        commit(&dir).await;
        let evil_common = format!("{}/evil-common", w.root);
        assert_eq!(
            run(&["cp", "-R", &format!("{dir}/.git"), &evil_common], &w.root)
                .await
                .code,
            0
        );
        append(
            &format!("{evil_common}/config"),
            &format!("[filter \"x\"]\n\tclean = {}\n", w.filter()),
        );
        std::fs::write(format!("{dir}/.git/commondir"), format!("{evil_common}\n")).unwrap();
        append(&format!("{dir}/a.txt"), "more\n");
        assert!(guard_seed(&dir).await.unwrap().contains("commondir"));
        assert_eq!(git(&dir, &["status", "--porcelain=v2"]).await.code, 128);
        assert!(!w.ran());

        // a config.worktree refuses
        let dir = w.seed("wtconfig").await;
        std::fs::write(
            format!("{dir}/.git/config.worktree"),
            "[core]\n\tpager = sh\n",
        )
        .unwrap();
        assert!(guard_seed(&dir).await.unwrap().contains("config.worktree"));

        // a committed gitlink's own .git folder never runs its filter
        let dir = w.seed("gitlink").await;
        let sub = format!("{dir}/sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(run(&["git", "init", "-q"], &sub).await.code, 0);
        std::fs::write(format!("{sub}/.gitattributes"), "* filter=x\n").unwrap();
        std::fs::write(format!("{sub}/f"), "hi\n").unwrap();
        commit(&sub).await;
        commit(&dir).await;
        assert_eq!(
            run(&["git", "config", "filter.x.clean", &w.filter()], &sub)
                .await
                .code,
            0
        );
        append(&format!("{sub}/f"), "more\n");
        assert_eq!(guard_seed(&dir).await, None);
        assert_eq!(git(&dir, &["status", "--porcelain=v2"]).await.code, 0);
        assert!(!w.ran());

        // a folder under a seed is judged by its seed's .git
        let dir = w.seed("deep").await;
        std::fs::create_dir_all(format!("{dir}/src/lib")).unwrap();
        append(&format!("{dir}/.git/config"), "[core]\n\tpager = sh\n");
        assert!(
            guard_seed(&format!("{dir}/src/lib"))
                .await
                .unwrap()
                .contains("core.pager")
        );

        // a .git that is not a whole repo refuses, so it cannot hide the seed's own
        let dir = w.seed("hollow").await;
        append(&format!("{dir}/.git/config"), "[core]\n\tpager = sh\n");
        std::fs::create_dir_all(format!("{dir}/src/.git")).unwrap();
        assert!(
            guard_seed(&format!("{dir}/src"))
                .await
                .unwrap()
                .contains("not a whole repository")
        );

        // canopy runs no git in the seeds dir itself
        let r = git(&w.seeds, &["status"]).await;
        assert_eq!(r.code, 128);
        assert!(r.stderr.contains("seeds folder"));

        // while a stage process is alive in a seed, canopy runs no git there
        let dir = w.seed("busy").await;
        let busy_dir = dir.clone();
        set_seed_busy(Some(Arc::new(move |p: &str| p == busy_dir)));
        let r = git(&dir, &["status"]).await;
        assert_eq!(r.code, 128);
        assert!(r.stderr.contains("waits for the stage"));
        set_seed_busy(None);
        assert_eq!(git(&dir, &["status"]).await.code, 0);

        // a repo outside the seeds dir is not read by the guard
        let dir = format!("{}/plain", w.root);
        std::fs::create_dir_all(&dir).unwrap();
        run(&["git", "init", "-q"], &dir).await;
        append(&format!("{dir}/.git/config"), "[alias]\n\tst = status\n");
        assert_eq!(guard_seed(&dir).await, None);
        assert_eq!(git(&dir, &["status"]).await.code, 0);
    }

    #[tokio::test]
    async fn git_never_walks_up_into_a_git_the_agent_wrote_in_the_seeds_dir() {
        let _lock = SEED_TEST_LOCK.lock().await;
        let w = World::new();
        let inner = format!("{}/walk/_incubator", w.root);
        std::fs::create_dir_all(format!("{inner}/coin")).unwrap();
        set_seed_roots(std::slice::from_ref(&inner));
        assert_eq!(run(&["git", "init", "-q"], &inner).await.code, 0);
        std::fs::write(format!("{inner}/.gitattributes"), "* filter=x\n").unwrap();
        std::fs::write(format!("{inner}/coin/f"), "hi\n").unwrap();
        commit(&inner).await;
        assert_eq!(
            run(&["git", "config", "filter.x.clean", &w.filter()], &inner)
                .await
                .code,
            0
        );
        let _ = std::fs::remove_file(w.marker());
        append(&format!("{inner}/coin/f"), "more\n");
        let r = git(&format!("{inner}/coin"), &["status", "--porcelain=v2"]).await;
        assert_ne!(r.code, 0);
        assert!(!w.ran());
        // a new seed still inits under the ceiling
        std::fs::create_dir_all(format!("{inner}/fresh")).unwrap();
        assert_eq!(
            git(&format!("{inner}/fresh"), &["init", "-q", "-b", "main"])
                .await
                .code,
            0
        );
        assert!(std::path::Path::new(&format!("{inner}/fresh/.git/HEAD")).exists());
    }

    #[tokio::test]
    async fn bare_layouts_never_run_their_filter() {
        let _lock = SEED_TEST_LOCK.lock().await;
        let w = World::new();
        for (name, empty_dot_git) in [("bare", true), ("barefaced", false)] {
            let dir = format!("{}/{name}", w.seeds);
            std::fs::create_dir_all(&dir).unwrap();
            assert_eq!(
                run(&["git", "init", "-q", "--bare", "."], &dir).await.code,
                0
            );
            if empty_dot_git {
                std::fs::create_dir_all(format!("{dir}/.git")).unwrap();
            }
            let cfg = format!("{dir}/config");
            let filter = w.filter();
            for (k, v) in [
                ("core.bare", "false"),
                ("core.worktree", dir.as_str()),
                ("filter.x.clean", filter.as_str()),
            ] {
                assert_eq!(
                    run(&["git", "config", "--file", &cfg, k, v], &dir)
                        .await
                        .code,
                    0
                );
            }
            std::fs::write(format!("{dir}/.gitattributes"), "* filter=x\n").unwrap();
            std::fs::write(format!("{dir}/f"), "hi\n").unwrap();
            let opts = ExecOptions {
                env: vec![("GIT_CEILING_DIRECTORIES".into(), w.seeds.clone())],
                ..Default::default()
            };
            assert_eq!(
                exec(&["git", "-C", &dir, "add", "f", ".gitattributes"], &opts)
                    .await
                    .code,
                0
            );
            let _ = std::fs::remove_file(w.marker());
            append(&format!("{dir}/f"), "more\n");
            git(&dir, &["status", "--porcelain=v2"]).await;
            assert!(!w.ran(), "{name}");
        }
    }

    type Calls = Vec<(String, Vec<String>, Vec<(String, String)>)>;
    struct Recorder(Arc<Mutex<Calls>>);

    impl SeedGitHook for Recorder {
        fn run(
            &self,
            path: String,
            args: Vec<String>,
            _timeout_ms: u64,
            env: Vec<(String, String)>,
        ) -> Pin<Box<dyn Future<Output = ExecResult> + Send>> {
            self.0.lock().unwrap().push((path, args, env));
            Box::pin(async {
                ExecResult {
                    code: 0,
                    stdout: "from the runner\n".into(),
                    stderr: String::new(),
                }
            })
        }
    }

    #[tokio::test]
    async fn a_seed_git_hook_takes_a_seeds_git_and_other_repos_ignore_it() {
        let _lock = SEED_TEST_LOCK.lock().await;
        let w = World::new();
        let dir = w.seed("hooked").await;
        let plain = format!("{}/plain-hooked", w.root);
        std::fs::create_dir_all(&plain).unwrap();
        run(&["git", "init", "-q"], &plain).await;
        let seen = Arc::new(Mutex::new(Vec::new()));
        set_seed_git(Some(Arc::new(Recorder(seen.clone()))));
        let r = git_with(
            &dir,
            &["status", "--porcelain"],
            30_000.into(),
            &[("GIT_AUTHOR_NAME", "canopy")],
        )
        .await;
        assert_eq!(r.stdout, "from the runner\n");
        assert_eq!(
            seen.lock().unwrap().clone(),
            vec![(
                dir.clone(),
                vec!["status".to_string(), "--porcelain".to_string()],
                kv(&[("GIT_OPTIONAL_LOCKS", "0"), ("GIT_AUTHOR_NAME", "canopy")])
            )]
        );
        let idx = format!("{}/i", w.root);
        let off = git_with(
            &dir,
            &["add", "-A"],
            30_000.into(),
            &[("GIT_INDEX_FILE", idx.as_str())],
        )
        .await;
        assert_eq!(off.code, 128);
        assert!(off.stderr.contains("GIT_INDEX_FILE"));
        assert_eq!(seen.lock().unwrap().len(), 1);
        append(&format!("{dir}/.git/config"), "[core]\n\tpager = sh\n");
        assert!(git(&dir, &["status"]).await.stderr.contains("core.pager"));
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(git(&plain, &["status", "--porcelain"]).await.stdout, "");
        assert_eq!(seen.lock().unwrap().len(), 1);
        set_seed_git(None);
    }
}
