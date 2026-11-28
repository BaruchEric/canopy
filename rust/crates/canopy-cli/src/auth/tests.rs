//! auth.test.ts's cases, and people.test.ts's `statusWords` case, which is
//! auth's line. The TypeScript drives the CLI against an enforce server;
//! here a stub server on loopback answers the auth routes as that server
//! does, and the token file lands in a scratch config dir.

use super::*;
use crate::ask::tests::{Seen, Stub, json_answer};
use std::os::unix::fs::PermissionsExt as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Scratch(String);

impl Scratch {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("canopy-auth-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Scratch(p.to_string_lossy().into_owned())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn caller(s: &Scratch) -> Caller {
    Caller {
        config_dir: format!("{}/client", s.0),
        ..Default::default()
    }
}

/// Runs the verb; its stdout lines, what it said as it went, and its
/// failure.
async fn run(c: &Caller, args: &[&str]) -> (Vec<String>, Vec<String>, Result<(), String>) {
    let client = Client::new(c.clone());
    let said: Mutex<Vec<String>> = Mutex::default();
    let live = |l: String| said.lock().unwrap().push(l);
    let mut env = AuthEnv::new(Paint::default(), &live);
    env.poll = Duration::from_millis(5);
    env.window = Duration::from_millis(40);
    let mut out = Out::default();
    let r = auth_cmd(
        args.iter().map(|s| s.to_string()).collect(),
        c,
        &client,
        &mut out,
        &env,
    )
    .await;
    let lines = out.printed().iter().map(|s| s.to_string()).collect();
    (lines, said.into_inner().unwrap(), r)
}

fn body(s: &Seen) -> Value {
    serde_json::from_str(&s.body).unwrap_or(Value::Null)
}

/// A backend that enforces who calls: one pair request, approved by the
/// first code, its token minted on the claim; `/api/auth` knows the token
/// once minted and forgets it on a sign-out.
async fn enforce() -> (Stub, Arc<Mutex<bool>>) {
    let signed_in = Arc::new(Mutex::new(false));
    let state = signed_in.clone();
    let stub = Stub::start(move |s| {
        let mut on = state.lock().unwrap();
        let known = *on && s.token.as_deref() == Some("tok-1");
        match s.path.as_str() {
            "/api/auth/pair" => json_answer(200, json!({"id": "p1", "code": "QX7K", "secret": "s1"})),
            "/api/auth/first" if body(s)["code"] == "FIRST-1" => json_answer(200, json!({"ok": true})),
            "/api/auth/first" => json_answer(403, json!({"error": "that is not the first sign-in code, or the pair request is not waiting"})),
            "/api/auth/claim" => {
                *on = true;
                json_answer(200, json!({"token": "tok-1"}))
            }
            "/api/auth/signout" if known => {
                *on = false;
                json_answer(200, json!({"ok": true}))
            }
            "/api/auth/signout" => json_answer(401, json!({"error": "no session to sign out"})),
            "/api/auth" if known => json_answer(200, json!({"mode": "enforce", "refused": {"count": 1}, "you": "cli", "youId": "c1", "person": {"id": "owner", "name": "Eric", "role": "owner"}, "rights": ["read", "plan", "operate", "shell", "admin"], "scope": null})),
            "/api/auth" => json_answer(200, json!({"mode": "enforce", "refused": {"count": 1}, "you": "none", "youId": null, "person": null, "rights": [], "scope": null})),
            _ => json_answer(404, json!({"error": "nope"})),
        }
    })
    .await;
    (stub, signed_in)
}

#[test]
fn auth_status_says_whose_the_token_is_and_what_it_holds_and_reads_an_older_backends_answer() {
    assert_eq!(
        status_words(
            &json!({"mode": "enforce", "refused": {"count": 3}, "you": "cli", "youId": "c1", "person": {"id": "p-a", "name": "Avery", "role": "member"}, "rights": ["read", "plan", "operate"]})
        ),
        "mode enforce  you cli  Avery (member)  holds read, plan, operate  refused 3"
    );
    assert_eq!(
        status_words(
            &json!({"mode": "log", "refused": {"count": 0}, "you": "none", "youId": null})
        ),
        "mode log  you none  refused 0"
    );
    assert_eq!(
        status_words(
            &json!({"mode": "enforce", "refused": {"count": 0}, "you": "cli", "youId": "c2", "person": {"id": "p-g", "name": "Guest", "role": "viewer"}, "rights": ["read"], "scope": ["/srv/rio"]})
        ),
        "mode enforce  you cli  Guest (viewer)  holds read  only in /srv/rio  refused 0"
    );
    assert_eq!(
        status_words(
            &json!({"mode": "enforce", "refused": {"count": 0}, "you": "cli", "rights": []})
        ),
        "mode enforce  you cli  holds nothing  refused 0"
    );
}

#[tokio::test]
async fn login_with_the_first_code_writes_a_0600_token_file_and_land_gets_past_the_check() {
    let s = Scratch::new();
    let c = caller(&s);
    let (stub, _) = enforce().await;
    let (bare, _, r) = run(&c, &["status", "--backend", &stub.url]).await;
    r.unwrap();
    assert_eq!(
        bare,
        [format!(
            "{}  mode enforce  you none  holds nothing  refused 1",
            stub.url
        )]
    );
    let (lines, said, r) = run(&c, &["auth-ignored", "--backend", &stub.url]).await;
    assert_eq!(r, Err(AUTH_USAGE.into()));
    assert!(lines.is_empty() && said.is_empty());
    let (lines, said, r) = run(&c, &["login", "--backend", &stub.url, "--code", "FIRST-1"]).await;
    r.unwrap();
    let file = c.token_file(&stub.url).unwrap();
    assert_eq!(
        said,
        [
            "canopy auth pair code QX7K: approve it in the canopy inbox, or pass the first code from the server log with --code"
        ]
    );
    assert_eq!(
        lines,
        [format!("signed in → {} (token kept in {file})", stub.url)]
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "tok-1\n");
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    // the file's token goes with the next call
    let (status, _, r) = run(&c, &["status", "--backend", &stub.url]).await;
    r.unwrap();
    assert_eq!(
        status,
        [format!(
            "{}  mode enforce  you cli  Eric (owner)  holds read, plan, operate, shell, admin  refused 1",
            stub.url
        )]
    );
    let seen = stub.seen.lock().unwrap().clone();
    assert_eq!(seen.last().unwrap().token.as_deref(), Some("tok-1"));
}

#[tokio::test]
async fn logout_revokes_the_caller_and_removes_the_file_the_old_token_gets_401() {
    let s = Scratch::new();
    let c = caller(&s);
    let (stub, signed_in) = enforce().await;
    run(&c, &["login", "--backend", &stub.url, "--code", "FIRST-1"])
        .await
        .2
        .unwrap();
    let file = c.token_file(&stub.url).unwrap();
    let (lines, _, r) = run(&c, &["logout", "--backend", &stub.url]).await;
    r.unwrap();
    assert_eq!(lines, [format!("signed out of {}", stub.url)]);
    assert!(std::fs::metadata(&file).is_err());
    assert!(!*signed_in.lock().unwrap());
    // nobody is signed in now: the file goes, if there is one, and nothing is posted
    let (lines, _, r) = run(&c, &["logout", "--backend", &stub.url]).await;
    r.unwrap();
    assert_eq!(
        lines,
        [format!(
            "no signed-in caller at {}; removed the token file if there was one",
            stub.url
        )]
    );
    let posts = stub
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path == "/api/auth/signout")
        .count();
    assert_eq!(posts, 1);
}

#[tokio::test]
async fn a_wrong_first_code_fails_the_sign_in_and_writes_no_file() {
    let s = Scratch::new();
    let c = caller(&s);
    let (stub, _) = enforce().await;
    let (lines, said, r) = run(&c, &["login", "--backend", &stub.url, "--code", "NOPE"]).await;
    assert_eq!(
        r,
        Err("sign-in failed: that is not the first sign-in code, or the pair request is not waiting".into())
    );
    assert!(lines.is_empty());
    assert_eq!(said.len(), 1);
    assert!(std::fs::metadata(c.token_file(&stub.url).unwrap()).is_err());
}

#[tokio::test]
async fn canopy_auth_login_sends_cli() {
    let s = Scratch::new();
    let c = caller(&s);
    let stub = Stub::start(|_| json_answer(429, json!({"error": "no"}))).await;
    let (_, _, r) = run(&c, &["login", "--backend", &stub.url]).await;
    assert_eq!(r, Err("sign-in failed: no".into()));
    let kinds: Vec<Value> = stub
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|s| body(s)["kind"].clone())
        .collect();
    assert_eq!(kinds, [json!("cli")]);
}

#[tokio::test]
async fn join_trades_an_invite_for_a_cli_token_of_its_person() {
    let s = Scratch::new();
    let c = caller(&s);
    let stub = Stub::start(|s| {
        if body(s)["code"] == "cnv_good" {
            json_answer(200, json!({"token": "tok-sam", "person": "Sam"}))
        } else {
            json_answer(403, json!({"error": "that invite is not one: it was used, has expired, or was typed wrong"}))
        }
    })
    .await;
    let (lines, _, r) = run(&c, &["join", "cnv_good", "--backend", &stub.url]).await;
    r.unwrap();
    let file = c.token_file(&stub.url).unwrap();
    assert_eq!(
        lines,
        [format!(
            "signed in as Sam → {} (token kept in {file})",
            stub.url
        )]
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "tok-sam\n");
    let sent = body(&stub.seen.lock().unwrap()[0]);
    assert_eq!(sent["kind"], "cli");
    assert!(sent["label"].as_str().unwrap().starts_with("cli "));
    let (_, _, r) = run(&c, &["join", "cnv_used", "--backend", &stub.url]).await;
    assert_eq!(
        r,
        Err(
            "could not join: that invite is not one: it was used, has expired, or was typed wrong"
                .into()
        )
    );
    for args in [&["join"][..], &["join", "a", "b"][..], &["join", ""][..]] {
        assert_eq!(run(&c, args).await.2, Err(AUTH_USAGE.into()), "{args:?}");
    }
}

#[tokio::test]
async fn logout_falls_back_to_revoke_on_an_older_backend_and_says_what_a_403_means() {
    let s = Scratch::new();
    let c = caller(&s);
    let seen_revoke: Arc<Mutex<Vec<Value>>> = Arc::default();
    let log = seen_revoke.clone();
    let older = Stub::start(move |s| match s.path.as_str() {
        "/api/auth" => json_answer(
            200,
            json!({"mode": "enforce", "refused": {"count": 0}, "you": "cli", "youId": "c9"}),
        ),
        "/api/auth/revoke" => {
            log.lock().unwrap().push(body(s));
            json_answer(403, json!({"error": "needs admin", "need": "admin"}))
        }
        _ => json_answer(404, json!({"error": "no such auth route: signout"})),
    })
    .await;
    let (lines, _, r) = run(&c, &["logout", "--backend", &older.url]).await;
    r.unwrap();
    assert_eq!(
        lines,
        [
            "removed the token file; this token cannot revoke itself, so the session stays on the server until a page revokes it"
        ]
    );
    assert_eq!(*seen_revoke.lock().unwrap(), [json!({"id": "c9"})]);
    let broken = Stub::start(|s| match s.path.as_str() {
        "/api/auth" => json_answer(
            200,
            json!({"mode": "enforce", "refused": {"count": 0}, "you": "cli", "youId": "c9"}),
        ),
        _ => json_answer(500, json!({})),
    })
    .await;
    let (_, _, r) = run(&c, &["logout", "--backend", &broken.url]).await;
    assert_eq!(
        r,
        Err("removed the token file, but the server said: the backend answered 500".into())
    );
}

#[tokio::test]
async fn a_backend_that_does_not_answer_or_refuses_the_read_is_one_line() {
    let s = Scratch::new();
    let c = caller(&s);
    let down = "http://127.0.0.1:1";
    for sub in ["status", "logout"] {
        assert_eq!(
            run(&c, &[sub, "--backend", down]).await.2,
            Err(format!("{down} did not answer"))
        );
    }
    assert!(
        run(&c, &["login", "--backend", down])
            .await
            .2
            .unwrap_err()
            .starts_with("sign-in failed: ECONNREFUSED")
    );
    let shut = Stub::start(|_| json_answer(401, json!({}))).await;
    assert_eq!(
        run(&c, &["status", "--backend", &shut.url]).await.2,
        Err(format!("{} answered 401 to /api/auth", shut.url))
    );
    assert_eq!(
        run(&c, &["logout", "--backend", "notaurl"]).await.2,
        Err("Invalid URL".into())
    );
}
