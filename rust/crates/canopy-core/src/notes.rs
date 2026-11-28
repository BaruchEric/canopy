//! Quick notes and reminders (FR-020, `src/core/notes.ts`): the record and
//! the pure rules the CLI lists them by. The server half (the store, the
//! delivery of a reminder) is not ported yet.

use serde::Deserialize;

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

#[cfg(test)]
mod tests {
    use super::*;

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
