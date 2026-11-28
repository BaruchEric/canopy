//! Port of the CallerBook half of `src/server/callers.test.ts`: mint and
//! check, a bad disk, persistence, expiry, drops, tickets, pairing, the first
//! code and the loopback caller.

mod common;

use std::collections::HashSet;
use std::fs;
use std::sync::{Arc, Mutex};

use canopy_auth::{CallerBook, CallerKind as K, Claim, MintOpts, PairKind, Renew, Ticketed};
use common::{DAY, MIN, Scratch};
use serde_json::Value;

fn token_of(c: Option<Claim>) -> String {
    match c {
        Some(Claim::Token(t)) => t,
        other => panic!("not a token: {other:?}"),
    }
}

mod mint_and_check {
    use super::*;

    #[test]
    fn a_minted_token_checks_to_its_caller_anything_else_is_none() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Shell, MintOpts::label("sh").term("t1"));
        assert!(m.token.starts_with("cnp_shell_"));
        // 32 random bytes as base64url with no padding, and a 6-byte id
        assert_eq!(m.token.len(), "cnp_shell_".len() + 43);
        assert_eq!(m.caller.id.len(), 8);
        assert_eq!(book.check(Some(&m.token)).unwrap().kind, K::Shell);
        assert_eq!(book.check(Some(&m.token)).unwrap().id, m.caller.id);
        assert!(book.check(Some("cnp_shell_x")).is_none());
        assert!(book.check(None).is_none());
        assert!(book.check(Some("")).is_none());
    }

    #[test]
    fn revoke_ends_a_token() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Cli, MintOpts::label("cli a"));
        assert!(book.revoke(&m.caller.id).unwrap());
        assert!(!book.revoke(&m.caller.id).unwrap());
        assert!(book.check(Some(&m.token)).is_none());
    }
}

mod a_bad_disk {
    use super::*;

    #[test]
    fn a_failed_write_fails_the_revoke_and_bites_in_memory() {
        let s = Scratch::new();
        // the parent of the file is a regular file, so every write fails
        let blocker = s.dir.path().join("blocker");
        fs::write(&blocker, "x").unwrap();
        let book = CallerBook::open_with_clock(blocker.join("callers.json"), s.t.clock());
        let m = book.mint(K::Cli, MintOpts::label("cli a"));
        assert!(book.revoke(&m.caller.id).is_err());
        assert!(book.check(Some(&m.token)).is_none());
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_with_its_content_and_the_book_starts_empty() {
        let s = Scratch::new();
        fs::write(&s.file, "{corrupt").unwrap();
        let book = s.open();
        assert!(book.list().is_empty());
        let aside: Vec<String> = fs::read_dir(s.dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("callers.json.corrupt-"))
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            fs::read_to_string(s.dir.path().join(&aside[0])).unwrap(),
            "{corrupt"
        );
        assert!(!s.file.exists());
    }

    #[test]
    fn json_that_is_not_an_array_is_moved_aside_too_and_a_missing_file_is_just_empty() {
        let s = Scratch::new();
        fs::write(&s.file, r#"{"a":1}"#).unwrap();
        s.open();
        let moved = fs::read_dir(s.dir.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("callers.json.corrupt-")
        });
        assert!(moved);
        let fresh = Scratch::new();
        assert!(fresh.open().list().is_empty());
        // nothing was moved aside for a file that was never there
        assert_eq!(fs::read_dir(fresh.dir.path()).unwrap().count(), 0);
    }
}

mod persistence {
    use super::*;

    #[test]
    fn the_file_holds_no_token_a_second_book_reads_it_mode_0600() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Page, MintOpts::label("laptop"));
        let text = fs::read_to_string(&s.file).unwrap();
        assert!(!text.contains(&m.token));
        assert!(text.contains(&canopy_auth::token_hash(&m.token)));
        assert!(text.ends_with("}\n]\n"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(&s.file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(s.open().check(Some(&m.token)).unwrap().kind, K::Page);
        // no temp file is left behind
        let names: Vec<String> = fs::read_dir(s.dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["callers.json"]);
    }

    #[test]
    fn a_bump_of_used_is_written_after_a_minute() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Page, MintOpts::label("laptop"));
        s.t.add(2 * MIN);
        book.check(Some(&m.token));
        assert_eq!(s.open().list()[0].used, s.t.now());
    }

    #[test]
    fn a_bump_inside_the_minute_waits() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Page, MintOpts::label("laptop"));
        let minted = s.t.now();
        s.t.add(30 * 1000);
        book.check(Some(&m.token));
        assert_eq!(s.open().list()[0].used, minted);
        book.flush().unwrap();
        assert_eq!(s.open().list()[0].used, s.t.now());
    }
}

mod expiry {
    use super::*;

    #[test]
    fn a_page_session_unused_for_30_days_is_over_a_shell_token_is_not() {
        let s = Scratch::new();
        let book = s.open();
        let page = book.mint(K::Page, MintOpts::label("p"));
        let shell = book.mint(K::Shell, MintOpts::label("s").term("t1"));
        s.t.add(30 * DAY);
        assert!(book.check(Some(&page.token)).is_some());
        s.t.add(30 * DAY + 1);
        assert!(book.check(Some(&page.token)).is_none());
        assert_eq!(book.check(Some(&shell.token)).unwrap().kind, K::Shell);
    }

    #[test]
    fn use_pushes_the_expiry_out() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Cli, MintOpts::label("cli a"));
        s.t.add(20 * DAY);
        assert!(book.check(Some(&m.token)).is_some());
        s.t.add(20 * DAY);
        assert!(book.check(Some(&m.token)).is_some());
    }

    #[test]
    fn an_expired_session_is_dropped_and_told() {
        let s = Scratch::new();
        let book = s.open();
        let told = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = told.clone();
        book.set_on_drop(Arc::new(move |ids| {
            sink.lock().unwrap().extend(ids.iter().cloned())
        }));
        let m = book.mint(K::Page, MintOpts::label("p"));
        s.t.add(30 * DAY + 1);
        assert!(book.check(Some(&m.token)).is_none());
        assert_eq!(*told.lock().unwrap(), std::slice::from_ref(&m.caller.id));
        assert!(s.open().list().is_empty());
    }
}

mod drops {
    use super::*;

    #[test]
    fn drop_term_and_drop_run_kill_the_tokens_tied_to_them() {
        let s = Scratch::new();
        let book = s.open();
        let a = book.mint(K::Shell, MintOpts::label("a").term("t1"));
        let b = book.mint(K::Shell, MintOpts::label("b").term("t2"));
        let c = book.mint(K::Ranger, MintOpts::label("c").run("r1"));
        book.drop_term("t1").unwrap();
        book.drop_run("r1").unwrap();
        assert!(book.check(Some(&a.token)).is_none());
        assert!(book.check(Some(&c.token)).is_none());
        assert!(book.check(Some(&b.token)).is_some());
    }

    #[test]
    fn a_coordinators_token_carries_its_run_and_drop_run_revokes_it() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(
            K::Coordinator,
            MintOpts::label("coordinator web").run("co1"),
        );
        assert_eq!(m.caller.kind, K::Coordinator);
        assert_eq!(m.caller.run.as_deref(), Some("co1"));
        assert_eq!(
            book.check(Some(&m.token)).unwrap().run.as_deref(),
            Some("co1")
        );
        book.drop_run("co1").unwrap();
        assert!(book.check(Some(&m.token)).is_none());
    }

    #[test]
    fn drop_kind_drops_every_caller_of_that_kind_on_disk_too() {
        let s = Scratch::new();
        let book = s.open();
        let a = book.mint(
            K::Coordinator,
            MintOpts::label("coordinator web").run("co1"),
        );
        let b = book.mint(
            K::Coordinator,
            MintOpts::label("coordinator api").run("co2"),
        );
        let c = book.mint(K::Ranger, MintOpts::label("ranger").term("t1"));
        let dropped = Arc::new(Mutex::new(Vec::<String>::new()));
        let again = s.open();
        let sink = dropped.clone();
        again.set_on_drop(Arc::new(move |ids| {
            sink.lock().unwrap().extend(ids.iter().cloned())
        }));
        again.drop_kind(K::Coordinator).unwrap();
        assert_eq!(
            *dropped.lock().unwrap(),
            [a.caller.id.clone(), b.caller.id.clone()]
        );
        assert!(again.check(Some(&a.token)).is_none());
        assert!(again.check(Some(&b.token)).is_none());
        assert!(again.check(Some(&c.token)).is_some());
        assert!(s.open().check(Some(&a.token)).is_none());
    }

    #[test]
    fn prune_drops_shell_callers_whose_term_is_gone() {
        let s = Scratch::new();
        let book = s.open();
        let a = book.mint(K::Shell, MintOpts::label("a").term("t1"));
        let b = book.mint(K::Shell, MintOpts::label("b").term("t2"));
        let bare = book.mint(K::Shell, MintOpts::label("no term"));
        let ranger = book.mint(K::Ranger, MintOpts::label("r").term("t9"));
        book.prune(&HashSet::from(["t2".to_string()])).unwrap();
        assert!(book.check(Some(&a.token)).is_none());
        assert!(book.check(Some(&bare.token)).is_none());
        assert!(book.check(Some(&b.token)).is_some());
        assert!(book.check(Some(&ranger.token)).is_some());
    }

    #[test]
    fn drop_user_drops_a_persons_tokens_and_the_owners_are_those_with_none() {
        let s = Scratch::new();
        let book = s.open();
        let mine = book.mint(K::Page, MintOpts::label("owner page"));
        let theirs = book.mint(
            K::Shell,
            MintOpts::label("their shell").term("t1").user("p-averyave"),
        );
        assert_eq!(book.user_of_term("t1").as_deref(), Some("p-averyave"));
        book.drop_user("p-averyave").unwrap();
        assert!(book.check(Some(&theirs.token)).is_none());
        assert!(book.check(Some(&mine.token)).is_some());
        book.drop_user("owner").unwrap();
        assert!(book.check(Some(&mine.token)).is_none());
    }

    #[test]
    fn the_owners_user_is_never_written() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Page, MintOpts::label("p").user("owner"));
        assert_eq!(m.caller.user, None);
        assert!(!fs::read_to_string(&s.file).unwrap().contains("\"user\""));
        assert_eq!(book.by_id(&m.caller.id).unwrap().label, "p");
        assert!(book.by_id("nope").is_none());
    }
}

mod tickets {
    use super::*;

    #[test]
    fn redeem_works_once() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Page, MintOpts::label("p"));
        let ticket = book.ticket(&m.caller.id, Ticketed::Shell).unwrap();
        assert_eq!(ticket.len(), 43);
        assert_eq!(
            book.redeem(&ticket, Ticketed::Shell).unwrap().id,
            m.caller.id
        );
        assert!(book.redeem(&ticket, Ticketed::Shell).is_none());
    }

    #[test]
    fn redeem_fails_after_60_s_for_the_other_right_and_after_a_revoke() {
        let s = Scratch::new();
        let book = s.open();
        let m = book.mint(K::Page, MintOpts::label("p"));
        let late = book.ticket(&m.caller.id, Ticketed::Shell).unwrap();
        s.t.add(60 * 1000 + 1);
        assert!(book.redeem(&late, Ticketed::Shell).is_none());
        let wrong = book.ticket(&m.caller.id, Ticketed::Shell).unwrap();
        assert!(book.redeem(&wrong, Ticketed::Helper).is_none());
        // spent by the wrong try
        assert!(book.redeem(&wrong, Ticketed::Shell).is_none());
        let gone = book.ticket(&m.caller.id, Ticketed::Helper).unwrap();
        book.revoke(&m.caller.id).unwrap();
        assert!(book.redeem(&gone, Ticketed::Helper).is_none());
    }

    #[test]
    fn a_ticket_for_no_caller_fails() {
        let s = Scratch::new();
        assert!(s.open().ticket("nope", Ticketed::Shell).is_err());
    }
}

mod pairing {
    use super::*;

    #[test]
    fn a_fourth_pair_while_three_wait_is_an_error() {
        let s = Scratch::new();
        let book = s.open();
        for i in 0..3 {
            assert!(book.pair(&format!("p{i}"), "1.2.3.4", None, None).is_ok());
        }
        assert!(book.pair("p3", "1.2.3.4", None, None).is_err());
    }

    #[test]
    fn a_pair_is_gone_after_10_min() {
        let s = Scratch::new();
        let book = s.open();
        let p = book.pair("p", "1.2.3.4", None, None).unwrap();
        assert_eq!(book.pending().len(), 1);
        s.t.add(10 * MIN + 1);
        assert!(book.pending().is_empty());
        assert!(!book.approve(&p.id, None));
        assert!(book.claim(&p.id, &p.secret).is_none());
    }

    #[test]
    fn codes_are_6_characters_from_the_alphabet() {
        let s = Scratch::new();
        let p = s.open().pair("p", "a", None, None).unwrap();
        assert_eq!(p.code.len(), 6);
        assert!(
            p.code
                .bytes()
                .all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&b)),
            "{}",
            p.code
        );
        assert_eq!(p.id.len(), 8);
        assert_eq!(p.secret.len(), 43);
    }

    #[test]
    fn claim_wrong_secret_none_waiting_then_a_token_once() {
        let s = Scratch::new();
        let book = s.open();
        let p = book.pair("laptop", "1.2.3.4", None, None).unwrap();
        assert!(book.claim(&p.id, "wrong").is_none());
        assert_eq!(book.claim(&p.id, &p.secret), Some(Claim::Waiting));
        assert!(book.approve(&p.id, None));
        let token = token_of(book.claim(&p.id, &p.secret));
        assert_eq!(book.check(Some(&token)).unwrap().kind, K::Page);
        assert!(book.claim(&p.id, &p.secret).is_none());
    }

    #[test]
    fn wrong_secret_is_a_wrong_guess_at_a_live_pair_only() {
        let s = Scratch::new();
        let book = s.open();
        let p = book.pair("laptop", "1.2.3.4", None, None).unwrap();
        assert!(book.wrong_secret(&p.id, "wrong"));
        assert!(!book.wrong_secret(&p.id, &p.secret));
        assert!(!book.wrong_secret("nope", "wrong"));
        assert!(book.deny(&p.id));
        // denied but not yet told: still a live pair to guess at
        assert!(book.wrong_secret(&p.id, "wrong"));
        assert!(book.claim(&p.id, &p.secret).is_none());
        // told, and gone
        assert!(!book.wrong_secret(&p.id, "wrong"));
    }

    #[test]
    fn the_label_prefix_picks_the_kind() {
        let s = Scratch::new();
        let book = s.open();
        let mut kinds = Vec::new();
        for label in ["cli mac", "helper mini", "laptop"] {
            let p = book.pair(label, "a", None, None).unwrap();
            book.approve(&p.id, None);
            let token = token_of(book.claim(&p.id, &p.secret));
            kinds.push(book.check(Some(&token)).unwrap().kind);
        }
        assert_eq!(kinds, [K::Cli, K::Helper, K::Page]);
    }

    #[test]
    fn the_asked_kind_is_minted_whatever_the_label_says() {
        let s = Scratch::new();
        let book = s.open();
        let mut kinds = Vec::new();
        for (label, kind) in [
            ("cli mac", PairKind::Page),
            ("laptop", PairKind::Cli),
            ("page x", PairKind::Helper),
        ] {
            let p = book.pair(label, "a", Some(kind), None).unwrap();
            assert_eq!(
                book.pending().iter().find(|x| x.id == p.id).unwrap().kind,
                kind
            );
            book.approve(&p.id, None);
            let token = token_of(book.claim(&p.id, &p.secret));
            kinds.push(book.check(Some(&token)).unwrap().kind);
        }
        assert_eq!(kinds, [K::Page, K::Cli, K::Helper]);
    }

    #[test]
    fn a_renewal_with_the_waiting_pairs_own_id_and_secret_replaces_it() {
        let s = Scratch::new();
        let book = s.open();
        let a = book
            .pair("laptop", "1.2.3.4", Some(PairKind::Page), None)
            .unwrap();
        let renew = Renew {
            id: a.id.clone(),
            secret: a.secret.clone(),
        };
        let b = book
            .pair("laptop", "1.2.3.4", Some(PairKind::Page), Some(&renew))
            .unwrap();
        let ids: Vec<String> = book.pending().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, std::slice::from_ref(&b.id));
        assert!(book.claim(&a.id, &a.secret).is_none());
        assert!(book.replaced(&a.id, &a.secret));
        assert!(!book.replaced(&a.id, "wrong"));
        assert!(!book.replaced(&b.id, &b.secret));
        assert_eq!(book.claim(&b.id, &b.secret), Some(Claim::Waiting));
    }

    #[test]
    fn the_same_label_and_address_without_the_secret_does_not_replace() {
        let s = Scratch::new();
        let book = s.open();
        let a = book
            .pair("laptop", "1.2.3.4", Some(PairKind::Page), None)
            .unwrap();
        let b = book
            .pair("laptop", "1.2.3.4", Some(PairKind::Page), None)
            .unwrap();
        let ids: Vec<String> = book.pending().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, [a.id.clone(), b.id]);
        assert_eq!(book.claim(&a.id, &a.secret), Some(Claim::Waiting));
    }

    #[test]
    fn a_renewal_with_a_wrong_secret_makes_a_new_pair_and_replaces_nothing() {
        let s = Scratch::new();
        let book = s.open();
        let a = book
            .pair("laptop", "1.2.3.4", Some(PairKind::Page), None)
            .unwrap();
        let renew = Renew {
            id: a.id.clone(),
            secret: "wrong".into(),
        };
        assert!(
            book.pair("laptop", "1.2.3.4", Some(PairKind::Page), Some(&renew))
                .is_ok()
        );
        assert_eq!(book.pending().len(), 2);
        assert_eq!(book.claim(&a.id, &a.secret), Some(Claim::Waiting));
    }

    #[test]
    fn a_renewal_leaves_room_under_the_waiting_cap() {
        let s = Scratch::new();
        let book = s.open();
        let first = book.pair("p0", "a", Some(PairKind::Page), None).unwrap();
        for i in 1..3 {
            assert!(
                book.pair(&format!("p{i}"), "a", Some(PairKind::Page), None)
                    .is_ok()
            );
        }
        assert!(book.pair("p3", "a", Some(PairKind::Page), None).is_err());
        let renew = Renew {
            id: first.id,
            secret: first.secret,
        };
        assert!(
            book.pair("p0", "a", Some(PairKind::Page), Some(&renew))
                .is_ok()
        );
        assert_eq!(book.pending().len(), 3);
    }

    #[test]
    fn the_7th_new_pair_inside_a_minute_is_refused_and_one_is_allowed_after_it() {
        let s = Scratch::new();
        let book = s.open();
        for _ in 0..6 {
            s.t.add(1000);
            let p = book.pair("loop", "a", Some(PairKind::Page), None).unwrap();
            // denying frees the slot, so only the rate cap is in the way
            book.deny(&p.id);
        }
        s.t.add(1000);
        assert!(book.pair("loop", "a", Some(PairKind::Page), None).is_err());
        assert!(book.pending().is_empty());
        s.t.add(MIN);
        assert!(book.pair("loop", "a", Some(PairKind::Page), None).is_ok());
    }

    #[test]
    fn both_refusals_say_how_to_free_the_slots() {
        let s = Scratch::new();
        let book = s.open();
        for i in 0..3 {
            let _ = book.pair(&format!("p{i}"), "a", Some(PairKind::Page), None);
        }
        let full = book
            .pair("p3", "a", Some(PairKind::Page), None)
            .unwrap_err();
        assert!(full.contains("deny"), "{full}");
        let burst = Scratch::new();
        let burst = burst.open();
        for _ in 0..6 {
            if let Ok(p) = burst.pair("x", "a", Some(PairKind::Page), None) {
                burst.deny(&p.id);
            }
        }
        let limited = burst
            .pair("x", "a", Some(PairKind::Page), None)
            .unwrap_err();
        assert!(limited.contains("deny"), "{limited}");
    }

    #[test]
    fn deny_makes_claim_none() {
        let s = Scratch::new();
        let book = s.open();
        let p = book.pair("p", "a", None, None).unwrap();
        assert!(book.deny(&p.id));
        assert!(book.claim(&p.id, &p.secret).is_none());
    }

    #[test]
    fn a_label_is_cut_at_80_utf16_units() {
        let s = Scratch::new();
        let book = s.open();
        book.pair(&"x".repeat(100), "a", None, None).unwrap();
        book.pair(&format!("{}\u{1F332}", "y".repeat(79)), "a", None, None)
            .unwrap();
        let labels: Vec<String> = book.pending().into_iter().map(|p| p.label).collect();
        assert_eq!(labels, ["x".repeat(80), "y".repeat(79)]);
    }

    #[test]
    fn withdraw_takes_back_only_a_waiting_pair_with_its_secret() {
        let s = Scratch::new();
        let book = s.open();
        let p = book.pair("p", "a", None, None).unwrap();
        assert!(!book.withdraw(&p.id, "wrong"));
        assert!(book.withdraw(&p.id, &p.secret));
        assert!(!book.withdraw(&p.id, &p.secret));
        assert!(book.pending().is_empty());
    }

    #[test]
    fn an_approval_for_a_person_mints_their_token() {
        let s = Scratch::new();
        let book = s.open();
        let p = book.pair("their laptop", "a", None, None).unwrap();
        assert!(book.approve(&p.id, Some("p-averyave")));
        let token = token_of(book.claim(&p.id, &p.secret));
        assert_eq!(
            book.check(Some(&token)).unwrap().user.as_deref(),
            Some("p-averyave")
        );
    }
}

mod first_code {
    use super::*;

    #[test]
    fn an_empty_book_has_one_and_using_it_approves_the_pair() {
        let s = Scratch::new();
        let book = s.open();
        let code = book.first_code(None).unwrap();
        let p = book.pair("laptop", "a", None, None).unwrap();
        assert!(!book.use_first("WRONG1", &p.id, None));
        assert!(book.use_first(&code, &p.id, None));
        token_of(book.claim(&p.id, &p.secret));
        assert!(book.first_code(None).is_none());
    }

    #[test]
    fn the_code_is_burned_by_use() {
        let s = Scratch::new();
        let book = s.open();
        let code = book.first_code(None).unwrap();
        let a = book.pair("a", "x", None, None).unwrap();
        let b = book.pair("b", "x", None, None).unwrap();
        assert!(book.use_first(&code, &a.id, None));
        assert!(!book.use_first(&code, &b.id, None));
    }

    #[test]
    fn a_session_that_could_not_let_the_owner_in_does_not_hold_the_code_back() {
        let s = Scratch::new();
        let book = s.open();
        let member = book
            .mint(
                K::Page,
                MintOpts::label("a member's phone").user("p-averyave"),
            )
            .caller;
        let owners = |c: &canopy_auth::Caller| c.user.is_none();
        // every session counts unless the caller says which do
        assert!(book.first_code(None).is_none());
        let code = book.first_code(Some(&owners)).unwrap();
        let p = book.pair("the owner's laptop", "a", None, None).unwrap();
        // without the rule the code is not one, since a session is live
        assert!(!book.use_first(&code, &p.id, None));
        assert!(book.use_first(&code, &p.id, Some(&owners)));
        let token = token_of(book.claim(&p.id, &p.secret));
        // the code made the owner: a token with no person on it
        let owner = book.check(Some(&token)).unwrap();
        assert_eq!(owner.user, None);
        assert_ne!(owner.id, member.id);
        assert!(book.first_code(Some(&owners)).is_none());
    }

    #[test]
    fn a_book_that_holds_a_page_session_from_disk_has_none() {
        let s = Scratch::new();
        s.open().mint(K::Page, MintOpts::label("p"));
        assert!(s.open().first_code(None).is_none());
    }

    #[test]
    fn an_expired_session_does_not_count() {
        let s = Scratch::new();
        let book = s.open();
        book.mint(K::Page, MintOpts::label("p"));
        book.mint(K::Cli, MintOpts::label("cli a"));
        s.t.add(30 * DAY + 1);
        assert!(s.open().first_code(None).is_some());
        assert!(book.first_code(None).is_some());
    }

    #[test]
    fn the_code_stays_the_same_until_used() {
        let s = Scratch::new();
        let book = s.open();
        let code = book.first_code(None).unwrap();
        assert_eq!(book.first_code(None).unwrap(), code);
        // a session hides it without forgetting it
        let m = book.mint(K::Page, MintOpts::label("p"));
        assert!(book.first_code(None).is_none());
        book.revoke(&m.caller.id).unwrap();
        assert_eq!(book.first_code(None).unwrap(), code);
    }
}

mod the_loopback_caller {
    use super::*;

    #[test]
    fn is_a_page_caller_ticketable_and_matches_no_token() {
        let s = Scratch::new();
        let book = s.open();
        let c = book.local_caller();
        assert_eq!(c.kind, K::Page);
        assert_eq!(c.id, "loopback");
        assert_eq!(book.local_caller().id, c.id);
        let tk = book.ticket(&c.id, Ticketed::Shell).unwrap();
        assert_eq!(book.redeem(&tk, Ticketed::Shell).unwrap().id, c.id);
        assert!(book.check(Some("anything")).is_none());
        assert!(book.check(Some("loopback:no-token")).is_none());
    }

    #[test]
    fn does_not_suppress_the_first_sign_in_code() {
        let s = Scratch::new();
        let book = s.open();
        book.local_caller();
        assert!(book.first_code(None).is_some());
    }

    #[test]
    fn is_never_written_to_callers_json() {
        let s = Scratch::new();
        let book = s.open();
        book.local_caller();
        book.mint(K::Cli, MintOpts::label("cli x"));
        let on_disk: Vec<Value> =
            serde_json::from_str(&fs::read_to_string(&s.file).unwrap()).unwrap();
        assert!(!on_disk.iter().any(|c| c["id"] == "loopback"));
        assert!(on_disk.iter().any(|c| c["label"] == "cli x"));
        // the list a page reads still names it
        assert!(book.list().iter().any(|c| c.id == "loopback"));
    }
}
