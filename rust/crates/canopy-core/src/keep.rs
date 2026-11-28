//! Kept shells, read side only (`src/core/keep.ts`): the records under
//! `<config>/shells`, which ones are past the retention window and which a
//! live shell does not answer for. Writing, forgetting and replaying a
//! record are not ported yet.

use serde_json::{Map, Value, json};

use crate::pathx::{join, js_trim, js_ws};

/// days a kept record lasts
pub const KEEP_DAYS: f64 = 7.0;
/// days a record the sweep left lasts
pub const SWEPT_DAYS: f64 = 14.0;
/// the longest hand-given shell name (`LABEL_MAX` in core/types.ts)
pub const LABEL_MAX: usize = 40;

/// A hand-given shell name as kept: one line with no control characters,
/// trimmed, at most `LABEL_MAX` UTF-16 units; None when nothing is left
/// (`cleanLabel` in core/types.ts).
pub fn clean_label(raw: &str) -> Option<String> {
    let mut one = String::with_capacity(raw.len());
    let mut gap = false;
    for c in raw.chars() {
        if js_ws(c) || (c as u32) <= 0x1f || c == '\u{7f}' {
            if !gap {
                one.push(' ');
            }
            gap = true;
        } else {
            one.push(c);
            gap = false;
        }
    }
    let units: Vec<u16> = js_trim(&one).encode_utf16().take(LABEL_MAX).collect();
    let out = js_trim(&String::from_utf16_lossy(&units)).to_string();
    (!out.is_empty()).then_some(out)
}

fn is_term_id(v: &str) -> bool {
    v.len() == 32 && v.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// A number as JavaScript prints it: whole ones without a fraction.
fn js_num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// One record read back, or None for one that does not check out. The
/// fields stay JSON in the TS's key order; `savedAt` is kept beside it for
/// the sort.
#[derive(Debug, Clone, PartialEq)]
pub struct KeptShell {
    pub id: String,
    pub saved_at: f64,
    pub swept: bool,
    pub json: Value,
}

pub fn parse_kept(raw: &str) -> Option<KeptShell> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let o = v.as_object()?;
    let text = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("");
    let (id, repo_id, path) = (text("id"), text("repoId"), text("path"));
    if !is_term_id(id) || repo_id.is_empty() || path.is_empty() {
        return None;
    }
    // a number that is there, else the fallback, kept as it was written
    let num = |k: &str, fallback: Value| {
        o.get(k)
            .filter(|x| x.is_number())
            .cloned()
            .unwrap_or(fallback)
    };
    let saved = num("savedAt", json!(0));
    let saved_at = saved.as_f64().unwrap_or(0.0);
    let agent = match o.get("agent").and_then(Value::as_str) {
        Some(a @ ("claude" | "codex" | "antigravity")) => json!(a),
        _ => Value::Null,
    };
    let lines = o
        .get("lines")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .trunc()
        .max(0.0);
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("repoId".into(), json!(repo_id));
    out.insert("path".into(), json!(path));
    out.insert(
        "place".into(),
        json!(if o.get("place").and_then(Value::as_str) == Some("panel") {
            "panel"
        } else {
            "strip"
        }),
    );
    out.insert("startedAt".into(), num("startedAt", saved.clone()));
    out.insert("savedAt".into(), saved);
    out.insert("lines".into(), js_num(lines));
    out.insert("agent".into(), agent);
    if let Some(l) = o.get("label").and_then(Value::as_str).and_then(clean_label) {
        out.insert("label".into(), json!(l));
    }
    if let Some(s) = o
        .get("session")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        out.insert("session".into(), json!(s));
    }
    let swept = o.get("swept") == Some(&Value::Bool(true));
    if swept {
        out.insert("swept".into(), json!(true));
    }
    Some(KeptShell {
        id: id.into(),
        saved_at,
        swept,
        json: Value::Object(out),
    })
}

/// Every record in `<config>/shells`, the newest first; a record that does
/// not read is skipped.
pub fn list_kept(config_dir: &str) -> Vec<KeptShell> {
    let dir = join(config_dir, "shells");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let mut kept: Vec<KeptShell> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json"))
        .filter_map(|n| std::fs::read_to_string(join(&dir, &n)).ok())
        .filter_map(|raw| parse_kept(&raw))
        .collect();
    kept.sort_by(|a, b| b.saved_at.total_cmp(&a.saved_at));
    kept
}

/// the ids past the retention window: `days` for a kept record,
/// `SWEPT_DAYS` for one the sweep left
pub fn expired_shells(kept: &[KeptShell], now: f64, days: f64) -> Vec<String> {
    let day = 24.0 * 60.0 * 60.0 * 1000.0;
    kept.iter()
        .filter(|k| k.saved_at < now - (if k.swept { SWEPT_DAYS } else { days }) * day)
        .map(|k| k.id.clone())
        .collect()
}

/// the records no live shell answers for, the newest first
pub fn lost_shells(kept: &[KeptShell], live: &[String]) -> Vec<KeptShell> {
    let mut out: Vec<KeptShell> = kept
        .iter()
        .filter(|k| !live.contains(&k.id))
        .cloned()
        .collect();
    out.sort_by(|a, b| b.saved_at.total_cmp(&a.saved_at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn a_record_reads_back_field_by_field() {
        let k = parse_kept(&format!(
            r#"{{"id":"{ID}","repoId":"app","path":"/r/app","place":"x","savedAt":5,"lines":-3.7,"agent":"gemini","label":"  my\n shell  ","session":"","swept":true}}"#
        ))
        .unwrap();
        assert_eq!(
            k.json,
            json!({ "id": ID, "repoId": "app", "path": "/r/app", "place": "strip", "startedAt": 5,
                    "savedAt": 5, "lines": 0, "agent": null, "label": "my shell", "swept": true })
        );
        assert!(parse_kept(r#"{"id":"short","repoId":"a","path":"/a"}"#).is_none());
        assert!(parse_kept("not json").is_none());
    }

    #[test]
    fn expired_and_lost_records_follow_the_windows_and_the_live_shells() {
        let day = 86_400_000.0;
        let rec = |id: &str, saved: f64, swept: bool| KeptShell {
            id: id.into(),
            saved_at: saved,
            swept,
            json: json!({}),
        };
        let now = 30.0 * day;
        let all = vec![
            rec("a", now - 8.0 * day, false),
            rec("b", now - 8.0 * day, true),
            rec("c", now - day, false),
        ];
        assert_eq!(expired_shells(&all, now, KEEP_DAYS), ["a"]);
        let lost = lost_shells(&all, &["c".into()]);
        assert_eq!(
            lost.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }

    #[test]
    fn a_label_is_one_line_of_at_most_forty() {
        assert_eq!(clean_label(" \u{7}  "), None);
        assert_eq!(clean_label(&"x".repeat(50)).unwrap().len(), 40);
    }
}
