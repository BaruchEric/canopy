//! Closing what sits idle (FR-018, `src/core/sweep.ts`). Only the kinds and
//! whether the sweep may close an item are here; the planner stays in the
//! TypeScript.

use crate::js::truthy_at;
use serde_json::Value;

/// `SWEEP_KINDS` in `core/types.ts`, in the order the sheet lists them.
pub const SWEEP_KINDS: &[&str] = &["shell", "chat", "run", "transcript", "pr", "outside"];

/// `mayClose()`: closable, and not one only a tick in the sheet closes.
pub fn may_close(item: &Value) -> bool {
    truthy_at(item, "closable") && !truthy_at(item, "handOnly")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_hand_only_item_is_never_closed_unticked() {
        assert!(may_close(&json!({"closable": true})));
        assert!(!may_close(&json!({"closable": true, "handOnly": true})));
        assert!(!may_close(&json!({"closable": false})));
    }
}
