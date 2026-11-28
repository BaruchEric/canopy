//! A repo's named processes (`src/core/tasks.ts`, in part). Ported: task
//! names and `cwdError`, a patch checked field by field
//! (`normalizeTaskPatch`), the repo's `.canopy/tasks.json`
//! (`parseTaskFile`), and detection from package.json, Cargo.toml and a
//! Makefile (`parseScripts`, `parseCargo`, `parseMakeTargets`,
//! `TASK_FILES`, `parseTaskFiles`, `detectTasks`), which `canopy health
//! init` reads. Not yet: env slots filled at a start, merging the layers,
//! backoff, status, log text and the sweep, which the server owns.
//!
//! A patch and a task are the JSON the TypeScript makes, keys in its order.

use crate::pathx::{js_trim, js_ws};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

/// `TASK_NAME`: `^[a-z0-9][a-z0-9._-]{0,39}$`.
fn task_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 40
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

/// `isTaskName()`: a string that names a task.
pub fn is_task_name(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(task_name)
}

const FLAGS: [&str; 5] = ["dev", "keep", "withPanel", "hidden", "compose"];

/// `cwdError()`: why a cwd is refused, or None for one inside the repo.
pub fn cwd_error(cwd: &str) -> Option<&'static str> {
    if cwd.starts_with('/') {
        return Some("cwd is relative to the repo root");
    }
    if cwd.split('/').any(|seg| seg == "..") {
        return Some("cwd stays inside the repo");
    }
    None
}

/// `Object.entries(o)` in JavaScript's order: keys that read as array
/// indexes first, ascending, then the rest as written.
pub fn js_entries(o: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |k: &str| -> Option<u32> {
        let n: u32 = k.parse().ok()?;
        (n != u32::MAX && n.to_string() == k).then_some(n)
    };
    let mut ints: Vec<(u32, (&String, &Value))> = o
        .iter()
        .filter_map(|(k, v)| index(k).map(|n| (n, (k, v))))
        .collect();
    ints.sort_by_key(|(n, _)| *n);
    let mut out: Vec<(&String, &Value)> = ints.into_iter().map(|(_, e)| e).collect();
    out.extend(o.iter().filter(|(k, _)| index(k).is_none()));
    out
}

/// `JSON.stringify(v)`, `undefined` for a missing value.
fn stringify(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), Value::to_string)
}

static SLOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{([^}]*)\}").unwrap());

/// `PORT_SLOT`: `^PORT(?:_([2-9]))?$`.
fn port_slot(s: &str) -> bool {
    match s.strip_prefix("PORT") {
        Some("") => true,
        Some(rest) => {
            let b = rest.as_bytes();
            b.len() == 2 && b[0] == b'_' && (b'2'..=b'9').contains(&b[1])
        }
        None => false,
    }
}

/// `ENV_NAME`: `^[A-Za-z_][A-Za-z0-9_]*$`.
fn env_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// `envError()`: why an env is refused, or None for one that reads.
fn env_error(v: &Value) -> Option<String> {
    let Some(o) = v.as_object() else {
        return Some("env is an object of names and values".into());
    };
    for (k, value) in js_entries(o) {
        if !env_name(k) {
            return Some(format!(
                "env: {} is not a variable name",
                Value::from(k.as_str())
            ));
        }
        let Some(value) = value.as_str().filter(|s| !s.contains(['\r', '\n'])) else {
            return Some(format!("env: {k} is one line of text"));
        };
        for cap in SLOT.captures_iter(value) {
            let slot = cap.get(1).map_or("", |m| m.as_str());
            if slot != "WORKTREE" && !port_slot(slot) {
                return Some(format!(
                    "env: ${{{slot}}} is not PORT, PORT_2 to PORT_9 or WORKTREE"
                ));
            }
        }
    }
    None
}

/// `normalizeTaskPatch()`: one layer's word on a task, checked field by
/// field; Err says what is wrong.
pub fn normalize_task_patch(v: &Value) -> Result<Value, String> {
    let Some(o) = v.as_object() else {
        return Err("a task is an object".into());
    };
    if !is_task_name(o.get("name")) {
        return Err(format!("bad task name: {}", stringify(o.get("name"))));
    }
    let name = o["name"].as_str().unwrap_or_default();
    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    if let Some(cmd) = o.get("cmd") {
        match cmd.as_str() {
            Some(c) if !js_trim(c).is_empty() && !c.contains(['\r', '\n']) => {
                out.insert("cmd".into(), json!(js_trim(c)));
            }
            _ => return Err(format!("{name}: cmd is one line")),
        }
    }
    if let Some(cwd) = o.get("cwd") {
        let Some(cwd) = cwd.as_str() else {
            return Err(format!("{name}: cwd is a folder name"));
        };
        let raw = js_trim(cwd);
        if raw.starts_with('/') {
            return Err(format!("{name}: {}", cwd_error(raw).unwrap_or_default()));
        }
        // ^\.\/+ off the front, \/+$ off the end
        let dir = match raw.strip_prefix("./") {
            Some(rest) => rest.trim_start_matches('/'),
            None => raw,
        }
        .trim_end_matches('/');
        if dir.is_empty() || dir == "." {
            out.insert("cwd".into(), json!("."));
        } else {
            if let Some(err) = cwd_error(dir) {
                return Err(format!("{name}: {err}"));
            }
            out.insert("cwd".into(), json!(dir));
        }
    }
    for f in FLAGS {
        let Some(flag) = o.get(f) else { continue };
        let Some(b) = flag.as_bool() else {
            return Err(format!("{name}: {f} is true or false"));
        };
        out.insert(f.into(), json!(b));
    }
    if let Some(env) = o.get("env") {
        if let Some(err) = env_error(env) {
            return Err(format!("{name}: {err}"));
        }
        let copy: Map<String, Value> = env
            .as_object()
            .map(|e| {
                js_entries(e)
                    .into_iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        out.insert("env".into(), Value::Object(copy));
    }
    Ok(Value::Object(out))
}

/// `parseTaskFile()`: `.canopy/tasks.json`, a list of patches; a bad entry
/// is dropped with its reason.
pub fn parse_task_file(text: &str) -> (Vec<Value>, Vec<String>) {
    let Ok(raw) = serde_json::from_str::<Value>(text) else {
        return (Vec::new(), vec![".canopy/tasks.json is not JSON".into()]);
    };
    let Some(items) = raw.as_array() else {
        return (
            Vec::new(),
            vec![".canopy/tasks.json is a list of tasks".into()],
        );
    };
    let mut patches: Vec<Value> = Vec::new();
    let mut errors = Vec::new();
    for item in items {
        match normalize_task_patch(item) {
            Err(e) => errors.push(e),
            Ok(p) if patches.iter().any(|x| x["name"] == p["name"]) => {
                errors.push(format!(
                    "{}: named twice",
                    p["name"].as_str().unwrap_or_default()
                ));
            }
            Ok(p) => patches.push(p),
        }
    }
    (patches, errors)
}

/// `quote()`: a shell word in single quotes.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `PLAIN`: `^[A-Za-z0-9_.:/@+-]+$`.
fn plain(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:/@+-".contains(&c))
}

/// `taskNameOf()`: a manifest's own name for something as a task name;
/// None when nothing usable is left.
fn task_name_of(s: &str) -> Option<String> {
    let lower = s.to_lowercase();
    // [^a-z0-9._-]+ as one "-"
    let mut n = String::new();
    let mut run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c) {
            n.push(c);
            run = false;
        } else if !run {
            n.push('-');
            run = true;
        }
    }
    // ^[^a-z0-9]+ off the front, then the first 40
    let n: String = n
        .trim_start_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .chars()
        .take(40)
        .collect();
    task_name(&n).then_some(n)
}

const LIFECYCLE: [&str; 9] = [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
    "dependencies",
];

/// `.+$` for what follows a hook's pre or post: one or more characters,
/// none a line terminator.
fn rest_of_line(s: &str) -> Option<&str> {
    (!s.is_empty() && !s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(s)
}

/// `parseScripts()`: package.json's scripts, each through bun; npm's
/// lifecycle hooks and a pre or post hook of another script are not tasks
/// of their own.
pub fn parse_scripts(text: &str) -> Vec<Value> {
    let Ok(pkg) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(scripts) = pkg.get("scripts").and_then(Value::as_object) else {
        return Vec::new();
    };
    let keys: Vec<&String> = js_entries(scripts)
        .into_iter()
        .filter(|(_, v)| v.is_string())
        .map(|(k, _)| k)
        .collect();
    let mut out: Vec<Value> = Vec::new();
    for key in &keys {
        if LIFECYCLE.contains(&key.as_str()) {
            continue;
        }
        let hook = key
            .strip_prefix("pre")
            .or_else(|| key.strip_prefix("post"))
            .and_then(rest_of_line);
        if hook.is_some_and(|h| keys.iter().any(|k| k.as_str() == h)) {
            continue;
        }
        let Some(name) = task_name_of(key) else {
            continue;
        };
        if out.iter().any(|t| t["name"] == name.as_str()) {
            continue;
        }
        let word = if plain(key) {
            key.to_string()
        } else {
            quote(key)
        };
        let mut t = json!({"name": name, "cmd": format!("bun run {word}")});
        if key.as_str() == "dev" {
            t["dev"] = json!(true);
        }
        out.push(t);
    }
    out
}

/// `/^\s*\[<section>\]/m`: a line, after the line terminators JavaScript's
/// `^` starts one at, that opens with the section.
fn has_section(text: &str, section: &str) -> bool {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| line.trim_start_matches(js_ws).starts_with(section))
}

/// `parseCargo()`: build and test, and run for a package (a bare workspace
/// has nothing to run).
pub fn parse_cargo(text: &str) -> Vec<Value> {
    let pkg = has_section(text, "[package]");
    if !pkg && !has_section(text, "[workspace]") {
        return Vec::new();
    }
    let mut out = vec![
        json!({"name": "build", "cmd": "cargo build"}),
        json!({"name": "test", "cmd": "cargo test"}),
    ];
    if pkg {
        out.push(json!({"name": "run", "cmd": "cargo run"}));
    }
    out
}

/// `^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:(?![=:])`: a line's plain target.
fn make_target(line: &str) -> Option<&str> {
    let b = line.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_alphanumeric) {
        return None;
    }
    let end = b
        .iter()
        .position(|c| !(c.is_ascii_alphanumeric() || b"._-".contains(c)))
        .unwrap_or(b.len());
    let rest = line[end..].trim_start_matches(js_ws);
    let after = rest.strip_prefix(':')?;
    (!after.starts_with(['=', ':'])).then(|| &line[..end])
}

/// `parseMakeTargets()`: a Makefile's plain targets, not dotted, not
/// pattern rules, not variables.
pub fn parse_make_targets(text: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for line in text.split('\n') {
        let Some(target) = make_target(line) else {
            continue;
        };
        let Some(name) = task_name_of(target) else {
            continue;
        };
        if out.iter().any(|t| t["name"] == name.as_str()) {
            continue;
        }
        out.push(json!({"name": name, "cmd": format!("make {target}")}));
    }
    out
}

/// `TASK_FILES`: the files a repo's tasks are read from, by the key
/// `TaskFiles` uses.
pub const TASK_FILES: [(&str, &str); 5] = [
    ("pkg", "package.json"),
    ("cargo", "Cargo.toml"),
    ("make", "Makefile"),
    ("repoFile", ".canopy/tasks.json"),
    ("gates", ".canopy/gates.json"),
];

/// `TaskFiles`: each file's text, when it is there.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TaskFiles {
    pub pkg: Option<String>,
    pub cargo: Option<String>,
    pub make: Option<String>,
    pub repo_file: Option<String>,
    pub gates: Option<String>,
}

impl TaskFiles {
    /// the slot `TASK_FILES`' key names
    pub fn slot(&mut self, key: &str) -> Option<&mut Option<String>> {
        match key {
            "pkg" => Some(&mut self.pkg),
            "cargo" => Some(&mut self.cargo),
            "make" => Some(&mut self.make),
            "repoFile" => Some(&mut self.repo_file),
            "gates" => Some(&mut self.gates),
            _ => None,
        }
    }
}

/// `parseTaskFiles()`: what `TASK_FILES_SCRIPT` printed, each file after a
/// record separator and its name.
pub fn parse_task_files(out: &str) -> TaskFiles {
    let mut files = TaskFiles::default();
    for chunk in out.split('\u{1e}') {
        let Some((name, text)) = chunk.split_once('\n') else {
            continue;
        };
        if let Some((key, _)) = TASK_FILES.iter().find(|(_, n)| *n == name)
            && let Some(slot) = files.slot(key)
        {
            *slot = Some(text.to_string());
        }
    }
    files
}

/// a file's text when it has some: `files.pkg ?` in the TypeScript
fn some(f: &Option<String>) -> Option<&str> {
    f.as_deref().filter(|t| !t.is_empty())
}

/// `detectTasks()`: every manifest's tasks, the first to use a name
/// keeping it. A file of empty text counts as no file, as in the
/// TypeScript.
pub fn detect_tasks(files: &TaskFiles) -> Vec<Value> {
    let mut all = Vec::new();
    if let Some(t) = some(&files.pkg) {
        all.extend(parse_scripts(t));
    }
    if let Some(t) = some(&files.cargo) {
        all.extend(parse_cargo(t));
    }
    if let Some(t) = some(&files.make) {
        all.extend(parse_make_targets(t));
    }
    let mut out: Vec<Value> = Vec::new();
    for t in all {
        if !out.iter().any(|x| x["name"] == t["name"]) {
            out.push(t);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_names() {
        let n = |s: &str| is_task_name(Some(&json!(s)));
        assert!(n("dev"));
        assert!(n("test.watch-2"));
        assert!(!n("Dev"));
        assert!(!n("-x"));
        assert!(!n(&"a".repeat(41)));
        assert!(!is_task_name(Some(&json!(1))));
        assert!(!is_task_name(None));
    }

    #[test]
    fn cwd_stays_inside_the_repo() {
        assert_eq!(cwd_error("ui"), None);
        assert!(cwd_error("/etc").is_some());
        assert!(cwd_error("ui/../..").is_some());
    }

    #[test]
    fn a_patch_is_validated_field_by_field() {
        assert_eq!(
            normalize_task_patch(&json!({"name": "dev", "cmd": " bun run dev ", "keep": true})),
            Ok(json!({"name": "dev", "cmd": "bun run dev", "keep": true}))
        );
        assert_eq!(
            normalize_task_patch(&json!({"name": "dev", "cwd": "./"})),
            Ok(json!({"name": "dev", "cwd": "."}))
        );
        assert_eq!(
            normalize_task_patch(&json!({"name": "dev", "cwd": ""})),
            Ok(json!({"name": "dev", "cwd": "."}))
        );
        assert!(normalize_task_patch(&json!({"name": "dev", "cmd": "a\nb"})).is_err());
        assert!(normalize_task_patch(&json!({"name": "dev", "keep": "yes"})).is_err());
        assert!(normalize_task_patch(&json!({"name": "Bad"})).is_err());
        assert!(normalize_task_patch(&json!({"name": "x", "cwd": "../out"})).is_err());
        assert_eq!(
            normalize_task_patch(&json!({"cmd": "x"})),
            Err("bad task name: undefined".into())
        );
        assert_eq!(
            normalize_task_patch(&json!({"name": "Bad"})),
            Err("bad task name: \"Bad\"".into())
        );
    }

    #[test]
    fn the_repo_file_keeps_good_entries_and_reports_bad_ones() {
        let (patches, errors) = parse_task_file(
            &json!([{"name": "a", "cmd": "x"}, {"name": "B"}, {"name": "a", "cmd": "y"}])
                .to_string(),
        );
        assert_eq!(patches, [json!({"name": "a", "cmd": "x"})]);
        assert_eq!(errors.len(), 2);
        assert_eq!(parse_task_file("{").1, [".canopy/tasks.json is not JSON"]);
        assert_eq!(
            parse_task_file("{}").1,
            [".canopy/tasks.json is a list of tasks"]
        );
    }

    #[test]
    fn package_json_scripts_run_through_bun_lifecycle_hooks_left_out() {
        let pkg = json!({"scripts": {"dev": "vite", "test:watch": "vitest", "prebuild": "x", "build": "tsc", "postinstall": "y", "my script": "z"}}).to_string();
        assert_eq!(
            parse_scripts(&pkg),
            [
                json!({"name": "dev", "cmd": "bun run dev", "dev": true}),
                json!({"name": "test-watch", "cmd": "bun run test:watch"}),
                json!({"name": "build", "cmd": "bun run build"}),
                json!({"name": "my-script", "cmd": "bun run 'my script'"}),
            ]
        );
        assert!(parse_scripts("not json").is_empty());
        assert!(parse_scripts("{}").is_empty());
    }

    #[test]
    fn cargo_a_package_runs_a_bare_workspace_does_not() {
        let cmds =
            |t: &str| -> Vec<Value> { parse_cargo(t).iter().map(|x| x["cmd"].clone()).collect() };
        assert_eq!(
            cmds("[package]\nname = \"x\""),
            [
                json!("cargo build"),
                json!("cargo test"),
                json!("cargo run")
            ]
        );
        assert_eq!(
            cmds("[workspace]\nmembers = []"),
            [json!("cargo build"), json!("cargo test")]
        );
        assert!(parse_cargo("").is_empty());
    }

    #[test]
    fn make_plain_targets_only() {
        let mk = [
            "all: build",
            ".PHONY: all",
            "%.o: %.c",
            "CC := gcc",
            "lint:",
            "\techo lint",
            "a b: c",
            "all: again",
        ]
        .join("\n");
        assert_eq!(
            parse_make_targets(&mk),
            [
                json!({"name": "all", "cmd": "make all"}),
                json!({"name": "lint", "cmd": "make lint"}),
            ]
        );
    }

    #[test]
    fn the_first_manifest_wins_a_name() {
        let t = detect_tasks(&TaskFiles {
            pkg: Some(json!({"scripts": {"build": "tsc"}}).to_string()),
            cargo: Some("[package]".into()),
            make: Some("build:\nextra:".into()),
            ..TaskFiles::default()
        });
        let got: Vec<String> = t
            .iter()
            .map(|x| {
                format!(
                    "{}={}",
                    x["name"].as_str().unwrap(),
                    x["cmd"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                "build=bun run build",
                "test=cargo test",
                "run=cargo run",
                "extra=make extra"
            ]
        );
    }

    #[test]
    fn the_file_dump_splits_back_into_files() {
        let out = "\x1epackage.json\n{\"a\":1}\n\x1eMakefile\nall:\n\x1e.canopy/gates.json\n{}\n";
        assert_eq!(
            parse_task_files(out),
            TaskFiles {
                pkg: Some("{\"a\":1}\n".into()),
                make: Some("all:\n".into()),
                gates: Some("{}\n".into()),
                ..TaskFiles::default()
            }
        );
        assert_eq!(parse_task_files(""), TaskFiles::default());
    }

    #[test]
    fn a_good_env_reads_and_one_that_does_not_says_why_under_the_tasks_name() {
        assert_eq!(
            normalize_task_patch(&json!({"name": "dev", "env": {"PORT": "${PORT}", "DEBUG": "1"}})),
            Ok(json!({"name": "dev", "env": {"PORT": "${PORT}", "DEBUG": "1"}}))
        );
        for (env, want) in [
            (json!(["PORT"]), "dev: env is an object of names and values"),
            (
                json!({"1BAD": "x"}),
                "dev: env: \"1BAD\" is not a variable name",
            ),
            (json!({"A": 1}), "dev: env: A is one line of text"),
            (json!({"A": "x\ny"}), "dev: env: A is one line of text"),
            (
                json!({"A": "${HOME}"}),
                "dev: env: ${HOME} is not PORT, PORT_2 to PORT_9 or WORKTREE",
            ),
        ] {
            assert_eq!(
                normalize_task_patch(&json!({"name": "dev", "env": env})),
                Err(want.into())
            );
        }
    }

    #[test]
    fn a_plain_dollar_sign_is_the_shells_not_a_slot() {
        assert_eq!(
            normalize_task_patch(&json!({"name": "dev", "env": {"A": "$HOME/x"}})),
            Ok(json!({"name": "dev", "env": {"A": "$HOME/x"}}))
        );
    }

    #[test]
    fn keys_that_read_as_indexes_come_first_as_javascript_orders_them() {
        let pkg = r#"{"scripts": {"b": "x", "10": "y", "2": "z", "02": "w"}}"#;
        let names: Vec<Value> = parse_scripts(pkg)
            .iter()
            .map(|t| t["name"].clone())
            .collect();
        assert_eq!(names, [json!("2"), json!("10"), json!("b"), json!("02")]);
    }
}
