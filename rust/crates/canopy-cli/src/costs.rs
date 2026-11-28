//! `canopy costs` (`src/cli/costs.ts`): every backend's cost ledger and
//! claude-history archive as one sheet, the window's total, by service and
//! by repo, and with `--share` the part that went into repos marked as the
//! harness, week by week. The sums are canopy-core's `costsheet`,
//! `harnessshare`, `cards`, `backendid` and `historymerge`.

use crate::api::Caller;
use crate::ask::{Ask, AskError, backend_targets, has, is_origin, take};
use crate::out::Out;
use canopy_core::backendid::{Reg, qualify, split};
use canopy_core::cards::join_repos;
use canopy_core::costsheet::{CostLine, CostSheet, cost_sheet, tokens_word, usage_words, usd_word};
use canopy_core::harnessshare::{
    HARNESS_SHARE_MAX, HarnessShare, HarnessWeek, ShareTone, WEEKS, harness_names, harness_share,
    harness_weeks, pct, share_tone,
};
use canopy_core::historymerge::merge_history;
use canopy_core::js::{list_at, template, truthy_at};
use canopy_core::pathx::{js_trim_end, pad_end, pad_start};
use canopy_core::store::js_number;
use serde_json::{Map, Value};
use std::cell::Cell;

/// `COSTS_USAGE`.
pub const COSTS_USAGE: &str =
    "usage: canopy costs [--days 1|7|30] [--share] [--on NAME] [--backend URL]";

use crate::render::Paint as Palette;

/// `daysOf()`: 1, 7 or 30 from --days, 7 unset, None for anything else.
pub fn days_of(arg: Option<&str>) -> Option<usize> {
    match arg {
        None | Some("7") => Some(7),
        Some("1") => Some(1),
        Some("30") => Some(30),
        Some(_) => None,
    }
}

fn amount_word(line: &CostLine) -> String {
    let mut parts: Vec<String> = Vec::new();
    if line.usd > 0.0 {
        parts.push(usd_word(Some(line.usd)));
    }
    if line.est > 0.0 {
        parts.push(format!("≈ {}", usd_word(Some(line.est))));
    }
    if !parts.is_empty() {
        return parts.join(" + ");
    }
    if line.unpriced > 0.0 {
        "unpriced".into()
    } else {
        "$0.00".into()
    }
}

fn group_lines(lines: &[CostLine]) -> Vec<String> {
    if lines.is_empty() {
        return vec!["  nothing".into()];
    }
    lines
        .iter()
        .map(|line| {
            let amount = amount_word(line);
            let width = if amount == "unpriced" { 11 } else { 10 };
            let row = format!(
                "  {} {}  {}",
                pad_end(&line.label, 26),
                pad_start(&amount, width),
                usage_words(line.tokens, line.seconds, tokens_word)
            );
            js_trim_end(&row).to_string()
        })
        .collect()
}

/// `costLines()`: the window's total, then by service and by repo, the
/// first `limit` repos.
pub fn cost_lines(sheet: &CostSheet, days: usize, limit: usize) -> Vec<String> {
    let mut total = vec![usd_word(Some(sheet.usd))];
    if sheet.est > 0.0 {
        total.push(format!("≈ {}", usd_word(Some(sheet.est))));
    }
    if sheet.unpriced > 0.0 {
        total.push(format!("{} unpriced", js_number(sheet.unpriced)));
    }
    let window = if days == 1 {
        "today".to_string()
    } else {
        format!("{days} days")
    };
    let mut lines = vec![
        format!("{window}: {}", total.join(" + ")),
        "by service".into(),
    ];
    lines.extend(group_lines(&sheet.services));
    lines.push("by repo".into());
    let shown = &sheet.repos[..limit.min(sheet.repos.len())];
    lines.extend(group_lines(shown));
    if sheet.repos.len() > limit {
        lines.push(format!("  … and {} more", sheet.repos.len() - limit));
    }
    lines
}

fn paint_share(pal: Palette, value: &str, share: Option<f64>, max: f64) -> String {
    match share_tone(share, max) {
        Some(ShareTone::Rust) => pal.rust(value),
        Some(ShareTone::Moss) => pal.moss(value),
        None => value.to_string(),
    }
}

fn share_line_at(pal: Palette, share: &HarnessShare, max: f64) -> String {
    let dollars = share.usd.harness + share.usd.rest;
    let sessions = share.sessions.harness + share.sessions.rest;
    format!(
        "tooling {} of {} · {} of {} sessions",
        paint_share(pal, &pct(share.share), share.share, max),
        usd_word(Some(dollars)),
        paint_share(pal, &pct(share.session_share), share.session_share, max),
        js_number(sessions)
    )
}

/// `shareLine()`: "tooling 23% of $41.20 · 31% of 48 sessions".
#[cfg(test)]
fn share_line(pal: Palette, share: &HarnessShare) -> String {
    share_line_at(pal, share, HARNESS_SHARE_MAX)
}

/// `shareLines()`: the figure naming the tooling repos, then the weeks.
fn share_lines(
    pal: Palette,
    share: &HarnessShare,
    weeks: &[HarnessWeek],
    names: &[String],
    max: f64,
) -> Vec<String> {
    let label = if names.is_empty() {
        "(no repo is marked as tooling)".to_string()
    } else {
        format!("({})", names.join(", "))
    };
    let head = format!("{}  {label}", share_line_at(pal, share, max));
    if weeks.is_empty() {
        return vec![
            head,
            "  no week to show: claude-history has no spend in these repos".into(),
        ];
    }
    let mut lines = vec![
        head,
        format!(
            "{}  {}  {}  {}",
            pad_end("week", 10),
            pad_start("tooling", 9),
            pad_start("rest", 8),
            pad_start("share", 5)
        ),
    ];
    for (index, week) in weeks.iter().enumerate() {
        let last = index == weeks.len() - 1;
        let amount = |value: f64, width: usize| pad_start(&usd_word(Some(value)), width);
        let cell = paint_share(pal, &pad_start(&pct(week.share), 5), week.share, max);
        lines.push(format!(
            "{}  {}  {}  {cell}{}",
            pad_end(&week.from, 10),
            amount(week.harness, 9),
            amount(week.rest, 8),
            if last { "  so far" } else { "" }
        ));
    }
    lines
}

/// `qualifyOverview()`: an available overview's repos under the ids the
/// sheet holds.
fn qualify_overview(overview: Value, backend: &str, reg: &Reg) -> Value {
    if !truthy_at(&overview, "available") {
        return overview;
    }
    let mut overview = overview;
    if let Some(o) = overview.as_object_mut() {
        let repos: Map<String, Value> = o
            .get("repos")
            .and_then(Value::as_object)
            .map(|rs| {
                rs.iter()
                    .map(|(id, r)| (qualify(reg, backend, id), r.clone()))
                    .collect()
            })
            .unwrap_or_default();
        o.insert("repos".into(), Value::Object(repos));
    }
    overview
}

/// What one backend gave: its tree, its archive and its ledger, or why not.
enum Answer {
    Ready {
        name: String,
        tree: Value,
        history: Value,
        costs: Value,
    },
    Skipped {
        name: String,
        why: String,
    },
}

/// `costsCommand()`.
pub(crate) async fn costs_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    color: bool,
) -> Result<(), String> {
    let pal = Palette { color };
    let argv = args.clone();
    let backend_flag = args.iter().any(|a| a == "--backend");
    let on_flag = args.iter().any(|a| a == "--on");
    let given = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    let with_share = has(&mut args, "--share");
    let days_arg = take(&mut args, "--days");
    let days = days_of(days_arg.as_deref());
    let Some(days) = days.filter(|_| {
        !(days_arg.is_none() && argv.iter().any(|a| a == "--days")
            || backend_flag && given.is_none()
            || on_flag && on.is_none())
    }) else {
        return Err(COSTS_USAGE.into());
    };
    let flag_like = |v: &Option<String>| v.as_deref().is_some_and(|s| s.starts_with("--"));
    if flag_like(&given) || flag_like(&on) || !args.is_empty() {
        return Err(COSTS_USAGE.into());
    }
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let targets = backend_targets(ask, &home, given.is_some(), on.as_deref()).await?;
    let reg = Reg {
        home: targets.first().map(|t| t.name.clone()).unwrap_or_default(),
        names: targets.iter().map(|t| t.name.clone()).collect(),
    };
    let costs_path = format!("/api/costs?days={days}");
    let mut answers: Vec<Answer> = Vec::new();
    for t in &targets {
        // the three reads go out together, as Promise.all sends them, and
        // a failure is the first to come back, as Promise.all rejects
        let order = Cell::new(0u32);
        let stamp = |r: Result<Value, AskError>| {
            let n = order.get();
            order.set(n + 1);
            (n, r)
        };
        let (tree, history, costs) = tokio::join!(
            async { stamp(ask.ask(t, "GET", "/api/tree", None).await) },
            async { stamp(ask.ask(t, "GET", "/api/history?window=90d", None).await) },
            async { stamp(ask.ask(t, "GET", &costs_path, None).await) },
        );
        let answer = match (tree, history, costs) {
            ((_, Ok(tree)), (_, Ok(history)), (_, Ok(costs))) => Answer::Ready {
                name: t.name.clone(),
                tree,
                history,
                costs,
            },
            (tree, history, costs) => {
                let first = [tree, history, costs]
                    .into_iter()
                    .filter_map(|(n, r)| r.err().map(|e| (n, e)))
                    .min_by_key(|(n, _)| *n);
                Answer::Skipped {
                    name: t.name.clone(),
                    why: first
                        .map(|(_, e)| e.message().to_string())
                        .unwrap_or_default(),
                }
            }
        };
        answers.push(answer);
    }
    let ready: Vec<(&String, &Value, &Value, &Value)> = answers
        .iter()
        .filter_map(|a| match a {
            Answer::Ready {
                name,
                tree,
                history,
                costs,
            } => Some((name, tree, history, costs)),
            Answer::Skipped { .. } => None,
        })
        .collect();
    if ready.is_empty() {
        return Err("no backend answered".into());
    }
    let mut repos: Vec<Value> = Vec::new();
    let mut overviews: Vec<Value> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    for (name, tree, history, costs) in &ready {
        for repo in list_at(tree, "repos") {
            let mut r = repo.clone();
            if let Some(o) = r.as_object_mut() {
                let id = qualify(&reg, name, &template(o.get("id")));
                o.insert("id".into(), Value::String(id));
            }
            repos.push(r);
        }
        overviews.push(qualify_overview((*history).clone(), name, &reg));
        for row in list_at(costs, "rows") {
            let mut r = row.clone();
            if let Some(o) = r.as_object_mut() {
                let qid = match o.get("repoId") {
                    Some(Value::Null) => Value::Null,
                    id => Value::String(qualify(&reg, name, &template(id))),
                };
                o.insert("backend".into(), Value::String((*name).clone()));
                o.insert("qid".into(), qid);
            }
            rows.push(r);
        }
    }
    let cards = join_repos(&repos, &reg.names, |id| split(&reg, id));
    let history = merge_history(&overviews);
    let sheet = cost_sheet(&rows, history.as_ref(), days, &cards);
    for line in cost_lines(&sheet, days, 15) {
        if line == "by service" || line == "by repo" {
            out.line(pal.bold(&line));
        } else {
            out.line(line);
        }
    }
    if with_share {
        let share = harness_share(&sheet.repos, history.as_ref(), days, &cards);
        let weeks = harness_weeks(history.as_ref(), &cards, WEEKS);
        out.lines(share_lines(
            pal,
            &share,
            &weeks,
            &harness_names(&cards),
            HARNESS_SHARE_MAX,
        ));
    }
    for a in &answers {
        if let Answer::Skipped { name, why } = a {
            out.line(pal.dim(&format!("not counted: {name}: {why}")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
