//! Cron lines for the ranger's wakes (`src/core/cron.ts`), the part a wake
//! read back off disk needs: a line read into its sets (`parseCron`), the
//! `@` words written out (`expandCron`) and whether a line reads (`isCron`).
//! When a line next fires, one-shot times and the clock-change rules are
//! not ported yet.
//!
//! The sets keep the order the line names their values in, as a
//! JavaScript `Set` does.

use crate::pathx::{js_len, js_trim, js_ws};
use serde_json::Value;

/// A cron line read into the values each field allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    pub minutes: Vec<u32>,
    pub hours: Vec<u32>,
    pub days: Vec<u32>,
    pub months: Vec<u32>,
    /// 0 is Sunday; a 7 in the line is read as 0
    pub weekdays: Vec<u32>,
    /// whether each day field was `*`, for the either-day rule
    pub any_day: bool,
    pub any_weekday: bool,
    /// whether the minute or hour field starts with `*`
    pub on_the_clock: bool,
}

/// `CRON_MAX`: the longest cron line taken.
pub const CRON_MAX: usize = 100;

const MACROS: [(&str, &str); 5] = [
    ("@hourly", "0 * * * *"),
    ("@daily", "0 0 * * *"),
    ("@midnight", "0 0 * * *"),
    ("@weekly", "0 0 * * 0"),
    ("@monthly", "0 0 1 * *"),
];

const FIELDS: [(&str, u32, u32); 5] = [
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day of month", 1, 31),
    ("month", 1, 12),
    ("day of week", 0, 7),
];

/// `/^\d{1,2}$/`
fn num(s: &str) -> Option<u32> {
    (matches!(s.len(), 1 | 2) && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

fn add(out: &mut Vec<u32>, v: u32) {
    if !out.contains(&v) {
        out.push(v);
    }
}

/// One field as the values it allows, or why it cannot be read. A part
/// split on `/` or `-` reads its first two pieces and drops the rest, as a
/// JavaScript destructuring does.
fn field(text: &str, lo: u32, hi: u32, name: &str) -> Result<Vec<u32>, String> {
    let mut out = vec![];
    for part in text.split(',') {
        let mut pieces = part.split('/');
        let range = pieces.next().unwrap_or("");
        let step_text = pieces.next();
        let mut step = 1;
        if let Some(st) = step_text {
            match num(st) {
                Some(n) if n >= 1 => step = n,
                _ => return Err(format!("the {name} step \"{st}\" is not a positive number")),
            }
        }
        let (from, to) = if range == "*" {
            (lo, hi)
        } else {
            let mut ends = range.split('-');
            let a = ends.next().unwrap_or("");
            let b = ends.next();
            let bad = || format!("the {name} \"{part}\" is not a number, a range or *");
            let from = num(a).ok_or_else(bad)?;
            let to = match b {
                Some(b) => num(b).ok_or_else(bad)?,
                None if step_text.is_none() => from,
                None => hi,
            };
            (from, to)
        };
        if from < lo || to > hi || from > to {
            return Err(format!("the {name} \"{part}\" is outside {lo}-{hi}"));
        }
        let mut v = from;
        while v <= to {
            add(&mut out, v);
            v += step;
        }
    }
    Ok(out)
}

/// `expandCron()`: a line with its `@` word written out as five fields; any
/// other line trimmed.
pub fn expand_cron(line: &str) -> String {
    let key = js_trim(line).to_lowercase();
    MACROS
        .iter()
        .find(|(k, _)| *k == key)
        .map_or_else(|| js_trim(line).to_string(), |(_, v)| v.to_string())
}

/// `parseCron()`: a cron line read into its sets, or why it cannot be read.
pub fn parse_cron(line: &str) -> Result<Cron, String> {
    let text = expand_cron(line);
    let parts: Vec<&str> = text.split(js_ws).collect();
    // `"".split(/\s+/)` is one empty part, as `split` gives here
    let parts: Vec<&str> = if text.is_empty() {
        vec![""]
    } else {
        squash(&parts)
    };
    if parts.len() != 5 {
        return Err(
            "a cron line has five fields: minute hour day-of-month month day-of-week".into(),
        );
    }
    let mut sets = vec![];
    for (i, (name, lo, hi)) in FIELDS.iter().enumerate() {
        sets.push(field(parts[i], *lo, *hi, name)?);
    }
    let mut weekdays = vec![];
    for d in &sets[4] {
        add(&mut weekdays, d % 7);
    }
    Ok(Cron {
        minutes: sets[0].clone(),
        hours: sets[1].clone(),
        days: sets[2].clone(),
        months: sets[3].clone(),
        weekdays,
        any_day: parts[2].starts_with('*'),
        any_weekday: parts[4].starts_with('*'),
        on_the_clock: parts[0].starts_with('*') || parts[1].starts_with('*'),
    })
}

/// A split on single whitespace characters joined into `/\s+/`'s runs: the
/// text is trimmed, so only the empty pieces between runs go.
fn squash<'a>(parts: &[&'a str]) -> Vec<&'a str> {
    parts.iter().copied().filter(|p| !p.is_empty()).collect()
}

/// `isCron()`: a string of at most `CRON_MAX` UTF-16 units that reads.
pub fn is_cron(line: &Value) -> bool {
    line.as_str()
        .is_some_and(|l| js_len(l) <= CRON_MAX && parse_cron(l).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cron(line: &str) -> Cron {
        parse_cron(line).unwrap_or_else(|e| panic!("{line}: {e}"))
    }

    #[test]
    fn reads_stars_lists_ranges_and_steps() {
        let c = cron("*/15 9-17 * * 1-5");
        assert_eq!(c.minutes, vec![0, 15, 30, 45]);
        assert_eq!(c.hours, vec![9, 10, 11, 12, 13, 14, 15, 16, 17]);
        assert_eq!(c.weekdays, vec![1, 2, 3, 4, 5]);
        assert!(c.any_day);
        assert!(!c.any_weekday);
        assert_eq!(cron("5,10 0 1 1,7 *").months, vec![1, 7]);
        // a step from a single value runs to the top of the field
        assert_eq!(cron("50/5 * * * *").minutes, vec![50, 55]);
    }

    #[test]
    fn a_line_that_names_a_member_every_object_has_is_a_line_that_does_not_read_not_a_crash() {
        for line in ["constructor", "__proto__", "toString", "hasOwnProperty"] {
            assert_eq!(
                parse_cron(line),
                Err(
                    "a cron line has five fields: minute hour day-of-month month day-of-week"
                        .into()
                )
            );
            assert!(!is_cron(&json!(line)));
            assert_eq!(expand_cron(line), line);
        }
    }

    /// The TypeScript test also reads the macros' next fires; `nextFire` is
    /// not ported, so this checks what they expand to.
    #[test]
    fn a_7_is_sunday_and_the_macros_expand() {
        assert_eq!(cron("0 0 * * 7").weekdays, vec![0]);
        assert_eq!(expand_cron(" @Daily "), "0 0 * * *");
        assert_eq!(expand_cron("@hourly"), "0 * * * *");
        assert_eq!(cron("@daily").hours, vec![0]);
    }

    #[test]
    fn refuses_what_is_not_a_cron_line() {
        for bad in [
            "",
            "* * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "* * * * 8",
            "a * * * *",
            "*/0 * * * *",
            "5-1 * * * *",
            "* * * * * *",
        ] {
            assert!(parse_cron(bad).is_err(), "{bad}");
            assert!(!is_cron(&json!(bad)), "{bad}");
        }
        assert!(is_cron(&json!("0 8 * * *")));
        assert!(!is_cron(&json!(42)));
    }

    #[test]
    fn a_part_reads_only_its_first_two_pieces_as_javascript_destructures_them() {
        assert_eq!(cron("1-2-9 * * * *").minutes, vec![1, 2]);
        assert_eq!(cron("0/30/7 * * * *").minutes, vec![0, 30]);
        assert_eq!(cron("0  8\t* * *").hours, vec![8]);
        assert!(!is_cron(&json!(format!("0 {}2 * * *", "1,".repeat(60)))));
    }
}
