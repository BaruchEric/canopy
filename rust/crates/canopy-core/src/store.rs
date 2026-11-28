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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
