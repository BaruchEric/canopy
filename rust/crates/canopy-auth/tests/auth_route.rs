//! The cases of `src/server/callers-route.test.ts` that land on this crate's
//! functions, run through a stand-in for route()'s top: who is calling, the
//! lanes, the gate, the origin gate for the API, then the auth routes; any
//! other request that gets that far is answered 200 by the stand-in, which is
//! what "not 401 or 403" means in the TS. Also join, sign-out and approve's
//! person through a fake `AuthPeople`.

mod common;

use std::sync::{Arc, Mutex};

use canopy_auth::{
    AuthPeople, Caller, CallerGate, CallerKind as K, CallersMode, Invited, Me, MintOpts,
    OriginPolicy, PREFLIGHT_HEADERS, Reply, Req, Role, auth_route, caller_of, cors_headers,
    library_origin_allowed, return_leg,
};
use common::Scratch;
use serde_json::{Value, json};

const LISTED: &str = "https://canopy-mac.example";
const EVIL: &str = "https://evil.example";

struct Server {
    s: Scratch,
    gate: CallerGate,
    lines: Arc<Mutex<Vec<String>>>,
    pairs: Arc<Mutex<Vec<Vec<String>>>>,
    policy: OriginPolicy,
    people: Option<Box<dyn AuthPeople>>,
}

impl Server {
    /// a server in `mode` on a fresh config dir, with `mint`'s tokens already
    /// in its book and its first code announced, as a start does
    fn up(mode: CallersMode, mint: impl FnOnce(&canopy_auth::CallerBook)) -> Server {
        let s = Scratch::new();
        mint(&s.open());
        let lines: Arc<Mutex<Vec<String>>> = Arc::default();
        let pairs: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let (l, p) = (lines.clone(), pairs.clone());
        let gate = CallerGate::new(
            s.open(),
            mode,
            Arc::new(move |line| l.lock().unwrap().push(line.to_string())),
        )
        .with_clock(s.t.clock())
        .with_on_pairs(Arc::new(move |pending| {
            p.lock()
                .unwrap()
                .push(pending.iter().map(|x| x.id.clone()).collect());
        }));
        gate.announce();
        Server {
            s,
            gate,
            lines,
            pairs,
            policy: OriginPolicy {
                origins: vec![LISTED.to_string()],
                ..OriginPolicy::default()
            },
            people: None,
        }
    }

    fn call(&self, req: Req, body: &[u8]) -> Reply {
        let caller = caller_of(&self.gate.book, &req);
        if let Some(r) = self.gate.lane(&req, caller.as_ref(), "127.0.0.1", false) {
            return r;
        }
        if let Some(r) = self.gate.gate(&req, caller.as_ref()) {
            return r;
        }
        if req.path().starts_with("/api/")
            && !library_origin_allowed(&return_leg(&req), &self.policy)
        {
            return Reply::json(403, json!({ "error": "Foreign origin" }));
        }
        if let Some(r) = auth_route(
            &self.gate,
            &req,
            body,
            caller.as_ref(),
            "127.0.0.1",
            self.people.as_deref(),
        ) {
            return r;
        }
        Reply::json(200, json!({ "passed": true }))
    }

    fn get(&self, path: &str, token: Option<&str>) -> Reply {
        let mut req = Req::new("GET", &format!("http://127.0.0.1:7850{path}")).unwrap();
        if let Some(t) = token {
            req = req.with_header("x-canopy-token", t);
        }
        self.call(req, b"")
    }

    fn post(&self, path: &str, body: Value, token: Option<&str>) -> Reply {
        let mut req = Req::new("POST", &format!("http://127.0.0.1:7850{path}"))
            .unwrap()
            .with_header("content-type", "application/json");
        if let Some(t) = token {
            req = req.with_header("x-canopy-token", t);
        }
        self.call(req, body.to_string().as_bytes())
    }

    fn first_code(&self) -> String {
        let lines = self.lines.lock().unwrap();
        let line = lines
            .iter()
            .find(|l| l.contains("first sign-in code"))
            .expect("no first code");
        line.strip_prefix("canopy: first sign-in code ")
            .and_then(|r| r.strip_suffix(" (good until a page or the CLI signs in)"))
            .unwrap()
            .to_string()
    }
}

fn s(r: &Reply, k: &str) -> String {
    r.body[k].as_str().unwrap_or_default().to_string()
}

/// The "shell" tokens are minted as rangers, which hold the same rights.
const TERM: &str = "0123456789abcdef0123456789abcdef";

struct Enforce {
    srv: Server,
    shell: String,
    page: String,
}

fn enforce() -> Enforce {
    let mut shell = String::new();
    let mut page = String::new();
    let srv = Server::up(CallersMode::Enforce, |book| {
        shell = book
            .mint(K::Ranger, MintOpts::label("a shell").term(TERM))
            .token;
        page = book.mint(K::Page, MintOpts::label("a page")).token;
    });
    Enforce { srv, shell, page }
}

mod in_enforce {
    use super::*;

    #[test]
    fn a_bare_post_is_refused_with_the_right_it_needed_and_no_login_key() {
        let e = enforce();
        let r = e.srv.post("/api/repos/run?id=app", json!({}), None);
        assert_eq!(r.status, 401);
        assert_eq!(s(&r, "need"), "operate");
        assert!(s(&r, "error").contains("operate"));
        assert!(r.body.get("login").is_none());
    }

    #[test]
    fn an_unknown_token_is_refused_like_no_token() {
        let e = enforce();
        assert_eq!(
            e.srv
                .post("/api/repos/run?id=app", json!({}), Some("cnp_page_nope"))
                .status,
            401
        );
    }

    #[test]
    fn a_shell_token_passes_for_operate() {
        let e = enforce();
        assert_eq!(
            e.srv
                .post("/api/repos/run?id=app", json!({}), Some(&e.shell))
                .status,
            200
        );
    }

    #[test]
    fn a_shell_token_lacks_admin_the_library_included() {
        let e = enforce();
        let role = e.srv.post("/api/agents/role", json!({}), Some(&e.shell));
        assert_eq!(role.status, 403);
        assert_eq!(s(&role, "need"), "admin");
        assert!(role.body.get("login").is_none());
        assert_eq!(
            e.srv
                .post("/library/refresh", json!({}), Some(&e.shell))
                .status,
            403
        );
    }

    #[test]
    fn the_librarys_open_runs_a_command_so_even_its_get_needs_admin() {
        let e = enforce();
        let q = "?action=finder&path=%2Ftmp%2Fapp";
        let bare = e.srv.get(&format!("/library/open{q}"), None);
        assert_eq!((bare.status, s(&bare, "need")), (401, "admin".into()));
        let lacks = e.srv.get(&format!("/library/open{q}"), Some(&e.shell));
        assert_eq!((lacks.status, s(&lacks, "need")), (403, "admin".into()));
        for p in ["/library/open;x", "/library//open", "/library/open%3Bx"] {
            let bare = e.srv.get(&format!("{p}{q}"), None);
            assert_eq!(
                (bare.status, s(&bare, "need")),
                (401, "admin".into()),
                "{p}"
            );
        }
    }

    fn events_ticket(e: &Enforce, token: &str) -> String {
        let r = e
            .srv
            .post("/api/auth/ticket", json!({ "for": "events" }), Some(token));
        assert_eq!(r.status, 200);
        s(&r, "ticket")
    }

    #[test]
    fn the_event_stream_takes_a_token_or_a_one_use_ticket() {
        let e = enforce();
        let bare = e.srv.get("/api/events", None);
        assert_eq!((bare.status, s(&bare, "need")), (401, "read".into()));
        assert_eq!(e.srv.get("/api/events?ticket=not-one", None).status, 401);
        for token in [&e.shell, &e.page] {
            assert_eq!(e.srv.get("/api/events", Some(token)).status, 200);
        }
        let ticket = events_ticket(&e, &e.page);
        assert_eq!(
            e.srv
                .get(&format!("/api/events?ticket={ticket}"), None)
                .status,
            200
        );
        assert_eq!(
            e.srv
                .get(&format!("/api/events?ticket={ticket}"), None)
                .status,
            401
        );
        let shells = events_ticket(&e, &e.shell);
        assert_eq!(
            e.srv
                .get(&format!("/api/events?ticket={shells}"), None)
                .status,
            200
        );
    }

    #[test]
    fn a_ticket_opens_only_what_it_was_asked_for() {
        let e = enforce();
        let t = events_ticket(&e, &e.page);
        assert_eq!(
            e.srv
                .get(&format!("/api/term?id=app&ticket={t}"), None)
                .status,
            401
        );
        let term = s(
            &e.srv
                .post("/api/auth/ticket", json!({ "for": "term" }), Some(&e.page)),
            "ticket",
        );
        assert_eq!(
            e.srv
                .get(&format!("/api/events?ticket={term}"), None)
                .status,
            401
        );
        // and a ticket is no token: it opens no other read
        let t = events_ticket(&e, &e.page);
        assert_eq!(
            e.srv.get(&format!("/api/tree?ticket={t}"), None).status,
            401
        );
        assert_eq!(
            e.srv
                .post("/api/auth/ticket", json!({ "for": "events" }), None)
                .status,
            401
        );
        let bad = e.srv.post(
            "/api/auth/ticket",
            json!({ "for": "everything" }),
            Some(&e.page),
        );
        assert_eq!(
            (bad.status, s(&bad, "error")),
            (400, "for is \"term\", \"helper\" or \"events\"".into())
        );
    }

    #[test]
    fn the_sweeps_plan_is_refused_to_a_shell() {
        let e = enforce();
        assert_eq!(e.srv.get("/api/sweep", Some(&e.shell)).status, 403);
        assert_eq!(
            e.srv
                .post("/api/sweep/settings", json!({}), Some(&e.page))
                .status,
            200
        );
    }

    #[test]
    fn the_board_takes_a_token() {
        let e = enforce();
        for p in [
            "/api/tree",
            "/api/runs",
            "/api/runs?kept=1",
            "/api/flows",
            "/api/fleets",
            "/api/landing",
            "/api/notes",
            "/api/work",
            "/api/tasks",
            "/api/terms",
            "/api/backends",
            "/api/health",
        ] {
            let bare = e.srv.get(p, None);
            assert_eq!((bare.status, s(&bare, "need")), (401, "read".into()), "{p}");
        }
        for token in [&e.shell, &e.page] {
            for p in [
                "/api/tree",
                "/api/runs",
                "/api/flows",
                "/api/fleets",
                "/api/landing",
                "/api/notes",
            ] {
                assert_eq!(e.srv.get(p, Some(token)).status, 200, "{p}");
            }
        }
    }

    #[test]
    fn a_caller_with_no_token_still_gets_the_page_the_build_what_is_going_and_who_it_is() {
        let e = enforce();
        for p in [
            "/",
            "/api/about",
            "/api/going",
            &format!("/api/terms/watched?term={TERM}"),
        ] {
            assert_eq!(e.srv.get(p, None).status, 200, "{p}");
        }
        assert_eq!(
            e.srv
                .post("/api/remembered/check", json!({ "tool": "Bash" }), None)
                .status,
            200
        );
    }

    #[test]
    fn auth_tells_everyone_the_mode_and_who_they_are_and_only_an_admin_the_rest() {
        let e = enforce();
        // something refused, so the count is above nought
        e.srv.get("/api/tree", None);
        let asked = e
            .srv
            .post("/api/auth/pair", json!({ "label": "a waiting page" }), None);
        let asked_id = s(&asked, "id");
        let none = e.srv.get("/api/auth", None).body;
        assert_eq!(
            (
                none["mode"].clone(),
                none["you"].clone(),
                none["youId"].clone()
            ),
            (json!("enforce"), json!("none"), Value::Null)
        );
        assert_eq!(
            (none["callers"].clone(), none["pending"].clone()),
            (json!([]), json!([]))
        );
        assert_eq!(none["refused"]["recent"], json!([]));
        assert!(none["refused"]["count"].as_u64().unwrap() > 0);
        assert_eq!(none["rights"], json!([]));
        assert_eq!(none["person"], Value::Null);
        assert_eq!(none["scope"], Value::Null);
        let hand = e.srv.get("/api/auth", Some(&e.shell)).body;
        assert_eq!(hand["you"], "ranger");
        assert!(hand["youId"].is_string());
        assert_eq!(
            (hand["callers"].clone(), hand["pending"].clone()),
            (json!([]), json!([]))
        );
        assert_eq!(hand["refused"]["recent"], json!([]));
        assert_eq!(hand["rights"], json!(["read", "plan", "operate"]));
        let admin = e.srv.get("/api/auth", Some(&e.page)).body;
        assert_eq!(admin["you"], "page");
        assert!(admin["callers"].as_array().unwrap().len() >= 2);
        let pending: Vec<&str> = admin["pending"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect();
        assert!(pending.contains(&asked_id.as_str()));
        let p = &admin["pending"][0];
        assert_eq!(p["label"], "a waiting page");
        assert_eq!(p["addr"], "127.0.0.1");
        assert_eq!(p["kind"], "page");
        assert!(!admin["refused"]["recent"].as_array().unwrap().is_empty());
        // a caller's hash never goes out
        assert!(admin["callers"][0].get("hash").is_none());
        assert_eq!(
            e.srv
                .post("/api/auth/deny", json!({ "id": asked_id }), Some(&e.page))
                .status,
            200
        );
    }

    #[test]
    fn a_pair_request_tells_the_hook_which_pairs_wait() {
        let e = enforce();
        let asked = s(
            &e.srv
                .post("/api/auth/pair", json!({ "label": "a page asking" }), None),
            "id",
        );
        assert_eq!(
            e.srv.pairs.lock().unwrap().last().unwrap(),
            &vec![asked.clone()]
        );
        e.srv
            .post("/api/auth/deny", json!({ "id": asked }), Some(&e.page));
        assert!(e.srv.pairs.lock().unwrap().last().unwrap().is_empty());
    }

    #[test]
    fn what_is_in_a_repo_takes_a_token() {
        let e = enforce();
        let raw = "/api/repos/raw?id=app&path=.env";
        let bare = e.srv.get(raw, None);
        assert_eq!((bare.status, s(&bare, "need")), (401, "operate".into()));
        for p in [
            "/api/repos/diff?id=app",
            "/api/repos/log?id=app",
            "/api/repos/ls?id=app",
            "/api/landing/diff?id=app&path=x",
            "/api/browse?path=~",
            "/api/runs/ab12cd34",
            "/api/runs/ab12cd34/export",
        ] {
            assert_eq!(e.srv.get(p, None).status, 401, "{p}");
        }
        assert_eq!(
            e.srv.post("/api/grep", json!({ "q": "KEY" }), None).status,
            401
        );
        for token in [&e.shell, &e.page] {
            assert_eq!(e.srv.get(raw, Some(token)).status, 200);
        }
        // a dot segment cannot turn a repo read into a plain read
        assert_eq!(
            e.srv.get("/api/tree/../repos/raw?id=app", None).body["need"],
            "operate"
        );
    }

    #[test]
    fn a_shell_socket_needs_a_ticket_and_a_page_token_gets_one() {
        let e = enforce();
        assert_eq!(
            e.srv
                .get(&format!("/api/term?id=app&term={TERM}"), None)
                .status,
            401
        );
        let r = e
            .srv
            .post("/api/auth/ticket", json!({ "for": "term" }), Some(&e.page));
        assert_eq!(r.status, 200);
        let t = s(&r, "ticket");
        assert_eq!(
            e.srv
                .get(&format!("/api/term?id=app&ticket={t}"), None)
                .status,
            200
        );
        assert_eq!(
            e.srv
                .get(&format!("/api/term?id=app&ticket={t}"), None)
                .status,
            401
        );
    }

    #[test]
    fn a_ticket_needs_the_right_it_opens() {
        let e = enforce();
        let bare = e
            .srv
            .post("/api/auth/ticket", json!({ "for": "term" }), None);
        assert_eq!((bare.status, s(&bare, "need")), (401, "shell".into()));
        let lacks = e
            .srv
            .post("/api/auth/ticket", json!({ "for": "term" }), Some(&e.shell));
        assert_eq!((lacks.status, s(&lacks, "need")), (403, "shell".into()));
        assert_eq!(
            e.srv
                .post(
                    "/api/auth/ticket",
                    json!({ "for": "helper" }),
                    Some(&e.page)
                )
                .status,
            403
        );
    }

    #[test]
    fn another_origin_may_not_read_auth() {
        let e = enforce();
        let req = Req::new("GET", "http://127.0.0.1:7850/api/auth")
            .unwrap()
            .with_header("origin", EVIL);
        let r = e.srv.call(req, b"");
        assert_eq!((r.status, s(&r, "error")), (403, "Foreign origin".into()));
    }

    #[test]
    fn a_preflight_from_a_listed_origin_allows_the_token_header() {
        let e = enforce();
        let headers = cors_headers(Some(LISTED), &e.srv.policy.origins).unwrap();
        assert!(headers.contains(&("Access-Control-Allow-Origin", LISTED.to_string())));
        let allow = PREFLIGHT_HEADERS
            .iter()
            .find(|(k, _)| *k == "Access-Control-Allow-Headers")
            .unwrap()
            .1;
        assert!(allow.contains("x-canopy-token"));
        assert!(cors_headers(Some(EVIL), &e.srv.policy.origins).is_none());
    }

    #[test]
    fn the_coordinator_routes_reach_the_hub_past_the_gate() {
        let e = enforce();
        assert_eq!(
            e.srv
                .post(
                    "/api/coordinator/plan",
                    json!({ "run": "nope" }),
                    Some(&e.shell)
                )
                .status,
            200
        );
        assert_eq!(
            e.srv
                .post(
                    "/api/coordinator/start",
                    json!({ "run": "nope" }),
                    Some(&e.shell)
                )
                .status,
            200
        );
        assert_eq!(
            e.srv
                .post("/api/coordinator/plan", json!({ "run": "nope" }), None)
                .status,
            401
        );
    }

    #[test]
    fn the_auth_routes_answer_one_method() {
        let e = enforce();
        let r = e.srv.post("/api/auth", json!({}), Some(&e.page));
        assert_eq!(
            (r.status, s(&r, "error")),
            (405, "/api/auth only answers a GET".into())
        );
        let r = e.srv.get("/api/auth/pair", Some(&e.page));
        assert_eq!(
            (r.status, s(&r, "error")),
            (405, "the auth routes take a POST".into())
        );
        let r = e.srv.post("/api/auth/nope", json!({}), Some(&e.page));
        assert_eq!(
            (r.status, s(&r, "error")),
            (404, "no such auth route: nope".into())
        );
    }
}

#[test]
fn a_coordinators_token_from_before_a_restart_is_dropped_at_start() {
    let mut coordinator = String::new();
    let mut ranger = String::new();
    let srv = Server::up(CallersMode::Enforce, |book| {
        coordinator = book
            .mint(
                K::Coordinator,
                MintOpts::label("coordinator app").run("gone1234"),
            )
            .token;
        ranger = book
            .mint(K::Ranger, MintOpts::label("a shell").term(TERM))
            .token;
    });
    // what a start does with the coordinators' tokens
    srv.gate.book.drop_kind(K::Coordinator).unwrap();
    assert_eq!(
        srv.post("/api/agents/role", json!({}), Some(&coordinator))
            .status,
        401
    );
    assert_eq!(
        srv.post("/api/agents/role", json!({}), Some(&ranger))
            .status,
        403
    );
}

#[test]
fn revoking_a_caller_tells_the_drop_hook_and_its_token_asks_for_no_ticket() {
    let mut holder = (String::new(), String::new());
    let mut admin = String::new();
    let srv = Server::up(CallersMode::Enforce, |book| {
        let a = book.mint(K::Page, MintOpts::label("a page with a shell open"));
        holder = (a.token, a.caller.id);
        admin = book
            .mint(K::Page, MintOpts::label("the page that revokes"))
            .token;
    });
    let dropped = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = dropped.clone();
    srv.gate.book.set_on_drop(Arc::new(move |ids| {
        sink.lock().unwrap().extend(ids.iter().cloned())
    }));
    let t = s(
        &srv.post(
            "/api/auth/ticket",
            json!({ "for": "term" }),
            Some(&holder.0),
        ),
        "ticket",
    );
    assert_eq!(
        srv.post("/api/auth/revoke", json!({ "id": holder.1 }), Some(&admin))
            .status,
        200
    );
    assert_eq!(*dropped.lock().unwrap(), [holder.1.clone()]);
    assert_eq!(
        srv.post(
            "/api/auth/ticket",
            json!({ "for": "events" }),
            Some(&holder.0)
        )
        .status,
        401
    );
    // a ticket minted before the revoke opens nothing after it
    assert_eq!(srv.get(&format!("/api/term?ticket={t}"), None).status, 401);
    let r = srv.post("/api/auth/revoke", json!({}), Some(&admin));
    assert_eq!((r.status, s(&r, "error")), (400, "id is required".into()));
}

#[test]
fn a_revoke_whose_write_fails_says_so() {
    let srv = Server::up(CallersMode::Enforce, |_| {});
    // a book on a file that cannot be written: its folder is a regular file
    let blocker = srv.s.dir.path().join("blocker");
    std::fs::write(&blocker, "x").unwrap();
    let book = Arc::new(canopy_auth::CallerBook::open_with_clock(
        blocker.join("callers.json"),
        srv.s.t.clock(),
    ));
    let admin = book.mint(K::Page, MintOpts::label("admin")).token;
    let victim = book.mint(K::Cli, MintOpts::label("cli x")).caller.id;
    let gate = CallerGate::new(book, CallersMode::Enforce, Arc::new(|_| {}));
    let caller = gate.book.check(Some(&admin));
    let req = Req::new("POST", "http://127.0.0.1:7850/api/auth/revoke").unwrap();
    let body = json!({ "id": victim }).to_string();
    let r = auth_route(&gate, &req, body.as_bytes(), caller.as_ref(), "a", None).unwrap();
    assert_eq!(r.status, 500);
    assert!(
        s(&r, "error")
            .starts_with("revoked until canopy restarts, but callers.json could not be written (")
    );
    assert!(gate.book.by_id(&victim).is_none());
}

mod in_log {
    use super::*;

    #[test]
    fn a_would_refuse_call_passes_and_is_counted() {
        let srv = Server::up(CallersMode::Log, |_| {});
        assert_eq!(
            srv.post("/api/repos/run?id=app", json!({}), None).status,
            200
        );
        let auth = srv.get("/api/auth", None).body;
        assert_eq!(auth["mode"], "log");
        assert!(auth["refused"]["count"].as_u64().unwrap() >= 1);
        assert_eq!(auth["refused"]["recent"][0]["kind"], "none");
        assert_eq!(auth["refused"]["recent"][0]["route"], "POST /api/repos/run");
    }

    #[test]
    fn the_auth_routes_are_checked_whatever_the_mode() {
        let srv = Server::up(CallersMode::Log, |_| {});
        assert_eq!(
            srv.post("/api/auth/approve", json!({ "id": "x" }), None)
                .status,
            401
        );
    }

    #[test]
    fn its_lines_go_to_the_log_sink_once_per_kind_method_and_path() {
        let srv = Server::up(CallersMode::Log, |_| {});
        srv.post("/api/repos/run?id=app", json!({}), None);
        srv.post("/api/repos/run?id=app", json!({}), None);
        let lines = srv.lines.lock().unwrap();
        let n = lines
            .iter()
            .filter(|l| *l == "callers: would refuse none POST /api/repos/run (needs operate)")
            .count();
        assert_eq!(n, 1);
    }
}

#[test]
fn in_off_a_bare_post_passes_and_nothing_is_counted() {
    let srv = Server::up(CallersMode::Off, |_| {});
    assert_eq!(
        srv.post("/api/repos/run?id=app", json!({}), None).status,
        200
    );
    let auth = srv.get("/api/auth", None).body;
    assert_eq!(auth["mode"], "off");
    assert_eq!(auth["refused"]["count"], 0);
}

mod pairing_over_http {
    use super::*;

    fn pair_server() -> (Server, String, String) {
        let mut shell = String::new();
        let mut shell_id = String::new();
        let srv = Server::up(CallersMode::Enforce, |book| {
            let m = book.mint(K::Ranger, MintOpts::label("a shell").term(TERM));
            shell = m.token;
            shell_id = m.caller.id;
        });
        (srv, shell, shell_id)
    }

    #[test]
    fn the_first_code_is_printed_at_start() {
        let (srv, _, _) = pair_server();
        let code = srv.first_code();
        assert_eq!(code.len(), 6);
    }

    #[test]
    fn a_pair_approved_by_the_first_code_claims_a_page_token_with_admin() {
        let (srv, shell, shell_id) = pair_server();
        let paired = srv.post("/api/auth/pair", json!({ "label": "page test" }), None);
        assert_eq!(paired.status, 200);
        let (id, secret) = (s(&paired, "id"), s(&paired, "secret"));
        assert_eq!(s(&paired, "code").len(), 6);
        assert_eq!(
            srv.post("/api/auth/approve", json!({ "id": id }), None)
                .status,
            401
        );
        let lacks = srv.post("/api/auth/approve", json!({ "id": id }), Some(&shell));
        assert_eq!((lacks.status, s(&lacks, "need")), (403, "admin".into()));
        let early = srv.post(
            "/api/auth/claim",
            json!({ "id": id, "secret": secret }),
            None,
        );
        assert_eq!(early.body, json!({ "waiting": true }));
        let first = srv.post(
            "/api/auth/first",
            json!({ "id": id, "code": srv.first_code().to_lowercase() }),
            None,
        );
        assert_eq!(
            (first.status, first.body.clone()),
            (200, json!({ "ok": true }))
        );
        let claimed = srv.post(
            "/api/auth/claim",
            json!({ "id": id, "secret": secret }),
            None,
        );
        assert_eq!(claimed.status, 200);
        let token = s(&claimed, "token");
        assert!(token.starts_with("cnp_page_"));
        assert_eq!(
            srv.post("/api/agents/role", json!({}), Some(&token)).status,
            200
        );
        let auth = srv.get("/api/auth", Some(&token)).body;
        assert_eq!(auth["you"], "page");
        assert_eq!(auth["pending"], json!([]));
        assert_eq!(
            srv.post("/api/auth/revoke", json!({ "id": "nobody" }), Some(&token))
                .status,
            404
        );
        assert_eq!(
            srv.post("/api/auth/revoke", json!({ "id": shell_id }), Some(&token))
                .status,
            200
        );
        assert_eq!(
            srv.post("/api/repos/run?id=app", json!({}), Some(&shell))
                .status,
            401
        );
    }

    #[test]
    fn a_wrong_secret_gets_nothing() {
        let (srv, _, _) = pair_server();
        let paired = srv.post("/api/auth/pair", json!({ "label": "page two" }), None);
        let r = srv.post(
            "/api/auth/claim",
            json!({ "id": s(&paired, "id"), "secret": "wrong" }),
            None,
        );
        assert_eq!(
            (r.status, s(&r, "error")),
            (
                404,
                "no such pair request: it was denied, claimed, or has expired".into()
            )
        );
        let r = srv.post("/api/auth/claim", json!({ "id": s(&paired, "id") }), None);
        assert_eq!(
            (r.status, s(&r, "error")),
            (400, "id and secret are required".into())
        );
    }

    #[test]
    fn a_page_polling_a_denied_pair_is_not_guessing() {
        let mut page = String::new();
        let srv = Server::up(CallersMode::Enforce, |book| {
            page = book.mint(K::Page, MintOpts::label("p")).token
        });
        let paired = srv.post("/api/auth/pair", json!({ "label": "page denied" }), None);
        let (id, secret) = (s(&paired, "id"), s(&paired, "secret"));
        assert_eq!(
            srv.post("/api/auth/deny", json!({ "id": id }), Some(&page))
                .status,
            200
        );
        for _ in 0..15 {
            assert_eq!(
                srv.post(
                    "/api/auth/claim",
                    json!({ "id": id, "secret": secret }),
                    None
                )
                .status,
                404
            );
        }
    }

    #[test]
    fn guessing_is_cut_off_after_ten_misses() {
        let (srv, _, _) = pair_server();
        let paired = srv.post("/api/auth/pair", json!({ "label": "page three" }), None);
        let (id, secret) = (s(&paired, "id"), s(&paired, "secret"));
        for _ in 0..10 {
            assert_eq!(
                srv.post(
                    "/api/auth/claim",
                    json!({ "id": id, "secret": "wrong" }),
                    None
                )
                .status,
                404
            );
        }
        let r = srv.post(
            "/api/auth/claim",
            json!({ "id": id, "secret": secret }),
            None,
        );
        assert_eq!(
            (r.status, s(&r, "error")),
            (
                429,
                "too many wrong tries from this address; try again in ten minutes".into()
            )
        );
        for _ in 0..10 {
            assert_eq!(
                srv.post(
                    "/api/auth/first",
                    json!({ "id": id, "code": "AAAAAA" }),
                    None
                )
                .status,
                403
            );
        }
        assert_eq!(
            srv.post(
                "/api/auth/first",
                json!({ "id": id, "code": "AAAAAA" }),
                None
            )
            .status,
            429
        );
        // ten minutes on, the address may try again
        srv.s.t.add(10 * common::MIN);
        assert_eq!(
            srv.post(
                "/api/auth/first",
                json!({ "id": id, "code": "AAAAAA" }),
                None
            )
            .status,
            403
        );
    }
}

mod the_pair_request_names_its_kind {
    use super::*;

    fn kind_server() -> (Server, String) {
        let mut admin = String::new();
        let srv = Server::up(CallersMode::Enforce, |book| {
            admin = book.mint(K::Page, MintOpts::label("admin page")).token
        });
        (srv, admin)
    }

    fn pending(srv: &Server, admin: &str) -> Vec<(String, String, String)> {
        let body = srv.get("/api/auth", Some(admin)).body;
        body["pending"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (s_v(&p["id"]), s_v(&p["label"]), s_v(&p["kind"])))
            .collect()
    }

    fn s_v(v: &Value) -> String {
        v.as_str().unwrap().to_string()
    }

    #[test]
    fn an_unknown_kind_is_a_400_and_makes_no_pair() {
        let (srv, admin) = kind_server();
        for kind in [
            json!("admin"),
            json!("shell"),
            json!(3),
            json!(""),
            Value::Null,
        ] {
            let r = srv.post(
                "/api/auth/pair",
                json!({ "label": "x", "kind": kind }),
                None,
            );
            assert_eq!(
                (r.status, s(&r, "error")),
                (400, "kind is one of page, cli, helper".into()),
                "{kind}"
            );
        }
        assert!(pending(&srv, &admin).is_empty());
        let r = srv.post("/api/auth/pair", json!({ "kind": "page" }), None);
        assert_eq!(
            (r.status, s(&r, "error")),
            (400, "a pair request needs a label".into())
        );
    }

    #[test]
    fn a_kind_is_kept_and_shown_and_a_missing_one_falls_back_to_the_label() {
        let (srv, admin) = kind_server();
        let a = s(
            &srv.post(
                "/api/auth/pair",
                json!({ "label": "cli looks", "kind": "page" }),
                None,
            ),
            "id",
        );
        let b = s(
            &srv.post("/api/auth/pair", json!({ "label": "helper old" }), None),
            "id",
        );
        let got: Vec<(String, String)> = pending(&srv, &admin)
            .into_iter()
            .map(|(_, l, k)| (l, k))
            .collect();
        assert_eq!(
            got,
            [
                ("cli looks".to_string(), "page".to_string()),
                ("helper old".to_string(), "helper".to_string())
            ]
        );
        for id in [a, b] {
            assert_eq!(
                srv.post("/api/auth/deny", json!({ "id": id }), Some(&admin))
                    .status,
                200
            );
        }
    }

    #[test]
    fn a_renewal_replaces_and_the_old_claim_says_so_a_bare_repeat_does_not() {
        let (srv, admin) = kind_server();
        let a = srv.post(
            "/api/auth/pair",
            json!({ "label": "renew", "kind": "page" }),
            None,
        );
        let bare = s(
            &srv.post(
                "/api/auth/pair",
                json!({ "label": "renew", "kind": "page" }),
                None,
            ),
            "id",
        );
        let ids = |srv: &Server| -> Vec<String> {
            pending(srv, &admin)
                .into_iter()
                .map(|(id, _, _)| id)
                .collect()
        };
        assert_eq!(ids(&srv), [s(&a, "id"), bare.clone()]);
        let b = s(
            &srv.post("/api/auth/pair", json!({ "label": "renew", "kind": "page", "id": s(&a, "id"), "secret": s(&a, "secret") }), None),
            "id",
        );
        assert_eq!(ids(&srv), [bare.clone(), b.clone()]);
        let old = srv.post(
            "/api/auth/claim",
            json!({ "id": s(&a, "id"), "secret": s(&a, "secret") }),
            None,
        );
        assert_eq!(old.status, 404);
        assert!(s(&old, "error").contains("replaced by a newer one"));
        for id in [bare, b] {
            assert_eq!(
                srv.post("/api/auth/deny", json!({ "id": id }), Some(&admin))
                    .status,
                200
            );
        }
        assert_eq!(
            srv.post("/api/auth/deny", json!({ "id": "nope" }), Some(&admin))
                .status,
            404
        );
    }

    #[test]
    fn the_7th_new_pair_in_a_minute_is_a_429_and_makes_no_pair() {
        let (srv, admin) = kind_server();
        let mut made = 0;
        let mut refused = None;
        for _ in 0..8 {
            let r = srv.post(
                "/api/auth/pair",
                json!({ "label": "loop", "kind": "page" }),
                None,
            );
            if r.status == 429 {
                refused = Some(r);
                break;
            }
            made += 1;
            srv.post("/api/auth/deny", json!({ "id": s(&r, "id") }), Some(&admin));
        }
        let refused = refused.expect("no 429");
        assert_eq!(made, 6);
        assert!(refused.body["error"].is_string());
        assert!(pending(&srv, &admin).is_empty());
    }

    #[test]
    fn a_body_that_is_not_an_object_is_an_empty_one() {
        let (srv, _) = kind_server();
        let req = Req::new("POST", "http://127.0.0.1:7850/api/auth/pair").unwrap();
        for body in [
            &b"not json"[..],
            b"[1,2]",
            b"",
            b"\xef\xbb\xbf{\"label\":\"bom\"}",
        ] {
            let r = srv.call(req.clone(), body);
            if body.starts_with(b"\xef\xbb\xbf") {
                assert_eq!(
                    r.status, 200,
                    "a leading BOM is dropped as a fetch body's text drops it"
                );
            } else {
                assert_eq!(r.status, 400);
            }
        }
    }
}

/// People as a fake: one invite, one member, a scoped viewer.
struct FakePeople {
    redeemed: Mutex<bool>,
}

impl AuthPeople for FakePeople {
    fn me(&self, caller: Option<&Caller>, mode: CallersMode) -> Option<Me> {
        match caller {
            None if mode == CallersMode::Enforce => None,
            _ => Some(Me {
                id: self.id_of(caller),
                name: "someone".into(),
                role: if caller.is_some_and(|c| c.user.is_some()) {
                    Role::Member
                } else {
                    Role::Owner
                },
            }),
        }
    }
    fn id_of(&self, caller: Option<&Caller>) -> String {
        caller
            .and_then(|c| c.user.clone())
            .unwrap_or_else(|| "owner".into())
    }
    fn hand_refusal(&self, _actor: Option<&Caller>, person: &str) -> Option<String> {
        (person == "p-ownerish").then(|| "you may not sign anyone in as an owner".to_string())
    }
    fn redeem(&self, code: &str) -> Option<Invited> {
        let mut used = self.redeemed.lock().unwrap();
        if code != "cnv_abcdefghijklmnopqrstuvwx" || *used {
            return None;
        }
        *used = true;
        Some(Invited {
            person: "p-averyave".into(),
            name: "Avery".into(),
        })
    }
    fn scope_of(&self, caller: Option<&Caller>) -> Option<Vec<String>> {
        caller
            .and_then(|c| c.user.as_deref())
            .filter(|u| *u == "p-scoped00")
            .map(|_| vec!["/repos/team".into()])
    }
}

fn people_server(mode: CallersMode) -> (Server, String) {
    let mut admin = String::new();
    let mut srv = Server::up(mode, |book| {
        admin = book.mint(K::Page, MintOpts::label("admin page")).token
    });
    srv.people = Some(Box::new(FakePeople {
        redeemed: Mutex::new(false),
    }));
    (srv, admin)
}

mod with_people {
    use super::*;

    #[test]
    fn join_trades_an_invite_for_a_session_and_withdraws_the_askers_pair() {
        let (srv, _) = people_server(CallersMode::Enforce);
        let p = srv.post("/api/auth/pair", json!({ "label": "phone" }), None);
        let r = srv.post(
            "/api/auth/join",
            json!({ "code": " CNV_ABCDEFGHIJKLMNOPQRSTUVWX ", "label": "phone", "id": s(&p, "id"), "secret": s(&p, "secret") }),
            None,
        );
        assert_eq!(r.status, 200);
        assert_eq!(s(&r, "person"), "Avery");
        let token = s(&r, "token");
        assert!(token.starts_with("cnp_page_"));
        let caller = srv.gate.book.check(Some(&token)).unwrap();
        assert_eq!(caller.user.as_deref(), Some("p-averyave"));
        assert!(srv.gate.book.pending().is_empty());
        // used once
        let again = srv.post(
            "/api/auth/join",
            json!({ "code": "cnv_abcdefghijklmnopqrstuvwx", "label": "x" }),
            None,
        );
        assert_eq!(again.status, 403);
    }

    #[test]
    fn join_checks_its_label_and_kind_and_counts_a_wrong_code() {
        let (srv, _) = people_server(CallersMode::Enforce);
        let r = srv.post(
            "/api/auth/join",
            json!({ "code": "cnv_abcdefghijklmnopqrstuvwx" }),
            None,
        );
        assert_eq!(
            (r.status, s(&r, "error")),
            (400, "a join needs a label".into())
        );
        let r = srv.post(
            "/api/auth/join",
            json!({ "code": "x", "label": "l", "kind": "helper" }),
            None,
        );
        assert_eq!(
            (r.status, s(&r, "error")),
            (400, "kind is page or cli".into())
        );
        let r = srv.post(
            "/api/auth/join",
            json!({ "code": "x", "label": "l", "kind": null }),
            None,
        );
        assert_eq!(r.status, 400);
        for _ in 0..10 {
            assert_eq!(
                srv.post(
                    "/api/auth/join",
                    json!({ "code": "wrong", "label": "l" }),
                    None
                )
                .status,
                403
            );
        }
        assert_eq!(
            srv.post(
                "/api/auth/join",
                json!({ "code": "wrong", "label": "l" }),
                None
            )
            .status,
            429
        );
        let cli = srv.post(
            "/api/auth/join",
            json!({ "code": "wrong", "label": "l", "kind": "cli" }),
            None,
        );
        assert_eq!(cli.status, 429);
    }

    #[test]
    fn join_on_a_backend_with_no_people_is_a_404() {
        let srv = Server::up(CallersMode::Enforce, |_| {});
        let r = srv.post("/api/auth/join", json!({ "code": "x", "label": "l" }), None);
        assert_eq!(
            (r.status, s(&r, "error")),
            (404, "this backend keeps no people".into())
        );
    }

    #[test]
    fn a_session_signs_itself_out_and_a_shell_may_not() {
        let mut shell = String::new();
        let mut page = String::new();
        let srv = Server::up(CallersMode::Enforce, |book| {
            shell = book.mint(K::Shell, MintOpts::label("s").term("t1")).token;
            page = book.mint(K::Page, MintOpts::label("p")).token;
        });
        let r = srv.post("/api/auth/signout", json!({}), None);
        assert_eq!(
            (r.status, s(&r, "error")),
            (401, "no session to sign out".into())
        );
        let r = srv.post("/api/auth/signout", json!({}), Some(&shell));
        assert_eq!(
            (r.status, s(&r, "error")),
            (
                403,
                "only a page, a CLI or a helper signs itself out".into()
            )
        );
        assert_eq!(
            srv.post("/api/auth/signout", json!({}), Some(&page)).status,
            200
        );
        assert!(srv.gate.book.check(Some(&page)).is_none());
    }

    #[test]
    fn approve_names_a_person_the_approver_may_sign_in() {
        let (srv, admin) = people_server(CallersMode::Enforce);
        let p = srv.post("/api/auth/pair", json!({ "label": "their laptop" }), None);
        let r = srv.post(
            "/api/auth/approve",
            json!({ "id": s(&p, "id"), "person": "p-ownerish" }),
            Some(&admin),
        );
        assert_eq!(
            (r.status, s(&r, "error")),
            (403, "you may not sign anyone in as an owner".into())
        );
        let r = srv.post(
            "/api/auth/approve",
            json!({ "id": s(&p, "id"), "person": "p-averyave" }),
            Some(&admin),
        );
        assert_eq!(r.status, 200);
        let claimed = srv.post(
            "/api/auth/claim",
            json!({ "id": s(&p, "id"), "secret": s(&p, "secret") }),
            None,
        );
        let token = s(&claimed, "token");
        assert_eq!(
            srv.gate.book.check(Some(&token)).unwrap().user.as_deref(),
            Some("p-averyave")
        );
        // with no person named, the device is the approver's own: the owner's
        let q = srv.post("/api/auth/pair", json!({ "label": "mine" }), None);
        srv.post(
            "/api/auth/approve",
            json!({ "id": s(&q, "id") }),
            Some(&admin),
        );
        let mine = s(
            &srv.post(
                "/api/auth/claim",
                json!({ "id": s(&q, "id"), "secret": s(&q, "secret") }),
                None,
            ),
            "token",
        );
        assert_eq!(srv.gate.book.check(Some(&mine)).unwrap().user, None);
    }

    #[test]
    fn auth_names_the_person_and_a_scoped_caller_never_reads_the_callers() {
        let (mut srv, admin) = people_server(CallersMode::Log);
        // a person's token holds their role's rights: a member is no admin
        srv.gate = srv.gate.with_role_of(Arc::new(|c| {
            Some(if c.user.is_none() {
                Role::Owner
            } else {
                Role::Member
            })
        }));
        let scoped = srv
            .gate
            .book
            .mint(K::Page, MintOpts::label("walled").user("p-scoped00"))
            .token;
        let none = srv.get("/api/auth", None).body;
        // outside enforce, no token is the owner and reads the whole answer
        assert_eq!(
            none["person"],
            json!({ "id": "owner", "name": "someone", "role": "owner" })
        );
        assert!(!none["callers"].as_array().unwrap().is_empty());
        let walled = srv.get("/api/auth", Some(&scoped)).body;
        assert_eq!(walled["scope"], json!(["/repos/team"]));
        assert_eq!(walled["callers"], json!([]));
        let whole = srv.get("/api/auth", Some(&admin)).body;
        assert_eq!(whole["scope"], Value::Null);
        assert!(!whole["callers"].as_array().unwrap().is_empty());
    }
}
