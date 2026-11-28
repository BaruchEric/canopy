//! The words of `src/core/floorplan.ts` (FR-070): `floorplanLine`, the one
//! line a checkout's map is shown in, as `canopy floorplan` prints it. The
//! run's spec and prompt, how status.mjs's and server.json's JSON read, and
//! the section's head are not ported yet.

use crate::js::{template, truthy};
use serde_json::Value;

/// `plural(n, one)`: the count and the word, an s added unless it is 1.
fn plural(n: Option<&Value>, one: &str) -> String {
    let word = if is_one(n) {
        one.to_string()
    } else {
        format!("{one}s")
    };
    format!("{} {word}", template(n))
}

/// `n === 1`.
fn is_one(n: Option<&Value>) -> bool {
    n.and_then(Value::as_f64) == Some(1.0)
}

/// `v !== null`: a missing field is undefined, which is not null.
fn not_null(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Null))
}

/// `floorplanLine(info, ago)`: one line for a checkout's map, as the route
/// answers it. `ago` words a time from its ISO string.
pub fn floorplan_line(info: &Value, ago: impl Fn(&str) -> String) -> String {
    let built_at = info.get("builtAt");
    let built = if truthy(built_at) {
        format!(", built {}", ago(&template(built_at)))
    } else {
        String::new()
    };
    let (files, nodes) = (info.get("files"), info.get("nodes"));
    let size = if not_null(files) && not_null(nodes) {
        format!("{} in {}", plural(files, "file"), plural(nodes, "part"))
    } else {
        String::new()
    };
    match info.get("state").and_then(Value::as_str) {
        Some("none") => "no map yet".into(),
        Some("unbuilt") => "architecture.json is written but the map was never built".into(),
        Some("blueprint-started") => "a blueprint was started but never drawn".into(),
        Some("blueprint") => {
            let of = if size.is_empty() {
                String::new()
            } else {
                format!(" of {}", size.replacen("file", "planned file", 1))
            };
            format!("a blueprint{of}{built}")
        }
        Some("unknown") => {
            let error = info.get("error");
            if truthy(error) {
                format!("could not read the map: {}", template(error))
            } else {
                "could not read the map".into()
            }
        }
        Some("map") => {
            let (changed, uncommitted) = (info.get("changed"), info.get("uncommitted"));
            let mut since = Vec::new();
            if truthy(changed) {
                since.push(format!("{} changed since", plural(changed, "file")));
            }
            if truthy(uncommitted) {
                since.push(format!("{} uncommitted", template(uncommitted)));
            }
            let size = if size.is_empty() { "a map" } else { &size };
            let since = if since.is_empty() {
                String::new()
            } else {
                format!("; {}", since.join(", "))
            };
            format!("{size}{built}{since}")
        }
        // a state the switch does not name returns undefined, which prints
        _ => "undefined".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// the test's `ago`: "at" and the hour and minute of the ISO time
    fn ago(iso: &str) -> String {
        format!("at {}", iso.get(11..16).unwrap_or(""))
    }

    fn base(more: Value) -> Value {
        let mut v = json!({"builtAt": null, "files": null, "nodes": null, "changed": null, "uncommitted": null});
        for (k, x) in more.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    #[test]
    fn a_map_says_its_size_its_age_and_what_changed_since() {
        let map = |more: Value| {
            let mut v = base(
                json!({"state": "map", "builtAt": "2026-11-20T10:00:00.000Z", "files": 412, "nodes": 7}),
            );
            for (k, x) in more.as_object().unwrap() {
                v[k] = x.clone();
            }
            v
        };
        assert_eq!(
            floorplan_line(&map(json!({"changed": 0, "uncommitted": 0})), ago),
            "412 files in 7 parts, built at 10:00"
        );
        assert_eq!(
            floorplan_line(&map(json!({"changed": 1, "uncommitted": 3})), ago),
            "412 files in 7 parts, built at 10:00; 1 file changed since, 3 uncommitted"
        );
        assert_eq!(
            floorplan_line(&map(json!({"files": 1, "nodes": 1})), ago),
            "1 file in 1 part, built at 10:00"
        );
    }

    #[test]
    fn the_other_states_say_what_is_there() {
        assert_eq!(
            floorplan_line(&base(json!({"state": "none"})), ago),
            "no map yet"
        );
        assert_eq!(
            floorplan_line(
                &base(
                    json!({"state": "blueprint", "files": 30, "nodes": 4, "builtAt": "2026-11-20T09:30:00.000Z"})
                ),
                ago
            ),
            "a blueprint of 30 planned files in 4 parts, built at 09:30"
        );
        assert_eq!(
            floorplan_line(&base(json!({"state": "unknown", "error": "boom"})), ago),
            "could not read the map: boom"
        );
        assert!(floorplan_line(&base(json!({"state": "unbuilt"})), ago).contains("never built"));
        assert_eq!(floorplan_line(&base(json!({"state": "map"})), ago), "a map");
        assert_eq!(
            floorplan_line(&base(json!({"state": "unknown"})), ago),
            "could not read the map"
        );
        assert_eq!(
            floorplan_line(&base(json!({"state": "blueprint-started"})), ago),
            "a blueprint was started but never drawn"
        );
        assert_eq!(floorplan_line(&json!({"state": "odd"}), ago), "undefined");
    }
}
