//! How the CLI addresses a canopy backend and proves who is calling
//! (`src/cli/api.ts`): the backend's origin, the token file kept per host
//! and port, and the X-Canopy-Token header every call carries.
//!
//! The TypeScript reads the environment and two module-level settings (the
//! `--token` flag and the `--backend` it was pointed at) wherever it needs
//! them. Here they sit in one `Caller`, read once in main, so a test can
//! hand it a scratch config dir and token without touching the process's
//! environment.

use canopy_core::pathx::{join, js_trim};
use canopy_core::store::config_dir;
use reqwest::Url;

/// The local backend, when neither `--backend` nor $CANOPY_API says another.
pub const LOCAL: &str = "http://127.0.0.1:7850";

#[derive(Debug, Clone, Default)]
pub struct Caller {
    /// `configDir()`: $CANOPY_CONFIG_DIR, else ~/.config/canopy.
    pub config_dir: String,
    /// $CANOPY_API.
    pub env_api: Option<String>,
    /// $CANOPY_TOKEN.
    pub env_token: Option<String>,
    /// `--token`, for the whole run (`setTokenFlag`).
    pub flag_token: Option<String>,
    /// The `--backend` this command was pointed at (`setHomeBase`).
    pub home_base: Option<String>,
}

impl Caller {
    /// The process's own environment, with the run's `--token` and
    /// `--backend`.
    pub fn from_env(flag_token: Option<String>, home_base: Option<String>) -> Self {
        Caller {
            config_dir: config_dir(),
            env_api: std::env::var("CANOPY_API").ok(),
            env_token: std::env::var("CANOPY_TOKEN").ok(),
            flag_token,
            home_base,
        }
    }

    /// `apiBase()`: the `--backend` value, else $CANOPY_API, else the local
    /// backend, without trailing slashes.
    pub fn api_base(&self, given: Option<&str>) -> String {
        let base = given.or(self.env_api.as_deref()).unwrap_or(LOCAL);
        base.trim_end_matches('/').to_string()
    }

    /// `tokenFile()`: where `canopy auth login` keeps the token for a
    /// backend, one file per host and port. None for a base that is not a
    /// URL, where the TypeScript throws.
    pub fn token_file(&self, base: &str) -> Option<String> {
        let u = Url::parse(base).ok()?;
        let port = match u.port() {
            Some(p) => p.to_string(),
            None if u.scheme() == "https" => "443".into(),
            None => "80".into(),
        };
        let host = u.host_str().unwrap_or("");
        Some(join(&self.config_dir, &format!("token-{host}-{port}")))
    }

    /// `callerToken()`: the backend's own token file first for any base; the
    /// flag and $CANOPY_TOKEN only for the home base, so a peer or a
    /// fallback address never gets a token that was meant for another
    /// backend.
    pub fn caller_token(&self, base: &str, flag: Option<&str>) -> Option<String> {
        let home = same_origin(base, &self.api_base(self.home_base.as_deref()));
        let given = flag.or(if home {
            self.flag_token.as_deref()
        } else {
            None
        });
        if let Some(g) = given.map(js_trim).filter(|g| !g.is_empty()) {
            return Some(g.to_string());
        }
        if let Some(text) = self
            .token_file(base)
            .and_then(|f| std::fs::read_to_string(f).ok())
        {
            let filed = js_trim(&text);
            if !filed.is_empty() {
                return Some(filed.to_string());
            }
        }
        if !home {
            return None;
        }
        self.env_token
            .as_deref()
            .map(js_trim)
            .filter(|t| !t.is_empty())
            .map(String::from)
    }
}

/// `new URL(a).origin === new URL(b).origin`, false when either is not a
/// URL. An opaque origin reads "null" on both sides, as in JavaScript.
fn same_origin(a: &str, b: &str) -> bool {
    match (Url::parse(a), Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin().ascii_serialization() == b.origin().ascii_serialization(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> (tempdir::Dir, Caller) {
        let dir = tempdir::Dir::new("canopy-cliapi");
        let caller = Caller {
            config_dir: join(&dir.0, "cfg"),
            ..Default::default()
        };
        (dir, caller)
    }

    /// a scratch folder removed on drop
    mod tempdir {
        pub struct Dir(pub String);
        impl Dir {
            pub fn new(prefix: &str) -> Self {
                static NEXT: std::sync::atomic::AtomicUsize =
                    std::sync::atomic::AtomicUsize::new(0);
                let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let p = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p.to_string_lossy().into_owned())
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn api_base_is_the_given_origin_else_canopy_api_else_the_local_default() {
        let mut c = Caller::default();
        assert_eq!(c.api_base(None), "http://127.0.0.1:7850");
        c.env_api = Some("http://mini:7850//".into());
        assert_eq!(c.api_base(None), "http://mini:7850");
        assert_eq!(c.api_base(Some("http://other:1/")), "http://other:1");
    }

    #[test]
    fn token_file_is_named_for_the_host_and_port() {
        let (_d, c) = scratch();
        let cfg = &c.config_dir;
        assert_eq!(
            c.token_file("http://127.0.0.1:7850/").unwrap(),
            format!("{cfg}/token-127.0.0.1-7850")
        );
        assert_eq!(
            c.token_file("http://mini").unwrap(),
            format!("{cfg}/token-mini-80")
        );
        assert_eq!(
            c.token_file("https://canopy.example.ca").unwrap(),
            format!("{cfg}/token-canopy.example.ca-443")
        );
        assert_eq!(c.token_file("not a url"), None);
    }

    #[test]
    fn the_flag_first_then_the_file_then_the_environment() {
        let (_d, mut c) = scratch();
        let base = "http://127.0.0.1:7850";
        std::fs::create_dir_all(&c.config_dir).unwrap();
        c.env_token = Some("from-env".into());
        assert_eq!(c.caller_token(base, None).as_deref(), Some("from-env"));
        std::fs::write(c.token_file(base).unwrap(), "from-file\n").unwrap();
        assert_eq!(c.caller_token(base, None).as_deref(), Some("from-file"));
        assert_eq!(
            c.caller_token(base, Some("from-flag")).as_deref(),
            Some("from-flag")
        );
        c.flag_token = Some("global-flag".into());
        assert_eq!(c.caller_token(base, None).as_deref(), Some("global-flag"));
    }

    #[test]
    fn a_file_holding_only_whitespace_counts_as_no_token() {
        let (_d, mut c) = scratch();
        let base = "http://127.0.0.1:7850";
        std::fs::create_dir_all(&c.config_dir).unwrap();
        std::fs::write(c.token_file(base).unwrap(), " \n\t\n").unwrap();
        assert_eq!(c.caller_token(base, None), None);
        c.env_token = Some("from-env".into());
        assert_eq!(c.caller_token(base, None).as_deref(), Some("from-env"));
    }

    #[test]
    fn the_flag_and_the_environment_reach_the_home_base_and_a_peer_needs_its_own_file() {
        let (_d, mut c) = scratch();
        let home = "http://127.0.0.1:7850";
        let peer = "http://mini:7850";
        c.env_token = Some("from-env".into());
        c.flag_token = Some("from-flag".into());
        assert_eq!(c.caller_token(home, None).as_deref(), Some("from-flag"));
        assert_eq!(c.caller_token(peer, None), None);
        c.flag_token = None;
        assert_eq!(c.caller_token(home, None).as_deref(), Some("from-env"));
        assert_eq!(c.caller_token(peer, None), None);
        c.home_base = Some(peer.into());
        assert_eq!(c.caller_token(peer, None).as_deref(), Some("from-env"));
        assert_eq!(c.caller_token(home, None), None);
        c.home_base = None;
        std::fs::create_dir_all(&c.config_dir).unwrap();
        std::fs::write(c.token_file(peer).unwrap(), "peer-own\n").unwrap();
        assert_eq!(c.caller_token(peer, None).as_deref(), Some("peer-own"));
    }

    #[test]
    fn origins_compare_as_javascript_compares_them() {
        assert!(same_origin("http://a:1/x", "http://a:1"));
        assert!(same_origin("http://a:80/", "http://a"));
        assert!(!same_origin("http://a:1", "https://a:1"));
        assert!(!same_origin("not a url", "not a url"));
        assert!(same_origin("foo://x", "bar://y"));
    }
}
