//! The pairing flow `canopy auth login` and `canopy helper --pair` share
//! (`pairFlow`, `saveToken`, `readHelperToken` and `pairLabel` in
//! `src/cli/auth.ts`): ask the backend for a pair request, get it approved
//! (in the inbox, or with the first code from the server's log), and keep
//! the token it mints in a 0600 file named for the backend.
//!
//! A stand-in, so `canopy helper` builds and is tested in this branch: the
//! `canopy auth` port writes this module, with these names and signatures,
//! and its copy is the one kept at the merge.

use crate::ask::{Client, fetch_words};
use canopy_core::pathx::{dirname, js_trim};
use reqwest::Method;
use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

/// How often a login asks whether it was approved.
pub const POLL: Duration = Duration::from_millis(2_000);
/// How long it waits.
pub const WINDOW: Duration = Duration::from_millis(10 * 60_000);

pub struct PairOptions<'a> {
    pub base: &'a str,
    pub label: &'a str,
    /// what the token is for, "cli" or "helper"; the server mints exactly this kind
    pub kind: &'a str,
    /// the first sign-in code from the server's log, when nobody can approve in a page
    pub code: Option<&'a str>,
    pub poll: Duration,
    pub window: Duration,
    pub say: &'a dyn Fn(&str),
}

/// One answer: its status and its body when that is a JSON object, else {}.
struct Answer {
    status: u16,
    body: Map<String, Value>,
}

/// `post()`: a JSON POST with the caller's token for `base`, no redirect
/// followed and no timeout.
async fn post(client: &Client, base: &str, path: &str, body: &Value) -> Result<Answer, String> {
    let url = format!("{base}{path}");
    let res = client
        .request(Method::POST, base, &url, None)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| fetch_words(&e, &url))?;
    let status = res.status().as_u16();
    if (300..400).contains(&status) {
        return Err(format!(
            "{base} sent a redirect to a sign-in; point --backend at canopy itself"
        ));
    }
    let text = res.text().await.unwrap_or_default();
    let body = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    };
    Ok(Answer { status, body })
}

/// `message()`: the backend's own error, else its status.
fn message(r: &Answer) -> String {
    match r.body.get("error") {
        Some(Value::String(e)) => e.clone(),
        _ => format!("the backend answered {}", r.status),
    }
}

fn string<'a>(r: &'a Answer, key: &str) -> Option<&'a str> {
    r.body.get(key).and_then(Value::as_str)
}

/// `pairFlow()`: pair, wait for approval, and return the minted token. Err
/// with a reason for a refusal, a denied or expired request, or the window
/// running out.
pub async fn pair_flow(client: &Client, opts: &PairOptions<'_>) -> Result<String, String> {
    let pair = post(
        client,
        opts.base,
        "/api/auth/pair",
        &json!({"label": opts.label, "kind": opts.kind}),
    )
    .await?;
    let (Some(id), Some(secret)) = (string(&pair, "id"), string(&pair, "secret")) else {
        return Err(message(&pair));
    };
    if pair.status != 200 {
        return Err(message(&pair));
    }
    (opts.say)(&format!(
        "pair code {}: approve it in the canopy inbox, or pass the first code from the server log with --code",
        string(&pair, "code").unwrap_or("?")
    ));
    if let Some(code) = opts.code.filter(|c| !c.is_empty()) {
        let first = post(
            client,
            opts.base,
            "/api/auth/first",
            &json!({"id": id, "code": code}),
        )
        .await?;
        if first.status != 200 {
            return Err(message(&first));
        }
    }
    let until = Instant::now() + opts.window;
    loop {
        let got = post(
            client,
            opts.base,
            "/api/auth/claim",
            &json!({"id": id, "secret": secret}),
        )
        .await?;
        if got.status == 200
            && let Some(token) = string(&got, "token")
        {
            return Ok(token.to_string());
        }
        if got.status != 200 || got.body.get("waiting") != Some(&Value::Bool(true)) {
            return Err(message(&got));
        }
        if Instant::now() >= until {
            return Err("timed out waiting for approval".into());
        }
        tokio::time::sleep(opts.poll).await;
    }
}

/// `saveToken()`: write a token with no one else able to read it, even for
/// a moment.
pub fn save_token(file: &str, token: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dirname(file))?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)?;
    f.write_all(format!("{token}\n").as_bytes())?;
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
}

/// `readHelperToken()`: the helper's token from its file, None when there
/// is none yet.
#[allow(dead_code)] // the helper loop reads it, and that is not ported yet
pub fn read_helper_token(file: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let t = js_trim(&text);
    (!t.is_empty()).then(|| t.to_string())
}

/// `pairLabel()`: the kind and this machine's name up to its first dot.
pub fn pair_label(kind: &str) -> String {
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    format!(
        "{kind} {}",
        host.split('.').next().unwrap_or("this machine")
    )
}
