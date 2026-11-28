//! The costs view's sums (`src/core/costsheet.ts`), in the part `canopy
//! costs` prints: the dollar and token words, a card's Claude dollars from
//! the claude-history archive (`claudeByCard`, `claudeLeads`), and the
//! sheet's total, its lines by service and by repo. A line's detail, the
//! by-run lines, the session lines and `windowStart` are not here yet. Rows
//! and overviews stay JSON, as the backends serve them.

use crate::cards::RepoCard;
use crate::costs::service_name;
use crate::js::{str_at, template, to_fixed, truthy, truthy_at};
use crate::store::js_number;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;

/// `usdWord()`: dollars the way claude-history prints them, cents until
/// the number is big enough that they stop meaning anything.
pub fn usd_word(n: Option<f64>) -> String {
    match n {
        None => "n/a".into(),
        Some(n) if n >= 100.0 => format!("${}", to_fixed(n, 0)),
        Some(n) => format!("${}", to_fixed(n, 2)),
    }
}

/// `tokensWord()`: a token count in a compact form.
pub fn tokens_word(n: f64) -> String {
    if n >= 1_000_000_000.0 {
        format!("{}B", to_fixed(n / 1_000_000_000.0, 2))
    } else if n >= 1_000_000.0 {
        format!("{}M", to_fixed(n / 1_000_000.0, 1))
    } else if n >= 1_000.0 {
        format!("{}k", to_fixed(n / 1_000.0, 1))
    } else {
        js_number(n)
    }
}

/// `Math.round()`: the nearer whole number, a half toward +∞.
fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `usageWords()`: a line's usage in words, "12.3k tokens · 4.2 min".
pub fn usage_words(tokens: f64, seconds: f64, fmt_tokens: impl Fn(f64) -> String) -> String {
    let mut parts: Vec<String> = Vec::new();
    if tokens > 0.0 {
        parts.push(format!("{} tokens", fmt_tokens(tokens)));
    }
    if seconds > 0.0 {
        parts.push(if seconds < 60.0 {
            format!("{} s", js_number(round(seconds)))
        } else {
            format!("{} min", to_fixed(seconds / 60.0, 1))
        });
    }
    parts.join(" · ")
}

/// One line of the sheet (`CostLine`), without its detail.
#[derive(Debug, Clone, PartialEq)]
pub struct CostLine {
    pub key: String,
    pub label: String,
    /// dollars a provider reported: claude-history's and the ledger's
    pub usd: f64,
    /// dollars the price list estimates for usage nobody priced
    pub est: f64,
    pub tokens: f64,
    pub seconds: f64,
    /// rows with usage and no dollars, reported or estimated
    pub unpriced: f64,
    /// the newest row's time, 0 for none
    pub at: f64,
}

impl CostLine {
    /// `line(key, label)`: nothing counted yet.
    pub fn new(key: &str, label: &str) -> Self {
        CostLine {
            key: key.into(),
            label: label.into(),
            usd: 0.0,
            est: 0.0,
            tokens: 0.0,
            seconds: 0.0,
            unpriced: 0.0,
            at: 0.0,
        }
    }
}

/// The sheet (`CostSheet`) without its by-run lines.
#[derive(Debug, Clone, PartialEq)]
pub struct CostSheet {
    pub usd: f64,
    pub est: f64,
    pub unpriced: f64,
    /// false when claude-history did not answer: Claude is then canopy's
    /// own runs
    pub archive: bool,
    pub services: Vec<CostLine>,
    pub repos: Vec<CostLine>,
}

/// `+= v` for a field a row may lack: missing is NaN, null is 0.
fn plus(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    }
}

/// `v ?? 0` for a number.
fn or_zero(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => 0.0,
        other => plus(other),
    }
}

/// `Math.max(a, b)`: NaN wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `add()`: a row's dollars, or its estimate, or one more unpriced row,
/// and its tokens, seconds and time.
fn add(l: &mut CostLine, r: &Value) {
    match r.get("usd") {
        Some(Value::Null) => match r.get("estUsd") {
            Some(Value::Null) => l.unpriced += 1.0,
            est => l.est += plus(est),
        },
        usd => l.usd += plus(usd),
    }
    l.tokens += or_zero(r.get("tokens").and_then(|t| t.get("total")));
    l.seconds += or_zero(r.get("seconds"));
    l.at = js_max(l.at, plus(r.get("at")));
}

/// A comparator's number as an order; NaN reads as equal, as sort takes it.
fn order(d: f64) -> Ordering {
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

fn worth(l: &CostLine) -> f64 {
    l.usd + l.est
}

/// `byWorth`: the costliest first, then the busiest, then the newest.
fn by_worth(a: &CostLine, b: &CostLine) -> Ordering {
    let d = worth(b) - worth(a);
    if d != 0.0 && !d.is_nan() {
        return order(d);
    }
    let d = b.tokens + b.seconds - (a.tokens + a.seconds);
    if d != 0.0 && !d.is_nan() {
        return order(d);
    }
    order(b.at - a.at)
}

/// A card the archive has Claude dollars for in the window, with the
/// checkout whose archive holds them (`ClaudeLead`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeLead {
    pub key: String,
    pub name: String,
    /// the checkout's repo id, backend-qualified
    pub id: String,
    pub usd: f64,
}

/// The archive's dollars of a slice of a day array, summed left to right.
fn sum_from(days: Option<&Value>, from: usize) -> f64 {
    days.and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .skip(from)
        .fold(0.0, |a, b| a + or_zero(Some(b)))
}

/// Where a window of `days` begins in an overview's day arrays.
pub(crate) fn window_from(history: &Value, days: usize) -> usize {
    let len = history
        .get("days")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    len.saturating_sub(days)
}

/// `claudeLeads()`: every card with Claude dollars in the window, the
/// costliest first. A card takes its largest checkout's figure.
pub fn claude_leads(history: Option<&Value>, days: usize, cards: &[RepoCard]) -> Vec<ClaudeLead> {
    let Some(history) = history.filter(|h| truthy_at(h, "available")) else {
        return Vec::new();
    };
    let from = window_from(history, days);
    let repos = history.get("repos");
    let mut out: Vec<ClaudeLead> = Vec::new();
    for card in cards {
        let mut best: Option<ClaudeLead> = None;
        for r in &card.checkouts {
            let id = template(r.get("id"));
            let Some(h) = repos.and_then(|rs| rs.get(&id)).filter(|h| truthy(Some(h))) else {
                continue;
            };
            let usd = sum_from(h.get("days"), from);
            if usd > best.as_ref().map_or(0.0, |b| b.usd) {
                best = Some(ClaudeLead {
                    key: card.key.clone(),
                    name: card.name.clone(),
                    id,
                    usd,
                });
            }
        }
        out.extend(best);
    }
    out.sort_by(|a, b| order(b.usd - a.usd));
    out
}

/// `claudeByCard()`: the archive's Claude dollars per card over the last
/// `days` local days, the costliest first.
pub fn claude_by_card(
    history: Option<&Value>,
    days: usize,
    cards: &[RepoCard],
) -> Vec<(String, f64)> {
    claude_leads(history, days, cards)
        .into_iter()
        .map(|l| (l.key, l.usd))
        .collect()
}

const NO_REPO: &str = "\u{0}none";

/// Lines kept in the order they were first set, as a Map keeps them.
#[derive(Default)]
struct Lines {
    list: Vec<CostLine>,
    at: HashMap<String, usize>,
}

impl Lines {
    /// `map.get(key) ?? line(key, label)`, set in the map.
    fn entry(&mut self, key: &str, label: impl FnOnce() -> String) -> &mut CostLine {
        let i = match self.at.get(key) {
            Some(&i) => i,
            None => {
                self.list.push(CostLine::new(key, &label()));
                self.at.insert(key.to_string(), self.list.len() - 1);
                self.list.len() - 1
            }
        };
        &mut self.list[i]
    }
}

/// `costSheet()`: every backend's ledger rows (each with its `backend` and
/// its backend-qualified repo id `qid`) and the archive as lines by service
/// and by repo. Claude's dollars come from the archive, so a ledger Claude
/// row on a card the archive has a figure for is not added again.
pub fn cost_sheet(
    rows: &[Value],
    history: Option<&Value>,
    days: usize,
    cards: &[RepoCard],
) -> CostSheet {
    let archive = history.and_then(|h| h.get("available")) == Some(&Value::Bool(true));
    let mut card_of: HashMap<String, usize> = HashMap::new();
    for (i, c) in cards.iter().enumerate() {
        for r in &c.checkouts {
            card_of.insert(template(r.get("id")), i);
        }
    }
    let claude = claude_by_card(history, days, cards);
    let mut services = Lines::default();
    let mut repos = Lines::default();
    let mut claude_line = CostLine::new("claude:anthropic", "Claude Code");
    for (key, usd) in &claude {
        claude_line.usd += usd;
        let name = cards
            .iter()
            .find(|c| c.key == *key)
            .map_or_else(|| key.clone(), |c| c.name.clone());
        repos.entry(key, || name).usd = *usd;
    }
    for r in rows {
        let card = str_at(r, "qid")
            .filter(|q| !q.is_empty())
            .and_then(|q| card_of.get(q))
            .map(|&i| &cards[i]);
        let service = r.get("service");
        let provider = r.get("provider");
        let is = |v: Option<&Value>, s: &str| v.and_then(Value::as_str) == Some(s);
        // claude-history indexes every Claude Code transcript for a repo;
        // its totals do not separate providers, so all matching Claude rows
        // overlap
        let archived_claude =
            is(service, "claude") && card.is_some_and(|c| claude.iter().any(|(k, _)| *k == c.key));
        if archived_claude {
            // the archive's dollars stand for this row; its tokens still count
            claude_line.tokens += or_zero(r.get("tokens").and_then(|t| t.get("total")));
            claude_line.at = js_max(claude_line.at, plus(r.get("at")));
            continue;
        }
        let sk = format!("{}:{}", template(service), template(provider));
        if is(service, "claude") && is(provider, "anthropic") {
            add(&mut claude_line, r);
        } else {
            let label = || {
                let name = service
                    .and_then(Value::as_str)
                    .and_then(service_name)
                    .unwrap_or("undefined");
                format!("{name} · {}", template(provider))
            };
            add(services.entry(&sk, label), r);
        }
        let repo_name = r.get("repoName");
        let rk = match card {
            Some(c) => c.key.clone(),
            None if truthy(repo_name) => format!("name:{}", template(repo_name)),
            None => NO_REPO.to_string(),
        };
        let label = || match card {
            Some(c) => c.name.clone(),
            None => match repo_name {
                None | Some(Value::Null) => "no repo".to_string(),
                v => template(v),
            },
        };
        add(repos.entry(&rk, label), r);
    }
    let mut service_lines: Vec<CostLine> = Vec::new();
    if claude_line.usd > 0.0 || claude_line.at > 0.0 {
        service_lines.push(claude_line);
    }
    let mut others = services.list;
    others.sort_by(by_worth);
    service_lines.extend(others);
    let mut repo_lines = repos.list;
    repo_lines.sort_by(by_worth);
    CostSheet {
        usd: service_lines.iter().fold(0.0, |a, l| a + l.usd),
        est: service_lines.iter().fold(0.0, |a, l| a + l.est),
        unpriced: service_lines.iter().fold(0.0, |a, l| a + l.unpriced),
        archive,
        services: service_lines,
        repos: repo_lines,
    }
}

#[cfg(test)]
mod tests;
