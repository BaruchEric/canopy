//! health.test.ts's cases (parseCheckArgs, filterChecks, showLines,
//! defLines, changeLines, starterFile, targetsOf), and the command against
//! a fake backend: the listing and its exit, one backend down among two,
//! show, heal, checks, rm's refusals, lint, init and watch on a backend
//! that does not answer.

use super::*;
use crate::ask::AskError;
use crate::ask::tests::Fake;
use std::cell::RefCell;
use std::sync::Mutex;

const PLAIN: Paint = Paint { color: false };

fn check(id: &str, state: &str, over: Value) -> Value {
    let mut c = json!({
        "id": id, "label": id, "scope": {"kind": "canopy"}, "state": state, "why": null,
        "since": 0, "lastOk": null, "heal": "none", "fails": 0, "nextHeal": null,
        "button": false, "history": [],
    });
    if let Some(o) = over.as_object() {
        for (k, v) in o {
            c[k] = v.clone();
        }
    }
    c
}

fn s(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| w.to_string()).collect()
}

#[test]
fn parse_check_args_each_kind_from_its_flag_with_the_shared_ones() {
    let got = |name: &str, flags: &[&str]| parse_check_args(name, &s(flags));
    assert_eq!(
        got(
            "site",
            &["--http", "http://127.0.0.1:3000/", "--expect", "204"]
        ),
        Ok(json!({"name": "site", "kind": "http", "url": "http://127.0.0.1:3000/", "expect": 204}))
    );
    assert_eq!(
        got(
            "db",
            &["--port", "5432", "--host", "db.local", "--heal", "none"]
        ),
        Ok(json!({"name": "db", "heal": "none", "kind": "port", "port": 5432, "host": "db.local"}))
    );
    assert_eq!(
        got("dev", &["--task", "dev", "--heal", "auto", "--every", "10"]),
        Ok(json!({"name": "dev", "heal": "auto", "every": 10, "kind": "task", "task": "dev"}))
    );
    assert_eq!(
        got(
            "pg",
            &[
                "--compose",
                "postgres",
                "--file",
                "c.yml",
                "--fix",
                "make up"
            ]
        ),
        Ok(
            json!({"name": "pg", "fix": "make up", "kind": "compose", "service": "postgres", "file": "c.yml"})
        )
    );
    assert_eq!(
        got("smoke", &["--command", "bun run smoke"]),
        Ok(json!({"name": "smoke", "kind": "command", "run": "bun run smoke"}))
    );
    assert_eq!(
        got("site", &["--http", "http://a/", "--while", "dev"]),
        Ok(json!({"name": "site", "while": "dev", "kind": "http", "url": "http://a/"}))
    );
}

#[test]
fn parse_check_args_exactly_one_kind_every_flag_understood_and_the_servers_rules() {
    let err = |name: &str, flags: &[&str]| parse_check_args(name, &s(flags)).unwrap_err();
    assert!(err("x", &[]).contains("name one kind"));
    assert!(err("x", &["--port", "1", "--task", "dev"]).contains("name one kind"));
    assert!(err("x", &["--port"]).contains("needs a value"));
    assert!(err("x", &["--port", "1", "--nope"]).contains("not understood"));
    assert!(err("x", &["--port", "70000"]).contains("1 to 65535"));
    assert!(err("x", &["--http", "ftp://a"]).contains("http(s) url"));
    assert!(err("Bad Name", &["--port", "1"]).contains("bad check name"));
    // Number() of words JSON cannot hold is refused as the TypeScript refuses NaN
    assert!(err("x", &["--port", "abc"]).contains("1 to 65535"));
    assert!(err("x", &["--port", "1", "--every", "soon"]).contains("every is a number"));
    assert!(
        err("x", &["--http", "http://a/", "--expect", "1e400"])
            .contains("expect is an HTTP status")
    );
    assert_eq!(
        parse_check_args("x", &s(&["--port", "0x50"])),
        Ok(json!({"name": "x", "kind": "port", "port": 80}))
    );
}

#[test]
fn filter_checks_by_bad_by_repo_by_canopy() {
    let list = [
        check("canopy:a", "ok", json!({})),
        check(
            "repo:app:site",
            "down",
            json!({"scope": {"kind": "repo", "repoId": "app"}}),
        ),
        check(
            "repo:web:dev",
            "ok",
            json!({"scope": {"kind": "repo", "repoId": "web"}}),
        ),
    ];
    let ids = |f: ListFilter| -> Vec<String> {
        filter_checks(&list, &f)
            .iter()
            .map(|c| field(c, "id"))
            .collect()
    };
    assert_eq!(
        ids(ListFilter {
            bad: true,
            ..Default::default()
        }),
        ["repo:app:site"]
    );
    assert_eq!(
        ids(ListFilter {
            repo: Some("web".into()),
            ..Default::default()
        }),
        ["repo:web:dev"]
    );
    assert_eq!(
        ids(ListFilter {
            canopy: true,
            ..Default::default()
        }),
        ["canopy:a"]
    );
    assert_eq!(ids(ListFilter::default()).len(), 3);
}

#[test]
fn show_lines_tells_how_it_heals_and_what_it_has_been_through_newest_first() {
    let c = check(
        "repo:app:dev",
        "healing",
        json!({"why": "exited 1", "heal": "auto", "button": true, "fails": 2, "nextHeal": 9000,
               "history": [{"at": 1, "state": "ok", "why": null}, {"at": 2, "state": "healing", "why": "exited 1"}]}),
    );
    let lines = show_lines(&c, 4000.0, PLAIN);
    assert_eq!(lines[0], "repo:app:dev  healing  exited 1");
    assert!(lines.contains(&"heals      auto, and by hand (canopy health heal)".to_string()));
    assert!(lines.contains(&"fails      2 heals that did not hold".to_string()));
    assert!(lines.contains(&"next heal  in 5s".to_string()));
    let at = lines.iter().position(|l| l == "history").unwrap();
    assert!(lines[at + 1].contains("healing"));
    assert!(lines[at + 2].contains("ok"));
    // a heal already due reads 0s, one fail reads singular, and colour paints the state
    let due = check("x", "down", json!({"nextHeal": 1000, "fails": 1}));
    let lines = show_lines(&due, 9000.0, PLAIN);
    assert!(lines.contains(&"next heal  in 0s".to_string()));
    assert!(lines.contains(&"fails      1 heal that did not hold".to_string()));
    assert_eq!(
        show_lines(&due, 0.0, Paint { color: true })[0],
        "\x1b[1mx\x1b[0m  \x1b[38;2;201;123;95mdown\x1b[0m"
    );
}

#[test]
fn def_lines_says_where_each_check_is_from_and_why_one_does_not_run() {
    let lines = def_lines(
        &json!({
            "checks": [
                {"name": "site", "kind": "http", "url": "http://a/", "source": "canopy"},
                {"name": "smoke", "kind": "command", "run": "true", "source": "repo", "blocked": "not run: not your repo"},
            ],
            "errors": ["x: kind is one of http"],
        }),
        PLAIN,
    );
    assert!(lines[0].contains("from canopy's config"));
    assert!(lines[0].contains("heal none"));
    assert!(lines[1].contains("heal none"));
    assert!(lines[1].contains("not run: not your repo"));
    assert_eq!(lines[2], "x: kind is one of http");
    assert!(def_lines(&json!({"checks": [], "errors": []}), PLAIN)[0].contains("no checks"));
    assert_eq!(
        def_lines(
            &json!({"checks": [{"name": "dev", "kind": "task", "task": "dev", "heal": "auto", "every": 10, "while": "x", "fix": "make up", "source": "repo"}], "errors": []}),
            PLAIN
        ),
        [
            "dev            task     task dev  fix: make up  heal auto, every 10s, while x runs, from .canopy/health.json"
        ]
    );
}

#[test]
fn change_lines_prints_only_what_moved_and_what_left() {
    let before = by_id(&[
        check("a", "ok", json!({})),
        check("b", "ok", json!({})),
        check("c", "ok", json!({})),
    ]);
    let lines = change_lines(
        &before,
        &[
            check("a", "ok", json!({})),
            check("b", "down", json!({"why": "nothing listening"})),
            check("d", "ok", json!({})),
        ],
        PLAIN,
    );
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("down"));
    assert!(lines[1].contains('d'));
    assert!(lines[2].contains("gone"));
    assert_eq!(lines[2], "gone                 c  c");
}

#[test]
fn starter_file_checks_the_dev_task_when_there_is_one() {
    let parse = |t: String| serde_json::from_str::<Value>(&t).unwrap();
    assert_eq!(
        parse(starter_file(&TaskFiles {
            pkg: Some(json!({"scripts": {"dev": "vite", "build": "vite build"}}).to_string()),
            ..Default::default()
        })),
        json!({"checks": [{"name": "dev", "kind": "task", "task": "dev", "heal": "auto"}]})
    );
    assert_eq!(
        parse(starter_file(&TaskFiles {
            repo_file: Some(json!([{"name": "dev", "cmd": "make run"}]).to_string()),
            ..Default::default()
        }))["checks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        starter_file(&TaskFiles::default()),
        "{\n  \"checks\": []\n}\n"
    );
}

#[test]
fn targets_of_puts_home_first_at_its_own_address_then_each_other_backend_by_tailnet_then_public() {
    let ts = crate::ask::targets_of(
        "http://127.0.0.1:7850",
        "mac",
        &[
            json!({"name": "mac", "public": "https://canopy-mac.example", "tailnet": "https://mac.ts:7850"}),
            json!({"name": "mini", "public": "https://canopy.example", "tailnet": "https://mini.ts:7849"}),
            json!({"name": "gpd"}),
        ],
    );
    let got: Vec<(String, Vec<String>)> = ts.into_iter().map(|t| (t.name, t.urls)).collect();
    assert_eq!(
        got,
        [
            ("mac".to_string(), s(&["http://127.0.0.1:7850"])),
            (
                "mini".to_string(),
                s(&["https://mini.ts:7849", "https://canopy.example"])
            ),
        ]
    );
}

/// A temporary folder, removed when it goes.
struct Dir(std::path::PathBuf);

impl Dir {
    fn new(tag: &str) -> Dir {
        let d = std::env::temp_dir().join(format!("canopy-health-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Dir(std::fs::canonicalize(&d).unwrap())
    }
    fn path(&self, rel: &str) -> String {
        self.0.join(rel).to_string_lossy().into_owned()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Got {
    text: String,
    failed: bool,
    err: Option<String>,
    asked: Vec<String>,
    live: Vec<String>,
}

/// The command against `answer`, a backend that answers a request by its
/// target's name, method and path.
async fn drive<F>(argv: &[&str], answer: F) -> Got
where
    F: Fn(&str, &str, &str, Option<&Value>) -> Result<Value, AskError>,
{
    let asked = Mutex::new(Vec::new());
    let fake = Fake(|t: &Target, m: &str, p: &str, b: Option<&Value>| {
        asked.lock().unwrap().push(format!("{} {m} {p}", t.name));
        answer(&t.name, m, p, b)
    });
    let live = RefCell::new(Vec::new());
    let say = |l: String| live.borrow_mut().push(l);
    let env = HealthEnv {
        paint: PLAIN,
        now: 0.0,
        live: &say,
    };
    let mut out = Out::default();
    let err = health_cmd(s(argv), &Caller::default(), &fake, &mut out, &env)
        .await
        .err();
    Got {
        text: out.text.clone(),
        failed: out.failed,
        err,
        asked: asked.into_inner().unwrap(),
        live: live.into_inner(),
    }
}

fn listing() -> Value {
    json!({"checks": [
        check("canopy:flows", "ok", json!({"detail": "2 running"})),
        check("repo:app:site", "down", json!({"why": "nothing listening", "scope": {"kind": "repo", "repoId": "app"}})),
    ]})
}

fn refused(path: &str) -> Result<Value, AskError> {
    Err(AskError::Refused {
        message: format!("no route {path}"),
        status: 404,
    })
}

#[tokio::test]
async fn the_listing_prints_each_check_and_exits_1_while_one_is_down() {
    let got = drive(&["--backend", "http://h:1"], |_, _, p, _| match p {
        "/api/health" => Ok(listing()),
        _ => refused(p),
    })
    .await;
    assert_eq!(got.err, None);
    assert_eq!(got.asked, ["home GET /api/health"]);
    assert_eq!(
        got.text,
        "ok                   canopy:flows  2 running  canopy:flows\n\
         down                 repo:app:site  nothing listening  repo:app:site\n"
    );
    assert!(got.failed);
    let fine = drive(
        &["list", "--repo", "app", "--bad", "--backend", "http://h:1"],
        |_, _, _, _| Ok(json!({"checks": [check("canopy:flows", "ok", json!({}))]})),
    )
    .await;
    assert_eq!(fine.text, "nothing is down\n");
    assert!(!fine.failed);
    let json_out = drive(
        &["--json", "--canopy", "--backend", "http://h:1"],
        |_, _, _, _| Ok(listing()),
    )
    .await;
    let shown: Value = serde_json::from_str(&json_out.text).unwrap();
    assert_eq!(shown.as_array().unwrap().len(), 1);
    assert_eq!(shown[0]["id"], "canopy:flows");
}

#[tokio::test]
async fn every_backend_the_home_one_lists_one_of_them_down() {
    let answer = |name: &str, _: &str, p: &str, _: Option<&Value>| match (name, p) {
        ("home", "/api/backends") => {
            Ok(json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini:1"}]}))
        }
        ("mac", "/api/health") => Ok(json!({"checks": [check("canopy:flows", "ok", json!({}))]})),
        ("mini", _) => Err(AskError::Unreachable("http://mini:1: refused".into())),
        _ => refused(p),
    };
    let got = drive(&[], answer).await;
    assert_eq!(
        got.text,
        "mac\n  ok                   canopy:flows  canopy:flows\nmini\n  unreachable          http://mini:1: refused\n"
    );
    assert!(got.failed);
    let json_out = drive(&["--json"], answer).await;
    assert_eq!(
        serde_json::from_str::<Value>(&json_out.text).unwrap(),
        json!([
            {"backend": "mac", "checks": [check("canopy:flows", "ok", json!({}))]},
            {"backend": "mini", "error": "http://mini:1: refused"},
        ])
    );
    let on = drive(&["--on", "nosuch"], answer).await;
    assert_eq!(
        on.err.as_deref(),
        Some("no backend named nosuch; the home backend lists mac, mini")
    );
}

#[tokio::test]
async fn a_down_backend_alone_is_unreachable_and_watch_on_it_ends() {
    let down = |_: &str, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable("http://127.0.0.1:1: refused".into()))
    };
    let got = drive(&["--backend", "http://127.0.0.1:1"], down).await;
    assert_eq!(
        got.text,
        "unreachable          http://127.0.0.1:1: refused\n"
    );
    assert!(got.failed);
    let json_out = drive(&["--json", "--backend", "http://127.0.0.1:1"], down).await;
    assert_eq!(
        serde_json::from_str::<Value>(&json_out.text).unwrap(),
        json!([{"backend": "home", "error": "http://127.0.0.1:1: refused"}])
    );
    let watch = drive(&["watch", "--backend", "http://127.0.0.1:1"], down).await;
    assert_eq!(
        watch.live,
        ["unreachable          http://127.0.0.1:1: refused"]
    );
    assert_eq!(watch.err.as_deref(), Some("every event stream ended"));
    let origin = drive(&["--backend", "http://x/y"], down).await;
    assert_eq!(
        origin.err.as_deref(),
        Some("--backend must be an http(s) origin, got http://x/y")
    );
}

#[tokio::test]
async fn show_heal_and_the_usages() {
    let answer = |_: &str, m: &str, p: &str, _: Option<&Value>| match (m, p) {
        ("GET", "/api/health") => Ok(listing()),
        ("POST", "/api/health/heal?id=repo%3Aapp%3Asite") => {
            Ok(check("repo:app:site", "healing", json!({})))
        }
        _ => refused(p),
    };
    let b = "http://h:1";
    let show = drive(&["show", "repo:app:site", "--backend", b], answer).await;
    assert_eq!(show.err, None);
    assert!(
        show.text
            .starts_with("repo:app:site  down  nothing listening\nrepo:app:site\nsince      ")
    );
    assert!(show.failed);
    let json_out = drive(&["show", "canopy:flows", "--json", "--backend", b], answer).await;
    assert_eq!(
        serde_json::from_str::<Value>(&json_out.text).unwrap()["detail"],
        "2 running"
    );
    assert!(!json_out.failed);
    assert_eq!(
        drive(&["show", "nope", "--backend", b], answer)
            .await
            .err
            .as_deref(),
        Some("no check nope; canopy health lists them")
    );
    assert_eq!(
        drive(&["show", "--backend", b], answer)
            .await
            .err
            .as_deref(),
        Some("usage: canopy health show <id> [--on NAME]")
    );
    let heal = drive(&["heal", "repo:app:site", "--backend", b], answer).await;
    assert_eq!(
        heal.text,
        format!("{:<20} repo:app:site  repo:app:site\n", "healing")
    );
    assert!(!heal.failed);
    assert_eq!(
        drive(&["heal", "--backend", b], answer)
            .await
            .err
            .as_deref(),
        Some("usage: canopy health heal <id> [--on NAME]")
    );
    assert_eq!(
        drive(&["what", "--backend", b], answer)
            .await
            .err
            .as_deref(),
        Some(HEALTH_USAGE)
    );
    assert_eq!(
        drive(&["list", "x", "--backend", b], answer)
            .await
            .err
            .as_deref(),
        Some(HEALTH_USAGE)
    );
}

#[tokio::test]
async fn checks_and_rm_speak_to_the_home_backend_and_refuse_a_repo_files_check() {
    let info = json!({"checks": [{"name": "site", "kind": "port", "port": 1, "source": "repo"}, {"name": "mine", "kind": "http", "url": "http://a/", "source": "canopy"}], "errors": ["bad check name: \"Bad Name\""]});
    let answer = move |_: &str, m: &str, p: &str, _: Option<&Value>| match (m, p) {
        ("GET", "/api/repos/health?id=web%2Fapp") => Ok(info.clone()),
        ("DELETE", "/api/repos/health?id=web%2Fapp&name=mine") => {
            Ok(json!({"checks": [], "errors": []}))
        }
        _ => refused(p),
    };
    let b = "http://h:1";
    let checks = drive(&["checks", "web/app", "--backend", b], answer.clone()).await;
    assert_eq!(
        checks.text,
        "site           port     127.0.0.1:1  heal none, every 30s, from .canopy/health.json\n\
         mine           http     http://a/  heal none, every 30s, from canopy's config\n\
         bad check name: \"Bad Name\"\n"
    );
    assert!(checks.failed);
    assert_eq!(
        drive(&["checks", "--backend", b], answer.clone())
            .await
            .err
            .as_deref(),
        Some(HEALTH_USAGE)
    );
    assert_eq!(
        drive(&["checks", "nosuch", "--backend", b], answer.clone())
            .await
            .err
            .as_deref(),
        Some("no route /api/repos/health?id=nosuch")
    );
    assert_eq!(
        drive(&["rm", "web/app", "site", "--backend", b], answer.clone())
            .await
            .err
            .as_deref(),
        Some("site is in the repo's .canopy/health.json; edit that file to remove it")
    );
    assert_eq!(
        drive(&["rm", "web/app", "nope", "--backend", b], answer.clone())
            .await
            .err
            .as_deref(),
        Some("web/app has no check named nope")
    );
    assert_eq!(
        drive(&["rm", "web/app", "--backend", b], answer.clone())
            .await
            .err
            .as_deref(),
        Some("usage: canopy health rm <repo> <name>")
    );
    let rm = drive(&["rm", "web/app", "mine", "--backend", b], answer.clone()).await;
    assert_eq!(rm.err, None);
    assert!(rm.text.starts_with("no checks"));
    // add's flags are read before anything is sent
    let add = drive(&["add", "web/app", "x", "--port", "--backend", b], answer).await;
    assert_eq!(add.err.as_deref(), Some("--port needs a value"));
    assert!(add.asked.is_empty());
}

#[tokio::test]
async fn add_sends_the_check_and_prints_the_repos_checks() {
    let sent = Mutex::new(None);
    let got = drive(&["add", "app", "site", "--http", "http://a/", "--heal", "none", "--backend", "http://h:1"], |_, m, p, b| {
        *sent.lock().unwrap() = Some(format!("{m} {p} {}", b.map(Value::to_string).unwrap_or_default()));
        Ok(json!({"checks": [{"name": "site", "kind": "http", "url": "http://a/", "heal": "none", "source": "canopy"}], "errors": []}))
    })
    .await;
    assert_eq!(got.err, None);
    assert_eq!(
        sent.into_inner().unwrap().as_deref(),
        Some(
            r#"POST /api/repos/health?id=app {"name":"site","heal":"none","kind":"http","url":"http://a/"}"#
        )
    );
    assert_eq!(
        got.text,
        "site           http     http://a/  heal none, every 30s, from canopy's config\n"
    );
}

#[tokio::test]
async fn a_repo_by_path_is_the_one_the_backend_scans_there() {
    let dir = Dir::new("path");
    let real = dir.path("");
    let real = real.trim_end_matches('/').to_string();
    let tree = json!({"repos": [{"id": "web/app", "path": real}]});
    let answer = move |_: &str, _: &str, p: &str, _: Option<&Value>| match p {
        "/api/tree" => Ok(tree.clone()),
        "/api/repos/health?id=web%2Fapp" => Ok(json!({"checks": [], "errors": []})),
        _ => refused(p),
    };
    let got = drive(
        &["checks", &real, "--backend", "http://h:1"],
        answer.clone(),
    )
    .await;
    assert_eq!(got.err, None);
    assert_eq!(
        got.asked,
        [
            "home GET /api/tree",
            "home GET /api/repos/health?id=web%2Fapp"
        ]
    );
    let gone = dir.path("gone");
    assert_eq!(
        drive(&["checks", &gone, "--backend", "http://h:1"], answer)
            .await
            .err,
        Some(format!("no such folder: {gone}"))
    );
}

#[tokio::test]
async fn lint_reads_a_folders_health_file_and_init_writes_a_starter_once() {
    let dir = Dir::new("files");
    let none = |_: &str, _: &str, p: &str, _: Option<&Value>| refused(p);
    let missing = drive(&["lint", &dir.path("")], none).await;
    assert_eq!(
        missing.err,
        Some(format!("no {}", dir.path(".canopy/health.json")))
    );
    std::fs::write(
        dir.0.join("package.json"),
        r#"{"scripts": {"dev": "vite"}}"#,
    )
    .unwrap();
    let init = drive(&["init", &dir.path("")], none).await;
    assert_eq!(init.err, None);
    let file = dir.path(".canopy/health.json");
    assert_eq!(
        init.text,
        format!(
            "wrote {file}\n{{\n  \"checks\": [\n    {{\n      \"name\": \"dev\",\n      \"kind\": \"task\",\n      \"task\": \"dev\",\n      \"heal\": \"auto\"\n    }}\n  ]\n}}\n"
        )
    );
    assert_eq!(
        drive(&["init", &dir.path("")], none).await.err,
        Some(format!(
            "{file} is there already; canopy health lint checks it"
        ))
    );
    std::fs::write(
        &file,
        r#"{"checks": [{"name": "dev", "kind": "task", "task": "dev"}, {"name": "site", "kind": "http", "url": "http://a/"}, {"name": "x", "kind": "ftp"}]}"#,
    )
    .unwrap();
    let lint = drive(&["lint", &dir.path("")], none).await;
    assert_eq!(
        lint.text,
        "ok  dev  task task dev\nok  site  http http://a/\nbad x: kind is one of http, port, task, compose, command\n"
    );
    assert!(lint.failed);
}
