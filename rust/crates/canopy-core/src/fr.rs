//! Feature numbers (FR-076), the pure half (`src/core/fr.ts`, all of it): a
//! repo's FEATURES.md gives each entry `### FR-NNN · Title`, a number is
//! reserved before it is written anywhere as a git ref `refs/canopy/fr/NNN`
//! on a commit with no files, and this file has the names, how a list
//! reads, the next number, and a reservation's words. The git half is the
//! CLI's `fr.rs`.

use crate::pathx::{js_squash_ws, js_trim};
use serde::Serialize;

/// the list, at a repo's root
pub const FR_FILE: &str = "FEATURES.md";

/// where reservations live in a repo's refs, one ref per number
pub const FR_REFS: &str = "refs/canopy/fr";

/// a number as git and the list write it: three digits, more when it needs them
fn padded(n: u64) -> String {
    format!("{n:03}")
}

/// `FR-076`
pub fn fr_id(n: u64) -> String {
    format!("FR-{}", padded(n))
}

/// `refs/canopy/fr/076`
pub fn fr_ref(n: u64) -> String {
    format!("{FR_REFS}/{}", padded(n))
}

/// The number a reservation's ref holds, or None for a ref that is not one.
pub fn fr_of_ref(r: &str) -> Option<u64> {
    let digits = r.strip_prefix("refs/canopy/fr/")?;
    if digits.is_empty() || digits.len() > 6 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// `\w` as JavaScript reads it without the u flag.
fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The number at the start of `s` when it is one to six digits and no word
/// character follows: `(\d{1,6})\b`.
fn number_at(s: &str) -> Option<u64> {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    if end == 0 || end > 6 {
        return None;
    }
    if s[end..].chars().next().is_some_and(word_char) {
        return None;
    }
    s[..end].parse().ok()
}

/// The numbers a list gives entries to, in the file's order: one per
/// `### FR-NNN` heading. A number that is only mentioned is not here.
pub fn fr_entries(text: &str) -> Vec<u64> {
    // a line starts where JavaScript's multiline ^ does
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .filter_map(|line| {
            let rest = line.strip_prefix("###")?;
            let after = rest.trim_start_matches([' ', '\t']);
            if after.len() == rest.len() {
                return None;
            }
            number_at(after.strip_prefix("FR-")?)
        })
        .collect()
}

/// The numbers two entries share, lowest first.
pub fn fr_duplicates(text: &str) -> Vec<u64> {
    let mut seen = std::collections::HashSet::new();
    let mut twice = std::collections::BTreeSet::new();
    for n in fr_entries(text) {
        if !seen.insert(n) {
            twice.insert(n);
        }
    }
    twice.into_iter().collect()
}

/// The highest number a text names anywhere, a heading or not, since a
/// number quoted in an entry's body is taken too. 0 when it names none.
pub fn fr_highest(text: &str) -> u64 {
    let mut top = 0;
    for (i, _) in text.match_indices("FR-") {
        if text[..i].chars().next_back().is_some_and(word_char) {
            continue;
        }
        if let Some(n) = number_at(&text[i + 3..]) {
            top = top.max(n);
        }
    }
    top
}

/// The next free number: one past the highest that any copy of the list
/// names or any reservation holds.
pub fn fr_next<S: AsRef<str>>(texts: &[S], reserved: &[u64]) -> u64 {
    let texts = texts.iter().map(|t| fr_highest(t.as_ref()));
    texts.chain(reserved.iter().copied()).max().unwrap_or(0) + 1
}

/// Who holds a reservation and what for.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct FrHolder {
    /// what the number is for, as the session said it; may be empty
    pub title: String,
    /// the session's handle, such as `claude-f0351f` or a person's name
    pub by: String,
    /// the branch it was reserved on
    pub branch: String,
    /// canopy's name for the backend it was reserved on, when it ran on one
    pub backend: String,
}

/// The first `max` UTF-16 units of `s`, as `slice(0, max)` keeps them; a
/// pair cut in half is dropped, since a Rust string cannot hold half.
pub fn utf16_prefix(s: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

/// one line: no line break may cut a field short
fn one_line(v: &str, max: usize) -> String {
    utf16_prefix(js_trim(&js_squash_ws(v)), max)
}

/// A reservation's commit message: the id and the title, then who holds
/// it. `nonce` is any text no other reservation has: two sessions that
/// reserve the same number in the same second with the same words would
/// otherwise write the same commit, and origin would take both pushes.
pub fn fr_message(n: u64, holder: &FrHolder, nonce: &str) -> String {
    let title = one_line(&holder.title, 200);
    let head = if title.is_empty() {
        fr_id(n)
    } else {
        format!("{} {title}", fr_id(n))
    };
    [
        head,
        String::new(),
        format!("by: {}", one_line(&holder.by, 80)),
        format!("branch: {}", one_line(&holder.branch, 200)),
        format!("backend: {}", one_line(&holder.backend, 80)),
        format!("nonce: {}", one_line(nonce, 80)),
        String::new(),
    ]
    .join("\n")
}

/// What a reservation's commit message says. A message canopy did not
/// write reads as empty fields.
pub fn parse_fr_message(message: &str) -> FrHolder {
    let mut lines = message.split('\n');
    let first = lines.next().unwrap_or("");
    let rest: Vec<&str> = lines.collect();
    let field = |name: &str| -> String {
        let lead = format!("{name}: ");
        rest.iter()
            .find(|l| l.starts_with(&lead))
            .map(|l| js_trim(&l[lead.len()..]).to_string())
            .unwrap_or_default()
    };
    // `/^FR-\d+\s*/`
    let title = match first.strip_prefix("FR-") {
        Some(after) if after.starts_with(|c: char| c.is_ascii_digit()) => {
            let digits = after.trim_start_matches(|c: char| c.is_ascii_digit());
            digits.trim_start_matches(crate::pathx::js_ws)
        }
        _ => first,
    };
    FrHolder {
        title: js_trim(title).to_string(),
        by: field("by"),
        branch: field("branch"),
        backend: field("backend"),
    }
}

/// `shared`: origin holds the same ref. `here`: only this machine knows,
/// since it was made while origin did not answer or the repo has none.
/// `clash`: origin gave the number to another session while this one was
/// made offline, so this one must take a new number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FrWhere {
    Shared,
    Here,
    Clash,
}

/// One reservation as `canopy fr` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrReservation {
    pub n: u64,
    pub id: String,
    pub holder: FrHolder,
    /// when it was made, unix ms
    pub at: i64,
    #[serde(rename = "where")]
    pub where_: FrWhere,
    /// the default branch's list has an entry with this number, so the
    /// reservation has done its job
    pub listed: bool,
}

/// One reservation in a line.
pub fn fr_line(r: &FrReservation, ago: impl Fn(i64) -> String) -> String {
    let h = &r.holder;
    let who: Vec<String> = [
        h.by.clone(),
        if h.branch.is_empty() {
            String::new()
        } else {
            format!("on {}", h.branch)
        },
        if h.backend.is_empty() {
            String::new()
        } else {
            format!("({})", h.backend)
        },
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect();
    let who = who.join(" ");
    let where_ = match r.where_ {
        FrWhere::Here => "this machine only",
        FrWhere::Clash => "origin gave this number to another session: take a new one",
        FrWhere::Shared => "",
    };
    let state: Vec<&str> = [if r.listed { "in the list" } else { "" }, where_]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let state = state.join(", ");
    let title = if h.title.is_empty() {
        "(no title)"
    } else {
        &h.title
    };
    format!(
        "{}  {title}{}  · {}{}",
        r.id,
        if who.is_empty() {
            String::new()
        } else {
            format!("  · {who}")
        },
        ago(r.at),
        if state.is_empty() {
            String::new()
        } else {
            format!("  · {state}")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "# Feature requests: shop

## Open

### FR-012 · A cart that remembers
P2 · added 2026-11-01 · source: Eric
Follow-up to FR-009, and see FR-020 in the plan.

## In Progress

## Shipped

### FR-009 · A cart
P1 · added 2026-10-01 · source: Eric · shipped 2026-10-09

### FR-003 · Sign in
P1 · added 2026-09-01 · source: Eric · shipped 2026-09-03

## Declined
";

    #[test]
    fn the_id_and_the_ref_pad_to_three_digits_and_grow_past_them() {
        assert_eq!(fr_id(7), "FR-007");
        assert_eq!(fr_id(76), "FR-076");
        assert_eq!(fr_id(1204), "FR-1204");
        assert_eq!(fr_ref(76), "refs/canopy/fr/076");
        assert_eq!(fr_of_ref("refs/canopy/fr/076"), Some(76));
        assert_eq!(fr_of_ref("refs/canopy/fr/1204"), Some(1204));
    }

    #[test]
    fn a_ref_that_is_not_a_reservation_reads_as_none() {
        for r in [
            "refs/heads/main",
            "refs/canopy/fr/",
            "refs/canopy/fr/abc",
            "refs/canopy/fr/076/x",
            "refs/canopy/other/076",
        ] {
            assert_eq!(fr_of_ref(r), None, "{r}");
        }
    }

    #[test]
    fn a_list_gives_its_entries_numbers_in_order_headings_only() {
        assert_eq!(fr_entries(LIST), [12, 9, 3]);
        assert!(fr_entries("").is_empty());
    }

    #[test]
    fn its_highest_number_counts_one_that_is_only_mentioned() {
        assert_eq!(fr_highest(LIST), 20);
        assert_eq!(fr_highest("no numbers here"), 0);
        // a word before it or a seventh digit after it is not a number
        assert_eq!(fr_highest("XFR-099 FR-1234567 FR-5x (FR-004)"), 4);
    }

    #[test]
    fn says_which_numbers_two_entries_share() {
        assert!(fr_duplicates(LIST).is_empty());
        let twice = format!(
            "{LIST}\n### FR-009 · A cart, again\n\n### FR-003 · Sign in, again\n\n### FR-003 · And again\n"
        );
        assert_eq!(fr_duplicates(&twice), [3, 9]);
    }

    #[test]
    fn canopys_own_list_gives_every_number_once() {
        let file = format!("{}/{FR_FILE}", crate::version::canopy_dir());
        let text = std::fs::read_to_string(file).unwrap();
        assert!(fr_duplicates(&text).is_empty());
    }

    #[test]
    fn the_next_is_one_past_the_highest_any_copy_names_or_any_reservation_holds() {
        let none: [&str; 0] = [];
        assert_eq!(fr_next(&none, &[]), 1);
        assert_eq!(fr_next(&[LIST], &[]), 21);
        assert_eq!(
            fr_next(&[LIST, "### FR-031 · In another worktree"], &[]),
            32
        );
        assert_eq!(fr_next(&[LIST], &[40, 22]), 41);
    }

    fn holder() -> FrHolder {
        FrHolder {
            title: "Feature numbers that cannot clash".into(),
            by: "claude-f0351f".into(),
            branch: "fr-reserve".into(),
            backend: "mac".into(),
        }
    }

    #[test]
    fn a_reservations_words_go_into_a_commit_message_and_come_back() {
        let message = fr_message(76, &holder(), "n-1");
        assert_eq!(
            message.split('\n').next().unwrap(),
            "FR-076 Feature numbers that cannot clash"
        );
        assert_eq!(parse_fr_message(&message), holder());
    }

    #[test]
    fn they_stay_on_one_line_each_whatever_the_title_holds() {
        let h = FrHolder {
            title: "two\nlines\nby: someone else".into(),
            ..holder()
        };
        let message = fr_message(76, &h, "n-1");
        assert_eq!(
            parse_fr_message(&message),
            FrHolder {
                title: "two lines by: someone else".into(),
                ..holder()
            }
        );
    }

    #[test]
    fn two_reservations_of_one_number_never_read_the_same() {
        assert_ne!(
            fr_message(76, &holder(), "a"),
            fr_message(76, &holder(), "b")
        );
    }

    #[test]
    fn a_message_canopy_did_not_write_reads_as_empty_fields() {
        assert_eq!(
            parse_fr_message("something else"),
            FrHolder {
                title: "something else".into(),
                ..Default::default()
            }
        );
        assert_eq!(parse_fr_message(""), FrHolder::default());
    }

    #[test]
    fn a_line_says_who_holds_it_since_when_and_where_it_stands() {
        let r = FrReservation {
            n: 76,
            id: "FR-076".into(),
            holder: holder(),
            at: 1,
            where_: FrWhere::Shared,
            listed: false,
        };
        let ago = |_| "3h ago".to_string();
        assert_eq!(
            fr_line(&r, ago),
            "FR-076  Feature numbers that cannot clash  · claude-f0351f on fr-reserve (mac)  · 3h ago"
        );
        let here = FrReservation {
            where_: FrWhere::Here,
            listed: true,
            ..r.clone()
        };
        assert!(fr_line(&here, ago).ends_with("· 3h ago  · in the list, this machine only"));
        let clash = FrReservation {
            where_: FrWhere::Clash,
            ..r.clone()
        };
        assert!(fr_line(&clash, ago).contains("take a new one"));
        let bare = FrReservation {
            holder: FrHolder::default(),
            ..r
        };
        assert_eq!(fr_line(&bare, ago), "FR-076  (no title)  · 3h ago");
    }

    #[test]
    fn a_reservation_lists_as_json_in_the_typescripts_key_order() {
        let r = FrReservation {
            n: 6,
            id: "FR-006".into(),
            holder: holder(),
            at: 1_767_225_600_000,
            where_: FrWhere::Here,
            listed: false,
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"n":6,"id":"FR-006","holder":{"title":"Feature numbers that cannot clash","by":"claude-f0351f","branch":"fr-reserve","backend":"mac"},"at":1767225600000,"where":"here","listed":false}"#
        );
    }
}
