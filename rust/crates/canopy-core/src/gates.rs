//! A repo's gates for the landing queue (`src/core/gates.ts`):
//! `.canopy/gates.json` in the main checkout, else the `package.json`
//! scripts named typecheck, lint, test and build. canopy-server reads them
//! for the worktrees listing's `fileWarm`. The script the gates run as and
//! the lockfile check are not ported yet.
//!
//! A gates file that is not JSON says so with JavaScriptCore's own words for
//! why, which this port cannot give; `GatesError::not_json` marks that case
//! so a caller that must answer as the Bun server does can decline.

use crate::warm::WARM_MAX;
use serde_json::{Map, Value, json};

/// `GATES_FILE`
pub const GATES_FILE: &str = ".canopy/gates.json";
/// `PACKAGE_GATES`: the package.json scripts used when the repo has no
/// gates file, in order.
pub const PACKAGE_GATES: [&str; 4] = ["typecheck", "lint", "test", "build"];

/// Why a gates file cannot be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatesError {
    pub message: String,
    /// the file is not JSON, and `message` carries serde's words, not
    /// JavaScriptCore's
    pub not_json: bool,
}

fn bad(message: String) -> GatesError {
    GatesError {
        message,
        not_json: false,
    }
}

/// `GATE_NAME` in core/gatename.ts: `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/`.
pub fn is_gate_name(v: &str) -> bool {
    let b = v.as_bytes();
    (1..=40).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

/// `parseGatesFile()`: the file's text as `{ gates, setup?, warm? }`, in the
/// TypeScript's key order, or why it cannot be.
pub fn parse_gates_file(text: &str) -> Result<Value, GatesError> {
    let raw: Value = serde_json::from_str(text).map_err(|e| GatesError {
        message: format!("{GATES_FILE} is not JSON: {e}"),
        not_json: true,
    })?;
    let Some(raw) = raw.as_object() else {
        return Err(bad(format!("{GATES_FILE} must be an object")));
    };
    let Some(list) = raw.get("gates").and_then(Value::as_array) else {
        return Err(bad(format!("{GATES_FILE} needs a gates list")));
    };
    let mut gates = vec![];
    let mut seen = std::collections::HashSet::new();
    for (i, g) in list.iter().enumerate() {
        let Some(g) = g.as_object() else {
            return Err(bad(format!(
                "{GATES_FILE}: gate {} must be an object",
                i + 1
            )));
        };
        let Some(name) = g
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| is_gate_name(n))
        else {
            return Err(bad(format!(
                "{GATES_FILE}: gate {} needs a short name of letters, digits, dots, dashes or underscores",
                i + 1
            )));
        };
        let run = g
            .get("run")
            .and_then(Value::as_str)
            .map(crate::pathx::js_trim);
        let Some(run) = run.filter(|r| !r.is_empty()) else {
            return Err(bad(format!("{GATES_FILE}: gate {name} needs a run line")));
        };
        if !seen.insert(name.to_string()) {
            return Err(bad(format!("{GATES_FILE}: two gates are named {name}")));
        }
        gates.push(json!({ "name": name, "run": run }));
    }
    let setup = match raw.get("setup") {
        None => None,
        Some(Value::String(s)) if !crate::pathx::js_trim(s).is_empty() => {
            Some(crate::pathx::js_trim(s).to_string())
        }
        Some(_) => return Err(bad(format!("{GATES_FILE}: setup must be a shell line"))),
    };
    let warm = match raw.get("warm") {
        None => None,
        Some(w) => match w.as_f64() {
            Some(n) if n.fract() == 0.0 && (0.0..=WARM_MAX).contains(&n) => {
                Some(crate::screenlayouts::js_num(n))
            }
            _ => {
                return Err(bad(format!(
                    "{GATES_FILE}: warm must be a whole number from 0 to {WARM_MAX}"
                )));
            }
        },
    };
    let mut out = Map::new();
    out.insert("gates".into(), Value::Array(gates));
    if let Some(s) = setup {
        out.insert("setup".into(), json!(s));
    }
    if let Some(w) = warm {
        out.insert("warm".into(), w);
    }
    Ok(Value::Object(out))
}

/// `packageGates()`: the gates `package.json`'s scripts give, in
/// `PACKAGE_GATES` order.
pub fn package_gates(text: &str) -> Vec<Value> {
    let raw: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let scripts = raw.get("scripts").and_then(Value::as_object);
    PACKAGE_GATES
        .iter()
        .filter(|n| {
            scripts
                .and_then(|s| s.get(**n))
                .is_some_and(Value::is_string)
        })
        .map(|name| json!({ "name": name, "run": format!("bun run {name}") }))
        .collect()
}

/// `readGates()`: the repo's gates as its main checkout holds them now, with
/// where they came from. A gates file that is there but wrong is an error,
/// not a fall back to the package scripts.
pub fn read_gates(main_path: &str) -> Result<Value, GatesError> {
    // readFile(.., "utf8"): bytes that are not UTF-8 read as U+FFFD, and any
    // failure to read is no file
    let read = |p: &str| {
        std::fs::read(crate::pathx::join(main_path, p))
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    if let Some(file) = read(GATES_FILE) {
        let mut parsed = parse_gates_file(&file)?;
        parsed["source"] = json!("file");
        return Ok(parsed);
    }
    let gates = read("package.json")
        .map(|t| package_gates(&t))
        .unwrap_or_default();
    Ok(if gates.is_empty() {
        json!({ "gates": [], "source": "none" })
    } else {
        json!({ "gates": gates, "source": "package" })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (p, body) in files {
            let full = dir.path().join(p);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
        }
        dir
    }

    fn read(dir: &tempfile::TempDir) -> Result<Value, GatesError> {
        read_gates(dir.path().to_str().unwrap())
    }

    #[test]
    fn gates_and_setup() {
        let text = r#"{"gates":[{"name":"test","run":"bun test"}],"setup":"bun install --frozen-lockfile"}"#;
        assert_eq!(
            parse_gates_file(text).unwrap(),
            json!({ "gates": [{ "name": "test", "run": "bun test" }], "setup": "bun install --frozen-lockfile" })
        );
    }

    #[test]
    fn warm_prepared_worktrees_to_keep_a_whole_number_from_0_to_2() {
        assert_eq!(
            parse_gates_file(r#"{"gates":[],"warm":1}"#).unwrap(),
            json!({ "gates": [], "warm": 1 })
        );
        assert_eq!(
            parse_gates_file(r#"{"gates":[]}"#).unwrap(),
            json!({ "gates": [] })
        );
        for warm in ["3", "-1", "1.5", "\"1\""] {
            assert_eq!(
                parse_gates_file(&format!(r#"{{"gates":[],"warm":{warm}}}"#))
                    .unwrap_err()
                    .message,
                ".canopy/gates.json: warm must be a whole number from 0 to 2"
            );
        }
    }

    #[test]
    fn a_bad_file_says_why() {
        let e = |t: &str| parse_gates_file(t).unwrap_err();
        assert!(e("{").not_json);
        assert_eq!(e("[]").message, ".canopy/gates.json must be an object");
        assert_eq!(e("{}").message, ".canopy/gates.json needs a gates list");
        assert!(!e(r#"{"gates":[{"name":"a b","run":"x"}]}"#).not_json);
        assert_eq!(
            e(r#"{"gates":[{"name":"a","run":" "}]}"#).message,
            ".canopy/gates.json: gate a needs a run line"
        );
        assert_eq!(
            e(r#"{"gates":[{"name":"a","run":"x"},{"name":"a","run":"y"}]}"#).message,
            ".canopy/gates.json: two gates are named a"
        );
        assert_eq!(
            e(r#"{"gates":[],"setup":3}"#).message,
            ".canopy/gates.json: setup must be a shell line"
        );
    }

    #[test]
    fn the_four_names_that_exist_in_order() {
        assert_eq!(
            package_gates(r#"{"scripts":{"build":"vite build","test":"bun test","dev":"x"}}"#),
            vec![
                json!({ "name": "test", "run": "bun run test" }),
                json!({ "name": "build", "run": "bun run build" })
            ]
        );
        assert!(package_gates("not json").is_empty());
    }

    #[test]
    fn warm_comes_with_the_file() {
        let dir = folder(&[(GATES_FILE, r#"{"gates":[],"setup":"bun install","warm":2}"#)]);
        assert_eq!(
            read(&dir).unwrap(),
            json!({ "gates": [], "setup": "bun install", "warm": 2, "source": "file" })
        );
    }

    #[test]
    fn the_file_wins_over_package_json() {
        let dir = folder(&[
            (
                GATES_FILE,
                r#"{"gates":[{"name":"check","run":"make check"}]}"#,
            ),
            ("package.json", r#"{"scripts":{"test":"bun test"}}"#),
        ]);
        assert_eq!(
            read(&dir).unwrap(),
            json!({ "gates": [{ "name": "check", "run": "make check" }], "source": "file" })
        );
    }

    #[test]
    fn package_json_when_there_is_no_file() {
        let dir = folder(&[("package.json", r#"{"scripts":{"lint":"oxlint"}}"#)]);
        assert_eq!(
            read(&dir).unwrap(),
            json!({ "gates": [{ "name": "lint", "run": "bun run lint" }], "source": "package" })
        );
    }

    #[test]
    fn none() {
        let dir = folder(&[("README.md", "hi")]);
        assert_eq!(
            read(&dir).unwrap(),
            json!({ "gates": [], "source": "none" })
        );
    }

    #[test]
    fn a_bad_file_throws_rather_than_falling_back() {
        let dir = folder(&[
            (GATES_FILE, "{"),
            ("package.json", r#"{"scripts":{"test":"x"}}"#),
        ]);
        let e = read(&dir).unwrap_err();
        assert!(e.not_json && e.message.contains("not JSON"), "{e:?}");
    }

    #[test]
    fn read_from_the_folder_it_is_handed_the_main_checkout_not_a_branchs_copy() {
        let main = folder(&[(
            GATES_FILE,
            r#"{"gates":[{"name":"test","run":"bun test"}]}"#,
        )]);
        let _branch = folder(&[(GATES_FILE, r#"{"gates":[]}"#)]);
        assert_eq!(
            read(&main).unwrap()["gates"],
            json!([{ "name": "test", "run": "bun test" }])
        );
    }
}
