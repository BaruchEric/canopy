//! Agent settings read from a body or a hand-edited config
//! (`normalizeAgent` and `sameAgent` in `src/core/agent.ts`). Settings stay
//! JSON objects in the TS's key order, since the routes hand them on as
//! they are. `describeAgent` and `withHarness` are not ported yet.

use serde_json::{Map, Value, json};

use crate::harness::{is_harness, takes_effort, takes_model, takes_provider};
use crate::pathx::js_trim;

/// `DEFAULT_AGENT`: claude, its defaults, yolo on.
pub fn default_agent() -> Value {
    json!({ "harness": "claude", "model": "default", "effort": "default", "yolo": true, "extra": "" })
}

/// Settings field by field and per harness: a missing harness is claude, a
/// model or an effort the harness does not take falls back to its default,
/// and no control character reaches `extra`.
pub fn normalize_agent(v: &Value) -> Value {
    let Some(o) = v.as_object() else {
        return default_agent();
    };
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let harness = s("harness").filter(|h| is_harness(h)).unwrap_or("claude");
    let provider = s("provider").map(js_trim).unwrap_or_default();
    let mut out = Map::new();
    out.insert("harness".into(), json!(harness));
    let model = s("model")
        .filter(|m| takes_model(harness, m))
        .unwrap_or("default");
    out.insert("model".into(), json!(model));
    let effort = s("effort")
        .filter(|e| takes_effort(harness, e))
        .unwrap_or("default");
    out.insert("effort".into(), json!(effort));
    if provider != "default" && takes_provider(harness, provider) {
        out.insert("provider".into(), json!(provider));
    }
    out.insert(
        "yolo".into(),
        json!(o.get("yolo").and_then(Value::as_bool).unwrap_or(true)),
    );
    let extra: String = s("extra")
        .map(|e| e.chars().filter(|c| (*c as u32) > 0x1f).collect())
        .unwrap_or_default();
    out.insert("extra".into(), json!(js_trim(&extra)));
    if o.get("canopyTools") == Some(&Value::Bool(true)) {
        out.insert("canopyTools".into(), json!(true));
    }
    Value::Object(out)
}

/// Two settings that start the same agent.
pub fn same_agent(a: &Value, b: &Value) -> bool {
    let s = |v: &Value, k: &str| v.get(k).cloned().unwrap_or(Value::Null);
    let provider = |v: &Value| match v.get("provider").and_then(Value::as_str) {
        None | Some("default") => None,
        Some(p) => Some(p.to_string()),
    };
    let tools = |v: &Value| v.get("canopyTools") == Some(&Value::Bool(true));
    ["harness", "model", "effort", "yolo", "extra"]
        .iter()
        .all(|k| s(a, k) == s(b, k))
        && provider(a) == provider(b)
        && tools(a) == tools(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_foreign_value_falls_back_field_by_field() {
        assert_eq!(normalize_agent(&json!(null)), default_agent());
        let a = normalize_agent(&json!({
            "harness": "claude", "model": "gpt-5.5", "effort": "ultra",
            "provider": " local ", "yolo": false, "extra": " --x\u{1}y ", "canopyTools": true
        }));
        assert_eq!(
            a,
            json!({ "harness": "claude", "model": "default", "effort": "default", "provider": "local",
                    "yolo": false, "extra": "--xy", "canopyTools": true })
        );
        let keys: Vec<&String> = a.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "harness",
                "model",
                "effort",
                "provider",
                "yolo",
                "extra",
                "canopyTools"
            ]
        );
    }

    #[test]
    fn antigravity_takes_no_provider_and_an_unknown_harness_is_claude() {
        let a = normalize_agent(&json!({ "harness": "antigravity", "provider": "local" }));
        assert!(a.get("provider").is_none());
        assert_eq!(
            normalize_agent(&json!({ "harness": "gemini" }))["harness"],
            "claude"
        );
    }

    #[test]
    fn same_agent_reads_a_default_provider_as_none() {
        let mut b = default_agent();
        b["provider"] = json!("default");
        assert!(same_agent(&default_agent(), &b));
        b["canopyTools"] = json!(false);
        assert!(same_agent(&default_agent(), &b));
        b["yolo"] = json!(false);
        assert!(!same_agent(&default_agent(), &b));
    }
}
