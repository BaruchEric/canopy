//! Repo paths are plain absolute paths on this machine, or a locator
//! `ssh://<host><abs path>` for a folder on another host. Everything that
//! runs git takes the locator and routes through `on_host`, so the rest of
//! the code never has to know where a repo lives. (`src/core/host.ts`)

use regex::Regex;
use std::sync::LazyLock;

pub const SSH_SCHEME: &str = "ssh://";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locator {
    /// ssh host alias, or None for this machine
    pub host: Option<String>,
    /// absolute path on that host
    pub path: String,
}

pub fn parse_locator(p: &str) -> Locator {
    let Some(rest) = p.strip_prefix(SSH_SCHEME) else {
        return Locator {
            host: None,
            path: p.to_string(),
        };
    };
    match rest.find('/') {
        None => Locator {
            host: Some(rest.to_string()),
            path: "/".into(),
        },
        Some(i) => Locator {
            host: Some(rest[..i].to_string()),
            path: rest[i..].to_string(),
        },
    }
}

pub fn to_locator(host: Option<&str>, path: &str) -> String {
    match host {
        Some(h) if !h.is_empty() => format!("{SSH_SCHEME}{h}{path}"),
        _ => path.to_string(),
    }
}

pub fn is_remote(p: &str) -> bool {
    p.starts_with(SSH_SCHEME)
}

static SSH_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$").unwrap());

/// An ssh host as it appears in `~/.ssh/config`, optionally `user@host`.
/// Anything else is refused before it can reach ssh's argv as an option.
pub fn is_ssh_host(h: &str) -> bool {
    SSH_HOST.is_match(h)
}

/// POSIX single-quoting: safe for any byte but NUL.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

static PLAIN_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_@%+=:,./-]+$").unwrap());

/// What a line typed into a canopy shell uses for that shell's own
/// CANOPY_TOKEN: the shell expands it, so no token value is ever typed.
pub const TOKEN_REF: &str = "$CANOPY_TOKEN";

/// Marks the one word `shell_line` leaves as written.
const RAW_WORD: &str = "\u{1}";

/// Codex's `-c` value that sets its commands' CANOPY_TOKEN from the shell's
/// own; `shell_line` matches it whole, so no other word is left raw.
pub static TOKEN_SET_WORD: LazyLock<String> = LazyLock::new(|| {
    format!("{RAW_WORD}'shell_environment_policy.set.CANOPY_TOKEN=\"'\"{TOKEN_REF}\"'\"'")
});

/// Words as one shell line, quoting only what needs it.
pub fn shell_line(words: &[String]) -> String {
    words
        .iter()
        .map(|w| {
            if *w == *TOKEN_SET_WORD {
                w[RAW_WORD.len()..].to_string()
            } else if PLAIN_WORD.is_match(w) {
                w.clone()
            } else {
                shell_quote(w)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Quote a path for a remote shell while letting a leading `~` expand.
pub fn tilde_quote(p: &str) -> String {
    if p.is_empty() || p == "~" {
        return "~".into();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return format!("~/{}", shell_quote(rest));
    }
    shell_quote(p)
}

/// ssh, never prompting, with a shared connection per host so a scan's many
/// git calls ride one session. The control socket lives in `control_dir`.
pub fn ssh_args(host: &str, control_dir: &str) -> Vec<String> {
    let dir = control_dir.trim_end_matches('/');
    [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ControlMaster=auto",
        "-o",
        &format!("ControlPath={dir}/ssh-%C"),
        "-o",
        "ControlPersist=120",
        "--",
        host,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// ssh hands the remote shell one string; quote each word so the remote sees
/// the argv we meant. Assumes a POSIX shell on the far side.
pub fn remote_command(cmd: &[String]) -> String {
    cmd.iter()
        .map(|w| shell_quote(w))
        .collect::<Vec<_>>()
        .join(" ")
}

static HOST_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Host\s+(.+)$").unwrap());
static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// The aliases in `~/.ssh/config`, minus patterns.
pub fn parse_ssh_hosts(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        let Some(m) = HOST_LINE.captures(line) else {
            continue;
        };
        for h in WS.split(&m[1]) {
            if !h.is_empty() && !h.contains(['*', '?', '!']) && !out.iter().any(|o| o == h) {
                out.push(h.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc(host: Option<&str>, path: &str) -> Locator {
        Locator {
            host: host.map(String::from),
            path: path.into(),
        }
    }

    #[test]
    fn a_plain_path_is_local() {
        assert_eq!(parse_locator("/Users/me/dev"), loc(None, "/Users/me/dev"));
        assert_eq!(to_locator(None, "/Users/me/dev"), "/Users/me/dev");
    }

    #[test]
    fn ssh_carries_the_host_and_keeps_the_absolute_path() {
        assert_eq!(
            parse_locator("ssh://wsl/home/me/dev"),
            loc(Some("wsl"), "/home/me/dev")
        );
        assert_eq!(
            to_locator(Some("wsl"), "/home/me/dev"),
            "ssh://wsl/home/me/dev"
        );
        assert_eq!(
            parse_locator(&to_locator(Some("a@b"), "/x")),
            loc(Some("a@b"), "/x")
        );
    }

    #[test]
    fn a_host_alone_means_its_root() {
        assert_eq!(parse_locator("ssh://wsl"), loc(Some("wsl"), "/"));
    }

    #[test]
    fn host_names() {
        assert!(is_ssh_host("wsl"));
        assert!(is_ssh_host("eric@macmini-2018.tail.ts.net"));
        assert!(!is_ssh_host("-oProxyCommand=evil"));
        assert!(!is_ssh_host("a host"));
        assert!(!is_ssh_host(""));
    }

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(tilde_quote("~"), "~");
        assert_eq!(tilde_quote("~/my dev"), "~/'my dev'");
        assert_eq!(tilde_quote("/abs/path"), "'/abs/path'");
        assert_eq!(tilde_quote(""), "~");
        let cmd: Vec<String> = ["git", "-C", "/a b", "status"].map(String::from).to_vec();
        assert_eq!(remote_command(&cmd), "'git' '-C' '/a b' 'status'");
    }

    #[test]
    fn ssh_never_prompts_and_shares_a_connection_per_host() {
        let args = ssh_args("wsl", "/tmp/cfg");
        assert_eq!(args[0], "ssh");
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ControlMaster=auto".to_string()));
        assert!(args.contains(&"ControlPath=/tmp/cfg/ssh-%C".to_string()));
        assert_eq!(&args[args.len() - 2..], ["--", "wsl"]);
        assert!(ssh_args("wsl", "/tmp/cfg/").contains(&"ControlPath=/tmp/cfg/ssh-%C".to_string()));
    }

    #[test]
    fn shell_lines_quote_only_what_needs_it() {
        let words: Vec<String> = vec![
            "claude".into(),
            "--model".into(),
            "a b".into(),
            TOKEN_SET_WORD.clone(),
        ];
        assert_eq!(
            shell_line(&words),
            "claude --model 'a b' 'shell_environment_policy.set.CANOPY_TOKEN=\"'\"$CANOPY_TOKEN\"'\"'"
        );
    }

    #[test]
    fn ssh_config_lists_aliases_skips_patterns_and_duplicates() {
        let text = "\nHost qnap qnap-lan\n  HostName 192.168.1.10\nHost *\n  ServerAliveInterval 30\nhost wsl\nHost qnap !qnap-lan\n";
        assert_eq!(parse_ssh_hosts(text), vec!["qnap", "qnap-lan", "wsl"]);
    }
}
