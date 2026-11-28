//! Owner and repo out of a git remote, and the remote as a web page
//! (`src/core/remote.ts`).

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRef {
    pub host: String,
    pub owner: String,
    pub name: String,
}

static SCHEMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://(?:[^@/]+@)?([^:/\s]+)(?::\d+)?/(.+)$").unwrap()
});
static SCP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^@\s]+@([^:\s]+):([^/\s]+)/(.+)$").unwrap());

/// Owner and repo out of the URL shapes git remotes actually take.
pub fn parse_remote(url: &str) -> Option<RemoteRef> {
    let trimmed = url.trim();
    let clean = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    // A scheme first: the scp pattern would swallow "ssh://git" as its user
    // part and read the port as the owner.
    if clean.contains("://") {
        let m = SCHEMED.captures(clean)?;
        let parts: Vec<&str> = m[2].split('/').filter(|p| !p.is_empty()).collect();
        let n = parts.len();
        if n >= 2 {
            return Some(RemoteRef {
                host: m[1].to_string(),
                owner: parts[n - 2].to_string(),
                name: parts[n - 1].to_string(),
            });
        }
        return None;
    }
    let m = SCP.captures(clean)?;
    Some(RemoteRef {
        host: m[1].to_string(),
        owner: m[2].to_string(),
        name: m[3].to_string(),
    })
}

static GITHUB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|\.)github\.com$").unwrap());

pub fn is_github(host: &str) -> bool {
    GITHUB.is_match(host)
}

/// Forges that serve the same owner/name path over https as over ssh.
static WEB_FORGES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht)$")
        .unwrap()
});

/// A remote on no public forge: the user's own server or a path here.
pub fn is_self_hosted(url: &str) -> bool {
    parse_remote(url).is_none_or(|r| !WEB_FORGES.is_match(&r.host))
}

static HTTP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").unwrap());

/// The remote as a page you can open, or None when we cannot tell. An https
/// remote keeps its own host, so a self-hosted forge works; ssh and scp
/// remotes only map for the forges above.
pub fn web_url(url: &str) -> Option<String> {
    let clean = url.trim();
    let r = parse_remote(clean)?;
    if HTTP.is_match(clean) {
        let mut u = url::Url::parse(clean).ok()?;
        // credentials belong in the remote, never in a link the UI renders
        let _ = u.set_username("");
        let _ = u.set_password(None);
        u.set_query(None);
        u.set_fragment(None);
        let _ = u.set_scheme("https");
        let path = u.path().to_string();
        let path = path
            .strip_suffix(".git")
            .unwrap_or(&path)
            .trim_end_matches('/')
            .to_string();
        u.set_path(&path);
        let s = u.to_string();
        return Some(s.strip_suffix('/').map(String::from).unwrap_or(s));
    }
    if !WEB_FORGES.is_match(&r.host) {
        return None;
    }
    Some(format!("https://{}/{}/{}", r.host, r.owner, r.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rr(host: &str, owner: &str, name: &str) -> Option<RemoteRef> {
        Some(RemoteRef {
            host: host.into(),
            owner: owner.into(),
            name: name.into(),
        })
    }

    #[test]
    fn reads_the_url_shapes_git_remotes_take() {
        assert_eq!(
            parse_remote("https://github.com/nateherkai/AIS-OS"),
            rr("github.com", "nateherkai", "AIS-OS")
        );
        assert_eq!(
            parse_remote("https://github.com/BaruchEric/canopy.git"),
            rr("github.com", "BaruchEric", "canopy")
        );
        assert_eq!(
            parse_remote("git@github.com:BuilderIO/skills.git"),
            rr("github.com", "BuilderIO", "skills")
        );
        assert_eq!(
            parse_remote("ssh://git@192.168.1.10:2222/eric/_devhub.git"),
            rr("192.168.1.10", "eric", "_devhub")
        );
        for bad in ["", "not a url", "https://github.com/onlyowner"] {
            assert_eq!(parse_remote(bad), None, "{bad}");
        }
    }

    #[test]
    fn github_and_lookalikes() {
        assert!(is_github("github.com"));
        assert!(is_github("www.github.com"));
        for host in [
            "notgithub.com",
            "github.com.evil.test",
            "gitlab.com",
            "192.168.1.10",
        ] {
            assert!(!is_github(host), "{host}");
        }
    }

    #[test]
    fn web_urls() {
        assert_eq!(
            web_url("git@github.com:BaruchEric/canopy.git").as_deref(),
            Some("https://github.com/BaruchEric/canopy")
        );
        assert_eq!(
            web_url("https://github.com/BaruchEric/canopy.git").as_deref(),
            Some("https://github.com/BaruchEric/canopy")
        );
        assert_eq!(
            web_url("git@gitlab.com:group/thing.git").as_deref(),
            Some("https://gitlab.com/group/thing")
        );
        assert_eq!(
            web_url("ssh://git@codeberg.org/eric/thing.git").as_deref(),
            Some("https://codeberg.org/eric/thing")
        );
        assert_eq!(
            web_url("https://git.example.test:8443/team/sub/thing.git").as_deref(),
            Some("https://git.example.test:8443/team/sub/thing")
        );
        assert_eq!(
            web_url("http://eric:t0ken@git.example.test/eric/thing").as_deref(),
            Some("https://git.example.test/eric/thing")
        );
        assert_eq!(
            web_url("ssh://git@192.168.1.10:2222/eric/_devhub.git"),
            None
        );
        assert_eq!(web_url("git@git.internal.test:eric/thing.git"), None);
        assert_eq!(web_url("/srv/git/thing.git"), None);
        assert_eq!(web_url(""), None);
    }

    #[test]
    fn self_hosted() {
        assert!(is_self_hosted(
            "ssh://git@192.168.1.76:2222/eric/DigitalMe.git"
        ));
        assert!(is_self_hosted("https://git.beric.ca/eric/thing.git"));
        assert!(is_self_hosted("/Users/e/dev/other"));
        assert!(!is_self_hosted("git@github.com:BaruchEric/canopy.git"));
        assert!(!is_self_hosted("https://gitlab.com/someone/thing"));
        assert!(!is_self_hosted("https://codeberg.org/someone/thing"));
    }
}
