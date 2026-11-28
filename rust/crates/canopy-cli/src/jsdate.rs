//! `new Date(ms).toLocaleString()` as Bun prints it. Bun formats in en-US
//! whatever LANG says ("11/27/2025, 7:20:00 PM", plain spaces), in the zone
//! TZ names, else the system's. Also `toISOString()`, which is UTC.

use jiff::Timestamp;
use jiff::tz::TimeZone;

/// `new Date(ms).toLocaleString()` in the system's zone.
pub fn locale_string(ms: f64) -> String {
    locale_string_in(ms, &TimeZone::system())
}

/// The same in a given zone. A time JavaScript cannot hold reads "Invalid
/// Date", as Bun prints it.
pub fn locale_string_in(ms: f64, tz: &TimeZone) -> String {
    if !ms.is_finite() {
        return "Invalid Date".into();
    }
    // a Date keeps whole milliseconds, truncated toward zero
    let Ok(ts) = Timestamp::from_millisecond(ms.trunc() as i64) else {
        return "Invalid Date".into();
    };
    let z = ts.to_zoned_datetime(tz.clone());
    let hour = z.hour();
    let (h12, half) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!(
        "{}/{}/{}, {}:{:02}:{:02} {}",
        z.month(),
        z.day(),
        z.year(),
        h12,
        z.minute(),
        z.second(),
        half
    )
}

/// `new Date(ms).toISOString()`: UTC to the millisecond with a `Z`, a year
/// before 0 or after 9999 as six digits with its sign. None where
/// JavaScript throws, for a time a Date cannot hold.
pub fn iso_string(ms: f64) -> Option<String> {
    // a Date keeps whole milliseconds, truncated toward zero, within ±8.64e15
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let of_day = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else {
        format!("{}{:06}", if y < 0 { '-' } else { '+' }, y.unsigned_abs())
    };
    Some(format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    ))
}

/// The proleptic Gregorian date `days` after 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_string_is_to_iso_string() {
        // what Bun printed for each
        assert_eq!(
            iso_string(1_795_165_200_000.0).as_deref(),
            Some("2026-11-20T09:00:00.000Z")
        );
        assert_eq!(iso_string(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(
            iso_string(-1.5).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            iso_string(951_782_400_123.9).as_deref(),
            Some("2000-02-29T00:00:00.123Z")
        );
        assert_eq!(
            iso_string(253_402_300_800_000.0).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_string(-62_198_755_200_000.0).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_string(8.64e15).as_deref(),
            Some("+275760-09-13T00:00:00.000Z")
        );
        assert_eq!(iso_string(8.64e15 + 1.0), None);
        assert_eq!(iso_string(f64::NAN), None);
    }

    #[test]
    fn en_us_in_the_zone_given() {
        // fixed offsets, so the test needs no zoneinfo on the machine: Los
        // Angeles in November and Tokyo
        let la = TimeZone::fixed(jiff::tz::offset(-8));
        let tokyo = TimeZone::fixed(jiff::tz::offset(9));
        // what Bun printed for 1764300000000 on the Mac and under TZ=Asia/Tokyo
        assert_eq!(
            locale_string_in(1_764_300_000_000.0, &la),
            "11/27/2025, 7:20:00 PM"
        );
        assert_eq!(
            locale_string_in(1_764_300_000_000.0, &tokyo),
            "11/28/2025, 12:20:00 PM"
        );
        assert_eq!(
            locale_string_in(0.0, &TimeZone::UTC),
            "1/1/1970, 12:00:00 AM"
        );
        assert_eq!(locale_string_in(f64::NAN, &TimeZone::UTC), "Invalid Date");
    }
}
