//! Branch work items (`src/core/work.ts`). What `canopy work` prints and
//! parses is here (the states, an id, the id a run branch carries, where an
//! item came from, a note's minute), and the state an item derives from
//! what the hubs know (`stateOf`), which `GET /api/work` reads. The store's
//! writes and the ledger of runs, branches and notes stay in the TypeScript.

use crate::js::field;
use serde_json::Value;

/// `WORK_STATES`.
pub const WORK_STATES: &[&str] = &["open", "working", "review", "landed", "dropped"];

/// `[a-z2-7]`, the base32 a work id is written in.
fn base32(c: u8) -> bool {
    c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c)
}

/// `isWorkId()`: `w-` and eight base32 letters.
pub fn is_work_id(v: &str) -> bool {
    v.len() == 10 && v.starts_with("w-") && v.bytes().skip(2).all(base32)
}

/// `workIdOf()`: the id a `run/<id>-<slug>` branch carries.
pub fn work_id_of(branch: Option<&str>) -> Option<String> {
    let rest = branch?.strip_prefix("run/")?;
    let id = rest.get(..10)?;
    let slug = rest.get(10..)?.strip_prefix('-')?;
    let slug_ok = !slug.is_empty()
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    (is_work_id(id) && slug_ok).then(|| id.to_string())
}

/// `fromWord()`: where an item came from, in a few words.
pub fn from_word(from: &Value) -> String {
    match from.get("kind").and_then(Value::as_str) {
        Some("note") => "a note".into(),
        Some("issue") => format!("{} issue {}", field(from, "service"), field(from, "key")),
        Some("coordinator") => format!(
            "coordinator {}, card {}",
            field(from, "run"),
            field(from, "card")
        ),
        Some("trigger") => format!("trigger event {}", field(from, "event")),
        // the switch hands the object back, which a template prints so
        _ => "[object Object]".into(),
    }
}

/// `noteStamp()`: a note's minute in UTC, `2026-11-27 18:05`.
pub fn note_stamp(at: f64) -> String {
    let ms = at as i64;
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let in_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        in_day / 3600,
        in_day % 3600 / 60
    )
}

/// The proleptic Gregorian date of a day count from 1970-01-01 (Howard
/// Hinnant's days_from_civil, run backwards).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// What a branch of a work item is now, as the hubs know it (`WorkFacts`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BranchFact {
    /// the landing record's state
    pub state: String,
    /// its queue entry's state
    pub land: Option<String>,
    /// its PR's status
    pub pr: Option<String>,
}

/// What the server knows of an item's runs and branches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkFacts {
    pub active: bool,
    pub branches: Vec<BranchFact>,
}

/// `stateOf()`: the state from the item's open or closed mark and the facts.
pub fn state_of<'a>(state: &'a str, closed: bool, facts: &WorkFacts) -> &'a str {
    if closed {
        return state;
    }
    let b = &facts.branches;
    if b.iter()
        .any(|x| x.land.as_deref() == Some("landed") || x.pr.as_deref() == Some("merged"))
    {
        return "landed";
    }
    if facts.active || b.iter().any(|x| x.state == "working") {
        return "working";
    }
    if b.iter().any(|x| {
        x.state == "ready"
            || x.state == "stopped"
            || x.land.is_some()
            || x.pr.as_deref() == Some("open")
    }) {
        return "review";
    }
    "open"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_and_the_id_a_branch_carries() {
        assert!(is_work_id("w-abcdefg2"));
        assert!(!is_work_id("w-abcdefg1"));
        assert!(!is_work_id("w-abcdefgh2"));
        assert_eq!(
            work_id_of(Some("run/w-abcdefg2-fix-it")).as_deref(),
            Some("w-abcdefg2")
        );
        assert_eq!(work_id_of(Some("run/w-abcdefg2-")), None);
        assert_eq!(work_id_of(Some("run/w-abcdefg2-Fix")), None);
        assert_eq!(work_id_of(Some("main")), None);
        assert_eq!(work_id_of(None), None);
    }

    #[test]
    fn where_an_item_came_from() {
        assert_eq!(from_word(&json!({"kind": "note"})), "a note");
        assert_eq!(
            from_word(&json!({"kind": "issue", "service": "github", "key": "a/b#3"})),
            "github issue a/b#3"
        );
        assert_eq!(
            from_word(&json!({"kind": "coordinator", "run": "r1", "card": "c2"})),
            "coordinator r1, card c2"
        );
        assert_eq!(
            from_word(&json!({"kind": "trigger", "event": "e1"})),
            "trigger event e1"
        );
    }

    #[test]
    fn a_note_is_stamped_to_the_minute_in_utc() {
        assert_eq!(note_stamp(1_764_300_000_000.0), "2025-11-28 03:20");
        assert_eq!(note_stamp(0.0), "1970-01-01 00:00");
        assert_eq!(note_stamp(951_782_400_000.0), "2000-02-29 00:00");
    }

    fn fact(state: &str, land: Option<&str>, pr: Option<&str>) -> BranchFact {
        BranchFact {
            state: state.into(),
            land: land.map(Into::into),
            pr: pr.map(Into::into),
        }
    }

    #[test]
    fn state_of_derived_from_the_runs_and_branches_in_order() {
        let f = |active: bool, branches: Vec<BranchFact>| WorkFacts { active, branches };
        assert_eq!(state_of("open", false, &f(false, vec![])), "open");
        assert_eq!(state_of("open", false, &f(true, vec![])), "working");
        assert_eq!(
            state_of("open", false, &f(false, vec![fact("working", None, None)])),
            "working"
        );
        assert_eq!(
            state_of("open", false, &f(false, vec![fact("ready", None, None)])),
            "review"
        );
        assert_eq!(
            state_of(
                "open",
                false,
                &f(false, vec![fact("ready", Some("red"), None)])
            ),
            "review"
        );
        assert_eq!(
            state_of("open", false, &f(false, vec![fact("stopped", None, None)])),
            "review"
        );
        assert_eq!(
            state_of(
                "open",
                false,
                &f(false, vec![fact("ready", None, Some("open"))])
            ),
            "review"
        );
        assert_eq!(
            state_of(
                "open",
                false,
                &f(
                    false,
                    vec![fact("nothing", None, None), fact("uncommitted", None, None)]
                )
            ),
            "open"
        );
        assert_eq!(
            state_of(
                "open",
                false,
                &f(false, vec![fact("ready", Some("landed"), None)])
            ),
            "landed"
        );
        assert_eq!(
            state_of(
                "open",
                false,
                &f(false, vec![fact("ready", None, Some("merged"))])
            ),
            "landed"
        );
        // a run going beats a sent-back branch: the fix is on its way
        assert_eq!(
            state_of(
                "open",
                false,
                &f(true, vec![fact("ready", Some("conflict"), None)])
            ),
            "working"
        );
    }

    #[test]
    fn state_of_a_closed_item_keeps_its_state_whatever_the_facts_say() {
        let busy = WorkFacts {
            active: true,
            branches: vec![fact("working", None, None)],
        };
        assert_eq!(state_of("dropped", true, &busy), "dropped");
        assert_eq!(state_of("landed", true, &WorkFacts::default()), "landed");
    }
}
