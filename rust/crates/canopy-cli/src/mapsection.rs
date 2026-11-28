//! What the map section's four verbs (`floorplan`, `archify`, `diagnosis`,
//! `understand`) share: the target and repo pickers from run.rs
//! (`selectedTarget` and `repoId` in src/cli/run.ts), `ageWord` from
//! worktrees.rs, `Date.parse` for the ISO times the routes send, the line a
//! start prints, and a page saved beside the CLI.

use canopy_core::js::field;
use canopy_core::pathx::resolve_from;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::Value;
use std::time::Duration;

pub(crate) use crate::run::{here, repo_id, selected_target};

/// The clock a verb reads and whether it naps: `Date.now()` and
/// `Bun.sleep()` for real, a counter and no naps in a test.
pub(crate) struct Clock<'a> {
    pub now: &'a dyn Fn() -> f64,
    pub naps: bool,
}

impl Clock<'_> {
    /// `Date.now()`.
    pub fn now(&self) -> f64 {
        (self.now)()
    }

    /// `await Bun.sleep(ms)`.
    pub async fn nap(&self, ms: u64) {
        if self.naps {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }
}

#[cfg(test)]
const MINUTE: f64 = 60_000.0;
#[cfg(test)]
const HOUR: f64 = 60.0 * MINUTE;

pub(crate) use crate::worktrees::age_word;

/// The verbs' `ago` for a unix-ms time: "3h ago", or "just now".
pub(crate) fn ago_ms(now: f64, ms: f64) -> String {
    format!("{} ago", age_word(now - ms)).replacen("now ago", "just now", 1)
}

/// The verbs' `ago` for an ISO time; a time that does not parse stays as
/// it is.
pub(crate) fn ago_iso(now: f64, iso: &str) -> String {
    let t = date_parse(iso);
    if t.is_nan() {
        iso.to_string()
    } else {
        ago_ms(now, t)
    }
}

/// `Date.parse(s)` in the system's zone.
pub(crate) fn date_parse(s: &str) -> f64 {
    date_parse_in(s, &TimeZone::system())
}

/// `Date.parse(s)` for ECMAScript's date-time strings, as Bun's engine
/// reads them: `YYYY[-MM[-DD]]` or `±YYYYYY…`, then `T`, `t` or a space and
/// `HH:mm[:ss[.fff…]]`, then `Z`, `z` or `±HH[:]mm`. A date alone is UTC
/// and a date with a time and no offset is local; a day past its month's
/// end rolls over and 24:00 is the next midnight. NaN for anything else,
/// where the engine would try its legacy formats ("Nov 20 2026"), which
/// the routes never send.
pub(crate) fn date_parse_in(s: &str, tz: &TimeZone) -> f64 {
    iso_ms(s, tz).map_or(f64::NAN, |ms| ms as f64)
}

/// Exactly `n` ASCII digits at `*i`, as a number.
fn digits(b: &[u8], i: &mut usize, n: usize) -> Option<i64> {
    let run = b.get(*i..*i + n)?;
    if !run.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *i += n;
    Some(run.iter().fold(0, |a, d| a * 10 + i64::from(d - b'0')))
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn iso_ms(s: &str, tz: &TimeZone) -> Option<i64> {
    let b = s.as_bytes();
    let mut i = 0;
    let year = match b.first()? {
        sign @ (b'+' | b'-') => {
            i = 1;
            let y = digits(b, &mut i, 6)?;
            match sign {
                // -000000 is not a year
                b'-' if y == 0 => return None,
                b'-' => -y,
                _ => y,
            }
        }
        _ => digits(b, &mut i, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if b.get(i) == Some(&b'-') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
        i += 1;
        month = digits(b, &mut i, 2)?;
        if b.get(i) == Some(&b'-') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
            i += 1;
            day = digits(b, &mut i, 2)?;
        }
    }
    let mut time = None;
    if matches!(b.get(i), Some(b'T' | b't' | b' ')) {
        i += 1;
        let h = digits(b, &mut i, 2)?;
        if b.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        let m = digits(b, &mut i, 2)?;
        let (mut sec, mut ms) = (0, 0);
        if b.get(i) == Some(&b':') {
            i += 1;
            sec = digits(b, &mut i, 2)?;
            if b.get(i) == Some(&b'.') {
                i += 1;
                let start = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
                // whole milliseconds, the rest cut off
                let frac = format!("{:0<3}", &s[start..i.min(start + 3)]);
                ms = frac.parse().ok()?;
            }
        }
        time = Some((h, m, sec, ms));
    }
    let mut offset = None;
    match b.get(i) {
        Some(b'Z' | b'z') => {
            i += 1;
            offset = Some(0);
        }
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            i += 1;
            let oh = digits(b, &mut i, 2)?;
            if b.get(i) == Some(&b':') {
                i += 1;
            }
            let om = digits(b, &mut i, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            offset = Some(sign * (oh * 60 + om));
        }
        _ => {}
    }
    if i != b.len() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (h, m, sec, ms) = time.unwrap_or((0, 0, 0, 0));
    if h > 24 || m > 59 || sec > 59 || (h == 24 && (m, sec, ms) != (0, 0, 0)) {
        return None;
    }
    let wall = (days_from_civil(year, month, 1) + day - 1) * 86_400_000
        + h * 3_600_000
        + m * 60_000
        + sec * 1000
        + ms;
    let t = match (offset, time) {
        (Some(off), _) => wall - off * 60_000,
        (None, None) => wall,
        (None, Some(_)) => {
            let dt = Timestamp::from_millisecond(wall)
                .ok()?
                .to_zoned_datetime(TimeZone::UTC)
                .datetime();
            tz.to_ambiguous_timestamp(dt)
                .compatible()
                .ok()?
                .as_millisecond()
        }
    };
    (t.abs() <= 8_640_000_000_000_000).then_some(t)
}

/// What a start prints: the run's id and verb and how to follow it.
pub(crate) fn started_line(run: &Value) -> String {
    format!(
        "started run {} ({}). Follow it with canopy run show {}; its questions wait in the page.",
        field(run, "id"),
        field(run, "verb"),
        field(run, "id")
    )
}

pub(crate) use canopy_core::js::pretty;

/// `existsSync(file)`, read against the CLI's folder. An empty name is
/// never there.
pub(crate) fn is_there(cwd: &str, file: &str) -> bool {
    !file.is_empty() && std::path::Path::new(&resolve_from(cwd, file)).exists()
}

/// `Bun.write(file, text)`, read against the CLI's folder, its folders
/// made first as Bun makes them.
pub(crate) fn write_page(cwd: &str, file: &str, text: &str) -> Result<(), String> {
    let path = resolve_from(cwd, file);
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Caller;
    use crate::ask::tests::Stub;
    use crate::ask::{AskError, Client, Target};

    #[test]
    fn age_words_and_ago() {
        assert_eq!(age_word(59_999.0), "now");
        assert_eq!(age_word(-5.0), "now");
        assert_eq!(age_word(5.0 * MINUTE), "5m");
        assert_eq!(age_word(3.0 * HOUR + 1.0), "3h");
        assert_eq!(age_word(49.0 * HOUR), "2d");
        assert_eq!(age_word(f64::NAN), "NaNd");
        assert_eq!(ago_ms(10_000.0, 0.0), "just now");
        assert_eq!(ago_ms(3.0 * HOUR, 0.0), "3h ago");
        let now = 1_795_176_000_000.0; // 2026-11-20T12:00:00Z
        assert_eq!(ago_iso(now, "2026-11-20T09:00:00.000Z"), "3h ago");
        assert_eq!(ago_iso(now, "yesterday-ish"), "yesterday-ish");
    }

    #[test]
    fn date_parse_reads_what_bun_reads() {
        let la = TimeZone::fixed(jiff::tz::offset(-8));
        let p = |s: &str| date_parse_in(s, &la);
        // each value is what Bun printed for Date.parse on a Mac in Los Angeles
        for (s, want) in [
            ("2026-11-20T09:00:00.000Z", 1_795_165_200_000_i64),
            ("2026-11-20", 1_795_132_800_000),
            ("2026-11-20T09:00", 1_795_194_000_000),
            ("2026-11-20 09:00:00", 1_795_194_000_000),
            ("2026-11-20t09:00", 1_795_194_000_000),
            ("2026-11-20T09:00:00+01:00", 1_795_161_600_000),
            ("2026-11-20T09:00:00.000+0100", 1_795_161_600_000),
            ("2026-11-20T09:00:00-08:00", 1_795_194_000_000),
            ("2026-11-20T09:00:00+23:59", 1_795_078_860_000),
            ("2026-11-20T09:00:00.1234Z", 1_795_165_200_123),
            ("2026-11-20T09:00:00.5Z", 1_795_165_200_500),
            ("2026-11-20T09:00Z", 1_795_165_200_000),
            ("2026-11-20 09:00Z", 1_795_165_200_000),
            ("2026-11-20T09:00:00z", 1_795_165_200_000),
            ("2026-11-20Z", 1_795_132_800_000),
            ("+002026-11-20T09:00:00Z", 1_795_165_200_000),
            ("-000001-01-01T00:00:00Z", -62_198_755_200_000),
            ("2026", 1_767_225_600_000),
            ("2026-11", 1_793_491_200_000),
            ("2026-02-30T00:00:00Z", 1_772_409_600_000),
            ("2026-11-31", 1_796_083_200_000),
            ("2026-11-20T24:00:00Z", 1_795_219_200_000),
            ("2026-11-20T23:59:59.999Z", 1_795_219_199_999),
            ("1970-01-01", 0),
            ("+275760-09-13T00:00:00Z", 8_640_000_000_000_000),
        ] {
            assert_eq!(p(s), want as f64, "{s}");
        }
        for s in [
            "garbage",
            "2026-11-20T9:00:00Z",
            "2026-11-20T09:00:60Z",
            "2026-13-01",
            "2026-11-32",
            "2026-00-10",
            "2026-11-00",
            "2026-11-20T24:30:00Z",
            "2026-11-20T24:00:00.001Z",
            "2026-11-20T09:60:00Z",
            "2026-11-20T09:00:00+24:00",
            "2026-11-20T09:00:00+01:60",
            "2026-11-20T09:00:00+01",
            "2026-11-20T09:00:00+1:00",
            "2026-11-20T09:00:00.Z",
            "2026-11-20T09:00:00.",
            "2026-11-20T09:00:00Z ",
            "2026-11-20T",
            "2026-11-20T09",
            "20261120",
            "-000000-01-01T00:00:00Z",
            "+275760-09-13T00:00:00.001Z",
            "275760-09-13",
            "2026-11-20T09:00:00.000Zjunk",
            "",
        ] {
            assert!(p(s).is_nan(), "{s}");
        }
    }

    #[tokio::test]
    async fn a_page_comes_as_text_within_its_own_timeout() {
        let stub = Stub::start(|s| match s.path.as_str() {
            "/page" => (200, vec![], "<html>hi</html>".into()),
            "/gone" => (404, vec![], "{\"error\": \"there is no diagram x\"}".into()),
            _ => (
                403,
                vec![],
                "{\"error\": \"no\", \"need\": \"read\"}".into(),
            ),
        })
        .await;
        let caller = Caller::default();
        let t = Target::home(&stub.url);
        let long = Duration::from_secs(60);
        assert_eq!(
            Client::new(caller.clone())
                .ask_text_within(&t, "/page", long)
                .await
                .unwrap(),
            "<html>hi</html>"
        );
        assert_eq!(
            Client::new(caller.clone())
                .ask_text_within(&t, "/gone", long)
                .await
                .unwrap_err(),
            AskError::Denied("there is no diagram x".into())
        );
        assert_eq!(
            Client::new(caller.clone())
                .ask_text_within(&t, "/x", long)
                .await
                .unwrap_err(),
            AskError::Denied("no".into())
        );
    }
}
