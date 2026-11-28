//! `canopy floorplan` (`src/cli/floorplan.ts`): a checkout's map (FR-070).
//! Says where the map stands, starts the Claude run that makes or updates
//! it, and starts or stops the map's own server, over the HTTP API.

use crate::api::Caller;
use crate::ask::{Ask, did_not_answer, form_query, has, take};
use crate::mapsection::{Clock, ago_iso, pretty, repo_id, selected_target, started_line};
use crate::out::Out;
use canopy_core::floorplan::floorplan_line;
use canopy_core::js::{field, truthy, truthy_at};
use serde_json::{Map, Value, json};
use std::time::Duration;

/// `FLOORPLAN_USAGE`.
pub const FLOORPLAN_USAGE: &str = "usage: canopy floorplan <repo> [status] [--json] [--backend URL] [--on NAME]\n       canopy floorplan <repo> make|update [-m note] [--developers] [--backend URL] [--on NAME]\n       canopy floorplan <repo> open|stop [--backend URL] [--on NAME]";

/// What the command does to the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    Status,
    Make,
    Update,
    Open,
    Stop,
}

impl Act {
    fn of(word: &str) -> Option<Act> {
        Some(match word {
            "status" => Act::Status,
            "make" => Act::Make,
            "update" => Act::Update,
            "open" => Act::Open,
            "stop" => Act::Stop,
            _ => return None,
        })
    }
}

/// `FloorplanArgs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FloorplanArgs {
    pub repo: String,
    pub act: Act,
    pub note: String,
    pub developers: bool,
    pub json: bool,
    pub backend: Option<String>,
    pub on: Option<String>,
}

/// `parseFloorplanArgs()`: the command's words, or what is wrong with
/// them. The caller's list is not changed.
pub fn parse_floorplan_args(argv: &[String]) -> Result<FloorplanArgs, String> {
    let mut args = argv.to_vec();
    let backend = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    let note = match take(&mut args, "-m") {
        Some(n) => Some(n),
        None => take(&mut args, "--note"),
    };
    let developers = has(&mut args, "--developers");
    let json = has(&mut args, "--json");
    let repo = args.first().cloned().unwrap_or_default();
    let word = args.get(1).map_or("status", String::as_str);
    let act = Act::of(word);
    let Some(act) = act.filter(|_| !repo.is_empty() && !repo.starts_with('-') && args.len() <= 2)
    else {
        return Err(FLOORPLAN_USAGE.into());
    };
    if backend.is_some() && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }
    let starts = matches!(act, Act::Make | Act::Update);
    if !starts && (note.is_some() || developers) {
        return Err(format!(
            "-m and --developers go with make or update\n\n{FLOORPLAN_USAGE}"
        ));
    }
    Ok(FloorplanArgs {
        repo,
        act,
        note: note.unwrap_or_default(),
        developers,
        json,
        backend,
        on,
    })
}

/// `floorplanLines()`: a status in lines, the map, its server, the run at
/// it. `now` is unix ms.
pub fn floorplan_lines(info: &Value, now: f64) -> Vec<String> {
    let mut out = vec![floorplan_line(info, |iso| ago_iso(now, iso))];
    if truthy_at(info, "server") {
        out.push(format!(
            "its server is up on the backend's port {}; the repo's map section shows it",
            field(&info["server"], "port")
        ));
    }
    if truthy_at(info, "run") {
        let run = field(info, "run");
        out.push(format!(
            "run {run} is drawing it now (canopy run show {run})"
        ));
    }
    out
}

/// `floorplanCommand()`. `cwd` is the folder a path argument is read from.
pub(crate) async fn floorplan_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    cwd: &str,
    clock: &Clock<'_>,
) -> Result<(), String> {
    let p = parse_floorplan_args(&argv)?;
    let target = selected_target(ask, caller, p.backend.as_deref(), p.on.as_deref()).await?;
    let id = repo_id(ask, &p.repo, &target, cwd).await?;
    let path = format!("/api/repos/floorplan?{}", form_query(&[("id", &id)]));
    let failed = |e| did_not_answer(&target.name, &e);
    let within = |s| Duration::from_millis(s);
    match p.act {
        Act::Status => {
            let info = ask
                .ask_within(&target, "GET", &path, None, within(30_000))
                .await
                .map_err(failed)?;
            if p.json {
                out.line(pretty(&info));
            } else {
                out.lines(floorplan_lines(&info, clock.now()));
            }
        }
        Act::Make | Act::Update => {
            let mut body = Map::new();
            body.insert("act".into(), json!("make"));
            body.insert("note".into(), json!(p.note));
            if p.developers {
                body.insert("developers".into(), json!(true));
            }
            let run = ask
                .ask_within(
                    &target,
                    "POST",
                    &path,
                    Some(&Value::Object(body)),
                    within(30_000),
                )
                .await
                .map_err(failed)?;
            out.line(started_line(&run));
        }
        Act::Open => {
            let got = ask
                .ask_within(
                    &target,
                    "POST",
                    &path,
                    Some(&json!({"act": "open"})),
                    within(60_000),
                )
                .await
                .map_err(failed)?;
            out.line(format!(
                "the map's server is up on the backend's port {}; the repo's map section shows it",
                field(&got, "port")
            ));
        }
        Act::Stop => {
            let got = ask
                .ask(&target, "POST", &path, Some(&json!({"act": "stop"})))
                .await
                .map_err(failed)?;
            out.line(if truthy(got.get("stopped")) {
                "stopped the map's server"
            } else {
                "no map server was up"
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::AskError;
    use crate::ask::Target;
    use crate::ask::tests::Fake;
    use std::sync::Mutex;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn parse(a: &[&str]) -> Result<FloorplanArgs, String> {
        parse_floorplan_args(&argv(a))
    }

    #[test]
    fn parse_floorplan_args_reads_the_repo_the_act_and_the_flags_and_leaves_the_list_alone() {
        let a = argv(&[
            "shop",
            "make",
            "-m",
            "the server matters",
            "--developers",
            "--on",
            "mini",
        ]);
        assert_eq!(
            parse_floorplan_args(&a),
            Ok(FloorplanArgs {
                repo: "shop".into(),
                act: Act::Make,
                note: "the server matters".into(),
                developers: true,
                json: false,
                backend: None,
                on: Some("mini".into()),
            })
        );
        assert_eq!(a.len(), 7);
        let bare = parse(&["shop"]).unwrap();
        assert_eq!(
            (
                bare.repo.as_str(),
                bare.act,
                bare.note.as_str(),
                bare.developers
            ),
            ("shop", Act::Status, "", false)
        );
        let json = parse(&["./shop", "--json"]).unwrap();
        assert_eq!(
            (json.repo.as_str(), json.act, json.json),
            ("./shop", Act::Status, true)
        );
        assert_eq!(parse(&["shop", "update"]).unwrap().act, Act::Update);
        assert_eq!(
            parse(&["shop", "make", "--note", "n"]).unwrap().note,
            "n",
            "--note stands in for -m"
        );
    }

    #[test]
    fn parse_floorplan_args_refuses_what_it_cannot_run() {
        let usage = Err(FLOORPLAN_USAGE.to_string());
        assert_eq!(parse(&[]), usage);
        assert_eq!(parse(&["shop", "draw"]), usage);
        assert_eq!(parse(&["shop", "open", "extra"]), usage);
        assert_eq!(parse(&["--json"]), usage);
        assert_eq!(parse(&["", "open"]), usage);
        assert!(
            parse(&["shop", "open", "-m", "hi"])
                .unwrap_err()
                .contains("-m and --developers go with make or update")
        );
        assert!(parse(&["shop", "stop", "--developers"]).is_err());
        assert_eq!(
            parse(&["shop", "--backend", "http://x:1", "--on", "mini"]),
            Err("use either --backend URL or --on NAME".into())
        );
        // -m with a value leaves --note behind, which is one word too many
        assert_eq!(parse(&["shop", "make", "-m", "a", "--note", "b"]), usage);
    }

    #[test]
    fn floorplan_lines_says_the_map_its_server_and_its_run() {
        let now = 1_795_176_000_000.0; // 2026-11-20T12:00:00.000Z
        let base = json!({"state": "map", "builtAt": "2026-11-20T09:00:00.000Z", "files": 40, "nodes": 5, "changed": 2, "uncommitted": 0, "server": null, "run": null});
        assert_eq!(
            floorplan_lines(&base, now),
            ["40 files in 5 parts, built 3h ago; 2 files changed since"]
        );
        let mut live = base.clone();
        live["builtAt"] = json!("2026-11-20T11:59:50.000Z");
        live["server"] = json!({"port": 4378});
        live["run"] = json!("r7");
        assert_eq!(
            floorplan_lines(&live, now),
            [
                "40 files in 5 parts, built just now; 2 files changed since",
                "its server is up on the backend's port 4378; the repo's map section shows it",
                "run r7 is drawing it now (canopy run show r7)",
            ]
        );
        let none = json!({"state": "none", "builtAt": null, "files": null, "nodes": null, "changed": null, "uncommitted": null, "server": null, "run": null});
        assert_eq!(floorplan_lines(&none, now), ["no map yet"]);
    }

    fn caller() -> Caller {
        Caller {
            env_api: Some("http://home.invalid".into()),
            ..Caller::default()
        }
    }

    #[tokio::test]
    async fn each_act_asks_the_route_and_says_what_it_answered() {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{m} {p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
            Ok::<Value, AskError>(match b.and_then(|b| b.get("act")).and_then(Value::as_str) {
                None => {
                    json!({"state": "none", "builtAt": null, "files": null, "nodes": null, "changed": null, "uncommitted": null, "server": null, "run": null})
                }
                Some("make") => json!({"id": "r9", "verb": "map"}),
                Some("open") => json!({"port": 4378}),
                _ => json!({"stopped": false}),
            })
        });
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        for a in [
            &["web/shop"][..],
            &["web/shop", "make", "-m", "the api", "--developers"],
            &["web/shop", "update"],
            &["web/shop", "open"],
            &["web/shop", "stop"],
        ] {
            floorplan_cmd(argv(a), &caller(), &fake, &mut out, "/", &clock)
                .await
                .unwrap();
        }
        assert_eq!(
            out.printed(),
            [
                "no map yet",
                "started run r9 (map). Follow it with canopy run show r9; its questions wait in the page.",
                "started run r9 (map). Follow it with canopy run show r9; its questions wait in the page.",
                "the map's server is up on the backend's port 4378; the repo's map section shows it",
                "no map server was up",
            ]
        );
        let path = "/api/repos/floorplan?id=web%2Fshop";
        assert_eq!(
            *seen.lock().unwrap(),
            [
                format!("GET {path} "),
                format!(
                    "POST {path} {{\"act\":\"make\",\"note\":\"the api\",\"developers\":true}}"
                ),
                format!("POST {path} {{\"act\":\"make\",\"note\":\"\"}}"),
                format!("POST {path} {{\"act\":\"open\"}}"),
                format!("POST {path} {{\"act\":\"stop\"}}"),
            ]
        );
        let mut out = Out::default();
        floorplan_cmd(
            argv(&["web/shop", "--json"]),
            &caller(),
            &fake,
            &mut out,
            "/",
            &clock,
        )
        .await
        .unwrap();
        assert!(
            out.text
                .starts_with("{\n  \"state\": \"none\",\n  \"builtAt\": null,")
        );
    }

    #[tokio::test]
    async fn a_refusal_or_a_backend_that_does_not_answer_is_the_failure() {
        let refused = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err::<Value, AskError>(AskError::Refused {
                message: "there is no map here yet: make it first".into(),
                status: 400,
            })
        });
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        assert_eq!(
            floorplan_cmd(
                argv(&["shop", "open"]),
                &caller(),
                &refused,
                &mut out,
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "there is no map here yet: make it first"
        );
        let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err::<Value, AskError>(AskError::Unreachable("http://home.invalid: refused".into()))
        });
        assert_eq!(
            floorplan_cmd(argv(&["shop"]), &caller(), &down, &mut out, "/", &clock)
                .await
                .unwrap_err(),
            "home did not answer: http://home.invalid: refused"
        );
        assert_eq!(
            floorplan_cmd(
                argv(&["shop", "--on", "mini"]),
                &caller(),
                &down,
                &mut out,
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "home did not answer: http://home.invalid: refused"
        );
        assert_eq!(
            floorplan_cmd(
                argv(&["shop", "--backend", "ftp://x"]),
                &caller(),
                &down,
                &mut out,
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "--backend must be an http(s) origin, got ftp://x"
        );
        assert!(out.text.is_empty());
    }
}
