//! The parts of `src/core/secretwire.ts` the CLI's `canopy secrets` reads:
//! the limits it names, and a batch's counts and a file's unread lines in
//! the words the page and the CLI share. The wire itself (requests,
//! replies, acts, proposals) is not ported yet.

use crate::js::{field, join, list_at, number_string};
use serde_json::Value;

/// `LIMITS.proposals`: the store takes a batch of at most this many
pub const PROPOSALS: usize = 200;
/// `LIMITS.pending`: one scan holds at most this many values
pub const PENDING: usize = 500;
/// `LIMITS.passphrase`: the fewest characters a machine key's passphrase
/// may have
pub const PASSPHRASE: usize = 8;

/// `ProposeCount`: what the store did with a batch of proposals; `in_step`
/// is absent from a writer older than 2026-11-10.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ProposeCount {
    pub added: f64,
    pub dropped: f64,
    pub in_step: Option<f64>,
}

/// `proposedWords()`: a batch's counts in words, the same on the page and
/// in the CLI.
pub fn proposed_words(c: &ProposeCount) -> String {
    let in_step = c.in_step.unwrap_or(0.0);
    let step = if in_step > 0.0 {
        format!(", {} already in step", number_string(in_step))
    } else {
        String::new()
    };
    let dropped = if c.dropped > 0.0 {
        format!(", {} dropped", number_string(c.dropped))
    } else {
        String::new()
    };
    format!(
        "{} waiting for approval{step}{dropped}",
        number_string(c.added)
    )
}

/// `skippedWords()`: a file's lines that are not pairs, by number, as one
/// note: `{path, lines}` as the scan answers it.
pub fn skipped_words(s: &Value) -> String {
    let lines = list_at(s, "lines");
    let shown = join(&lines[..lines.len().min(12)], ", ");
    let more = if lines.len() > 12 {
        format!(" and {} more", lines.len() - 12)
    } else {
        String::new()
    };
    let many = lines.len() != 1;
    let pick = |a: &'static str, b: &'static str| if many { a } else { b };
    format!(
        "{}: line{} {shown}{more} {} not KEY=value, so {} left out; a sink of this file leaves {} as {}",
        field(s, "path"),
        pick("s", ""),
        pick("are", "is"),
        pick("they were", "it was"),
        pick("them", "it"),
        pick("they are", "it is"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_batchs_counts_read_the_same_on_the_page_and_in_the_cli_and_an_older_writers_answer_has_no_in_step_count()
     {
        let c = |added: f64, dropped: f64, in_step: Option<f64>| ProposeCount {
            added,
            dropped,
            in_step,
        };
        assert_eq!(proposed_words(&c(3.0, 0.0, None)), "3 waiting for approval");
        assert_eq!(
            proposed_words(&c(1.0, 2.0, Some(140.0))),
            "1 waiting for approval, 140 already in step, 2 dropped"
        );
        assert_eq!(
            proposed_words(&c(0.0, 0.0, Some(5.0))),
            "0 waiting for approval, 5 already in step"
        );
    }

    #[test]
    fn names_a_files_unread_lines_by_number_one_or_many_and_stops_listing_after_twelve() {
        assert_eq!(
            skipped_words(&json!({"path": "/d/.env", "lines": [8]})),
            "/d/.env: line 8 is not KEY=value, so it was left out; a sink of this file leaves it as it is"
        );
        assert_eq!(
            skipped_words(&json!({"path": "/d/.env", "lines": [8, 11]})),
            "/d/.env: lines 8, 11 are not KEY=value, so they were left out; a sink of this file leaves them as they are"
        );
        let long =
            skipped_words(&json!({"path": "/d/.env", "lines": (1..=15).collect::<Vec<_>>()}));
        assert!(
            long.contains(
                "lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 and 3 more are not KEY=value"
            )
        );
    }
}
