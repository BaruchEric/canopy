//! `canopy health` (`src/cli/health.ts`): every check on a backend, one
//! check's history, the button, a live follow, a repo's own checks and
//! canopy's layer over them, and a health file's lint and starter. The
//! listing exits 1 while something is down, so a script or a compose
//! healthcheck can read it.
//!
//! health.ts also holds the CLI's shared `ask`, `askText`, `take`, `has`,
//! `targetsOf` and `backendTargets`; those are ask.rs's. A check is the
//! JSON a backend sends (`HealthCheck`, `RepoHealthInfo` in types.ts), read
//! as the TypeScript reads it.

use crate::api::Caller;
use crate::ask::{
    Ask, Target, backend_targets, did_not_answer, encode_component, has, is_origin, shift, take,
};
use crate::out::Out;
use canopy_core::js::{field, list_at, num_at, str_at, template, truthy_at};
use canopy_core::pathx::{dirname, join, pad_end, resolve};
use canopy_core::repohealth::{HEALTH_FILE, check_target, normalize_check, parse_health_file};
use canopy_core::tasks::{TASK_FILES, TaskFiles, detect_tasks, parse_task_file};
use serde_json::{Map, Value, json};
use std::future::Future;
use std::pin::Pin;
use std::task::Poll;

/// `HEALTH_USAGE`.
pub const HEALTH_USAGE: &str = "usage: canopy health [list] [--bad] [--repo R] [--canopy] [--json]
       canopy health show <id> [--on NAME] [--json]
       canopy health heal <id> [--on NAME]
       canopy health watch [--bad] [--repo R]
       canopy health checks <repo> [--json]
       canopy health add <repo> <name> (--http URL [--expect N] | --port N [--host H] | --task T | --compose S [--file F] | --command CMD)
                         [--fix CMD] [--heal auto|button|none] [--while TASK] [--every SECONDS]
       canopy health rm <repo> <name>
       canopy health lint [dir]
       canopy health init [dir]
  the listing, show, heal and watch ask every backend the home one lists (Mac, mini);
  --on NAME keeps one, --backend URL asks only that address ($CANOPY_API, else 127.0.0.1:7850);
  checks, add and rm speak to the home backend, or to --on's
  <repo> is an id the backend knows (web-apps/ripe) or a path (.)";

/// the flags the kinds take: exactly one names the kind
const KIND_FLAGS: [(&str, &str); 5] = [
    ("--http", "http"),
    ("--port", "port"),
    ("--task", "task"),
    ("--compose", "compose"),
    ("--command", "command"),
];

/// render.ts's palette, on when stdout is a terminal and NO_COLOR is not
/// set (main.rs decides).
#[derive(Debug, Clone, Copy, Default)]
pub struct Paint {
    pub color: bool,
}

impl Paint {
    fn rgb(&self, (r, g, b): (u8, u8, u8), s: &str) -> String {
        if self.color {
            format!("\x1b[38;2;{r};{g};{b}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }
    fn moss(&self, s: &str) -> String {
        self.rgb((147, 201, 139), s)
    }
    fn lichen(&self, s: &str) -> String {
        self.rgb((217, 179, 107), s)
    }
    fn rust(&self, s: &str) -> String {
        self.rgb((201, 123, 95), s)
    }
    fn dim(&self, s: &str) -> String {
        if self.color {
            format!("\x1b[2m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }
    fn bold(&self, s: &str) -> String {
        if self.color {
            format!("\x1b[1m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }
}

/// `Number(v)` as JSON keeps it: a number JSON cannot hold (NaN, Infinity)
/// as null, which every rule of `normalizeCheck` refuses as it refuses
/// those.
fn num(v: &str) -> Value {
    let n = canopy_core::workflow::to_number(v);
    if !n.is_finite() {
        Value::Null
    } else if n.trunc() == n && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `parseCheckArgs()`: add's flags as a check, through the rules the
/// server keeps, or what is wrong.
pub fn parse_check_args(name: &str, flags: &[String]) -> Result<Value, String> {
    let mut args = flags.to_vec();
    let kinds: Vec<&(&str, &str)> = KIND_FLAGS
        .iter()
        .filter(|(f, _)| args.iter().any(|a| a == f))
        .collect();
    let [(flag, kind)] = kinds.as_slice() else {
        return Err("name one kind: --http, --port, --task, --compose or --command".into());
    };
    let Some(value) = take(&mut args, flag) else {
        return Err(format!("{flag} needs a value"));
    };
    let mut raw = Map::new();
    raw.insert("name".into(), json!(name));
    raw.insert("kind".into(), json!(kind));
    match *kind {
        "http" => raw.insert("url".into(), json!(value)),
        "port" => raw.insert("port".into(), num(&value)),
        "task" => raw.insert("task".into(), json!(value)),
        "compose" => raw.insert("service".into(), json!(value)),
        _ => raw.insert("run".into(), json!(value)),
    };
    if let Some(expect) = take(&mut args, "--expect") {
        raw.insert("expect".into(), num(&expect));
    }
    for (flag, key) in [
        ("--host", "host"),
        ("--file", "file"),
        ("--fix", "fix"),
        ("--heal", "heal"),
        ("--while", "while"),
    ] {
        if let Some(v) = take(&mut args, flag) {
            raw.insert(key.into(), json!(v));
        }
    }
    if let Some(every) = take(&mut args, "--every") {
        raw.insert("every".into(), num(&every));
    }
    if !args.is_empty() {
        return Err(format!("not understood: {}", args.join(" ")));
    }
    normalize_check(&Value::Object(raw))
}

/// `paintState()`: a state's word in its colour.
pub fn paint_state(state: Option<&str>, p: Paint) -> String {
    match state {
        Some("ok") => p.moss("ok"),
        Some("down") => p.rust("down"),
        Some("gave-up") => p.rust("gave up"),
        Some("off") => p.dim("off"),
        Some("healing") => p.lichen("healing"),
        Some("unknown") => p.lichen("checking"),
        _ => p.lichen("undefined"),
    }
}

fn is_bad(c: &Value) -> bool {
    matches!(str_at(c, "state"), Some("down" | "gave-up"))
}

/// `checkLine()`: one check on one line: state, label, why, detail, id.
pub fn check_line(c: &Value, p: Paint) -> String {
    let said = |k: &str| {
        if truthy_at(c, k) {
            p.dim(&format!("  {}", field(c, k)))
        } else {
            String::new()
        }
    };
    format!(
        "{} {}{}{}  {}",
        pad_end(&paint_state(str_at(c, "state"), p), 20),
        p.bold(&field(c, "label")),
        said("why"),
        said("detail"),
        p.dim(&field(c, "id"))
    )
}

/// `ListFilter`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListFilter {
    pub bad: bool,
    /// a repo's id: its checks only
    pub repo: Option<String>,
    /// canopy's own pieces only
    pub canopy: bool,
}

/// `filterChecks()`.
pub fn filter_checks(checks: &[Value], f: &ListFilter) -> Vec<Value> {
    checks
        .iter()
        .filter(|c| {
            let scope = c.get("scope").unwrap_or(&Value::Null);
            let kind = str_at(scope, "kind");
            (!f.bad || is_bad(c))
                && (!f.canopy || kind == Some("canopy"))
                && f.repo
                    .as_deref()
                    .is_none_or(|r| kind == Some("repo") && str_at(scope, "repoId") == Some(r))
        })
        .cloned()
        .collect()
}

/// `clock()`: `new Date(v).toLocaleString()`, null as the epoch and
/// anything not a number as "Invalid Date".
fn clock(v: Option<&Value>) -> String {
    match v {
        Some(Value::Null) => crate::jsdate::locale_string(0.0),
        Some(Value::Number(n)) => crate::jsdate::locale_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => crate::jsdate::locale_string(if *b { 1.0 } else { 0.0 }),
        _ => "Invalid Date".into(),
    }
}

/// `showLines()`: one check at length: what it is, how it heals, what it
/// has been through.
pub fn show_lines(c: &Value, now: f64, p: Paint) -> Vec<String> {
    let why = if truthy_at(c, "why") {
        format!("  {}", field(c, "why"))
    } else {
        String::new()
    };
    let mut out = vec![
        format!(
            "{}  {}{why}",
            p.bold(&field(c, "label")),
            paint_state(str_at(c, "state"), p)
        ),
        p.dim(&field(c, "id")),
    ];
    out.push(format!("since      {}", clock(c.get("since"))));
    if !matches!(c.get("lastOk"), Some(Value::Null)) {
        out.push(format!("last ok    {}", clock(c.get("lastOk"))));
    }
    if truthy_at(c, "detail") {
        out.push(format!("detail     {}", field(c, "detail")));
    }
    let by_hand = if truthy_at(c, "button") {
        ", and by hand (canopy health heal)"
    } else {
        ""
    };
    out.push(format!("heals      {}{by_hand}", field(c, "heal")));
    if let Some(fails) = num_at(c, "fails").filter(|n| *n > 0.0) {
        let s = if fails == 1.0 { "" } else { "s" };
        out.push(format!(
            "fails      {} heal{s} that did not hold",
            field(c, "fails")
        ));
    }
    match c.get("nextHeal") {
        Some(Value::Null) => {}
        next => {
            let secs = next
                .and_then(Value::as_f64)
                .map_or(f64::NAN, |n| ((n - now) / 1000.0).round());
            // Math.max(0, x): NaN stays NaN
            let word = if secs.is_nan() {
                "NaN".to_string()
            } else {
                canopy_core::store::js_number(secs.max(0.0))
            };
            out.push(format!("next heal  in {word}s"));
        }
    }
    let history = list_at(c, "history");
    if !history.is_empty() {
        out.push("history".into());
        for h in history.iter().rev() {
            let why = if truthy_at(h, "why") {
                p.dim(&format!("  {}", field(h, "why")))
            } else {
                String::new()
            };
            out.push(format!(
                "  {}  {}{why}",
                p.dim(&clock(h.get("at"))),
                paint_state(str_at(h, "state"), p)
            ));
        }
    }
    out
}

/// `defLines()`: a repo's checks as defined: name, kind and target, heal,
/// where from, and why one does not run.
pub fn def_lines(info: &Value, p: Paint) -> Vec<String> {
    let mut out: Vec<String> = list_at(info, "checks")
        .iter()
        .map(|c| {
            // an http or port check with no fix has nothing to run, whatever its mode
            let kind = str_at(c, "kind");
            let can_heal = c.get("fix").is_some() || matches!(kind, Some("task" | "compose"));
            let heal = if truthy_at(c, "blocked") || !can_heal {
                "none".to_string()
            } else {
                match c.get("heal").filter(|h| !h.is_null()) {
                    Some(h) => template(Some(h)),
                    None => "button".into(),
                }
            };
            let from = if str_at(c, "source") == Some("repo") {
                HEALTH_FILE
            } else {
                "canopy's config"
            };
            let fix = if truthy_at(c, "fix") {
                p.dim(&format!("  fix: {}", field(c, "fix")))
            } else {
                String::new()
            };
            let every = match c.get("every").filter(|e| !e.is_null()) {
                Some(e) => template(Some(e)),
                None => "30".into(),
            };
            let during = if truthy_at(c, "while") {
                format!(", while {} runs", field(c, "while"))
            } else {
                String::new()
            };
            let blocked = if truthy_at(c, "blocked") {
                format!("  {}", p.rust(&field(c, "blocked")))
            } else {
                String::new()
            };
            format!(
                "{} {} {}{fix}  {}{blocked}",
                p.bold(&pad_end(&field(c, "name"), 14)),
                pad_end(&field(c, "kind"), 8),
                check_target(c),
                p.dim(&format!("heal {heal}, every {every}s{during}, from {from}"))
            )
        })
        .collect();
    for e in list_at(info, "errors") {
        out.push(p.rust(&template(Some(e))));
    }
    if out.is_empty() {
        out.push(p.dim(&format!(
            "no checks: add one with canopy health add, or list them in {HEALTH_FILE}"
        )));
    }
    out
}

/// `new Map(checks.map((c) => [c.id, c]))`: a later check of one id
/// replaces the earlier in its place.
fn by_id(checks: &[Value]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::new();
    for c in checks {
        let id = field(c, "id");
        match out.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = c.clone(),
            None => out.push((id, c.clone())),
        }
    }
    out
}

/// `changeLines()`: what changed between two lists: a new check, one gone,
/// or a state or why that moved. Unchanged checks say nothing.
pub fn change_lines(before: &[(String, Value)], after: &[Value], p: Paint) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for c in after {
        let id = field(c, "id");
        let old = before.iter().find(|(k, _)| *k == id).map(|(_, v)| v);
        if old.is_none_or(|o| o.get("state") != c.get("state") || o.get("why") != c.get("why")) {
            out.push(check_line(c, p));
        }
        seen.push(id);
    }
    for (id, c) in before {
        if !seen.contains(id) {
            out.push(format!(
                "{} {}  {}",
                p.dim(&pad_end("gone", 20)),
                p.bold(&field(c, "label")),
                p.dim(id)
            ));
        }
    }
    out
}

/// `starterFile()`: a starter health file for a repo's task files: its dev
/// task, healed on its own, when it has one.
pub fn starter_file(files: &TaskFiles) -> String {
    let mut names: Vec<Value> = detect_tasks(files)
        .iter()
        .map(|t| t["name"].clone())
        .collect();
    if let Some(text) = files.repo_file.as_deref().filter(|t| !t.is_empty()) {
        names.extend(parse_task_file(text).0.iter().map(|p| p["name"].clone()));
    }
    let checks = if names.iter().any(|n| n == "dev") {
        json!([{"name": "dev", "kind": "task", "task": "dev", "heal": "auto"}])
    } else {
        json!([])
    };
    let text = serde_json::to_string_pretty(&json!({ "checks": checks })).unwrap_or_default();
    format!("{text}\n")
}

/// `isPath()` for a repo argument.
fn is_path(v: &str) -> bool {
    v == "."
        || v.starts_with('/')
        || v.starts_with("./")
        || v.starts_with("../")
        || v.starts_with('~')
}

/// a leading `~` as $HOME
fn home_of(v: &str) -> String {
    match v.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            format!(
                "{}{rest}",
                std::env::var("HOME").unwrap_or_else(|_| "~".into())
            )
        }
        _ => v.to_string(),
    }
}

/// One backend's checks, or why it did not answer (`everyList`'s rows).
struct Listed {
    t: Target,
    checks: Vec<Value>,
    error: Option<String>,
}

async fn every_list(ask: &impl Ask, ts: &[Target]) -> Vec<Listed> {
    let mut out = Vec::new();
    for t in ts {
        out.push(match ask.ask(t, "GET", "/api/health", None).await {
            Ok(info) => Listed {
                t: t.clone(),
                checks: list_at(&info, "checks").to_vec(),
                error: None,
            },
            Err(e) => Listed {
                t: t.clone(),
                checks: Vec::new(),
                error: Some(e.message().to_string()),
            },
        });
    }
    out
}

/// `call()`: a request whose failure is the command's.
async fn call(
    ask: &impl Ask,
    t: &Target,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    ask.ask(t, method, path, body)
        .await
        .map_err(|e| did_not_answer(&t.name, &e))
}

/// `repoId()`: an id as given, or the id of the repo at a path the backend
/// scans.
async fn repo_id(ask: &impl Ask, t: &Target, arg: Option<&str>) -> Result<String, String> {
    let Some(arg) = arg.filter(|a| !a.is_empty()) else {
        return Err(HEALTH_USAGE.into());
    };
    if !is_path(arg) {
        return Ok(arg.to_string());
    }
    let path = std::fs::canonicalize(resolve(&home_of(arg)))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| format!("no such folder: {arg}"))?;
    let tree = call(ask, t, "GET", "/api/tree", None).await?;
    list_at(&tree, "repos")
        .iter()
        .find(|r| str_at(r, "path") == Some(path.as_str()))
        .map(|r| field(r, "id"))
        .ok_or_else(|| format!("{} does not scan {path}", t.name))
}

/// `filter()`: --repo is an id on every backend; a path is read on the first.
async fn read_filter(
    ask: &impl Ask,
    args: &mut Vec<String>,
    first: &Target,
) -> Result<ListFilter, String> {
    let repo = take(args, "--repo");
    let bad = has(args, "--bad");
    let canopy = has(args, "--canopy");
    let repo = match repo {
        Some(r) => Some(repo_id(ask, first, Some(&r)).await?),
        None => None,
    };
    Ok(ListFilter { bad, repo, canopy })
}

async fn repo_info(
    ask: &impl Ask,
    t: &Target,
    method: &str,
    id: &str,
    extra: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let path = format!("/api/repos/health?id={}{extra}", encode_component(id));
    call(ask, t, method, &path, body).await
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// What `health_cmd` needs beyond the backend: the palette, the clock, and
/// where watch's lines go as they come.
pub(crate) struct HealthEnv<'a> {
    pub paint: Paint,
    pub now: f64,
    pub live: &'a dyn Fn(String),
}

/// `healthCommand()`.
pub(crate) async fn health_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    env: &HealthEnv<'_>,
) -> Result<(), String> {
    let p = env.paint;
    let given = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let json = has(&mut args, "--json");
    let sub = match args.first() {
        Some(a) if !a.starts_with("--") => shift(&mut args).unwrap_or_default(),
        _ => "list".to_string(),
    };
    let home_target = Target::home(&home);
    let targets = || backend_targets(ask, &home, given.is_some(), on.as_deref());
    // the backend a repo command speaks to: --on's, else home
    let repo_target = async || -> Result<Target, String> {
        if on.is_none() {
            return Ok(home_target.clone());
        }
        Ok(targets()
            .await?
            .into_iter()
            .next()
            .unwrap_or_else(|| home_target.clone()))
    };

    match sub.as_str() {
        "list" => {
            let ts = targets().await?;
            let f = read_filter(ask, &mut args, ts.first().unwrap_or(&home_target)).await?;
            if !args.is_empty() {
                return Err(HEALTH_USAGE.into());
            }
            let all: Vec<Listed> = every_list(ask, &ts)
                .await
                .into_iter()
                .map(|r| Listed {
                    checks: filter_checks(&r.checks, &f),
                    ..r
                })
                .collect();
            let many = all.len() > 1;
            if json {
                // one backend keeps the plain list scripts already read
                let shown = match all.first() {
                    Some(one) if !many && one.error.is_none() => json!(one.checks),
                    _ => Value::Array(
                        all.iter()
                            .map(|r| match &r.error {
                                Some(e) => json!({"backend": r.t.name, "error": e}),
                                None => json!({"backend": r.t.name, "checks": r.checks}),
                            })
                            .collect(),
                    ),
                };
                out.line(pretty(&shown));
            } else {
                for r in &all {
                    if many {
                        out.line(p.bold(&r.t.name));
                    }
                    let pad = if many { "  " } else { "" };
                    if let Some(e) = &r.error {
                        out.line(format!(
                            "{pad}{} {}",
                            p.rust(&pad_end("unreachable", 20)),
                            p.dim(e)
                        ));
                    } else if r.checks.is_empty() {
                        out.line(format!(
                            "{pad}{}",
                            p.dim(if f.bad {
                                "nothing is down"
                            } else {
                                "no checks"
                            })
                        ));
                    } else {
                        for c in &r.checks {
                            out.line(format!("{pad}{}", check_line(c, p)));
                        }
                    }
                }
            }
            // a script or a compose healthcheck reads the exit code
            if all
                .iter()
                .any(|r| r.error.is_some() || r.checks.iter().any(is_bad))
            {
                out.failed = true;
            }
            Ok(())
        }
        "show" => {
            let Some(id) = args.first().filter(|a| !a.is_empty()).cloned() else {
                return Err("usage: canopy health show <id> [--on NAME]".into());
            };
            let found: Vec<(String, Value)> = every_list(ask, &targets().await?)
                .await
                .into_iter()
                .flat_map(|r| {
                    let name = r.t.name.clone();
                    r.checks
                        .into_iter()
                        .filter(|c| str_at(c, "id") == Some(id.as_str()))
                        .map(move |c| (name.clone(), c))
                })
                .collect();
            if found.is_empty() {
                return Err(format!("no check {id}; canopy health lists them"));
            }
            if json {
                let shown = if let [(_, c)] = found.as_slice() {
                    c.clone()
                } else {
                    Value::Array(
                        found
                            .iter()
                            .map(|(name, c)| {
                                let mut o = Map::new();
                                o.insert("backend".into(), json!(name));
                                if let Some(m) = c.as_object() {
                                    for (k, v) in m {
                                        o.insert(k.clone(), v.clone());
                                    }
                                }
                                Value::Object(o)
                            })
                            .collect(),
                    )
                };
                out.line(pretty(&shown));
            } else {
                let many = found.len() > 1;
                let blocks: Vec<String> = found
                    .iter()
                    .map(|(name, c)| {
                        let mut lines = Vec::new();
                        if many {
                            lines.push(p.bold(&format!("on {name}")));
                        }
                        lines.extend(show_lines(c, env.now, p));
                        lines.join("\n")
                    })
                    .collect();
                out.line(blocks.join("\n\n"));
            }
            if found.iter().any(|(_, c)| is_bad(c)) {
                out.failed = true;
            }
            Ok(())
        }
        "heal" => {
            let Some(id) = args.first().filter(|a| !a.is_empty()).cloned() else {
                return Err("usage: canopy health heal <id> [--on NAME]".into());
            };
            let holders: Vec<Target> = every_list(ask, &targets().await?)
                .await
                .into_iter()
                .filter(|r| {
                    r.checks
                        .iter()
                        .any(|c| str_at(c, "id") == Some(id.as_str()))
                })
                .map(|r| r.t)
                .collect();
            let t = match holders.as_slice() {
                [] => return Err(format!("no check {id}; canopy health lists them")),
                [one] => one.clone(),
                many => {
                    let names: Vec<&str> = many.iter().map(|t| t.name.as_str()).collect();
                    return Err(format!(
                        "{id} is on {}; say which with --on NAME",
                        names.join(" and ")
                    ));
                }
            };
            let path = format!("/api/health/heal?id={}", encode_component(&id));
            let c = call(ask, &t, "POST", &path, None).await?;
            out.line(check_line(&c, p));
            if is_bad(&c) {
                out.failed = true;
            }
            Ok(())
        }
        "watch" => {
            let ts = targets().await?;
            let f = read_filter(ask, &mut args, ts.first().unwrap_or(&home_target)).await?;
            let many = ts.len() > 1;
            let follows = ts
                .iter()
                .map(|t| {
                    let prefix = if many {
                        format!("{} ", t.name)
                    } else {
                        String::new()
                    };
                    follow(ask, caller, t, &f, prefix, p, env.live)
                })
                .collect();
            join_all(follows).await;
            Err("every event stream ended".into())
        }
        "checks" => {
            let t = repo_target().await?;
            let id = repo_id(ask, &t, args.first().map(String::as_str)).await?;
            let info = repo_info(ask, &t, "GET", &id, "", None).await?;
            out.line(if json {
                pretty(&info)
            } else {
                def_lines(&info, p).join("\n")
            });
            if !list_at(&info, "errors").is_empty() {
                out.failed = true;
            }
            Ok(())
        }
        "add" => {
            let t = repo_target().await?;
            let id = repo_id(ask, &t, args.first().map(String::as_str)).await?;
            let Some(name) = args.get(1).filter(|n| !n.is_empty()).cloned() else {
                return Err(HEALTH_USAGE.into());
            };
            let check = parse_check_args(&name, &args[2..])?;
            let info = repo_info(ask, &t, "POST", &id, "", Some(&check)).await?;
            out.line(def_lines(&info, p).join("\n"));
            Ok(())
        }
        "rm" => {
            let t = repo_target().await?;
            let id = repo_id(ask, &t, args.first().map(String::as_str)).await?;
            let Some(name) = args.get(1).filter(|n| !n.is_empty()).cloned() else {
                return Err("usage: canopy health rm <repo> <name>".into());
            };
            let before = repo_info(ask, &t, "GET", &id, "", None).await?;
            let Some(mine) = list_at(&before, "checks")
                .iter()
                .find(|c| str_at(c, "name") == Some(name.as_str()))
            else {
                return Err(format!("{id} has no check named {name}"));
            };
            if str_at(mine, "source") == Some("repo") {
                return Err(format!(
                    "{name} is in the repo's {HEALTH_FILE}; edit that file to remove it"
                ));
            }
            let extra = format!("&name={}", encode_component(&name));
            let info = repo_info(ask, &t, "DELETE", &id, &extra, None).await?;
            out.line(def_lines(&info, p).join("\n"));
            Ok(())
        }
        "lint" => {
            let file = join(
                &resolve(args.first().map_or(".", String::as_str)),
                HEALTH_FILE,
            );
            let text = std::fs::read(&file)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .map_err(|_| format!("no {file}"))?;
            let (checks, errors) = parse_health_file(&text);
            for c in &checks {
                out.line(format!(
                    "{}  {}  {} {}",
                    p.moss("ok"),
                    p.bold(&field(c, "name")),
                    field(c, "kind"),
                    check_target(c)
                ));
            }
            for e in &errors {
                out.line(format!("{} {e}", p.rust("bad")));
            }
            if !errors.is_empty() {
                out.failed = true;
            }
            Ok(())
        }
        "init" => {
            let dir = resolve(args.first().map_or(".", String::as_str));
            let file = join(&dir, HEALTH_FILE);
            if std::fs::read(&file).is_ok() {
                return Err(format!(
                    "{file} is there already; canopy health lint checks it"
                ));
            }
            let mut files = TaskFiles::default();
            for (key, name) in TASK_FILES {
                if let Ok(bytes) = std::fs::read(join(&dir, name))
                    && let Some(slot) = files.slot(key)
                {
                    *slot = Some(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
            let starter = starter_file(&files);
            std::fs::create_dir_all(dirname(&file)).map_err(|e| e.to_string())?;
            std::fs::write(&file, &starter).map_err(|e| e.to_string())?;
            out.line(format!("wrote {file}"));
            out.line(p.dim(canopy_core::pathx::js_trim(&starter)));
            Ok(())
        }
        _ => Err(HEALTH_USAGE.into()),
    }
}

/// `Promise.all` for futures that hold borrows: polls each until all end.
async fn join_all<'a>(futs: Vec<Pin<Box<dyn Future<Output = ()> + 'a>>>) {
    let mut futs: Vec<Option<Pin<Box<dyn Future<Output = ()> + 'a>>>> =
        futs.into_iter().map(Some).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for slot in futs.iter_mut() {
            if let Some(f) = slot {
                if f.as_mut().poll(cx).is_ready() {
                    *slot = None;
                } else {
                    pending = true;
                }
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await
}

/// `new Date().toLocaleTimeString()` as Bun prints it: en-US, the zone TZ
/// names, else the system's ("7:20:00 PM").
fn locale_time() -> String {
    let z = jiff::Timestamp::now().to_zoned_datetime(jiff::tz::TimeZone::system());
    let hour = z.hour();
    let (h12, half) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!("{h12}:{:02}:{:02} {half}", z.minute(), z.second())
}

/// `follow()`: prints one backend's checks, then what changes on each
/// `health` event, `prefix` before every line. Ends when its stream ends
/// or never opens.
fn follow<'a>(
    ask: &'a impl Ask,
    caller: &'a Caller,
    t: &'a Target,
    f: &'a ListFilter,
    prefix: String,
    p: Paint,
    say: &'a dyn Fn(String),
) -> Pin<Box<dyn Future<Output = ()> + 'a>> {
    Box::pin(async move {
        let first = match ask.ask(t, "GET", "/api/health", None).await {
            Ok(info) => filter_checks(list_at(&info, "checks"), f),
            Err(e) => {
                say(format!(
                    "{prefix}{} {}",
                    p.rust(&pad_end("unreachable", 20)),
                    p.dim(e.message())
                ));
                return;
            }
        };
        for c in &first {
            say(format!("{prefix}{}", check_line(c, p)));
        }
        let mut last = by_id(&first);
        let _ = rustls::crypto::ring::default_provider().install_default();
        let Ok(http) = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
        else {
            say(format!("{prefix}{}", p.rust("no event stream")));
            return;
        };
        for url in &t.urls {
            let mut req = http.get(format!("{url}/api/events"));
            if let Some(token) = caller.caller_token(url, None) {
                req = req.header("x-canopy-token", token);
            }
            let Ok(mut res) = req.send().await else {
                continue;
            };
            if !res.status().is_success() {
                continue;
            }
            let mut buf: Vec<u8> = Vec::new();
            loop {
                // a stream that breaks ends as one that closes
                let Ok(Some(chunk)) = res.chunk().await else {
                    say(format!("{prefix}{}", p.rust("stream ended")));
                    return;
                };
                buf.extend_from_slice(&chunk);
                while let Some(cut) = buf.windows(2).position(|w| w == b"\n\n") {
                    let frame = String::from_utf8_lossy(&buf[..cut]).into_owned();
                    buf.drain(..cut + 2);
                    let Some(data) = frame.split('\n').find(|l| l.starts_with("data: ")) else {
                        continue;
                    };
                    // the server's own events: only a health one is read past its type
                    let Ok(ev) = serde_json::from_str::<Value>(&data[6..]) else {
                        continue;
                    };
                    if str_at(&ev, "type") != Some("health") {
                        continue;
                    }
                    let Some(checks) = ev.get("checks").and_then(Value::as_array) else {
                        continue;
                    };
                    let now = filter_checks(checks, f);
                    let at = locale_time();
                    for line in change_lines(&last, &now, p) {
                        say(format!("{prefix}{} {line}", p.dim(&at)));
                    }
                    last = by_id(&now);
                }
            }
        }
        say(format!("{prefix}{}", p.rust("no event stream")));
    })
}

#[cfg(test)]
mod tests;
