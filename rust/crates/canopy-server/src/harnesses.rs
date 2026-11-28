//! Which agent harnesses this backend can start (`findBinary`,
//! `LoginHarnesses`, `harnessesFrom` and `backendCaps` in
//! `src/core/openers.ts`): a binary this process finds, or one the user's
//! login shell finds, asked in the background every ten minutes. Until the
//! shell answers, or when it cannot, every harness is offered.

use canopy_core::exec::{ExecOptions, exec};
use canopy_core::harness::{HARNESSES, harness};
use canopy_core::host::shell_quote;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// how long the login shell gets to answer
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// how long its answer holds before it is asked again
pub const PROBE_EVERY: Duration = Duration::from_secs(10 * 60);
const PROBE_MARK: &str = "canopy-has:";
/// where a harness's installer puts its binary, under HOME
const HARNESS_DIRS: [&str; 3] = [".local/bin", ".bun/bin", ".npm-global/bin"];
const SYSTEM_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// `Bun.which`: an executable file of that name on PATH.
fn which(binary: &str) -> Option<String> {
    let path = std::env::var("PATH").ok()?;
    path.split(':').filter(|d| !d.is_empty()).find_map(|d| {
        let full = canopy_core::pathx::join(d, binary);
        let m = std::fs::metadata(&full).ok()?;
        (m.is_file() && m.permissions().mode() & 0o111 != 0).then_some(full)
    })
}

/// Where a harness's binary is: on PATH, or where its installers put it.
pub fn find_binary(binary: &str) -> Option<String> {
    if let Some(p) = which(binary) {
        return Some(p);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    HARNESS_DIRS
        .iter()
        .map(|d| canopy_core::pathx::join(&canopy_core::pathx::join(&home, d), binary))
        .chain(
            SYSTEM_DIRS
                .iter()
                .map(|d| canopy_core::pathx::join(d, binary)),
        )
        .find(|full| std::path::Path::new(full).exists())
}

pub fn has_binary(binary: &str) -> bool {
    find_binary(binary).is_some()
}

/// The script the probe runs: one marker line per harness the shell can
/// run, as a binary, a function or an alias.
pub fn probe_script() -> String {
    let mut parts: Vec<String> = HARNESSES
        .iter()
        .filter_map(|h| harness(h))
        .map(|i| {
            let b = shell_quote(i.binary);
            format!("command -v {b} >/dev/null 2>&1 && printf '{PROBE_MARK}%s\\n' {b}")
        })
        .collect();
    parts.push("true".into());
    parts.join("; ")
}

/// The harnesses a probe's output names.
pub fn parse_probe(out: &str) -> Vec<&'static str> {
    let found: Vec<&str> = out
        .split('\n')
        .map(str::trim)
        .filter_map(|l| l.strip_prefix(PROBE_MARK))
        .collect();
    HARNESSES
        .into_iter()
        .filter(|h| harness(h).is_some_and(|i| found.contains(&i.binary)))
        .collect()
}

/// `process.env.SHELL`, else the platform's login shell.
pub fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh"
            } else {
                "/bin/bash"
            }
            .into()
        })
}

/// One answer from the login shell: what it found, or None when it did
/// not answer.
#[derive(Debug, Clone, PartialEq)]
pub struct LoginProbe {
    pub at: Instant,
    pub found: Option<Vec<&'static str>>,
    pub why: Option<String>,
}

pub async fn probe_login_shell(shell: &str) -> LoginProbe {
    let r = exec(
        &[shell, "-l", "-i", "-c", &probe_script()],
        &ExecOptions {
            timeout_ms: Some(PROBE_TIMEOUT.as_millis() as u64),
            ..Default::default()
        },
    )
    .await;
    let found = parse_probe(&r.stdout);
    // a shell that printed markers answered, whatever its rc files did to
    // the exit code; one that printed none and failed did not answer
    if r.code != 0 && found.is_empty() {
        let last = r
            .stderr
            .trim()
            .split('\n')
            .next_back()
            .unwrap_or("")
            .to_string();
        let why = if last.is_empty() {
            format!("{shell} exited with {}", r.code)
        } else {
            last
        };
        return LoginProbe {
            at: Instant::now(),
            found: None,
            why: Some(why),
        };
    }
    LoginProbe {
        at: Instant::now(),
        found: Some(found),
        why: None,
    }
}

/// What a backend offers: a harness this process finds, or one the login
/// shell found; every harness while the shell has not answered.
pub fn harnesses_from(has: impl Fn(&str) -> bool, probe: Option<&LoginProbe>) -> Vec<&'static str> {
    HARNESSES
        .into_iter()
        .filter(|h| {
            let Some(i) = harness(h) else { return false };
            has(i.binary)
                || probe
                    .and_then(|p| p.found.as_ref())
                    .is_none_or(|f| f.contains(h))
        })
        .collect()
}

/// The harnesses this backend offers, kept fresh: `list` answers at once
/// from the last probe and asks again in the background once it is old.
pub struct LoginHarnesses {
    shell: String,
    state: Mutex<(Option<LoginProbe>, bool)>,
}

impl LoginHarnesses {
    pub fn new(shell: String) -> Arc<LoginHarnesses> {
        Arc::new(LoginHarnesses {
            shell,
            state: Mutex::new((None, false)),
        })
    }

    pub fn list(self: &Arc<Self>) -> Vec<&'static str> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let due = st.0.as_ref().is_none_or(|p| p.at.elapsed() >= PROBE_EVERY);
        if due && !st.1 {
            st.1 = true;
            let me = Arc::clone(self);
            tokio::spawn(async move {
                let p = probe_login_shell(&me.shell).await;
                if let (None, Some(why)) = (&p.found, &p.why) {
                    eprintln!(
                        "canopy: could not ask the login shell which agents it has ({why}); no start is refused for a missing one"
                    );
                }
                let mut st = me.state.lock().unwrap_or_else(|e| e.into_inner());
                *st = (Some(p), false);
            });
        }
        harnesses_from(has_binary, st.0.as_ref())
    }
}

/// `hostOpeners`: a desktop to open apps on, on a Mac not told otherwise.
pub fn host_openers() -> bool {
    std::env::var("CANOPY_NO_DESKTOP").ok().as_deref() != Some("1") && cfg!(target_os = "macos")
}

/// What the tree says this backend can do (`backendCaps`).
pub fn backend_caps(harnesses: &[&str]) -> Value {
    let ssh = std::env::var("CANOPY_SSH_HOST")
        .ok()
        .filter(|s| !s.is_empty());
    json!({ "openers": host_openers(), "sshHost": ssh, "harnesses": harnesses, "labels": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_marks_each_harness_it_finds_and_reads_back_only_markers() {
        let s = probe_script();
        assert!(s.starts_with(
            "command -v 'claude' >/dev/null 2>&1 && printf 'canopy-has:%s\\n' 'claude'; "
        ));
        assert!(s.ends_with("; true"));
        assert_eq!(
            parse_probe("hello\n canopy-has:agy \ncanopy-has:claude\ncanopy-has:gemini"),
            ["claude", "antigravity"]
        );
    }

    #[test]
    fn every_harness_is_offered_until_the_shell_answers() {
        let none = |_: &str| false;
        assert_eq!(harnesses_from(none, None), HARNESSES);
        let failed = LoginProbe {
            at: Instant::now(),
            found: None,
            why: Some("x".into()),
        };
        assert_eq!(harnesses_from(none, Some(&failed)), HARNESSES);
        let answered = LoginProbe {
            at: Instant::now(),
            found: Some(vec!["codex"]),
            why: None,
        };
        assert_eq!(
            harnesses_from(|b| b == "agy", Some(&answered)),
            ["codex", "antigravity"]
        );
    }

    #[tokio::test]
    async fn a_shell_that_fails_without_markers_did_not_answer() {
        let p = probe_login_shell("/nonexistent/shell").await;
        assert!(p.found.is_none());
        assert!(p.why.is_some());
    }
}
