//! Times as canopy reads them (`src/core/cron.ts`): cron lines for the
//! ranger's wakes, the part a wake read back off disk needs (a line read
//! into its sets, `parseCron`; the `@` words written out, `expandCron`;
//! whether a line reads, `isCron`), and a one-shot time as typed
//! (`parseWhen`), what a note's reminder and a wake are set by, and the
//! time a command line starts with (`leadingWhen`). When a line next fires
//! (`nextFire`) and `lastClock` are not ported yet.
//!
//! The sets keep the order the line names their values in, as a
//! JavaScript `Set` does. Local time is the zone `TZ` names, else the
//! system's, as Bun reads it. A local time the clock skips (a
//! spring-forward gap) or shows twice (the fall-back hour) resolves as
//! JavaScript's `Date` resolves it, which is jiff's "compatible" rule: the
//! later reading for a gap, the earlier for a fold.

use crate::pathx::{JS_S, js_len, js_trim, js_ws};
use jiff::civil::{Date, DateTime};
use jiff::tz::{Offset, TimeZone};
use jiff::{Span, Timestamp};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

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

/// `IN`: `in 30m`, `in 2 hours`, `in 1 day`. The `i` flag folds ASCII only,
/// as a JavaScript regex without `u` does.
static IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^(?i-u:in){JS_S}+([0-9]{{1,4}}){JS_S}*(?i-u:(m|min|mins|minutes?|h|hrs?|hours?|d|days?))$"
    ))
    .expect("IN")
});

/// `CLOCK`: `14:00` or `at 14:00`.
static CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^(?:(?i-u:at){JS_S}+)?([01]?[0-9]|2[0-3]):([0-5][0-9])$"
    ))
    .expect("CLOCK")
});

/// `ISO_WHEN`: a date and a time as `leadingWhen` takes them, its offset
/// optional.
static ISO_WHEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?$").unwrap()
});

/// `leadingWhen()`: the time a command line starts with, in a form the
/// server reads, and the words after it. `in 30m`, `at 14:00` and
/// `2026-10-11 09:00` run to more than one word unquoted, so the longest
/// run of up to three leading words that has a time's shape wins.
pub fn leading_when(words: &[String]) -> Option<(String, Vec<String>)> {
    for n in (1..=words.len().min(3)).rev() {
        let when = words[..n].join(" ");
        if IN.is_match(&when) || CLOCK.is_match(&when) || ISO_WHEN.is_match(&when) {
            return Some((when, words[n..].to_vec()));
        }
    }
    None
}

/// What `parseWhen` hands to `new Date()`: a date and a time at the front.
static ISO_FRONT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}").expect("ISO"));

/// The date-time form Bun's `Date` parses (JavaScriptCore's ES5 parser):
/// seconds and a fraction of any length optional, then `Z` or an offset
/// with or without its colon, or nothing for local time. A `T` of either
/// case, as only the parser sees it.
static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        "^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?$",
    )
    .expect("ISO_DATE")
});

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 3_600_000.0;
const DAY: f64 = 86_400_000.0;

fn ms(z: &jiff::ZonedDateTime) -> f64 {
    z.timestamp().as_millisecond() as f64
}

/// A local wall time in `tz` as unix ms, by JavaScript's rule for a gap
/// and a fold.
fn local_ms(dt: DateTime, tz: &TimeZone) -> Option<f64> {
    dt.to_zoned_datetime(tz.clone()).ok().map(|z| ms(&z))
}

/// `new Date(text).getTime()` for the date-time form, in `tz` when it names
/// no zone: None where Bun's answer is NaN. A day past the month's end runs
/// into the next month (`2026-02-30` is March 2) and `24:00` is the next
/// day's midnight, as JavaScriptCore reads them.
pub fn parse_date_time(text: &str, tz: &TimeZone) -> Option<f64> {
    let c = ISO_DATE.captures(text)?;
    let num = |i: usize| -> i64 { c.get(i).map_or(0, |m| m.as_str().parse().unwrap_or(0)) };
    let (year, month, day, hour, minute, second) = (num(1), num(2), num(3), num(4), num(5), num(6));
    let fraction = c.get(7).map_or("", |m| m.as_str());
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if minute > 59 || second > 59 || hour > 24 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || fraction.bytes().any(|b| b != b'0')) {
        return None;
    }
    // the fraction to whole milliseconds, cut, not rounded
    let milli: i32 = format!("{fraction:0<3}")[..3].parse().unwrap_or(0);
    let first = Date::new(year as i16, month as i8, 1).ok()?;
    let date = first.checked_add(Span::new().days(day - 1)).ok()?;
    let (date, hour) = if hour == 24 {
        (date.tomorrow().ok()?, 0)
    } else {
        (date, hour)
    };
    let dt = date.at(hour as i8, minute as i8, second as i8, milli * 1_000_000);
    let zone = match c.get(8).map(|m| m.as_str()) {
        None => return local_ms(dt, tz),
        Some("Z" | "z") => TimeZone::UTC,
        Some(off) => {
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let digits: String = off[1..].chars().filter(char::is_ascii_digit).collect();
            let (h, m): (i32, i32) = (digits[..2].parse().ok()?, digits[2..].parse().ok()?);
            if h > 23 || m > 59 {
                return None;
            }
            TimeZone::fixed(Offset::from_seconds(sign * (h * 3600 + m * 60)).ok()?)
        }
    };
    local_ms(dt, &zone)
}

/// `parseWhen()` in the zone `TZ` names, else the system's.
pub fn parse_when(text: &str, now: f64) -> Result<f64, String> {
    parse_when_in(text, now, &TimeZone::system())
}

/// `parseWhen()`: a one-shot time as typed, `in 30m`, `in 2h`, `in 1d`,
/// `14:00` or `at 14:00` (the next time the clock shows it, today or
/// tomorrow), or an ISO date and time. Unix ms, or why it cannot be read.
/// A time that is not in the future is refused.
pub fn parse_when_in(text: &str, now: f64, tz: &TimeZone) -> Result<f64, String> {
    let t = crate::pathx::js_trim(text);
    if let Some(rel) = IN.captures(t) {
        let n: f64 = rel[1].parse().unwrap_or(0.0);
        let unit = rel[2].to_ascii_lowercase();
        let ms = match unit.as_bytes().first() {
            Some(b'd') => DAY,
            Some(b'h') => HOUR,
            _ => MINUTE,
        };
        if n < 1.0 {
            return Err("a wake is at least a minute away".into());
        }
        return Ok(now + n * ms);
    }
    if let Some(clock) = CLOCK.captures(t) {
        let (h, m): (i8, i8) = (clock[1].parse().unwrap_or(0), clock[2].parse().unwrap_or(0));
        let not = || format!("\"{t}\" is not a date and time");
        let today = Timestamp::from_millisecond(now as i64)
            .map_err(|_| not())?
            .to_zoned_datetime(tz.clone());
        let set = today.date().at(h, m, 0, 0);
        let at = local_ms(set, tz).ok_or_else(not)?;
        if at > now {
            return Ok(at);
        }
        // `setDate(getDate() + 1)`: the next day at the wall time `setHours`
        // landed on, which a gap may have moved
        let landed = Timestamp::from_millisecond(at as i64)
            .map_err(|_| not())?
            .to_zoned_datetime(tz.clone())
            .datetime();
        let next = landed.checked_add(Span::new().days(1)).map_err(|_| not())?;
        return local_ms(next, tz).ok_or_else(not);
    }
    if ISO_FRONT.is_match(t) {
        let Some(at) = parse_date_time(&t.replacen(' ', "T", 1), tz) else {
            return Err(format!("\"{t}\" is not a date and time"));
        };
        if at <= now {
            return Err(format!("{t} has already passed"));
        }
        return Ok(at);
    }
    Err(format!(
        "\"{t}\" is not a time: try \"in 30m\", \"14:00\" or an ISO date and time"
    ))
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

    /// `new Date("<iso>Z").getTime()`: the TS tests read local time as UTC
    fn at(iso: &str) -> f64 {
        parse_date_time(&format!("{iso}Z"), &TimeZone::UTC).unwrap()
    }

    fn iso(ms: f64) -> String {
        Timestamp::from_millisecond(ms as i64)
            .unwrap()
            .to_string()
            .chars()
            .take(16)
            .collect()
    }

    const UTC: TimeZone = TimeZone::UTC;

    #[test]
    fn in_so_long() {
        let now = at("2026-10-10T08:30");
        assert_eq!(
            parse_when_in("in 30m", now, &UTC),
            Ok(now + 30.0 * 60_000.0)
        );
        assert_eq!(
            parse_when_in("in 2h", now, &UTC),
            Ok(now + 2.0 * 3_600_000.0)
        );
        assert_eq!(parse_when_in("in 1 day", now, &UTC), Ok(now + 86_400_000.0));
        assert!(parse_when_in("in 0m", now, &UTC).is_err());
    }

    #[test]
    fn a_clock_time_is_the_next_one_today_or_tomorrow() {
        let now = at("2026-10-10T08:30");
        assert_eq!(
            iso(parse_when_in("14:00", now, &UTC).unwrap()),
            "2026-10-10T14:00"
        );
        assert_eq!(
            iso(parse_when_in("at 8:15", now, &UTC).unwrap()),
            "2026-10-11T08:15"
        );
    }

    #[test]
    fn an_iso_time_never_one_already_gone() {
        let now = at("2026-10-10T08:30");
        assert_eq!(
            parse_when_in("2026-10-11T09:00", now, &UTC),
            Ok(parse_date_time("2026-10-11T09:00", &UTC).unwrap())
        );
        assert!(parse_when_in("2026-10-09 09:00", now, &UTC).is_err());
        assert!(parse_when_in("tomorrow", now, &UTC).is_err());
    }

    #[test]
    fn the_words_of_a_refusal_are_the_typescripts() {
        let now = at("2026-10-10T08:30");
        assert_eq!(
            parse_when_in(" someday ", now, &UTC),
            Err(
                "\"someday\" is not a time: try \"in 30m\", \"14:00\" or an ISO date and time"
                    .into()
            )
        );
        assert_eq!(
            parse_when_in("2026-10-09 09:00", now, &UTC),
            Err("2026-10-09 09:00 has already passed".into())
        );
        assert_eq!(
            parse_when_in("2026-13-01 09:00", now, &UTC),
            Err("\"2026-13-01 09:00\" is not a date and time".into())
        );
        assert_eq!(
            parse_when_in("in 0 days", now, &UTC),
            Err("a wake is at least a minute away".into())
        );
        // ASCII case only: a long s is not an s
        assert!(parse_when_in("IN 5 MINS", now, &UTC).is_ok());
        assert!(parse_when_in("in 5 min\u{17f}", now, &UTC).is_err());
        assert!(parse_when_in("in\u{a0}5m", now, &UTC).is_ok());
    }

    /// What Bun 1.3 answered for each in America/Los_Angeles, NaN as None.
    #[test]
    fn a_date_and_time_reads_as_bun_reads_it() {
        let la = TimeZone::posix("PST8PDT,M3.2.0,M11.1.0").unwrap();
        let cases: &[(&str, Option<f64>)] = &[
            ("2026-10-11T09:00", Some(1791734400000.0)),
            ("2026-10-11T09:00:30.5", Some(1791734430500.0)),
            ("2026-10-11T09:00:30.123456", Some(1791734430123.0)),
            ("2026-10-11T09:00Z", Some(1791709200000.0)),
            ("2026-10-11T09:00z", Some(1791709200000.0)),
            ("2026-10-11T09:00+02:00", Some(1791702000000.0)),
            ("2026-10-11T09:00+0200", Some(1791702000000.0)),
            ("2026-10-11T09:00-00:00", Some(1791709200000.0)),
            ("2026-10-11T09:00:00+23:59", Some(1791622860000.0)),
            ("2026-10-11T09:00:00.5+01:30", Some(1791703800500.0)),
            ("2026-10-11T24:00", Some(1791788400000.0)),
            ("2026-10-11T24:00:00.0", Some(1791788400000.0)),
            ("2026-02-30T09:00", Some(1772470800000.0)),
            ("2026-04-31T09:00", Some(1777651200000.0)),
            ("2026-10-11T23:59:59.9999", Some(1791788399999.0)),
            ("2026-03-08T02:30", Some(1772965800000.0)),
            ("2026-11-01T01:30", Some(1793521800000.0)),
            ("2026-10-11t09:00", Some(1791734400000.0)),
            ("2026-10-11T09:00-05", None),
            ("2026-10-11T09:00+02", None),
            ("2026-10-11T09:00+2:00", None),
            ("2026-10-11T09:00+23:60", None),
            ("2026-10-11T09:00:00+24:00", None),
            ("2026-10-11T25:00", None),
            ("2026-10-11T24:00:01", None),
            ("2026-10-11T24:00:00.0001", None),
            ("2026-13-01T09:00", None),
            ("2026-00-11T09:00", None),
            ("2026-10-00T09:00", None),
            ("2026-10-32T09:00", None),
            ("2026-10-11T09:60", None),
            ("2026-10-11T09:00:60", None),
            ("2026-10-11T09:00:5", None),
            ("2026-10-11T09:00:00.", None),
            ("2026-10-11T09:00.5", None),
            ("2026-10-11T09:00 extra", None),
            ("2026-10-11T09:00:00 GMT", None),
            ("2026-10-11T09:00:00+02:00Z", None),
        ];
        for (text, want) in cases {
            assert_eq!(parse_date_time(text, &la), *want, "{text}");
        }
    }

    /// Bun's answers in America/Los_Angeles around both changes of 2026: a
    /// 02:30 the clock skips reads as 03:30, and the next day keeps the wall
    /// time `setHours` landed on; a 01:30 it shows twice is the first one.
    #[test]
    fn a_clock_time_across_a_clock_change_lands_where_set_hours_lands() {
        let la = TimeZone::posix("PST8PDT,M3.2.0,M11.1.0").unwrap();
        let cases = [
            ("2026-03-08T04:00", "02:30", 1773052200000.0),
            ("2026-03-08T01:00", "02:30", 1772965800000.0),
            ("2026-03-07T03:00", "02:30", 1772965800000.0),
            ("2026-10-31T02:00", "01:30", 1793521800000.0),
            ("2026-11-01T01:45", "01:30", 1793611800000.0),
        ];
        for (now, text, want) in cases {
            let now_ms = parse_date_time(now, &la).unwrap();
            assert_eq!(parse_when_in(text, now_ms, &la), Ok(want), "{now} {text}");
        }
    }
}
