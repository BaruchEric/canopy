//! Best-of-N run groups (`src/core/group.ts`). Only a group's state in
//! words is here; fan-out, scoring and the reviewer stay in the TypeScript.

use crate::js::{field, str_at, truthy_at};
use serde_json::Value;

/// `groupWord()`: a group's state as the lists print it.
pub fn group_word(group: &Value) -> String {
    match str_at(group, "state").unwrap_or("") {
        "reviewing" => "comparing".into(),
        "picked" => "winner picked".into(),
        "needs-you" if truthy_at(group, "reason") => {
            format!("needs you: {}", field(group, "reason"))
        }
        "needs-you" => "needs you".into(),
        _ => field(group, "state"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_group_in_words() {
        assert_eq!(group_word(&json!({"state": "working"})), "working");
        assert_eq!(group_word(&json!({"state": "reviewing"})), "comparing");
        assert_eq!(group_word(&json!({"state": "picked"})), "winner picked");
        assert_eq!(group_word(&json!({"state": "needs-you"})), "needs you");
        assert_eq!(
            group_word(&json!({"state": "needs-you", "reason": "a tie"})),
            "needs you: a tie"
        );
    }
}
