//! canopy's own MCP server, the pure half (`src/core/canopymcp.ts`): the
//! tool table, the folds that put an API answer in a few lines, and the
//! JSON-RPC dispatch. `canopy mcp` (`mcp.rs`) starts it over stdio with the
//! token the session holds. It lives in the CLI crate rather than core
//! because it asks canopy-auth which rights a caller's kind holds.
//!
//! API answers are read as the JSON the routes send. Where an answer lacks
//! a list the fold reads (the real routes always send one), the fold reads
//! it as empty; Bun would throw a TypeError there and send its message back
//! as the tool's error text.

use crate::jsdate::iso_string;
use canopy_auth::{CallerKind, Right, allows};
use canopy_core::codexrpc::{LineSplitter, RpcMessage, parse_message};
use canopy_core::js::{field, list_at, num_at, str_at, stringify, template, truthy, truthy_at};
use canopy_core::landing::{in_queue, land_word, queue_of, review_word, sent_back, stopped_whole};
use canopy_core::pathx::{js_cmp, pad_end};
use serde_json::{Map, Value, json};

pub const SERVER_NAME: &str = "canopy";
pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

pub const INSTRUCTIONS: &str = "These tools act on canopy's API with the token this session holds; a tool the token's rights do not cover is not listed. Answers are short text; json true on canopy_runs and canopy_queue gives the record. An error is the API's own words.";

/// One tool: its name, the right it needs, what it says it does, and its
/// inputs as (name, type, description), in the schema's order.
pub struct ToolSpec {
    pub name: &'static str,
    pub right: Right,
    pub description: &'static str,
    pub inputs: &'static [(&'static str, &'static str, &'static str)],
    pub required: Option<&'static [&'static str]>,
}

impl ToolSpec {
    /// `inputSchema`: a closed object of the inputs the call reads.
    pub fn input_schema(&self) -> Value {
        let mut properties = Map::new();
        for (name, kind, description) in self.inputs {
            properties.insert(
                (*name).into(),
                json!({"type": kind, "description": description}),
            );
        }
        let mut s = Map::new();
        s.insert("type".into(), json!("object"));
        s.insert("properties".into(), Value::Object(properties));
        if let Some(r) = self.required {
            s.insert("required".into(), json!(r));
        }
        s.insert("additionalProperties".into(), json!(false));
        Value::Object(s)
    }
}

/// `TOOLS`, in spec order: the read tools, the plan tools, the operate
/// tools.
pub static TOOLS: [ToolSpec; 10] = [
    ToolSpec {
        name: "canopy_status",
        right: Right::Read,
        description: "Every repo canopy shows on this backend: id, branch, ahead and behind, changed files, and the run working in it. A repo's id is what the other tools take.",
        inputs: &[],
        required: None,
    },
    ToolSpec {
        name: "canopy_runs",
        right: Right::Read,
        description: "The agent runs on this backend, oldest first. Give id for one run with its last steps; json true for the records as the API has them.",
        inputs: &[
            (
                "id",
                "string",
                "A run id to show one run and its last steps.",
            ),
            ("json", "boolean", "Return the API records as JSON."),
        ],
        required: None,
    },
    ToolSpec {
        name: "canopy_queue",
        right: Right::Read,
        description: "The landing queues: each repo's branch runs queued in order, what was sent back and why, and what is ready to land. repo narrows to one repo id or folder name; json true for the record.",
        inputs: &[
            ("repo", "string", "A repo id or folder name to show."),
            ("json", "boolean", "Return the API record as JSON."),
        ],
        required: None,
    },
    ToolSpec {
        name: "canopy_health",
        right: Right::Read,
        description: "canopy's health checks, the bad ones first.",
        inputs: &[],
        required: None,
    },
    ToolSpec {
        name: "canopy_work_note",
        right: Right::Plan,
        description: "Leave a note on a work item for the next session that picks this work up. In a run, the note goes on that run's own item and id is not needed.",
        inputs: &[
            ("text", "string", "What the next session needs to know."),
            ("id", "string", "The work item's id, outside a run."),
        ],
        required: Some(&["text"]),
    },
    ToolSpec {
        name: "canopy_run_start",
        right: Right::Plan,
        description: "Start a child: one branch run in the parent's repo at low priority, which lands through the landing queue under the repo's review rules and never pushes. Its note must stand alone, since it knows nothing of this session. In a run, the parent is this run; a run has at most three live children and a child starts none.",
        inputs: &[
            (
                "note",
                "string",
                "Everything the child needs to know to do its work.",
            ),
            ("action", "string", "ask (the default) or propose."),
            (
                "repo",
                "string",
                "The repo's id; it must be the parent's own.",
            ),
            ("parent", "string", "The parent run's id, outside a run."),
        ],
        required: Some(&["note"]),
    },
    ToolSpec {
        name: "canopy_say",
        right: Right::Plan,
        description: "Send text to a chat between turns by its id, as typing into its sheet would; it is the chat's next turn. A person's token (the page's, the CLI's) also reaches a run at work, at its next step; an agent's token (a shell's, the ranger's, a run's) does not, and a run's reaches only its kin.",
        inputs: &[
            ("id", "string", "The run or chat id."),
            ("text", "string", "Text to send to the run."),
        ],
        required: Some(&["id", "text"]),
    },
    ToolSpec {
        name: "canopy_wake",
        right: Right::Plan,
        description: "Wake the ranger later with a prompt: when (in 30m, 14:00, an ISO time), cron (five fields, local time) or run (a run id: when that run ends). Give exactly one of the three.",
        inputs: &[
            ("prompt", "string", "What the ranger should do."),
            (
                "when",
                "string",
                "A time such as in 30m, 14:00, or an ISO time.",
            ),
            (
                "cron",
                "string",
                "A five-field cron schedule in local time.",
            ),
            ("run", "string", "A run id; wake when that run ends."),
        ],
        required: Some(&["prompt"]),
    },
    ToolSpec {
        name: "canopy_land",
        right: Right::Operate,
        description: "A ready branch run into its repo's landing queue: rebase, gates, fast-forward; never a push. Only when the user asked for it to land.",
        inputs: &[(
            "run",
            "string",
            "The ready branch run id to queue for landing.",
        )],
        required: Some(&["run"]),
    },
    ToolSpec {
        name: "canopy_pr",
        right: Right::Operate,
        description: "Push a ready branch run and open a PR on GitHub in place of landing it; never a force push. Only when the user asked for a PR.",
        inputs: &[(
            "run",
            "string",
            "The ready branch run id to push and open as a PR.",
        )],
        required: Some(&["run"]),
    },
];

/// `toolsFor()`: the tools a caller's kind holds. A backend that only logs
/// its callers still answers one with no token, so there (`enforced` false)
/// nobody known is listed the read tools; one that enforces answers it
/// nothing, and it is listed none.
pub fn tools_for(kind: CallerKind, enforced: bool) -> Vec<&'static ToolSpec> {
    TOOLS
        .iter()
        .filter(|t| {
            allows(kind, t.right)
                || (!enforced && kind == CallerKind::None && t.right == Right::Read)
        })
        .collect()
}

fn is_active_status(run: &Value) -> bool {
    matches!(str_at(run, "status"), Some("working" | "waiting" | "idle"))
}

/// `foldStatus()`: one line per repo that is not archived: id, branch,
/// ahead and behind, changed files, and the runs going on it (a checkout
/// takes several).
pub fn fold_status(repos: &[Value], runs: &[Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for repo in repos {
        if truthy_at(repo, "archived") {
            continue;
        }
        let status = match repo.get("status") {
            None | Some(Value::Null) => {
                let why = match repo.get("error") {
                    None | Some(Value::Null) => "no status".to_string(),
                    Some(e) => template(Some(e)),
                };
                lines.push(format!("{}  {why}", field(repo, "id")));
                continue;
            }
            Some(s) => s,
        };
        let mut parts: Vec<String> = Vec::new();
        if num_at(status, "ahead").is_some_and(|n| n > 0.0) {
            parts.push(format!("{} ahead", field(status, "ahead")));
        }
        if num_at(status, "behind").is_some_and(|n| n > 0.0) {
            parts.push(format!("{} behind", field(status, "behind")));
        }
        let files = list_at(status, "files").len();
        if files > 0 {
            parts.push(format!("{files} changed"));
        }
        let active: Vec<&Value> = runs
            .iter()
            .filter(|r| r.get("repoId") == repo.get("id") && is_active_status(r))
            .collect();
        let summary = format!(
            "{}  {}{}",
            field(repo, "id"),
            field(status, "branch"),
            if parts.is_empty() {
                String::new()
            } else {
                format!(" {}", parts.join(" "))
            }
        );
        lines.push(if active.is_empty() {
            summary
        } else {
            let said: Vec<String> = active
                .iter()
                .map(|r| format!("{} {}", field(r, "verb"), field(r, "status")))
                .collect();
            format!(
                "{summary}  {}: {}",
                if active.len() == 1 { "run" } else { "runs" },
                said.join(", ")
            )
        });
    }
    if lines.is_empty() {
        "no repos".into()
    } else {
        lines.join("\n")
    }
}

/// `runLine()`: a run in one line: id, repo, status, verb, its name in
/// quotes when it has one, and its note's first line.
fn run_line(run: &Value) -> String {
    let note = field(run, "note");
    let note = note.split('\n').next().unwrap_or("");
    format!(
        "{}  {}  {}  {}{}{}",
        field(run, "id"),
        field(run, "repoId"),
        field(run, "status"),
        field(run, "verb"),
        if truthy_at(run, "name") {
            format!(" \"{}\"", field(run, "name"))
        } else {
            String::new()
        },
        if note.is_empty() {
            String::new()
        } else {
            format!("  {note}")
        }
    )
}

/// `foldRuns()`: one line per run in API order; an id adds its error and
/// last ten steps.
pub fn fold_runs(runs: &[Value], id: Option<&str>) -> String {
    let Some(id) = id else {
        return if runs.is_empty() {
            "no runs".into()
        } else {
            runs.iter().map(run_line).collect::<Vec<_>>().join("\n")
        };
    };
    let Some(run) = runs.iter().find(|r| str_at(r, "id") == Some(id)) else {
        return format!("no run {id}");
    };
    let mut lines = vec![run_line(run)];
    if truthy_at(run, "error") {
        lines.push(format!("error: {}", field(run, "error")));
    }
    let steps = list_at(run, "steps");
    for step in &steps[steps.len().saturating_sub(10)..] {
        if str_at(step, "kind") == Some("tool") {
            if let Some(tool) = step.get("tool").filter(|t| truthy(Some(t))) {
                lines.push(format!(
                    "  tool: {} ({})",
                    field(tool, "title"),
                    field(tool, "status")
                ));
            }
        } else {
            let text = match step.get("text") {
                None | Some(Value::Null) => String::new(),
                Some(t) => template(Some(t)),
            };
            lines.push(format!("  {}: {text}", field(step, "kind")));
        }
    }
    lines.join("\n")
}

/// `backWords()`: why an entry came back.
fn back_words(entry: &Value) -> String {
    let or = |key: &str, fallback: String| match entry.get(key) {
        None | Some(Value::Null) => fallback,
        Some(v) => template(Some(v)),
    };
    if str_at(entry, "state") == Some("red") {
        format!("{} failed", or("gate", "a gate".into()))
    } else {
        or("reason", field(entry, "state"))
    }
}

/// `foldQueue()`: a repo's queue in order, with sent-back reasons and ready
/// branch runs.
pub fn fold_queue(info: &Value, repo: Option<&str>) -> String {
    let entries = list_at(info, "entries");
    let runs = list_at(info, "runs");
    let mut repos: Vec<String> = Vec::new();
    for r in entries.iter().chain(runs) {
        let id = field(r, "repoId");
        if !repos.contains(&id) {
            repos.push(id);
        }
    }
    repos.sort_by(|a, b| js_cmp(a, b));
    let of = |r: &Value, id: &str| field(r, "repoId") == id;
    let mut lines: Vec<String> = Vec::new();
    for id in &repos {
        let path = entries
            .iter()
            .find(|e| of(e, id))
            .or_else(|| runs.iter().find(|r| of(r, id)))
            .and_then(|r| r.get("repoPath"))
            .filter(|p| !p.is_null())
            .map_or(String::new(), |p| template(Some(p)));
        let named = match repo {
            None => true,
            Some(want) => want == id || path.split('/').next_back() == Some(want),
        };
        if !named {
            continue;
        }
        let mine: Vec<&Value> = entries.iter().filter(|e| of(e, id)).collect();
        let queued = queue_of(entries, id);
        let back: Vec<&Value> = mine.iter().copied().filter(|e| sent_back(e)).collect();
        let taken: Vec<&Value> = mine
            .iter()
            .filter(|e| in_queue(e) || str_at(e, "state") == Some("landed") || sent_back(e))
            .filter_map(|e| e.get("id"))
            .collect();
        let free = |r: &&Value| !r.get("id").is_some_and(|i| taken.contains(&i));
        let ready: Vec<&Value> = runs
            .iter()
            .filter(|r| of(r, id) && str_at(r, "state") == Some("ready"))
            .filter(free)
            .collect();
        let stopped: Vec<&Value> = runs
            .iter()
            .filter(|r| of(r, id) && stopped_whole(r))
            .filter(free)
            .collect();
        if queued.len() + back.len() + ready.len() + stopped.len() == 0 {
            continue;
        }
        lines.push(id.clone());
        for entry in &queued {
            lines.push(format!(
                "  {} {}",
                pad_end(&land_word(entry, entries), 16),
                field(entry, "branch")
            ));
        }
        for entry in &back {
            let why = back_words(entry);
            lines.push(format!(
                "  {} {}  {}",
                pad_end(&land_word(entry, entries), 16),
                field(entry, "branch"),
                why.split('\n').next_back().unwrap_or("")
            ));
        }
        let review = |r: &Value| match r.get("review").filter(|v| truthy(Some(v))) {
            Some(v) => review_word(v),
            None => "sorting".into(),
        };
        for run in &ready {
            lines.push(format!(
                "  {} {}  {}  canopy_land {}",
                pad_end("ready", 16),
                field(run, "branch"),
                review(run),
                field(run, "runId")
            ));
        }
        for run in &stopped {
            lines.push(format!(
                "  {} {}  can land: {}  canopy_land {}",
                pad_end("stopped", 16),
                field(run, "branch"),
                review(run),
                field(run, "runId")
            ));
        }
    }
    if lines.is_empty() {
        "no branch runs in any queue".into()
    } else {
        lines.join("\n")
    }
}

/// `foldHealth()`: a count line followed by down and gave-up checks, then
/// the rest.
pub fn fold_health(checks: &[Value]) -> String {
    if checks.is_empty() {
        return "no checks".into();
    }
    let is_bad = |c: &&Value| matches!(str_at(c, "state"), Some("down" | "gave-up"));
    let bad: Vec<&Value> = checks.iter().filter(is_bad).collect();
    let rest = checks.iter().filter(|c| !is_bad(c));
    let heading = if bad.is_empty() {
        format!("all {} checks ok", checks.len())
    } else {
        format!("{} of {} checks down", bad.len(), checks.len())
    };
    let mut lines = vec![heading];
    for c in bad.iter().copied().chain(rest) {
        lines.push(format!(
            "  {} {}{}  {}",
            pad_end(&field(c, "state"), 8),
            field(c, "label"),
            if truthy_at(c, "why") {
                format!("  {}", field(c, "why"))
            } else {
                String::new()
            },
            field(c, "id")
        ));
    }
    lines.join("\n")
}

/// `CanopyApi`: one backend call; Err is its `error` text, else `<base>
/// answered <status>`.
pub(crate) trait CanopyApi {
    async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String>;
}

/// `McpContext`.
pub(crate) struct McpContext<'a, A: CanopyApi> {
    pub api: &'a A,
    /// the token's kind, from GET /api/auth at start
    pub kind: CallerKind,
    /// false when that backend only logs its callers (`tools_for`)
    pub enforced: bool,
    /// CANOPY_RUN when set: the parent `canopy_run_start` names by default
    pub run: Option<String>,
    /// what serverInfo says
    pub version: String,
}

/// `ToolResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

fn string_arg(args: Option<&Value>, name: &str) -> Option<String> {
    args?.as_object()?.get(name)?.as_str().map(String::from)
}

fn boolean_arg(args: Option<&Value>, name: &str) -> bool {
    args.and_then(Value::as_object)
        .is_some_and(|o| o.get(name) == Some(&Value::Bool(true)))
}

/// `callTool()`: runs one tool. The API's errors become the same short text
/// canopy returned.
pub(crate) async fn call_tool<A: CanopyApi>(
    name: &str,
    args: Option<&Value>,
    ctx: &McpContext<'_, A>,
) -> ToolResult {
    match tool_text(name, args, ctx).await {
        Ok(text) => ToolResult {
            text,
            is_error: false,
        },
        Err(text) => ToolResult {
            text,
            is_error: true,
        },
    }
}

async fn tool_text<A: CanopyApi>(
    name: &str,
    args: Option<&Value>,
    ctx: &McpContext<'_, A>,
) -> Result<String, String> {
    let invalid = |field: &str| format!("{name} needs {field}");
    let api = ctx.api;
    match name {
        "canopy_status" => {
            let tree = api.call("GET", "/api/tree", None).await?;
            let runs = api.call("GET", "/api/runs", None).await?;
            Ok(fold_status(
                list_at(&tree, "repos"),
                runs.as_array().map_or(&[][..], Vec::as_slice),
            ))
        }
        "canopy_runs" => {
            let runs = api.call("GET", "/api/runs", None).await?;
            let list = runs.as_array().map_or(&[][..], Vec::as_slice);
            let id = string_arg(args, "id");
            if boolean_arg(args, "json") {
                return Ok(match &id {
                    Some(id) => stringify(
                        list.iter()
                            .find(|r| str_at(r, "id") == Some(id.as_str()))
                            .unwrap_or(&Value::Null),
                    ),
                    None => stringify(&runs),
                });
            }
            Ok(fold_runs(list, id.as_deref()))
        }
        "canopy_queue" => {
            let info = api.call("GET", "/api/landing", None).await?;
            if boolean_arg(args, "json") {
                return Ok(stringify(&info));
            }
            Ok(fold_queue(&info, string_arg(args, "repo").as_deref()))
        }
        "canopy_health" => {
            let health = api.call("GET", "/api/health", None).await?;
            Ok(fold_health(list_at(&health, "checks")))
        }
        "canopy_work_note" => {
            let text = string_arg(args, "text").ok_or_else(|| invalid("text"))?;
            let mut body = Map::new();
            body.insert("text".into(), json!(text));
            if let Some(id) = string_arg(args, "id") {
                body.insert("id".into(), json!(id));
            }
            let item = api
                .call("POST", "/api/work/note", Some(&Value::Object(body)))
                .await?;
            Ok(format!("noted on {}", field(&item, "id")))
        }
        "canopy_run_start" => {
            let note = string_arg(args, "note").ok_or_else(|| invalid("note"))?;
            let mut body = Map::new();
            body.insert("note".into(), json!(note));
            if let Some(a) = string_arg(args, "action") {
                body.insert("action".into(), json!(a));
            }
            if let Some(r) = string_arg(args, "repo") {
                body.insert("repo".into(), json!(r));
            }
            if let Some(p) = string_arg(args, "parent").or_else(|| ctx.run.clone()) {
                body.insert("parent".into(), json!(p));
            }
            let child = api
                .call("POST", "/api/runs/child", Some(&Value::Object(body)))
                .await?;
            let branch = child
                .get("branch")
                .filter(|b| b.is_object())
                .and_then(|b| b.get("name"))
                .filter(|n| !n.is_null())
                .map_or_else(|| "its branch".to_string(), |n| template(Some(n)));
            Ok(format!("started run {} on {branch}", field(&child, "id")))
        }
        "canopy_say" => {
            let id = string_arg(args, "id").ok_or_else(|| invalid("id"))?;
            let text = string_arg(args, "text").ok_or_else(|| invalid("text"))?;
            let run = api
                .call(
                    "POST",
                    "/api/runs/say",
                    Some(&json!({"id": id, "text": text})),
                )
                .await?;
            Ok(format!(
                "said to {}, now {}",
                field(&run, "id"),
                field(&run, "status")
            ))
        }
        "canopy_wake" => {
            let prompt = string_arg(args, "prompt").ok_or_else(|| invalid("prompt"))?;
            let mut body = Map::new();
            body.insert("prompt".into(), json!(prompt));
            for key in ["when", "cron", "run"] {
                if let Some(v) = string_arg(args, key) {
                    body.insert(key.into(), json!(v));
                }
            }
            // a run's wake is stamped as the run's by the server
            if !matches!(ctx.kind, CallerKind::Ranger | CallerKind::Run) {
                body.insert("by".into(), json!("eric"));
            }
            let wake = api
                .call("POST", "/api/ranger/wakes", Some(&Value::Object(body)))
                .await?;
            let when = if truthy_at(&wake, "cron") {
                format!("cron {}", field(&wake, "cron"))
            } else if truthy_at(&wake, "run") {
                format!("the end of run {}", field(&wake, "run"))
            } else {
                let at = match wake.get("at") {
                    None | Some(Value::Null) => 0.0,
                    Some(v) => v.as_f64().unwrap_or(f64::NAN),
                };
                iso_string(at).ok_or("Invalid Date")?
            };
            Ok(format!("wake {} set for {when}", field(&wake, "id")))
        }
        "canopy_land" => {
            let run = string_arg(args, "run").ok_or_else(|| invalid("run"))?;
            let entry = api
                .call("POST", "/api/landing/land", Some(&json!({ "run": run })))
                .await?;
            Ok(format!(
                "{}: {} into {}",
                land_word(&entry, std::slice::from_ref(&entry)),
                field(&entry, "branch"),
                field(&entry, "target")
            ))
        }
        "canopy_pr" => {
            let run = string_arg(args, "run").ok_or_else(|| invalid("run"))?;
            let pr = api
                .call("POST", "/api/prs/open", Some(&json!({ "run": run })))
                .await?;
            Ok(format!(
                "PR #{} opened: {}",
                field(&pr, "number"),
                field(&pr, "url")
            ))
        }
        other => Err(format!("no tool named {other}")),
    }
}

fn rpc_error(id: &Value, code: i64, message: String) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// `handleMessage()`: one message in, at most one reply out. Notifications
/// and responses have none.
pub(crate) async fn handle_message<A: CanopyApi>(
    msg: &RpcMessage,
    ctx: &McpContext<'_, A>,
) -> Option<Value> {
    let RpcMessage::Request { id, method, params } = msg else {
        return None;
    };
    let params = params.as_ref().filter(|p| p.is_object());
    Some(match method.as_str() {
        "initialize" => {
            let requested = params
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str);
            let version = requested
                .filter(|v| PROTOCOL_VERSIONS.contains(v))
                .unwrap_or(PROTOCOL_VERSION);
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": ctx.version},
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => {
            let tools: Vec<Value> = tools_for(ctx.kind, ctx.enforced)
                .iter()
                .map(|t| json!({"name": t.name, "description": t.description, "inputSchema": t.input_schema()}))
                .collect();
            rpc_result(id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
                return Some(rpc_error(id, -32602, "tools/call needs a name".into()));
            };
            let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
                return Some(rpc_error(id, -32602, format!("no tool named {name}")));
            };
            if !tools_for(ctx.kind, ctx.enforced)
                .iter()
                .any(|t| t.name == tool.name)
            {
                return Some(rpc_error(
                    id,
                    -32602,
                    format!("{} is not a tool this {} token holds", tool.name, ctx.kind),
                ));
            }
            let result = call_tool(tool.name, params.and_then(|p| p.get("arguments")), ctx).await;
            let mut out = Map::new();
            out.insert(
                "content".into(),
                json!([{"type": "text", "text": result.text}]),
            );
            if result.is_error {
                out.insert("isError".into(), json!(true));
            }
            rpc_result(id, Value::Object(out))
        }
        other => rpc_error(id, -32601, format!("no method {other}")),
    })
}

/// `serve()`: reads `input` to its end, one JSON-RPC message per line;
/// other lines are dropped. Each reply goes to `write` as one line of JSON
/// before the next message is read, so replies keep the requests' order.
pub(crate) async fn serve<A: CanopyApi, R: tokio::io::AsyncRead + Unpin>(
    mut input: R,
    write: &mut dyn FnMut(String),
    ctx: &McpContext<'_, A>,
) {
    use tokio::io::AsyncReadExt as _;
    let mut splitter = LineSplitter::default();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = match input.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for line in splitter.push(&chunk[..n]) {
            one_line(&line, write, ctx).await;
        }
    }
    for line in splitter.flush() {
        one_line(&line, write, ctx).await;
    }
}

async fn one_line<A: CanopyApi>(
    line: &str,
    write: &mut dyn FnMut(String),
    ctx: &McpContext<'_, A>,
) {
    let Some(message) = parse_message(line) else {
        return;
    };
    if let Some(reply) = handle_message(&message, ctx).await {
        write(stringify(&reply));
    }
}

#[cfg(test)]
mod tests;
