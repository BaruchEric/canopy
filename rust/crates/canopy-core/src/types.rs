//! The wire types the scan produces, as `src/core/types.ts` defines them.
//! Field names and the absent-versus-null rules match the TypeScript, so a
//! page reads the Rust server's JSON exactly as it reads the Bun server's.

use serde::{Deserialize, Serialize};

/// How many unmerged branches a status reads; a card showing this many says
/// "or more".
pub const BRANCH_WIP_CAP: usize = 12;

/// The launch root's source id; its repo ids stay bare.
pub const LAUNCH_SOURCE: &str = "launch";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RepoFile {
    /// path relative to the repo root
    pub path: String,
    /// original path for renames and copies
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig: Option<String>,
    /// index (staged) state: M A D R C U or "."
    pub index: String,
    /// worktree (unstaged) state: M D U or "."
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
    /// when the file on disk last changed, unix seconds
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastCommit {
    pub hash: String,
    pub subject: String,
    /// unix seconds
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitUser {
    pub name: String,
    pub email: String,
}

/// The newest commit on a remote-tracking branch the checkout lacks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteTip {
    #[serde(rename = "ref")]
    pub reference: String,
    pub hash: String,
    pub subject: String,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lines {
    pub added: i64,
    pub deleted: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<RepoFile>,
    pub last_commit: Option<LastCommit>,
    /// null when neither user.name nor user.email is set anywhere
    pub user: Option<GitUser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip: Option<RemoteTip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elsewhere: Option<Elsewhere>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<Lines>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeWip {
    pub path: String,
    /// null when its HEAD is detached
    pub branch: Option<String>,
    pub files: i64,
    pub unmerged: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
}

/// Where a branch stands against its upstream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BranchPush {
    Local,
    Upstream {
        #[serde(rename = "ref")]
        reference: String,
        unpushed: i64,
    },
    Gone {
        #[serde(rename = "ref")]
        reference: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BranchWip {
    pub name: String,
    pub push: BranchPush,
    pub at: i64,
    pub subject: String,
    /// commits on it HEAD lacks; absent on a git older than 2.41
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unmerged: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StashWip {
    pub count: i64,
    pub subject: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Elsewhere {
    pub worktrees: Vec<WorktreeWip>,
    pub branches: Vec<BranchWip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stash: Option<StashWip>,
}

/// One commit as the log lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub when: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unpushed: bool,
}

/// "in-sync" says the spec's text matches, not that the code follows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpecState {
    #[serde(rename = "in-sync")]
    InSync,
    #[serde(rename = "behind")]
    Behind,
    #[serde(rename = "drifted")]
    Drifted,
    #[serde(rename = "not-adopted")]
    NotAdopted,
}

/// Where a scanned source is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourcePlace {
    Local {
        path: String,
    },
    Ssh {
        host: String,
        path: String,
    },
    Forgejo {
        url: String,
        #[serde(rename = "tokenFile", default, skip_serializing_if = "Option::is_none")]
        token_file: Option<String>,
    },
}

/// A folder canopy scans for repos.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    #[serde(flatten)]
    pub place: SourcePlace,
    pub label: String,
    pub launch: bool,
}

/// A source with what its last scan found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceState {
    #[serde(flatten)]
    pub source: Source,
    pub repos: usize,
    pub scanned_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub group: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remotes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<SpecState>,
    pub status: Option<RepoStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    // What the server lays on after a scan. Kept as raw JSON until the
    // modules that own them are ported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulls: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peers: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub sources: Vec<SourceState>,
    pub repos: Vec<Repo>,
    pub scanned_at: i64,
    /// what this backend can do for its clients; raw until openers.ts is ported
    pub backend: serde_json::Value,
}

/// How many files a repo has changed.
pub fn dirty_count(r: &Repo) -> usize {
    r.status.as_ref().map_or(0, |s| s.files.len())
}

/// Milliseconds since the epoch, as `Date.now()`.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `isRunActive()`: a run that is working, waiting on someone or idle
/// between turns, read off a run's JSON as `GET /api/runs` answers it.
pub fn is_run_active(run: &serde_json::Value) -> bool {
    matches!(
        run.get("status").and_then(serde_json::Value::as_str),
        Some("working" | "waiting" | "idle")
    )
}

/// Keep awake's modes (`AWAKE_MODES`).
pub const AWAKE_MODES: &[&str] = &["off", "always", "working"];

/// Where keep awake stands on a backend (`AwakeInfo`, `GET /api/awake`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AwakeInfo {
    pub mode: String,
    /// a caffeinate or systemd-inhibit child is alive
    pub holding: bool,
    /// this machine can hold itself awake
    pub available: bool,
    /// why it cannot, or why the last hold ended; null when all is well
    pub why: Option<String>,
    /// agents working on this machine, as last counted
    pub working: f64,
}

/// `awakeWords()`: where keep awake stands in a few words, "holding the
/// machine awake", "not holding, 0 agents working", "unavailable: ...".
pub fn awake_words(info: &AwakeInfo) -> String {
    let why = info.why.as_deref().filter(|w| !w.is_empty());
    if !info.available {
        return format!(
            "unavailable: {}",
            info.why
                .as_deref()
                .unwrap_or("this machine cannot hold itself awake")
        );
    }
    let s = if info.working == 1.0 { "" } else { "s" };
    let agents = format!("{} agent{s} working", info.working);
    let hold = if info.holding {
        "holding the machine awake".to_string()
    } else if info.mode == "working" {
        format!("not holding, {agents}")
    } else {
        "not holding".to_string()
    };
    match why {
        Some(w) => format!("{hold} ({w})"),
        None => hold,
    }
}

/// `OPENER_IDS`: the openers canopy knows, in types.ts's order.
pub const OPENER_IDS: [&str; 6] = ["kitty", "terminal", "code", "finder", "agent", "herdr"];

/// `isOpenerId()` (src/core/openers.ts): whether a word names an opener.
pub fn is_opener_id(v: &str) -> bool {
    OPENER_IDS.contains(&v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn absent_and_null_follow_the_typescript() {
        let st = RepoStatus {
            branch: "main".into(),
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![],
            last_commit: None,
            user: None,
            tip: None,
            elsewhere: None,
            lines: None,
        };
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            json!({"branch":"main","upstream":null,"ahead":0,"behind":0,"files":[],"lastCommit":null,"user":null})
        );
    }

    #[test]
    fn push_and_source_tags() {
        let p = BranchPush::Upstream {
            reference: "origin/x".into(),
            unpushed: 2,
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            json!({"kind":"upstream","ref":"origin/x","unpushed":2})
        );
        let s = Source {
            id: "launch".into(),
            place: SourcePlace::Local { path: "/d".into() },
            label: "d".into(),
            launch: true,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"id":"launch","kind":"local","path":"/d","label":"d","launch":true})
        );
        let back: Source = serde_json::from_value(
            json!({"id":"w","kind":"ssh","host":"wsl","path":"/x","label":"wsl","launch":false}),
        )
        .unwrap();
        assert_eq!(
            back.place,
            SourcePlace::Ssh {
                host: "wsl".into(),
                path: "/x".into()
            }
        );
    }

    #[test]
    fn awake_words_say_where_keep_awake_stands() {
        let info = |mode: &str, holding: bool, available: bool, why: Option<&str>, working: f64| {
            AwakeInfo {
                mode: mode.into(),
                holding,
                available,
                why: why.map(String::from),
                working,
            }
        };
        assert_eq!(
            awake_words(&info("always", true, true, None, 0.0)),
            "holding the machine awake"
        );
        assert_eq!(
            awake_words(&info("working", false, true, None, 0.0)),
            "not holding, 0 agents working"
        );
        assert_eq!(
            awake_words(&info("working", false, true, None, 1.0)),
            "not holding, 1 agent working"
        );
        assert_eq!(
            awake_words(&info("off", false, true, None, 3.0)),
            "not holding"
        );
        assert_eq!(
            awake_words(&info("always", false, true, Some("caffeinate exited"), 0.0)),
            "not holding (caffeinate exited)"
        );
        assert_eq!(
            awake_words(&info(
                "always",
                false,
                false,
                Some("running in a container"),
                0.0
            )),
            "unavailable: running in a container"
        );
        assert_eq!(
            awake_words(&info("always", false, false, None, 0.0)),
            "unavailable: this machine cannot hold itself awake"
        );
    }

    #[test]
    fn spec_state_words() {
        assert_eq!(
            serde_json::to_value(SpecState::NotAdopted).unwrap(),
            json!("not-adopted")
        );
    }

    /// openers.test.ts
    #[test]
    fn agent_and_herdr_are_opener_ids() {
        assert!(is_opener_id("agent"));
        assert!(is_opener_id("herdr"));
        assert!(!is_opener_id("emacs"));
    }
}
