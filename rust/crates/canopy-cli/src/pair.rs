//! The pairing flow `canopy auth login` and `canopy helper --pair` share
//! (`pairFlow`, `saveToken`, `readHelperToken` and `pairLabel` in
//! src/cli/auth.ts): ask the backend for a pair request, get it approved
//! (in the inbox, or with the first code from the server's log), and keep
//! the token it mints in a 0600 file named for the backend. Every request
//! goes through `ask::Client::request`, with the caller's token for that
//! backend, no redirect followed and no timeout, as auth.ts's `post` sends
//! it.

use crate::ask::{Client, fetch_words};
use reqwest::Method;
use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

/// How often a login asks whether it was approved.
pub const POLL: Duration = Duration::from_millis(2_000);
/// How long a login waits for approval.
pub const WINDOW: Duration = Duration::from_secs(10 * 60);

/// `PairOptions`.
pub struct PairOptions<'a> {
    pub base: &'a str,
    pub label: &'a str,
    /// what the token is for, "cli" or "helper"; the server mints exactly
    /// this kind
    pub kind: &'a str,
    /// the first sign-in code from the server's log, when nobody can
    /// approve in a page
    pub code: Option<&'a str>,
    pub poll: Duration,
    pub window: Duration,
    pub say: &'a dyn Fn(&str),
}

/// What a POST to an auth route answered: its status and its body when
/// that was a JSON object, else an empty one.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Posted {
    pub status: u16,
    pub body: Map<String, Value>,
}

/// auth.ts's `post()`: one JSON POST to `base + path`. Err is the thrown
/// error's message: Bun's words for an address that does not answer, or
/// the refusal of a redirect.
pub(crate) async fn post(
    client: &Client,
    base: &str,
    path: &str,
    body: &Value,
) -> Result<Posted, String> {
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
        Ok(Value::Object(o)) => o,
        _ => Map::new(),
    };
    Ok(Posted { status, body })
}

/// auth.ts's `message()`: the body's error, else the status.
pub(crate) fn message(r: &Posted) -> String {
    match r.body.get("error") {
        Some(Value::String(e)) => e.clone(),
        _ => format!("the backend answered {}", r.status),
    }
}

fn string_at<'a>(body: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// `pairFlow()`: pair, wait for approval, and return the minted token. Err
/// says why: a refusal, a denied or expired request, or the window running
/// out.
pub async fn pair_flow(client: &Client, opts: &PairOptions<'_>) -> Result<String, String> {
    let pair = post(
        client,
        opts.base,
        "/api/auth/pair",
        &json!({"label": opts.label, "kind": opts.kind}),
    )
    .await?;
    let (Some(id), Some(secret)) = (string_at(&pair.body, "id"), string_at(&pair.body, "secret"))
    else {
        return Err(message(&pair));
    };
    if pair.status != 200 {
        return Err(message(&pair));
    }
    let code = string_at(&pair.body, "code").unwrap_or("?");
    (opts.say)(&format!(
        "pair code {code}: approve it in the canopy inbox, or pass the first code from the server log with --code"
    ));
    if let Some(first_code) = opts.code.filter(|c| !c.is_empty()) {
        let first = post(
            client,
            opts.base,
            "/api/auth/first",
            &json!({"id": id, "code": first_code}),
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
            && let Some(token) = string_at(&got.body, "token")
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
/// a moment: the folder made 0700 when it is new, the file 0600 from its
/// first byte, and set 0600 again for a file that was there before.
pub fn save_token(file: &str, token: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(canopy_core::pathx::dirname(file))?;
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
/// is none yet. The helper's loop that reads it is still TypeScript.
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_helper_token(file: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let t = canopy_core::pathx::js_trim(&text);
    (!t.is_empty()).then(|| t.to_string())
}

/// `pairLabel()`: "<kind> <this machine's name up to its first dot>".
pub fn pair_label(kind: &str) -> String {
    let host = hostname();
    format!(
        "{kind} {}",
        host.split('.').next().unwrap_or("this machine")
    )
}

/// `os.hostname()`: the machine's name, as `hostname` prints it.
pub fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Caller;
    use crate::ask::tests::{Stub, json_answer};
    use std::sync::Mutex;

    fn client() -> Client {
        Client::new(Caller {
            config_dir: "/nonexistent/canopy-pair-test".into(),
            ..Default::default()
        })
    }

    fn opts<'a>(base: &'a str, kind: &'a str, say: &'a dyn Fn(&str)) -> PairOptions<'a> {
        PairOptions {
            base,
            label: "helper test",
            kind,
            code: None,
            poll: Duration::from_millis(5),
            window: Duration::from_millis(40),
            say,
        }
    }

    #[tokio::test]
    async fn a_helper_label_claims_a_helper_token_the_window_ends_a_pair_nobody_approves() {
        let stub = Stub::start(|s| match s.path.as_str() {
            "/api/auth/pair" => {
                json_answer(200, json!({"id": "p1", "code": "AB12", "secret": "s"}))
            }
            _ => json_answer(200, json!({"waiting": true})),
        })
        .await;
        let said: Mutex<Vec<String>> = Mutex::default();
        let say = |l: &str| said.lock().unwrap().push(l.to_string());
        let got = pair_flow(&client(), &opts(&stub.url, "helper", &say)).await;
        assert_eq!(got, Err("timed out waiting for approval".into()));
        assert!(said.lock().unwrap().join("\n").contains("approve"));
        assert!(said.lock().unwrap()[0].starts_with("pair code AB12: "));
    }

    #[tokio::test]
    async fn the_request_names_its_kind_whatever_the_label_starts_with() {
        let stub = Stub::start(|s| match s.path.as_str() {
            "/api/auth/pair" => json_answer(200, json!({"id": "p1", "secret": "s"})),
            "/api/auth/first" => json_answer(200, json!({"ok": true})),
            _ => json_answer(200, json!({"token": "minted"})),
        })
        .await;
        let say = |_: &str| {};
        let mut o = opts(&stub.url, "cli", &say);
        o.label = "laptop";
        o.code = Some("FIRST-1");
        assert_eq!(pair_flow(&client(), &o).await, Ok("minted".into()));
        let seen = stub.seen.lock().unwrap().clone();
        let bodies: Vec<Value> = seen
            .iter()
            .map(|s| serde_json::from_str(&s.body).unwrap())
            .collect();
        assert_eq!(
            bodies,
            [
                json!({"label": "laptop", "kind": "cli"}),
                json!({"id": "p1", "code": "FIRST-1"}),
                json!({"id": "p1", "secret": "s"}),
            ]
        );
    }

    #[tokio::test]
    async fn a_refusal_a_redirect_and_a_wrong_first_code_end_the_flow_in_their_words() {
        let refuse = Stub::start(|_| json_answer(429, json!({"error": "no"}))).await;
        let say = |_: &str| {};
        assert_eq!(
            pair_flow(&client(), &opts(&refuse.url, "cli", &say)).await,
            Err("no".into())
        );
        let moved = Stub::start(|_| {
            (
                302,
                vec![("location".into(), "/login".into())],
                String::new(),
            )
        })
        .await;
        assert_eq!(
            pair_flow(&client(), &opts(&moved.url, "cli", &say)).await,
            Err(format!(
                "{} sent a redirect to a sign-in; point --backend at canopy itself",
                moved.url
            ))
        );
        let bare = Stub::start(|s| match s.path.as_str() {
            "/api/auth/pair" => json_answer(200, json!({"id": "p1", "secret": "s"})),
            _ => json_answer(403, json!({})),
        })
        .await;
        let mut o = opts(&bare.url, "cli", &say);
        o.code = Some("WRONG");
        assert_eq!(
            pair_flow(&client(), &o).await,
            Err("the backend answered 403".into())
        );
    }

    #[test]
    fn a_token_is_kept_0600_with_a_newline_and_read_back_trimmed() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempdir();
        let file = format!("{dir}/new/token-x-80");
        save_token(&file, "tok").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "tok\n");
        let mode = |p: &str| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&format!("{dir}/new")), 0o700);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        save_token(&file, "again").unwrap();
        assert_eq!(mode(&file), 0o600);
        assert_eq!(read_helper_token(&file).as_deref(), Some("again"));
        std::fs::write(&file, " \n").unwrap();
        assert_eq!(read_helper_token(&file), None);
        assert_eq!(read_helper_token(&format!("{dir}/none")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_label_is_the_kind_and_the_machines_first_name() {
        let label = pair_label("cli");
        assert!(label.starts_with("cli "));
        assert!(!label["cli ".len()..].contains('.'));
    }

    fn tempdir() -> String {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("canopy-pair-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p.to_string_lossy().into_owned()
    }
}
