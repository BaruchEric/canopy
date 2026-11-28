//! The archive behind the rings (`src/core/history.ts`): where the
//! claude-history CLI is (`locateHistory`). Its reports, the overview built
//! from them and the session reads are not ported yet.

use serde_json::Value;

/// `RING_DAYS`: the days the rings cover.
pub const RING_DAYS: u32 = 30;

/// What `locateHistory` says when it finds no CLI anywhere.
pub const NOT_FOUND: &str = "claude-history is not on PATH and not at ~/dev/dev-tools/claude-history; set historyBin in ~/.config/canopy/config.json";

/// The config's `historyBin` as `normalize` keeps it: a string that is not
/// empty.
pub fn history_bin(raw: &Value) -> Option<&str> {
    raw.get("historyBin")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// `locateHistory()`: the config's word first, then PATH (`which`), then
/// the checkout next to canopy in `~/dev`. `Err` carries the reason the
/// overview gives when there is none.
pub fn locate_history(
    history_bin: Option<&str>,
    which: &dyn Fn(&str) -> Option<String>,
    home: &str,
) -> Result<String, String> {
    if let Some(bin) = history_bin {
        return if std::path::Path::new(bin).exists() {
            Ok(bin.to_string())
        } else {
            Err(format!(
                "historyBin in config points at {bin}, which does not exist"
            ))
        };
    }
    if let Some(on_path) = which("claude-history") {
        return Ok(on_path);
    }
    let sibling = crate::pathx::join(home, "dev/dev-tools/claude-history/bin/claude-history");
    if std::path::Path::new(&sibling).exists() {
        return Ok(sibling);
    }
    Err(NOT_FOUND.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_configs_word_first_and_it_must_exist() {
        let none = |_: &str| -> Option<String> { Some("/on/path".into()) };
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("ch");
        std::fs::write(&bin, "").unwrap();
        let h = home.path().to_str().unwrap();
        assert_eq!(
            locate_history(Some(bin.to_str().unwrap()), &none, h),
            Ok(bin.to_str().unwrap().to_string())
        );
        assert_eq!(
            locate_history(Some("/nope/claude-history"), &none, h),
            Err("historyBin in config points at /nope/claude-history, which does not exist".into())
        );
    }

    #[test]
    fn then_path_then_the_checkout_beside_canopy() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().to_str().unwrap();
        let found = |_: &str| -> Option<String> { Some("/on/path/claude-history".into()) };
        let missing = |_: &str| -> Option<String> { None };
        assert_eq!(
            locate_history(None, &found, h),
            Ok("/on/path/claude-history".into())
        );
        assert_eq!(locate_history(None, &missing, h), Err(NOT_FOUND.into()));
        let sibling = home.path().join("dev/dev-tools/claude-history/bin");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("claude-history"), "").unwrap();
        assert_eq!(
            locate_history(None, &missing, h),
            Ok(format!(
                "{h}/dev/dev-tools/claude-history/bin/claude-history"
            ))
        );
    }

    #[test]
    fn an_empty_or_odd_history_bin_is_none() {
        assert_eq!(history_bin(&json!({ "historyBin": "" })), None);
        assert_eq!(history_bin(&json!({ "historyBin": 3 })), None);
        assert_eq!(history_bin(&json!({ "historyBin": "/x" })), Some("/x"));
    }
}
