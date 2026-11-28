//! `canopy archify` (`src/cli/archify.ts`): a checkout's diagrams (FR-071).
//! Lists them, starts the Claude run that draws a new one or revises one,
//! saves a diagram's page to a file here, and removes one, over the HTTP
//! API.

use crate::api::Caller;
use crate::ask::{did_not_answer, form_query, has, take};
use crate::mapsection::{
    AskText, Clock, ago_ms, is_there, pretty, repo_id, selected_target, started_line, write_page,
};
use crate::out::Out;
use canopy_core::archify::{
    ARCHIFY_TYPES, archify_line, built_at, checks_word, is_archify_pick, is_plain_name, type_word,
};
use canopy_core::js::{field, list_at, str_at, template, truthy_at};
use canopy_core::pathx::js_trim;
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::time::Duration;

/// `ARCHIFY_USAGE`.
pub static ARCHIFY_USAGE: LazyLock<String> = LazyLock::new(|| {
    [
        "usage: canopy archify <repo> [list] [--json] [--backend URL] [--on NAME]".to_string(),
        format!(
            "       canopy archify <repo> make [--type auto|{}] [-m note] [--backend URL] [--on NAME]",
            ARCHIFY_TYPES.join("|")
        ),
        "       canopy archify <repo> revise <diagram> -m note [--backend URL] [--on NAME]".into(),
        "       canopy archify <repo> save <diagram> [file] [--backend URL] [--on NAME]".into(),
        "       canopy archify <repo> rm <diagram> [--backend URL] [--on NAME]".into(),
    ]
    .join("\n")
});

/// What the command does, with its own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Act {
    List,
    Make {
        kind: String,
        note: String,
    },
    Revise {
        diagram: String,
        note: String,
    },
    Save {
        diagram: String,
        file: Option<String>,
    },
    Rm {
        diagram: String,
    },
}

/// `ArchifyArgs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchifyArgs {
    pub repo: String,
    pub json: bool,
    pub backend: Option<String>,
    pub on: Option<String>,
    pub act: Act,
}

/// `parseArchifyArgs()`: the command's words, or what is wrong with them.
/// The caller's list is not changed.
pub fn parse_archify_args(argv: &[String]) -> Result<ArchifyArgs, String> {
    let usage = || ARCHIFY_USAGE.clone();
    let mut args = argv.to_vec();
    let backend = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    let note = match take(&mut args, "-m") {
        Some(n) => Some(n),
        None => take(&mut args, "--note"),
    };
    let kind = take(&mut args, "--type");
    let json = has(&mut args, "--json");
    let repo = args.first().cloned().unwrap_or_default();
    let word = args.get(1).map_or("list", String::as_str);
    let rest = args.get(2..).unwrap_or(&[]);
    if repo.is_empty() || repo.starts_with('-') {
        return Err(usage());
    }
    if backend.is_some() && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }
    if kind.is_some() && word != "make" {
        return Err(format!("--type goes with make\n\n{}", usage()));
    }
    if note.is_some() && word != "make" && word != "revise" {
        return Err(format!("-m goes with make or revise\n\n{}", usage()));
    }
    let diagram = rest.first().cloned();
    let named = diagram.as_deref().is_some_and(is_plain_name);
    let act = match word {
        "list" if rest.is_empty() => Act::List,
        "make" => {
            let pick = kind.unwrap_or_else(|| "auto".into());
            if !is_archify_pick(&pick) {
                return Err(format!(
                    "--type is auto or one of {}",
                    ARCHIFY_TYPES.join(", ")
                ));
            }
            if !rest.is_empty() {
                return Err(usage());
            }
            Act::Make {
                kind: pick,
                note: note.unwrap_or_default(),
            }
        }
        "revise" => {
            if !named || rest.len() != 1 {
                return Err(usage());
            }
            let note = note.unwrap_or_default();
            if js_trim(&note).is_empty() {
                return Err("say what to change with -m".into());
            }
            Act::Revise {
                diagram: diagram.unwrap_or_default(),
                note,
            }
        }
        "save" if named && rest.len() <= 2 => Act::Save {
            diagram: diagram.unwrap_or_default(),
            file: rest.get(1).cloned(),
        },
        "rm" if named && rest.len() == 1 => Act::Rm {
            diagram: diagram.unwrap_or_default(),
        },
        _ => return Err(usage()),
    };
    Ok(ArchifyArgs {
        repo,
        json,
        backend,
        on,
        act,
    })
}

/// `archifyLines()`: a list in lines, the summary, one line per diagram,
/// the run at work. `now` is unix ms.
pub fn archify_lines(info: &Value, now: f64) -> Vec<String> {
    let ago = |ms: f64| ago_ms(now, ms);
    let mut out = vec![archify_line(info, ago)];
    for d in list_at(info, "diagrams") {
        let title = d
            .get("title")
            .filter(|t| !t.is_null())
            .or_else(|| d.get("file"));
        let git = if truthy_at(d, "tracked") {
            ", in git"
        } else {
            ""
        };
        out.push(format!(
            "  {}  {}  ({}, {}, {}{git})",
            field(d, "id"),
            template(title),
            type_word(d.get("type")),
            ago(built_at(d)),
            checks_word(d.get("checks"))
        ));
    }
    if truthy_at(info, "run") {
        let run = field(info, "run");
        out.push(format!(
            "run {run} is drawing one now (canopy run show {run})"
        ));
    }
    out
}

/// `archifyCommand()`. `cwd` is the folder a path argument and a saved
/// page are read against.
pub(crate) async fn archify_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl AskText,
    out: &mut Out,
    cwd: &str,
    clock: &Clock<'_>,
) -> Result<(), String> {
    let p = parse_archify_args(&argv)?;
    let target = selected_target(ask, caller, p.backend.as_deref(), p.on.as_deref()).await?;
    let id = repo_id(ask, &p.repo, &target, cwd).await?;
    let path = format!("/api/repos/archify?{}", form_query(&[("id", &id)]));
    let failed = |e| did_not_answer(&target.name, &e);
    let within = Duration::from_millis;
    match &p.act {
        Act::List => {
            let info = ask
                .ask_within(&target, "GET", &path, None, within(30_000))
                .await
                .map_err(failed)?;
            if p.json {
                out.line(pretty(&info));
            } else {
                out.lines(archify_lines(&info, clock.now()));
            }
        }
        Act::Make { kind, note } => {
            let body = json!({"act": "make", "type": kind, "note": note});
            let run = ask
                .ask_within(&target, "POST", &path, Some(&body), within(30_000))
                .await
                .map_err(failed)?;
            out.line(started_line(&run));
        }
        Act::Revise { diagram, note } => {
            let body = json!({"act": "revise", "diagram": diagram, "note": note});
            let run = ask
                .ask_within(&target, "POST", &path, Some(&body), within(30_000))
                .await
                .map_err(failed)?;
            out.line(started_line(&run));
        }
        Act::Save { diagram, file } => {
            let info = ask
                .ask_within(&target, "GET", &path, None, within(30_000))
                .await
                .map_err(failed)?;
            let Some(d) = list_at(&info, "diagrams")
                .iter()
                .find(|x| str_at(x, "id") == Some(diagram.as_str()))
            else {
                return Err(format!(
                    "no diagram {diagram}; canopy archify {} lists them",
                    p.repo
                ));
            };
            let file = file.clone().unwrap_or_else(|| field(d, "file"));
            if is_there(cwd, &file) {
                return Err(format!("{file} is there already; name another file"));
            }
            let page = format!("{path}&{}", form_query(&[("diagram", &field(d, "id"))]));
            let html = ask
                .ask_text_within(&target, &page, within(60_000))
                .await
                .map_err(failed)?;
            write_page(cwd, &file, &html)?;
            let named = d
                .get("title")
                .filter(|t| !t.is_null())
                .or_else(|| d.get("id"));
            out.line(format!(
                "saved {} to {file}; it opens in any browser",
                template(named)
            ));
        }
        Act::Rm { diagram } => {
            let got = ask
                .ask(
                    &target,
                    "POST",
                    &path,
                    Some(&json!({"act": "remove", "diagram": diagram})),
                )
                .await
                .map_err(failed)?;
            out.line(format!("removed .archify/{}", field(&got, "removed")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::Fake;
    use crate::ask::{AskError, Target};
    use std::sync::Mutex;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn parse(a: &[&str]) -> Result<ArchifyArgs, String> {
        parse_archify_args(&argv(a))
    }

    fn at(repo: &str, act: Act) -> ArchifyArgs {
        ArchifyArgs {
            repo: repo.into(),
            json: false,
            backend: None,
            on: None,
            act,
        }
    }

    #[test]
    fn parse_archify_args_reads_the_repo_the_act_and_its_words_and_leaves_the_list_alone() {
        let a = argv(&[
            "shop",
            "make",
            "--type",
            "sequence",
            "-m",
            "the login request",
            "--on",
            "mini",
        ]);
        assert_eq!(
            parse_archify_args(&a),
            Ok(ArchifyArgs {
                on: Some("mini".into()),
                ..at(
                    "shop",
                    Act::Make {
                        kind: "sequence".into(),
                        note: "the login request".into()
                    }
                )
            })
        );
        assert_eq!(a.len(), 8);
        assert_eq!(parse(&["shop"]), Ok(at("shop", Act::List)));
        let json = parse(&["./shop", "--json"]).unwrap();
        assert_eq!(
            (json.repo.as_str(), &json.act, json.json),
            ("./shop", &Act::List, true)
        );
        assert_eq!(
            parse(&["shop", "make"]).unwrap().act,
            Act::Make {
                kind: "auto".into(),
                note: String::new()
            }
        );
        assert_eq!(
            parse(&[
                "shop",
                "revise",
                "architecture-shop-20261121-090000",
                "-m",
                "add auth"
            ])
            .unwrap()
            .act,
            Act::Revise {
                diagram: "architecture-shop-20261121-090000".into(),
                note: "add auth".into()
            }
        );
        assert_eq!(
            parse(&["shop", "save", "d1"]).unwrap().act,
            Act::Save {
                diagram: "d1".into(),
                file: None
            }
        );
        assert_eq!(
            parse(&["shop", "save", "d1", "out.html"]).unwrap().act,
            Act::Save {
                diagram: "d1".into(),
                file: Some("out.html".into())
            }
        );
        let rm = parse(&["shop", "rm", "d1", "--backend", "http://x:1"]).unwrap();
        assert_eq!(
            (rm.act, rm.backend.as_deref()),
            (
                Act::Rm {
                    diagram: "d1".into()
                },
                Some("http://x:1")
            )
        );
    }

    #[test]
    fn parse_archify_args_refuses_what_it_cannot_run() {
        let usage = Err(ARCHIFY_USAGE.clone());
        assert_eq!(parse(&[]), usage);
        assert_eq!(parse(&["--json"]), usage);
        assert_eq!(parse(&["shop", "draw"]), usage);
        assert_eq!(parse(&["shop", "list", "extra"]), usage);
        assert!(
            parse(&["shop", "make", "--type", "mindmap"])
                .unwrap_err()
                .contains("--type is auto or one of")
        );
        assert!(
            parse(&["shop", "rm", "d1", "--type", "erd"])
                .unwrap_err()
                .contains("--type goes with make")
        );
        assert!(
            parse(&["shop", "rm", "d1", "-m", "x"])
                .unwrap_err()
                .contains("-m goes with make or revise")
        );
        assert_eq!(
            parse(&["shop", "revise", "d1"]),
            Err("say what to change with -m".into())
        );
        assert_eq!(
            parse(&["shop", "revise", "d1", "-m", "  "]),
            Err("say what to change with -m".into())
        );
        assert_eq!(parse(&["shop", "revise", "-m", "x"]), usage);
        assert_eq!(parse(&["shop", "rm", "../etc"]), usage);
        assert_eq!(parse(&["shop", "rm"]), usage);
        assert_eq!(parse(&["shop", "make", "extra"]), usage);
        assert_eq!(parse(&["shop", "save", "d1", "a", "b"]), usage);
        assert_eq!(
            parse(&["shop", "--backend", "http://x:1", "--on", "mini"]),
            Err("use either --backend URL or --on NAME".into())
        );
    }

    #[test]
    fn the_usage_names_every_type() {
        assert_eq!(
            ARCHIFY_USAGE.lines().nth(1),
            Some(
                "       canopy archify <repo> make [--type auto|architecture|workflow|sequence|dataflow|lifecycle|erd|class|tree|timeline|waterfall|explainer] [-m note] [--backend URL] [--on NAME]"
            )
        );
    }

    #[test]
    fn archify_lines_says_the_diagrams_and_the_run() {
        let now = 1_795_262_400_000.0; // 2026-11-21T12:00:00.000Z
        let d = json!({"id": "architecture-shop-20261121-090000", "file": "shop.html", "title": "Shop", "type": "architecture", "bytes": 9, "builtAt": now - 3.0 * 3_600_000.0, "checks": "browser-skipped", "tracked": true});
        assert_eq!(
            archify_lines(&json!({"diagrams": [], "run": null}), now),
            ["no diagrams yet"]
        );
        assert_eq!(
            archify_lines(&json!({"diagrams": [d], "run": "r7"}), now),
            [
                "1 diagram, built 3h ago",
                "  architecture-shop-20261121-090000  Shop  (architecture, 3h ago, checked, no browser check, in git)",
                "run r7 is drawing one now (canopy run show r7)",
            ]
        );
        let bare = json!({"id": "sequence-login-1", "file": "login.html", "title": null, "type": null, "bytes": 1, "builtAt": now, "checks": null});
        assert_eq!(
            archify_lines(&json!({"diagrams": [bare.clone(), bare], "run": null}), now),
            [
                "2 diagrams; the newest built just now",
                "  sequence-login-1  login.html  (diagram, just now, not checked)",
                "  sequence-login-1  login.html  (diagram, just now, not checked)",
            ]
        );
    }

    fn caller() -> Caller {
        Caller {
            env_api: Some("http://home.invalid".into()),
            ..Caller::default()
        }
    }

    fn listing() -> Value {
        json!({"diagrams": [{"id": "architecture-shop-1", "file": "shop.html", "title": "Shop", "type": "architecture", "bytes": 9, "builtAt": 0, "checks": "pass"}], "run": null})
    }

    #[tokio::test]
    async fn starts_saves_and_removes_through_the_route() {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{m} {p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
            Ok::<Value, AskError>(match b.and_then(|b| b.get("act")).and_then(Value::as_str) {
                None if p.contains("&diagram=") => json!("<html><title>Shop</title></html>"),
                None => listing(),
                Some("remove") => json!({"removed": "architecture-shop-1"}),
                Some(_) => json!({"id": "r9", "verb": "draw"}),
            })
        });
        let dir = std::env::temp_dir().join(format!("canopy-archify-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        for a in [
            &["shop", "make", "--type", "erd", "-m", "orders"][..],
            &["shop", "revise", "architecture-shop-1", "-m", "add auth"],
            &["shop", "save", "architecture-shop-1"],
            &["shop", "save", "architecture-shop-1", "pages/copy.html"],
            &["shop", "rm", "architecture-shop-1"],
        ] {
            archify_cmd(argv(a), &caller(), &fake, &mut out, &cwd, &clock)
                .await
                .unwrap();
        }
        let saved = std::fs::read_to_string(dir.join("shop.html")).unwrap();
        let copy = std::fs::read_to_string(dir.join("pages/copy.html")).unwrap();
        let again = archify_cmd(
            argv(&["shop", "save", "architecture-shop-1"]),
            &caller(),
            &fake,
            &mut Out::default(),
            &cwd,
            &clock,
        )
        .await;
        let unknown = archify_cmd(
            argv(&["shop", "save", "erd-x"]),
            &caller(),
            &fake,
            &mut Out::default(),
            &cwd,
            &clock,
        )
        .await;
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(saved, "<html><title>Shop</title></html>");
        assert_eq!(copy, saved);
        assert_eq!(
            again.unwrap_err(),
            "shop.html is there already; name another file"
        );
        assert_eq!(
            unknown.unwrap_err(),
            "no diagram erd-x; canopy archify shop lists them"
        );
        assert_eq!(
            out.printed(),
            [
                "started run r9 (draw). Follow it with canopy run show r9; its questions wait in the page.",
                "started run r9 (draw). Follow it with canopy run show r9; its questions wait in the page.",
                "saved Shop to shop.html; it opens in any browser",
                "saved Shop to pages/copy.html; it opens in any browser",
                "removed .archify/architecture-shop-1",
            ]
        );
        let path = "/api/repos/archify?id=shop";
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen[..5],
            [
                format!("POST {path} {{\"act\":\"make\",\"type\":\"erd\",\"note\":\"orders\"}}"),
                format!(
                    "POST {path} {{\"act\":\"revise\",\"diagram\":\"architecture-shop-1\",\"note\":\"add auth\"}}"
                ),
                format!("GET {path} "),
                format!("GET {path}&diagram=architecture-shop-1 "),
                format!("GET {path} "),
            ]
        );
        assert_eq!(seen[5], format!("GET {path}&diagram=architecture-shop-1 "));
        assert_eq!(
            seen[6],
            format!("POST {path} {{\"act\":\"remove\",\"diagram\":\"architecture-shop-1\"}}")
        );
        assert_eq!(
            seen.len(),
            9,
            "a page that is there already, or no diagram, asks only the list"
        );
    }

    #[tokio::test]
    async fn the_list_and_its_json_and_a_backend_that_does_not_answer() {
        let fake =
            Fake(
                |_: &Target, _: &str, _: &str, _: Option<&Value>| Ok::<Value, AskError>(listing()),
            );
        let now = || 3.0 * 3_600_000.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        archify_cmd(argv(&["shop"]), &caller(), &fake, &mut out, "/", &clock)
            .await
            .unwrap();
        assert_eq!(
            out.printed(),
            [
                "1 diagram, built 3h ago",
                "  architecture-shop-1  Shop  (architecture, 3h ago, checked)",
            ]
        );
        let mut out = Out::default();
        archify_cmd(
            argv(&["shop", "--json"]),
            &caller(),
            &fake,
            &mut out,
            "/",
            &clock,
        )
        .await
        .unwrap();
        assert_eq!(out.text, format!("{}\n", pretty(&listing())));
        let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err::<Value, AskError>(AskError::Unreachable("http://home.invalid: refused".into()))
        });
        assert_eq!(
            archify_cmd(
                argv(&["shop", "rm", "d1"]),
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
}
