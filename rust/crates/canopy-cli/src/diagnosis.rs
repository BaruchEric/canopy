//! `canopy diagnosis` (`src/cli/diagnosis.ts`): a checkout's Architecture
//! Diagnosis (FR-075). Says what the last analysis found, starts one on the
//! backend and waits for it, saves its page to a file here, and removes it,
//! over the HTTP API.

use crate::api::Caller;
use crate::ask::{AskError, Target, did_not_answer, form_query, has, take};
use crate::mapsection::{
    AskText, Clock, ago_ms, is_there, pretty, repo_id, selected_target, write_page,
};
use crate::out::Out;
use canopy_core::diagnosis::{
    DIAGNOSIS_LANGUAGES, DIAGNOSIS_PAGE, DIAGNOSIS_PATH, changes_line, diagnosis_failure,
    diagnosis_line, is_diagnosis_pick, others_line,
};
use canopy_core::js::{field, list_at, template, truthy, truthy_at};
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::time::Duration;

/// `DIAGNOSIS_USAGE`.
pub static DIAGNOSIS_USAGE: LazyLock<String> = LazyLock::new(|| {
    [
        "usage: canopy diagnosis <repo> [status] [--json] [--backend URL] [--on NAME]".to_string(),
        format!(
            "       canopy diagnosis <repo> run [--language auto|{}] [--no-wait] [--backend URL] [--on NAME]",
            DIAGNOSIS_LANGUAGES.join("|")
        ),
        "       canopy diagnosis <repo> save [file] [--backend URL] [--on NAME]".into(),
        "       canopy diagnosis <repo> rm [--backend URL] [--on NAME]".into(),
    ]
    .join("\n")
});

/// What the command does, with its own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Act {
    Status,
    Run { language: String, wait: bool },
    Save { file: Option<String> },
    Rm,
}

/// `DiagnosisArgs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosisArgs {
    pub repo: String,
    pub json: bool,
    pub backend: Option<String>,
    pub on: Option<String>,
    pub act: Act,
}

/// `parseDiagnosisArgs()`: the command's words, or what is wrong with
/// them. The caller's list is not changed.
pub fn parse_diagnosis_args(argv: &[String]) -> Result<DiagnosisArgs, String> {
    let usage = || DIAGNOSIS_USAGE.clone();
    let mut args = argv.to_vec();
    let backend = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    let language = take(&mut args, "--language");
    let json = has(&mut args, "--json");
    let no_wait = has(&mut args, "--no-wait");
    let repo = args.first().cloned().unwrap_or_default();
    let word = args.get(1).map_or("status", String::as_str);
    let rest = args.get(2..).unwrap_or(&[]);
    if repo.is_empty() || repo.starts_with('-') {
        return Err(usage());
    }
    if backend.is_some() && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }
    if (language.is_some() || no_wait) && word != "run" {
        return Err(format!(
            "--language and --no-wait go with run\n\n{}",
            usage()
        ));
    }
    let act = match word {
        "status" if rest.is_empty() => Act::Status,
        "run" => {
            let pick = language.unwrap_or_else(|| "auto".into());
            if !is_diagnosis_pick(&pick) {
                return Err(format!(
                    "--language is auto or one of {}",
                    DIAGNOSIS_LANGUAGES.join(", ")
                ));
            }
            if !rest.is_empty() {
                return Err(usage());
            }
            Act::Run {
                language: pick,
                wait: !no_wait,
            }
        }
        "save" if rest.len() <= 1 => Act::Save {
            file: rest.first().cloned(),
        },
        "rm" if rest.is_empty() => Act::Rm,
        _ => return Err(usage()),
    };
    Ok(DiagnosisArgs {
        repo,
        json,
        backend,
        on,
        act,
    })
}

/// `v !== null`: a missing field is undefined, which is not null.
fn not_null(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Null))
}

/// `diagnosisLines()`: a diagnosis in lines, the summary, what changed,
/// what to look at first, what was left out, and the last failure. `now`
/// is unix ms.
pub fn diagnosis_lines(info: &Value, now: f64) -> Vec<String> {
    let facts = info
        .get("report")
        .and_then(|r| r.get("facts"))
        .filter(|f| !f.is_null());
    let lit = facts.filter(|f| truthy(Some(f)));
    let changes = lit.and_then(|f| changes_line(f.get("changes")));
    let others = lit.and_then(|f| others_line(list_at(f, "others")));
    let running = not_null(info.get("running"));
    let tracked = if truthy_at(info, "tracked") {
        " (in git)"
    } else {
        ""
    };
    let mut out = vec![format!(
        "{}{tracked}",
        diagnosis_line(info, |ms| ago_ms(now, ms))
    )];
    if running && truthy_at(info, "report") {
        out.push("an analysis is going now".into());
    }
    out.extend(changes);
    for l in facts.map_or(&[][..], |f| list_at(f, "leads")) {
        let place = if truthy_at(l, "where") {
            format!("  ({})", field(l, "where"))
        } else {
            String::new()
        };
        out.push(format!(
            "  {}  {}{place}",
            field(l, "severity"),
            field(l, "message")
        ));
    }
    out.extend(others);
    if truthy_at(info, "failed") && !running {
        out.push(format!(
            "the last analysis failed: {}",
            template(info.get("failed"))
        ));
    }
    out
}

/// how often a waiting `run` reads the route, and for how long
const WAIT_EVERY: u64 = 2_000;
const WAIT_MS: f64 = 16.0 * 60_000.0;

/// `diagnosisCommand()`. `cwd` is the folder a path argument and a saved
/// page are read against.
pub(crate) async fn diagnosis_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl AskText,
    out: &mut Out,
    cwd: &str,
    clock: &Clock<'_>,
) -> Result<(), String> {
    let p = parse_diagnosis_args(&argv)?;
    let target = selected_target(ask, caller, p.backend.as_deref(), p.on.as_deref()).await?;
    let id = repo_id(ask, &p.repo, &target, cwd).await?;
    let path = format!("/api/repos/diagnosis?{}", form_query(&[("id", &id)]));
    // an older backend's bare 404 gets its meaning; the rest pass as they are
    let failed = |e: AskError| diagnosis_failure(&did_not_answer(&target.name, &e));
    let say = |out: &mut Out, info: &Value| {
        if p.json {
            out.line(pretty(info));
        } else {
            out.lines(diagnosis_lines(info, clock.now()));
        }
    };
    match &p.act {
        Act::Status => {
            let info = read(ask, &target, &path).await.map_err(failed)?;
            say(out, &info);
        }
        Act::Run { language, wait } => {
            let body = json!({"act": "run", "language": language});
            ask.ask_within(
                &target,
                "POST",
                &path,
                Some(&body),
                Duration::from_millis(60_000),
            )
            .await
            .map_err(failed)?;
            if !wait {
                out.line(format!(
                    "the analysis started; canopy diagnosis {} says when it is done",
                    p.repo
                ));
                return Ok(());
            }
            let until = clock.now() + WAIT_MS;
            loop {
                clock.nap(WAIT_EVERY).await;
                let info = read(ask, &target, &path).await.map_err(failed)?;
                if info.get("running") == Some(&Value::Null) {
                    if truthy_at(&info, "failed") {
                        return Err(format!(
                            "the analysis failed: {}",
                            template(info.get("failed"))
                        ));
                    }
                    say(out, &info);
                    return Ok(());
                }
                if clock.now() > until {
                    return Err(format!(
                        "the analysis is still going; canopy diagnosis {} says when it is done",
                        p.repo
                    ));
                }
            }
        }
        Act::Save { file } => {
            let info = read(ask, &target, &path).await.map_err(failed)?;
            if !truthy_at(&info, "report") {
                return Err(format!(
                    "no diagnosis yet; canopy diagnosis {} run makes one",
                    p.repo
                ));
            }
            let file = file.clone().unwrap_or_else(|| DIAGNOSIS_PAGE.into());
            if is_there(cwd, &file) {
                return Err(format!("{file} is there already; name another file"));
            }
            let html = ask
                .ask_text_within(
                    &target,
                    &format!("{path}&page=1"),
                    Duration::from_millis(120_000),
                )
                .await
                .map_err(failed)?;
            write_page(cwd, &file, &html)?;
            out.line(format!(
                "saved the diagnosis to {file}; it opens in any browser"
            ));
        }
        Act::Rm => {
            ask.ask(&target, "POST", &path, Some(&json!({"act": "remove"})))
                .await
                .map_err(failed)?;
            out.line(format!("removed {DIAGNOSIS_PATH}"));
        }
    }
    Ok(())
}

/// The route's read of the diagnosis.
async fn read(ask: &impl AskText, target: &Target, path: &str) -> Result<Value, AskError> {
    ask.ask_within(target, "GET", path, None, Duration::from_millis(30_000))
        .await
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

    fn parse(a: &[&str]) -> Result<DiagnosisArgs, String> {
        parse_diagnosis_args(&argv(a))
    }

    fn at(repo: &str, act: Act) -> DiagnosisArgs {
        DiagnosisArgs {
            repo: repo.into(),
            json: false,
            backend: None,
            on: None,
            act,
        }
    }

    #[test]
    fn parse_diagnosis_args_reads_the_repo_the_act_and_its_words_and_leaves_the_list_alone() {
        let a = argv(&["shop", "run", "--language", "py", "--on", "mini"]);
        assert_eq!(
            parse_diagnosis_args(&a),
            Ok(DiagnosisArgs {
                on: Some("mini".into()),
                ..at(
                    "shop",
                    Act::Run {
                        language: "py".into(),
                        wait: true
                    }
                )
            })
        );
        assert_eq!(a.len(), 6);
        assert_eq!(parse(&["shop"]), Ok(at("shop", Act::Status)));
        let json = parse(&["./shop", "status", "--json"]).unwrap();
        assert_eq!(
            (json.repo.as_str(), &json.act, json.json),
            ("./shop", &Act::Status, true)
        );
        assert_eq!(
            parse(&["shop", "run"]).unwrap().act,
            Act::Run {
                language: "auto".into(),
                wait: true
            }
        );
        assert_eq!(
            parse(&["shop", "run", "--no-wait"]).unwrap().act,
            Act::Run {
                language: "auto".into(),
                wait: false
            }
        );
        assert_eq!(
            parse(&["shop", "save"]).unwrap().act,
            Act::Save { file: None }
        );
        assert_eq!(
            parse(&["shop", "save", "out.html"]).unwrap().act,
            Act::Save {
                file: Some("out.html".into())
            }
        );
        let rm = parse(&["shop", "rm", "--backend", "http://x:1"]).unwrap();
        assert_eq!(
            (rm.act, rm.backend.as_deref()),
            (Act::Rm, Some("http://x:1"))
        );
    }

    #[test]
    fn parse_diagnosis_args_refuses_what_it_cannot_run() {
        let usage = Err(DIAGNOSIS_USAGE.clone());
        assert_eq!(parse(&[]), usage);
        assert_eq!(parse(&["--json"]), usage);
        assert_eq!(parse(&["shop", "analyze"]), usage);
        assert_eq!(parse(&["shop", "status", "extra"]), usage);
        assert_eq!(parse(&["shop", "rm", "extra"]), usage);
        assert_eq!(parse(&["shop", "save", "a.html", "b.html"]), usage);
        assert_eq!(parse(&["shop", "run", "extra"]), usage);
        assert!(
            parse(&["shop", "run", "--language", "cobol"])
                .unwrap_err()
                .contains("--language is auto or one of")
        );
        assert!(
            parse(&["shop", "rm", "--language", "ts"])
                .unwrap_err()
                .contains("--language and --no-wait go with run")
        );
        assert!(
            parse(&["shop", "--no-wait"])
                .unwrap_err()
                .contains("--language and --no-wait go with run")
        );
        assert_eq!(
            parse(&["shop", "--backend", "http://x:1", "--on", "mini"]),
            Err("use either --backend URL or --on NAME".into())
        );
    }

    #[test]
    fn the_usage_names_every_language() {
        assert_eq!(
            DIAGNOSIS_USAGE.lines().nth(1),
            Some(
                "       canopy diagnosis <repo> run [--language auto|ts|py|java|go|rust|c|cpp] [--no-wait] [--backend URL] [--on NAME]"
            )
        );
    }

    fn none() -> Value {
        json!({"report": null, "running": null, "failed": null, "settings": {"language": null, "exclude": []}})
    }

    fn with(mut v: Value, more: Value) -> Value {
        for (k, x) in more.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn analyzed(now: f64) -> Value {
        with(
            none(),
            json!({
                "tracked": true,
                "running": now,
                "report": {
                    "builtAt": now - 3.0 * 3_600_000.0,
                    "bytes": 9,
                    "facts": {
                        "language": "ts", "files": 263, "findings": 270, "errors": 2, "warnings": 104,
                        "leads": [
                            {"code": "coupling/import-cycle", "severity": "error", "message": "16 files form a module-scope import cycle.", "where": "ui/src/App.tsx:1"},
                            {"code": "complexity/function", "severity": "warning", "message": "handleApi has cyclomatic complexity 982.", "where": null},
                        ],
                        "others": [{"language": "py", "files": 26}],
                        "changes": {"comparable": true, "added": 1, "gone": 0, "changed": 2},
                    },
                },
            }),
        )
    }

    #[test]
    fn diagnosis_lines_says_the_findings_the_changes_the_leads_what_was_left_out_and_a_failure() {
        let now = 1_795_348_800_000.0; // 2026-11-22T12:00:00.000Z
        assert_eq!(diagnosis_lines(&none(), now), ["no diagnosis yet"]);
        assert_eq!(
            diagnosis_lines(&with(none(), json!({"running": now})), now),
            ["analyzing the code…"]
        );
        assert_eq!(
            diagnosis_lines(
                &with(
                    none(),
                    json!({"failed": "No language adapter matched the analyzed directory."})
                ),
                now
            ),
            [
                "no diagnosis yet",
                "the last analysis failed: No language adapter matched the analyzed directory."
            ]
        );
        assert_eq!(
            diagnosis_lines(&analyzed(now), now),
            [
                "270 findings (2 errors) in 263 files of JS/TS, analyzed 3h ago (in git)",
                "an analysis is going now",
                "since the analysis before: 1 new, 2 with changed code",
                "  error  16 files form a module-scope import cycle.  (ui/src/App.tsx:1)",
                "  warning  handleApi has cyclomatic complexity 982.",
                "not read in this run: 26 files of Python",
            ]
        );
    }

    fn caller() -> Caller {
        Caller {
            env_api: Some("http://home.invalid".into()),
            ..Caller::default()
        }
    }

    #[tokio::test]
    async fn run_starts_the_analysis_and_waits_until_it_is_done() {
        let reads = Mutex::new(0);
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{m} {p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
            if m == "POST" {
                return Ok::<Value, AskError>(json!({"running": 1}));
            }
            let mut n = reads.lock().unwrap();
            *n += 1;
            Ok(if *n < 3 {
                with(none(), json!({"running": 1}))
            } else {
                with(
                    analyzed(3.0 * 3_600_000.0),
                    json!({"running": null, "tracked": false}),
                )
            })
        });
        let now = || 3.0 * 3_600_000.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        diagnosis_cmd(
            argv(&["web/shop", "run", "--language", "ts"]),
            &caller(),
            &fake,
            &mut out,
            "/",
            &clock,
        )
        .await
        .unwrap();
        assert_eq!(
            out.printed(),
            [
                "270 findings (2 errors) in 263 files of JS/TS, analyzed 3h ago",
                "since the analysis before: 1 new, 2 with changed code",
                "  error  16 files form a module-scope import cycle.  (ui/src/App.tsx:1)",
                "  warning  handleApi has cyclomatic complexity 982.",
                "not read in this run: 26 files of Python",
            ]
        );
        let path = "/api/repos/diagnosis?id=web%2Fshop";
        assert_eq!(
            *seen.lock().unwrap(),
            [
                format!("POST {path} {{\"act\":\"run\",\"language\":\"ts\"}}"),
                format!("GET {path} "),
                format!("GET {path} "),
                format!("GET {path} "),
            ]
        );
        let mut out = Out::default();
        diagnosis_cmd(
            argv(&["web/shop", "run", "--no-wait"]),
            &caller(),
            &fake,
            &mut out,
            "/",
            &clock,
        )
        .await
        .unwrap();
        assert_eq!(
            out.printed(),
            ["the analysis started; canopy diagnosis web/shop says when it is done"]
        );
    }

    #[tokio::test]
    async fn a_failed_analysis_and_one_that_runs_too_long_say_so() {
        let failed = Fake(|_: &Target, m: &str, _: &str, _: Option<&Value>| {
            Ok::<Value, AskError>(if m == "POST" {
                json!({"running": 1})
            } else {
                with(none(), json!({"failed": "No language adapter matched."}))
            })
        });
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        assert_eq!(
            diagnosis_cmd(
                argv(&["shop", "run"]),
                &caller(),
                &failed,
                &mut Out::default(),
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "the analysis failed: No language adapter matched."
        );
        let going = Fake(|_: &Target, m: &str, _: &str, _: Option<&Value>| {
            Ok::<Value, AskError>(if m == "POST" {
                json!({"running": 1})
            } else {
                with(none(), json!({"running": 1}))
            })
        });
        // each read of the clock is a minute on
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
            diagnosis_cmd(
                argv(&["shop", "run"]),
                &caller(),
                &going,
                &mut Out::default(),
                "/",
                &clock
            )
            .await
            .unwrap_err(),
            "the analysis is still going; canopy diagnosis shop says when it is done"
        );
        assert_eq!(
            ticks.get(),
            18.0 * 60_000.0,
            "the start, then sixteen minutes and one more"
        );
    }

    #[tokio::test]
    async fn save_writes_the_page_here_and_rm_removes_the_folder() {
        let seen = Mutex::new(Vec::new());
        let fake = Fake(|_: &Target, m: &str, p: &str, b: Option<&Value>| {
            seen.lock().unwrap().push(format!(
                "{m} {p} {}",
                b.map(Value::to_string).unwrap_or_default()
            ));
            Ok::<Value, AskError>(if p.ends_with("&page=1") {
                json!("<html>analysis</html>")
            } else if m == "POST" {
                json!({"removed": true})
            } else {
                analyzed(0.0)
            })
        });
        let dir = std::env::temp_dir().join(format!("canopy-diagnosis-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        let mut out = Out::default();
        diagnosis_cmd(
            argv(&["shop", "save"]),
            &caller(),
            &fake,
            &mut out,
            &cwd,
            &clock,
        )
        .await
        .unwrap();
        let again = diagnosis_cmd(
            argv(&["shop", "save"]),
            &caller(),
            &fake,
            &mut Out::default(),
            &cwd,
            &clock,
        )
        .await;
        diagnosis_cmd(
            argv(&["shop", "rm"]),
            &caller(),
            &fake,
            &mut out,
            &cwd,
            &clock,
        )
        .await
        .unwrap();
        let saved = std::fs::read_to_string(dir.join(DIAGNOSIS_PAGE));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(saved.unwrap(), "<html>analysis</html>");
        assert_eq!(
            again.unwrap_err(),
            "repo.analysis.html is there already; name another file"
        );
        assert_eq!(
            out.printed(),
            [
                "saved the diagnosis to repo.analysis.html; it opens in any browser",
                "removed .archify/diagnosis",
            ]
        );
        let path = "/api/repos/diagnosis?id=shop";
        assert_eq!(
            *seen.lock().unwrap(),
            [
                format!("GET {path} "),
                format!("GET {path}&page=1 "),
                format!("GET {path} "),
                format!("POST {path} {{\"act\":\"remove\"}}"),
            ]
        );
        let empty =
            Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| Ok::<Value, AskError>(none()));
        assert_eq!(
            diagnosis_cmd(
                argv(&["shop", "save"]),
                &caller(),
                &empty,
                &mut Out::default(),
                &cwd,
                &clock
            )
            .await
            .unwrap_err(),
            "no diagnosis yet; canopy diagnosis shop run makes one"
        );
    }

    #[tokio::test]
    async fn an_older_backends_404_says_what_it_means() {
        let old = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err::<Value, AskError>(AskError::Refused {
                message: "not found".into(),
                status: 404,
            })
        });
        let now = || 0.0;
        let clock = Clock {
            now: &now,
            naps: false,
        };
        assert!(
            diagnosis_cmd(
                argv(&["shop"]),
                &caller(),
                &old,
                &mut Out::default(),
                "/",
                &clock
            )
            .await
            .unwrap_err()
            .contains("from before the Architecture Diagnosis")
        );
        let mut out = Out::default();
        let fine =
            Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| Ok::<Value, AskError>(none()));
        diagnosis_cmd(
            argv(&["shop", "--json"]),
            &caller(),
            &fine,
            &mut out,
            "/",
            &clock,
        )
        .await
        .unwrap();
        assert_eq!(out.text, format!("{}\n", pretty(&none())));
    }
}
