//! Quick notes and reminders (FR-020, `src/core/notes.ts`): the record, the
//! pure rules the CLI lists them by, and the file's records read back as the
//! server reads them. The rest of the server half (the writes, the delivery
//! of a reminder) is not ported yet.

use serde::Deserialize;
use serde_json::{Map, Value};

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

/// `timeOf()`: a positive finite number, kept as it was written.
fn time_of(v: Option<&Value>) -> Option<Value> {
    let v = v?;
    let n = v.as_f64()?;
    (n.is_finite() && n > 0.0).then(|| v.clone())
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
}
