//! `new Date(ms).toLocaleString()` as Bun prints it. Bun formats in en-US
//! whatever LANG says ("11/27/2025, 7:20:00 PM", plain spaces), in the zone
//! TZ names, else the system's.

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

/// `new Date(v).toLocaleString()` for a JSON field: null as the epoch, a
/// boolean as 0 or 1, and anything not a number as "Invalid Date".
pub fn date_of(v: Option<&serde_json::Value>) -> String {
    use serde_json::Value;
    match v {
        Some(Value::Null) => locale_string(0.0),
        Some(Value::Number(n)) => locale_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => locale_string(if *b { 1.0 } else { 0.0 }),
        _ => "Invalid Date".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
