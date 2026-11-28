//! The ranger, canopy's always-on agent (`src/core/ranger.ts`), the part
//! canopy-server's `GET /api/ranger` reads: its settings as the config
//! stores them (`normalizeRanger`), its handle (`rangerHandle`), a wake read
//! back off disk (`parseWake`), and from `src/server/ranger.ts` its session
//! id on a backend (`rangerTermId`) and the record it keeps across restarts
//! (`parseRecord`). Starting it, its argv and brief, a fresh conversation
//! and the wakes' delivery are not ported yet.

use crate::cron::is_cron;
use crate::pathx::js_len;
use crate::route::is_profile_name;
use crate::screenlayouts::js_num;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// `RANGER_HANDLE`: its tailchan handle unless the settings name one.
pub const RANGER_HANDLE: &str = "ranger";
/// `TELEGRAM_PLUGIN`: the plugin it owns the Telegram bot through.
pub const TELEGRAM_PLUGIN: &str = "telegram@claude-plugins-official";
/// `WAKE_PROMPT_MAX`: the longest prompt a wake carries, in UTF-16 units.
pub const WAKE_PROMPT_MAX: usize = 2000;
/// the biggest transcript size a fresh start can wait for, in MB
const MAX_MB: f64 = 1000.0;

/// `RANGER_FRESH`
fn fresh_default() -> Value {
    json!({ "daily": "04:00", "maxMb": 25 })
}

/// `RANGER_DEFAULTS`
pub fn ranger_defaults() -> Value {
    json!({ "on": false, "profile": null, "handle": null, "telegram": false, "fresh": fresh_default(), "home": "own" })
}

/// `HANDLE_RE` in core/tailchan.ts: `/^[a-z0-9][a-z0-9._-]{0,39}$/`.
pub fn is_handle(v: &str) -> bool {
    let b = v.as_bytes();
    (1..=40).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// `CLOCK_RE` in core/cron.ts: `HH:MM` on a 24-hour clock.
pub fn is_clock(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit())
        && (b[0] == b'0' || b[0] == b'1' || (b[0] == b'2' && b[1] <= b'3'))
        && b[3] <= b'5'
}

fn normalize_fresh(v: Option<&Value>) -> Value {
    let Some(f) = v.and_then(Value::as_object) else {
        return fresh_default();
    };
    let daily = match f.get("daily") {
        Some(Value::Null) => Value::Null,
        Some(Value::String(s)) if is_clock(s) => json!(s),
        _ => json!("04:00"),
    };
    let max_mb = match f.get("maxMb") {
        Some(Value::Null) => Value::Null,
        Some(n) => match n.as_f64() {
            // Math.round: halves go up
            Some(mb) if mb.is_finite() && (1.0..=MAX_MB).contains(&mb) => {
                js_num((mb + 0.5).floor())
            }
            _ => json!(25),
        },
        None => json!(25),
    };
    json!({ "daily": daily, "maxMb": max_mb })
}

/// `normalizeRanger()`: the stored settings field by field; anything that
/// does not read falls back to its default.
pub fn normalize_ranger(v: Option<&Value>) -> Value {
    let Some(r) = v.and_then(Value::as_object) else {
        return ranger_defaults();
    };
    let profile = r
        .get("profile")
        .and_then(Value::as_str)
        .filter(|p| is_profile_name(p));
    let handle = r
        .get("handle")
        .and_then(Value::as_str)
        .filter(|h| is_handle(h));
    json!({
        "on": r.get("on") == Some(&Value::Bool(true)),
        "profile": profile,
        "handle": handle,
        "telegram": r.get("telegram") == Some(&Value::Bool(true)),
        "fresh": normalize_fresh(r.get("fresh")),
        "home": if r.get("home").and_then(Value::as_str) == Some("root") { "root" } else { "own" },
    })
}

/// `rangerHandle()`: the settings' handle, else `ranger`.
pub fn ranger_handle(settings: &Value) -> String {
    settings
        .get("handle")
        .and_then(Value::as_str)
        .unwrap_or(RANGER_HANDLE)
        .to_string()
}

/// `rangerTermId()`: its session id on a backend, shaped like a shell's and
/// the same every start.
pub fn ranger_term_id(backend: &str) -> String {
    let hash = Sha256::digest(format!("ranger\0{backend}").as_bytes());
    hash.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// a run's id, as the runner makes them: `/^[A-Za-z0-9_-]{1,64}$/`
fn is_run_id(v: &str) -> bool {
    (1..=64).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `parseWake()`: a wake as read back off disk, in the TypeScript's key
/// order, or None when it does not check out.
pub fn parse_wake(v: &Value) -> Option<Value> {
    let w = v.as_object()?;
    let id = w.get("id")?.as_str()?;
    if id.len() != 8 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let by = w.get("by")?.as_str()?;
    if !matches!(by, "eric" | "ranger" | "run") {
        return None;
    }
    let from = w.get("from").and_then(Value::as_str);
    if by == "run" && !from.is_some_and(is_run_id) {
        return None;
    }
    let prompt = w.get("prompt")?.as_str()?;
    if prompt.is_empty() || js_len(prompt) > WAKE_PROMPT_MAX {
        return None;
    }
    let created = w.get("created")?.as_f64()?;
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("by".into(), json!(by));
    if by == "run" {
        out.insert("from".into(), json!(from));
    }
    out.insert("prompt".into(), json!(prompt));
    out.insert("created".into(), js_num(created));
    let next = w.get("next").and_then(Value::as_f64);
    let cron = w.get("cron").filter(|c| is_cron(c));
    let at = w.get("at").and_then(Value::as_f64);
    let run = w
        .get("run")
        .and_then(Value::as_str)
        .filter(|r| is_run_id(r));
    if let Some(cron) = cron {
        out.insert("cron".into(), cron.clone());
        if let Some(n) = next {
            out.insert("next".into(), js_num(n));
        }
    } else if let Some(at) = at {
        out.insert("at".into(), js_num(at));
        out.insert("next".into(), js_num(next.unwrap_or(at)));
    } else {
        // neither a cron line, a time nor a run: not a wake
        out.insert("run".into(), json!(run?));
    }
    Some(Value::Object(out))
}

/// `parseRecord()` in server/ranger.ts: what the hub keeps across restarts
/// (`ranger/state.json`), field by field.
pub fn parse_record(v: Option<&Value>) -> Value {
    let Some(r) = v.and_then(Value::as_object) else {
        return json!({ "session": null });
    };
    let session = r.get("session").and_then(Value::as_str).filter(|s| {
        s.len() == 36
            && s.bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
    });
    let mut out = Map::new();
    out.insert("session".into(), json!(session));
    for k in ["sessionAt", "startedAt", "exitedAt", "fails"] {
        if let Some(n) = r.get(k).and_then(Value::as_f64) {
            out.insert(k.into(), js_num(n));
        }
    }
    for k in ["previous", "home"] {
        if let Some(s) = r.get(k).and_then(Value::as_str) {
            out.insert(k.into(), json!(s));
        }
    }
    match r.get("exitCode") {
        Some(Value::Null) => {
            out.insert("exitCode".into(), Value::Null);
        }
        Some(n) if n.is_number() => {
            out.insert("exitCode".into(), js_num(n.as_f64().unwrap_or(0.0)));
        }
        _ => {}
    }
    if r.get("gaveUp") == Some(&Value::Bool(true)) {
        out.insert("gaveUp".into(), json!(true));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_what_reads_and_defaults_the_rest() {
        assert_eq!(normalize_ranger(None), ranger_defaults());
        let all = json!({ "on": true, "profile": "review", "handle": "ranger-mac", "telegram": true, "fresh": { "daily": null, "maxMb": 40 }, "home": "root" });
        assert_eq!(normalize_ranger(Some(&all)), all);
        // a folder of its own unless root is asked for
        assert_eq!(
            normalize_ranger(Some(&json!({ "home": "elsewhere" })))["home"],
            "own"
        );
        let bad = json!({ "on": "yes", "profile": "Bad Name", "handle": "@x", "fresh": { "daily": "4am", "maxMb": -1 } });
        assert_eq!(normalize_ranger(Some(&bad)), ranger_defaults());
        // the key order is the TypeScript's
        assert_eq!(
            serde_json::to_string(&ranger_defaults()).unwrap(),
            r#"{"on":false,"profile":null,"handle":null,"telegram":false,"fresh":{"daily":"04:00","maxMb":25},"home":"own"}"#
        );
    }

    #[test]
    fn read_back_off_disk_or_dropped() {
        let now = 1_791_620_000_000.0_f64;
        let w = json!({ "id": "0000000f", "by": "eric", "prompt": "morning", "created": now, "cron": "0 8 * * *", "next": now + 1.0 });
        assert_eq!(
            serde_json::to_string(&parse_wake(&w).unwrap()).unwrap(),
            r#"{"id":"0000000f","by":"eric","prompt":"morning","created":1791620000000,"cron":"0 8 * * *","next":1791620000001}"#
        );
        let mut nothex = w.clone();
        nothex["id"] = json!("nothex!!");
        assert_eq!(parse_wake(&nothex), None);
        let mut neither = w.clone();
        neither.as_object_mut().unwrap().remove("cron");
        assert_eq!(parse_wake(&neither), None);
        let mut at = neither.clone();
        at["at"] = json!(5);
        let back = parse_wake(&at).unwrap();
        assert_eq!(back["at"], 5);
        assert_eq!(back["next"], json!(1_791_620_000_001_i64));
    }

    #[test]
    fn a_run_wake_names_its_run_and_one_by_a_run_names_where_it_came_from() {
        let base = json!({ "id": "0000000a", "by": "run", "from": "r-12", "prompt": "look", "created": 1, "run": "r-9" });
        assert_eq!(
            serde_json::to_string(&parse_wake(&base).unwrap()).unwrap(),
            r#"{"id":"0000000a","by":"run","from":"r-12","prompt":"look","created":1,"run":"r-9"}"#
        );
        let mut nofrom = base.clone();
        nofrom.as_object_mut().unwrap().remove("from");
        assert_eq!(parse_wake(&nofrom), None);
        let mut long = base.clone();
        long["prompt"] = json!("x".repeat(WAKE_PROMPT_MAX + 1));
        assert_eq!(parse_wake(&long), None);
        let mut bad_cron = base.clone();
        bad_cron["by"] = json!("eric");
        bad_cron["cron"] = json!("nope");
        // a cron line that does not read leaves the run it also names
        assert_eq!(parse_wake(&bad_cron).unwrap()["run"], "r-9");
    }

    #[test]
    fn its_session_id_is_the_first_half_of_a_sha256_of_its_backend() {
        let id = ranger_term_id("mini");
        assert_eq!(id.len(), 32);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(id, ranger_term_id("mac"));
        // sha256("ranger\0mini"), as node:crypto gives it
        assert_eq!(id, "f5adc82b93f575d7cc6e8444ef1b6a2f");
    }

    #[test]
    fn the_record_keeps_what_reads() {
        let r = json!({ "session": "0123abcd-0123-0123-0123-0123456789ab", "sessionAt": 5, "fails": 2, "exitCode": null, "home": "/h", "gaveUp": true, "junk": 1 });
        assert_eq!(
            serde_json::to_string(&parse_record(Some(&r))).unwrap(),
            r#"{"session":"0123abcd-0123-0123-0123-0123456789ab","sessionAt":5,"fails":2,"home":"/h","exitCode":null,"gaveUp":true}"#
        );
        assert_eq!(
            parse_record(Some(&json!({ "session": "short" }))),
            json!({ "session": null })
        );
        assert_eq!(parse_record(None), json!({ "session": null }));
    }

    #[test]
    fn a_handle_and_a_clock_read_as_tailchan_and_cron_have_them() {
        assert!(is_handle("ranger-mac"));
        assert!(!is_handle("@x"));
        assert!(!is_handle(&"a".repeat(41)));
        assert!(is_clock("04:00") && is_clock("23:59") && is_clock("19:30"));
        assert!(!is_clock("24:00") && !is_clock("4am") && !is_clock("12:60"));
    }
}
