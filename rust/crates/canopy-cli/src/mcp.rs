//! `canopy mcp` (`src/cli/mcp.ts`): the process around `canopymcp.rs`. It
//! asks the backend who its token is (`GET /api/auth`), then either lists
//! the tools that kind holds (`canopy mcp tools`) or serves them as an MCP
//! server on stdin and stdout, one JSON-RPC message a line, until stdin
//! ends. Every call is one request through `ask::Client::request_as` with
//! the session's own token (`mcpToken`), a 30-second timeout and no
//! redirect followed; a refusal is never retried.

use crate::api::Caller;
use crate::ask::{Client, fetch_words, take};
use crate::canopymcp::{CanopyApi, McpContext, serve, tools_for};
use crate::out::Out;
use canopy_auth::CallerKind;
use canopy_core::pathx::{js_trim, pad_end};
use canopy_core::version::{canopy_dir, read_build, version_line};
use reqwest::Method;
use serde_json::Value;
use std::time::Duration;

/// `MCP_USAGE`.
pub const MCP_USAGE: &str = "usage: canopy mcp [--backend URL] [--run-config FILE]\n       canopy mcp tools [--backend URL]";

/// The three variables `canopy mcp` reads: from the process, or from a
/// run's `mcp.json` (`runConfigEnv`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McpEnv {
    pub api: Option<String>,
    pub token: Option<String>,
    pub run: Option<String>,
}

impl McpEnv {
    /// The process's own.
    pub fn from_process() -> Self {
        McpEnv {
            api: std::env::var("CANOPY_API").ok(),
            token: std::env::var("CANOPY_TOKEN").ok(),
            run: std::env::var("CANOPY_RUN").ok(),
        }
    }
}

/// `mcpToken()`: the session's token wins over a CLI token saved on the
/// same machine. A run's server takes no other: on the Mac the file holds
/// an admin token, and a run whose own went missing must get nothing rather
/// than that.
pub fn mcp_token(base: &str, env: &McpEnv, caller: &Caller) -> Option<String> {
    if let Some(own) = env.token.as_deref().map(js_trim).filter(|t| !t.is_empty()) {
        return Some(own.to_string());
    }
    if env
        .run
        .as_deref()
        .map(js_trim)
        .is_some_and(|r| !r.is_empty())
    {
        return None;
    }
    caller.caller_token(base, None)
}

/// What `JSON.parse` throws, in the words Bun's engine uses for the usual
/// cases: an empty or cut-off text, a bare word, and anything else.
fn json_error(text: &str, e: &serde_json::Error) -> String {
    let t = js_trim(text);
    let word: String = t
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    let why = if t.is_empty() || (e.is_eof() && !t.starts_with('{')) {
        "Unexpected EOF".to_string()
    } else if !word.is_empty()
        && !word.starts_with(|c: char| c.is_ascii_digit())
        && !["true", "false", "null"].contains(&word.as_str())
    {
        format!("Unexpected identifier \"{word}\"")
    } else if t == "{" {
        "Expected '}'".to_string()
    } else {
        "Unable to parse JSON string".to_string()
    };
    format!("JSON Parse error: {why}")
}

/// `runConfigEnv()`: the environment a run's `mcp.json` holds, for a harness
/// that cannot hand the server an env without putting the token on argv.
/// Err on a file that is not one: a run's server takes that file's token or
/// none.
pub fn run_config_env(text: &str) -> Result<McpEnv, String> {
    let parsed: Value = serde_json::from_str(text).map_err(|e| json_error(text, &e))?;
    let env = parsed
        .get("mcpServers")
        .filter(|v| v.is_object())
        .and_then(|s| s.get("canopy"))
        .filter(|v| v.is_object())
        .and_then(|c| c.get("env"))
        .filter(|v| v.is_object());
    let s = |k: &str| {
        env.and_then(|e| e.get(k))
            .and_then(Value::as_str)
            .map(String::from)
    };
    match (s("CANOPY_API"), s("CANOPY_TOKEN"), s("CANOPY_RUN")) {
        (Some(api), Some(token), Some(run)) => Ok(McpEnv {
            api: Some(api),
            token: Some(token),
            run: Some(run),
        }),
        _ => Err("it is not a run's canopy config".into()),
    }
}

/// `Bun.file(file).text()`'s failure, as Bun words it.
fn read_text(file: &str) -> Result<String, String> {
    match std::fs::metadata(file) {
        Ok(m) if m.is_dir() => return Err("Directories cannot be read like files".into()),
        _ => {}
    }
    std::fs::read(file)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                format!("ENOENT: no such file or directory, open '{file}'")
            }
            std::io::ErrorKind::PermissionDenied => {
                format!("EACCES: permission denied, open '{file}'")
            }
            _ => e.to_string(),
        })
}

/// `apiOver()`: one HTTP request per call. A refusal or redirect is never
/// retried.
pub(crate) struct ApiOver<'a> {
    pub client: &'a Client,
    pub base: String,
    pub token: Option<String>,
}

/// `apiOver`'s timeout.
const API_TIMEOUT: Duration = Duration::from_secs(30);

impl CanopyApi for ApiOver<'_> {
    async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let url = format!("{}{path}", self.base);
        let method = Method::from_bytes(method.as_bytes()).unwrap_or(Method::GET);
        let mut req =
            self.client
                .request_as(method, &url, Some(API_TIMEOUT), self.token.as_deref());
        if let Some(b) = body {
            req = req
                .header("content-type", "application/json")
                .body(b.to_string());
        }
        let res = req.send().await.map_err(|e| fetch_words(&e, &url))?;
        let status = res.status();
        let data: Value = match res.text().await {
            Ok(text) => serde_json::from_str(&text).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        if !status.is_success() {
            return Err(match data.get("error") {
                Some(Value::String(e)) => e.clone(),
                _ => format!("{} answered {}", self.base, status.as_u16()),
            });
        }
        Ok(data)
    }
}

/// `toolLines()`: `canopy mcp tools`'s listing.
pub fn tool_lines(kind: CallerKind, base: &str, enforced: bool) -> Vec<String> {
    let tools = tools_for(kind, enforced);
    let head = format!("tools for a {kind} token on {base}");
    // nothing to list under enforce means nobody signed in: say how
    if tools.is_empty() && kind == CallerKind::None {
        return vec![
            head,
            format!(
                "  none: {base} checks who calls it. Sign in with: canopy auth login --backend {base}"
            ),
        ];
    }
    let mut out = vec![head];
    out.extend(tools.iter().map(|t| {
        format!(
            "  {}  {}  {}",
            pad_end(t.name, 15),
            pad_end(t.right.as_str(), 8),
            t.description
        )
    }));
    out
}

/// `enforces()`: whether a backend's `/api/auth` says it refuses a caller
/// it does not know. Only `log` and `off` say otherwise; a mode this build
/// has not heard of counts as enforcing, the side that lists less.
pub fn enforces(mode: Option<&Value>) -> bool {
    !matches!(mode.and_then(Value::as_str), Some("log" | "off"))
}

/// A flag present with nothing, or nothing truthy, after it.
fn bare(args: &[String], flag: &str) -> bool {
    args.iter()
        .position(|a| a == flag)
        .is_some_and(|i| args.get(i + 1).is_none_or(|v| v.is_empty()))
}

/// `mcpCommand()`. The server reads `input` and writes each reply line to
/// `write`; the listing goes to `out`.
pub(crate) async fn mcp_cmd<R: tokio::io::AsyncRead + Unpin>(
    mut args: Vec<String>,
    caller: &Caller,
    client: &Client,
    out: &mut Out,
    process: McpEnv,
    input: R,
    write: &mut dyn FnMut(String),
) -> Result<(), String> {
    if bare(&args, "--backend") || bare(&args, "--run-config") {
        return Err(MCP_USAGE.into());
    }
    let file = take(&mut args, "--run-config");
    let held = match &file {
        Some(f) => Some(
            read_text(f)
                .and_then(|t| run_config_env(&t))
                .map_err(|e| format!("canopy mcp: {f}: {e}"))?,
        ),
        None => None,
    };
    let given = take(&mut args, "--backend").or_else(|| held.as_ref().and_then(|h| h.api.clone()));
    let base = caller.api_base(given.as_deref());
    if args.len() > 1 || (args.len() == 1 && args[0] != "tools") {
        return Err(MCP_USAGE.into());
    }
    let env = held.unwrap_or(process);
    let api = ApiOver {
        client,
        token: mcp_token(&base, &env, caller),
        base: base.clone(),
    };
    let auth = api
        .call("GET", "/api/auth", None)
        .await
        .map_err(|e| format!("canopy mcp: {base} did not answer: {e}"))?;
    let kind = auth
        .as_object()
        .and_then(|a| a.get("you"))
        .and_then(Value::as_str)
        .and_then(CallerKind::parse)
        .ok_or_else(|| format!("canopy mcp: {base} did not answer with a caller kind"))?;
    let enforced = enforces(auth.get("mode"));
    if args.first().is_some_and(|a| a == "tools") {
        out.lines(tool_lines(kind, &base, enforced));
        return Ok(());
    }
    let ctx = McpContext {
        api: &api,
        kind,
        enforced,
        run: env.run.clone(),
        version: version_line(&read_build(&canopy_dir())),
    };
    serve(input, write, &ctx).await;
    Ok(())
}

#[cfg(test)]
mod tests;
