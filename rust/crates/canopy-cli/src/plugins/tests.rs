//! plugins.test.ts, case by case, then the command against a fake backend.

use super::*;
use crate::ask::AskError;
use crate::ask::tests::Fake;
use std::cell::RefCell;

fn mac() -> Value {
    json!({
        "machine": "mac", "at": 0, "away": null, "shared": true, "settingsDirty": true, "commits": true,
        "agents": [{
            "agent": "claude", "path": "/c", "error": null,
            "plugins": [
                {"id": "superpowers@o", "version": "7.0.0", "enabled": true, "scope": "user", "servers": {}, "errors": [], "notes": []},
                {"id": "context-mode@cm", "version": null, "enabled": false, "scope": "user", "servers": {"context-mode": "node s"}, "errors": [], "notes": []},
            ],
            "markets": [{"name": "o", "source": "x/o"}],
            "declared": {"superpowers@o": true, "remember@o": true, "off@o": false},
            "declaredMarkets": {},
        }],
    })
}

fn with(base: Value, over: Value) -> Value {
    let mut out = base;
    for (k, v) in over.as_object().unwrap() {
        out[k] = v.clone();
    }
    out
}

#[test]
fn a_machines_lines_how_it_holds_settings_json_each_plugin_what_settings_json_wants_the_marketplaces()
 {
    assert_eq!(
        plugin_lines(&mac(), None),
        [
            "mac  commits the shared settings.json, settings.json changed and not committed",
            "  claude  superpowers@o  on 7.0.0",
            "  claude  context-mode@cm  off  servers: context-mode",
            "  claude  remember@o  wanted: settings.json turns it on, not installed here",
            "  claude  marketplaces: o",
        ]
    );
    assert_eq!(
        plugin_lines(&mac(), Some("codex")),
        ["mac  commits the shared settings.json, settings.json changed and not committed"]
    );
    assert_eq!(
        plugin_lines(&with(mac(), json!({"away": "no ssh"})), None),
        ["mac  away: no ssh"]
    );
    assert_eq!(
        plugin_lines(
            &with(mac(), json!({"settingsDirty": false, "unpushed": 2})),
            Some("codex")
        ),
        ["mac  commits the shared settings.json, 2 dotclaude commits not pushed"]
    );
    let agent = with(
        mac()["agents"][0].clone(),
        json!({
            "plugins": [{"id": "v@m", "version": "0.1.0", "enabled": true, "scope": "user", "servers": {}, "errors": ["skills load failed"], "notes": []}],
            "declared": {},
            "markets": [],
        }),
    );
    let broken = with(mac(), json!({"agents": [agent]}));
    assert_eq!(
        plugin_lines(&broken, None),
        [
            "mac  commits the shared settings.json, settings.json changed and not committed",
            "  claude  v@m  on 0.1.0  fails: skills load failed",
        ]
    );
}

#[test]
fn one_unpushed_commit_is_said_as_one_and_keys_list_as_object_keys_lists_them() {
    assert_eq!(
        plugin_lines(
            &with(
                mac(),
                json!({"settingsDirty": false, "unpushed": 1, "commits": false})
            ),
            Some("codex")
        ),
        ["mac  follows the shared settings.json, 1 dotclaude commit not pushed"]
    );
    assert_eq!(
        plugin_lines(
            &with(mac(), json!({"shared": false, "unpushed": 3})),
            Some("codex")
        ),
        ["mac  own settings.json"]
    );
    let agent = with(
        mac()["agents"][0].clone(),
        json!({
            "error": "claude: not found",
            "plugins": [{"id": "s@m", "version": null, "enabled": true, "servers": {"b": 1, "10": 1, "a": 1, "2": 1}, "errors": [null]}],
            "declared": {"z@m": true, "7": true},
            "markets": [],
        }),
    );
    assert_eq!(
        plugin_lines(&with(mac(), json!({"agents": [agent]})), Some("claude"))[1..],
        [
            "  claude  claude: not found",
            "  claude  s@m  on  servers: 2, 10, b, a  fails: ",
            "  claude  7  wanted: settings.json turns it on, not installed here",
            "  claude  z@m  wanted: settings.json turns it on, not installed here",
        ]
    );
}

#[test]
fn an_ops_line_and_a_command_to_accept() {
    assert_eq!(
        op_lines(
            &json!({"machine": "mac", "agent": "claude", "op": "disable", "outcome": "ok", "message": "Successfully disabled"}),
            "superpowers@o"
        ),
        ["mac: turn off superpowers@o done: Successfully disabled"]
    );
    let sha = "a".repeat(64);
    assert_eq!(
        op_lines(
            &json!({"machine": "mac", "agent": "claude", "op": "install", "outcome": "confirm", "message": "", "command": "npx x", "sha256": sha}),
            "x@o"
        ),
        [
            "mac: install x@o waits: the marketplace declares a command to run".to_string(),
            "  npx x".to_string(),
            format!("read it, then run the same command again with --accept {sha}"),
        ]
    );
    assert_eq!(
        op_lines(
            &json!({"machine": "mini", "op": "market-remove", "outcome": "failed", "message": "no such marketplace"}),
            "o"
        ),
        ["mini: remove the marketplace o failed: no such marketplace"]
    );
}

#[test]
fn a_searchs_lines_end_with_the_count() {
    assert_eq!(
        catalog_lines(
            &json!({"machine": "mac", "agent": "claude", "total": 2, "entries": [
                {"id": "remember@o", "name": "remember", "marketplace": "o", "description": "memory", "version": null, "installs": 5, "installed": false},
            ]})
        ),
        [
            "remember@o  5 installs  memory",
            "2 on mac for claude, 1 shown"
        ]
    );
    assert_eq!(
        catalog_lines(
            &json!({"machine": "mac", "agent": "codex", "total": 1, "entries": [
                {"id": "x@o", "description": "", "installs": null, "installed": true},
            ]})
        ),
        ["x@o  (installed)", "1 on mac for codex"]
    );
}

#[test]
fn a_commits_preview_then_what_it_came_to() {
    let change = json!({"on": [], "off": ["superpowers@o"], "dropped": [], "marketsAdded": [], "marketsRemoved": [], "marketsChanged": [], "other": []});
    assert_eq!(
        commit_preview_lines(
            &json!({"machine": "mac", "sha": "a".repeat(40), "branch": "main", "change": change, "lines": ["turns off superpowers@o"], "message": "settings.json: turn off superpowers@o\n\nCommitted from canopy."})
        ),
        [
            "mac: settings.json on main",
            "  turns off superpowers@o",
            "",
            "  | settings.json: turn off superpowers@o",
            "  |",
            "  | Committed from canopy.",
        ]
    );
    assert_eq!(
        commit_preview_lines(&json!({"machine": "mac", "branch": "", "lines": [], "message": "m"})),
        [
            "mac: settings.json on its branch",
            "  changes only the file's layout",
            "",
            "  | m"
        ]
    );
    assert_eq!(
        commit_result_line(
            &json!({"machine": "mac", "outcome": "pushed", "commit": "abc1234", "message": "committed abc1234 and pushed"})
        ),
        "mac: committed abc1234 and pushed"
    );
    assert_eq!(
        commit_result_line(
            &json!({"machine": "mac", "outcome": "failed", "message": "settings.json has nothing to commit"})
        ),
        "mac: nothing committed: settings.json has nothing to commit"
    );
}

#[test]
fn a_limit_reads_as_string_of_a_number_writes_it() {
    assert_eq!(
        [30.0, 0.5, 1e21, 1.5e-7, f64::INFINITY, -2.0].map(js_string),
        ["30", "0.5", "1e+21", "1.5e-7", "Infinity", "-2"]
    );
}

fn caller() -> Caller {
    Caller {
        config_dir: "/nonexistent/canopy-cli-test".into(),
        env_api: Some("http://home.test".into()),
        ..Default::default()
    }
}

fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// A home backend that lists mini, each reading one machine.
fn kit(t: &Target) -> Value {
    if t.name == "mini" {
        json!({"ok": true, "plugins": [with(mac(), json!({"machine": "mini", "commits": false}))]})
    } else {
        json!({"ok": false, "error": "not scanned yet", "plugins": [mac()]})
    }
}

#[tokio::test]
async fn the_listing_reads_every_backend_and_a_machine_once() {
    let fake = Fake(|t: &Target, _: &str, p: &str, _: Option<&Value>| match p {
        "/api/backends" => {
            Ok(json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}]}))
        }
        "/api/kit" => Ok(kit(t)),
        _ => Err(AskError::Refused {
            message: "not found".into(),
            status: 404,
        }),
    });
    let mut out = Out::default();
    plugins_cmd(
        words(&["status", "--agent", "codex"]),
        &caller(),
        &fake,
        &mut out,
    )
    .await
    .unwrap();
    assert_eq!(
        out.printed(),
        [
            "mac's kit: not scanned yet",
            "mac  commits the shared settings.json, settings.json changed and not committed",
            "mini  follows the shared settings.json, settings.json changed and not committed",
        ]
    );
    let mut out = Out::default();
    plugins_cmd(
        words(&["--machine", "mini", "--agent", "claude"]),
        &caller(),
        &fake,
        &mut out,
    )
    .await
    .unwrap();
    assert_eq!(
        out.printed()[1],
        "mini  follows the shared settings.json, settings.json changed and not committed"
    );
    assert_eq!(out.printed().len(), 6);
}

#[tokio::test]
async fn the_usages_and_a_backend_that_does_not_answer() {
    let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable(
            "http://home.test: ECONNREFUSED".into(),
        ))
    });
    for (args, want) in [
        (
            &["--agent", "hermes"][..],
            format!("--agent is claude or codex\n{PLUGINS_USAGE}"),
        ),
        (&["frob", "x"], PLUGINS_USAGE.to_string()),
        (&["install"], PLUGINS_USAGE.to_string()),
        (&["marketplace", "add"], PLUGINS_USAGE.to_string()),
        (&["market", "frob", "x"], PLUGINS_USAGE.to_string()),
        (
            &["search", "x"],
            format!("--machine is required\n{PLUGINS_USAGE}"),
        ),
        (
            &["enable", "x@o"],
            format!("--machine is required\n{PLUGINS_USAGE}"),
        ),
    ] {
        let mut out = Out::default();
        assert_eq!(
            plugins_cmd(words(args), &caller(), &down, &mut out).await,
            Err(want),
            "{args:?}"
        );
    }
    let mut out = Out::default();
    assert_eq!(
        plugins_cmd(vec![], &caller(), &down, &mut out).await,
        Err("no backend reads plugins: kit.json's plugins names the agents".into())
    );
    assert_eq!(
        out.printed(),
        ["home: did not answer: http://home.test: ECONNREFUSED"]
    );
    let mut out = Out::default();
    assert_eq!(
        plugins_cmd(words(&["commit"]), &caller(), &down, &mut out).await,
        Err("no machine is marked to commit dotclaude: kit.json machines.<name>.commits".into())
    );
    let mut out = Out::default();
    assert_eq!(
        plugins_cmd(
            words(&["search", "x", "--machine", "far"]),
            &caller(),
            &down,
            &mut out
        )
        .await,
        Err("no backend reads plugins on far".into())
    );
}

#[tokio::test]
async fn an_op_a_search_and_a_commit_go_to_the_backend_that_reads_the_machine() {
    let seen: RefCell<Vec<String>> = RefCell::default();
    let fake = Fake(|t: &Target, m: &str, p: &str, b: Option<&Value>| {
        seen.borrow_mut().push(format!(
            "{} {m} {p} {}",
            t.name,
            b.map(Value::to_string).unwrap_or_default()
        ));
        match p {
            "/api/backends" => {
                Ok(json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}]}))
            }
            "/api/kit" => Ok(kit(t)),
            "/api/kit/plugins" => Ok(
                json!({"machine": "mini", "op": b.unwrap()["op"], "outcome": "failed", "message": "exit 1"}),
            ),
            "/api/kit/plugins/commit" if m == "POST" => Ok(
                json!({"machine": "mac", "outcome": "pushed", "message": "committed abc and pushed"}),
            ),
            p if p.starts_with("/api/kit/plugins/commit?") => Ok(
                json!({"machine": "mac", "sha": "s1", "branch": "main", "lines": ["turns on x@o"], "message": "turn on x@o"}),
            ),
            p if p.starts_with("/api/kit/plugins/catalog?") => {
                Ok(json!({"machine": "mini", "agent": "codex", "total": 0, "entries": []}))
            }
            _ => Err(AskError::Refused {
                message: "not found".into(),
                status: 404,
            }),
        }
    });
    let mut out = Out::default();
    plugins_cmd(
        words(&["install", "x@o", "--machine", "mini", "--accept", "abc"]),
        &caller(),
        &fake,
        &mut out,
    )
    .await
    .unwrap();
    assert_eq!(
        out.printed().last(),
        Some(&"mini: install x@o failed: exit 1")
    );
    assert!(out.failed);
    let mut out = Out::default();
    plugins_cmd(
        words(&[
            "marketplace",
            "add",
            "x/o",
            "--machine",
            "mini",
            "--agent",
            "codex",
        ]),
        &caller(),
        &fake,
        &mut out,
    )
    .await
    .unwrap();
    let mut out = Out::default();
    plugins_cmd(
        words(&[
            "search",
            "a",
            "b",
            "--machine",
            "mini",
            "--agent",
            "codex",
            "--limit",
            "x",
        ]),
        &caller(),
        &fake,
        &mut out,
    )
    .await
    .unwrap();
    assert_eq!(out.printed().last(), Some(&"0 on mini for codex"));
    let mut out = Out::default();
    plugins_cmd(words(&["commit"]), &caller(), &fake, &mut out)
        .await
        .unwrap();
    assert!(!out.failed);
    assert_eq!(out.printed().last(), Some(&"mac: committed abc and pushed"));
    let calls: Vec<String> = seen
        .borrow()
        .iter()
        .filter(|c| !c.contains("/api/kit ") && !c.contains("/api/backends"))
        .cloned()
        .collect();
    assert_eq!(
        calls,
        [
            "mini POST /api/kit/plugins {\"machine\":\"mini\",\"agent\":\"claude\",\"op\":\"install\",\"id\":\"x@o\",\"accept\":\"abc\"}",
            "mini POST /api/kit/plugins {\"machine\":\"mini\",\"agent\":\"codex\",\"op\":\"market-add\",\"source\":\"x/o\"}",
            "mini GET /api/kit/plugins/catalog?machine=mini&agent=codex&q=a+b&limit=30 ",
            "mac GET /api/kit/plugins/commit?machine=mac ",
            "mac POST /api/kit/plugins/commit {\"machine\":\"mac\",\"sha\":\"s1\"}",
        ]
    );
}
