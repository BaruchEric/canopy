//! Several backends' claude-history overviews as one
//! (`src/core/historymerge.ts`), whole. An overview stays JSON, as the
//! backends serve it.

use crate::js::truthy_at;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

/// `mergeHistory()`: the overviews as one, on the first available one's
/// days. A day it does not cover drops out of the others' arrays and a day
/// they lack is 0. One overview is handed back as it is.
pub fn merge_history(parts: &[Value]) -> Option<Value> {
    if parts.len() == 1 {
        return parts.first().cloned();
    }
    let ok: Vec<&Value> = parts.iter().filter(|p| truthy_at(p, "available")).collect();
    let Some(base) = ok.first().copied() else {
        return parts.first().cloned();
    };
    let base_days = base
        .get("days")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let at: HashMap<String, usize> = base_days
        .iter()
        .enumerate()
        .map(|(i, d)| (crate::js::template(Some(d)), i))
        .collect();
    let align = |days: &[Value], vals: Option<&Value>| -> Value {
        let vals = vals
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        let mut out: Vec<Value> = base_days.iter().map(|_| json!(0)).collect();
        for (i, d) in days.iter().enumerate() {
            if let Some(&j) = at.get(&crate::js::template(Some(d))) {
                out[j] = match vals.get(i) {
                    None | Some(Value::Null) => json!(0),
                    Some(v) => v.clone(),
                };
            }
        }
        Value::Array(out)
    };
    let mut repos = Map::new();
    let mut max_day = 0f64;
    for p in &ok {
        max_day = js_max(
            max_day,
            p.get("maxDay").and_then(Value::as_f64).unwrap_or(f64::NAN),
        );
        let days = p
            .get("days")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        let Some(list) = p.get("repos").and_then(Value::as_object) else {
            continue;
        };
        for (id, h) in list {
            let merged = if std::ptr::eq(*p, base) {
                h.clone()
            } else {
                let mut h = h.clone();
                if let Some(o) = h.as_object_mut() {
                    let d = align(days, o.get("days"));
                    let s = align(days, o.get("daySessions"));
                    o.insert("days".into(), d);
                    o.insert("daySessions".into(), s);
                }
                h
            };
            repos.insert(id.clone(), merged);
        }
    }
    Some(json!({
        "available": true,
        "days": base.get("days").cloned().unwrap_or(Value::Null),
        "maxDay": number(max_day),
        "repos": repos,
        "fetchedAt": base.get("fetchedAt").cloned().unwrap_or(Value::Null),
    }))
}

/// `Math.max(a, b)`: NaN wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// A number as JSON holds it: a whole one as an integer, as JavaScript
/// writes it.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overview(days: &[&str], repos: Value, max_day: f64) -> Value {
        json!({"available": true, "days": days, "maxDay": max_day, "repos": repos, "fetchedAt": 7})
    }

    #[test]
    fn one_overview_comes_back_as_it_is() {
        let down = json!({"available": false, "reason": "no archive", "fetchedAt": 0});
        assert_eq!(merge_history(std::slice::from_ref(&down)), Some(down));
        assert_eq!(merge_history(&[]), None);
    }

    #[test]
    fn the_others_align_on_the_first_available_ones_days() {
        let down = json!({"available": false, "reason": "no archive", "fetchedAt": 0});
        let a = overview(
            &["2026-10-01", "2026-10-02"],
            json!({"app": {"project": "p", "days": [1, 2], "daySessions": [1, 1]}}),
            2.0,
        );
        let b = overview(
            &["2026-10-02", "2026-10-03"],
            json!({"mini|app": {"project": "q", "days": [5, 9], "daySessions": [2, 3]}}),
            9.0,
        );
        let merged = merge_history(&[down.clone(), a, b]).unwrap();
        assert_eq!(merged["days"], json!(["2026-10-01", "2026-10-02"]));
        assert_eq!(merged["maxDay"], json!(9));
        assert_eq!(merged["fetchedAt"], json!(7));
        assert_eq!(merged["repos"]["app"]["days"], json!([1, 2]));
        assert_eq!(merged["repos"]["mini|app"]["days"], json!([0, 5]));
        assert_eq!(merged["repos"]["mini|app"]["daySessions"], json!([0, 2]));
        assert_eq!(merged["repos"]["mini|app"]["project"], json!("q"));
        // none available: the first part, whatever it says
        assert_eq!(merge_history(&[down.clone(), down.clone()]), Some(down));
    }
}
