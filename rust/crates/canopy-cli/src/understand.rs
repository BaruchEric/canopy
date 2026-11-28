//! `canopy understand` (`src/cli/understand.ts`): a checkout's knowledge
//! graph (FR-072). Says where the graph stands, starts the Claude run that
//! makes, updates or rebuilds it, and starts or stops the graph's viewer,
//! over the HTTP API. The first start or open on a backend prepares the
//! plugin there; the command waits for it.

use crate::api::Caller;
use crate::ask::{Ask, AskError, Target, did_not_answer, form_query, has, take};
use crate::mapsection::{Clock, ago_iso, pretty, repo_id, selected_target, started_line};
use crate::out::Out;
use canopy_core::js::{field, template, truthy, truthy_at};
use canopy_core::understand::{PREPARING_WORDS, is_wait, understand_line};
use serde_json::{Map, Value, json};
use std::time::Duration;

/// `UNDERSTAND_USAGE`.
pub const UNDERSTAND_USAGE: &str = "usage: canopy understand <repo> [status] [--json] [--backend URL] [--on NAME]\n       canopy understand <repo> make|update|rebuild [-m note] [--backend URL] [--on NAME]\n       canopy understand <repo> open|stop|prepare [--backend URL] [--on NAME]";

/// What the command does to the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    Status,
    Make,
    Update,
    Rebuild,
    Open,
    Stop,
    Prepare,
}

impl Act {
    fn of(word: &str) -> Option<Act> {
        Some(match word {
            "status" => Act::Status,
            "make" => Act::Make,
            "update" => Act::Update,
            "rebuild" => Act::Rebuild,
            "open" => Act::Open,
            "stop" => Act::Stop,
            "prepare" => Act::Prepare,
            _ => return None,
        })
    }
}

/// `UnderstandArgs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnderstandArgs {
    pub repo: String,
    pub act: Act,
    pub note: String,
    pub json: bool,
    pub backend: Option<String>,
    pub on: Option<String>,
}

/// `parseUnderstandArgs()`: the command's words, or what is wrong with
/// them. The caller's list is not changed.
pub fn parse_understand_args(argv: &[String]) -> Result<UnderstandArgs, String> {
    let mut args = argv.to_vec();
    let backend = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    let note = match take(&mut args, "-m") {
        Some(n) => Some(n),
        None => take(&mut args, "--note"),
    };
    let json = has(&mut args, "--json");
    let repo = args.first().cloned().unwrap_or_default();
    let word = args.get(1).map_or("status", String::as_str);
    let Some(act) =
        Act::of(word).filter(|_| !repo.is_empty() && !repo.starts_with('-') && args.len() <= 2)
    else {
        return Err(UNDERSTAND_USAGE.into());
    };
    if backend.is_some() && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }
    let starts = matches!(act, Act::Make | Act::Update | Act::Rebuild);
    if !starts && note.is_some() {
        return Err(format!(
            "-m goes with make, update or rebuild\n\n{UNDERSTAND_USAGE}"
        ));
    }
    Ok(UnderstandArgs {
        repo,
        act,
        note: note.unwrap_or_default(),
        json,
        backend,
        on,
    })
}

/// `info.plugin.state`.
fn plugin_state(info: &Value) -> Option<&str> {
    info.get("plugin")?.get("state")?.as_str()
}

/// `understandLines()`: a status in lines, the graph, the plugin, its
/// viewer, the run at it. `now` is unix ms.
pub fn understand_lines(info: &Value, now: f64) -> Vec<String> {
    let graph = info.get("state").and_then(Value::as_str) == Some("graph");
    let folder = if graph {
        format!(" (in {}/)", field(info, "folder"))
    } else {
        String::new()
    };
    let mut out = vec![format!(
        "{}{folder}",
        understand_line(info, |iso| ago_iso(now, iso))
    )];
    let extras: Vec<&str> = [("domain", "a domain graph"), ("lessons", "code lessons")]
        .iter()
        .filter(|(k, _)| truthy_at(info, k))
        .map(|(_, words)| *words)
        .collect();
    if !extras.is_empty() {
        out.push(format!("with {}", extras.join(" and ")));
    }
    match plugin_state(info) {
        Some("preparing") => out.push(format!("{PREPARING_WORDS}…")),
        Some("failed") => out.push(format!(
            "preparing Understand-Anything failed: {} (any start or open tries again)",
            field(&info["plugin"], "error")
        )),
        _ => {}
    }
    if truthy_at(info, "server") {
        out.push(format!(
            "its viewer is up on the backend's port {}; the repo's map section shows it",
            field(&info["server"], "port")
        ));
    }
    if truthy_at(info, "run") {
        let run = field(info, "run");
        out.push(format!(
            "run {run} is making it now (canopy run show {run})"
        ));
    }
    out
}

/// `untilReady()`: sends `body`, and while the backend answers that it is
/// preparing the plugin, says so once, waits for the prepare and sends it
/// again.
async fn until_ready(
    ask: &impl Ask,
    target: &Target,
    path: &str,
    body: &Value,
    out: &mut Out,
    clock: &Clock<'_>,
) -> Result<Value, String> {
    let failed = |e: AskError| did_not_answer(&target.name, &e);
    let deadline = clock.now() + 15.0 * 60_000.0;
    let mut said = false;
    loop {
        let got = ask
            .ask_within(
                target,
                "POST",
                path,
                Some(body),
                Duration::from_millis(60_000),
            )
            .await
            .map_err(failed)?;
        if !is_wait(&got) {
            return Ok(got);
        }
        if !said {
            out.line(format!("{PREPARING_WORDS}…"));
        }
        said = true;
        loop {
            if clock.now() > deadline {
                return Err(
                    "the backend is still preparing Understand-Anything; try again in a minute"
                        .into(),
                );
            }
            clock.nap(3_000).await;
            let info = ask
                .ask_within(target, "GET", path, None, Duration::from_millis(30_000))
                .await
                .map_err(failed)?;
            match plugin_state(&info) {
                Some("failed") => {
                    return Err(format!(
                        "preparing Understand-Anything failed: {}",
                        template(info.get("plugin").and_then(|p| p.get("error")))
                    ));
                }
                Some("ready") => break,
                _ => {}
            }
        }
    }
}

/// `understandCommand()`. `cwd` is the folder a path argument is read from.
pub(crate) async fn understand_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    cwd: &str,
    clock: &Clock<'_>,
) -> Result<(), String> {
    let p = parse_understand_args(&argv)?;
    let target = selected_target(ask, caller, p.backend.as_deref(), p.on.as_deref()).await?;
    let id = repo_id(ask, &p.repo, &target, cwd).await?;
    let path = format!("/api/repos/understand?{}", form_query(&[("id", &id)]));
    let failed = |e| did_not_answer(&target.name, &e);
    match p.act {
        Act::Status => {
            let info = ask
                .ask_within(&target, "GET", &path, None, Duration::from_millis(30_000))
                .await
                .map_err(failed)?;
            if p.json {
                out.line(pretty(&info));
            } else {
                out.lines(understand_lines(&info, clock.now()));
            }
        }
        Act::Make | Act::Update | Act::Rebuild => {
            let mut body = Map::new();
            body.insert("act".into(), json!("make"));
            body.insert("note".into(), json!(p.note));
            if p.act == Act::Rebuild {
                body.insert("full".into(), json!(true));
            }
            let run = until_ready(ask, &target, &path, &Value::Object(body), out, clock).await?;
            out.line(started_line(&run));
        }
        Act::Open => {
            let got = until_ready(ask, &target, &path, &json!({"act": "open"}), out, clock).await?;
            out.line(format!(
                "the graph's viewer is up on the backend's port {}; the repo's map section shows it",
                field(&got, "port")
            ));
        }
        Act::Prepare => {
            until_ready(ask, &target, &path, &json!({"act": "prepare"}), out, clock).await?;
            out.line("Understand-Anything is ready on the backend");
        }
        Act::Stop => {
            let got = ask
                .ask(&target, "POST", &path, Some(&json!({"act": "stop"})))
                .await
                .map_err(failed)?;
            out.line(if truthy(got.get("stopped")) {
                "stopped the graph's viewer"
            } else {
                "no viewer was up"
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;
    use std::cell::Cell;
    use std::sync::Mutex;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn parse(a: &[&str]) -> Result<UnderstandArgs, String> {
        parse_understand_args(&argv(a))
    }

    #[test]
    fn parse_understand_args_reads_the_repo_the_act_and_the_flags_and_leaves_the_list_alone() {
        let a = argv(&[
            "shop",
            "rebuild",
            "-m",
            "the server matters",
            "--on",
            "mini",
        ]);
        assert_eq!(
            parse_understand_args(&a),
            Ok(UnderstandArgs {
                repo: "shop".into(),
                act: Act::Rebuild,
                note: "the server matters".into(),
                json: false,
                backend: None,
                on: Some("mini".into()),
            })
        );
        assert_eq!(a.len(), 6);
        let bare = parse(&["shop"]).unwrap();
        assert_eq!(
            (bare.repo.as_str(), bare.act, bare.note.as_str()),
            ("shop", Act::Status, "")
        );
        let json = parse(&["./shop", "--json"]).unwrap();
        assert_eq!(
            (json.repo.as_str(), json.act, json.json),
            ("./shop", Act::Status, true)
        );
        for (word, act) in [
            ("make", Act::Make),
            ("update", Act::Update),
            ("open", Act::Open),
            ("stop", Act::Stop),
            ("prepare", Act::Prepare),
        ] {
            assert_eq!(parse(&["shop", word]).unwrap().act, act, "{word}");
        }
    }

    #[test]
    fn parse_understand_args_refuses_what_it_cannot_run() {
        let usage = Err(UNDERSTAND_USAGE.to_string());
        assert_eq!(parse(&[]), usage);
        assert_eq!(parse(&["shop", "draw"]), usage);
        assert_eq!(parse(&["shop", "open", "extra"]), usage);
        assert_eq!(parse(&["--json"]), usage);
        assert!(
            parse(&["shop", "open", "-m", "hi"])
                .unwrap_err()
                .contains("-m goes with make, update or rebuild")
        );
        assert_eq!(
            parse(&["shop", "--backend", "http://x:1", "--on", "mini"]),
            Err("use either --backend URL or --on NAME".into())
        );
    }

    fn info() -> Value {
        json!({
            "state": "graph", "analyzedAt": "2026-11-20T09:00:00.000Z", "commit": "a".repeat(40),
            "nodes": 120, "edges": 300, "files": 40, "layers": 4, "tour": 8, "folder": ".ua",
            "behind": 2, "changed": 5, "domain": false, "lessons": true,
            "plugin": {"state": "ready"}, "server": null, "run": null,
        })
    }

    fn with(mut v: Value, more: Value) -> Value {
        for (k, x) in more.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    #[test]
    fn understand_lines_says_the_graph_the_plugin_its_viewer_and_its_run() {
        let now = 1_795_176_000_000.0; // 2026-11-20T12:00:00.000Z
        assert_eq!(
            understand_lines(&info(), now),
            [
                "120 nodes in 40 files, 4 layers, made 3h ago; 2 commits since, 5 files changed (in .ua/)",
                "with code lessons",
            ]
        );
        assert_eq!(
            understand_lines(
                &with(
                    info(),
                    json!({"behind": 0, "lessons": false, "domain": true, "server": {"port": 5180}, "run": "r7"})
                ),
                now
            ),
            [
                "120 nodes in 40 files, 4 layers, made 3h ago (in .ua/)",
                "with a domain graph",
                "its viewer is up on the backend's port 5180; the repo's map section shows it",
                "run r7 is making it now (canopy run show r7)",
            ]
        );
        let none = with(
            info(),
            json!({"state": "none", "analyzedAt": null, "nodes": null, "files": null, "layers": null, "behind": null, "changed": null, "lessons": false}),
        );
        assert_eq!(
            understand_lines(
                &with(none.clone(), json!({"plugin": {"state": "preparing"}})),
                now
            ),
            [
                "no graph yet",
                "getting Understand-Anything ready on this backend (the first time it installs and builds, a minute or two)…",
            ]
        );
        assert_eq!(
            understand_lines(
                &with(
                    none,
                    json!({"plugin": {"state": "failed", "error": "bun install failed: no network"}})
                ),
                now
            )[1],
            "preparing Understand-Anything failed: bun install failed: no network (any start or open tries again)"
        );
    }

    fn caller() -> Caller {
        Caller {
            env_api: Some("http://home.invalid".into()),
            ..Caller::default()
        }
    }

    #[tokio::test]
    async fn a_start_waits_out_the_prepare_and_says_so_once() {
        let posts = Mutex::new(0);
        let reads = Mutex::new(0);
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{m} {p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
            if m == "GET" {
                let mut n = reads.lock().unwrap();
                *n += 1;
                let state = if *n < 2 { "preparing" } else { "ready" };
                return Ok::<Value, AskError>(json!({"plugin": {"state": state}}));
            }
            let mut n = posts.lock().unwrap();
            *n += 1;
            Ok(if *n == 1 {
                json!({"preparing": true, "plugin": {"state": "preparing"}})
            } else if b.and_then(|b| b.get("act")) == Some(&json!("open")) {
                json!({"port": 5180, "token": "t"})
            } else if b.and_then(|b| b.get("act")) == Some(&json!("prepare")) {
                json!({"plugin": {"state": "ready"}})
            } else {
                json!({"id": "r9", "verb": "understand"})
            })
        });
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        understand_cmd(
            argv(&["web/shop", "rebuild", "-m", "api"]),
            &caller(),
            &fake,
            &mut out,
            "/",
            &clock,
        )
        .await
        .unwrap();
        for a in [
            &["web/shop", "open"][..],
            &["web/shop", "prepare"],
            &["web/shop", "stop"],
        ] {
            understand_cmd(argv(a), &caller(), &fake, &mut out, "/", &clock)
                .await
                .unwrap();
        }
        assert_eq!(
            out.printed(),
            [
                "getting Understand-Anything ready on this backend (the first time it installs and builds, a minute or two)…",
                "started run r9 (understand). Follow it with canopy run show r9; its questions wait in the page.",
                "the graph's viewer is up on the backend's port 5180; the repo's map section shows it",
                "Understand-Anything is ready on the backend",
                "no viewer was up",
            ]
        );
        let path = "/api/repos/understand?id=web%2Fshop";
        let rebuild = format!("POST {path} {{\"act\":\"make\",\"note\":\"api\",\"full\":true}}");
        assert_eq!(
            seen.lock().unwrap()[..4],
            [
                rebuild.clone(),
                format!("GET {path} "),
                format!("GET {path} "),
                rebuild
            ]
        );
    }

    #[tokio::test]
    async fn a_prepare_that_fails_or_never_ends_is_the_failure() {
        let failing = Fake(|_: &Target, m: &str, _: &str, _: Option<&Value>| {
            Ok::<Value, AskError>(if m == "POST" {
                json!({"preparing": true, "plugin": {"state": "preparing"}})
            } else {
                json!({"plugin": {"state": "failed", "error": "bun install failed: no network"}})
            })
        });
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        assert_eq!(
            understand_cmd(
                argv(&["shop", "open"]),
                &caller(),
                &failing,
                &mut out,
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "preparing Understand-Anything failed: bun install failed: no network"
        );
        assert_eq!(out.printed(), [format!("{PREPARING_WORDS}…")]);
        let endless = Fake(|_: &Target, m: &str, _: &str, _: Option<&Value>| {
            Ok::<Value, AskError>(if m == "POST" {
                json!({"preparing": true, "plugin": {"state": "preparing"}})
            } else {
                json!({"plugin": {"state": "preparing"}})
            })
        });
        let ticks = Cell::new(0.0);
        let now = || {
            ticks.set(ticks.get() + 60_000.0);
            ticks.get()
        };
        let clock = Clock {
            now: &now,
            naps: false,
        };
        assert_eq!(
            understand_cmd(
                argv(&["shop", "make"]),
                &caller(),
                &endless,
                &mut Out::default(),
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "the backend is still preparing Understand-Anything; try again in a minute"
        );
        let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err::<Value, AskError>(AskError::Unreachable("http://home.invalid: refused".into()))
        });
        assert_eq!(
            understand_cmd(
                argv(&["shop"]),
                &caller(),
                &down,
                &mut Out::default(),
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "home did not answer: http://home.invalid: refused"
        );
    }

    #[tokio::test]
    async fn status_prints_its_lines_or_its_json() {
        let fake =
            Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| Ok::<Value, AskError>(info()));
        let now = || 1_795_176_000_000.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        understand_cmd(argv(&["shop"]), &caller(), &fake, &mut out, "/", &clock)
            .await
            .unwrap();
        assert_eq!(out.printed(), understand_lines(&info(), now()));
        let mut out = Out::default();
        understand_cmd(
            argv(&["shop", "--json"]),
            &caller(),
            &fake,
            &mut out,
            "/",
            &clock,
        )
        .await
        .unwrap();
        assert_eq!(out.text, format!("{}\n", pretty(&info())));
    }
}
