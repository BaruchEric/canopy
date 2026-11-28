//! Running commands: here, over ssh, and git wherever a repo lives
//! (`src/core/exec.ts`). Nothing here throws; a failure is a code and stderr.

use crate::host::{parse_locator, remote_command, ssh_args};
use crate::seedgit::{self, SEED_BUSY, SEED_GIT_FLAGS};
use crate::store::config_dir;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ExecResult {
    pub fn fail(code: i32, stderr: impl Into<String>) -> Self {
        Self {
            code,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }
}

/// What `AbortController` is to the TypeScript: one side aborts, every
/// clone of its signal sees it.
#[derive(Debug)]
pub struct AbortController {
    tx: watch::Sender<bool>,
}

impl Default for AbortController {
    fn default() -> Self {
        Self::new()
    }
}

impl AbortController {
    pub fn new() -> Self {
        Self {
            tx: watch::channel(false).0,
        }
    }
    pub fn abort(&self) {
        self.tx.send_replace(true);
    }
    pub fn signal(&self) -> AbortSignal {
        AbortSignal {
            rx: self.tx.subscribe(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AbortSignal {
    rx: watch::Receiver<bool>,
}

impl AbortSignal {
    pub fn aborted(&self) -> bool {
        *self.rx.borrow()
    }
    /// Settles once aborted; never, if the controller goes away first.
    pub async fn wait(&self) {
        let mut rx = self.rx.clone();
        if rx.wait_for(|v| *v).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    /// ends the command once neither pipe has produced output for this long:
    /// the bound for a transfer whose size is unknown (a fetch)
    pub idle_ms: Option<u64>,
    /// variables laid over the environment
    pub env: Vec<(String, String)>,
    /// the environment `env` is laid over, in place of this process's own
    pub base: Option<Vec<(String, String)>>,
    /// text for the child's stdin; without it stdin is closed
    pub input: Option<String>,
    /// ends the command the way the timeout does
    pub signal: Option<AbortSignal>,
}

/// a command's first line of output, for an error message
pub fn first_line(s: &str) -> String {
    s.trim().split('\n').next().unwrap_or("").to_string()
}

/// How long a timed-out command gets after SIGTERM before SIGKILL, and
/// after that before its pipes stop being waited on.
pub const KILL_GRACE: Duration = Duration::from_millis(2_000);

/// a signal to the command's whole process group, or to the command alone
/// when the group is gone
fn signal_group(pid: Option<u32>, sig: rustix::process::Signal) {
    let Some(pid) = pid.and_then(|p| rustix::process::Pid::from_raw(p as i32)) else {
        return;
    };
    if rustix::process::kill_process_group(pid, sig).is_err() {
        let _ = rustix::process::kill_process(pid, sig);
    }
}

fn exit_code(status: std::io::Result<std::process::ExitStatus>) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    match status {
        Ok(s) => s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0)),
        Err(_) => 1,
    }
}

async fn read_into<R: tokio::io::AsyncRead + Unpin>(
    mut r: R,
    buf: Arc<Mutex<Vec<u8>>>,
    last: Arc<AtomicU64>,
    start: Instant,
) {
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if let Ok(mut b) = buf.lock() {
                    b.extend_from_slice(&chunk[..n]);
                }
                last.store(start.elapsed().as_millis() as u64, Ordering::Relaxed);
            }
        }
    }
}

/// Settles once `idle_ms` pass with no output on either pipe.
async fn idle_watch(idle_ms: u64, last: Arc<AtomicU64>, start: Instant) {
    loop {
        let at = last.load(Ordering::Relaxed);
        let due = start + Duration::from_millis(at + idle_ms);
        tokio::time::sleep_until(due.into()).await;
        if last.load(Ordering::Relaxed) == at {
            return;
        }
    }
}

/// Run a command, capture output. Never fails: errors land in code/stderr.
///
/// With a timeout the command runs in a process group of its own and the
/// timeout ends the whole group, so what it started (git fetch's per-remote
/// child, a test runner) cannot hold the pipes. A process that leaves the
/// group and keeps a pipe (a daemon) stops being waited on after
/// `KILL_GRACE`. An aborted signal and `idle_ms` of silence end it the same way.
pub async fn exec<S: AsRef<str>>(cmd: &[S], opts: &ExecOptions) -> ExecResult {
    let Some((prog, args)) = cmd.split_first() else {
        return ExecResult::fail(127, "no command");
    };
    let mut c = Command::new(prog.as_ref());
    c.args(args.iter().map(|a| a.as_ref()));
    if let Some(cwd) = &opts.cwd {
        c.current_dir(cwd);
    }
    // always a whole env: the live one (or `base`) with `env` laid over it
    c.env_clear();
    match &opts.base {
        Some(base) => {
            c.envs(base.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        None => {
            c.envs(std::env::vars_os());
        }
    }
    c.envs(opts.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    c.stdin(if opts.input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    c.stdout(Stdio::piped());
    c.stderr(Stdio::piped());
    let timed = opts.timeout_ms.filter(|t| *t > 0);
    let idle = opts.idle_ms.filter(|t| *t > 0);
    if timed.is_some() || opts.signal.is_some() || idle.is_some() {
        c.process_group(0);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return ExecResult::fail(127, e.to_string()),
    };
    let pid = child.id();
    if let (Some(input), Some(mut stdin)) = (opts.input.clone(), child.stdin.take()) {
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let start = Instant::now();
    let last = Arc::new(AtomicU64::new(0));
    let out_buf = Arc::new(Mutex::new(Vec::new()));
    let err_buf = Arc::new(Mutex::new(Vec::new()));
    let out_h = child
        .stdout
        .take()
        .map(|s| tokio::spawn(read_into(s, out_buf.clone(), last.clone(), start)));
    let err_h = child
        .stderr
        .take()
        .map(|s| tokio::spawn(read_into(s, err_buf.clone(), last.clone(), start)));
    let aborts: Vec<_> = out_h
        .iter()
        .chain(err_h.iter())
        .map(|h| h.abort_handle())
        .collect();
    let all = async move {
        if let Some(h) = out_h {
            let _ = h.await;
        }
        if let Some(h) = err_h {
            let _ = h.await;
        }
        child.wait().await
    };
    tokio::pin!(all);
    let signal = opts.signal.clone();
    let stop = async {
        tokio::select! {
            _ = async { match &signal { Some(s) => s.wait().await, None => std::future::pending().await } } => {}
            _ = async { match idle { Some(ms) => idle_watch(ms, last.clone(), start).await, None => std::future::pending().await } } => {}
        }
    };
    let status = if timed.is_some() || signal.is_some() || idle.is_some() {
        let already = signal.as_ref().is_some_and(|s| s.aborted());
        let done = if already {
            None
        } else {
            tokio::select! {
                r = &mut all => Some(r),
                _ = async { match timed { Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await, None => std::future::pending().await } } => None,
                _ = stop => None,
            }
        };
        match done {
            Some(r) => r,
            None => {
                signal_group(pid, rustix::process::Signal::TERM);
                match tokio::time::timeout(KILL_GRACE, &mut all).await {
                    Ok(r) => r,
                    Err(_) => {
                        signal_group(pid, rustix::process::Signal::KILL);
                        match tokio::time::timeout(KILL_GRACE, &mut all).await {
                            Ok(r) => r,
                            Err(_) => {
                                for a in &aborts {
                                    a.abort();
                                }
                                all.await
                            }
                        }
                    }
                }
            }
        }
    } else {
        all.await
    };
    let text = |b: &Arc<Mutex<Vec<u8>>>| {
        b.lock()
            .map(|v| String::from_utf8_lossy(&v).into_owned())
            .unwrap_or_default()
    };
    ExecResult {
        code: exit_code(status),
        stdout: text(&out_buf),
        stderr: text(&err_buf),
    }
}

/// Where ssh keeps its control sockets: the config dir, made once.
fn ssh_control_dir() -> &'static str {
    static DIR: OnceLock<String> = OnceLock::new();
    DIR.get_or_init(|| {
        let d = config_dir();
        // a missing dir only costs the shared connection; ssh still works
        let _ = std::fs::create_dir_all(&d);
        d
    })
}

/// Run `cmd` where the target lives: here when `host` is None, else over
/// ssh. Remote runs assume a POSIX shell and key-based login; the env and
/// cwd are this machine's and do not travel.
pub async fn on_host<S: AsRef<str>>(
    host: Option<&str>,
    cmd: &[S],
    opts: &ExecOptions,
) -> ExecResult {
    let Some(host) = host else {
        let local = ExecOptions {
            cwd: None,
            ..opts.clone()
        };
        return exec(cmd, &local).await;
    };
    let words: Vec<String> = cmd.iter().map(|w| w.as_ref().to_string()).collect();
    let mut argv = ssh_args(host, ssh_control_dir());
    argv.push(remote_command(&words));
    let remote = ExecOptions {
        timeout_ms: opts.timeout_ms,
        input: opts.input.clone(),
        idle_ms: opts.idle_ms,
        signal: opts.signal.clone(),
        ..Default::default()
    };
    exec(&argv, &remote).await
}

/// Where canopy's git in a seed runs instead of here: on an isolated
/// backend, the stage runner. Not ported yet; the hook is here so the
/// server can set it when the stage runner is.
pub trait SeedGitHook: Send + Sync {
    /// the seeds this hook answers for; every seed by default
    fn covers(&self, _path: &str) -> bool {
        true
    }
    fn run(
        &self,
        path: String,
        args: Vec<String>,
        timeout_ms: u64,
        env: Vec<(String, String)>,
    ) -> Pin<Box<dyn Future<Output = ExecResult> + Send>>;
}

static SEED_GIT_HOOK: RwLock<Option<Arc<dyn SeedGitHook>>> = RwLock::new(None);

/// set by the server on an isolated backend, cleared on one that is not
pub fn set_seed_git(hook: Option<Arc<dyn SeedGitHook>>) {
    if let Ok(mut h) = SEED_GIT_HOOK.write() {
        *h = hook;
    }
}

fn seed_git_hook(path: &str) -> Option<Arc<dyn SeedGitHook>> {
    SEED_GIT_HOOK
        .read()
        .ok()?
        .as_ref()
        .filter(|h| h.covers(path))
        .cloned()
}

/// The names the stage runner takes in a seed's git env.
pub const SEED_GIT_ENV: &[&str] = &[
    "GIT_OPTIONAL_LOCKS",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
];

/// a refusal for an env the stage runner would refuse
fn off_git_env(env: &[(String, String)]) -> Option<ExecResult> {
    let off = env
        .iter()
        .find(|(k, _)| !SEED_GIT_ENV.contains(&k.as_str()))?;
    Some(ExecResult::fail(
        128,
        format!(
            "canopy runs git in a seed with {} alone, not {}",
            SEED_GIT_ENV.join(", "),
            off.0
        ),
    ))
}

/// How long a git call may run: a hard cap, and optionally how long it may
/// stay silent first (which needs output to watch: `--progress` on a fetch).
#[derive(Debug, Clone, Copy)]
pub struct GitTimeout {
    pub total: u64,
    pub idle: Option<u64>,
}

impl Default for GitTimeout {
    fn default() -> Self {
        Self {
            total: 30_000,
            idle: None,
        }
    }
}

impl From<u64> for GitTimeout {
    fn from(total: u64) -> Self {
        Self { total, idle: None }
    }
}

/// git in a repo with the default 30 s cap and no extra env.
pub async fn git<S: AsRef<str>>(repo_path: &str, args: &[S]) -> ExecResult {
    git_with(repo_path, args, GitTimeout::default(), &[]).await
}

/// git in a repo, wherever its locator says it is.
///
/// `GIT_OPTIONAL_LOCKS=0`: canopy reads while the user works, and a status
/// that refreshes the index holds index.lock while it does, so the user's
/// own `git add` landing in that moment would fail. (The variable does not
/// travel over ssh.) A seed is written by agents: see seedgit.rs.
pub async fn git_with<S: AsRef<str>>(
    repo_path: &str,
    args: &[S],
    timeout: GitTimeout,
    env: &[(&str, &str)],
) -> ExecResult {
    let loc = parse_locator(repo_path);
    let mut genv: Vec<(String, String)> = vec![("GIT_OPTIONAL_LOCKS".into(), "0".into())];
    for (k, v) in env {
        if let Some(slot) = genv.iter_mut().find(|(gk, _)| gk == k) {
            slot.1 = v.to_string();
        } else {
            genv.push((k.to_string(), v.to_string()));
        }
    }
    let opts = ExecOptions {
        timeout_ms: Some(timeout.total),
        idle_ms: timeout.idle,
        env: genv.clone(),
        ..Default::default()
    };
    let args: Vec<String> = args.iter().map(|a| a.as_ref().to_string()).collect();
    if loc.host.is_none() {
        let path = loc.path.as_str();
        let roots = seedgit::seed_roots_now();
        let seeds = seedgit::seeds_root_of(path, &roots);
        if seeds.is_some() && seedgit::seed_busy(path) {
            return ExecResult::fail(128, SEED_BUSY);
        }
        if let Some(refused) = seedgit::seed_git_refusal(path).await {
            return ExecResult::fail(128, refused);
        }
        if let Some(seeds) = seeds {
            if let Some(hook) = seed_git_hook(path) {
                if let Some(off) = off_git_env(&genv) {
                    return off;
                }
                return hook.run(path.to_string(), args, timeout.total, genv).await;
            }
            let mut argv: Vec<String> = vec!["git".into()];
            argv.extend(SEED_GIT_FLAGS.iter().map(|s| s.to_string()));
            argv.extend(["-C".to_string(), path.to_string()]);
            argv.extend(args);
            let mut env = genv;
            env.push(("GIT_CEILING_DIRECTORIES".into(), seeds));
            return exec(&argv, &ExecOptions { env, ..opts }).await;
        }
    }
    let mut argv: Vec<String> = vec!["git".into(), "-C".into(), loc.path.clone()];
    argv.extend(args);
    on_host(loc.host.as_deref(), &argv, &opts).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sv(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    async fn alive(pid: u32) -> bool {
        let r = exec(
            &sv(&["ps", "-o", "stat=", "-p", &pid.to_string()]),
            &ExecOptions::default(),
        )
        .await;
        let stat = r.stdout.trim().to_string();
        r.code == 0 && !stat.is_empty() && !stat.starts_with('Z')
    }

    #[tokio::test]
    async fn captures_output_and_the_exit_code() {
        let r = exec(
            &sv(&["sh", "-c", "echo out; echo err >&2; exit 3"]),
            &ExecOptions {
                timeout_ms: Some(5_000),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            r,
            ExecResult {
                code: 3,
                stdout: "out\n".into(),
                stderr: "err\n".into()
            }
        );
        assert_eq!(
            exec(&sv(&["sh", "-c", "exit 4"]), &ExecOptions::default())
                .await
                .code,
            4
        );
    }

    #[tokio::test]
    async fn input_goes_to_stdin() {
        let r = exec(
            &sv(&["cat"]),
            &ExecOptions {
                input: Some("a\nb $(no)".into()),
                ..Default::default()
            },
        )
        .await;
        assert_eq!((r.code, r.stdout.as_str()), (0, "a\nb $(no)"));
        let r = on_host(
            None,
            &sv(&["cat"]),
            &ExecOptions {
                input: Some("x".into()),
                ..Default::default()
            },
        )
        .await;
        assert_eq!((r.code, r.stdout.as_str()), (0, "x"));
    }

    #[tokio::test]
    async fn a_missing_binary_is_a_result() {
        assert_eq!(
            exec(
                &sv(&["/nonexistent/canopy-no-such-binary"]),
                &ExecOptions::default()
            )
            .await
            .code,
            127
        );
    }

    #[tokio::test]
    async fn a_timeout_ends_what_the_command_started_and_keeps_what_it_printed() {
        let start = Instant::now();
        let r = exec(
            &sv(&["sh", "-c", "echo early; echo $$ >&2; sleep 30; true"]),
            &ExecOptions {
                timeout_ms: Some(300),
                ..Default::default()
            },
        )
        .await;
        assert!(start.elapsed() < Duration::from_millis(300) + KILL_GRACE);
        assert_ne!(r.code, 0);
        assert_eq!(r.stdout, "early\n");
    }

    #[tokio::test]
    async fn an_idle_timeout_ends_a_quiet_command_and_lets_a_talking_one_finish() {
        let start = Instant::now();
        let quiet = exec(
            &sv(&["sh", "-c", "echo early; sleep 30; true"]),
            &ExecOptions {
                idle_ms: Some(300),
                timeout_ms: Some(60_000),
                ..Default::default()
            },
        )
        .await;
        assert!(start.elapsed() < Duration::from_millis(300) + KILL_GRACE * 2);
        assert_ne!(quiet.code, 0);
        assert_eq!(quiet.stdout, "early\n");
        let talking = exec(
            &sv(&[
                "sh",
                "-c",
                "for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.1; done",
            ]),
            &ExecOptions {
                idle_ms: Some(300),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(talking.code, 0);
        assert_eq!(talking.stdout, "1\n2\n3\n4\n5\n6\n7\n8\n");
    }

    #[tokio::test]
    async fn an_abort_ends_the_command_and_what_it_started() {
        let ctl = AbortController::new();
        let signal = ctl.signal();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            ctl.abort();
        });
        let start = Instant::now();
        let r = exec(
            &sv(&["sh", "-c", "sleep 30 & echo $!; wait; true"]),
            &ExecOptions {
                timeout_ms: Some(60_000),
                signal: Some(signal),
                ..Default::default()
            },
        )
        .await;
        assert!(start.elapsed() < Duration::from_millis(200) + KILL_GRACE);
        assert_ne!(r.code, 0);
        let pid: u32 = r.stdout.trim().parse().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!alive(pid).await);
    }

    #[tokio::test]
    async fn the_whole_group_goes() {
        let r = exec(
            &sv(&["sh", "-c", "sleep 30 & echo $!; wait; true"]),
            &ExecOptions {
                timeout_ms: Some(300),
                ..Default::default()
            },
        )
        .await;
        let pid: u32 = r.stdout.trim().parse().unwrap();
        assert!(pid > 0);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!alive(pid).await);
    }

    #[tokio::test]
    async fn a_process_that_leaves_the_group_and_keeps_a_pipe_is_not_waited_on_forever() {
        if exec(
            &sv(&["sh", "-c", "command -v python3"]),
            &ExecOptions::default(),
        )
        .await
        .code
            != 0
        {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let script = "import os, sys, time\npid = os.fork()\nif pid == 0:\n    os.setsid()\n    print(os.getpid(), flush=True)\n    with open(sys.argv[1], 'w') as f:\n        f.write(str(os.getpid()))\n    time.sleep(30)\nelse:\n    time.sleep(30)";
        let ctl = AbortController::new();
        let argv = sv(&["python3", "-c", script, ready.to_str().unwrap()]);
        let opts = ExecOptions {
            timeout_ms: Some(10_000),
            signal: Some(ctl.signal()),
            ..Default::default()
        };
        let running = tokio::spawn(async move { exec(&argv, &opts).await });
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut daemon = 0u32;
        while Instant::now() < deadline {
            if let Ok(t) = std::fs::read_to_string(&ready) {
                daemon = t.trim().parse().unwrap_or(0);
            }
            if daemon > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(daemon > 0);
        let start = Instant::now();
        ctl.abort();
        let r = running.await.unwrap();
        assert!(start.elapsed() < KILL_GRACE * 3);
        assert_ne!(r.code, 0);
        assert_eq!(r.stdout.trim(), daemon.to_string());
        assert!(alive(daemon).await);
        if let Some(p) = rustix::process::Pid::from_raw(daemon as i32) {
            let _ = rustix::process::kill_process(p, rustix::process::Signal::KILL);
        }
    }
}
