//! `canopy library sync` (`src/cli/libsync.ts`): where the Library sync
//! stands on a backend, a pull now, or a join (`--seed`, `--adopt`), over
//! the backend's API. The rest of `canopy library` goes to the engine
//! (`library.rs`). The merge itself (`src/core/libsync.ts`) is the server's
//! and is not ported; this reads its status as JSON.
//!
//! The backend is `--backend`, else $CANOPY_API, else 127.0.0.1:7850, at
//! that one address: the backends list is not read.

use crate::api::Caller;
use crate::ask::{Ask, AskError, Target, shift, take};
use crate::out::Out;
use canopy_core::js::{
    list_at, number_of, number_string, round, str_at, template, truthy, truthy_at,
};
use serde_json::{Value, json};
use std::time::Duration;

/// `LIBRARY_SYNC_USAGE`.
pub const LIBRARY_SYNC_USAGE: &str = "usage: canopy library sync [--status | --seed | --adopt BACKEND | --accept BACKEND] [--backend URL]";

/// A join or a pull may take this long.
const SYNC_TIMEOUT: Duration = Duration::from_millis(60_000);

/// `isLibrarySync()`: whether `canopy library <args>` is this command and
/// not the engine's: "sync" first once `--root` and `--backend` (each with
/// the word after it) are out.
pub fn is_library_sync(args: &[String]) -> bool {
    let mut rest = args.to_vec();
    take(&mut rest, "--root");
    take(&mut rest, "--backend");
    rest.first().is_some_and(|w| w == "sync")
}

/// A value as JavaScript's arithmetic reads it; a missing one is NaN.
fn arith(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_of(s),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

/// `ago()`: seconds under 90, minutes under an hour and a half, else hours.
fn ago(at: f64, now: f64) -> String {
    let r = round((now - at) / 1000.0);
    // Math.max(0, NaN) is NaN, where f64::max would give 0
    let s = if r.is_nan() || r > 0.0 { r } else { 0.0 };
    if s < 90.0 {
        format!("{}s ago", number_string(s))
    } else if s < 5400.0 {
        format!("{}m ago", number_string(round(s / 60.0)))
    } else {
        format!("{}h ago", number_string(round(s / 3600.0)))
    }
}

/// `x ?? fallback` read as a template prints `x`.
fn or_else(v: Option<&Value>, fallback: impl FnOnce() -> String) -> String {
    match v {
        None | Some(Value::Null) => fallback(),
        some => template(some),
    }
}

/// `s.slice(n)` by UTF-16 units.
fn slice_from(s: &str, n: usize) -> String {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= n {
            return s[i..].to_string();
        }
        units += c.len_utf16();
    }
    String::new()
}

/// `syncLines()`: the status as lines, the mode and join, then a line per
/// other backend.
pub fn sync_lines(st: &Value, now: f64) -> Vec<String> {
    let joined = match st.get("joined") {
        j @ Some(o) if truthy(j) => {
            let from = if truthy(o.get("from")) {
                format!(" from {}", template(o.get("from")))
            } else {
                String::new()
            };
            format!("joined by {}{from}", template(o.get("how")))
        }
        _ => "not joined (--seed on the first backend, --adopt BACKEND on the rest)".into(),
    };
    let me = or_else(st.get("self"), || "(no self in the config)".into());
    let mut out = vec![format!(
        "library sync on {me}: {}, {joined}",
        template(st.get("mode"))
    )];
    if truthy_at(st, "error") {
        out.push(format!("  stopped: {}", template(st.get("error"))));
    }
    let peers = list_at(st, "peers");
    for p in peers {
        let when = match p.get("at") {
            Some(Value::Null) => "not pulled yet".into(),
            at => format!("pulled {}", ago(arith(at), now)),
        };
        let dry = truthy_at(p, "dry");
        let how = or_else(p.get("held"), || {
            or_else(p.get("away"), || {
                format!(
                    "{} {}, {} {}",
                    if dry { "would take" } else { "took" },
                    template(p.get("taken")),
                    if dry { "would delete" } else { "deleted" },
                    template(p.get("deleted"))
                )
            })
        });
        out.push(format!("  {}: {when}, {how}", template(p.get("name"))));
        let kept = list_at(p, "kept");
        if !kept.is_empty() {
            let names: Vec<String> = kept
                .iter()
                .map(|k| slice_from(k.as_str().unwrap_or(""), "cat:".len()))
                .collect();
            out.push(format!(
                "    kept while their folders have projects: {}",
                names.join(", ")
            ));
        }
    }
    if str_at(st, "mode") != Some("off") && peers.is_empty() {
        out.push("  no other backend in the config's backends".into());
    }
    out
}

/// `librarySyncCommand()`.
pub async fn library_sync_cmd(
    argv: Vec<String>,
    caller: &Caller,
    client: &impl Ask,
    o: &mut Out,
    now: f64,
) -> Result<(), String> {
    let mut args = argv;
    take(&mut args, "--root");
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    let target = Target::home(&home);
    let failed = |e: AskError| match e {
        AskError::Unreachable(m) => format!("the backend did not answer: {m}"),
        other => other.message().to_string(),
    };
    shift(&mut args); // "sync"
    let adopt = take(&mut args, "--adopt");
    let accept = take(&mut args, "--accept");
    let seed = args.iter().any(|a| a == "--seed");
    let status = args.iter().any(|a| a == "--status");
    let left = args
        .iter()
        .filter(|a| *a != "--seed" && *a != "--status")
        .count();
    let picked = [adopt.is_some(), accept.is_some(), seed, status]
        .iter()
        .filter(|b| **b)
        .count();
    if left > 0 || picked > 1 || adopt.as_deref() == Some("") || accept.as_deref() == Some("") {
        return Err(LIBRARY_SYNC_USAGE.into());
    }
    let st = if status {
        client
            .ask(&target, "GET", "/api/library/sync/status", None)
            .await
            .map_err(failed)?
    } else {
        let body = match (adopt, accept) {
            (Some(b), _) => json!({"action": "adopt", "backend": b}),
            (_, Some(b)) => json!({"action": "accept", "backend": b}),
            _ => json!({"action": if seed { "seed" } else { "pull" }}),
        };
        client
            .ask_within(
                &target,
                "POST",
                "/api/library/sync",
                Some(&body),
                SYNC_TIMEOUT,
            )
            .await
            .map_err(failed)?
    };
    o.lines(sync_lines(&st, now));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;
    use std::sync::Mutex;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn is_this_command_only_as_the_first_word_after_the_flags() {
        assert!(is_library_sync(&args(&["sync"])));
        assert!(is_library_sync(&args(&[
            "--root", "/x", "sync", "--status"
        ])));
        assert!(is_library_sync(&args(&[
            "--backend",
            "http://mini:7850",
            "sync"
        ])));
        assert!(!is_library_sync(&args(&["git", "sync"])));
        assert!(!is_library_sync(&args(&["--root", "sync", "index"])));
    }

    #[test]
    fn the_status_in_lines() {
        let st = json!({
            "mode": "on",
            "self": "mini",
            "joined": {"how": "adopt", "from": "mac", "at": 1},
            "error": null,
            "peers": [
                {"name": "mac", "url": "https://mac.example", "at": 100_000 - 30_000, "ok": 70_000, "away": null, "held": null, "taken": 3, "deleted": 1, "kept": ["cat:apps"], "dry": false},
                {"name": "gpd", "url": null, "at": null, "ok": null, "away": null, "held": null, "taken": 0, "deleted": 0, "kept": [], "dry": false},
            ],
        });
        assert_eq!(
            sync_lines(&st, 100_000.0),
            [
                "library sync on mini: on, joined by adopt from mac",
                "  mac: pulled 30s ago, took 3, deleted 1",
                "    kept while their folders have projects: apps",
                "  gpd: not pulled yet, took 0, deleted 0",
            ]
        );
        let mut mac = st["peers"][0].clone();
        mac["kept"] = json!([]);
        mac["held"] = json!("mac would delete 30 of 30 entries; --accept mac");
        mac["dry"] = json!(true);
        let mut held = st.clone();
        held["joined"] = Value::Null;
        held["peers"] = json!([mac]);
        assert_eq!(
            sync_lines(&held, 100_000.0),
            [
                "library sync on mini: on, not joined (--seed on the first backend, --adopt BACKEND on the rest)",
                "  mac: pulled 30s ago, mac would delete 30 of 30 entries; --accept mac",
            ]
        );
    }

    #[test]
    fn ago_counts_seconds_then_minutes_then_hours() {
        assert_eq!(ago(0.0, 89_000.0), "89s ago");
        assert_eq!(ago(0.0, 90_000.0), "2m ago");
        assert_eq!(ago(0.0, 5_399_000.0), "90m ago");
        assert_eq!(ago(0.0, 5_400_000.0), "2h ago");
        assert_eq!(ago(10_000.0, 0.0), "0s ago", "a clock behind reads now");
        assert_eq!(
            ago(f64::NAN, 0.0),
            "NaNh ago",
            "as Math.max(0, NaN) leaves it"
        );
    }

    #[test]
    fn off_with_no_self_says_so_and_a_dry_peer_says_would() {
        let st = json!({"mode": "off", "self": null, "joined": null, "error": "categories.json did not parse", "peers": [
            {"name": "mac", "at": 0, "away": null, "held": null, "taken": 2, "deleted": 0, "kept": [], "dry": true},
            {"name": "gpd", "at": 0, "away": "away (not answering)", "held": null, "taken": 0, "deleted": 0, "kept": [], "dry": false}]});
        assert_eq!(
            sync_lines(&st, 7_200_000.0),
            [
                "library sync on (no self in the config): off, not joined (--seed on the first backend, --adopt BACKEND on the rest)",
                "  stopped: categories.json did not parse",
                "  mac: pulled 2h ago, would take 2, would delete 0",
                "  gpd: pulled 2h ago, away (not answering)",
            ]
        );
        let lonely = json!({"mode": "dry", "self": "mini", "joined": {"how": "seed", "at": 1}, "error": null, "peers": []});
        assert_eq!(
            sync_lines(&lonely, 0.0),
            [
                "library sync on mini: dry, joined by seed",
                "  no other backend in the config's backends",
            ]
        );
    }

    async fn run(
        argv: &[&str],
    ) -> (
        Result<(), String>,
        Out,
        Vec<(String, String, Option<Value>)>,
    ) {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(
            |t: &Target, method: &str, path: &str, body: Option<&Value>| {
                seen.lock().unwrap().push((
                    format!("{} {method}", t.urls.join(",")),
                    path.to_string(),
                    body.cloned(),
                ));
                if t.urls[0].ends_with(":1") {
                    return Err(AskError::Unreachable(format!(
                        "{}: ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
                        t.urls[0]
                    )));
                }
                if path == "/api/library/sync" {
                    return Err(AskError::Refused {
                        message: "librarySync is off".into(),
                        status: 409,
                    });
                }
                Ok(
                    json!({"mode": "off", "self": "scratch", "joined": null, "peers": [], "error": null}),
                )
            },
        );
        let caller = Caller {
            env_api: Some("http://api:7850/".into()),
            ..Default::default()
        };
        let mut o = Out::default();
        let r = library_sync_cmd(args(argv), &caller, &fake, &mut o, 0.0).await;
        (r, o, seen.into_inner().unwrap())
    }

    #[tokio::test]
    async fn the_status_is_a_get_and_everything_else_a_post_with_its_action() {
        let (r, o, seen) = run(&["sync", "--status"]).await;
        assert_eq!(r, Ok(()));
        assert_eq!(
            o.printed(),
            [
                "library sync on scratch: off, not joined (--seed on the first backend, --adopt BACKEND on the rest)"
            ]
        );
        assert_eq!(
            seen[0].0, "http://api:7850 GET",
            "$CANOPY_API, its slash gone"
        );
        let (r, _, seen) = run(&[
            "--root",
            "/x",
            "sync",
            "--adopt",
            "mac",
            "--backend",
            "http://b:2",
        ])
        .await;
        assert_eq!(r, Err("librarySync is off".into()));
        assert_eq!(seen[0].0, "http://b:2 POST");
        assert_eq!(
            seen[0].2,
            Some(json!({"action": "adopt", "backend": "mac"}))
        );
        let (_, _, seen) = run(&["sync", "--accept", "mac"]).await;
        assert_eq!(
            seen[0].2,
            Some(json!({"action": "accept", "backend": "mac"}))
        );
        let (_, _, seen) = run(&["sync", "--seed"]).await;
        assert_eq!(seen[0].2, Some(json!({"action": "seed"})));
        let (_, _, seen) = run(&["sync"]).await;
        assert_eq!(seen[0].2, Some(json!({"action": "pull"})));
        let (_, _, seen) = run(&["sync", "--adopt"]).await;
        assert_eq!(
            seen[0].2,
            Some(json!({"action": "pull"})),
            "--adopt with nothing after it goes, as take() takes it"
        );
    }

    #[tokio::test]
    async fn two_picks_a_stray_word_or_an_empty_name_is_the_usage() {
        for a in [
            &["sync", "--seed", "--status"][..],
            &["sync", "now"],
            &["sync", "--adopt", ""],
            &["sync", "--accept", "", "--seed"],
            &["sync", "--adopt", "a", "--accept", "b"],
        ] {
            let (r, o, seen) = run(a).await;
            assert_eq!(r, Err(LIBRARY_SYNC_USAGE.into()), "{a:?}");
            assert!(o.text.is_empty() && seen.is_empty());
        }
    }

    #[tokio::test]
    async fn a_backend_that_does_not_answer_says_so() {
        let (r, _, _) = run(&["sync", "--status", "--backend", "http://127.0.0.1:1"]).await;
        assert_eq!(
            r,
            Err("the backend did not answer: http://127.0.0.1:1: ECONNREFUSED: Unable to connect. Is the computer able to access the url?".into())
        );
    }
}
