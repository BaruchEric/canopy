//! Quick notes and reminders (FR-020, `src/core/notes.ts`): the record, the
//! pure rules the CLI lists them by, the file's records read back as the
//! server reads them, a note's text and id as the server makes them, and
//! the reminders that have come due. The server half (the file's writes,
//! the routes, the delivery) is canopy-server's `notes.rs`.
//!
//! The server keeps a note as a JSON object, not as `QuickNote`, because
//! the file is written back byte for byte: a field keeps the place
//! JavaScript gave it, and an edit that adds one puts it last.

use crate::js::num;
use crate::pathx::js_trim;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::borrow::Cow;

/// `QUICK_NOTE_CHARS`: the most characters (UTF-16 units) a note keeps.
pub const QUICK_NOTE_CHARS: usize = 600;

/// One note, as `GET /api/notes` sends it. Times are unix ms.
#[derive(Debug, Clone, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct QuickNote {
    pub id: String,
    pub text: String,
    /// the repo it is about; absent for a note on its own
    pub repo_id: Option<String>,
    /// when it comes back; absent for a plain note
    pub due: Option<f64>,
    pub created_at: f64,
    /// when the reminder reached the inbox
    pub reminded_at: Option<f64>,
    pub done_at: Option<f64>,
}

/// `openNotes()`: the notes not yet done.
pub fn open_notes(notes: &[QuickNote]) -> Vec<QuickNote> {
    notes
        .iter()
        .filter(|n| n.done_at.is_none())
        .cloned()
        .collect()
}

/// `sortNotes()`: reminders first, the soonest at the top; then plain
/// notes, newest first.
pub fn sort_notes(notes: &[QuickNote]) -> Vec<QuickNote> {
    let mut out = notes.to_vec();
    // JavaScript's sort is stable and so is this; a comparator that says
    // "equal" (0, or NaN) keeps the order
    out.sort_by(|a, b| {
        let by = |x: f64| x.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        match (a.due, b.due) {
            (Some(ad), Some(bd)) => {
                let d = ad - bd;
                if d != 0.0 && !d.is_nan() {
                    by(d)
                } else {
                    by(b.created_at - a.created_at)
                }
            }
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => by(b.created_at - a.created_at),
        }
    });
    out
}

const MIN: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MIN;
const DAY: f64 = 24.0 * HOUR;

/// `dueWord()`: "in 5m", "in 1h 30m", "in 2d", "now", "5m ago", "1d ago",
/// a reminder's time against now.
pub fn due_word(due: f64, now: f64) -> String {
    let diff = due - now;
    let span = |ms: f64| -> String {
        if ms >= DAY {
            return format!("{}d", (ms / DAY).floor());
        }
        if ms >= HOUR {
            let h = (ms / HOUR).floor();
            let m = ((ms % HOUR) / MIN).floor();
            return if m > 0.0 {
                format!("{h}h {m}m")
            } else {
                format!("{h}h")
            };
        }
        // Math.round: half up
        format!("{}m", (ms / MIN + 0.5).floor().max(1.0))
    };
    if diff >= 0.0 {
        return format!("in {}", span(diff));
    }
    if -diff < MIN {
        return "now".into();
    }
    format!("{} ago", span(-diff))
}

/// `isNoteId()`: `n-` and eight base32 letters.
pub fn is_note_id(v: &str) -> bool {
    v.len() == 10
        && v.starts_with("n-")
        && v.bytes()
            .skip(2)
            .all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c))
}

/// `timeOf()`: a positive finite number, as JavaScript writes it back
/// (`1e12` and `5.0` in the file are written `1000000000000` and `5`).
fn time_of(v: Option<&Value>) -> Option<Value> {
    let n = v?.as_f64()?;
    (n.is_finite() && n > 0.0).then(|| num(n))
}

/// `parseNote()`: one record of the file as a note, its fields in the order
/// the TypeScript sets them, or None when it is not one.
pub fn parse_note(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let id = o.get("id")?.as_str().filter(|s| is_note_id(s))?;
    let text = o.get("text")?.as_str()?;
    let created = time_of(o.get("createdAt"))?;
    let mut n = Map::new();
    n.insert("id".into(), id.into());
    n.insert("text".into(), text.into());
    n.insert("createdAt".into(), created);
    if let Some(r) = o
        .get("repoId")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())
    {
        n.insert("repoId".into(), r.into());
    }
    for k in ["due", "remindedAt", "doneAt"] {
        if let Some(t) = time_of(o.get(k)) {
            n.insert(k.into(), t);
        }
    }
    Some(Value::Object(n))
}

/// `parseNotes()`: the file's array read back; a record that is not a note
/// is dropped, never the file.
pub fn parse_notes(v: &Value) -> Vec<Value> {
    v.as_array()
        .map(|a| a.iter().filter_map(parse_note).collect())
        .unwrap_or_default()
}

/// The file's text read back as the server reads it: `JSON.parse`, then
/// `parseNotes`; text that is not JSON is no notes. JavaScript writes half
/// of a surrogate pair as an escape (`"\ud83d"`) that serde will not parse,
/// and a text cut at `QUICK_NOTE_CHARS` can end in one. It is read as
/// U+FFFD here, so such a file is not taken for an empty one, which the
/// next write would put one note over.
pub fn parse_file(raw: &str) -> Vec<Value> {
    let v = serde_json::from_str::<Value>(raw)
        .ok()
        .or_else(|| serde_json::from_str(&mend_lone_surrogates(raw)?).ok());
    v.map(|v| parse_notes(&v)).unwrap_or_default()
}

/// The JSON text with each `\u` escape of a lone surrogate as `�`, or
/// None when it has none.
fn mend_lone_surrogates(raw: &str) -> Option<String> {
    let b = raw.as_bytes();
    // the code unit of the `\uXXXX` escape whose backslash is at `i`
    let unit = |i: usize| -> Option<u16> {
        if b.get(i + 1) != Some(&b'u') {
            return None;
        }
        u16::from_str_radix(raw.get(i + 2..i + 6)?, 16).ok()
    };
    let high = |u: u16| (0xd800..0xdc00).contains(&u);
    let low = |u: u16| (0xdc00..0xe000).contains(&u);
    let mut out = String::with_capacity(raw.len());
    let mut mended = false;
    let mut i = 0;
    while let Some(off) = raw[i..].find('\\') {
        let at = i + off;
        out.push_str(&raw[i..at]);
        match unit(at) {
            Some(u)
                if high(u) && b.get(at + 6) == Some(&b'\\') && unit(at + 6).is_some_and(low) =>
            {
                out.push_str(&raw[at..at + 12]);
                i = at + 12;
            }
            Some(u) if high(u) || low(u) => {
                out.push_str("\\ufffd");
                mended = true;
                i = at + 6;
            }
            _ => {
                // any other escape: the backslash and the character after it
                let next = raw[at + 1..].chars().next().map_or(0, char::len_utf8);
                out.push_str(&raw[at..at + 1 + next]);
                i = at + 1 + next;
            }
        }
    }
    out.push_str(&raw[i..]);
    mended.then_some(out)
}

/// `noteText()`: a note's text as kept, trimmed, inner lines kept, cut at
/// `QUICK_NOTE_CHARS` UTF-16 units. A cut through a surrogate pair keeps
/// its first half in JavaScript, which a Rust string cannot hold: it is
/// U+FFFD here, the character a page shows for it, so the length is the
/// same.
pub fn note_text(text: &str) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in js_trim(text).chars() {
        let w = c.len_utf16();
        if units + w > QUICK_NOTE_CHARS {
            if units < QUICK_NOTE_CHARS {
                out.push('\u{fffd}');
            }
            break;
        }
        units += w;
        out.push(c);
    }
    out
}

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// `mintNoteId()` on five random bytes: `n-` and eight base32 letters, as
/// the work ledger mints its ids.
pub fn mint_note_id_from(bytes: [u8; 5]) -> String {
    let mut out = String::from("n-");
    for i in 0..8 {
        let bit = i * 5;
        let byte = bit / 8;
        let offset = bit % 8;
        let next = bytes.get(byte + 1).copied().unwrap_or(0);
        let window = (u32::from(bytes[byte]) << 8) | u32::from(next);
        let index = (window >> (11 - offset)) & 31;
        out.push(BASE32[index as usize] as char);
    }
    out
}

/// `mintNoteId()`: a new note's id from the system's random source.
pub fn mint_note_id() -> String {
    use rand::Rng as _;
    let mut bytes = [0u8; 5];
    rand::rng().fill_bytes(&mut bytes);
    mint_note_id_from(bytes)
}

/// `isDue()`: whether a reminder's time has come and it has not reached
/// the inbox yet.
pub fn is_due(n: &Value, now: f64) -> bool {
    n.get("due")
        .and_then(Value::as_f64)
        .is_some_and(|due| due <= now)
        && n.get("remindedAt").is_none()
        && n.get("doneAt").is_none()
}

/// What `remindDue()` returns: the list, and the notes it delivered.
pub struct Reminded<'a> {
    /// the list it was given, borrowed, when nothing came due
    pub notes: Cow<'a, [Value]>,
    pub delivered: Vec<Value>,
}

/// `remindDue()`: the reminders that have come due marked delivered at
/// `now`, `remindedAt` last, where the spread puts it. The list is the one
/// given, borrowed, when nothing came due, so a caller can skip the write.
pub fn remind_due(notes: &[Value], now: f64) -> Reminded<'_> {
    let mut delivered = Vec::new();
    let out: Vec<Value> = notes
        .iter()
        .map(|n| {
            if !is_due(n, now) {
                return n.clone();
            }
            let mut next = n.clone();
            if let Some(m) = next.as_object_mut() {
                m.insert("remindedAt".into(), num(now));
            }
            delivered.push(next.clone());
            next
        })
        .collect();
    let notes = if delivered.is_empty() {
        Cow::Borrowed(notes)
    } else {
        Cow::Owned(out)
    };
    Reminded { notes, delivered }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_is_a_note_only_with_an_id_text_and_a_time() {
        let file: Value = serde_json::from_str(
            r#"[{"doneAt":5,"id":"n-abcdefgh","text":"t","createdAt":1764300000000,"repoId":"","due":-1,"extra":1},
                {"id":"n-ABCDEFGH","text":"t","createdAt":1},
                {"id":"n-abcdefg2","text":"t"},
                {"id":"n-abcdefg3","text":"t","createdAt":2.5,"repoId":"r","remindedAt":3}]"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&parse_notes(&file)).unwrap(),
            r#"[{"id":"n-abcdefgh","text":"t","createdAt":1764300000000,"doneAt":5},{"id":"n-abcdefg3","text":"t","createdAt":2.5,"repoId":"r","remindedAt":3}]"#
        );
        assert!(parse_notes(&serde_json::json!({})).is_empty());
    }

    const NOW: f64 = 1_762_000_000_000.0;

    fn note(id: &str, due: Option<f64>, created_at: f64) -> QuickNote {
        QuickNote {
            id: id.into(),
            text: id.into(),
            due,
            created_at,
            ..Default::default()
        }
    }

    #[test]
    fn due_word_reads_a_time_against_now() {
        assert_eq!(due_word(NOW + 5.0 * MIN, NOW), "in 5m");
        assert_eq!(due_word(NOW + 20_000.0, NOW), "in 1m");
        assert_eq!(due_word(NOW + 90.0 * MIN, NOW), "in 1h 30m");
        assert_eq!(due_word(NOW + 2.0 * HOUR, NOW), "in 2h");
        assert_eq!(due_word(NOW + 2.0 * DAY + HOUR, NOW), "in 2d");
        assert_eq!(due_word(NOW, NOW), "in 1m");
        assert_eq!(due_word(NOW - 30_000.0, NOW), "now");
        assert_eq!(due_word(NOW - 5.0 * MIN, NOW), "5m ago");
        assert_eq!(due_word(NOW - DAY, NOW), "1d ago");
        assert_eq!(
            due_word(NOW + 150_000.0, NOW),
            "in 3m",
            "2.5 minutes rounds up"
        );
    }

    #[test]
    fn reminders_come_first_soonest_on_top_then_plain_notes_newest_first() {
        let notes = vec![
            note("plain-old", None, 1.0),
            note("later", Some(NOW + 2.0 * HOUR), 2.0),
            note("plain-new", None, 3.0),
            note("soon", Some(NOW + MIN), 4.0),
            note("soon-newer", Some(NOW + MIN), 5.0),
        ];
        let ids: Vec<String> = sort_notes(&notes).into_iter().map(|n| n.id).collect();
        assert_eq!(
            ids,
            ["soon-newer", "soon", "later", "plain-new", "plain-old"]
        );
    }

    #[test]
    fn open_notes_leaves_out_the_done_ones() {
        let mut done = note("done", None, 1.0);
        done.done_at = Some(2.0);
        let ids: Vec<String> = open_notes(&[done, note("open", None, 1.0)])
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert_eq!(ids, ["open"]);
    }

    #[test]
    fn a_note_reads_from_the_wire_with_absent_fields_absent() {
        let n: QuickNote = serde_json::from_str(
            r#"{"id":"n-abcdefgh","text":"hi","createdAt":5,"repoId":"canopy"}"#,
        )
        .unwrap();
        assert_eq!(n.repo_id.as_deref(), Some("canopy"));
        assert_eq!(n.due, None);
        assert_eq!(n.created_at, 5.0);
    }

    #[test]
    fn n_and_eight_base32_characters() {
        let id = mint_note_id_from([0, 0, 0, 0, 0]);
        assert_eq!(id, "n-aaaaaaaa");
        assert!(is_note_id(&id));
        assert!(is_note_id(&mint_note_id()));
        // every bit lands: five bytes are forty bits, eight letters of five
        assert_eq!(mint_note_id_from([0xff; 5]), "n-77777777");
        assert_eq!(
            mint_note_id_from([0x08, 0x86, 0x42, 0x98, 0xe8]),
            "n-bcdefghi"
        );
    }

    /// `isNoteId(3)` is false there; a value that is not a string never
    /// reaches this one, since the routes take the id with `as_str`.
    #[test]
    fn a_work_id_a_bare_word_and_the_wrong_length_are_not_note_ids() {
        assert!(!is_note_id("w-aaaaaaaa"));
        assert!(!is_note_id("n-aaaa"));
        assert!(!is_note_id("notes"));
    }

    #[test]
    fn trims_keeps_inner_newlines_and_caps_the_length() {
        assert_eq!(
            note_text("  ask Eric\nabout atlas  "),
            "ask Eric\nabout atlas"
        );
        let long = note_text(&"x".repeat(QUICK_NOTE_CHARS + 20));
        assert_eq!(long.encode_utf16().count(), QUICK_NOTE_CHARS);
        assert_eq!(note_text("   "), "");
        // a cut through a pair: JavaScript keeps its first half, read as U+FFFD
        let cut = note_text(&format!("{}\u{1f600}", "x".repeat(QUICK_NOTE_CHARS - 1)));
        assert_eq!(cut.encode_utf16().count(), QUICK_NOTE_CHARS);
        assert!(cut.ends_with('\u{fffd}'));
        let whole = note_text(&format!("{}\u{1f600}x", "x".repeat(QUICK_NOTE_CHARS - 2)));
        assert!(whole.ends_with('\u{1f600}'));
    }

    #[test]
    fn reads_the_files_array_dropping_records_that_are_not_notes() {
        let v = serde_json::json!([
            { "id": "n-aaaaaaaa", "text": "one", "createdAt": 1 },
            { "id": "n-bbbbbbbb", "text": "two", "createdAt": 2, "repoId": "r1", "due": 50, "remindedAt": 60, "doneAt": 70 },
            { "id": "w-cccccccc", "text": "a work id", "createdAt": 3 },
            { "id": "n-dddddddd", "text": 4, "createdAt": 4 },
            { "id": "n-eeeeeeee", "text": "no time" },
            "nothing",
            { "id": "n-ffffffff", "text": "odd extras", "createdAt": 5, "repoId": 7, "due": "soon" },
        ]);
        assert_eq!(
            Value::from(parse_notes(&v)),
            serde_json::json!([
                { "id": "n-aaaaaaaa", "text": "one", "createdAt": 1 },
                { "id": "n-bbbbbbbb", "text": "two", "createdAt": 2, "repoId": "r1", "due": 50, "remindedAt": 60, "doneAt": 70 },
                { "id": "n-ffffffff", "text": "odd extras", "createdAt": 5 },
            ])
        );
    }

    #[test]
    fn anything_but_an_array_is_no_notes() {
        assert!(parse_notes(&Value::Null).is_empty());
        assert!(parse_notes(&serde_json::json!({ "notes": [] })).is_empty());
        assert!(parse_notes(&serde_json::json!("[]")).is_empty());
    }

    #[test]
    fn a_file_with_half_a_surrogate_pair_is_read_not_taken_for_no_notes() {
        let raw = r#"[{"id":"n-aaaaaaaa","text":"cut \ud83d","createdAt":1},
                      {"id":"n-bbbbbbbb","text":"whole 😀 \\ud83d A","createdAt":2},
                      {"id":"n-cccccccc","text":"low \ude00 end","createdAt":3}]"#;
        let notes = parse_file(raw);
        let texts: Vec<&str> = notes.iter().filter_map(|n| n["text"].as_str()).collect();
        assert_eq!(
            texts,
            [
                "cut \u{fffd}",
                "whole \u{1f600} \\ud83d A",
                "low \u{fffd} end"
            ]
        );
        assert!(parse_file("{ not json").is_empty());
        // numbers come back as JavaScript writes them
        let n = parse_file(r#"[{"id":"n-aaaaaaaa","text":"t","createdAt":1e12,"due":5.0}]"#);
        assert_eq!(
            serde_json::to_string(&n).unwrap(),
            r#"[{"id":"n-aaaaaaaa","text":"t","createdAt":1000000000000,"due":5}]"#
        );
    }

    fn rec(id: &str, extra: Value) -> Value {
        let mut n = serde_json::json!({ "id": id, "text": id, "createdAt": 1_000 });
        if let (Some(m), Value::Object(e)) = (n.as_object_mut(), extra) {
            m.extend(e);
        }
        n
    }

    #[test]
    fn a_reminder_whose_time_has_come_is_marked_once_a_done_a_reminded_or_a_later_one_is_left() {
        let list = vec![
            rec("n-duenow11", serde_json::json!({ "due": 100 })),
            rec("n-duelater", serde_json::json!({ "due": 500 })),
            rec(
                "n-remindd1",
                serde_json::json!({ "due": 50, "remindedAt": 60 }),
            ),
            rec("n-doneone1", serde_json::json!({ "due": 50, "doneAt": 70 })),
            rec("n-nodue111", serde_json::json!({})),
        ];
        let r = remind_due(&list, 200.0);
        let ids: Vec<&str> = r
            .delivered
            .iter()
            .filter_map(|n| n["id"].as_str())
            .collect();
        assert_eq!(ids, ["n-duenow11"]);
        assert_eq!(r.notes[0]["remindedAt"], 200);
        // the mark goes last, where the spread puts it
        assert_eq!(
            serde_json::to_string(&r.notes[0]).unwrap(),
            r#"{"id":"n-duenow11","text":"n-duenow11","createdAt":1000,"due":100,"remindedAt":200}"#
        );
        assert_eq!(r.notes[1..], list[1..]);
        // the same list again delivers nothing more
        assert!(remind_due(&r.notes, 300.0).delivered.is_empty());
        assert!(is_due(&list[0], 100.0) && !is_due(&list[0], 99.0));
    }

    #[test]
    fn the_list_is_the_same_object_when_nothing_came_due() {
        let list = vec![rec("n-duelater", serde_json::json!({ "due": 500 }))];
        let r = remind_due(&list, 200.0);
        assert!(matches!(r.notes, Cow::Borrowed(l) if std::ptr::eq(l, list.as_slice())));
    }
}
