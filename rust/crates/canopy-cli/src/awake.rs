//! `canopy awake` (`src/cli/awake.ts`): where keep awake stands on a
//! backend, or a new mode for it, over the backend's API.

use crate::api::Caller;
use crate::ask::{Ask, AskError, Target, take};
use canopy_core::types::{AWAKE_MODES, AwakeInfo, awake_words};
use serde_json::json;

/// `AWAKE_USAGE`.
pub fn usage() -> String {
    format!(
        "usage: canopy awake [{}] [--backend URL]",
        AWAKE_MODES.join("|")
    )
}

/// `awakeLine()`: the mode, and whether the machine is held right now and
/// why not.
pub fn awake_line(info: &AwakeInfo, backend: &str) -> String {
    let on = if backend.is_empty() {
        String::new()
    } else {
        format!(" on {backend}")
    };
    format!("keep awake{on}: {}, {}", info.mode, awake_words(info))
}

/// `awakeCommand()`: the lines to print, or the failure.
pub(crate) async fn awake_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
) -> Result<Vec<String>, String> {
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    let target = Target::home(&home);
    let failed = |e: AskError| match e {
        AskError::Unreachable(m) => format!("the backend did not answer: {m}"),
        other => other.message().to_string(),
    };
    let word = if args.is_empty() {
        None
    } else {
        Some(args.remove(0))
    };
    let known = |w: &str| w == "status" || AWAKE_MODES.contains(&w);
    if !args.is_empty() || word.as_deref().is_some_and(|w| !known(w)) {
        return Err(usage());
    }
    let info = match word.as_deref() {
        None | Some("status") => ask.ask(&target, "GET", "/api/awake", None).await,
        Some(mode) => {
            ask.ask(
                &target,
                "POST",
                "/api/awake",
                Some(&json!({ "mode": mode })),
            )
            .await
        }
    }
    .map_err(failed)?;
    let info: AwakeInfo = serde_json::from_value(info).unwrap_or_default();
    Ok(vec![awake_line(&info, given.as_deref().unwrap_or(""))])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;
    use serde_json::Value;

    fn caller() -> Caller {
        Caller::default()
    }

    #[tokio::test]
    async fn status_reads_and_a_mode_posts() {
        let seen = std::sync::Mutex::new(Vec::<(String, String, Option<Value>)>::new());
        let fake = Fake(|t: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock()
                .unwrap()
                .push((t.urls[0].clone(), format!("{m} {p}"), b.cloned()));
            Ok(
                json!({"mode": "working", "holding": false, "available": true, "why": null, "working": 2}),
            )
        });
        assert_eq!(
            awake_cmd(vec![], &caller(), &fake).await.unwrap(),
            ["keep awake: working, not holding, 2 agents working"]
        );
        assert_eq!(
            awake_cmd(
                vec![
                    "always".into(),
                    "--backend".into(),
                    "http://mini:7850".into()
                ],
                &caller(),
                &fake
            )
            .await
            .unwrap(),
            ["keep awake on http://mini:7850: working, not holding, 2 agents working"]
        );
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen[0],
            (
                "http://127.0.0.1:7850".into(),
                "GET /api/awake".into(),
                None
            )
        );
        assert_eq!(
            seen[1],
            (
                "http://mini:7850".into(),
                "POST /api/awake".into(),
                Some(json!({"mode": "always"}))
            )
        );
    }

    #[tokio::test]
    async fn a_word_it_does_not_know_is_the_usage_and_no_answer_says_so() {
        let fake = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err(AskError::Unreachable(
                "http://127.0.0.1:7850: ECONNREFUSED".into(),
            ))
        });
        assert_eq!(
            awake_cmd(vec!["sometimes".into()], &caller(), &fake).await,
            Err("usage: canopy awake [off|always|working] [--backend URL]".into())
        );
        assert_eq!(
            awake_cmd(vec!["off".into(), "now".into()], &caller(), &fake).await,
            Err(usage())
        );
        assert_eq!(
            awake_cmd(vec![], &caller(), &fake).await,
            Err("the backend did not answer: http://127.0.0.1:7850: ECONNREFUSED".into())
        );
    }
}
