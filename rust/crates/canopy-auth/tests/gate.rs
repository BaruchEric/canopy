//! Port of the gate half of `src/server/callers.test.ts`: the first code
//! through the gate, a coordinator at the gate, the coordinator's and a
//! run's lanes, CANOPY_COORD_PORT, CANOPY_LOOPBACK_AUTH and the loopback
//! bypass; plus roles at the gate (FR-074).

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use canopy_auth::{
    Bypass, CallerGate, CallerKind as K, CallersMode, LaneVerdict, MintOpts, Req, Role, coord_port,
    coordinator_refusal, lane, lane_allows, lane_verdict, loopback_auth_wanted, loopback_bypass,
};
use common::Scratch;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |k| map.get(k).cloned()
}

type Lines = Arc<Mutex<Vec<String>>>;

fn gate_with_lines(s: &Scratch, mode: CallersMode) -> (CallerGate, Lines) {
    let lines: Lines = Arc::default();
    let sink = lines.clone();
    let gate = CallerGate::new(
        s.open(),
        mode,
        Arc::new(move |l| sink.lock().unwrap().push(l.to_string())),
    )
    .with_clock(s.t.clock());
    (gate, lines)
}

fn req(method: &str, path: &str) -> Req {
    Req::new(method, &format!("http://x{path}")).unwrap()
}

#[test]
fn the_gate_offers_the_code_while_no_owner_is_signed_in_and_withholds_it_once_one_is() {
    let s = Scratch::new();
    let (gate, lines) = gate_with_lines(&s, CallersMode::Enforce);
    let gate = gate.with_role_of(Arc::new(|c| {
        Some(if c.user.is_none() {
            Role::Owner
        } else {
            Role::Member
        })
    }));
    gate.book.mint(
        K::Cli,
        MintOpts::label("a member's laptop").user("p-averyave"),
    );
    gate.announce();
    let first = lines.lock().unwrap()[0].clone();
    let code = first
        .strip_prefix("canopy: first sign-in code ")
        .and_then(|r| r.strip_suffix(" (good until a page or the CLI signs in)"))
        .unwrap()
        .to_string();
    assert_eq!(code.len(), 6);
    assert!(
        code.bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'9').contains(&b))
    );
    let p = gate
        .book
        .pair("the owner's laptop", "a", None, None)
        .unwrap();
    assert!(!gate.use_first("WRONG1", &p.id));
    assert!(gate.use_first(&code, &p.id));
    assert!(matches!(
        gate.book.claim(&p.id, &p.secret),
        Some(canopy_auth::Claim::Token(_))
    ));
    // the owner is in: no second code, for anyone
    let again = gate.book.pair("someone else", "b", None, None).unwrap();
    gate.announce();
    assert_eq!(lines.lock().unwrap().len(), 1);
    assert!(!gate.use_first(&code, &again.id));
}

#[test]
fn announce_prints_a_code_once() {
    let s = Scratch::new();
    let (gate, lines) = gate_with_lines(&s, CallersMode::Enforce);
    gate.announce();
    gate.announce();
    assert_eq!(lines.lock().unwrap().len(), 1);
}

mod a_coordinator_at_the_gate {
    use super::*;

    #[test]
    fn its_token_posts_a_plan_and_reads_and_is_refused_on_every_route_that_starts_stops_or_answers()
    {
        let s = Scratch::new();
        let (gate, _) = gate_with_lines(&s, CallersMode::Enforce);
        let m = gate.book.mint(
            K::Coordinator,
            MintOpts::label("coordinator web").run("co1"),
        );
        let caller = gate.book.check(Some(&m.token));
        let at = |m: &str, p: &str| gate.gate(&req(m, p), caller.as_ref()).map(|r| r.status);
        assert_eq!(at("POST", "/api/coordinator/plan"), None);
        assert_eq!(at("GET", "/api/tree"), None);
        for (m, p) in [
            ("POST", "/api/coordinator/tasks"),
            ("POST", "/api/coordinator/start"),
            ("POST", "/api/coordinator/new"),
            ("POST", "/api/repos/run"),
            ("POST", "/api/runs/stop"),
            ("POST", "/api/runs/answer"),
            ("POST", "/api/asks/answer"),
            ("POST", "/api/landing/land"),
            ("POST", "/api/auth/approve"),
            ("POST", "/api/flows/pickup"),
            ("POST", "/api/landing/followup"),
        ] {
            assert_eq!(at(m, p), Some(403), "{m} {p}");
        }
        // the table's plan routes are a run's; the lane keeps the coordinator off them
        for p in [
            "/api/runs/say",
            "/api/runs/child",
            "/api/ranger/wakes",
            "/api/work/note",
        ] {
            assert_eq!(
                lane_verdict(false, K::Coordinator, "POST", p),
                Some(LaneVerdict::Route),
                "{p}"
            );
        }
    }

    #[test]
    fn a_page_may_post_a_plan_too_and_a_bare_caller_may_not() {
        let s = Scratch::new();
        let (gate, _) = gate_with_lines(&s, CallersMode::Enforce);
        let m = gate.book.mint(K::Page, MintOpts::label("a page"));
        let page = gate.book.check(Some(&m.token));
        let post = |c: Option<&canopy_auth::Caller>| {
            gate.gate(&req("POST", "/api/coordinator/plan"), c)
                .map(|r| r.status)
        };
        assert_eq!(post(page.as_ref()), None);
        assert_eq!(post(None), Some(401));
    }
}

mod the_coordinators_lane {
    use super::*;

    #[test]
    fn coord_port_unset_or_not_a_port_is_no_listener() {
        let got = coord_port(&env(&[("CANOPY_COORD_PORT", " 7859 ")]));
        assert_eq!((got.port, got.error), (Some(7859), None));
        let unset = coord_port(&env(&[]));
        assert_eq!(unset.port, None);
        assert!(
            unset
                .error
                .as_deref()
                .unwrap()
                .contains("CANOPY_COORD_PORT is not set")
        );
        for bad in ["0", "65536", "78a9", "-1", "7859.5", "123456"] {
            let got = coord_port(&env(&[("CANOPY_COORD_PORT", bad)]));
            assert_eq!(got.port, None, "{bad}");
            assert!(
                got.error
                    .unwrap()
                    .contains(&format!("CANOPY_COORD_PORT={bad}")),
                "{bad}"
            );
        }
        assert_eq!(coordinator_refusal(CallersMode::Enforce, None), None);
        assert_eq!(
            coordinator_refusal(CallersMode::Enforce, unset.error.as_deref()),
            unset.error
        );
        for mode in [CallersMode::Log, CallersMode::Off] {
            assert!(
                coordinator_refusal(mode, None)
                    .unwrap()
                    .contains("CANOPY_CALLERS=enforce")
            );
        }
    }

    #[test]
    fn lets_through_the_reads_the_brief_names_and_the_plan_by_exact_path_head_as_get() {
        for (m, p) in [
            ("GET", "/api/about"),
            ("GET", "/api/tree"),
            ("GET", "/api/runs"),
            ("HEAD", "/api/runs"),
            ("GET", "/api/landing"),
            ("POST", "/api/coordinator/plan"),
        ] {
            assert!(lane_allows(K::Coordinator, m, p), "{m} {p}");
        }
        for (m, p) in [
            ("GET", "/api/repos/diff"),
            ("GET", "/api/runs/"),
            ("GET", "/api/landing/x"),
            ("POST", "/api/landing"),
            ("GET", "/api/flows"),
            ("GET", "/api/prs"),
            ("GET", "/api/events"),
            ("GET", "/api/auth"),
            ("GET", "/api/term"),
            ("GET", "/library"),
            ("GET", "/"),
            ("GET", "/api/coordinator/plan"),
            ("POST", "/api/coordinator/start"),
            ("POST", "/api/coordinator/tasks"),
            ("POST", "/api/coordinator/new"),
            ("POST", "/api/repos/run"),
        ] {
            assert!(!lane_allows(K::Coordinator, m, p), "{m} {p}");
        }
    }

    #[test]
    fn on_its_listener_only_a_coordinators_token_is_taken() {
        use LaneVerdict::{Route, Token};
        assert_eq!(lane_verdict(true, K::Coordinator, "GET", "/api/runs"), None);
        assert_eq!(
            lane_verdict(true, K::None, "GET", "/api/about"),
            Some(Token)
        );
        assert_eq!(lane_verdict(true, K::Page, "GET", "/api/runs"), Some(Token));
        assert_eq!(lane_verdict(true, K::Cli, "GET", "/api/runs"), Some(Token));
        assert_eq!(
            lane_verdict(true, K::Coordinator, "GET", "/api/repos/diff"),
            Some(Route)
        );
        assert_eq!(
            lane_verdict(false, K::Coordinator, "GET", "/api/repos/diff"),
            Some(Route)
        );
        assert_eq!(
            lane_verdict(false, K::Coordinator, "POST", "/api/coordinator/plan"),
            None
        );
        assert_eq!(lane_verdict(false, K::None, "GET", "/api/repos/diff"), None);
        assert_eq!(lane_verdict(false, K::Page, "GET", "/api/repos/diff"), None);
    }

    #[test]
    fn lanes_pin_both_kinds_and_a_runs_token_keeps_to_its_own() {
        let mut coord = lane(K::Coordinator).unwrap().to_vec();
        coord.sort();
        assert_eq!(
            coord,
            [
                "GET /api/about",
                "GET /api/coordinator/workflows",
                "GET /api/landing",
                "GET /api/loadouts",
                "GET /api/runs",
                "GET /api/tree",
                "GET /api/trees",
                "POST /api/coordinator/plan"
            ]
        );
        let mut run = lane(K::Run).unwrap().to_vec();
        run.sort();
        assert_eq!(
            run,
            [
                "GET /api/auth",
                "GET /api/health",
                "GET /api/landing",
                "GET /api/runs",
                "GET /api/tree",
                "POST /api/ranger/wakes",
                "POST /api/runs/child",
                "POST /api/runs/say",
                "POST /api/work/note"
            ]
        );
        for line in lane(K::Run).unwrap() {
            let (m, p) = line.split_once(' ').unwrap();
            assert_eq!(lane_verdict(false, K::Run, m, p), None, "{line}");
        }
        assert_eq!(lane_verdict(false, K::Run, "HEAD", "/api/runs"), None);
        for (m, p) in [
            ("POST", "/api/landing/land"),
            ("POST", "/api/prs/open"),
            ("POST", "/api/runs/stop"),
            ("POST", "/api/runs/answer"),
            ("POST", "/api/runs/fork"),
            ("POST", "/api/runs/side"),
            ("POST", "/api/runs/model"),
            ("POST", "/api/repos/run"),
            ("POST", "/api/repos/push"),
            ("POST", "/api/coordinator/plan"),
            ("POST", "/api/work/close"),
            ("POST", "/api/auth/approve"),
            ("DELETE", "/api/ranger/wakes"),
            ("DELETE", "/api/runs"),
            ("GET", "/api/runs/child"),
            ("GET", "/api/runs/"),
            ("GET", "/api/repos/diff"),
            ("GET", "/api/events"),
            ("GET", "/api/term"),
            ("GET", "/library"),
            ("GET", "/"),
        ] {
            assert_eq!(
                lane_verdict(false, K::Run, m, p),
                Some(LaneVerdict::Route),
                "{m} {p}"
            );
        }
    }

    #[test]
    fn the_coordinators_listener_takes_no_run_token() {
        for (m, p) in [
            ("GET", "/api/runs"),
            ("POST", "/api/runs/child"),
            ("POST", "/api/landing/land"),
        ] {
            assert_eq!(
                lane_verdict(true, K::Run, m, p),
                Some(LaneVerdict::Token),
                "{m} {p}"
            );
        }
    }

    #[test]
    fn a_runs_refusal_says_what_a_runs_token_is_for_and_is_logged_once() {
        let s = Scratch::new();
        let (gate, lines) = gate_with_lines(&s, CallersMode::Off);
        let m = gate.book.mint(K::Run, MintOpts::label("run app").run("r1"));
        let caller = gate.book.check(Some(&m.token));
        let r = req("POST", "/api/landing/land");
        let first = gate.lane(&r, caller.as_ref(), "1.2.3.4", false).unwrap();
        assert_eq!(first.status, 403);
        assert!(
            first.body["error"]
                .as_str()
                .unwrap()
                .starts_with("a run's token reads the board")
        );
        assert_eq!(
            gate.lane(&r, caller.as_ref(), "1.2.3.4", false)
                .unwrap()
                .status,
            403
        );
        let said = lines
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.contains("run lane refused run POST /api/landing/land"))
            .count();
        assert_eq!(said, 1);
    }

    #[test]
    fn the_lane_refuses_in_every_mode_counts_and_says_each_route_once() {
        let s = Scratch::new();
        let told = Arc::new(Mutex::new(0u64));
        let sink = told.clone();
        let (gate, lines) = gate_with_lines(&s, CallersMode::Off);
        let gate = gate.with_on_refused(Arc::new(move |_| *sink.lock().unwrap() += 1));
        let ask = |p: &str, on_lane: bool| gate.lane(&req("GET", p), None, "192.168.48.1", on_lane);
        let res = ask("/api/repos/diff", true).unwrap();
        assert_eq!(res.status, 403);
        assert_eq!(
            res.body["error"],
            "a call on the coordinator's listener needs a coordinator's token"
        );
        ask("/api/repos/diff", true);
        ask("/api/about", true);
        let refused = gate.refused();
        assert_eq!(refused.count, 3);
        assert_eq!(refused.recent[0].kind, K::None);
        assert_eq!(refused.recent[0].route, "GET /api/about");
        assert_eq!(*told.lock().unwrap(), 3);
        let lines = lines.lock().unwrap();
        assert_eq!(
            lines
                .iter()
                .filter(|l| l.contains("GET /api/repos/diff"))
                .count(),
            1
        );
        assert_eq!(
            lines
                .iter()
                .filter(|l| l.contains("GET /api/about"))
                .count(),
            1
        );
        assert!(lines[0].ends_with(" from 192.168.48.1"));
        drop(lines);
        assert!(ask("/api/repos/diff", false).is_none());
    }
}

#[test]
fn loopback_auth_wanted_is_off_unless_clearly_on() {
    assert!(!loopback_auth_wanted(&env(&[])));
    for v in ["", "0", "off"] {
        assert!(
            !loopback_auth_wanted(&env(&[("CANOPY_LOOPBACK_AUTH", v)])),
            "{v:?}"
        );
    }
    for v in ["1", "on", "true", "yes", "YES", " On "] {
        assert!(
            loopback_auth_wanted(&env(&[("CANOPY_LOOPBACK_AUTH", v)])),
            "{v:?}"
        );
    }
}

#[test]
fn callers_mode_is_log_unless_it_says_off_or_enforce() {
    use canopy_auth::callers_mode;
    assert_eq!(callers_mode(&env(&[])), CallersMode::Log);
    assert_eq!(
        callers_mode(&env(&[("CANOPY_CALLERS", " enforce ")])),
        CallersMode::Enforce
    );
    assert_eq!(
        callers_mode(&env(&[("CANOPY_CALLERS", "off")])),
        CallersMode::Off
    );
    assert_eq!(
        callers_mode(&env(&[("CANOPY_CALLERS", "Enforce")])),
        CallersMode::Log
    );
}

mod loopback {
    use super::*;

    fn ok() -> Bypass<'static> {
        Bypass {
            wanted: true,
            beyond_loopback: false,
            on_lane: false,
            upgrade: false,
            sec_fetch_site: Some("same-origin"),
            addr: "127.0.0.1",
            hostname: "localhost",
        }
    }

    #[test]
    fn passes_only_when_every_part_holds() {
        assert!(loopback_bypass(&ok()));
        assert!(!loopback_bypass(&Bypass {
            wanted: false,
            ..ok()
        }));
        assert!(!loopback_bypass(&Bypass {
            beyond_loopback: true,
            ..ok()
        }));
        assert!(!loopback_bypass(&Bypass {
            on_lane: true,
            ..ok()
        }));
        // a socket upgrade is left out: a socket authenticates with a one-use ticket
        assert!(!loopback_bypass(&Bypass {
            upgrade: true,
            ..ok()
        }));
        // a peer that is not loopback, for example the preview on a tailnet-bound server
        assert!(!loopback_bypass(&Bypass {
            addr: "100.68.139.95",
            ..ok()
        }));
        // a Host that is not loopback is DNS rebinding
        assert!(!loopback_bypass(&Bypass {
            hostname: "evil.example",
            ..ok()
        }));
        assert!(!loopback_bypass(&Bypass {
            sec_fetch_site: Some("cross-site"),
            ..ok()
        }));
        assert!(!loopback_bypass(&Bypass {
            sec_fetch_site: Some("same-site"),
            ..ok()
        }));
    }

    #[test]
    fn same_origin_none_and_an_absent_sec_fetch_site_pass() {
        for site in [Some("same-origin"), Some("none"), None] {
            assert!(
                loopback_bypass(&Bypass {
                    sec_fetch_site: site,
                    ..ok()
                }),
                "{site:?}"
            );
        }
    }

    #[test]
    fn ipv6_loopback_and_127_x_both_count() {
        assert!(loopback_bypass(&Bypass {
            addr: "::1",
            hostname: "[::1]",
            ..ok()
        }));
        assert!(loopback_bypass(&Bypass {
            addr: "127.0.0.5",
            hostname: "127.0.0.9",
            ..ok()
        }));
    }
}

mod roles_at_the_gate {
    use super::*;

    #[test]
    fn a_member_short_of_admin_is_told_it_is_their_role() {
        let s = Scratch::new();
        let (gate, _) = gate_with_lines(&s, CallersMode::Enforce);
        let gate = gate.with_role_of(Arc::new(|c| {
            Some(if c.user.is_none() {
                Role::Owner
            } else {
                Role::Member
            })
        }));
        let member = gate
            .book
            .mint(K::Page, MintOpts::label("their page").user("p-averyave"))
            .caller;
        let r = gate
            .gate(&req("POST", "/api/agents/role"), Some(&member))
            .unwrap();
        assert_eq!(r.status, 403);
        assert_eq!(r.body["need"], "admin");
        assert_eq!(
            r.body["error"],
            "this call needs the admin right; your role on this backend does not hold it"
        );
        // a member operates, so a run start passes
        assert!(
            gate.gate(&req("POST", "/api/repos/run"), Some(&member))
                .is_none()
        );
        assert_eq!(gate.rights(Some(&member)).len(), 4);
    }

    #[test]
    fn a_caller_whose_person_is_gone_is_nobody() {
        let s = Scratch::new();
        let (gate, _) = gate_with_lines(&s, CallersMode::Enforce);
        let gate = gate.with_role_of(Arc::new(|c| {
            if c.user.is_none() {
                Some(Role::Owner)
            } else {
                None
            }
        }));
        let gone = gate
            .book
            .mint(K::Page, MintOpts::label("their page").user("p-gonegone"))
            .caller;
        let r = gate.gate(&req("GET", "/api/tree"), Some(&gone)).unwrap();
        assert_eq!(r.status, 401);
        assert_eq!(
            r.body["error"],
            "this call needs the read right; run canopy auth login, or open a new shell"
        );
        assert!(gate.rights(Some(&gone)).is_empty());
        assert_eq!(gate.refused().recent[0].kind, K::None);
    }

    #[test]
    fn people_writes_are_checked_in_every_mode_and_at_or_me_follow_the_mode() {
        let s = Scratch::new();
        let (gate, _) = gate_with_lines(&s, CallersMode::Off);
        assert_eq!(
            gate.gate(&req("POST", "/api/people/add"), None)
                .unwrap()
                .status,
            401
        );
        assert_eq!(
            gate.gate(&req("POST", "/api/auth/approve"), None)
                .unwrap()
                .status,
            401
        );
        assert!(gate.gate(&req("POST", "/api/people/at"), None).is_none());
        assert!(gate.gate(&req("POST", "/api/people/me"), None).is_none());
        assert!(gate.gate(&req("POST", "/api/repos/run"), None).is_none());
    }

    #[test]
    fn a_head_is_judged_as_a_get_and_recorded_as_a_head() {
        let s = Scratch::new();
        let (gate, _) = gate_with_lines(&s, CallersMode::Enforce);
        let r = req("HEAD", "/api/tree")
            .with_header("Origin", "http://o")
            .with_header("User-Agent", "ua/1");
        assert_eq!(gate.gate(&r, None).unwrap().body["need"], "read");
        let refused = gate.refused();
        assert_eq!(refused.recent[0].route, "HEAD /api/tree");
        assert_eq!(refused.recent[0].origin, "http://o");
        assert_eq!(refused.recent[0].ua, "ua/1");
        assert_eq!(refused.recent[0].at, s.t.now());
    }

    #[test]
    fn the_recent_list_keeps_the_newest_20() {
        let s = Scratch::new();
        let (gate, _) = gate_with_lines(&s, CallersMode::Enforce);
        for i in 0..25 {
            gate.gate(&req("GET", &format!("/api/r{i}")), None);
        }
        let refused = gate.refused();
        assert_eq!(refused.count, 25);
        assert_eq!(refused.recent.len(), 20);
        assert_eq!(refused.recent[0].route, "GET /api/r24");
    }
}
