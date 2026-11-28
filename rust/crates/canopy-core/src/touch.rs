//! Who else is editing the same files (`src/core/touch.ts`). Only the
//! other side's name is here; the overlap scan stays in the TypeScript.

use crate::js::field;
use serde_json::Value;

/// `withName()`: the run's name, the branch's, or "your uncommitted
/// changes".
pub fn with_name(w: &Value) -> String {
    match w.get("kind").and_then(Value::as_str) {
        Some("checkout") => "your uncommitted changes".into(),
        Some("branch") => field(w, "branch"),
        _ => field(w, "name"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_other_side_by_name() {
        assert_eq!(
            with_name(&json!({"kind": "checkout"})),
            "your uncommitted changes"
        );
        assert_eq!(
            with_name(&json!({"kind": "branch", "branch": "run/x"})),
            "run/x"
        );
        assert_eq!(with_name(&json!({"kind": "run", "name": "fox"})), "fox");
    }
}
