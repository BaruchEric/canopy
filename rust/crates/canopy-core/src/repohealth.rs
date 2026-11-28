//! A repo's declared health checks (`src/core/repohealth.ts`, in part):
//! `.canopy/health.json` read and each check held to its rules. Ported:
//! `HEALTH_FILE`, `CHECK_EVERY`, `CHECK_EVERY_MIN`, `normalizeCheck`,
//! `normalizeChecks`, `parseHealthFile`, `healOf`, `repoCheckId` and
//! `checkTarget`, which `canopy health` reads. Not yet: `mergeChecks` and
//! what keeps a check from running where, which the server owns.
//!
//! A check is the JSON the TypeScript makes, keys in its order: the shared
//! ones (name, fix, heal, while, every), then the kind and its own.

use crate::pathx::{js_trim, js_ws};
use crate::tasks::is_task_name;
use serde_json::{Map, Value, json};

pub const HEALTH_FILE: &str = ".canopy/health.json";
/// seconds between probes when a check does not say
pub const CHECK_EVERY: u64 = 30;
/// the fewest seconds between probes
pub const CHECK_EVERY_MIN: f64 = 5.0;

const KINDS: [&str; 5] = ["http", "port", "task", "compose", "command"];
const HEALS: [&str; 3] = ["auto", "button", "none"];

/// `str()`: a string with something in it, trimmed.
fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
        .map(js_trim)
        .filter(|s| !s.is_empty())
}

/// `JSON.stringify(v)`, `undefined` for a missing value.
fn stringify(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), Value::to_string)
}

/// A number as JSON.stringify writes it: a whole one without a point.
fn whole(n: f64) -> Value {
    if n.is_finite() && n.trunc() == n && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `Number.isInteger(v)` for a JSON value, with the number.
fn integer(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.trunc() == *n)
}

/// `/^https?:\/\/\S+$/`.
fn http_url(s: &str) -> bool {
    let rest = s
        .strip_prefix("http://")
        .or_else(|| s.strip_prefix("https://"));
    rest.is_some_and(|r| !r.is_empty() && !r.contains(js_ws))
}

/// `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`.
fn service_name(s: &str) -> bool {
    let b = s.as_bytes();
    b.first().is_some_and(u8::is_ascii_alphanumeric)
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(c))
}

/// `normalizeCheck()`: one check from untrusted JSON, or what is wrong.
pub fn normalize_check(v: &Value) -> Result<Value, String> {
    let Some(o) = v.as_object() else {
        return Err("a check is an object".into());
    };
    if !is_task_name(o.get("name")) {
        return Err(format!("bad check name: {}", stringify(o.get("name"))));
    }
    let name = o["name"].as_str().unwrap_or_default();
    let kind = o
        .get("kind")
        .and_then(Value::as_str)
        .filter(|k| KINDS.contains(k));
    let Some(kind) = kind else {
        return Err(format!("{name}: kind is one of {}", KINDS.join(", ")));
    };
    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    if let Some(fix) = str_of(o.get("fix")) {
        out.insert("fix".into(), json!(fix));
    }
    if let Some(heal) = o.get("heal") {
        match heal.as_str().filter(|h| HEALS.contains(h)) {
            Some(h) => out.insert("heal".into(), json!(h)),
            None => return Err(format!("{name}: heal is auto, button or none")),
        };
    }
    if let Some(during) = o.get("while") {
        if !is_task_name(Some(during)) {
            return Err(format!("{name}: while names a task"));
        }
        if kind == "task" {
            return Err(format!("{name}: a task check needs no while"));
        }
        out.insert("while".into(), during.clone());
    }
    if let Some(every) = o.get("every") {
        let Some(n) = every.as_f64().filter(|n| n.is_finite()) else {
            return Err(format!("{name}: every is a number of seconds"));
        };
        // Math.round rounds a half up and Rust's away from zero; they part
        // only below zero, where the floor of five wins either way
        out.insert("every".into(), whole(CHECK_EVERY_MIN.max(n.round())));
    }
    out.insert("kind".into(), json!(kind));
    match kind {
        "http" => {
            let Some(url) = str_of(o.get("url")).filter(|u| http_url(u)) else {
                return Err(format!("{name}: an http check needs an http(s) url"));
            };
            out.insert("url".into(), json!(url));
            if let Some(expect) = o.get("expect") {
                let Some(n) = integer(Some(expect)).filter(|n| (100.0..=599.0).contains(n)) else {
                    return Err(format!("{name}: expect is an HTTP status"));
                };
                out.insert("expect".into(), whole(n));
            }
        }
        "port" => {
            let Some(port) = integer(o.get("port")).filter(|n| (1.0..=65535.0).contains(n)) else {
                return Err(format!("{name}: a port check needs a port, 1 to 65535"));
            };
            out.insert("port".into(), whole(port));
            if let Some(host) = str_of(o.get("host")) {
                out.insert("host".into(), json!(host));
            }
        }
        "task" => {
            if !is_task_name(o.get("task")) {
                return Err(format!("{name}: a task check needs a task's name"));
            }
            out.insert("task".into(), o["task"].clone());
        }
        "compose" => {
            let Some(service) = str_of(o.get("service")).filter(|s| service_name(s)) else {
                return Err(format!("{name}: a compose check needs a service's name"));
            };
            out.insert("service".into(), json!(service));
            if let Some(file) = str_of(o.get("file")) {
                out.insert("file".into(), json!(file));
            }
        }
        _ => {
            let Some(run) = str_of(o.get("run")) else {
                return Err(format!("{name}: a command check needs run"));
            };
            out.insert("run".into(), json!(run));
        }
    }
    Ok(Value::Object(out))
}

/// `normalizeChecks()`: the good checks of a list from untrusted JSON and
/// what was wrong with the rest. A second check by one name is an error.
pub fn normalize_checks(list: &Value) -> (Vec<Value>, Vec<String>) {
    let Some(items) = list.as_array() else {
        return (Vec::new(), vec!["checks is a list".into()]);
    };
    let mut checks: Vec<Value> = Vec::new();
    let mut errors = Vec::new();
    for v in items {
        match normalize_check(v) {
            Err(e) => errors.push(e),
            Ok(c) if checks.iter().any(|x| x["name"] == c["name"]) => {
                errors.push(format!(
                    "{}: named twice",
                    c["name"].as_str().unwrap_or_default()
                ));
            }
            Ok(c) => checks.push(c),
        }
    }
    (checks, errors)
}

/// `parseHealthFile()`: `{ "checks": [...] }`. A file that is not JSON
/// says so with serde's words, where the TypeScript gives the engine's.
pub fn parse_health_file(text: &str) -> (Vec<Value>, Vec<String>) {
    let parsed: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return (Vec::new(), vec![format!("{HEALTH_FILE} is not JSON: {e}")]),
    };
    let Some(o) = parsed.as_object() else {
        return (
            Vec::new(),
            vec![format!("{HEALTH_FILE} is an object with a checks list")],
        );
    };
    match o.get("checks").filter(|c| !c.is_null()) {
        Some(list) => normalize_checks(list),
        None => (Vec::new(), Vec::new()),
    }
}

/// `healOf()`: the heal mode a merged check runs with; a blocked one heals
/// by nothing.
pub fn heal_of(c: &Value) -> String {
    if crate::js::truthy(c.get("blocked")) {
        return "none".into();
    }
    match c.get("heal").filter(|h| !h.is_null()) {
        Some(h) => crate::js::template(Some(h)),
        None => "button".into(),
    }
}

/// `repoCheckId()`: the id the hub keeps a repo's check under.
pub fn repo_check_id(repo_id: &str, name: &str) -> String {
    format!("repo:{repo_id}:{name}")
}

/// `checkTarget()`: what a check looks at, in a few words for its row.
pub fn check_target(c: &Value) -> String {
    let field = |k: &str| crate::js::field(c, k);
    match c.get("kind").and_then(Value::as_str) {
        Some("http") => field("url"),
        Some("port") => {
            let host = match c.get("host").filter(|h| !h.is_null()) {
                Some(h) => crate::js::template(Some(h)),
                None => "127.0.0.1".into(),
            };
            format!("{host}:{}", field("port"))
        }
        Some("task") => format!("task {}", field("task")),
        Some("compose") => format!("compose {}", field("service")),
        Some("command") => field("run"),
        _ => "undefined".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(v: Value) -> Value {
        normalize_check(&v).unwrap()
    }

    fn err(v: Value) -> String {
        normalize_check(&v).unwrap_err()
    }

    #[test]
    fn each_kind_with_what_it_needs() {
        assert_eq!(
            ok(
                json!({"name": "site", "kind": "http", "url": "http://127.0.0.1:5173/", "expect": 200})
            ),
            json!({"name": "site", "kind": "http", "url": "http://127.0.0.1:5173/", "expect": 200})
        );
        assert_eq!(
            ok(json!({"name": "api", "kind": "port", "port": 7850})),
            json!({"name": "api", "kind": "port", "port": 7850})
        );
        assert_eq!(
            ok(json!({"name": "dev", "kind": "task", "task": "dev", "heal": "auto"})),
            json!({"name": "dev", "heal": "auto", "kind": "task", "task": "dev"})
        );
        assert_eq!(
            ok(
                json!({"name": "db", "kind": "compose", "service": "postgres", "file": "compose.yml"})
            ),
            json!({"name": "db", "kind": "compose", "service": "postgres", "file": "compose.yml"})
        );
        assert_eq!(
            ok(json!({"name": "smoke", "kind": "command", "run": "bun run smoke", "every": 300})),
            json!({"name": "smoke", "every": 300, "kind": "command", "run": "bun run smoke"})
        );
    }

    #[test]
    fn keys_come_out_in_the_typescripts_order() {
        let c = ok(
            json!({"port": 80.0, "kind": "port", "every": 12.4, "heal": "none", "fix": " up ", "name": "db", "host": " h "}),
        );
        assert_eq!(
            c.to_string(),
            r#"{"name":"db","fix":"up","heal":"none","every":12,"kind":"port","port":80,"host":"h"}"#
        );
    }

    #[test]
    fn refuses_what_it_cannot_run() {
        assert!(
            err(json!({"name": "Bad Name", "kind": "port", "port": 1})).contains("bad check name")
        );
        assert!(err(json!({"name": "x", "kind": "ftp"})).contains("kind is one of"));
        assert!(
            err(json!({"name": "x", "kind": "http", "url": "file:///etc/passwd"}))
                .contains("http(s) url")
        );
        assert!(
            err(json!({"name": "x", "kind": "http", "url": "http://a", "expect": 42}))
                .contains("expect")
        );
        assert!(err(json!({"name": "x", "kind": "port", "port": 70000})).contains("1 to 65535"));
        assert!(err(json!({"name": "x", "kind": "task"})).contains("task's name"));
        assert!(err(json!({"name": "x", "kind": "compose", "service": "a b"})).contains("service"));
        assert!(err(json!({"name": "x", "kind": "command", "run": "  "})).contains("needs run"));
        assert!(
            err(json!({"name": "x", "kind": "port", "port": 1, "heal": "sometimes"}))
                .contains("heal is")
        );
        assert!(err(json!([1])).contains("object"));
        assert_eq!(
            err(json!({"name": "Bad Name"})),
            "bad check name: \"Bad Name\""
        );
        assert_eq!(err(json!({"kind": "port"})), "bad check name: undefined");
    }

    #[test]
    fn while_names_a_task_and_a_task_check_needs_none() {
        assert_eq!(
            ok(json!({"name": "site", "kind": "http", "url": "http://a/", "while": "dev"})),
            json!({"name": "site", "while": "dev", "kind": "http", "url": "http://a/"})
        );
        assert!(
            err(json!({"name": "site", "kind": "http", "url": "http://a/", "while": "Not A Task"}))
                .contains("while names a task")
        );
        assert!(
            err(json!({"name": "dev", "kind": "task", "task": "dev", "while": "dev"}))
                .contains("needs no while")
        );
    }

    #[test]
    fn every_is_at_least_five_seconds() {
        assert_eq!(
            ok(json!({"name": "x", "kind": "port", "port": 1, "every": 1}))["every"],
            5
        );
        assert_eq!(
            ok(json!({"name": "x", "kind": "port", "port": 1, "every": -7.5}))["every"],
            5
        );
        assert_eq!(
            ok(json!({"name": "x", "kind": "port", "port": 1, "every": 7.5}))["every"],
            8
        );
    }

    #[test]
    fn keeps_the_good_names_the_bad_and_the_twice_named() {
        let (checks, errors) = normalize_checks(&json!([
            {"name": "a", "kind": "port", "port": 1},
            {"name": "a", "kind": "port", "port": 2},
            {"name": "b", "kind": "nope"},
        ]));
        let names: Vec<&Value> = checks.iter().map(|c| &c["name"]).collect();
        assert_eq!(names, [&json!("a")]);
        assert_eq!(errors.len(), 2);
    }

    #[test]
    fn a_file_that_is_not_json_or_not_the_shape() {
        assert!(parse_health_file("{").1[0].contains("not JSON"));
        assert!(parse_health_file("[]").1[0].contains("checks list"));
        assert_eq!(
            parse_health_file(r#"{"checks":[{"name":"a","kind":"port","port":80}]}"#)
                .0
                .len(),
            1
        );
        assert_eq!(parse_health_file("{}"), (vec![], vec![]));
        assert_eq!(parse_health_file(r#"{"checks": null}"#), (vec![], vec![]));
        assert_eq!(
            parse_health_file(r#"{"checks": {}}"#).1,
            ["checks is a list"]
        );
    }

    #[test]
    fn ids_and_targets() {
        assert_eq!(repo_check_id("web/app", "site"), "repo:web/app:site");
        assert_eq!(
            check_target(&json!({"name": "a", "kind": "port", "port": 80})),
            "127.0.0.1:80"
        );
        assert_eq!(
            check_target(&json!({"name": "a", "kind": "task", "task": "dev"})),
            "task dev"
        );
        assert_eq!(heal_of(&json!({"heal": "auto"})), "auto");
        assert_eq!(heal_of(&json!({"heal": "auto", "blocked": "x"})), "none");
        assert_eq!(heal_of(&json!({})), "button");
    }
}
