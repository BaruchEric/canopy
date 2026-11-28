//! mcp.test.ts's cases. The TypeScript spawns the CLI against a Bun server;
//! here the command runs in the test against a stub server on loopback,
//! with its stdin a byte slice, and its token file in a scratch config dir.

use super::*;
use crate::ask::tests::{Stub, json_answer};
use serde_json::json;

struct Scratch(String);

impl Scratch {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("canopy-mcp-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Scratch(p.to_string_lossy().into_owned())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The stub the TypeScript's tests serve.
async fn backend() -> Stub {
    Stub::start(|s| match s.path.as_str() {
        "/api/auth" => json_answer(200, json!({"you": "shell"})),
        "/api/tree" => json_answer(200, json!({"repos": [{"id": "a", "name": "a", "path": "/d/a", "group": "", "source": "root", "status": {"branch": "main", "upstream": null, "ahead": 0, "behind": 0, "files": [], "lastCommit": null, "user": null}}]})),
        "/api/runs" => json_answer(200, json!([])),
        "/api/runs/say" => json_answer(404, json!({"error": "no run nope"})),
        "/redirect" => (302, vec![("location".into(), "/api/runs/say".into())], String::new()),
        _ => json_answer(404, json!({"error": "nope"})),
    })
    .await
}

fn caller(s: &Scratch, base: &str) -> Caller {
    let c = Caller {
        config_dir: s.0.clone(),
        env_api: Some(base.into()),
        ..Default::default()
    };
    std::fs::write(c.token_file(base).unwrap(), "file-token").unwrap();
    c
}

fn env(token: Option<&str>, run: Option<&str>) -> McpEnv {
    McpEnv {
        api: None,
        token: token.map(String::from),
        run: run.map(String::from),
    }
}

#[tokio::test]
async fn the_session_token_wins_over_the_cli_token_file() {
    let s = Scratch::new();
    let base = "http://127.0.0.1:9";
    let c = caller(&s, base);
    assert_eq!(
        mcp_token(base, &env(Some("env-token"), None), &c).as_deref(),
        Some("env-token")
    );
    assert_eq!(
        mcp_token(base, &env(None, None), &c).as_deref(),
        Some("file-token")
    );
    assert_eq!(mcp_token("http://127.0.0.1:1", &env(None, None), &c), None);
    // a run's server never falls back to the CLI's admin token
    assert_eq!(mcp_token(base, &env(None, Some("abcd1234")), &c), None);
    assert_eq!(
        mcp_token(base, &env(Some("run-token"), Some("abcd1234")), &c).as_deref(),
        Some("run-token")
    );
}

#[test]
fn a_caller_with_no_token_is_listed_the_reads_where_the_backend_only_logs_and_how_to_sign_in_where_it_enforces()
 {
    let lines = tool_lines(CallerKind::None, "http://x", false);
    assert_eq!(lines[0], "tools for a none token on http://x");
    assert_eq!(lines.len(), 5);
    let first: Vec<&str> = lines[1..]
        .iter()
        .map(|l| l.split_whitespace().next().unwrap())
        .collect();
    assert_eq!(
        first,
        [
            "canopy_status",
            "canopy_runs",
            "canopy_queue",
            "canopy_health"
        ]
    );
    assert_eq!(
        tool_lines(CallerKind::None, "http://x", true),
        [
            "tools for a none token on http://x",
            "  none: http://x checks who calls it. Sign in with: canopy auth login --backend http://x"
        ]
    );
    assert_eq!(tool_lines(CallerKind::Run, "http://x", true).len(), 9);
    assert_eq!(
        [
            enforces(Some(&json!("enforce"))),
            enforces(Some(&json!("log"))),
            enforces(Some(&json!("off"))),
            enforces(None)
        ],
        [true, false, false, true]
    );
    assert_eq!(
        tool_lines(CallerKind::Shell, "http://x", true)[1],
        "  canopy_status    read      Every repo canopy shows on this backend: id, branch, ahead and behind, changed files, and the run working in it. A repo's id is what the other tools take."
    );
}

/// Runs `canopy mcp` with `input` on its stdin; its listing, its reply
/// lines, and its failure.
async fn command(
    args: &[&str],
    c: &Caller,
    process: McpEnv,
    input: &[u8],
) -> (Vec<String>, Vec<String>, Result<(), String>) {
    let client = Client::new(c.clone());
    let mut out = Out::default();
    let mut replies: Vec<String> = Vec::new();
    let mut write = |line: String| replies.push(line);
    let r = mcp_cmd(
        args.iter().map(|s| s.to_string()).collect(),
        c,
        &client,
        &mut out,
        process,
        input,
        &mut write,
    )
    .await;
    let lines = out.printed().iter().map(|s| s.to_string()).collect();
    (lines, replies, r)
}

#[tokio::test]
async fn stdio_replies_preserve_order_and_the_sessions_token_including_an_api_refusal() {
    let s = Scratch::new();
    let stub = backend().await;
    let c = caller(&s, &stub.url);
    let input: String = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "canopy_status", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "canopy_say", "arguments": {"id": "nope", "text": "hi"}}}),
    ]
    .iter()
    .map(|v| format!("{v}\n"))
    .collect();
    let (lines, replies, r) =
        command(&[], &c, env(Some("env-token"), None), input.as_bytes()).await;
    r.unwrap();
    assert!(lines.is_empty());
    let replies: Vec<Value> = replies
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "canopy");
    assert_eq!(replies[0]["result"]["capabilities"], json!({"tools": {}}));
    let names: Vec<&str> = replies[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 10);
    assert_eq!(
        replies[2]["result"]["content"],
        json!([{"type": "text", "text": "a  main"}])
    );
    assert_eq!(
        replies[3]["result"],
        json!({"content": [{"type": "text", "text": "no run nope"}], "isError": true})
    );
    let seen: Vec<(String, Option<String>)> = stub
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|s| (s.path.clone(), s.token.clone()))
        .collect();
    let token = Some("env-token".to_string());
    assert_eq!(
        seen,
        [
            ("/api/auth".to_string(), token.clone()),
            ("/api/tree".to_string(), token.clone()),
            ("/api/runs".to_string(), token.clone()),
            ("/api/runs/say".to_string(), token),
        ]
    );
}

#[tokio::test]
async fn tools_prints_only_the_listing_an_unavailable_backend_fails_on_stderr() {
    let s = Scratch::new();
    let stub = backend().await;
    let c = caller(&s, &stub.url);
    let (lines, replies, r) = command(&["tools"], &c, env(Some("env-token"), None), b"").await;
    r.unwrap();
    assert!(replies.is_empty());
    assert_eq!(lines.len(), 11);
    assert_eq!(lines[0], format!("tools for a shell token on {}", stub.url));
    let down = Caller {
        env_api: Some("http://127.0.0.1:1".into()),
        ..c.clone()
    };
    let (lines, _, r) = command(&["tools"], &down, env(Some("env-token"), None), b"").await;
    assert!(lines.is_empty());
    assert!(
        r.as_ref()
            .unwrap_err()
            .starts_with("canopy mcp: http://127.0.0.1:1 did not answer"),
        "{r:?}"
    );
}

#[tokio::test]
async fn api_errors_are_reported_once_and_redirects_are_never_followed() {
    let stub = backend().await;
    let client = Client::new(Caller::default());
    let api = ApiOver {
        client: &client,
        base: stub.url.clone(),
        token: Some("session-token".into()),
    };
    assert_eq!(
        api.call(
            "POST",
            "/api/runs/say",
            Some(&json!({"id": "nope", "text": "hi"}))
        )
        .await,
        Err("no run nope".into())
    );
    assert_eq!(
        api.call("POST", "/redirect", Some(&json!({}))).await,
        Err(format!("{} answered 302", stub.url))
    );
    assert_eq!(stub.paths(), ["/api/runs/say", "/redirect"]);
}

#[test]
fn a_runs_file_gives_its_server_the_token_and_anything_else_is_refused_fr_038() {
    let e = json!({"CANOPY_API": "http://127.0.0.1:1", "CANOPY_TOKEN": "run-token", "CANOPY_RUN": "abcd1234"});
    let mut with_other = e.clone();
    with_other["OTHER"] = json!("x");
    let file = json!({"mcpServers": {"canopy": {"command": "bun", "args": [], "env": with_other}}});
    assert_eq!(
        run_config_env(&file.to_string()),
        Ok(McpEnv {
            api: Some("http://127.0.0.1:1".into()),
            token: Some("run-token".into()),
            run: Some("abcd1234".into()),
        })
    );
    assert!(run_config_env("{").is_err());
    assert_eq!(
        run_config_env("{}"),
        Err("it is not a run's canopy config".into())
    );
    assert_eq!(
        run_config_env(
            &json!({"mcpServers": {"canopy": {"env": {"CANOPY_API": "x", "CANOPY_RUN": "y"}}}})
                .to_string()
        ),
        Err("it is not a run's canopy config".into())
    );
}

#[test]
fn a_file_that_is_not_json_reads_in_buns_words() {
    assert_eq!(
        run_config_env("{"),
        Err("JSON Parse error: Expected '}'".into())
    );
    assert_eq!(
        run_config_env(""),
        Err("JSON Parse error: Unexpected EOF".into())
    );
    assert_eq!(
        run_config_env("[1,"),
        Err("JSON Parse error: Unexpected EOF".into())
    );
    assert_eq!(
        run_config_env("x"),
        Err("JSON Parse error: Unexpected identifier \"x\"".into())
    );
    assert_eq!(
        run_config_env("{} x"),
        Err("JSON Parse error: Unable to parse JSON string".into())
    );
}

#[tokio::test]
async fn a_run_config_names_the_backend_and_its_token_and_a_missing_one_says_why() {
    let s = Scratch::new();
    let stub = backend().await;
    let c = caller(&s, "http://127.0.0.1:9");
    let file = format!("{}/mcp.json", s.0);
    std::fs::write(
        &file,
        json!({"mcpServers": {"canopy": {"env": {"CANOPY_API": stub.url, "CANOPY_TOKEN": "run-token", "CANOPY_RUN": "abcd1234"}}}}).to_string(),
    )
    .unwrap();
    let (lines, _, r) = command(
        &["tools", "--run-config", &file],
        &c,
        env(Some("env-token"), None),
        b"",
    )
    .await;
    r.unwrap();
    assert_eq!(lines[0], format!("tools for a shell token on {}", stub.url));
    assert_eq!(
        stub.seen.lock().unwrap()[0].token.as_deref(),
        Some("run-token")
    );
    let missing = format!("{}/none.json", s.0);
    assert_eq!(
        command(&["--run-config", &missing], &c, env(None, None), b"")
            .await
            .2,
        Err(format!(
            "canopy mcp: {missing}: ENOENT: no such file or directory, open '{missing}'"
        ))
    );
    assert_eq!(
        command(&["--run-config", &s.0], &c, env(None, None), b"")
            .await
            .2,
        Err(format!(
            "canopy mcp: {}: Directories cannot be read like files",
            s.0
        ))
    );
    for args in [
        &["--run-config"][..],
        &["--backend"][..],
        &["--backend", ""][..],
        &["serve"][..],
        &["tools", "x"][..],
    ] {
        assert_eq!(
            command(args, &c, env(None, None), b"").await.2,
            Err(MCP_USAGE.into()),
            "{args:?}"
        );
    }
}
