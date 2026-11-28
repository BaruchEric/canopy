//! `canopy sweep` (FR-018, `src/cli/sweep.ts`): the idle shells, chats,
//! runs and PRs a backend offers for closing, and, with --yes, closing the
//! ones its sheet starts ticked, or every one it may close of the kinds
//! --kind names.

use crate::api::Caller;
use crate::ask::{Ask, Target, has, is_origin, take};
use crate::out::Out;
use canopy_core::js::{field, list_at, num_at, str_at, truthy_at};
use canopy_core::pathx::{js_trim, pad_end, pad_start};
use canopy_core::sweep::{SWEEP_KINDS, may_close};
use canopy_core::treelines::ago_f;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// `SWEEP_USAGE`.
pub const SWEEP_USAGE: &str =
    "usage: canopy sweep [--yes [--kind shell,chat,run,transcript,pr]] [--backend URL]";

fn kind(i: &Value) -> &str {
    str_at(i, "kind").unwrap_or("")
}

/// `sweepKeys()`: the keys --yes closes. With no kinds, the ones the sheet
/// starts ticked (`checked` and closable), which is never a PR. With kinds
/// named, every item of those kinds the sweep may close, ticked or not.
pub fn sweep_keys(items: &[Value], kinds: Option<&[String]>) -> Vec<String> {
    items
        .iter()
        .filter(|i| match kinds {
            Some(ks) => ks.iter().any(|k| k == kind(i)) && may_close(i),
            None => truthy_at(i, "closable") && truthy_at(i, "checked") && kind(i) != "pr",
        })
        .map(|i| field(i, "key"))
        .collect()
}

/// `parseKinds()`: the kinds --kind names, or what is wrong with them.
fn parse_kinds(text: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for word in text.split(',').map(js_trim).filter(|w| !w.is_empty()) {
        if !SWEEP_KINDS.contains(&word) {
            return Err(format!(
                "--kind takes {}, not {word}",
                SWEEP_KINDS.join(", ")
            ));
        }
        out.push(word.to_string());
    }
    if out.is_empty() {
        Err("--kind needs at least one kind".into())
    } else {
        Ok(out)
    }
}

/// `sweepBody()`: close each key only while a fresh plan lets an unticked
/// close take it.
pub fn sweep_body(keys: &[String]) -> Value {
    json!({ "keys": keys, "unticked": true })
}

/// `sweepTimeoutMs()`: 30 s plus 15 s a key, at most 10 minutes.
pub fn sweep_timeout_ms(keys: usize) -> u64 {
    (30_000 + 15_000 * keys as u64).min(10 * 60_000)
}

/// `planLines()`: the plan a kind at a time, `kind  where  idle  why`, with
/// a mark for what --yes would close.
pub fn plan_lines(items: &[Value], now: f64, kinds: Option<&[String]>) -> Vec<String> {
    let closes: HashSet<String> = sweep_keys(items, kinds).into_iter().collect();
    let mut out = Vec::new();
    for k in SWEEP_KINDS {
        for i in items.iter().filter(|x| kind(x) == *k) {
            let mark = if !truthy_at(i, "closable") {
                "-"
            } else if closes.contains(&field(i, "key")) {
                "x"
            } else {
                " "
            };
            let idle = num_at(i, "idleSince").unwrap_or(f64::NAN) / 1000.0;
            out.push(format!(
                "[{mark}] {} {} {}  {}",
                pad_end(k, 7),
                pad_end(&field(i, "where"), 28),
                pad_start(&ago_f(idle, now), 4),
                field(i, "why")
            ));
        }
    }
    out
}

/// `sweepCommand()`.
pub(crate) async fn sweep_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    now: f64,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    let yes = has(&mut args, "--yes");
    let kind_text = take(&mut args, "--kind");
    if !args.is_empty() {
        return Err(SWEEP_USAGE.into());
    }
    let kinds = kind_text.as_deref().map(parse_kinds).transpose()?;
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let target = Target::home(&home);
    let failed = |e: crate::ask::AskError| e.message().to_string();
    let info = ask
        .ask(&target, "GET", "/api/sweep", None)
        .await
        .map_err(failed)?;
    let items = list_at(&info, "items");
    let kinds = kinds.as_deref();
    if !yes {
        if items.is_empty() {
            out.line("nothing is idle enough to close");
            return Ok(());
        }
        out.lines(plan_lines(items, now, kinds));
        let n = sweep_keys(items, kinds).len();
        let with = kinds
            .map(|k| format!(" --kind {}", k.join(",")))
            .unwrap_or_default();
        out.line(format!("{n} would close with --yes{with}"));
        return Ok(());
    }
    let keys = sweep_keys(items, kinds);
    if keys.is_empty() {
        out.line("nothing to close");
        return Ok(());
    }
    let got = ask
        .ask_within(
            &target,
            "POST",
            "/api/sweep",
            Some(&sweep_body(&keys)),
            Duration::from_millis(sweep_timeout_ms(keys.len())),
        )
        .await
        .map_err(failed)?;
    let by_key: HashMap<String, &Value> = items.iter().map(|i| (field(i, "key"), i)).collect();
    let outcomes = list_at(&got, "outcomes");
    for o in outcomes {
        let what = match by_key.get(&field(o, "key")) {
            Some(i) => format!("{} {}", field(i, "kind"), field(i, "where")),
            None => field(o, "key"),
        };
        let why = if truthy_at(o, "why") {
            format!("  {}", field(o, "why"))
        } else {
            String::new()
        };
        out.line(format!("{} {what}{why}", pad_end(&field(o, "result"), 10)));
    }
    if outcomes
        .iter()
        .any(|o| str_at(o, "result") == Some("failed"))
    {
        out.failed = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::AskError;
    use crate::ask::tests::Fake;

    fn item(key: &str, kind: &str, over: Value) -> Value {
        let mut i = json!({"key": key, "kind": kind, "id": key, "repoId": null, "where": "w", "title": key, "idleSince": 0, "why": "idle", "closable": true, "checked": true, "handOnly": false, "auto": false});
        if let (Some(m), Some(o)) = (i.as_object_mut(), over.as_object()) {
            for (k, v) in o {
                m.insert(k.clone(), v.clone());
            }
        }
        i
    }

    fn kinds(ks: &[&str]) -> Vec<String> {
        ks.iter().map(|s| s.to_string()).collect()
    }

    fn items() -> Vec<Value> {
        vec![
            item("s1", "shell", json!({})),
            item("c1", "chat", json!({})),
            item("r1", "run", json!({})),
            item("p1", "pr", json!({"checked": false})),
            item("p2", "pr", json!({"checked": false, "handOnly": true})),
            item("s2", "shell", json!({"checked": false, "handOnly": true})),
            item("c2", "chat", json!({"closable": false})),
        ]
    }

    #[test]
    fn without_kinds_every_checked_closable_item_but_a_pr() {
        assert_eq!(sweep_keys(&items(), None), ["s1", "c1", "r1"]);
    }

    #[test]
    fn with_kinds_each_one_it_may_close() {
        assert_eq!(sweep_keys(&items(), Some(&kinds(&["shell"]))), ["s1"]);
        assert_eq!(
            sweep_keys(&items(), Some(&kinds(&["pr", "run"]))),
            ["r1", "p1"]
        );
        assert_eq!(sweep_keys(&items(), Some(&kinds(&["pr"]))), ["p1"]);
        let all = sweep_keys(&items(), Some(&kinds(&["shell", "chat", "pr"])));
        assert!(!all.contains(&"s2".to_string()) && !all.contains(&"p2".to_string()));
        assert!(!sweep_keys(&items(), Some(&kinds(&["chat"]))).contains(&"c2".to_string()));
        let outside = vec![item("o1", "outside", json!({"closable": false}))];
        assert!(sweep_keys(&outside, None).is_empty());
        assert!(sweep_keys(&outside, Some(&kinds(&["outside"]))).is_empty());
    }

    #[test]
    fn the_plan_marks_what_yes_would_close() {
        let items = vec![
            item("s1", "shell", json!({})),
            item("p1", "pr", json!({"checked": false})),
            item("p2", "pr", json!({"checked": false, "handOnly": true})),
            item("o1", "outside", json!({"closable": false})),
        ];
        let marks = |k: Option<&[String]>| -> Vec<String> {
            plan_lines(&items, 0.0, k)
                .iter()
                .map(|l| l[..3].to_string())
                .collect()
        };
        assert_eq!(marks(None), ["[x]", "[ ]", "[ ]", "[-]"]);
        assert_eq!(marks(Some(&kinds(&["pr"]))), ["[ ]", "[x]", "[ ]", "[-]"]);
        // the where padded to 28, a blank idle padded to 4, two spaces
        assert_eq!(
            plan_lines(&items[..1], 0.0, None),
            [format!("[x] shell   w{}idle", " ".repeat(27 + 1 + 4 + 2))]
        );
    }

    #[test]
    fn the_body_and_the_timeout() {
        assert_eq!(
            sweep_body(&kinds(&["pr:o/a#1", "shell:s1"])),
            json!({"keys": ["pr:o/a#1", "shell:s1"], "unticked": true})
        );
        assert_eq!(sweep_timeout_ms(1), 45_000);
        assert_eq!(sweep_timeout_ms(10), 180_000);
        assert_eq!(sweep_timeout_ms(1000), 600_000);
    }

    #[tokio::test]
    async fn yes_closes_and_a_failed_close_exits_one() {
        let fake = Fake(|_: &Target, m: &str, _: &str, _: Option<&Value>| {
            Ok::<Value, AskError>(if m == "GET" {
                json!({"items": [item("s1", "shell", json!({"where": "repo a"}))]})
            } else {
                json!({"outcomes": [{"key": "s1", "result": "failed", "why": "busy"}, {"key": "x9", "result": "closed"}]})
            })
        });
        let mut out = Out::default();
        let args = vec!["--yes".to_string()];
        sweep_cmd(args, &Caller::default(), &fake, &mut out, 0.0)
            .await
            .unwrap();
        assert_eq!(
            out.printed(),
            ["failed     shell repo a  busy", "closed     x9"]
        );
        assert!(out.failed);
        let mut out = Out::default();
        let bad = vec!["--kind".to_string(), "pr,nope".to_string()];
        assert_eq!(
            sweep_cmd(bad, &Caller::default(), &fake, &mut out, 0.0)
                .await
                .unwrap_err(),
            "--kind takes shell, chat, run, transcript, pr, outside, not nope"
        );
    }
}
