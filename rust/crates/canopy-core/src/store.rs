//! Where canopy keeps its state, and the parts of `config.json` the ported
//! code reads (`src/core/store.ts`). The rest of the file is kept as raw
//! JSON, untouched, until the code that owns it is ported.

use serde_json::Value;

/// `$CANOPY_CONFIG_DIR`, else `~/.config/canopy`. An empty variable counts
/// as set, as `??` has it.
pub fn config_dir() -> String {
    if let Some(d) = std::env::var_os("CANOPY_CONFIG_DIR") {
        return d.to_string_lossy().into_owned();
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    crate::pathx::join(&home, ".config/canopy")
}

pub fn config_path() -> String {
    crate::pathx::join(&config_dir(), "config.json")
}

/// The config, as far as the ported code reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct CanopyConfig {
    /// how deep the scan walks below a root
    pub max_depth: f64,
    /// folder names the scan skips, on top of the defaults
    pub ignore: Vec<String>,
    /// the whole file as read, for the parts not ported yet
    pub raw: Value,
}

impl Default for CanopyConfig {
    fn default() -> Self {
        Self {
            max_depth: 4.0,
            ignore: vec![],
            raw: Value::Object(Default::default()),
        }
    }
}

/// Merge over defaults, repairing fields whose type is wrong.
pub fn normalize(parsed: Value) -> CanopyConfig {
    let base = CanopyConfig::default();
    let max_depth = parsed
        .get("maxDepth")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(base.max_depth);
    let ignore = parsed
        .get("ignore")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    CanopyConfig {
        max_depth,
        ignore,
        raw: parsed,
    }
}

/// Read the config. A missing file is a first run. An unreadable one is
/// moved aside to `config.json.corrupt-<ms>` rather than lost, as the
/// TypeScript does, and defaults are used.
pub fn load_config() -> std::io::Result<CanopyConfig> {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(CanopyConfig::default()),
        Err(e) => return Err(e),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) if v.is_object() => Ok(normalize(v)),
        // JSON.parse of a valid non-object spreads to nothing over the defaults
        Ok(_) => Ok(CanopyConfig::default()),
        Err(_) => {
            let backup = format!("{path}.corrupt-{}", crate::types::now_ms());
            let _ = std::fs::rename(&path, &backup);
            eprintln!("canopy: unreadable config, moved to {backup}");
            Ok(CanopyConfig::default())
        }
    }
}

/// A number as JavaScript's `String(n)` prints it, for the few places a
/// config number lands in an argv.
pub fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/* ---------- the config's other fields, read from `raw` as `normalize` does ---------- */

/// the colors a workspace may carry
pub const WS_COLORS: [&str; 5] = ["moss", "lichen", "rust", "sky", "bark"];

/// One stored workspace, or None for junk; a primary that is not a member
/// and a color that is not one of `WS_COLORS` are left out.
pub fn normalize_workspace(v: &Value) -> Option<Value> {
    let w = v.as_object()?;
    let name = w.get("name")?.as_str()?;
    let repos: Vec<&str> = w
        .get("repos")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let mut out = serde_json::Map::new();
    out.insert("name".into(), Value::from(name));
    out.insert("repos".into(), Value::from(repos.clone()));
    if let Some(p) = w
        .get("primary")
        .and_then(Value::as_str)
        .filter(|p| repos.contains(p))
    {
        out.insert("primary".into(), Value::from(p));
    }
    if let Some(c) = w
        .get("color")
        .and_then(Value::as_str)
        .filter(|c| WS_COLORS.contains(c))
    {
        out.insert("color".into(), Value::from(c));
    }
    Some(Value::Object(out))
}

/// The config's workspaces, junk left out.
pub fn workspaces(raw: &Value) -> Vec<Value> {
    raw.get("workspaces")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(normalize_workspace).collect())
        .unwrap_or_default()
}

/// A boolean field, else its default.
pub fn flag(raw: &Value, key: &str, default: bool) -> bool {
    raw.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// A list of paths: strings, none empty, the first of each kept (`paths`).
pub fn paths_of(raw: &Value, key: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for p in raw
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !p.is_empty() && !out.iter().any(|x| x == p) {
            out.push(p.into());
        }
    }
    out
}

/// The config's `harness` list: null when the field is not a list yet.
pub fn harness_paths(raw: &Value) -> Option<Vec<String>> {
    raw.get("harness")
        .filter(|v| v.is_array())
        .map(|_| paths_of(raw, "harness"))
}

/// The extra folders the config names (`isStoredSource`): an id that is
/// not the launch root's, a label, and a local path, an ssh host and path,
/// or a forge url.
pub fn stored_sources(raw: &Value) -> Vec<crate::types::Source> {
    use crate::types::{Source, SourcePlace};
    let mut out = vec![];
    for s in raw
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(o) = s.as_object() else { continue };
        let text = |k: &str| o.get(k).and_then(Value::as_str);
        let Some(id) = text("id").filter(|i| !i.is_empty() && *i != crate::types::LAUNCH_SOURCE)
        else {
            continue;
        };
        let Some(label) = text("label") else { continue };
        let place = match text("kind") {
            Some("forgejo") => {
                let Some(url) = text("url").filter(|u| !u.is_empty()) else {
                    continue;
                };
                let token_file = match o.get("tokenFile") {
                    None => None,
                    Some(Value::String(t)) => Some(t.clone()),
                    Some(_) => continue,
                };
                SourcePlace::Forgejo {
                    url: url.into(),
                    token_file,
                }
            }
            kind => {
                let Some(path) = text("path") else { continue };
                match (kind, text("host")) {
                    (Some("local"), _) => SourcePlace::Local { path: path.into() },
                    (Some("ssh"), Some(h)) if !h.is_empty() => SourcePlace::Ssh {
                        host: h.into(),
                        path: path.into(),
                    },
                    _ => continue,
                }
            }
        };
        out.push(Source {
            id: id.into(),
            place,
            label: label.into(),
            launch: false,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspaces_drop_junk_and_a_primary_or_color_that_does_not_fit() {
        let w = workspaces(&json!({ "workspaces": [
            { "name": "both", "repos": ["/a", 3, "/b"], "primary": "/c", "color": "nope" },
            { "name": "one", "repos": ["/a"], "primary": "/a", "color": "sky" },
            { "name": 5, "repos": [] },
            { "name": "no repos" }
        ]}));
        assert_eq!(
            w,
            vec![
                json!({ "name": "both", "repos": ["/a", "/b"] }),
                json!({ "name": "one", "repos": ["/a"], "primary": "/a", "color": "sky" }),
            ]
        );
    }

    #[test]
    fn stored_sources_keep_the_kinds_a_source_can_be() {
        let s = stored_sources(&json!({ "sources": [
            { "id": "x", "label": "X", "kind": "local", "path": "/x" },
            { "id": "launch", "label": "L", "kind": "local", "path": "/l" },
            { "id": "s", "label": "S", "kind": "ssh", "host": "", "path": "/s" },
            { "id": "f", "label": "F", "kind": "forgejo", "url": "https://git.example", "tokenFile": 3 },
            { "id": "g", "label": "G", "kind": "forgejo", "url": "https://git.example" }
        ]}));
        assert_eq!(
            s.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["x", "g"]
        );
    }

    #[test]
    fn paths_keep_the_first_of_each_and_harness_stays_null_until_a_list() {
        let raw = json!({ "favorites": ["/a", "", "/a", 3, "/b"], "harness": "x" });
        assert_eq!(paths_of(&raw, "favorites"), ["/a", "/b"]);
        assert_eq!(harness_paths(&raw), None);
        assert_eq!(harness_paths(&json!({ "harness": [] })), Some(vec![]));
    }

    #[test]
    fn repairs_wrong_types() {
        let c = normalize(json!({"maxDepth": "deep", "ignore": ["a", 3, "b"]}));
        assert_eq!(c.max_depth, 4.0);
        assert_eq!(c.ignore, vec!["a", "b"]);
        let c = normalize(json!({"maxDepth": 2, "ignore": null}));
        assert_eq!(c.max_depth, 2.0);
        assert!(c.ignore.is_empty());
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_number(5.0), "5");
        assert_eq!(js_number(3.5), "3.5");
    }
}
