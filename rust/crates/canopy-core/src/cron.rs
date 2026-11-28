//! A one-shot time as typed (`parseWhen` in `src/core/cron.ts`): what a
//! note's reminder and a wake are set by. The cron lines, `nextFire`,
//! `leadingWhen` and `lastClock` are not ported yet.
//!
//! Local time is the zone `TZ` names, else the system's, as Bun reads it.
//! A local time the clock skips (a spring-forward gap) or shows twice (the
//! fall-back hour) resolves as JavaScript's `Date` resolves it, which is
//! jiff's "compatible" rule: the later reading for a gap, the earlier for a
//! fold.

use crate::pathx::JS_S;
use jiff::civil::{Date, DateTime};
use jiff::tz::{Offset, TimeZone};
use jiff::{Span, Timestamp};
use regex::Regex;
use std::sync::LazyLock;

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
