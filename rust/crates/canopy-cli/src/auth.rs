//! `canopy auth login | join | logout | status` (`src/cli/auth.ts`): sign
//! this machine's CLI in to a backend and keep the token it mints in a 0600
//! file named for the backend's host and port (`Caller::token_file`). The
//! pairing itself (`pairFlow`, `saveToken`) is in `pair.rs`, which
//! `canopy helper --pair` shares. Every request goes through
//! `ask::Client::request` with no timeout and no redirect followed, as
//! auth.ts's own fetches send them; a backend that does not answer is worded
//! as Bun's fetch words it.

use crate::api::Caller;
use crate::ask::Client;
use crate::out::Out;
use crate::pair::{POLL, PairOptions, WINDOW, message, pair_flow, pair_label, post, save_token};
use crate::render::Paint;
use canopy_core::js::{field, list_at, truthy};
use reqwest::Method;
use serde_json::{Value, json};

/// `AUTH_USAGE`.
pub const AUTH_USAGE: &str = "usage: canopy auth login [--backend URL] [--code CODE]\n       canopy auth join <invite code> [--backend URL]\n       canopy auth logout [--backend URL]\n       canopy auth status [--backend URL]";

/// `statusWords()`: `auth status`'s line: the mode, the caller's kind,
/// whose it is, what it holds and where. `person`, `rights` and `scope` are
/// absent from a backend older than people, and read as nothing.
pub fn status_words(a: &Value) -> String {
    let who = a
        .get("person")
        .filter(|p| truthy(Some(p)))
        .map_or(String::new(), |p| {
            format!("  {} ({})", field(p, "name"), field(p, "role"))
        });
    let holds = a
        .get("rights")
        .filter(|r| truthy(Some(r)))
        .map_or(String::new(), |r| {
            let j = canopy_core::js::join(r.as_array().map_or(&[][..], Vec::as_slice), ", ");
            format!("  holds {}", if j.is_empty() { "nothing" } else { &j })
        });
    let scope = list_at(a, "scope");
    let held = if scope.is_empty() {
        String::new()
    } else {
        format!("  only in {}", canopy_core::js::join(scope, ", "))
    };
    let refused = a.get("refused").unwrap_or(&Value::Null);
    format!(
        "mode {}  you {}{who}{holds}{held}  refused {}",
        field(a, "mode"),
        field(a, "you"),
        field(refused, "count")
    )
}

/// What `auth_cmd` needs beyond the backend: the palette, where a login's
/// pair code goes the moment it is known, and how long a login polls.
pub(crate) struct AuthEnv<'a> {
    pub paint: Paint,
    pub live: &'a dyn Fn(String),
    pub poll: std::time::Duration,
    pub window: std::time::Duration,
}

impl<'a> AuthEnv<'a> {
    pub fn new(paint: Paint, live: &'a dyn Fn(String)) -> Self {
        AuthEnv {
            paint,
            live,
            poll: POLL,
            window: WINDOW,
        }
    }
}

/// `tokenFile(base)`, where `new URL(base)` throws "Invalid URL" for a base
/// that is not one.
fn token_file(caller: &Caller, base: &str) -> Result<String, String> {
    caller
        .token_file(base)
        .ok_or_else(|| "Invalid URL".to_string())
}

/// `saveToken()`'s failure, as Node words the usual ones.
fn save(file: &str, token: &str) -> Result<(), String> {
    save_token(file, token).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, open '{file}'")
        }
        _ => e.to_string(),
    })
}

/// `GET /api/auth`, as `info()` asks it: any failure to answer is one line.
async fn info(client: &Client, base: &str) -> Result<Value, String> {
    let url = format!("{base}/api/auth");
    let Ok(res) = client.request(Method::GET, base, &url, None).send().await else {
        return Err(format!("{base} did not answer"));
    };
    let status = res.status();
    if !status.is_success() {
        return Err(format!("{base} answered {} to /api/auth", status.as_u16()));
    }
    let text = res.text().await.unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| "JSON Parse error: Unable to parse JSON string".into())
}

/// `authCommand()`.
pub(crate) async fn auth_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    client: &Client,
    out: &mut Out,
    env: &AuthEnv<'_>,
) -> Result<(), String> {
    let p = env.paint;
    let given = crate::opt(&mut args, "--backend");
    let base = caller.api_base(given.as_deref());
    let code = crate::opt(&mut args, "--code");
    let sub = args.first().cloned().unwrap_or_default();
    match sub.as_str() {
        "login" => {
            let label = pair_label("cli");
            let say = |l: &str| (env.live)(format!("{} {l}", p.lichen("canopy auth")));
            let token = pair_flow(
                client,
                &PairOptions {
                    base: &base,
                    label: &label,
                    kind: "cli",
                    code: code.as_deref().filter(|c| !c.is_empty()),
                    poll: env.poll,
                    window: env.window,
                    say: &say,
                },
            )
            .await
            .map_err(|e| format!("sign-in failed: {e}"))?;
            let file = token_file(caller, &base)?;
            save(&file, &token)?;
            out.line(format!(
                "{} {} {} {}",
                p.moss("signed in"),
                p.dim("→"),
                p.sky(&base),
                p.dim(&format!("(token kept in {file})"))
            ));
            Ok(())
        }
        "join" => {
            // an invite traded for this machine's CLI token, of the
            // invite's person (FR-074)
            let invite = args.get(1).filter(|i| !i.is_empty()).cloned();
            let Some(invite) = invite.filter(|_| args.len() <= 2) else {
                return Err(AUTH_USAGE.into());
            };
            let body = json!({"code": invite, "label": pair_label("cli"), "kind": "cli"});
            let res = post(client, &base, "/api/auth/join", &body)
                .await
                .map_err(|e| format!("could not join: {e}"))?;
            let token = match res.body.get("token") {
                Some(Value::String(t)) if res.status == 200 => t.clone(),
                _ => return Err(format!("could not join: {}", message(&res))),
            };
            let file = token_file(caller, &base)?;
            save(&file, &token)?;
            let name = match res.body.get("person") {
                Some(Value::String(n)) => n.clone(),
                _ => "someone".into(),
            };
            out.line(format!(
                "{} {} {name} {} {} {}",
                p.moss("signed in"),
                p.dim("as"),
                p.dim("→"),
                p.sky(&base),
                p.dim(&format!("(token kept in {file})"))
            ));
            Ok(())
        }
        "status" => {
            let a = info(client, &base).await?;
            out.line(format!("{}  {}", p.sky(&base), status_words(&a)));
            Ok(())
        }
        "logout" => {
            let file = token_file(caller, &base)?;
            let a = info(client, &base).await?;
            if a.get("youId") == Some(&Value::Null) {
                let _ = std::fs::remove_file(&file);
                out.line(format!(
                    "{} {}{}",
                    p.dim("no signed-in caller at"),
                    p.sky(&base),
                    p.dim("; removed the token file if there was one")
                ));
                return Ok(());
            }
            // a session ends itself whatever its role; a backend from before
            // people has no such route, and there revoke is the way
            let mut res = post(client, &base, "/api/auth/signout", &json!({}))
                .await
                .map_err(|e| format!("could not revoke: {e}"))?;
            if res.status == 404 {
                let body = match a.get("youId") {
                    Some(id) => json!({ "id": id }),
                    None => json!({}),
                };
                res = post(client, &base, "/api/auth/revoke", &body)
                    .await
                    .map_err(|e| format!("could not revoke: {e}"))?;
            }
            let _ = std::fs::remove_file(&file);
            match res.status {
                200 => out.line(format!(
                    "{} {} {}",
                    p.moss("signed out"),
                    p.dim("of"),
                    p.sky(&base)
                )),
                403 => out.line(format!(
                    "{}{}",
                    p.lichen("removed the token file"),
                    p.dim("; this token cannot revoke itself, so the session stays on the server until a page revokes it")
                )),
                _ => {
                    return Err(format!(
                        "removed the token file, but the server said: {}",
                        message(&res)
                    ));
                }
            }
            Ok(())
        }
        _ => Err(AUTH_USAGE.into()),
    }
}

#[cfg(test)]
mod tests;
