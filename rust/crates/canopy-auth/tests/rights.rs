//! Port of `src/core/callers.test.ts`: the route table, the rights each kind
//! holds, the lanes and who is a person.

use canopy_auth::{CallerKind as K, Need};
use canopy_auth::{CallerKind, PAIR_KINDS, Right, allows, is_person, kind_rights, lane, needs};

fn n(method: &str, path: &str) -> &'static str {
    needs(method, path).as_str()
}

fn may(kind: CallerKind, method: &str, path: &str) -> bool {
    allows(kind, needs(method, path))
}

const HANDS: [K; 4] = [K::Page, K::Cli, K::Shell, K::Ranger];
const OTHERS: [K; 4] = [K::None, K::Run, K::Coordinator, K::Helper];

mod needs_table {
    use super::*;

    #[test]
    fn a_get_needs_read_bar_the_two_upgrades_and_the_library() {
        for p in ["/api/runs", "/api/repos", "/api/events", "/api/capacity"] {
            assert_eq!(n("GET", p), "read", "{p}");
        }
        assert_eq!(n("GET", "/api/term"), "shell");
        assert_eq!(n("GET", "/api/helper"), "helper");
        assert_eq!(n("GET", "/library/open"), "admin");
    }

    #[test]
    fn the_capacity_routes() {
        assert_eq!(
            [
                n("POST", "/api/capacity/read"),
                n("POST", "/api/capacity/release"),
                n("POST", "/api/capacity")
            ],
            ["operate", "operate", "admin"]
        );
        assert!(may(K::Shell, "POST", "/api/capacity/release"));
        assert!(!may(K::Shell, "POST", "/api/capacity"));
    }

    #[test]
    fn the_push_routes() {
        assert_eq!(n("POST", "/api/push/subscribe"), "operate");
        assert_eq!(n("DELETE", "/api/push/subscribe"), "operate");
        assert_eq!(n("POST", "/api/push/test"), "admin");
        assert_eq!(n("GET", "/api/push"), "admin");
        assert_eq!(n("GET", "/api/push/key"), "read");
        assert!(may(K::Shell, "POST", "/api/push/subscribe"));
        assert!(!may(K::Shell, "POST", "/api/push/test"));
    }

    #[test]
    fn each_read_only_library_path_is_open() {
        for p in [
            "/api/library",
            "/api/library/sync",
            "/api/library/sync/status",
            "/library",
            "/library/",
            "/library/index.html",
            "/library/ports",
            "/library/ping",
            "/library/manifest",
            "/library/api/dev/state",
            "/library/api/ports/state",
            "/library/api/files",
        ] {
            assert_eq!(n("GET", p), "open", "{p}");
        }
    }

    #[test]
    fn a_library_get_off_the_allowlist_needs_admin() {
        for p in [
            "/library/x",
            "/library/opener",
            "/library/api/git",
            "/library/api/library",
            "/api/library/x",
        ] {
            assert_eq!(n("GET", p), "admin", "{p}");
        }
    }

    #[test]
    fn a_library_path_not_already_in_normal_form_needs_admin() {
        for p in [
            "/library/open;x",
            "/library//open",
            "/library/open%3Bx",
            "/library/open/",
            "/library/ports;x",
            "/library//ports",
            "/library/ports/",
            "/library/api%2Fdev%2Fstate",
            "/library/%70ing",
            "/library/ping%zz",
        ] {
            assert_eq!(n("GET", p), "admin", "{p}");
        }
    }

    #[test]
    fn a_trailing_slash_is_ignored() {
        assert_eq!(n("POST", "/api/runs/answer/"), "operate");
    }

    #[test]
    fn a_fork_operates() {
        assert_eq!(n("POST", "/api/runs/fork"), "operate");
    }

    #[test]
    fn a_side_question_and_its_model_operate() {
        for p in ["/api/runs/side", "/api/runs/model"] {
            assert_eq!(n("POST", p), "operate");
            for k in [K::Page, K::Cli, K::Shell] {
                assert!(may(k, "POST", p), "{k} {p}");
            }
            for k in [K::Run, K::Coordinator] {
                assert!(!may(k, "POST", p), "{k} {p}");
            }
        }
    }

    #[test]
    fn repos_actions_key_on_the_action() {
        for a in [
            "run",
            "pull",
            "commit",
            "dropstale",
            "flow",
            "refresh",
            "harness",
        ] {
            assert_eq!(n("POST", &format!("/api/repos/{a}")), "operate", "{a}");
        }
        for a in ["peer", "launch", "archive", "build", "launcher"] {
            assert_eq!(n("POST", &format!("/api/repos/{a}")), "admin", "{a}");
        }
        assert_eq!(n("POST", "/api/repos/agent"), "shell");
        assert_eq!(n("POST", "/api/repos/movein"), "shell");
        assert_eq!(n("POST", "/api/repos/movecheck"), "read");
        assert_eq!(n("POST", "/api/repos/tasks/def"), "operate");
        assert_eq!(n("DELETE", "/api/repos/health"), "operate");
    }

    #[test]
    fn maps_diagrams_diagnoses_and_graphs_are_a_hands() {
        for a in ["floorplan", "archify", "diagnosis", "understand"] {
            let p = format!("/api/repos/{a}");
            assert_eq!(n("POST", &p), "operate", "{p}");
            assert_eq!(n("GET", &p), "operate", "{p}");
        }
    }

    #[test]
    fn operate_rows() {
        for (m, p, want) in [
            ("POST", "/api/runs/answer", "operate"),
            ("DELETE", "/api/runs", "operate"),
            ("PATCH", "/api/workspaces", "operate"),
            ("POST", "/api/landing/anything", "operate"),
            ("POST", "/api/prs/merge", "operate"),
            ("DELETE", "/api/incubator", "operate"),
            ("POST", "/api/voice/session", "operate"),
            ("POST", "/api/voice/live", "operate"),
            ("POST", "/api/voice/dictate", "operate"),
            ("POST", "/api/voice/ended", "operate"),
            ("GET", "/api/costs", "read"),
            ("GET", "/api/voice", "read"),
            ("POST", "/api/ranger/wakes", "plan"),
            ("DELETE", "/api/ranger/wakes", "operate"),
            ("POST", "/api/runs/say", "plan"),
            ("POST", "/api/runs/interrupt", "operate"),
            ("POST", "/api/terms/say", "shell"),
            ("POST", "/api/terms/keys", "shell"),
            ("POST", "/api/runs/child", "plan"),
            ("POST", "/api/work/note", "plan"),
            ("POST", "/api/work/close", "operate"),
            ("POST", "/api/tailchan/send", "operate"),
            ("POST", "/api/presence/beat", "operate"),
            ("POST", "/api/layouts/reset", "operate"),
            ("POST", "/api/rescan", "operate"),
            ("POST", "/api/preview", "operate"),
        ] {
            assert_eq!(n(m, p), want, "{m} {p}");
        }
    }

    #[test]
    fn shell_rows() {
        assert_eq!(n("POST", "/api/terms/restore"), "shell");
        assert_eq!(n("POST", "/api/terms/move/finish"), "shell");
        assert_eq!(n("DELETE", "/api/terms"), "shell");
        assert_eq!(n("DELETE", "/api/terms/kept"), "shell");
    }

    #[test]
    fn a_moves_check_needs_a_token_and_a_hooks_rule_check_is_open() {
        assert_eq!(n("POST", "/api/repos/movecheck"), "read");
        assert_eq!(n("POST", "/api/remembered/check"), "open");
    }

    #[test]
    fn the_ticket_route_is_open_to_the_table() {
        assert_eq!(n("POST", "/api/auth/ticket"), "open");
    }

    #[test]
    fn admin_rows_and_the_default() {
        for (m, p, want) in [
            ("POST", "/api/agents/role", "admin"),
            ("POST", "/api/agents/profile", "admin"),
            ("POST", "/api/peers/sync", "admin"),
            ("POST", "/api/awake", "admin"),
            ("GET", "/api/awake", "read"),
            ("DELETE", "/api/sources", "admin"),
            ("POST", "/api/kit/install", "admin"),
            ("POST", "/api/kit/plugins", "admin"),
            ("GET", "/api/kit/plugins/catalog", "operate"),
            ("GET", "/api/kit/plugins/details", "operate"),
            ("GET", "/api/kit/plugins/commit", "operate"),
            ("POST", "/api/kit/plugins/commit", "admin"),
            ("POST", "/api/secrets/set", "admin"),
            ("POST", "/api/ranger/restart", "admin"),
            ("PUT", "/api/guards", "admin"),
            ("POST", "/api/auth/approve", "admin"),
            ("POST", "/api/made-up", "admin"),
            ("PUT", "/api/runs", "admin"),
            ("POST", "/library/refresh", "admin"),
            ("POST", "/api/library/refresh", "admin"),
            ("POST", "/api/library/sync", "admin"),
        ] {
            assert_eq!(n(m, p), want, "{m} {p}");
        }
    }

    #[test]
    fn pairing_routes_are_open() {
        for a in ["pair", "claim", "first"] {
            assert_eq!(n("POST", &format!("/api/auth/{a}")), "open");
        }
    }

    #[test]
    fn the_people_routes() {
        assert_eq!(n("GET", "/api/people"), "read");
        assert_eq!(n("GET", "/api/people/activity"), "read");
        for p in ["at", "me"] {
            assert_eq!(n("POST", &format!("/api/people/{p}")), "read", "{p}");
        }
        for p in [
            "add",
            "set",
            "remove",
            "invite",
            "uninvite",
            "team",
            "team/remove",
        ] {
            assert_eq!(n("POST", &format!("/api/people/{p}")), "admin", "{p}");
        }
        assert_eq!(n("POST", "/api/people/anything"), "admin");
    }

    #[test]
    fn an_invites_trade_and_a_sessions_own_sign_out_are_open() {
        assert_eq!(n("POST", "/api/auth/join"), "open");
        assert_eq!(n("POST", "/api/auth/signout"), "open");
    }

    #[test]
    fn a_triggers_hook_is_open() {
        assert_eq!(n("POST", "/api/hooks/sentry/shop"), "open");
        assert_eq!(n("GET", "/api/hooks/sentry/shop"), "read");
        assert_eq!(n("POST", "/api/hooksx"), "admin");
    }

    #[test]
    fn acting_on_a_triggers_events_operates() {
        for a in ["fire", "resume", "retry", "stop"] {
            assert_eq!(n("POST", &format!("/api/triggers/{a}")), "operate");
        }
        assert_eq!(n("DELETE", "/api/triggers/events"), "operate");
    }

    #[test]
    fn scenario_routes() {
        assert_eq!(n("GET", "/api/scenarios"), "admin");
        assert_eq!(n("GET", "/api/scenarios/names"), "read");
        assert_eq!(n("POST", "/api/scenarios"), "admin");
        assert_eq!(n("DELETE", "/api/scenarios"), "admin");
        assert_eq!(n("POST", "/api/scenarios/run"), "operate");
        assert!(!may(K::Shell, "GET", "/api/scenarios"));
        assert!(may(K::Shell, "GET", "/api/scenarios/names"));
        assert!(may(K::Shell, "POST", "/api/scenarios/run"));
        assert!(may(K::Cli, "GET", "/api/scenarios"));
    }

    #[test]
    fn sweep_routes_need_admin() {
        for m in ["GET", "POST"] {
            for p in [
                "/api/sweep",
                "/api/sweep/",
                "/api/sweep/settings",
                "/api/sweep/resume",
                "/api/sweep/ask",
            ] {
                assert_eq!(n(m, p), "admin", "{m} {p}");
            }
        }
        assert_eq!(n("DELETE", "/api/sweep/ask"), "admin");
        assert!(!may(K::Shell, "GET", "/api/sweep"));
        assert!(!may(K::Shell, "POST", "/api/sweep"));
        assert!(!may(K::Ranger, "POST", "/api/sweep"));
        assert!(may(K::Cli, "POST", "/api/sweep"));
        assert_eq!(n("GET", "/api/sweeping"), "read");
    }
}

mod coordinator_routes {
    use super::*;

    #[test]
    fn a_plan_needs_plan_and_editing_a_card_or_start_operate() {
        assert_eq!(n("POST", "/api/coordinator/plan"), "plan");
        assert_eq!(n("POST", "/api/coordinator/tasks"), "operate");
        assert_eq!(n("POST", "/api/coordinator/start"), "operate");
    }

    #[test]
    fn a_new_goal_needs_operate() {
        assert_eq!(n("POST", "/api/coordinator/new"), "operate");
        for k in [K::Page, K::Cli, K::Shell] {
            assert!(may(k, "POST", "/api/coordinator/new"), "{k}");
        }
        for k in [K::Coordinator, K::Run, K::None] {
            assert!(!may(k, "POST", "/api/coordinator/new"), "{k}");
        }
    }

    #[test]
    fn picking_a_stopped_flow_up_needs_operate() {
        assert_eq!(n("POST", "/api/flows/pickup"), "operate");
    }

    #[test]
    fn a_follow_up_operates_and_the_trees_are_in_the_coordinators_lane() {
        assert_eq!(n("POST", "/api/coordinator/followup"), "operate");
        assert!(may(K::Page, "POST", "/api/coordinator/followup"));
        let coord = lane(K::Coordinator).unwrap();
        assert!(coord.contains(&"GET /api/trees"));
        assert!(!coord.contains(&"POST /api/coordinator/followup"));
        assert!(may(K::Coordinator, "GET", "/api/trees"));
    }

    #[test]
    fn holding_a_goal_needs_operate() {
        assert_eq!(n("POST", "/api/coordinator/hold"), "operate");
        assert!(!may(K::Coordinator, "POST", "/api/coordinator/hold"));
        assert!(may(K::Page, "POST", "/api/coordinator/hold"));
    }

    #[test]
    fn a_coordinator_may_post_a_plan_and_read_and_nothing_that_starts_stops_or_answers() {
        assert!(may(K::Coordinator, "POST", "/api/coordinator/plan"));
        assert!(may(K::Coordinator, "GET", "/api/runs"));
        for (m, p) in [
            ("POST", "/api/coordinator/tasks"),
            ("POST", "/api/coordinator/start"),
            ("POST", "/api/coordinator/hold"),
            ("POST", "/api/coordinator/new"),
            ("POST", "/api/coordinator/followup"),
            ("POST", "/api/repos/run"),
            ("POST", "/api/runs/stop"),
            ("POST", "/api/runs/answer"),
            ("POST", "/api/runs/fork"),
            ("POST", "/api/runs/side"),
            ("POST", "/api/runs/model"),
            ("POST", "/api/asks/answer"),
            ("POST", "/api/landing/land"),
            ("POST", "/api/landing/fix"),
            ("POST", "/api/auth/approve"),
            ("POST", "/api/flows/pickup"),
            ("POST", "/api/landing/followup"),
        ] {
            assert!(!may(K::Coordinator, m, p), "{m} {p}");
        }
    }
}

#[test]
fn the_work_ledgers_routes() {
    assert_eq!(n("GET", "/api/work"), "read");
    assert_eq!(n("GET", "/api/work/one"), "read");
    assert_eq!(n("POST", "/api/work/note"), "plan");
    assert_eq!(n("POST", "/api/work/close"), "operate");
    assert!(may(K::Shell, "POST", "/api/work/note"));
    assert!(!may(K::Coordinator, "POST", "/api/work/close"));
}

#[test]
fn the_notes_routes() {
    assert_eq!(n("GET", "/api/notes"), "read");
    for p in ["/api/notes", "/api/notes/edit", "/api/notes/done"] {
        assert_eq!(n("POST", p), "operate", "{p}");
    }
    assert_eq!(n("DELETE", "/api/notes"), "operate");
    assert!(may(K::Cli, "POST", "/api/notes"));
    assert!(may(K::Shell, "DELETE", "/api/notes"));
    assert!(!may(K::Coordinator, "POST", "/api/notes"));
}

mod what_a_shell_shows {
    use super::*;

    #[test]
    fn its_screen_text_and_transcript_are_a_hands() {
        for p in [
            "/api/terms/screen",
            "/api/terms/text",
            "/api/terms/transcript",
        ] {
            assert_eq!(n("GET", p), "operate", "{p}");
            for k in HANDS {
                assert!(may(k, "GET", p), "{k} {p}");
            }
            for k in OTHERS {
                assert!(!may(k, "GET", p), "{k} {p}");
            }
        }
    }

    #[test]
    fn a_moves_plan_and_transcript_go_with_the_moves_writes() {
        for p in ["/api/terms/move/plan", "/api/terms/move/transcript"] {
            assert_eq!(n("GET", p), "shell", "{p}");
            assert!(may(K::Page, "GET", p));
            for k in [
                K::None,
                K::Cli,
                K::Shell,
                K::Ranger,
                K::Run,
                K::Coordinator,
                K::Helper,
            ] {
                assert!(!may(k, "GET", p), "{k} {p}");
            }
        }
    }

    #[test]
    fn the_list_of_shells_and_the_facts_about_one_are_plain_reads() {
        for p in ["/api/terms", "/api/terms/kept", "/api/terms/agent"] {
            assert_eq!(n("GET", p), "read", "{p}");
            assert!(!may(K::None, "GET", p), "{p}");
        }
    }

    #[test]
    fn whether_someone_is_at_a_shell_is_open() {
        assert_eq!(n("GET", "/api/terms/watched"), "open");
    }
}

mod what_is_in_a_repo {
    use super::*;

    fn closed(method: &str, p: &str) {
        assert_eq!(n(method, p), "operate", "{p}");
        for k in HANDS {
            assert!(may(k, method, p), "{k} {p}");
        }
        for k in OTHERS {
            assert!(!may(k, method, p), "{k} {p}");
        }
    }

    #[test]
    fn a_files_bytes_a_diff_the_log_and_a_search_are_a_hands() {
        for a in [
            "raw",
            "diff",
            "commit",
            "log",
            "ls",
            "dir",
            "grep",
            "search",
            "mentions",
            "session",
            "sessions",
            "tasks",
            "tasks/log",
        ] {
            closed("GET", &format!("/api/repos/{a}"));
        }
    }

    #[test]
    fn an_unwritten_repo_read_is_closed_and_a_trailing_slash_opens_nothing() {
        closed("GET", "/api/repos/whatever");
        closed("GET", "/api/repos/raw/");
    }

    #[test]
    fn a_search_across_repos_a_landings_diff_and_the_hosts_folders() {
        closed("POST", "/api/grep");
        closed("GET", "/api/landing/diff");
        closed("GET", "/api/browse");
    }

    #[test]
    fn a_run_read_by_its_id_and_its_export_and_replay() {
        for p in [
            "/api/runs/r-1a2b3c",
            "/api/runs/r-1a2b3c/export",
            "/api/runs/r-1a2b3c/replay",
        ] {
            closed("GET", p);
        }
    }

    #[test]
    fn the_tree_the_lists_and_the_event_stream_are_plain_reads() {
        for p in [
            "/api/tree",
            "/api/runs",
            "/api/flows",
            "/api/fleets",
            "/api/landing",
            "/api/events",
            "/api/workspaces",
            "/api/agents",
            "/api/jobs",
            "/api/tasks",
            "/api/health",
            "/api/notes",
            "/api/work",
            "/api/backends",
            "/api/registry",
            "/api/asks",
            "/api/push/key",
            "/api/a-read-nobody-wrote-yet",
        ] {
            assert_eq!(n("GET", p), "read", "{p}");
            assert!(!may(K::None, "GET", p), "{p}");
            assert!(!may(K::Helper, "GET", p), "{p}");
            for k in [K::Page, K::Cli, K::Shell, K::Ranger, K::Run, K::Coordinator] {
                assert!(may(k, "GET", p), "{k} {p}");
            }
        }
    }

    #[test]
    fn no_lane_names_one_of_them() {
        for k in [K::Run, K::Coordinator] {
            let inside: Vec<&&str> = lane(k)
                .unwrap()
                .iter()
                .filter(|r| {
                    r.starts_with("GET /api/repos/")
                        || r.starts_with("GET /api/runs/")
                        || **r == "POST /api/grep"
                        || **r == "GET /api/browse"
                        || **r == "GET /api/landing/diff"
                })
                .collect();
            assert!(inside.is_empty(), "{k}: {inside:?}");
        }
    }
}

mod a_caller_with_no_token {
    use super::*;

    fn bare(method: &str, p: &str) -> bool {
        may(K::None, method, p)
    }

    #[test]
    fn gets_the_pages_own_files() {
        for p in [
            "/",
            "/index.html",
            "/assets/index-abc123.js",
            "/sw.js",
            "/manifest.webmanifest",
            "/icons/icon-192.png",
            "/some/route/the/page/owns",
        ] {
            assert_eq!(n("GET", p), "open", "{p}");
        }
        assert_eq!(n("POST", "/"), "admin");
        assert_eq!(n("DELETE", "/index.html"), "admin");
    }

    #[test]
    fn gets_what_signing_in_needs() {
        assert!(bare("GET", "/api/auth"));
        for p in ["/api/auth/pair", "/api/auth/claim", "/api/auth/first"] {
            assert!(bare("POST", p), "{p}");
        }
        for p in ["/api/auth/approve", "/api/auth/deny", "/api/auth/revoke"] {
            assert!(!bare("POST", p), "{p}");
        }
    }

    #[test]
    fn gets_the_answers_a_script_asks_for_and_linears_navigation() {
        for p in [
            "/api/about",
            "/api/going",
            "/api/terms/watched",
            "/api/linear/install",
            "/api/linear/callback",
        ] {
            assert_eq!(n("GET", p), "open", "{p}");
        }
        assert_eq!(n("POST", "/api/remembered/check"), "open");
        assert_eq!(n("POST", "/api/hooks/sentry"), "open");
    }

    #[test]
    fn gets_nothing_else() {
        for p in [
            "/api/tree",
            "/api/runs",
            "/api/runs?kept=1",
            "/api/flows",
            "/api/fleets",
            "/api/landing",
            "/api/events",
            "/api/notes",
            "/api/work",
            "/api/tasks",
            "/api/jobs",
            "/api/terms",
            "/api/terms/kept",
            "/api/terms/agent",
            "/api/workspaces",
            "/api/agents",
            "/api/backends",
            "/api/peers",
            "/api/registry",
            "/api/asks",
            "/api/ranger",
            "/api/health",
            "/api/history",
            "/api/costs",
            "/api/client",
            "/api/devices",
            "/api/helpers",
            "/api/hosts",
            "/api/ports",
            "/api/launchers",
            "/api/remembered",
            "/api/capacity",
            "/api/kit",
            "/api/kit/preview",
            "/api/secrets",
            "/api/secrets/audit",
            "/api/prs",
            "/api/groups",
            "/api/incubator",
            "/api/incubator/one",
            "/api/layouts",
            "/api/presence",
            "/api/guards",
            "/api/push/key",
            "/api/push",
            "/api/scenarios/names",
            "/api/voice",
            "/api/verdict",
            "/api/tailchan",
            "/api/tailchan/read",
            "/api/tailchan/blob",
            "/api/about/more",
            "/api/going/more",
            "/api/authx",
            "/api/a-read-nobody-wrote-yet",
        ] {
            let path = p.split('?').next().unwrap();
            assert!(!bare("GET", path), "{p}");
        }
        assert!(!bare("POST", "/api/repos/movecheck"));
        assert!(!bare("POST", "/api/a-write-nobody-wrote-yet"));
    }

    #[test]
    fn a_helpers_token_reads_nothing_either() {
        for p in ["/api/tree", "/api/runs", "/api/events", "/api/notes"] {
            assert!(!may(K::Helper, "GET", p), "{p}");
        }
    }
}

#[test]
fn what_was_said_on_tailchan_is_a_hands() {
    for p in ["/api/tailchan", "/api/tailchan/read", "/api/tailchan/blob"] {
        assert_eq!(n("GET", p), "operate", "{p}");
        for k in HANDS {
            assert!(may(k, "GET", p), "{k} {p}");
        }
        for k in OTHERS {
            assert!(!may(k, "GET", p), "{k} {p}");
        }
    }
}

#[test]
fn the_clipboards_routes_operate() {
    assert_eq!(n("GET", "/api/clips"), "operate");
    assert_eq!(n("GET", "/api/clips/c-aaaaaaaa"), "operate");
    for p in [
        "/api/clips",
        "/api/clips/use",
        "/api/clips/pin",
        "/api/clips/clear",
    ] {
        assert_eq!(n("POST", p), "operate", "{p}");
    }
    assert_eq!(n("DELETE", "/api/clips"), "operate");
    assert!(may(K::Page, "GET", "/api/clips"));
    assert!(may(K::Shell, "POST", "/api/clips"));
    assert!(!may(K::None, "GET", "/api/clips"));
    assert!(!may(K::Run, "GET", "/api/clips"));
    assert!(!may(K::Coordinator, "POST", "/api/clips"));
}

mod allows_by_kind {
    use super::*;

    #[test]
    fn each_kind_holds_what_the_table_gives_it() {
        for (k, r, want) in [
            (K::Page, Right::Shell, true),
            (K::Page, Right::Admin, true),
            (K::Cli, Right::Shell, false),
            (K::Cli, Right::Admin, true),
            (K::Shell, Right::Admin, false),
            (K::Shell, Right::Operate, true),
            (K::Ranger, Right::Operate, true),
            (K::Coordinator, Right::Plan, true),
            (K::Coordinator, Right::Operate, false),
            (K::None, Right::Read, false),
            (K::None, Right::Operate, false),
            (K::Helper, Right::Helper, true),
            (K::Helper, Right::Read, false),
        ] {
            assert_eq!(allows(k, r), want, "{k} {r}");
        }
    }

    #[test]
    fn plan_is_the_coordinators_and_comes_with_operate() {
        for k in [K::Coordinator, K::Page, K::Cli, K::Shell, K::Ranger] {
            assert!(allows(k, Right::Plan), "{k}");
        }
        for k in [K::None, K::Helper] {
            assert!(!allows(k, Right::Plan), "{k}");
        }
    }

    #[test]
    fn open_is_allowed_to_every_kind() {
        assert!(allows(K::None, Need::Open));
    }
}

#[test]
fn group_mutations_operate_and_the_group_list_reads() {
    assert_eq!(n("GET", "/api/groups"), "read");
    for a in ["pick", "review", "drop"] {
        assert_eq!(n("POST", &format!("/api/groups/{a}")), "operate");
    }
}

#[test]
fn worktree_routes() {
    assert_eq!(n("GET", "/api/worktrees"), "read");
    assert_eq!(n("POST", "/api/worktrees/warm"), "admin");
    assert_eq!(n("POST", "/api/worktrees/prune"), "operate");
    assert!(!may(K::Shell, "POST", "/api/worktrees/warm"));
    assert!(may(K::Shell, "POST", "/api/worktrees/prune"));
    assert_eq!(n("GET", "/api/trees"), "read");
    assert_eq!(n("POST", "/api/trees/add"), "operate");
    assert_eq!(n("POST", "/api/trees/remove"), "operate");
    assert!(may(K::Shell, "POST", "/api/trees/add"));
    assert!(may(K::Cli, "POST", "/api/worktrees/warm"));
}

#[test]
fn kept_runs_the_list_reads_one_takes_a_token_pruning_is_admin() {
    assert_eq!(n("GET", "/api/runs"), "read");
    for p in [
        "/api/runs/ab12cd34",
        "/api/runs/ab12cd34/export",
        "/api/runs/ab12cd34/replay",
    ] {
        assert_eq!(n("GET", p), "operate", "{p}");
    }
    assert_eq!(n("POST", "/api/runs/prune"), "admin");
    assert!(!may(K::Shell, "POST", "/api/runs/prune"));
    assert!(may(K::Cli, "POST", "/api/runs/prune"));
}

mod a_runs_token {
    use super::*;

    #[test]
    fn holds_read_and_plan_never_operate_and_no_pair_asks_for_it() {
        assert_eq!(kind_rights(K::Run), &[Right::Read, Right::Plan]);
        for r in [Right::Operate, Right::Shell, Right::Admin, Right::Helper] {
            assert!(!allows(K::Run, r), "{r}");
        }
        assert!(PAIR_KINDS.iter().all(|k| CallerKind::from(*k) != K::Run));
    }

    #[test]
    fn reaches_nothing_that_lands_pushes_answers_stops_or_configures() {
        for (m, p) in [
            ("POST", "/api/landing/land"),
            ("POST", "/api/prs/open"),
            ("POST", "/api/runs/answer"),
            ("POST", "/api/runs/stop"),
            ("POST", "/api/repos/push"),
            ("POST", "/api/repos/run"),
            ("POST", "/api/agents/profile"),
        ] {
            assert!(!may(K::Run, m, p), "{p}");
        }
    }
}

mod who_is_a_person {
    use super::*;

    #[test]
    fn a_page_and_the_cli_are() {
        let people: Vec<K> = K::ALL.into_iter().filter(|k| is_person(Some(*k))).collect();
        assert_eq!(people, [K::Page, K::Cli]);
    }

    #[test]
    fn no_caller_at_all_counts_as_one() {
        assert!(is_person(None));
    }
}
