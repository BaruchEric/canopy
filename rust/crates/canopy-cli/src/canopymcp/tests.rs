//! canopymcp.test.ts's cases. A fake `CanopyApi` answers from a table, as
//! the TypeScript's does, and keeps every call it was asked.

use super::*;
use std::sync::Mutex;

const ALL: [&str; 10] = [
    "canopy_status",
    "canopy_runs",
    "canopy_queue",
    "canopy_health",
    "canopy_work_note",
    "canopy_run_start",
    "canopy_say",
    "canopy_wake",
    "canopy_land",
    "canopy_pr",
];

fn names(kind: CallerKind, enforced: bool) -> Vec<&'static str> {
    tools_for(kind, enforced).iter().map(|t| t.name).collect()
}

#[test]
fn the_tool_table_names_rights_and_the_list_per_kind() {
    let rights: Vec<(&str, &str)> = TOOLS.iter().map(|t| (t.name, t.right.as_str())).collect();
    assert_eq!(
        rights,
        [
            ("canopy_status", "read"),
            ("canopy_runs", "read"),
            ("canopy_queue", "read"),
            ("canopy_health", "read"),
            ("canopy_work_note", "plan"),
            ("canopy_run_start", "plan"),
            ("canopy_say", "plan"),
            ("canopy_wake", "plan"),
            ("canopy_land", "operate"),
            ("canopy_pr", "operate"),
        ]
    );
    for kind in [
        CallerKind::Page,
        CallerKind::Cli,
        CallerKind::Shell,
        CallerKind::Ranger,
    ] {
        assert_eq!(names(kind, true), ALL, "{kind}");
    }
    assert_eq!(names(CallerKind::Coordinator, true), ALL[..8]);
    assert_eq!(names(CallerKind::Run, true), ALL[..8]);
    assert!(!names(CallerKind::Run, true).contains(&"canopy_land"));
    assert!(!names(CallerKind::Run, true).contains(&"canopy_pr"));
    // nobody known holds no tool where the backend enforces; where it only
    // logs, it answers the reads, so those are listed
    assert!(names(CallerKind::None, true).is_empty());
    assert_eq!(names(CallerKind::None, false), ALL[..4]);
    assert!(names(CallerKind::Helper, false).is_empty());
    assert_eq!(names(CallerKind::Run, false), ALL[..8]);
    assert!(names(CallerKind::Helper, true).is_empty());
}

#[test]
fn each_schema_is_a_closed_object_with_the_inputs_the_call_reads() {
    let of = |name: &str| {
        TOOLS
            .iter()
            .find(|t| t.name == name)
            .unwrap()
            .input_schema()
    };
    for tool in &TOOLS {
        let s = tool.input_schema();
        assert_eq!(
            (&s["type"], &s["additionalProperties"]),
            (&json!("object"), &json!(false))
        );
    }
    let keys = |v: Value| -> Vec<String> {
        v["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    };
    assert_eq!(keys(of("canopy_wake")), ["prompt", "when", "cron", "run"]);
    assert_eq!(of("canopy_wake")["required"], json!(["prompt"]));
    assert_eq!(of("canopy_say")["required"], json!(["id", "text"]));
    assert_eq!(keys(of("canopy_runs")), ["id", "json"]);
    assert_eq!(keys(of("canopy_queue")), ["repo", "json"]);
    assert_eq!(of("canopy_status")["properties"], json!({}));
    assert_eq!(of("canopy_land")["required"], json!(["run"]));
    // the key order JSON.stringify writes: required before additionalProperties
    assert_eq!(
        stringify(&of("canopy_land")),
        r#"{"type":"object","properties":{"run":{"type":"string","description":"The ready branch run id to queue for landing."}},"required":["run"],"additionalProperties":false}"#
    );
}

fn status(over: Value) -> Value {
    let mut s = json!({"branch": "main", "upstream": null, "ahead": 0, "behind": 0, "files": [], "lastCommit": null, "user": null});
    if let (Some(m), Value::Object(o)) = (s.as_object_mut(), over) {
        m.extend(o);
    }
    s
}

fn repo(id: &str, over: Value) -> Value {
    let mut r = json!({"id": id, "name": id.rsplit('/').next().unwrap(), "path": format!("/d/{id}"), "group": "", "source": "root", "status": status(json!({}))});
    if let (Some(m), Value::Object(o)) = (r.as_object_mut(), over) {
        m.extend(o);
    }
    r
}

fn run(id: &str, repo_id: &str, over: Value) -> Value {
    let mut r = json!({"id": id, "repoId": repo_id, "action": "ask", "verb": "Ask", "progress": "asking", "expectsChange": false, "chat": false, "harness": "claude", "note": "", "status": "done", "startedAt": 1, "steps": [], "prompt": null});
    if let (Some(m), Value::Object(o)) = (r.as_object_mut(), over) {
        m.extend(o);
    }
    r
}

#[test]
fn fold_status_branch_ahead_and_behind_changed_files_the_live_run_archived_repos_left_out() {
    let file = json!({"path": "a.ts", "index": ".", "worktree": "M", "untracked": false, "conflicted": false});
    let repos = [
        repo(
            "dev-tools/canopy",
            json!({"status": status(json!({"ahead": 2, "files": [file, file, file]}))}),
        ),
        repo(
            "web-apps/ripe",
            json!({"status": status(json!({"branch": "feat", "behind": 1}))}),
        ),
        repo("old", json!({"archived": "canopy"})),
        repo("broken", json!({"status": null, "error": "not a git repo"})),
    ];
    let runs = vec![
        run("r1", "dev-tools/canopy", json!({"status": "working"})),
        run("r2", "web-apps/ripe", json!({"status": "done"})),
    ];
    assert_eq!(
        fold_status(&repos, &runs),
        "dev-tools/canopy  main 2 ahead 3 changed  run: Ask working\nweb-apps/ripe  feat 1 behind\nbroken  not a git repo"
    );
    assert_eq!(fold_status(&[], &[]), "no repos");
    // a checkout takes several runs at once (FR-073): each is said
    let mut shared = runs.clone();
    shared.push(run(
        "r3",
        "dev-tools/canopy",
        json!({"status": "idle", "verb": "chat", "chat": true}),
    ));
    assert_eq!(
        fold_status(&repos, &shared).split('\n').next().unwrap(),
        "dev-tools/canopy  main 2 ahead 3 changed  runs: Ask working, chat idle"
    );
}

#[test]
fn fold_runs_the_list_one_run_with_its_last_steps_an_id_that_is_gone() {
    let mut steps: Vec<Value> = (0..12)
        .map(|i| json!({"id": format!("s{i}"), "at": i, "kind": "text", "text": format!("t{i}")}))
        .collect();
    steps.push(json!({"id": "x", "at": 99, "kind": "tool", "tool": {"name": "Bash", "title": "bun test", "status": "error"}}));
    let runs = [
        run(
            "r1",
            "a",
            json!({"status": "working", "note": "fix the\nthing"}),
        ),
        run(
            "r2",
            "b",
            json!({"status": "failed", "error": "exit 1", "steps": steps}),
        ),
    ];
    assert_eq!(
        fold_runs(&runs, None),
        "r1  a  working  Ask  fix the\nr2  b  failed  Ask"
    );
    let one = fold_runs(&runs, Some("r2"));
    let one: Vec<&str> = one.split('\n').collect();
    assert_eq!(one[0], "r2  b  failed  Ask");
    assert_eq!(one[1], "error: exit 1");
    assert_eq!(one.len(), 12);
    assert_eq!(one[2], "  text: t3");
    assert_eq!(one[11], "  tool: bun test (error)");
    assert_eq!(fold_runs(&runs, Some("nope")), "no run nope");
    assert_eq!(
        fold_runs(
            &[
                run("r3", "a", json!({"status": "idle", "name": "peer sync"})),
                run(
                    "r4",
                    "a",
                    json!({"status": "working", "name": "slow build", "note": "look at the build"})
                ),
            ],
            None
        ),
        "r3  a  idle  Ask \"peer sync\"\nr4  a  working  Ask \"slow build\"  look at the build"
    );
    assert_eq!(fold_runs(&[], None), "no runs");
}

fn rec(id: &str, over: Value) -> Value {
    let mut r = json!({"id": id, "runId": format!("run-{id}"), "repoId": "dev-tools/canopy", "repoPath": "/d/dev-tools/canopy", "branch": format!("run/x-{id}"), "target": "main", "base": "b0", "dir": format!("/w/{id}"), "note": "n", "verb": "Ask", "harness": "claude", "state": "ready", "startedAt": 1});
    if let (Some(m), Value::Object(o)) = (r.as_object_mut(), over) {
        m.extend(o);
    }
    r
}

/// What `enqueue(enqueue([], rec("a"), 1), rec("b"), 2)` leaves: two
/// queued entries, in the order they came. `enqueue` is not ported, so the
/// JSON it writes is written here.
fn entry(id: &str, at: u64) -> Value {
    json!({"id": id, "runId": format!("run-{id}"), "repoId": "dev-tools/canopy", "repoPath": "/d/dev-tools/canopy", "branch": format!("run/x-{id}"), "target": "main", "dir": format!("/w/{id}"), "note": "n", "state": "queued", "tries": 0, "queuedAt": at, "updatedAt": at})
}

#[test]
fn fold_queue_queued_in_order_sent_back_with_why_ready_with_the_tool_to_call_a_repo_filter_empty() {
    let info = json!({
        "runs": [rec("a", json!({})), rec("b", json!({})), rec("c", json!({})), rec("d", json!({"repoId": "web-apps/ripe", "repoPath": "/d/web-apps/ripe"}))],
        "entries": [entry("a", 1), entry("b", 2)],
        "orphans": [],
    });
    assert_eq!(
        fold_queue(&info, None),
        [
            "dev-tools/canopy",
            "  queued 1st       run/x-a",
            "  queued 2nd       run/x-b",
            "  ready            run/x-c  sorting  canopy_land run-c",
            "web-apps/ripe",
            "  ready            run/x-d  sorting  canopy_land run-d",
        ]
        .join("\n")
    );
    assert_eq!(
        fold_queue(&info, Some("ripe")),
        "web-apps/ripe\n  ready            run/x-d  sorting  canopy_land run-d"
    );
    assert_eq!(
        fold_queue(&json!({"runs": [], "entries": [], "orphans": []}), None),
        "no branch runs in any queue"
    );
}

fn check(id: &str, state: &str, why: Option<&str>) -> Value {
    json!({"id": id, "label": id, "scope": {"kind": "canopy"}, "state": state, "why": why, "since": 1, "lastOk": null, "heal": "auto", "fails": 0, "nextHeal": null, "button": false, "history": []})
}

#[test]
fn fold_health_the_bad_ones_first_under_a_count_line() {
    assert_eq!(
        fold_health(&[
            check("c:a", "ok", None),
            check("c:b", "down", Some("502 in 20ms")),
            check("c:c", "gave-up", Some("3 heals"))
        ]),
        "2 of 3 checks down\n  down     c:b  502 in 20ms  c:b\n  gave-up  c:c  3 heals  c:c\n  ok       c:a  c:a"
    );
    assert_eq!(
        fold_health(&[check("c:a", "ok", None)]),
        "all 1 checks ok\n  ok       c:a  c:a"
    );
    assert_eq!(fold_health(&[]), "no checks");
}

/// The TypeScript's `api()`: answers by "METHOD path", an Err for one that
/// throws, and every call kept.
struct Api {
    answers: Vec<(&'static str, Result<Value, String>)>,
    calls: Mutex<Vec<(String, String, Option<Value>)>>,
    /// answer `{}` (and `[]` for the lists) to anything not in the table
    lenient: bool,
}

impl Api {
    fn new(answers: Vec<(&'static str, Result<Value, String>)>) -> Self {
        Api {
            answers,
            calls: Mutex::default(),
            lenient: false,
        }
    }

    fn calls(&self) -> Vec<(String, String, Option<Value>)> {
        self.calls.lock().unwrap().clone()
    }
}

impl CanopyApi for Api {
    async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), path.into(), body.cloned()));
        let key = format!("{method} {path}");
        match self.answers.iter().find(|(k, _)| *k == key) {
            Some((_, a)) => a.clone(),
            None if self.lenient => Ok(if path == "/api/runs" || path == "/api/health" {
                json!([])
            } else {
                json!({})
            }),
            None => Err(format!("no answer for {key}")),
        }
    }
}

fn ctx(api: &Api, kind: CallerKind) -> McpContext<'_, Api> {
    McpContext {
        api,
        kind,
        enforced: true,
        run: None,
        version: "0.1.0 (abc1234)".into(),
    }
}

fn req(id: i64, method: &str, params: Option<Value>) -> RpcMessage {
    let mut m = json!({"jsonrpc": "2.0", "id": id, "method": method});
    if let Some(p) = params {
        m["params"] = p;
    }
    parse_message(&m.to_string()).unwrap()
}

#[tokio::test]
async fn initialize_answers_the_clients_version_when_known_else_the_servers_with_the_instructions()
{
    let api = Api::new(vec![]);
    let reply = handle_message(
        &req(1, "initialize", Some(json!({"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}))),
        &ctx(&api, CallerKind::Shell),
    )
    .await;
    assert_eq!(
        reply,
        Some(
            json!({"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "canopy", "version": "0.1.0 (abc1234)"}, "instructions": INSTRUCTIONS}})
        )
    );
    let unsupported = handle_message(
        &req(
            2,
            "initialize",
            Some(json!({"protocolVersion": "2099-01-01"})),
        ),
        &ctx(&api, CallerKind::Shell),
    )
    .await
    .unwrap();
    assert_eq!(unsupported["result"]["protocolVersion"], "2025-06-18");
}

#[tokio::test]
async fn ping_a_notification_an_unknown_method() {
    let api = Api::new(vec![]);
    let c = ctx(&api, CallerKind::Shell);
    assert_eq!(
        handle_message(&req(3, "ping", None), &c).await,
        Some(json!({"jsonrpc": "2.0", "id": 3, "result": {}}))
    );
    let note = parse_message(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).unwrap();
    assert_eq!(handle_message(&note, &c).await, None);
    assert_eq!(
        handle_message(&req(4, "resources/list", None), &c).await,
        Some(
            json!({"jsonrpc": "2.0", "id": 4, "error": {"code": -32601, "message": "no method resources/list"}})
        )
    );
}

#[tokio::test]
async fn tools_list_is_the_kinds_list() {
    let api = Api::new(vec![]);
    let listed = |reply: Option<Value>| -> Vec<String> {
        reply.unwrap()["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    };
    let reply = handle_message(&req(5, "tools/list", None), &ctx(&api, CallerKind::Run)).await;
    assert_eq!(listed(reply), ALL[..8]);
    // a caller with no token: nothing where the backend enforces, the reads where it only logs
    let none = handle_message(&req(5, "tools/list", None), &ctx(&api, CallerKind::None)).await;
    assert!(listed(none).is_empty());
    let mut logged = ctx(&api, CallerKind::None);
    logged.enforced = false;
    let reply = handle_message(&req(5, "tools/list", None), &logged).await;
    assert_eq!(listed(reply), ALL[..4]);
}

#[tokio::test]
async fn a_tool_the_kind_does_not_hold_and_one_that_does_not_exist_are_refused_before_any_call() {
    let api = Api::new(vec![]);
    assert_eq!(
        handle_message(
            &req(
                6,
                "tools/call",
                Some(json!({"name": "canopy_land", "arguments": {"run": "r"}}))
            ),
            &ctx(&api, CallerKind::None)
        )
        .await,
        Some(
            json!({"jsonrpc": "2.0", "id": 6, "error": {"code": -32602, "message": "canopy_land is not a tool this none token holds"}})
        )
    );
    assert_eq!(
        handle_message(
            &req(
                7,
                "tools/call",
                Some(json!({"name": "canopy_rm", "arguments": {}}))
            ),
            &ctx(&api, CallerKind::Shell)
        )
        .await,
        Some(
            json!({"jsonrpc": "2.0", "id": 7, "error": {"code": -32602, "message": "no tool named canopy_rm"}})
        )
    );
    assert_eq!(
        handle_message(
            &req(8, "tools/call", Some(json!({}))),
            &ctx(&api, CallerKind::Shell)
        )
        .await,
        Some(
            json!({"jsonrpc": "2.0", "id": 8, "error": {"code": -32602, "message": "tools/call needs a name"}})
        )
    );
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn a_calls_result_and_the_apis_error_as_text() {
    let api = Api::new(vec![
        ("GET /api/health", Ok(json!({"checks": []}))),
        ("POST /api/runs/say", Err("no run nope".into())),
    ]);
    let c = ctx(&api, CallerKind::Shell);
    assert_eq!(
        handle_message(
            &req(
                9,
                "tools/call",
                Some(json!({"name": "canopy_health", "arguments": {}}))
            ),
            &c
        )
        .await,
        Some(
            json!({"jsonrpc": "2.0", "id": 9, "result": {"content": [{"type": "text", "text": "no checks"}]}})
        )
    );
    assert_eq!(
        handle_message(
            &req(
                10,
                "tools/call",
                Some(json!({"name": "canopy_say", "arguments": {"id": "nope", "text": "hi"}}))
            ),
            &c
        )
        .await,
        Some(
            json!({"jsonrpc": "2.0", "id": 10, "result": {"content": [{"type": "text", "text": "no run nope"}], "isError": true}})
        )
    );
}

fn ok(text: &str) -> ToolResult {
    ToolResult {
        text: text.into(),
        is_error: false,
    }
}

#[tokio::test]
async fn call_tool_each_tools_call_and_words() {
    let api = Api::new(vec![
        ("GET /api/tree", Ok(json!({"repos": []}))),
        ("GET /api/runs", Ok(json!([]))),
        (
            "GET /api/landing",
            Ok(json!({"runs": [], "entries": [], "orphans": []})),
        ),
        ("GET /api/health", Ok(json!({"checks": []}))),
        (
            "POST /api/runs/say",
            Ok(json!({"id": "r1", "status": "working"})),
        ),
        (
            "POST /api/ranger/wakes",
            Ok(
                json!({"id": "1a2b3c4d", "by": "eric", "prompt": "p", "cron": "0 8 * * *", "created": 1, "next": 2}),
            ),
        ),
        (
            "POST /api/landing/land",
            Ok(
                json!({"id": "a", "state": "queued", "branch": "run/x-a", "target": "main", "repoId": "r", "repoPath": "/r", "dir": "/w", "note": "", "tries": 0, "queuedAt": 1, "updatedAt": 1}),
            ),
        ),
        (
            "POST /api/prs/open",
            Ok(json!({"number": 12, "url": "https://github.com/o/r/pull/12"})),
        ),
    ]);
    let c = ctx(&api, CallerKind::Shell);
    let ranger = ctx(&api, CallerKind::Ranger);
    let a = |v: Value| Some(v);
    assert_eq!(
        call_tool("canopy_status", a(json!({})).as_ref(), &c).await,
        ok("no repos")
    );
    assert_eq!(
        call_tool("canopy_runs", a(json!({"json": true})).as_ref(), &c).await,
        ok("[]")
    );
    assert_eq!(
        call_tool("canopy_queue", a(json!({})).as_ref(), &c).await,
        ok("no branch runs in any queue")
    );
    assert_eq!(
        call_tool("canopy_health", a(json!({})).as_ref(), &c).await,
        ok("no checks")
    );
    assert_eq!(
        call_tool(
            "canopy_say",
            a(json!({"id": "r1", "text": "go"})).as_ref(),
            &c
        )
        .await,
        ok("said to r1, now working")
    );
    assert_eq!(
        call_tool(
            "canopy_wake",
            a(json!({"prompt": "p", "cron": "0 8 * * *"})).as_ref(),
            &c
        )
        .await,
        ok("wake 1a2b3c4d set for cron 0 8 * * *")
    );
    assert!(
        !call_tool(
            "canopy_wake",
            a(json!({"prompt": "p", "when": "in 30m"})).as_ref(),
            &ranger
        )
        .await
        .is_error
    );
    assert_eq!(
        call_tool("canopy_land", a(json!({"run": "run-a"})).as_ref(), &c).await,
        ok("queued 1st: run/x-a into main")
    );
    assert_eq!(
        call_tool("canopy_pr", a(json!({"run": "run-a"})).as_ref(), &c).await,
        ok("PR #12 opened: https://github.com/o/r/pull/12")
    );
    assert_eq!(
        call_tool("canopy_say", a(json!({"id": "r1"})).as_ref(), &c).await,
        ToolResult {
            text: "canopy_say needs text".into(),
            is_error: true
        }
    );
    let calls = api.calls();
    let bodies = |path: &str| -> Vec<Value> {
        calls
            .iter()
            .filter(|c| c.1 == path)
            .map(|c| c.2.clone().unwrap_or(Value::Null))
            .collect()
    };
    assert_eq!(
        bodies("/api/ranger/wakes"),
        [
            json!({"prompt": "p", "cron": "0 8 * * *", "by": "eric"}),
            json!({"prompt": "p", "when": "in 30m"})
        ]
    );
    // the key order JSON.stringify sends: by goes last
    assert_eq!(
        stringify(&bodies("/api/ranger/wakes")[0]),
        r#"{"prompt":"p","cron":"0 8 * * *","by":"eric"}"#
    );
    assert_eq!(bodies("/api/runs/say"), [json!({"id": "r1", "text": "go"})]);
    assert_eq!(bodies("/api/landing/land"), [json!({"run": "run-a"})]);
}

#[tokio::test]
async fn serve_reads_newline_messages_in_order_drops_junk_and_flushes_the_last_line() {
    let api = Api::new(vec![("GET /api/health", Ok(json!({"checks": []})))]);
    let lines = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}).to_string(),
        String::new(),
        "starting up, log chatter".into(),
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into(),
        r#"{"not":"a message"}"#.into(),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "canopy_health", "arguments": {}}}).to_string(),
    ];
    let text = format!(
        "{}\n{}",
        lines.join("\n"),
        json!({"jsonrpc": "2.0", "id": 3, "method": "ping"})
    );
    // two chunks, the first ending mid-message
    let (mut tx, rx) = tokio::io::duplex(16);
    let bytes = text.into_bytes();
    let feed = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt as _;
        tx.write_all(&bytes[..40]).await.unwrap();
        tx.write_all(&bytes[40..]).await.unwrap();
    });
    let mut output: Vec<String> = Vec::new();
    let mut write = |line: String| output.push(line);
    serve(rx, &mut write, &ctx(&api, CallerKind::Shell)).await;
    feed.await.unwrap();
    let ids: Vec<i64> = output
        .iter()
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["id"]
                .as_i64()
                .unwrap()
        })
        .collect();
    assert_eq!(ids, [1, 2, 3]);
    assert_eq!(
        serde_json::from_str::<Value>(&output[1]).unwrap(),
        json!({"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": "no checks"}]}})
    );
}

#[tokio::test]
async fn canopy_run_start_names_this_run_as_parent_by_default_and_a_shell_names_one_itself() {
    let api = Api::new(vec![(
        "POST /api/runs/child",
        Ok(json!({"id": "kid12345", "branch": {"name": "run/w-kid"}})),
    )]);
    let mut in_run = ctx(&api, CallerKind::Run);
    in_run.run = Some("abcd1234".into());
    assert_eq!(
        call_tool(
            "canopy_run_start",
            Some(&json!({"note": "a part"})),
            &in_run
        )
        .await,
        ok("started run kid12345 on run/w-kid")
    );
    assert!(
        !call_tool(
            "canopy_run_start",
            Some(
                &json!({"note": "a part", "parent": "ffff0000", "repo": "app", "action": "propose"})
            ),
            &ctx(&api, CallerKind::Shell)
        )
        .await
        .is_error
    );
    let sent: Vec<Value> = api.calls().into_iter().map(|c| c.2.unwrap()).collect();
    assert_eq!(
        sent,
        [
            json!({"note": "a part", "parent": "abcd1234"}),
            json!({"note": "a part", "action": "propose", "repo": "app", "parent": "ffff0000"}),
        ]
    );
    assert_eq!(
        call_tool("canopy_run_start", Some(&json!({})), &in_run).await,
        ToolResult {
            text: "canopy_run_start needs note".into(),
            is_error: true
        }
    );
}

#[tokio::test]
async fn canopy_work_note_leaves_the_id_to_the_server_in_a_run() {
    let api = Api::new(vec![("POST /api/work/note", Ok(json!({"id": "w-1"})))]);
    let mut in_run = ctx(&api, CallerKind::Run);
    in_run.run = Some("abcd1234".into());
    assert_eq!(
        call_tool(
            "canopy_work_note",
            Some(&json!({"text": "for later"})),
            &in_run
        )
        .await,
        ok("noted on w-1")
    );
    assert_eq!(
        api.calls()[0],
        (
            "POST".into(),
            "/api/work/note".into(),
            Some(json!({"text": "for later"}))
        )
    );
}

#[tokio::test]
async fn a_runs_wake_claims_no_one_and_the_apis_refusal_comes_back_as_its_words() {
    let api = Api::new(vec![(
        "POST /api/ranger/wakes",
        Ok(json!({"id": "1a2b3c4d", "by": "run", "prompt": "p", "at": 5, "created": 1})),
    )]);
    let said = call_tool(
        "canopy_wake",
        Some(&json!({"prompt": "p", "when": "in 30m"})),
        &ctx(&api, CallerKind::Run),
    )
    .await;
    assert_eq!(
        api.calls()[0].2,
        Some(json!({"prompt": "p", "when": "in 30m"}))
    );
    assert_eq!(said, ok("wake 1a2b3c4d set for 1970-01-01T00:00:00.005Z"));
    let refused = Api::new(vec![(
        "POST /api/runs/child",
        Err("run abcd1234 has 3 children going; wait for one to end".into()),
    )]);
    assert_eq!(
        call_tool(
            "canopy_run_start",
            Some(&json!({"note": "x"})),
            &ctx(&refused, CallerKind::Run)
        )
        .await,
        ToolResult {
            text: "run abcd1234 has 3 children going; wait for one to end".into(),
            is_error: true
        }
    );
}

#[tokio::test]
async fn a_run_asking_for_a_tool_it_does_not_hold_is_refused_before_any_call() {
    let api = Api::new(vec![]);
    let msg = RpcMessage::Request {
        id: json!(1),
        method: "tools/call".into(),
        params: Some(json!({"name": "canopy_land", "arguments": {"run": "r"}})),
    };
    let reply = handle_message(&msg, &ctx(&api, CallerKind::Run))
        .await
        .unwrap();
    assert_eq!(
        reply["error"]["message"],
        "canopy_land is not a tool this run token holds"
    );
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn every_tool_it_lists_calls_a_route_on_its_lane() {
    // the lane matches exact paths, so a listed tool on any other path
    // would be offered to the agent and refused every time
    let args = |name: &str| match name {
        "canopy_work_note" => json!({"text": "n"}),
        "canopy_run_start" => json!({"note": "n"}),
        "canopy_say" => json!({"id": "c1", "text": "n"}),
        "canopy_wake" => json!({"prompt": "n", "when": "2026-11-04T09:00:00Z"}),
        _ => json!({}),
    };
    let lane = canopy_auth::lane(CallerKind::Run).unwrap();
    for tool in tools_for(CallerKind::Run, true) {
        let mut api = Api::new(vec![]);
        api.lenient = true;
        let mut c = ctx(&api, CallerKind::Run);
        c.run = Some("abcd1234".into());
        call_tool(tool.name, Some(&args(tool.name)), &c).await;
        let seen = api.calls();
        assert!(!seen.is_empty(), "{}", tool.name);
        for (method, path, _) in seen {
            let call = format!("{method} {path}");
            assert!(lane.contains(&call.as_str()), "{}: {call}", tool.name);
        }
    }
}

#[test]
fn an_iso_time_is_javascripts_to_the_millisecond() {
    assert_eq!(iso_string(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
    assert_eq!(
        iso_string(1_764_000_000_123.0).as_deref(),
        Some("2025-11-24T16:00:00.123Z")
    );
    assert_eq!(iso_string(f64::NAN), None);
}
