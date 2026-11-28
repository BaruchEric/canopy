//! The share of dollars and Claude sessions that went into repos marked as
//! the harness (`src/core/harnessshare.ts`), in the part `canopy costs
//! --share` prints: the percent and its tone, the marked cards, the share
//! over the window and the weeks table with its local Mondays. `barWidths`,
//! `cardsOf`, `harnessSlot` and `weekKey` are not here yet.

use crate::cards::RepoCard;
use crate::costsheet::{CostLine, window_from};
use crate::js::{template, truthy, truthy_at};
use serde_json::Value;
use std::collections::HashMap;

/// `WEEKS`: the weeks the table shows.
pub const WEEKS: usize = 8;
/// `HARNESS_SHARE_MAX`: Yegge's default warning line, in percent.
pub const HARNESS_SHARE_MAX: f64 = 25.0;

/// `Math.round()`: the nearer whole number, a half toward +∞.
fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `pct()`: a share as a whole percent, a dash when nothing was spent.
pub fn pct(share: Option<f64>) -> String {
    match share {
        None => "—".into(),
        Some(s) => format!("{}%", crate::store::js_number(round(s * 100.0))),
    }
}

/// `shareTone()`'s answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareTone {
    Rust,
    Moss,
}

/// `shareTone()`: the rounded percent the user sees against the line; a
/// line of zero turns it off.
pub fn share_tone(share: Option<f64>, max: f64) -> Option<ShareTone> {
    let share = share?;
    if max <= 0.0 {
        return None;
    }
    Some(if round(share * 100.0) >= max {
        ShareTone::Rust
    } else {
        ShareTone::Moss
    })
}

/// Dollars or sessions split between the harness and the rest.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Split {
    pub harness: f64,
    pub rest: f64,
}

/// `HarnessShare`.
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessShare {
    /// dollars, reported plus estimated, in the window
    pub usd: Split,
    /// Claude sessions started in the window, from the archive
    pub sessions: Split,
    /// harness dollars over total dollars; None when nothing was spent
    pub share: Option<f64>,
    /// harness sessions over total sessions; None when none started
    pub session_share: Option<f64>,
}

/// `HarnessWeek`.
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessWeek {
    /// the week's Monday, YYYY-MM-DD
    pub from: String,
    pub harness: f64,
    pub rest: f64,
    /// harness dollars over the total; None when nothing was spent
    pub share: Option<f64>,
}

/// `isHarnessCard()`: a card counts as the harness if any backend's
/// checkout is marked.
pub fn is_harness_card(card: &RepoCard) -> bool {
    card.checkouts
        .iter()
        .any(|r| r.get("harness") == Some(&Value::Bool(true)))
}

/// `harnessNames()`: the marked cards' names in board order.
pub fn harness_names(cards: &[RepoCard]) -> Vec<String> {
    cards
        .iter()
        .filter(|c| is_harness_card(c))
        .map(|c| c.name.clone())
        .collect()
}

fn share_of(harness: f64, rest: f64) -> Option<f64> {
    let total = harness + rest;
    (total > 0.0).then(|| harness / total)
}

/// An overview's slice for a checkout, when it has one.
fn archive_of<'a>(history: &'a Value, checkout: &Value) -> Option<&'a Value> {
    history
        .get("repos")?
        .get(template(checkout.get("id")))
        .filter(|h| truthy(Some(h)))
}

/// A day array's entries from `from` on, summed left to right.
fn sum_from(list: Option<&Value>, from: usize) -> f64 {
    list.and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .skip(from)
        .fold(0.0, |a, b| a + b.as_f64().unwrap_or(0.0))
}

/// `harnessShare()`: the window's dollars by the sheet's repo lines, and
/// sessions by each card's largest checkout over the selected archive days.
pub fn harness_share(
    repos: &[CostLine],
    history: Option<&Value>,
    days: usize,
    cards: &[RepoCard],
) -> HarnessShare {
    let marked: HashMap<&str, bool> = cards
        .iter()
        .map(|c| (c.key.as_str(), is_harness_card(c)))
        .collect();
    let mut usd = Split::default();
    for line in repos {
        let amount = line.usd + line.est;
        if marked.get(line.key.as_str()) == Some(&true) {
            usd.harness += amount;
        } else {
            usd.rest += amount;
        }
    }
    let mut sessions = Split::default();
    if let Some(history) = history.filter(|h| truthy_at(h, "available")) {
        let from = window_from(history, days);
        for card in cards {
            let mut largest = 0f64;
            for checkout in &card.checkouts {
                let Some(archive) = archive_of(history, checkout) else {
                    continue;
                };
                let count = sum_from(archive.get("daySessions"), from);
                largest = if largest.is_nan() || count.is_nan() {
                    f64::NAN
                } else {
                    largest.max(count)
                };
            }
            if is_harness_card(card) {
                sessions.harness += largest;
            } else {
                sessions.rest += largest;
            }
        }
    }
    HarnessShare {
        usd,
        sessions,
        share: share_of(usd.harness, usd.rest),
        session_share: share_of(sessions.harness, sessions.rest),
    }
}

/// `harnessWeeks()`: the archive's dollars by local week, each card by its
/// largest checkout over the whole overview, the newest `weeks` weeks.
pub fn harness_weeks(
    history: Option<&Value>,
    cards: &[RepoCard],
    weeks: usize,
) -> Vec<HarnessWeek> {
    let Some(history) = history.filter(|h| truthy_at(h, "available")) else {
        return Vec::new();
    };
    let days: Vec<String> = history
        .get("days")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|d| template(Some(d)))
        .collect();
    let mut order: Vec<(String, Split)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for day in &days {
        let from = week_from(day);
        if !at.contains_key(&from) {
            at.insert(from.clone(), order.len());
            order.push((from, Split::default()));
        }
    }
    for card in cards {
        // the checkout that leads over the whole overview
        let mut lead: Option<(&Value, f64)> = None;
        for checkout in &card.checkouts {
            let Some(archive) = archive_of(history, checkout) else {
                continue;
            };
            let usd = sum_from(archive.get("days"), 0);
            if usd > lead.map_or(0.0, |(_, u)| u) {
                lead = Some((archive, usd));
            }
        }
        let Some((archive, _)) = lead else {
            continue;
        };
        let amounts = archive.get("days").and_then(Value::as_array);
        let harness = is_harness_card(card);
        for (index, day) in days.iter().enumerate() {
            let Some(&i) = at.get(&week_from(day)) else {
                continue;
            };
            let amount = match amounts.and_then(|a| a.get(index)) {
                None | Some(Value::Null) => 0.0,
                Some(v) => v.as_f64().unwrap_or(f64::NAN),
            };
            if harness {
                order[i].1.harness += amount;
            } else {
                order[i].1.rest += amount;
            }
        }
    }
    let skip = order.len().saturating_sub(weeks);
    let newest = if weeks == 0 {
        &order[order.len()..]
    } else {
        &order[skip..]
    };
    newest
        .iter()
        .map(|(from, s)| HarnessWeek {
            from: from.clone(),
            harness: s.harness,
            rest: s.rest,
            share: share_of(s.harness, s.rest),
        })
        .collect()
}

/// `Number(part)` for a part of a YYYY-MM-DD, truncated as a Date's fields
/// are: empty is 0, a word NaN.
fn date_part(s: &str) -> f64 {
    let t = crate::pathx::js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let numeric = t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !numeric {
        return f64::NAN;
    }
    t.parse::<f64>().map_or(f64::NAN, f64::trunc)
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `z` days after 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `weekFrom()`: the local Monday that starts this date's week. The
/// arithmetic is the calendar's, so the zone never moves it.
pub fn week_from(day: &str) -> String {
    let mut parts = day.split('-').map(date_part);
    let year = parts.next().unwrap_or(0.0);
    let month = parts.next().unwrap_or(1.0);
    let date = parts.next().unwrap_or(1.0);
    if !(year.is_finite() && month.is_finite() && date.is_finite()) {
        return "NaN-NaN-NaN".into();
    }
    // a Date takes a two-digit year as the 1900s, and lets a month or a day
    // run over into the next
    let year = if (0.0..=99.0).contains(&year) {
        year + 1900.0
    } else {
        year
    } as i64;
    let m0 = month as i64 - 1;
    let days =
        days_from_civil(year + m0.div_euclid(12), m0.rem_euclid(12) + 1, 1) + date as i64 - 1;
    // 1970-01-01 was a Thursday
    let weekday = (days + 4).rem_euclid(7);
    let (y, m, d) = civil_from_days(days - (weekday + 6) % 7);
    format!("{y}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests;
