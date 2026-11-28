//! The launcher's settings (`normalizeLaunch` and `isDefaultLaunch` in
//! `src/core/launch.ts`): four one-line commands per repo. Release assets,
//! builds and the launch itself are not ported yet.

use serde_json::{Map, Value, json};

use crate::pathx::js_trim;

/// A field as one line: line breaks become a space, then trimmed.
fn line(v: Option<&Value>) -> String {
    let Some(s) = v.and_then(Value::as_str) else {
        return String::new();
    };
    let mut out = String::with_capacity(s.len());
    let mut in_break = false;
    for c in s.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            out.push(c);
            in_break = false;
        }
    }
    js_trim(&out).to_string()
}

/// Settings from a body or a hand-edited config, field by field.
pub fn normalize_launch(v: &Value) -> Value {
    let o = v.as_object();
    let f = |k: &str| line(o.and_then(|o| o.get(k)));
    json!({ "asset": f("asset"), "build": f("build"), "run": f("run"), "launch": f("launch") })
}

pub fn is_default_launch(l: &Value) -> bool {
    ["asset", "build", "run", "launch"]
        .iter()
        .all(|k| l[k].as_str() == Some(""))
}

/// The config's `launchers` by repo path, entries left at the defaults out.
pub fn normalize_launchers(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(o) = v.as_object() {
        for (path, raw) in o {
            let l = normalize_launch(raw);
            if !is_default_launch(&l) {
                out.insert(path.clone(), l);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_line_is_one_line_and_an_empty_entry_is_left_out() {
        let l = normalize_launch(&json!({ "build": " bun run build\r\n\nand more ", "run": 3 }));
        assert_eq!(
            l,
            json!({ "asset": "", "build": "bun run build and more", "run": "", "launch": "" })
        );
        let all = normalize_launchers(&json!({ "/a": { "app": "kitty" }, "/b": { "run": "x" } }));
        assert_eq!(all.keys().collect::<Vec<_>>(), ["/b"]);
        assert!(normalize_launchers(&json!([])).is_empty());
    }
}
