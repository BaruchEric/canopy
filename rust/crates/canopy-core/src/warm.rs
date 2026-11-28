//! The warm worktree pool (`src/core/warm.ts`), the parts canopy-server's
//! `GET /api/worktrees` reads: a slot's name (`isWarmName`), the record's
//! file (`WARM_RECORD`) and whether a record holds anything, this machine's
//! count for a repo (`warmFor` and `normalizeWarm` in core/store.ts), and
//! the free bytes on the root's volume (`freeBytes` in server/warm.ts). The
//! refill, the take, staleness and the probe are not ported yet.

use serde_json::Value;

/// `WARM_MAX`: the most prepared worktrees a repo keeps.
pub const WARM_MAX: f64 = 2.0;
/// `WARM_RECORD`: the record's name in a repo's folder under the root.
pub const WARM_RECORD: &str = "warm.json";

/// `isWarmName()`: `warm-1`, `warm-2`, ...; never `warm-0`.
pub fn is_warm_name(name: &str) -> bool {
    name.strip_prefix("warm-").is_some_and(|n| {
        n.bytes().next().is_some_and(|b| (b'1'..=b'9').contains(&b))
            && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// `warmFor(cfg, path)`: the count this machine keeps for a repo, as
/// `normalizeWarm` keeps the config's `warm` (a whole number from 1 to
/// `WARM_MAX` under a path that is not empty); 0 for any other.
pub fn warm_for(raw: &Value, path: &str) -> f64 {
    if path.is_empty() {
        return 0.0;
    }
    raw.get("warm")
        .and_then(Value::as_object)
        .and_then(|w| w.get(path))
        .and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && (1.0..=WARM_MAX).contains(n))
        .unwrap_or(0.0)
}

/// Whether a record's text gives no trees and no fails for certain:
/// `parseWarmRecord` reads anything that is not JSON, not an object, or
/// without both lists as the empty record, and so is one whose lists are
/// both empty. A record with entries may hold some, so it is not this.
pub fn holds_nothing(text: &str) -> bool {
    let Ok(raw) = serde_json::from_str::<Value>(text) else {
        return true;
    };
    let list = |k: &str| raw.get(k).and_then(Value::as_array);
    match (raw.as_object(), list("trees"), list("fails")) {
        (Some(_), Some(trees), Some(fails)) => {
            (trees.is_empty() && fails.is_empty())
                || trees.len() as f64 > WARM_MAX
                || fails.len() as f64 > WARM_MAX
        }
        _ => true,
    }
}

/// `freeBytes()`: the bytes free on a folder's volume, `bavail * bsize` as
/// Node's `statfs` gives them; None when the folder cannot be read.
pub fn free_bytes(dir: &str) -> Option<f64> {
    let s = rustix::fs::statfs(dir).ok()?;
    #[allow(clippy::unnecessary_cast)]
    Some(s.f_bavail as f64 * s.f_bsize as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_warm_slot_is_warm_and_a_number_from_1() {
        assert!(is_warm_name("warm-1") && is_warm_name("warm-12"));
        for bad in ["warm-0", "warm-01", "warm-", "warm-x", "run-1", "warm-1a"] {
            assert!(!is_warm_name(bad), "{bad}");
        }
    }

    #[test]
    fn only_explicit_positive_counts_survive() {
        let raw = json!({ "warm": { "/a": 2, "/b": 3, "/c": 0, "/d": 1.5, "/e": "1", "": 1 } });
        assert_eq!(warm_for(&raw, "/a"), 2.0);
        for p in ["/b", "/c", "/d", "/e", "", "/none"] {
            assert_eq!(warm_for(&raw, p), 0.0, "{p}");
        }
        assert_eq!(warm_for(&json!({ "warm": [1] }), "0"), 0.0);
    }

    #[test]
    fn a_record_holds_nothing_unless_its_lists_have_entries() {
        for empty in [
            "",
            "not json",
            "[]",
            r#"{"trees":[]}"#,
            r#"{"trees":[],"fails":[]}"#,
            r#"{"trees":[1,2,3],"fails":[]}"#,
        ] {
            assert!(holds_nothing(empty), "{empty}");
        }
        assert!(!holds_nothing(
            r#"{"trees":[],"fails":[{"dir":"/r/warm-1"}]}"#
        ));
        assert!(!holds_nothing(
            r#"{"trees":[{"dir":"/r/warm-1"}],"fails":[]}"#
        ));
    }

    #[test]
    fn a_folder_has_free_bytes_and_a_missing_one_has_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(dir.path().to_str().unwrap()).is_some_and(|n| n > 0.0));
        assert_eq!(free_bytes("/no/such/folder/anywhere"), None);
    }
}
