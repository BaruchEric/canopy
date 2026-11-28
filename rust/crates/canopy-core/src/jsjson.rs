//! A JSON file read as `JSON.parse` reads it and written back as
//! `JSON.stringify` writes what it parsed, for routes that hand a record on
//! disk to the page as it is. serde_json and JavaScript part in three
//! places this covers: a whole number prints without a point, an object's
//! array-index keys ("0", "17") come first in numeric order, and a file
//! that JavaScript reads but serde_json will not (a lone surrogate escape,
//! a number past f64, nesting past 128) is told apart from one that is not
//! JSON at all, so a caller can answer 501 rather than a wrong empty list.

use crate::screenlayouts::js_num;
use serde_json::{Map, Value};

/// JavaScript would read this text, but serde_json cannot hold what it
/// holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unheld;

/// `JSON.parse(text)`: Some(value), None for text that is not JSON (where
/// JavaScript throws too), or `Unheld`.
pub fn parse(text: &str) -> Result<Option<Value>, Unheld> {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            let words = e.to_string();
            // a high surrogate with no low one after it is "unexpected end
            // of hex escape", a low one alone "lone leading surrogate"
            let unheld = [
                "surrogate",
                "end of hex escape",
                "recursion limit",
                "out of range",
            ]
            .iter()
            .any(|w| words.contains(w));
            if unheld { Err(Unheld) } else { Ok(None) }
        }
    }
}

/// A file as Node's `readFile(path, "utf8")` reads it: bytes that are not
/// UTF-8 become U+FFFD.
pub fn read_text(path: &str) -> std::io::Result<String> {
    std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// An array index as JavaScript orders an object's keys: a canonical
/// decimal below 2^32 - 1.
fn index_key(k: &str) -> Option<u32> {
    if k.is_empty() || k.len() > 10 || (k.len() > 1 && k.starts_with('0')) {
        return None;
    }
    if !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u64>()
        .ok()
        .filter(|n| *n < u32::MAX as u64)
        .map(|n| n as u32)
}

/// A parsed value as `JSON.stringify` writes it back.
pub fn to_js(v: &Value) -> Value {
    match v {
        Value::Number(n) => n.as_f64().map_or(Value::Null, js_num),
        Value::Array(a) => Value::Array(a.iter().map(to_js).collect()),
        Value::Object(m) => {
            let mut index: Vec<(u32, &String, &Value)> = m
                .iter()
                .filter_map(|(k, x)| index_key(k).map(|i| (i, k, x)))
                .collect();
            index.sort_by_key(|(i, _, _)| *i);
            let mut out = Map::new();
            for (_, k, x) in index {
                out.insert(k.clone(), to_js(x));
            }
            for (k, x) in m.iter().filter(|(k, _)| index_key(k).is_none()) {
                out.insert(k.clone(), to_js(x));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `s.slice(0, n)` in UTF-16 code units, or None when the cut halves a
/// pair: `JSON.stringify` writes the half left as an escape a Rust string
/// cannot hold.
pub fn slice_units(s: &str, n: usize) -> Option<String> {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_javascript_reads_is_told_from_text_that_is_not_json() {
        assert_eq!(parse("[1]"), Ok(Some(serde_json::json!([1]))));
        assert_eq!(parse("{"), Ok(None));
        assert_eq!(parse(""), Ok(None));
        assert_eq!(parse(r#"["\ud800"]"#), Err(Unheld));
        assert_eq!(parse(r#"["\udc00"]"#), Err(Unheld));
        assert_eq!(
            parse(r#"["\ud83d\ude00"]"#),
            Ok(Some(serde_json::json!(["😀"])))
        );
        assert_eq!(parse(r#"["\u12"]"#), Ok(None));
        assert_eq!(parse("[1e400]"), Err(Unheld));
        assert_eq!(
            parse(&format!("{}1{}", "[".repeat(200), "]".repeat(200))),
            Err(Unheld)
        );
    }

    #[test]
    fn written_back_as_json_stringify_writes_it() {
        let v = parse(r#"{"b": 1.0, "10": true, "a": [2.5, 3.0], "2": null, "01": 0}"#)
            .unwrap()
            .unwrap();
        assert_eq!(
            to_js(&v).to_string(),
            r#"{"2":null,"10":true,"b":1,"a":[2.5,3],"01":0}"#
        );
    }

    #[test]
    fn a_cut_that_halves_a_pair_is_none() {
        assert_eq!(slice_units("ab😀", 3), None);
        assert_eq!(slice_units("ab😀", 4).as_deref(), Some("ab😀"));
        assert_eq!(slice_units("abc", 2).as_deref(), Some("ab"));
    }
}
