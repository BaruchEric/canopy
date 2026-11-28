//! `canopy capacity` (`src/cli/capacity.ts`, FR-036): each backend's usage
//! windows, the hit that holds work, the starts the governor holds and the
//! thresholds; `read` asks for a reading now, `release` starts one held
//! start as interactive, and `set` changes the thresholds or the observed
//! dollar figure. Also `hitStands` and `resetWord` from
//! src/core/capacity.ts, the two parts of the governor this verb prints.

use crate::api::Caller;
use crate::ask::{Ask, Target, backend_targets, did_not_answer, has, shift, take};
use crate::out::Out;
use canopy_core::js::{field, list_at, num_at, str_at, template};
use canopy_core::pathx::{js_trim, pad_end};
use canopy_core::store::js_number;
use jiff::Timestamp;
use jiff::civil::Weekday;
use jiff::tz::TimeZone;
use serde_json::{Map, Value, json};

/// `CAPACITY_USAGE`.
pub const CAPACITY_USAGE: &str = "usage: canopy capacity [--json] [--on NAME] [--backend URL]
       canopy capacity read [--on NAME]
       canopy capacity release <id> [--on NAME]
       canopy capacity set [--low N] [--normal N] [--weekly N] [--usd N|none] [--on NAME]
  the listing asks every backend the home one lists; read, release and set speak to the home
  backend, or to --on's. A hold is 0.7 or 70%; --usd is what one 5-hour window is worth in
  Claude dollars, for the estimate from the ledger, and none clears it";

/// `HIT_GRACE` in core/capacity.ts: how long a hit stands past its reset.
const HIT_GRACE: f64 = 2.0 * 60_000.0;

/// The tones a harness's line takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Moss,
    Lichen,
    Rust,
}

/// render.ts's palette, on when stdout is a terminal and NO_COLOR is unset.
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub color: bool,
}

impl Palette {
    fn rgb(&self, (r, g, b): (u8, u8, u8), s: &str) -> String {
        if self.color {
            format!("\x1b[38;2;{r};{g};{b}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }

    /// `paintTone()`: rust, lichen or moss.
    pub fn tone(&self, tone: Tone, s: &str) -> String {
        match tone {
            Tone::Moss => self.rgb((147, 201, 139), s),
            Tone::Lichen => self.rgb((217, 179, 107), s),
            Tone::Rust => self.rgb((201, 123, 95), s),
        }
    }

    fn dim(&self, s: &str) -> String {
        if self.color {
            format!("\x1b[2m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }

    fn bold(&self, s: &str) -> String {
        if self.color {
            format!("\x1b[1m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }
}

/// `Math.round()`: the nearer whole number, a half toward +∞.
fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `pct()`: "32%".
fn pct(share: f64) -> String {
    format!("{}%", js_number(round(share * 100.0)))
}

/// `resetWord()` in core/capacity.ts: a reset as its local time today
/// ("15:00"), or its weekday otherwise ("Thu"), in the zone given.
pub fn reset_word(ms: f64, now: f64, tz: &TimeZone) -> String {
    let at = |ms: f64| {
        if !ms.is_finite() {
            return None;
        }
        Timestamp::from_millisecond(ms.trunc() as i64)
            .ok()
            .map(|t| t.to_zoned_datetime(tz.clone()))
    };
    let Some(reset) = at(ms) else {
        return "Invalid Date".into();
    };
    let current = at(now);
    let same_day = current.as_ref().is_some_and(|c| {
        c.year() == reset.year() && c.month() == reset.month() && c.day() == reset.day()
    });
    if same_day {
        return format!("{:02}:{:02}", reset.hour(), reset.minute());
    }
    match reset.weekday() {
        Weekday::Monday => "Mon",
        Weekday::Tuesday => "Tue",
        Weekday::Wednesday => "Wed",
        Weekday::Thursday => "Thu",
        Weekday::Friday => "Fri",
        Weekday::Saturday => "Sat",
        Weekday::Sunday => "Sun",
    }
    .into()
}

/// `hitStands()` in core/capacity.ts: a hit holds work until its reset and
/// a short grace after it.
fn hit_stands(hit: Option<&Value>, now: f64) -> bool {
    match hit {
        None | Some(Value::Null) => false,
        Some(h) => now < num_at(h, "resetsAt").unwrap_or(f64::NAN) + HIT_GRACE,
    }
}

/// A field that is a number, NaN otherwise, as arithmetic reads it.
fn num(o: &Value, key: &str) -> f64 {
    num_at(o, key).unwrap_or(f64::NAN)
}

/// `w?.used ?? 0`.
fn used_of(w: Option<&Value>) -> f64 {
    match w.and_then(|w| w.get("used")) {
        None | Some(Value::Null) => 0.0,
        Some(v) => v.as_f64().unwrap_or(f64::NAN),
    }
}

/// `windowLine()`: "5h 32% · resets 15:00", "week 61% · resets Thu",
/// "5h 40%", "5h no reading".
pub fn window_line(name: &str, w: Option<&Value>, now: f64, tz: &TimeZone) -> String {
    let Some(w) = w.filter(|w| !w.is_null()) else {
        return format!("{name} no reading");
    };
    let used = pct(num(w, "used"));
    match w.get("resetsAt") {
        Some(Value::Null) => format!("{name} {used}"),
        r => format!(
            "{name} {used} · resets {}",
            reset_word(r.and_then(Value::as_f64).unwrap_or(f64::NAN), now, tz)
        ),
    }
}

fn source_word(c: &Value) -> &'static str {
    match str_at(c, "source") {
        Some("endpoint") => "read from the usage endpoint",
        Some("run") => "read from a run",
        Some("cli") => "read from the CLI",
        Some("observed") => "observed from the ledger",
        _ => "no reading",
    }
}

/// `capacityLines()`: one backend's answer as lines, a line per harness
/// with its hit under it, the held starts and the thresholds. `paint`
/// colours a harness's line.
pub fn capacity_lines(
    name: &str,
    info: &Value,
    now: f64,
    tz: &TimeZone,
    pal: Palette,
    paint: &mut dyn FnMut(Tone, &str) -> String,
) -> Vec<String> {
    let mut out = vec![pal.bold(name)];
    let s = info.get("settings").unwrap_or(&Value::Null);
    for c in list_at(info, "capacity") {
        let standing =
            Some(c.get("hit").unwrap_or(&Value::Null)).filter(|h| hit_stands(Some(h), now));
        let five = c.get("fiveHour");
        let weekly = c.get("weekly");
        let windows = if str_at(c, "source") == Some("unknown") && standing.is_none() {
            "no reading".to_string()
        } else {
            format!(
                "{}   {}",
                window_line("5h", five, now, tz),
                window_line("week", weekly, now, tz)
            )
        };
        let used = used_of(five);
        let tone = if standing.is_some() || used >= num(s, "normalHold") {
            Tone::Rust
        } else if used >= num(s, "lowHold") || used_of(weekly) >= num(s, "weeklyLowHold") {
            Tone::Lichen
        } else {
            Tone::Moss
        };
        out.push(format!(
            "  {} {}  {}",
            pad_end(&field(c, "harness"), 7),
            paint(tone, &windows),
            pal.dim(&format!("({})", source_word(c)))
        ));
        if let Some(hit) = standing {
            out.push(format!(
                "          limit hit, resets {}: {}",
                reset_word(num(hit, "resetsAt"), now, tz),
                field(hit, "text")
            ));
        }
    }
    let held = list_at(info, "held");
    if !held.is_empty() {
        out.push(format!("  held for capacity: {}", held.len()));
        for h in held {
            out.push(format!(
                "    {}  {} {} ({}): {}",
                field(h, "id"),
                pad_end(&field(h, "priority"), 6),
                field(h, "what"),
                field(h, "repoId"),
                field(h, "why")
            ));
        }
    }
    let usd = match s.get("observedFiveHourUsd") {
        Some(Value::Null) => "no observed dollar figure".to_string(),
        v => format!("${} a 5-hour window", template(v)),
    };
    out.push(pal.dim(&format!(
        "  holds: low past {}, normal past {}, low past {} of the week; {usd}",
        pct(num(s, "lowHold")),
        pct(num(s, "normalHold")),
        pct(num(s, "weeklyLowHold"))
    )));
    out
}

/// `Number(s)` for a word on the command line: JavaScript's whitespace
/// trimmed, empty is 0, Infinity and the 0x, 0o and 0b forms read, and
/// anything else that is not a decimal NaN.
pub(crate) fn js_number_of(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return rest.chars().fold(0.0, |n, c| {
                n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let b = t.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let mut seen = digits(&mut i);
    if i < b.len() && b[i] == b'.' {
        i += 1;
        seen += digits(&mut i);
    }
    if seen == 0 {
        return f64::NAN;
    }
    if i < b.len() && matches!(b[i], b'e' | b'E') {
        i += 1;
        if i < b.len() && matches!(b[i], b'+' | b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// A number as JSON.stringify writes it: a whole one with no point.
fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// `holdArg()`: a hold as written on the command line, 0.7 or 70%.
pub fn hold_arg(v: &str) -> Option<f64> {
    let n = match v.strip_suffix('%') {
        Some(head) => js_number_of(head) / 100.0,
        None => js_number_of(v),
    };
    (n.is_finite() && n > 0.0 && n <= 1.0).then_some(n)
}

/// `parseSetArgs()`: `set`'s flags as a settings patch, or what is wrong.
pub fn parse_set_args(argv: &[String]) -> Result<Value, String> {
    let mut args = argv.to_vec();
    let mut patch = Map::new();
    for (flag, key) in [
        ("--low", "lowHold"),
        ("--normal", "normalHold"),
        ("--weekly", "weeklyLowHold"),
    ] {
        if !args.iter().any(|a| a == flag) {
            continue;
        }
        let Some(n) = take(&mut args, flag).as_deref().and_then(hold_arg) else {
            return Err(format!(
                "{flag} needs a hold above 0 and at most 1 (0.7 or 70%)"
            ));
        };
        patch.insert(key.into(), json_number(n));
    }
    if args.iter().any(|a| a == "--usd") {
        let raw = take(&mut args, "--usd");
        if raw.as_deref() == Some("none") {
            patch.insert("observedFiveHourUsd".into(), Value::Null);
        } else {
            let n = raw.as_deref().map_or(f64::NAN, js_number_of);
            if !n.is_finite() || n <= 0.0 {
                return Err("--usd needs a dollar figure above 0, or none".into());
            }
            patch.insert("observedFiveHourUsd".into(), json_number(n));
        }
    }
    if !args.is_empty() {
        return Err(format!("unknown words: {}", args.join(" ")));
    }
    if patch.is_empty() {
        return Err("name one of --low, --normal, --weekly or --usd".into());
    }
    Ok(Value::Object(patch))
}

/// `JSON.stringify(v, null, 2)`.
fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// `capacityCommand()`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn capacity_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    now: f64,
    tz: &TimeZone,
    color: bool,
) -> Result<(), String> {
    let pal = Palette { color };
    let backend_flag = args.iter().any(|a| a == "--backend");
    let on_flag = args.iter().any(|a| a == "--on");
    let given = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    if backend_flag && given.is_none() {
        return Err("--backend needs a value".into());
    }
    if on_flag && on.is_none() {
        return Err("--on needs a value".into());
    }
    let as_json = has(&mut args, "--json");
    let home = caller.api_base(given.as_deref());
    let sub = if args
        .first()
        .is_some_and(|a| !a.is_empty() && !a.starts_with('-'))
    {
        shift(&mut args)
    } else {
        None
    };
    let mut paint = |tone: Tone, s: &str| pal.tone(tone, s);
    // the home backend, or the one --on names
    let one = async || -> Result<Target, String> {
        let Some(name) = on.as_deref() else {
            return Ok(Target::home(&home));
        };
        backend_targets(ask, &home, given.is_some(), Some(name))
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| format!("no backend named {name}"))
    };
    match sub.as_deref() {
        None | Some("list") => {
            if !args.is_empty() {
                return Err(CAPACITY_USAGE.into());
            }
            let targets = backend_targets(ask, &home, given.is_some(), on.as_deref()).await?;
            let mut answers = Map::new();
            for t in &targets {
                match ask.ask(t, "GET", "/api/capacity", None).await {
                    Ok(info) => {
                        if !as_json {
                            out.lines(capacity_lines(&t.name, &info, now, tz, pal, &mut paint));
                        }
                        answers.insert(t.name.clone(), info);
                    }
                    Err(e) => {
                        if !as_json {
                            out.line(format!(
                                "{}\n  {}",
                                pal.bold(&t.name),
                                pal.dim(&format!("no answer: {}", e.message()))
                            ));
                        }
                    }
                }
            }
            if as_json {
                out.line(pretty(&Value::Object(answers)));
            }
            Ok(())
        }
        Some("read") => {
            if !args.is_empty() {
                return Err(CAPACITY_USAGE.into());
            }
            let t = one().await?;
            let info = ask
                .ask(&t, "POST", "/api/capacity/read", Some(&json!({})))
                .await
                .map_err(|e| did_not_answer(&t.name, &e))?;
            show(out, &t.name, &info, as_json, now, tz, pal);
            Ok(())
        }
        Some("release") => {
            let id = shift(&mut args).filter(|id| !id.is_empty());
            let Some(id) = id.filter(|_| args.is_empty()) else {
                return Err(CAPACITY_USAGE.into());
            };
            let t = one().await?;
            let info = ask
                .ask(
                    &t,
                    "POST",
                    "/api/capacity/release",
                    Some(&json!({ "id": id })),
                )
                .await
                .map_err(|e| did_not_answer(&t.name, &e))?;
            if as_json {
                out.line(pretty(&info));
            } else {
                out.line(format!(
                    "{id} started as interactive; {} still held",
                    list_at(&info, "held").len()
                ));
            }
            Ok(())
        }
        Some("set") => {
            let patch = parse_set_args(&args)?;
            let t = one().await?;
            let info = ask
                .ask(&t, "POST", "/api/capacity", Some(&patch))
                .await
                .map_err(|e| did_not_answer(&t.name, &e))?;
            show(out, &t.name, &info, as_json, now, tz, pal);
            Ok(())
        }
        _ => Err(CAPACITY_USAGE.into()),
    }
}

/// `show()`: one backend's answer as JSON or as its lines.
fn show(
    out: &mut Out,
    name: &str,
    info: &Value,
    as_json: bool,
    now: f64,
    tz: &TimeZone,
    pal: Palette,
) {
    if as_json {
        out.line(pretty(info));
    } else {
        out.lines(capacity_lines(name, info, now, tz, pal, &mut |t, s| {
            pal.tone(t, s)
        }));
    }
}

#[cfg(test)]
mod tests;
