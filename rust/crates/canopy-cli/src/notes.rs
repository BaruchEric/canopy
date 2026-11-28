//! `canopy note` (FR-020, `src/cli/notes.ts`): jot a note or set a
//! reminder on a backend, list the open ones, mark one done or delete it.
//! Each is a call to the notes routes with the caller's token; the time is
//! read on the backend's clock.

use crate::api::Caller;
use crate::ask::{Ask, AskError, Target, encode_component, has, is_origin, take};
use crate::jsdate::locale_string;
use canopy_core::notes::{QuickNote, due_word, open_notes, sort_notes};
use canopy_core::pathx::{js_squash_ws, js_trim, pad_end};
use serde_json::{Map, Value, json};

/// `NOTE_USAGE`.
pub const NOTE_USAGE: &str = "usage: canopy note add \"<text>\" [--repo <id or path>] [--at <time>] [--backend URL]\n       canopy note list [--all] [--backend URL]\n       canopy note done <id> [--backend URL]\n       canopy note delete <id> [--backend URL]";

/// `addBody()`: the text, the repo when given, the time as typed, for the
/// backend to read.
pub fn add_body(text: &str, repo: Option<&str>, at: Option<&str>) -> Value {
    let mut body = Map::new();
    body.insert("text".into(), json!(text));
    if let Some(r) = repo {
        body.insert("repo".into(), json!(r));
    }
    if let Some(a) = at {
        body.insert("at".into(), json!(a));
    }
    Value::Object(body)
}

/// `noteLines()`: `id  when  repo  text`, reminders first and the soonest
/// at the top; with `all`, the done ones after, marked done.
pub fn note_lines(
    notes: &[QuickNote],
    now: f64,
    all: bool,
    repo_name: &dyn Fn(&str) -> String,
) -> Vec<String> {
    let open = sort_notes(&open_notes(notes));
    let mut done: Vec<QuickNote> = if all {
        notes
            .iter()
            .filter(|n| n.done_at.is_some())
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    done.sort_by(|a, b| {
        let d = b.done_at.unwrap_or(0.0) - a.done_at.unwrap_or(0.0);
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let line = |n: &QuickNote, word: &str| {
        let repo = n.repo_id.as_deref().map(repo_name).unwrap_or_default();
        format!(
            "{}  {} {} {}",
            n.id,
            pad_end(word, 9),
            pad_end(&repo, 16),
            js_squash_ws(&n.text)
        )
    };
    let mut out: Vec<String> = open
        .iter()
        .map(|n| {
            let word = match n.due {
                None => String::new(),
                Some(due) if n.reminded_at.is_some() && due <= now => "in inbox".into(),
                Some(due) => due_word(due, now),
            };
            line(n, &word)
        })
        .collect();
    out.extend(done.iter().map(|n| line(n, "done")));
    out
}

fn note_of(v: Value) -> QuickNote {
    serde_json::from_value(v).unwrap_or_default()
}

/// `noteCommand()`: the lines to print, or the failure.
pub(crate) async fn note_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    now: f64,
) -> Result<Vec<String>, String> {
    let given = take(&mut args, "--backend");
    let repo = take(&mut args, "--repo");
    let at = take(&mut args, "--at");
    let all = has(&mut args, "--all");
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let target = Target::home(&home);
    let failed = |e: AskError| e.message().to_string();
    let sub = if args.is_empty() {
        None
    } else {
        Some(args.remove(0))
    };
    let rest = args;

    if sub.as_deref() == Some("add") {
        let joined = rest.join(" ");
        let text = js_trim(&joined);
        if text.is_empty() {
            return Err(NOTE_USAGE.into());
        }
        let body = add_body(text, repo.as_deref(), at.as_deref());
        let n = note_of(
            ask.ask(&target, "POST", "/api/notes", Some(&body))
                .await
                .map_err(failed)?,
        );
        let reminds = match n.due {
            Some(due) => format!("  reminds {} ({})", due_word(due, now), locale_string(due)),
            None => String::new(),
        };
        return Ok(vec![format!("{}{reminds}", n.id)]);
    }
    if repo.is_some() || at.is_some() {
        return Err(NOTE_USAGE.into());
    }
    match sub.as_deref() {
        None | Some("list") => {
            if !rest.is_empty() {
                return Err(NOTE_USAGE.into());
            }
            let info = ask
                .ask(&target, "GET", "/api/notes", None)
                .await
                .map_err(failed)?;
            let notes: Vec<QuickNote> = info
                .get("notes")
                .and_then(Value::as_array)
                .map(|ns| ns.iter().cloned().map(note_of).collect())
                .unwrap_or_default();
            let lines = note_lines(&notes, now, all, &|id: &str| id.to_string());
            if lines.is_empty() {
                return Ok(vec![if all { "no notes" } else { "no open notes" }.into()]);
            }
            Ok(lines)
        }
        Some(verb @ ("done" | "delete" | "rm")) => {
            let [id] = rest.as_slice() else {
                return Err(NOTE_USAGE.into());
            };
            if id.is_empty() || all {
                return Err(NOTE_USAGE.into());
            }
            if verb == "done" {
                let n = note_of(
                    ask.ask(
                        &target,
                        "POST",
                        "/api/notes/done",
                        Some(&json!({ "id": id })),
                    )
                    .await
                    .map_err(failed)?,
                );
                return Ok(vec![format!("done: {}", js_squash_ws(&n.text))]);
            }
            let path = format!("/api/notes?id={}", encode_component(id));
            ask.ask(&target, "DELETE", &path, None)
                .await
                .map_err(failed)?;
            Ok(vec![format!("deleted {id}")])
        }
        _ => Err(NOTE_USAGE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;

    fn note(id: &str) -> QuickNote {
        QuickNote {
            id: id.into(),
            text: format!("note {id}"),
            created_at: 1.0,
            ..Default::default()
        }
    }

    #[test]
    fn add_body_carries_only_what_was_given() {
        assert_eq!(add_body("x", None, None), json!({"text": "x"}));
        assert_eq!(
            add_body("x", Some("/repos/atlas"), Some("in 30m")),
            json!({"text": "x", "repo": "/repos/atlas", "at": "in 30m"})
        );
    }

    fn fixture(now: f64) -> Vec<QuickNote> {
        vec![
            note("n-plainone"),
            QuickNote {
                due: Some(now + 5.0 * 60_000.0),
                repo_id: Some("r1".into()),
                ..note("n-soondue1")
            },
            QuickNote {
                due: Some(now - 60_000.0),
                reminded_at: Some(now - 30_000.0),
                ..note("n-inboxed1")
            },
            QuickNote {
                due: Some(now - 3_600_000.0),
                reminded_at: Some(now - 3_500_000.0),
                done_at: Some(now - 1000.0),
                text: "two  words\nand a line".into(),
                ..note("n-doneone1")
            },
        ]
    }

    /// `line.split(/\s{2,}/)`
    fn cells(line: &str) -> Vec<String> {
        let mut out = vec![String::new()];
        let mut spaces = 0;
        for c in line.chars() {
            if c.is_whitespace() {
                spaces += 1;
                continue;
            }
            if spaces >= 2 {
                out.push(String::new());
            } else if spaces == 1 {
                out.last_mut().unwrap().push(' ');
            }
            spaces = 0;
            out.last_mut().unwrap().push(c);
        }
        out
    }

    #[test]
    fn open_notes_only_reminders_first_soonest_on_top_each_with_its_word() {
        let now = 1_000_000_000.0;
        let lines = note_lines(&fixture(now), now, false, &|id: &str| {
            if id == "r1" {
                "atlas".into()
            } else {
                id.into()
            }
        });
        let got: Vec<Vec<String>> = lines.iter().map(|l| cells(l)).collect();
        assert_eq!(
            got,
            vec![
                vec!["n-inboxed1", "in inbox", "note n-inboxed1"],
                vec!["n-soondue1", "in 5m", "atlas", "note n-soondue1"],
                vec!["n-plainone", "note n-plainone"],
            ]
        );
    }

    #[test]
    fn all_lists_the_done_ones_after_marked_done_on_one_line() {
        let now = 1_000_000_000.0;
        let lines = note_lines(&fixture(now), now, true, &|id: &str| id.into());
        assert_eq!(lines.len(), 4);
        assert_eq!(
            lines[3],
            "n-doneone1  done                       two words and a line"
        );
    }

    #[tokio::test]
    async fn each_sub_command_calls_its_route() {
        let seen = std::sync::Mutex::new(Vec::<String>::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{m} {p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
            Ok(match (m, p) {
                ("GET", _) => json!({"notes": []}),
                ("POST", "/api/notes") => json!({"id": "n-abcdefgh", "text": "x", "createdAt": 1}),
                ("POST", _) => json!({"id": "n-abcdefgh", "text": "buy\n milk", "createdAt": 1}),
                _ => json!({"ok": true}),
            })
        });
        let c = Caller::default();
        let words = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            note_cmd(words(&["list"]), &c, &fake, 0.0).await.unwrap(),
            ["no open notes"]
        );
        assert_eq!(
            note_cmd(words(&["--all"]), &c, &fake, 0.0).await.unwrap(),
            ["no notes"]
        );
        assert_eq!(
            note_cmd(
                words(&["add", "buy", "milk", "--repo", "canopy"]),
                &c,
                &fake,
                0.0
            )
            .await
            .unwrap(),
            ["n-abcdefgh"]
        );
        assert_eq!(
            note_cmd(words(&["done", "n-abcdefgh"]), &c, &fake, 0.0)
                .await
                .unwrap(),
            ["done: buy milk"]
        );
        assert_eq!(
            note_cmd(words(&["rm", "n a"]), &c, &fake, 0.0)
                .await
                .unwrap(),
            ["deleted n a"]
        );
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "GET /api/notes ",
                "GET /api/notes ",
                r#"POST /api/notes {"text":"buy milk","repo":"canopy"}"#,
                r#"POST /api/notes/done {"id":"n-abcdefgh"}"#,
                "DELETE /api/notes?id=n%20a ",
            ]
        );
    }

    #[tokio::test]
    async fn the_usage_for_what_it_cannot_read_and_the_backend_words_for_a_refusal() {
        let fake = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err(AskError::Refused {
                message: "no note by that id".into(),
                status: 404,
            })
        });
        let c = Caller::default();
        let words = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for bad in [
            &["add"][..],
            &["add", "  "],
            &["list", "x"],
            &["done"],
            &["done", "a", "b"],
            &["done", "a", "--all"],
            &["list", "--at", "in 5m"],
            &["what"],
        ] {
            assert_eq!(
                note_cmd(words(bad), &c, &fake, 0.0).await,
                Err(NOTE_USAGE.to_string()),
                "{bad:?}"
            );
        }
        assert_eq!(
            note_cmd(words(&["done", "n-x"]), &c, &fake, 0.0).await,
            Err("no note by that id".into())
        );
        assert_eq!(
            note_cmd(words(&["--backend", "http://x/"]), &c, &fake, 0.0).await,
            Err("no note by that id".into()),
            "the trailing slash goes before the check, so the call is made"
        );
        assert_eq!(
            note_cmd(words(&["--backend", "http://x/y"]), &c, &fake, 0.0).await,
            Err("--backend must be an http(s) origin, got http://x/y".into())
        );
    }
}
