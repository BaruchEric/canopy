//! Routes whose answer the Bun server decides by what this machine has:
//! the tasks need tmux, tailchan and its registry and asks need a broker's
//! address, and voice needs its keys. Where the Bun server would find none,
//! these say what it says. Where it would find one, the feature itself is
//! not in this port yet, so the route answers 501 like any other.

use axum::Json;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::collections::HashMap;

use crate::routes::not_ported;

/// what an env lookup gives: the value, unset or empty alike as None
type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

fn env_var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

const TMUX_PLACES: [&str; 3] = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
];

/// `tmuxBase() !== null`: tmux is on this machine and not turned off.
pub fn has_tmux(env: Env, found: &dyn Fn() -> bool) -> bool {
    env("CANOPY_TMUX").as_deref() != Some("0") && found()
}

fn tmux_found() -> bool {
    crate::harnesses::which("tmux").is_some()
        || TMUX_PLACES.iter().any(|p| std::path::Path::new(p).exists())
}

/// The lines of tailchan's own env file (`parseEnvFile` in core/chan.ts).
pub fn parse_env_file(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.split('\n') {
        let t = line.trim_start();
        let t = t
            .strip_prefix("export")
            .filter(|r| r.starts_with(char::is_whitespace))
            .map_or(t, str::trim_start);
        let Some((key, raw)) = t.split_once('=') else {
            continue;
        };
        let ok = key
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_uppercase() || b == b'_')
            && key
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        if !ok {
            continue;
        }
        let v = raw.trim();
        let b = v.as_bytes();
        let quoted = b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0];
        out.insert(
            key.to_string(),
            if quoted {
                v[1..v.len() - 1].to_string()
            } else {
                v.to_string()
            },
        );
    }
    out
}

/// The broker's address (`chanConfig`), or None when there is none that is
/// a URL: the first of CANOPY_TAILCHAN_URL, TAILCHAN_URL and the CLI's file.
pub fn chan_address(env: Env, file: &HashMap<String, String>) -> Option<String> {
    let url = env("CANOPY_TAILCHAN_URL")
        .or_else(|| env("TAILCHAN_URL"))
        .or_else(|| file.get("TAILCHAN_URL").filter(|v| !v.is_empty()).cloned())
        .unwrap_or_default();
    let url = url.trim_end_matches('/');
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    (!rest.is_empty() && !rest.contains(char::is_whitespace)).then(|| url.to_string())
}

fn chan_file() -> HashMap<String, String> {
    let dir = env_var("XDG_CONFIG_HOME")
        .unwrap_or_else(|| format!("{}/.config", std::env::var("HOME").unwrap_or_default()));
    std::fs::read_to_string(format!("{dir}/tailchan/env"))
        .map(|t| parse_env_file(&t))
        .unwrap_or_default()
}

/// What this machine has for the gated routes, read once at the start as
/// the Bun server reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gates {
    pub tmux: bool,
    pub chan: bool,
    pub voice: bool,
}

impl Gates {
    pub fn from_env() -> Gates {
        let env = |k: &str| env_var(k);
        let set = |k: &str| env_var(k).is_some_and(|v| !v.trim().is_empty());
        Gates {
            tmux: has_tmux(&env, &tmux_found),
            chan: chan_address(&env, &chan_file()).is_some(),
            voice: set("CANOPY_VOICE_KEY")
                || set("CANOPY_LIVE_KEY")
                || set("CANOPY_TRANSCRIBE_URL"),
        }
    }
}

const NO_BROKER: &str =
    "tailchan is not set up on this backend: set CANOPY_TAILCHAN_URL or TAILCHAN_URL";

fn refuse(status: u16, error: &str) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(json!({ "error": error }))).into_response()
}

/// The gated answer for a request, or None when the path is not gated or
/// the machine has what it needs (the route is then not ported).
pub fn answer(g: Gates, method: &Method, path: &str) -> Option<Response> {
    let get = method == Method::GET;
    let under = |root: &str| path == root || path.starts_with(&format!("{root}/"));
    if (path == "/api/tasks" || under("/api/repos/tasks")) && !g.tmux {
        return Some(refuse(503, "tasks need tmux on this backend"));
    }
    if under("/api/tailchan") && !g.chan {
        if path == "/api/tailchan" && get {
            let reason = "no tailchan address: set CANOPY_TAILCHAN_URL or TAILCHAN_URL";
            return Some(Json(json!({ "ready": false, "reason": reason })).into_response());
        }
        return Some(refuse(503, "tailchan is not set up on this backend"));
    }
    if path == "/api/registry" {
        if !get {
            return Some(refuse(404, &format!("no route: {method} {path}")));
        }
        if !g.chan {
            return Some(refuse(503, NO_BROKER));
        }
    }
    let asks = under("/api/asks")
        || path == "/api/presence"
        || path == "/api/presence/beat"
        || path == "/api/guards";
    if asks && !g.chan {
        return Some(refuse(503, NO_BROKER));
    }
    if path == "/api/voice" && get && !g.voice {
        return Some(
            Json(json!({ "model": null, "live": null, "dictate": false })).into_response(),
        );
    }
    if path == "/api/voice/dictate" && method == Method::POST && !g.voice {
        return Some(refuse(
            503,
            "dictation is off: this backend has no CANOPY_TRANSCRIBE_URL",
        ));
    }
    None
}

/// The fallback for every API path no route took: a gated answer, else 501.
pub async fn fallback(
    axum::extract::State(s): axum::extract::State<std::sync::Arc<crate::app::AppState>>,
    req: Request,
) -> Response {
    let (method, path) = (req.method().clone(), req.uri().path().to_string());
    match answer(s.gates, &method, &path) {
        Some(r) => r,
        None => not_ported(method, req.uri().clone()).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
                .filter(|v| !v.is_empty())
        }
    }

    #[test]
    fn tmux_is_off_when_asked_or_missing() {
        assert!(!has_tmux(&env(&[("CANOPY_TMUX", "0")]), &|| true));
        assert!(!has_tmux(&env(&[]), &|| false));
        assert!(has_tmux(&env(&[("CANOPY_TMUX", "1")]), &|| true));
    }

    #[test]
    fn the_broker_address_is_the_first_one_given_and_must_be_a_url() {
        let none = HashMap::new();
        assert_eq!(
            chan_address(
                &env(&[("CANOPY_TAILCHAN_URL", "off"), ("TAILCHAN_URL", "http://b")]),
                &none
            ),
            None
        );
        assert_eq!(
            chan_address(&env(&[("TAILCHAN_URL", "http://b:7855//")]), &none).as_deref(),
            Some("http://b:7855")
        );
        let file = parse_env_file(
            "# tailchan\nexport TAILCHAN_URL=\"https://chan.example\"\nTAILCHAN_HUMAN='eric'\nlower=x\n",
        );
        assert_eq!(file.get("TAILCHAN_HUMAN").map(String::as_str), Some("eric"));
        assert!(!file.contains_key("lower"));
        assert_eq!(
            chan_address(&env(&[]), &file).as_deref(),
            Some("https://chan.example")
        );
        assert_eq!(
            chan_address(&env(&[("CANOPY_TAILCHAN_URL", "http://a b")]), &none),
            None
        );
    }

    #[test]
    fn a_machine_without_them_answers_as_the_bun_server_does() {
        let off = Gates {
            tmux: false,
            chan: false,
            voice: false,
        };
        let status = |m: Method, p: &str| answer(off, &m, p).map(|r| r.status().as_u16());
        assert_eq!(status(Method::GET, "/api/tasks"), Some(503));
        assert_eq!(status(Method::POST, "/api/repos/tasks/stop"), Some(503));
        assert_eq!(status(Method::GET, "/api/tailchan"), Some(200));
        assert_eq!(status(Method::POST, "/api/tailchan/send"), Some(503));
        assert_eq!(status(Method::GET, "/api/registry"), Some(503));
        assert_eq!(status(Method::POST, "/api/registry"), Some(404));
        assert_eq!(status(Method::GET, "/api/asks"), Some(503));
        assert_eq!(status(Method::PUT, "/api/guards"), Some(503));
        assert_eq!(status(Method::GET, "/api/voice"), Some(200));
        assert_eq!(status(Method::POST, "/api/voice/live"), None);
        assert_eq!(status(Method::GET, "/api/tasksx"), None);
        let on = Gates {
            tmux: true,
            chan: true,
            voice: true,
        };
        for p in [
            "/api/tasks",
            "/api/tailchan",
            "/api/registry",
            "/api/asks",
            "/api/voice",
        ] {
            assert!(answer(on, &Method::GET, p).is_none(), "{p}");
        }
    }
}
