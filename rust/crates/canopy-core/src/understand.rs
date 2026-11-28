//! The words of `src/core/understand.ts` (FR-072), as `canopy understand`
//! prints them: `understandLine`, `PREPARING_WORDS` and `isWait`. Reading
//! the graph and meta.json, the folder, the run's spec and prompt, the
//! viewer's record and the section's head are not ported yet.

use crate::js::{template, truthy};
use serde_json::Value;

/// `PREPARING_WORDS`: what the page and the CLI say while the plugin is
/// being prepared.
pub const PREPARING_WORDS: &str = "getting Understand-Anything ready on this backend (the first time it installs and builds, a minute or two)";

/// `isWait()`: the route's 202 while it prepares the plugin, `{preparing:
/// true, plugin}`.
pub fn is_wait(v: &Value) -> bool {
    v.is_object() && v.get("preparing") == Some(&Value::Bool(true))
}

/// `plural(n, one)`.
fn plural(n: Option<&Value>, one: &str) -> String {
    if n.and_then(Value::as_f64) == Some(1.0) {
        format!("{} {one}", template(n))
    } else {
        format!("{} {one}s", template(n))
    }
}

/// `v !== null`: a missing field is undefined, which is not null.
fn not_null(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Null))
}

/// `.replace(/ in (\d+ layers?)$/, ", $1")`: the layers after the files
/// read as a list, not as a third "in".
fn layers_listed(s: &str) -> String {
    let stem = s
        .strip_suffix(" layers")
        .or_else(|| s.strip_suffix(" layer"));
    if let Some(stem) = stem {
        let digits = stem.len() - stem.trim_end_matches(|c: char| c.is_ascii_digit()).len();
        let head = &stem[..stem.len() - digits];
        if digits > 0
            && let Some(before) = head.strip_suffix(" in ")
        {
            return format!("{before}, {}", &s[head.len()..]);
        }
    }
    s.to_string()
}

/// `understandLine(info, ago)`: one line for a checkout's graph. `ago`
/// words a time from its ISO string.
pub fn understand_line(info: &Value, ago: impl Fn(&str) -> String) -> String {
    match info.get("state").and_then(Value::as_str) {
        Some("none") => "no graph yet".into(),
        Some("unknown") => {
            let error = info.get("error");
            if truthy(error) {
                format!("could not read the graph: {}", template(error))
            } else {
                "could not read the graph".into()
            }
        }
        Some("graph") => {
            let (nodes, files, layers) = (info.get("nodes"), info.get("files"), info.get("layers"));
            let mut size = Vec::new();
            if not_null(nodes) {
                size.push(plural(nodes, "node"));
            }
            if not_null(files) {
                size.push(plural(files, "file"));
            }
            if truthy(layers) {
                size.push(plural(layers, "layer"));
            }
            let analyzed = info.get("analyzedAt");
            let made = if truthy(analyzed) {
                format!(", made {}", ago(&template(analyzed)))
            } else {
                String::new()
            };
            let (behind, changed) = (info.get("behind"), info.get("changed"));
            let since = if truthy(behind) {
                let files = if truthy(changed) {
                    format!(", {} changed", plural(changed, "file"))
                } else {
                    String::new()
                };
                format!("; {} since{files}", plural(behind, "commit"))
            } else {
                String::new()
            };
            let size = if size.is_empty() {
                "a graph".to_string()
            } else {
                layers_listed(&size.join(" in "))
            };
            format!("{size}{made}{since}")
        }
        // a state the switch does not name returns undefined, which prints
        _ => "undefined".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// parseGraph() of the test's graph: three nodes, two of them files,
    /// one edge, one layer, a tour of two
    fn base() -> Value {
        json!({"state": "graph", "analyzedAt": "2026-11-20T09:00:00.000Z", "commit": "a".repeat(40),
               "nodes": 3, "edges": 1, "files": 2, "layers": 1, "tour": 2})
    }

    fn with(mut v: Value, more: Value) -> Value {
        for (k, x) in more.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn ago(iso: &str) -> String {
        if iso.starts_with("2026-11-20") {
            "3h ago".into()
        } else {
            iso.into()
        }
    }

    #[test]
    fn understand_line_words_each_state() {
        assert_eq!(
            understand_line(&with(base(), json!({"behind": 0, "changed": 0})), ago),
            "3 nodes in 2 files, 1 layer, made 3h ago"
        );
        assert_eq!(
            understand_line(&with(base(), json!({"behind": 4, "changed": 9})), ago),
            "3 nodes in 2 files, 1 layer, made 3h ago; 4 commits since, 9 files changed"
        );
        assert_eq!(
            understand_line(
                &with(base(), json!({"layers": 0, "behind": 1, "changed": 0})),
                ago
            ),
            "3 nodes in 2 files, made 3h ago; 1 commit since"
        );
        assert_eq!(
            understand_line(
                &with(
                    base(),
                    json!({"nodes": null, "files": null, "layers": null, "analyzedAt": null, "behind": null, "changed": null})
                ),
                ago
            ),
            "a graph"
        );
        // parseGraph(null): state unknown with its reason
        let unreadable = json!({"state": "unknown", "analyzedAt": null, "commit": null, "nodes": null, "edges": null,
                                "files": null, "layers": null, "tour": null, "error": "knowledge-graph.json is not a graph canopy can read",
                                "behind": null, "changed": null});
        assert_eq!(
            understand_line(&unreadable, ago),
            "could not read the graph: knowledge-graph.json is not a graph canopy can read"
        );
        let none = json!({"state": "none", "analyzedAt": null, "nodes": null, "edges": null, "files": null, "layers": null, "behind": null, "changed": null});
        assert_eq!(understand_line(&none, ago), "no graph yet");
    }

    #[test]
    fn the_layers_join_as_a_list_only_after_a_count() {
        assert_eq!(
            understand_line(&with(base(), json!({"files": null, "layers": 4})), ago),
            "3 nodes, 4 layers, made 3h ago"
        );
        assert_eq!(
            understand_line(
                &with(base(), json!({"nodes": null, "files": null, "layers": 2})),
                ago
            ),
            "2 layers, made 3h ago"
        );
        assert_eq!(
            understand_line(&with(base(), json!({"layers": 1.5})), ago),
            "3 nodes in 2 files in 1.5 layers, made 3h ago"
        );
        assert_eq!(understand_line(&json!({"state": "odd"}), ago), "undefined");
    }

    #[test]
    fn is_wait_knows_the_routes_202() {
        assert!(is_wait(
            &json!({"preparing": true, "plugin": {"state": "preparing"}})
        ));
        assert!(!is_wait(&json!({"id": "r1"})));
        assert!(!is_wait(&Value::Null));
        assert!(!is_wait(&json!({"preparing": 1})));
    }
}
