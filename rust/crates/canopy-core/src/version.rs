//! Which canopy is running: package.json's version and git's HEAD
//! (`src/core/version.ts` and `src/core/build.ts`).

use crate::pathx::{join, normalize};
use regex::Regex;
use serde::Serialize;
use std::process::{Command, Stdio};
use std::sync::LazyLock;

/// canopy's own checkout: `$CANOPY_DIR`, else the one this crate was built from.
pub fn canopy_dir() -> String {
    std::env::var("CANOPY_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| normalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    pub commit: Option<String>,
    pub committed_at: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub commit: Option<String>,
    pub committed_at: Option<String>,
    pub dirty: bool,
}

/// The seven hex digits git shows for a commit.
pub fn short_commit(commit: Option<&str>) -> Option<String> {
    commit
        .filter(|c| !c.is_empty())
        .map(|c| c.chars().take(7).collect())
}

/// `0.1.0 (4b6ba30, 2026-09-26)`, `0.1.0 (4b6ba30+dirty, …)`, or bare `0.1.0`.
pub fn version_line(b: &BuildInfo) -> String {
    let Some(short) = short_commit(b.commit.as_deref()) else {
        return b.version.clone();
    };
    let at = b
        .committed_at
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!(", {}", s.chars().take(10).collect::<String>()))
        .unwrap_or_default();
    format!(
        "{} ({short}{}{at})",
        b.version,
        if b.dirty { "+dirty" } else { "" }
    )
}

static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,40}$").unwrap());

/// A build from what git said, with CANOPY_COMMIT and CANOPY_COMMITTED
/// winning over it; a commit that is not hex is ignored.
pub fn build_from(
    version: &str,
    env: impl Fn(&str) -> Option<String>,
    head: Option<Head>,
) -> BuildInfo {
    if let Some(given) = env("CANOPY_COMMIT").map(|g| crate::pathx::js_trim(&g).to_lowercase())
        && HEX.is_match(&given)
    {
        let committed = env("CANOPY_COMMITTED")
            .map(|c| crate::pathx::js_trim(&c).to_string())
            .filter(|c| !c.is_empty());
        return BuildInfo {
            version: version.into(),
            commit: Some(given),
            committed_at: committed,
            dirty: false,
        };
    }
    let head = head.unwrap_or(Head {
        commit: None,
        committed_at: None,
        dirty: false,
    });
    BuildInfo {
        version: version.into(),
        commit: head.commit,
        committed_at: head.committed_at,
        dirty: head.dirty,
    }
}

fn git_out(dir: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| crate::pathx::js_trim(&String::from_utf8_lossy(&out.stdout)).to_string())
}

fn read_head(dir: &str) -> Option<Head> {
    let line = git_out(dir, &["log", "-1", "--format=%H %cI"]).filter(|l| !l.is_empty())?;
    let mut parts = line.split(' ');
    let commit = parts.next().map(String::from);
    let committed_at = parts.next().map(String::from);
    let status = git_out(dir, &["status", "--porcelain", "--untracked-files=no"]);
    Some(Head {
        commit,
        committed_at,
        dirty: status.is_some_and(|s| !s.is_empty()),
    })
}

pub fn read_version(dir: &str) -> Option<String> {
    let text = std::fs::read_to_string(join(dir, "package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(String::from)
}

pub fn read_build(dir: &str) -> BuildInfo {
    let env = |k: &str| std::env::var(k).ok();
    let version = read_version(dir).unwrap_or_else(|| "0.0.0".into());
    let head = if env("CANOPY_COMMIT").is_some_and(|c| !c.is_empty()) {
        None
    } else {
        read_head(dir)
    };
    build_from(&version, env, head)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(commit: Option<&str>, at: Option<&str>, dirty: bool) -> BuildInfo {
        BuildInfo {
            version: "0.1.0".into(),
            commit: commit.map(String::from),
            committed_at: at.map(String::from),
            dirty,
        }
    }

    #[test]
    fn version_lines() {
        assert_eq!(version_line(&b(None, None, false)), "0.1.0");
        assert_eq!(
            version_line(&b(
                Some("4b6ba30aaaa"),
                Some("2026-09-26T10:00:00-07:00"),
                false
            )),
            "0.1.0 (4b6ba30, 2026-09-26)"
        );
        assert_eq!(
            version_line(&b(Some("4b6ba30aaaa"), None, true)),
            "0.1.0 (4b6ba30+dirty)"
        );
    }

    #[test]
    fn the_environment_wins_only_with_hex() {
        let head = Head {
            commit: Some("abc1234".into()),
            committed_at: None,
            dirty: true,
        };
        let env = |k: &str| match k {
            "CANOPY_COMMIT" => Some(" DEADBEEF ".to_string()),
            "CANOPY_COMMITTED" => Some("2026-01-02".to_string()),
            _ => None,
        };
        assert_eq!(
            build_from("1.0.0", env, Some(head.clone()))
                .commit
                .as_deref(),
            Some("deadbeef")
        );
        let bad = |k: &str| (k == "CANOPY_COMMIT").then(|| "not-hex".to_string());
        assert_eq!(
            build_from("1.0.0", bad, Some(head)).commit.as_deref(),
            Some("abc1234")
        );
    }

    #[test]
    fn this_checkout_has_a_version() {
        assert!(read_version(&canopy_dir()).is_some());
    }
}
