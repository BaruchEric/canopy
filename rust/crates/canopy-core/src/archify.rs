//! The words and names of `src/core/archify.ts` (FR-071), as `canopy
//! archify` reads and prints them: the diagram types and a start's pick,
//! what a plain folder name is, `archifyLine`, `checksWord` and `typeWord`.
//! The run's spec and prompt, finalize's receipt, a page's title, folder
//! names and slugs, and the section's head are not ported yet.

use crate::js::template;
use serde_json::Value;

/// `ARCHIFY_FOLDER`: the diagrams' folder at the checkout's root.
pub const ARCHIFY_FOLDER: &str = ".archify";

/// `ARCHIFY_TYPES`: Archify's ten native diagrams and the one-page
/// explainer.
pub const ARCHIFY_TYPES: [&str; 11] = [
    "architecture",
    "workflow",
    "sequence",
    "dataflow",
    "lifecycle",
    "erd",
    "class",
    "tree",
    "timeline",
    "waterfall",
    "explainer",
];

/// `isArchifyType()`.
pub fn is_archify_type(v: &str) -> bool {
    ARCHIFY_TYPES.contains(&v)
}

/// `isArchifyPick()`: a start's type, one of the types or `auto`.
pub fn is_archify_pick(v: &str) -> bool {
    v == "auto" || is_archify_type(v)
}

/// `isPlainName()`: one plain part, `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`
/// with no `..`, so no slash, backslash or NUL ever reaches a path join.
pub fn is_plain_name(name: &str) -> bool {
    let b = name.as_bytes();
    let Some((first, rest)) = b.split_first() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && rest.len() <= 127
        && rest
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        && !name.contains("..")
}

/// `plural(n, one)`.
fn plural(n: usize, one: &str) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else {
        format!("{n} {one}s")
    }
}

/// `archifyLine(info, ago)`: one line for a checkout's diagrams. `ago`
/// words a unix-ms time; a missing one is NaN, as `now - undefined` is.
pub fn archify_line(info: &Value, ago: impl Fn(f64) -> String) -> String {
    let diagrams = crate::js::list_at(info, "diagrams");
    let newest = match diagrams.first() {
        None | Some(Value::Null) => return "no diagrams yet".into(),
        Some(d) => d,
    };
    let at = ago(built_at(newest));
    match diagrams.len() {
        1 => format!("1 diagram, built {at}"),
        n => format!("{}; the newest built {at}", plural(n, "diagram")),
    }
}

/// A diagram's `builtAt`, NaN when it has none.
pub fn built_at(d: &Value) -> f64 {
    crate::js::num_at(d, "builtAt").unwrap_or(f64::NAN)
}

/// `checksWord()`: finalize's verdict in a few words. A value the switch
/// does not name returns undefined, which prints.
pub fn checks_word(checks: Option<&Value>) -> String {
    match checks {
        Some(Value::String(s)) if s == "pass" => "checked".into(),
        Some(Value::String(s)) if s == "browser-skipped" => "checked, no browser check".into(),
        Some(Value::String(s)) if s == "fail" => "a check failed".into(),
        Some(Value::Null) => "not checked".into(),
        _ => "undefined".into(),
    }
}

/// `typeWord()`: a type as the list says it.
pub fn type_word(t: Option<&Value>) -> String {
    match t {
        Some(Value::Null) => "diagram".into(),
        Some(Value::String(s)) if s == "dataflow" => "data flow".into(),
        Some(Value::String(s)) if s == "erd" => "ERD".into(),
        other => template(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FOLDER: &str = "architecture-shop-20261121-101500";

    #[test]
    fn a_plain_name_is_one_safe_part_never_a_way_out() {
        assert!(is_plain_name(FOLDER));
        assert!(is_plain_name("review-2"));
        let long = "x".repeat(129);
        for bad in [
            "", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a..b", "x\0y", "a b", &long,
        ] {
            assert!(!is_plain_name(bad), "{bad:?}");
        }
        assert!(is_plain_name(&"x".repeat(128)));
        assert!(!is_plain_name("é"));
        assert!(
            !is_plain_name("a\n"),
            "$ is the end of the string, not a line"
        );
    }

    #[test]
    fn a_pick_is_auto_or_one_of_the_eleven_types() {
        assert_eq!(ARCHIFY_TYPES.len(), 11);
        assert!(is_archify_pick("auto"));
        assert!(is_archify_pick("waterfall"));
        assert!(!is_archify_pick("mindmap"));
        // isArchifyPick(3): a number is not a &str, so the type refuses it
        assert!(!is_archify_type("auto"));
    }

    fn diagram(built_at: i64) -> Value {
        json!({"id": FOLDER, "file": "shop.html", "title": "Shop", "type": "architecture", "bytes": 1, "builtAt": built_at, "checks": "pass"})
    }

    #[test]
    fn the_line_counts_the_diagrams_and_dates_the_newest() {
        let ago = |ms: f64| format!("{ms}ms ago");
        assert_eq!(
            archify_line(&json!({"diagrams": []}), ago),
            "no diagrams yet"
        );
        assert_eq!(
            archify_line(&json!({"diagrams": [diagram(5)]}), ago),
            "1 diagram, built 5ms ago"
        );
        assert_eq!(
            archify_line(&json!({"diagrams": [diagram(9), diagram(5)]}), ago),
            "2 diagrams; the newest built 9ms ago"
        );
    }

    #[test]
    fn a_verdict_in_a_few_words() {
        assert_eq!(checks_word(Some(&json!("pass"))), "checked");
        assert_eq!(
            checks_word(Some(&json!("browser-skipped"))),
            "checked, no browser check"
        );
        assert_eq!(checks_word(Some(&json!("fail"))), "a check failed");
        assert_eq!(checks_word(Some(&Value::Null)), "not checked");
        assert_eq!(checks_word(None), "undefined");
    }

    #[test]
    fn a_type_as_the_list_says_it() {
        assert_eq!(type_word(Some(&Value::Null)), "diagram");
        assert_eq!(type_word(Some(&json!("dataflow"))), "data flow");
        assert_eq!(type_word(Some(&json!("erd"))), "ERD");
        assert_eq!(type_word(Some(&json!("sequence"))), "sequence");
        assert_eq!(type_word(None), "undefined");
    }
}
