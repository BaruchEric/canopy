//! The words and names of `src/core/diagnosis.ts` (FR-075), as `canopy
//! diagnosis` reads and prints them: where the analysis and its page live,
//! the languages and a run's pick, `languageWord`, `diagnosisFailure`,
//! `diagnosisLine`, `changesLine` and `othersLine`. Reading the overview
//! and the settings, the globs, the config, the receipt and the section's
//! head are not ported yet.

use crate::js::{template, truthy};
use serde_json::Value;

/// `DIAGNOSIS_FOLDER`: the analysis's folder under the checkout's
/// `.archify/`.
pub const DIAGNOSIS_FOLDER: &str = "diagnosis";

/// `DIAGNOSIS_PATH`: where the analysis lives, from the checkout's root
/// (`${ARCHIFY_FOLDER}/${DIAGNOSIS_FOLDER}`; a test holds the two equal).
pub const DIAGNOSIS_PATH: &str = ".archify/diagnosis";

/// `DIAGNOSIS_PAGE`: the analysis's page.
pub const DIAGNOSIS_PAGE: &str = "repo.analysis.html";

/// `DIAGNOSIS_LANGUAGES`: what Code Analysis reads, one per run.
pub const DIAGNOSIS_LANGUAGES: [&str; 7] = ["ts", "py", "java", "go", "rust", "c", "cpp"];

/// `isDiagnosisLanguage()`.
pub fn is_diagnosis_language(v: &str) -> bool {
    DIAGNOSIS_LANGUAGES.contains(&v)
}

/// `isDiagnosisPick()`: a run's language, one of the above or `auto`.
pub fn is_diagnosis_pick(v: &str) -> bool {
    v == "auto" || is_diagnosis_language(v)
}

/// `languageWord()`: a language as the page says it; a name canopy does
/// not know stays as it is.
pub fn language_word(language: Option<&Value>) -> String {
    let word = match language.and_then(Value::as_str) {
        Some("ts") => "JS/TS",
        Some("py") => "Python",
        Some("java") => "Java",
        Some("go") => "Go",
        Some("rust") => "Rust",
        Some("c") => "C",
        Some("cpp") => "C++",
        _ => return template(language),
    };
    word.into()
}

/// `diagnosisFailure()`: an older backend's bare 404 says what it means;
/// any other message stays as it is.
pub fn diagnosis_failure(message: &str) -> String {
    if message == "not found" {
        "this backend runs a canopy from before the Architecture Diagnosis; deploy the current one to it and try again".into()
    } else {
        message.into()
    }
}

/// `n.toLocaleString("en-US")`: thousands grouped with commas, at most
/// three fraction digits, the shortest decimal rounded half away from
/// zero as ICU rounds it.
pub fn locale_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    if x.is_infinite() {
        return format!("{sign}∞");
    }
    // the shortest digits that read back as x, and where the point goes
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let point = exp.parse::<i64>().unwrap_or(0) + 1;
    let (mut whole, frac) = if point <= 0 {
        (
            "0".to_string(),
            format!("{}{digits}", "0".repeat(point.unsigned_abs() as usize)),
        )
    } else if point as usize >= digits.len() {
        (
            format!("{digits}{}", "0".repeat(point as usize - digits.len())),
            String::new(),
        )
    } else {
        let (w, f) = digits.split_at(point as usize);
        (w.to_string(), f.to_string())
    };
    let mut kept = frac.chars().take(3).collect::<String>();
    if frac.as_bytes().get(3).is_some_and(|d| *d >= b'5') {
        // one more in the last kept place, carried through the whole part
        let mut all: Vec<u8> = format!("{whole}{kept}").into_bytes();
        let mut i = all.len();
        loop {
            if i == 0 {
                all.insert(0, b'1');
                break;
            }
            i -= 1;
            if all[i] == b'9' {
                all[i] = b'0';
            } else {
                all[i] += 1;
                break;
            }
        }
        let s = String::from_utf8(all).unwrap_or_default();
        let (w, f) = s.split_at(s.len() - kept.len());
        (whole, kept) = (w.to_string(), f.to_string());
    }
    let kept = kept.trim_end_matches('0');
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    if kept.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{kept}")
    }
}

/// `plural(n, one)`, the count as en-US writes it.
fn plural(n: Option<&Value>, one: &str) -> String {
    let count = match n.and_then(Value::as_f64) {
        Some(x) => locale_number(x),
        None => template(n),
    };
    if n.and_then(Value::as_f64) == Some(1.0) {
        format!("{count} {one}")
    } else {
        format!("{count} {one}s")
    }
}

/// `v !== null`: a missing field is undefined, which is not null.
fn not_null(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Null))
}

/// `diagnosisLine(info, ago)`: one line for a checkout's diagnosis. `ago`
/// words a unix-ms time; a missing one is NaN.
pub fn diagnosis_line(info: &Value, ago: impl Fn(f64) -> String) -> String {
    let report = info.get("report");
    let Some(r) = report.filter(|r| truthy(Some(r))) else {
        return if not_null(info.get("running")) {
            "analyzing the code…".into()
        } else {
            "no diagnosis yet".into()
        };
    };
    let when = format!(
        "analyzed {}",
        ago(crate::js::num_at(r, "builtAt").unwrap_or(f64::NAN))
    );
    let Some(f) = r.get("facts").filter(|f| truthy(Some(f))) else {
        return format!("{when}; its summary cannot be read");
    };
    let findings = f.get("findings");
    let what = if findings.and_then(Value::as_f64) == Some(0.0) {
        "nothing found".to_string()
    } else {
        let errors = f.get("errors");
        let errs = if truthy(errors) {
            format!(" ({})", plural(errors, "error"))
        } else {
            String::new()
        };
        format!("{}{errs}", plural(findings, "finding"))
    };
    let language = f.get("language");
    let of = if truthy(language) {
        format!(" of {}", language_word(language))
    } else {
        String::new()
    };
    format!("{what} in {}{of}, {when}", plural(f.get("files"), "file"))
}

/// `changesLine()`: how this analysis differs from the last, in a line;
/// None for a first one.
pub fn changes_line(changes: Option<&Value>) -> Option<String> {
    let c = changes.filter(|c| truthy(Some(c)))?;
    if !truthy(c.get("comparable")) {
        return Some("not comparable with the analysis before: the config, the rules or the files read changed".into());
    }
    let parts: Vec<String> = [
        ("added", "new"),
        ("gone", "no longer detected"),
        ("changed", "with changed code"),
    ]
    .iter()
    .filter(|(k, _)| truthy(c.get(*k)))
    .map(|(k, words)| format!("{} {words}", template(c.get(*k))))
    .collect();
    Some(if parts.is_empty() {
        "no change since the analysis before".into()
    } else {
        format!("since the analysis before: {}", parts.join(", "))
    })
}

/// `othersLine()`: the languages a run left out, in a line; None when it
/// read them all.
pub fn others_line(others: &[Value]) -> Option<String> {
    if others.is_empty() {
        return None;
    }
    let each: Vec<String> = others
        .iter()
        .map(|o| {
            format!(
                "{} of {}",
                plural(o.get("files"), "file"),
                language_word(o.get("language"))
            )
        })
        .collect();
    Some(format!("not read in this run: {}", each.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archify::ARCHIFY_FOLDER;
    use serde_json::json;

    fn facts() -> Value {
        json!({
            "language": "ts", "files": 263, "findings": 270, "errors": 2, "warnings": 104,
            "leads": [
                {"code": "coupling/cycle", "severity": "error", "message": "2 modules depend on each other at package level: src → src/components → src.", "where": "src/App.tsx:1"},
                {"code": "complexity/function", "severity": "warning", "message": "handleApi has cyclomatic complexity 982.", "where": null},
            ],
            "others": [{"language": "py", "files": 26}],
            "changes": {"comparable": true, "added": 1, "gone": 2, "changed": 1},
        })
    }

    fn with(mut v: Value, more: Value) -> Value {
        for (k, x) in more.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    #[test]
    fn the_path_is_the_archify_folder_and_the_diagnosis_folder() {
        assert_eq!(
            DIAGNOSIS_PATH,
            format!("{ARCHIFY_FOLDER}/{DIAGNOSIS_FOLDER}")
        );
    }

    #[test]
    fn a_line_says_what_was_found_in_what_and_when() {
        let ago = |_: f64| "3h ago".to_string();
        let report = |facts: Value| json!({"report": {"builtAt": 1, "bytes": 9, "facts": facts}, "running": null});
        assert_eq!(
            diagnosis_line(&json!({"report": null, "running": null}), ago),
            "no diagnosis yet"
        );
        assert_eq!(
            diagnosis_line(&json!({"report": null, "running": 5}), ago),
            "analyzing the code…"
        );
        assert_eq!(
            diagnosis_line(&report(facts()), ago),
            "270 findings (2 errors) in 263 files of JS/TS, analyzed 3h ago"
        );
        assert_eq!(
            diagnosis_line(
                &report(with(
                    facts(),
                    json!({"findings": 1, "errors": 0, "files": 1204, "language": null})
                )),
                ago
            ),
            "1 finding in 1,204 files, analyzed 3h ago"
        );
        assert_eq!(
            diagnosis_line(
                &report(with(facts(), json!({"findings": 0, "errors": 0}))),
                ago
            ),
            "nothing found in 263 files of JS/TS, analyzed 3h ago"
        );
        assert_eq!(
            diagnosis_line(&report(Value::Null), ago),
            "analyzed 3h ago; its summary cannot be read"
        );
    }

    #[test]
    fn changes_languages_left_out_and_language_names() {
        assert_eq!(changes_line(None), None);
        assert_eq!(changes_line(Some(&Value::Null)), None);
        assert_eq!(
            changes_line(Some(
                &json!({"comparable": true, "added": 1, "gone": 2, "changed": 1})
            ))
            .as_deref(),
            Some("since the analysis before: 1 new, 2 no longer detected, 1 with changed code")
        );
        assert_eq!(
            changes_line(Some(
                &json!({"comparable": true, "added": 0, "gone": 0, "changed": 0})
            ))
            .as_deref(),
            Some("no change since the analysis before")
        );
        assert!(
            changes_line(Some(
                &json!({"comparable": false, "added": 4, "gone": 0, "changed": 0})
            ))
            .unwrap()
            .contains("not comparable")
        );
        assert_eq!(others_line(&[]), None);
        assert_eq!(
            others_line(&[
                json!({"language": "py", "files": 26}),
                json!({"language": "rust", "files": 1})
            ])
            .as_deref(),
            Some("not read in this run: 26 files of Python, 1 file of Rust")
        );
        assert_eq!(language_word(Some(&json!("cpp"))), "C++");
        assert_eq!(language_word(Some(&json!("zig"))), "zig");
        assert!(is_diagnosis_pick("auto"));
        assert!(is_diagnosis_pick("ts"));
        assert!(!is_diagnosis_pick("js"));
    }

    #[test]
    fn an_older_backends_404_says_what_it_means_and_any_other_failure_stays() {
        assert!(diagnosis_failure("not found").contains("from before the Architecture Diagnosis"));
        assert_eq!(
            diagnosis_failure("an analysis is going on this checkout already"),
            "an analysis is going on this checkout already"
        );
    }

    #[test]
    fn counts_read_as_en_us_writes_them() {
        assert_eq!(locale_number(0.0), "0");
        assert_eq!(locale_number(-0.0), "-0");
        assert_eq!(locale_number(999.0), "999");
        assert_eq!(locale_number(1204.0), "1,204");
        assert_eq!(locale_number(-1234.0), "-1,234");
        assert_eq!(locale_number(1_234_567.891), "1,234,567.891");
        assert_eq!(locale_number(0.0005), "0.001");
        assert_eq!(locale_number(1.0005), "1.001");
        assert_eq!(locale_number(0.9996), "1");
        assert_eq!(locale_number(999.9999), "1,000");
        assert_eq!(locale_number(2.5e21), "2,500,000,000,000,000,000,000");
        assert_eq!(locale_number(f64::NAN), "NaN");
        assert_eq!(locale_number(f64::INFINITY), "∞");
    }
}
