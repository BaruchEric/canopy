//! What JavaScript does to a value when the TypeScript prints it: a
//! template's `${x}`, `String(n)`, `Number(s)`, `n.toFixed(d)`,
//! `Object.keys()`, `JSON.stringify` of a number and of a whole value, and
//! the truthiness and `??` reads of a JSON field. The CLI's lines are
//! compared byte for byte with the TypeScript's, so these follow the
//! language, not taste. One copy each: a verb that needs one of these
//! uses it from here.

use crate::pathx::js_trim;
use crate::store::js_number;
use serde_json::{Value, json};

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

/// `String(n)`: JavaScript's shortest form, a whole number with no point,
/// an exponent at 1e21 and above and under 1e-6, and NaN and Infinity by
/// name.
pub fn number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n != 0.0 && (n.abs() >= 1e21 || n.abs() < 1e-6) {
        let e = format!("{n:e}");
        return match e.split_once('e') {
            Some((m, x)) if !x.starts_with('-') => format!("{m}e+{x}"),
            Some((m, x)) => format!("{m}e{x}"),
            None => e,
        };
    }
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// `Number(s)` for a string: JavaScript's whitespace trimmed, empty as 0,
/// the 0x, 0o and 0b forms, Infinity with a sign, a decimal with an
/// optional point and exponent; NaN for the rest.
pub fn number_of(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |n, c| {
                n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // digits with an optional point, or a point and digits, then an optional exponent
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(i) => (&unsigned[..i], Some(&unsigned[i + 1..])),
        None => (unsigned, None),
    };
    let (whole, frac) = match mantissa.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (mantissa, None),
    };
    let digits = |d: &str| d.chars().all(|c| c.is_ascii_digit());
    let mantissa_ok = digits(whole)
        && frac.is_none_or(digits)
        && !(whole.is_empty() && frac.is_none_or(str::is_empty));
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !mantissa_ok || !exponent_ok {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

/// A number as `JSON.stringify` writes it: a whole one (in the range a
/// double holds exactly) with no point, NaN and Infinity as null.
pub fn num(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// `Math.round()`: the nearer whole number, a half toward +∞.
pub fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `JSON.stringify(v, null, 2)`.
pub fn pretty<T: serde::Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// `Object.keys()`: the keys that read as array indexes first, by number,
/// then the rest in the order the JSON gave them. Anything but an object
/// has none.
pub fn keys(o: Option<&Value>) -> Vec<&String> {
    let Some(map) = o.and_then(Value::as_object) else {
        return vec![];
    };
    let index = |k: &str| -> Option<u32> {
        let n: u32 = k.parse().ok()?;
        (n < u32::MAX && n.to_string() == k).then_some(n)
    };
    let mut indexed: Vec<(u32, &String)> = map
        .keys()
        .filter_map(|k| index(k).map(|n| (n, k)))
        .collect();
    indexed.sort_by_key(|(n, _)| *n);
    let mut out: Vec<&String> = indexed.into_iter().map(|(_, k)| k).collect();
    out.extend(map.keys().filter(|k| index(k).is_none()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_of_a_number_is_javascripts() {
        assert_eq!(number_string(3.0), "3");
        assert_eq!(number_string(-0.0), "0");
        assert_eq!(number_string(0.5), "0.5");
        assert_eq!(number_string(1e21), "1e+21");
        assert_eq!(number_string(1.5e-7), "1.5e-7");
        assert_eq!(number_string(f64::NAN), "NaN");
        assert_eq!(number_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(js_number(f64::INFINITY), "Infinity");
    }

    #[test]
    fn number_of_a_string_is_javascripts() {
        assert_eq!(number_of(" 12 "), 12.0);
        assert_eq!(number_of(""), 0.0);
        assert_eq!(number_of("0x1f"), 31.0);
        assert_eq!(number_of("0b101"), 5.0);
        assert_eq!(number_of("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(number_of("1."), 1.0);
        assert_eq!(number_of(".5"), 0.5);
        assert_eq!(number_of("2e3"), 2000.0);
        for nan in [".", "1e", "-0x10", "abc", "1,000", "inf", "0x"] {
            assert!(number_of(nan).is_nan(), "{nan}");
        }
    }

    #[test]
    fn a_json_number_drops_a_whole_ones_point() {
        assert_eq!(num(3.0).to_string(), "3");
        assert_eq!(num(0.25).to_string(), "0.25");
        assert_eq!(num(f64::NAN), Value::Null);
        assert_eq!(num(f64::INFINITY), Value::Null);
    }

    #[test]
    fn math_round_takes_a_half_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(-0.6), -1.0);
    }

    #[test]
    fn keys_come_in_object_keys_order() {
        let o: Value = serde_json::from_str(r#"{"b":1,"2":1,"a":1,"1":1,"01":1}"#).unwrap();
        let k: Vec<&str> = keys(Some(&o)).into_iter().map(String::as_str).collect();
        assert_eq!(k, ["1", "2", "b", "a", "01"]);
        assert!(keys(Some(&json!([1]))).is_empty());
    }

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
