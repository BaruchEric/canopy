//! What JavaScript does to a value when the TypeScript prints it: a
//! template's `${x}`, `n.toFixed(d)`, and the truthiness and `??` reads of
//! a JSON field. The CLI's lines are compared byte for byte with the
//! TypeScript's, so these follow the language, not taste.

use crate::store::js_number;
use serde_json::Value;

/// `${x}` for a JSON value, `undefined` for a missing one.
pub fn template(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map(js_number).unwrap_or_default(),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.toString: each element, null and undefined empty
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => template(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `list.join(sep)`: each element as a template prints it, null and
/// undefined as nothing.
pub fn join(list: &[Value], sep: &str) -> String {
    list.iter()
        .map(|x| match x {
            Value::Null => String::new(),
            other => template(Some(other)),
        })
        .collect::<Vec<_>>()
        .join(sep)
}

/// `${o.key}`.
pub fn field(o: &Value, key: &str) -> String {
    template(o.get(key))
}

/// `o.key` when it is a string, which is what `?? fallback` keeps for the
/// fields these lines read (a server never sends a wrong type there).
pub fn str_at<'a>(o: &'a Value, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

/// `o.key` when it is a number.
pub fn num_at(o: &Value, key: &str) -> Option<f64> {
    o.get(key).and_then(Value::as_f64)
}

/// `o.key ?? []` for a list.
pub fn list_at<'a>(o: &'a Value, key: &str) -> &'a [Value] {
    o.get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// JavaScript's truthiness.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `o.key` is truthy.
pub fn truthy_at(o: &Value, key: &str) -> bool {
    truthy(o.get(key))
}

/// `x.toFixed(digits)`. Rust rounds an exact tie to even and JavaScript
/// rounds it away from zero (0.125 is "0.13" there), so a tie is found in
/// the exact decimal expansion and rounded up by hand.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return js_number(x);
    }
    // -0 is not below zero there, so it prints unsigned
    let x = if x == 0.0 { 0.0 } else { x };
    let wide = format!("{:.*}", digits + 40, x.abs());
    let (whole, frac) = wide.split_once('.').unwrap_or((&wide, ""));
    let tail = &frac[digits.min(frac.len())..];
    let tie = tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0');
    if !tie {
        return format!("{:.*}", digits, x);
    }
    // the kept digits as one integer, plus one
    let kept = format!("{whole}{}", &frac[..digits.min(frac.len())]);
    let mut digits_up: Vec<u8> = kept.bytes().map(|b| b - b'0').collect();
    let mut i = digits_up.len();
    loop {
        if i == 0 {
            digits_up.insert(0, 1);
            break;
        }
        i -= 1;
        if digits_up[i] == 9 {
            digits_up[i] = 0;
        } else {
            digits_up[i] += 1;
            break;
        }
    }
    let s: String = digits_up.iter().map(|d| char::from(b'0' + d)).collect();
    let (w, f) = s.split_at(s.len() - digits);
    let body = if digits == 0 {
        w.to_string()
    } else {
        format!("{w}.{f}")
    };
    if x < 0.0 { format!("-{body}") } else { body }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_template_prints_what_javascript_prints() {
        let o = json!({"s": "x", "n": 3, "f": 0.5, "z": null, "a": [1, null, "b"], "o": {}});
        assert_eq!(field(&o, "s"), "x");
        assert_eq!(field(&o, "n"), "3");
        assert_eq!(field(&o, "f"), "0.5");
        assert_eq!(field(&o, "z"), "null");
        assert_eq!(field(&o, "a"), "1,,b");
        assert_eq!(field(&o, "o"), "[object Object]");
        assert_eq!(field(&o, "gone"), "undefined");
    }

    #[test]
    fn to_fixed_rounds_a_tie_away_from_zero() {
        assert_eq!(to_fixed(1.0 / 3.0, 2), "0.33");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(0.625, 2), "0.63");
        assert_eq!(to_fixed(-0.125, 2), "-0.13");
        assert_eq!(to_fixed(0.995, 2), "0.99");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.5, 0), "100");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(1.0, 2), "1.00");
        assert_eq!(to_fixed(0.45, 2), "0.45");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
    }

    #[test]
    fn truthiness_follows_javascript() {
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!([]))));
        assert!(!truthy(None));
    }
}
