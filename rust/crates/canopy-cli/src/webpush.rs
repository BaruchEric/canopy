//! `canopy push test | ls` (`src/cli/push.ts`, FR-042): one push to every
//! browser subscribed on a backend, and the list of those browsers, over
//! the backend's API. `canopy push <repo>` is git's push and lives in
//! main.rs; a repo folder named test or ls is pushed as ./test or ./ls.
//!
//! The backend is `--backend`, else $CANOPY_API, else 127.0.0.1:7850, at
//! that one address.

use crate::api::Caller;
use crate::ask::{Ask, AskError, Target, shift, take};
use crate::out::Out;
use canopy_core::js::{list_at, number_string, round, template, truthy, truthy_at};
use canopy_core::pathx::pad_end;
use serde_json::Value;

/// `PUSH_USAGE`.
pub const PUSH_USAGE: &str = "usage: canopy push test [--backend URL] | ls [--backend URL]";

/// `PUSH_WORDS`: the words push's subcommands answer to.
pub const PUSH_WORDS: &[&str] = &["test", "ls"];

/// A number as JavaScript's arithmetic reads a JSON value; NaN for a
/// missing one.
fn arith(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::String(s)) => canopy_core::js::number_of(s),
        _ => f64::NAN,
    }
}

/// `when()`: how long ago, in seconds, minutes, hours or days.
fn when(ms: f64, now: f64) -> String {
    let r = round((now - ms) / 1000.0);
    // Math.max(0, NaN) is NaN, and Math.max(0, -0) is 0
    let s = if r.is_nan() || r > 0.0 { r } else { 0.0 };
    if s < 60.0 {
        format!("{}s ago", number_string(s))
    } else if s < 3600.0 {
        format!("{}m ago", number_string(round(s / 60.0)))
    } else if s < 86_400.0 {
        format!("{}h ago", number_string(round(s / 3600.0)))
    } else {
        format!("{}d ago", number_string(round(s / 86_400.0)))
    }
}

/// `pushLines()`: the key's standing, then one line per browser: device,
/// backend, when it last heard a push, its standing.
pub fn push_lines(list: &Value, now: f64) -> Vec<String> {
    let head = if truthy_at(list, "vapid") {
        format!("push key: ready ({})", template(list.get("subject")))
    } else if truthy_at(list, "why") {
        format!("push key: none ({})", template(list.get("why")))
    } else {
        "push key: none".to_string()
    };
    let entries = list_at(list, "entries");
    if entries.is_empty() {
        return vec![head, "no browser has turned push on".into()];
    }
    let mut out = vec![head];
    for e in entries {
        let who = if truthy(e.get("device")) {
            template(e.get("device"))
        } else {
            template(e.get("client"))
        };
        let failures = template(e.get("failures"));
        let standing = if truthy_at(e, "stale") {
            format!("stale ({failures} failures)")
        } else if truthy_at(e, "failures") {
            let s = if arith(e.get("failures")) == 1.0 {
                ""
            } else {
                "s"
            };
            format!("{failures} failure{s}")
        } else {
            "ok".into()
        };
        out.push(format!(
            "{} {} used {} {standing}",
            pad_end(&who, 24),
            pad_end(&template(e.get("backend")), 10),
            pad_end(&when(arith(e.get("usedAt")), now), 8),
        ));
    }
    out
}

/// `testLine()`: what went where.
pub fn test_line(t: &Value) -> String {
    let (sent, failed, gone) = (
        arith(t.get("sent")),
        arith(t.get("failed")),
        arith(t.get("gone")),
    );
    let total = sent + failed + gone;
    if total == 0.0 {
        return "no browser has turned push on".into();
    }
    let mut parts = vec![format!(
        "sent to {} of {}",
        template(t.get("sent")),
        number_string(total)
    )];
    if truthy_at(t, "failed") {
        parts.push(format!("{} failed", template(t.get("failed"))));
    }
    if truthy_at(t, "gone") {
        parts.push(format!("{} gone (dropped)", template(t.get("gone"))));
    }
    parts.join(", ")
}

/// `pushCommand()`.
pub async fn push_cmd(
    argv: Vec<String>,
    caller: &Caller,
    client: &impl Ask,
    o: &mut Out,
    now: f64,
) -> Result<(), String> {
    let mut args = argv;
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    let target = Target::home(&home);
    let failed = |e: AskError| match e {
        AskError::Unreachable(m) => format!("the backend did not answer: {m}"),
        other => other.message().to_string(),
    };
    let word = shift(&mut args);
    let Some(word) = word.filter(|w| args.is_empty() && PUSH_WORDS.contains(&w.as_str())) else {
        return Err(PUSH_USAGE.into());
    };
    if word == "ls" {
        let list = client
            .ask(&target, "GET", "/api/push", None)
            .await
            .map_err(failed)?;
        o.lines(push_lines(&list, now));
        return Ok(());
    }
    let got = client
        .ask(&target, "POST", "/api/push/test", None)
        .await
        .map_err(failed)?;
    o.line(test_line(&got));
    if arith(got.get("failed")) > 0.0 {
        o.failed = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;
    use serde_json::json;

    fn entry() -> Value {
        json!({"client": "0123456789abcdef", "device": "Eric's iPhone", "backend": "mini", "createdAt": 0, "usedAt": 1_000_000 - 90_000, "failures": 0, "stale": false})
    }

    #[test]
    fn says_the_keys_standing_then_one_line_per_browser() {
        assert_eq!(
            push_lines(
                &json!({"vapid": true, "subject": "mailto:a@b", "entries": []}),
                1_000_000.0
            ),
            [
                "push key: ready (mailto:a@b)",
                "no browser has turned push on"
            ]
        );
        let mut other = entry();
        other["client"] = json!("fedcba9876543210");
        other["device"] = json!("");
        other["backend"] = json!("mac");
        other["failures"] = json!(3);
        other["stale"] = json!(true);
        let lines = push_lines(
            &json!({"vapid": true, "subject": "mailto:a@b", "entries": [entry(), other]}),
            1_000_000.0,
        );
        assert_eq!(
            lines[1],
            "Eric's iPhone            mini       used 2m ago   ok"
        );
        assert_eq!(
            lines[2],
            "fedcba9876543210         mac        used 2m ago   stale (3 failures)"
        );
        assert_eq!(
            push_lines(
                &json!({"vapid": false, "subject": "mailto:a@b", "why": "read-only", "entries": []}),
                0.0
            )[0],
            "push key: none (read-only)"
        );
    }

    #[test]
    fn counts_what_went_where() {
        assert_eq!(
            test_line(&json!({"sent": 0, "failed": 0, "gone": 0, "entries": []})),
            "no browser has turned push on"
        );
        assert_eq!(
            test_line(&json!({"sent": 2, "failed": 0, "gone": 0, "entries": []})),
            "sent to 2 of 2"
        );
        assert_eq!(
            test_line(&json!({"sent": 1, "failed": 1, "gone": 1, "entries": []})),
            "sent to 1 of 3, 1 failed, 1 gone (dropped)"
        );
    }

    #[test]
    fn a_failure_count_and_an_age_read_in_their_own_units() {
        let mut one = entry();
        one["failures"] = json!(1);
        one["usedAt"] = json!(0);
        let lines = push_lines(
            &json!({"vapid": false, "entries": [one]}),
            3.0 * 86_400_000.0,
        );
        assert_eq!(lines[0], "push key: none");
        assert!(
            lines[1].ends_with("used 3d ago   1 failure"),
            "{}",
            lines[1]
        );
        assert_eq!(when(0.0, 59_000.0), "59s ago");
        assert_eq!(when(0.0, 3_599_000.0), "60m ago");
        assert_eq!(when(0.0, 86_399_000.0), "24h ago");
        assert_eq!(when(5_000.0, 0.0), "0s ago");
    }

    #[tokio::test]
    async fn ls_reads_the_list_test_sends_one_and_a_failure_exits_one() {
        let fake = Fake(|t: &Target, method: &str, path: &str, _: Option<&Value>| {
            assert_eq!(t.urls, ["http://b:2"]);
            match (method, path) {
                ("GET", "/api/push") => {
                    Ok(json!({"vapid": true, "subject": "mailto:x", "entries": []}))
                }
                ("POST", "/api/push/test") => {
                    Ok(json!({"sent": 1, "failed": 1, "gone": 0, "entries": []}))
                }
                _ => Err(AskError::Refused {
                    message: "no".into(),
                    status: 404,
                }),
            }
        });
        let caller = Caller::default();
        let mut o = Out::default();
        let r = push_cmd(
            vec!["ls".into(), "--backend".into(), "http://b:2/".into()],
            &caller,
            &fake,
            &mut o,
            0.0,
        )
        .await;
        assert_eq!(r, Ok(()));
        assert_eq!(
            o.printed(),
            [
                "push key: ready (mailto:x)",
                "no browser has turned push on"
            ]
        );
        assert!(!o.failed);
        let mut o = Out::default();
        let r = push_cmd(
            vec!["test".into(), "--backend".into(), "http://b:2".into()],
            &caller,
            &fake,
            &mut o,
            0.0,
        )
        .await;
        assert_eq!(r, Ok(()));
        assert_eq!(o.printed(), ["sent to 1 of 2, 1 failed"]);
        assert!(o.failed);
        for bad in [&["ls", "x"][..], &["what"], &[]] {
            let mut o = Out::default();
            let argv = bad.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                push_cmd(argv, &caller, &fake, &mut o, 0.0).await,
                Err(PUSH_USAGE.into())
            );
        }
    }

    #[tokio::test]
    async fn a_backend_that_does_not_answer_says_so() {
        let fake = Fake(|t: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err(AskError::Unreachable(format!(
                "{}: ECONNREFUSED",
                t.urls[0]
            )))
        });
        let caller = Caller {
            env_api: Some("http://api:1".into()),
            ..Default::default()
        };
        let mut o = Out::default();
        assert_eq!(
            push_cmd(vec!["ls".into()], &caller, &fake, &mut o, 0.0).await,
            Err("the backend did not answer: http://api:1: ECONNREFUSED".into())
        );
    }
}
