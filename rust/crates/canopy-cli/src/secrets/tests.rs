//! secrets.test.ts, case by case, with a fake backend standing in for the
//! home one and the backends it lists.

use super::*;
use crate::ask::AskError;
use crate::ask::tests::Fake;
use canopy_core::secretwire::PENDING;
use std::sync::Mutex;

const STAMP: &str = "2026-10-14T12:00:00.000Z";
const PLAIN: Paint = Paint { color: false };

fn info(over: Value) -> Value {
    let mut v = json!({
        "ok": true, "error": null, "backend": "mac", "role": "reader", "head": "abc1234", "refused": null,
        "lock": "locked",
        "secrets": [{"name": "cf_token", "description": "dns edits", "tags": ["dns"], "created": STAMP, "rotated": STAMP,
                     "to": ["breakglass", "mini"], "allow": ["sink:dns"], "usedBy": ["dns"]}],
        "sinks": [{"id": "dns", "machine": "mac", "path": "/Users/e/x/.env", "format": "dotenv",
                   "keys": {"CF_TOKEN": "cf_token"}, "state": {"CF_TOKEN": "drift"}, "error": null}],
        "proposals": [], "passkeys": [], "session": false, "firstPasskey": false, "recipient": null,
        "gate": "https://canopy.beric.ca/?view=secrets", "unpushed": 0
    });
    for (k, x) in over.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

// describe("lines")

#[test]
fn the_list_names_dates_tags_and_users_and_no_value() {
    let text = list_lines(&info(json!({})), PLAIN).join("\n");
    for want in ["cf_token", "2026-10-14", "#dns", "dns edits"] {
        assert!(text.contains(want), "{want}");
    }
    assert!(!text.contains("12:00"), "the date only");
}

#[test]
fn the_status_names_the_lock_the_commit_drift_and_a_refusal() {
    let text = status_lines(
        &info(json!({"refused": "the newest commit (def5678) is not signed by the pinned mini key; abc1234 stays"})),
        PLAIN,
    )
    .join("\n");
    for want in [
        "abc1234",
        "canopy secrets unlock",
        "CF_TOKEN drift",
        "not signed",
    ] {
        assert!(text.contains(want), "{want}");
    }
}

#[test]
fn an_open_key_names_its_recipient_so_it_can_be_set_as_a_machine_key_later() {
    let text = status_lines(
        &info(json!({"lock": "open", "recipient": "age1example"})),
        PLAIN,
    )
    .join("\n");
    assert!(text.contains("this machine's key is open, recipient age1example"));
}

#[test]
fn status_exits_1_on_a_refusal_a_sink_error_or_drift_0_otherwise() {
    assert!(status_exit(&info(json!({}))));
    assert!(!status_exit(&info(json!({"sinks": []}))));
    assert!(status_exit(&info(json!({"sinks": [], "refused": "x"}))));
    assert!(status_exit(&info(json!({"ok": false, "sinks": []}))));
}

// describe("propose")

const BUNDLE: &str = "/Users/e/.claude/credentials/.credentials.json";
const NOTES: &str = "/Users/e/dev/.env";
// a sealed value's text stands in for the value: no printed line may hold it
const SEALED: &str = "-----BEGIN AGE ENCRYPTED FILE-----\nsealed-fixture-0x5eed\n";

fn item(source: &str, key: &str, partial: bool) -> Value {
    let mut v =
        json!({"from": "mac", "source": source, "key": key, "sealed": SEALED, "merges": null});
    if partial {
        v["partial"] = json!(true);
    }
    v
}

fn items() -> Vec<Value> {
    vec![
        item(BUNDLE, "providers.canopy.env.CANOPY_VOICE_KEY", false),
        item(BUNDLE, "providers.canopy.env.CANOPY_LIVE_KEY", false),
        item(BUNDLE, "providers.cloudflare.api_token", false),
        item(NOTES, "OPENAI_API_KEY", true),
    ]
}

fn args(over: impl FnOnce(&mut ProposeArgs)) -> ProposeArgs {
    let mut a = ProposeArgs::default();
    over(&mut a);
    a
}

fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn the_flags_one_or_more_texts_or_all_never_both_and_never_neither() {
    assert_eq!(
        parse_propose(&words(&[
            "--match",
            "voice",
            "--match",
            "LIVE",
            "--dry-run"
        ])),
        Ok(args(|a| {
            a.matches = words(&["voice", "LIVE"]);
            a.dry = true;
        }))
    );
    assert_eq!(
        parse_propose(&words(&["--all", "--to", "mini"])),
        Ok(args(|a| {
            a.all = true;
            a.to = Some("mini".into());
        }))
    );
    assert_eq!(
        parse_propose(&words(&["--all", "--offset", "500"])),
        Ok(args(|a| {
            a.all = true;
            a.offset = 500;
        }))
    );
    for bad in [
        &["--all", "--offset"][..],
        &["--all", "--offset", "-1"],
        &["--all", "--offset", "1.5"],
        &["--all", "--offset", "x"],
    ] {
        assert_eq!(
            parse_propose(&words(bad)),
            Err("--offset needs a whole number, 0 or more".into())
        );
    }
    assert!(parse_propose(&[]).unwrap_err().contains("--match TEXT"));
    assert!(
        parse_propose(&words(&["--all", "--match", "x"]))
            .unwrap_err()
            .contains("--match TEXT")
    );
    assert_eq!(
        parse_propose(&words(&["--match"])),
        Err("--match needs a text".into())
    );
    assert_eq!(
        parse_propose(&words(&["--match", "--all"])),
        Err("--match needs a text".into())
    );
    assert_eq!(
        parse_propose(&words(&["--all", "--to"])),
        Err("--to needs a backend's name".into())
    );
    assert_eq!(
        parse_propose(&words(&["--all", "extra"])),
        Err("not understood: extra".into())
    );
}

#[test]
fn a_text_picks_by_key_or_by_file_in_any_case_all_picks_every_value() {
    let keys_of = |v: Vec<Value>| -> Vec<String> { v.iter().map(|p| field(p, "key")).collect() };
    let pick = |m: &[&str]| pick_proposals(&items(), &args(|a| a.matches = words(m)));
    assert_eq!(
        keys_of(pick(&["canopy_voice"])),
        ["providers.canopy.env.CANOPY_VOICE_KEY"]
    );
    assert_eq!(pick(&["voice", "live"]).len(), 2);
    assert_eq!(keys_of(pick(&["DEV/.ENV"])), ["OPENAI_API_KEY"]);
    assert!(pick(&["nothing-here"]).is_empty());
    assert_eq!(pick_proposals(&items(), &args(|a| a.all = true)).len(), 4);
}

/// What a propose world saw: the requests, the batches posted, the scans.
#[derive(Default)]
struct Seen {
    asked: Vec<String>,
    posted: Vec<Vec<Value>>,
    scans: Vec<Value>,
}

#[derive(Default, Clone)]
struct World {
    scan: Option<Vec<Value>>,
    role: Option<&'static str>,
    writer_away: bool,
    in_step: Option<i64>,
    left: i64,
}

const HOME: &str = "http://127.0.0.1:7850";

/// A home backend that reads, a registry of two others, and whatever the
/// writer was posted.
fn world(w: World, seen: &Mutex<Seen>) -> impl Ask + '_ {
    Fake(
        move |t: &Target, method: &str, path: &str, body: Option<&Value>| {
            let mut s = seen.lock().unwrap();
            s.asked.push(format!("{} {method} {path}", t.name));
            if t.name == "home" {
                return match path {
                    "/api/secrets" => Ok(info(json!({"role": w.role.unwrap_or("reader")}))),
                    "/api/secrets/scan" => {
                        s.scans.push(body.cloned().unwrap_or(Value::Null));
                        Ok(json!({
                            "items": w.scan.clone().unwrap_or_else(items),
                            "missing": ["/Users/e/.codex/config.toml"], "left": w.left,
                            "skipped": [{"path": NOTES, "lines": [8, 11]}]
                        }))
                    }
                    "/api/backends" => Ok(json!({"self": "mac", "backends": [
                        {"name": "mac", "tailnet": "http://100.0.0.1:7850"},
                        {"name": "desoto", "tailnet": "http://100.0.0.3:7850"},
                        {"name": "mini", "tailnet": "http://100.0.0.2:7850"}
                    ]})),
                    _ => panic!("unexpected {path}"),
                };
            }
            if path == "/api/secrets" {
                if t.name == "mini" && w.writer_away {
                    return Err(AskError::Unreachable("did not answer".into()));
                }
                let role = if t.name == "mini" { "writer" } else { "reader" };
                return Ok(info(json!({"backend": t.name, "role": role})));
            }
            if path == "/api/secrets/proposals" && t.name == "mini" {
                let batch = list_at(body.unwrap(), "items").to_vec();
                let n = batch.len() as i64;
                s.posted.push(batch);
                // a writer from before 2026-11-10 answers without inStep
                return Ok(match w.in_step {
                    None => json!({"added": n, "dropped": 0}),
                    Some(k) => json!({"added": n - k, "dropped": 0, "inStep": k}),
                });
            }
            panic!("unexpected {} {path}", t.name)
        },
    )
}

async fn run_propose(
    o: &ProposeArgs,
    as_json: bool,
    w: World,
    seen: &Mutex<Seen>,
) -> (Result<bool, String>, Out) {
    let mut out = Out::default();
    let r = propose(o, as_json, HOME, &world(w, seen), &mut out, PLAIN).await;
    (r, out)
}

#[tokio::test]
async fn the_texts_and_the_offset_go_with_the_scan_so_the_backend_matches_before_its_cap_and_values_past_it_name_the_offset_that_reaches_them()
 {
    let seen = Mutex::default();
    let o = args(|a| {
        a.matches = words(&["CANOPY_"]);
        a.offset = 500;
    });
    let (r, out) = run_propose(
        &o,
        false,
        World {
            left: 7,
            ..Default::default()
        },
        &seen,
    )
    .await;
    assert_eq!(r, Ok(false));
    assert_eq!(
        seen.lock().unwrap().scans,
        [json!({"match": ["CANOPY_"], "offset": 500})]
    );
    assert!(out.text.contains("7 more values come after these: once these are approved or rejected, run this again with --offset 504"));
    let all = Mutex::default();
    let (_, out) = run_propose(&args(|a| a.all = true), false, World::default(), &all).await;
    assert_eq!(
        all.lock().unwrap().scans,
        [json!({"match": [], "offset": 0})]
    );
    assert!(!out.text.contains("--offset"));
}

#[tokio::test]
async fn sends_only_what_matched_to_the_backend_that_answers_as_the_writer_and_prints_names_and_counts()
 {
    let seen = Mutex::default();
    let (r, out) = run_propose(
        &args(|a| a.matches = words(&["CANOPY_"])),
        false,
        World::default(),
        &seen,
    )
    .await;
    assert_eq!(r, Ok(false));
    let s = seen.lock().unwrap();
    let posted: Vec<Vec<String>> = s
        .posted
        .iter()
        .map(|b| b.iter().map(|p| field(p, "key")).collect())
        .collect();
    assert_eq!(
        posted,
        [[
            "providers.canopy.env.CANOPY_VOICE_KEY",
            "providers.canopy.env.CANOPY_LIVE_KEY"
        ]]
    );
    assert!(s.asked.contains(&"desoto GET /api/secrets".to_string()));
    let text = &out.text;
    assert!(text.contains("CANOPY_VOICE_KEY"));
    assert!(text.contains("2 sent to mini: 2 waiting for approval"));
    assert!(text.contains("https://canopy.beric.ca/?view=secrets"));
    assert!(text.contains("lines 8, 11 are not KEY=value"));
    assert!(!text.contains("sealed-fixture"));
    assert!(!text.contains("cloudflare"));
}

#[tokio::test]
async fn a_value_from_a_file_with_unread_lines_goes_with_its_mark_so_the_store_offers_no_sink_for_it()
 {
    let seen = Mutex::default();
    let (_, out) = run_propose(
        &args(|a| a.matches = words(&["openai"])),
        true,
        World::default(),
        &seen,
    )
    .await;
    assert_eq!(seen.lock().unwrap().posted[0][0]["partial"], json!(true));
    let v: Value = serde_json::from_str(&out.text).unwrap();
    assert_eq!(v["found"], json!(4));
    assert_eq!(
        v["picked"],
        json!([{"from": "mac", "source": NOTES, "key": "OPENAI_API_KEY", "partial": true}])
    );
    assert_eq!(
        v["sent"],
        json!({"writer": "mini", "added": 1, "dropped": 0, "inStep": 0})
    );
    assert!(!out.text.contains("sealed-fixture"));
}

#[tokio::test]
async fn what_a_sink_already_holds_is_counted_apart_and_a_send_that_leaves_nothing_waiting_names_no_next_step()
 {
    let o = args(|a| a.matches = words(&["CANOPY_"]));
    let seen = Mutex::default();
    let (r, out) = run_propose(
        &o,
        false,
        World {
            in_step: Some(1),
            ..Default::default()
        },
        &seen,
    )
    .await;
    assert_eq!(r, Ok(false));
    assert!(
        out.text
            .contains("2 sent to mini: 1 waiting for approval, 1 already in step")
    );
    assert!(out.text.contains("approve them under import"));
    let seen = Mutex::default();
    let (r, out) = run_propose(
        &o,
        false,
        World {
            in_step: Some(2),
            ..Default::default()
        },
        &seen,
    )
    .await;
    assert_eq!(r, Ok(false));
    assert!(
        out.text
            .contains("2 sent to mini: 0 waiting for approval, 2 already in step")
    );
    assert!(!out.text.contains("approve them under import"));
}

#[tokio::test]
async fn dry_run_lists_what_would_go_and_asks_no_other_backend() {
    let seen = Mutex::default();
    let (r, out) = run_propose(
        &args(|a| {
            a.all = true;
            a.dry = true;
        }),
        false,
        World::default(),
        &seen,
    )
    .await;
    assert_eq!(r, Ok(false));
    let s = seen.lock().unwrap();
    assert!(s.posted.is_empty());
    assert!(s.asked.iter().all(|a| a.starts_with("home ")));
    assert!(out.text.contains("4 of 4 would be sent; nothing was"));
}

#[tokio::test]
async fn nothing_matched_nothing_is_sent_and_the_exit_code_says_so() {
    let seen = Mutex::default();
    let (r, out) = run_propose(
        &args(|a| a.matches = words(&["nothing-here"])),
        false,
        World::default(),
        &seen,
    )
    .await;
    assert_eq!(r, Ok(true));
    assert!(seen.lock().unwrap().posted.is_empty());
    assert!(
        out.text
            .contains("nothing to send: 4 values found, none with nothing-here in its key or file")
    );
}

#[tokio::test]
async fn a_long_pick_goes_a_batch_at_a_time_in_order() {
    let many: Vec<Value> = (0..PROPOSALS + 5)
        .map(|i| item(BUNDLE, &format!("k.K{i}"), false))
        .collect();
    let seen = Mutex::default();
    let (r, _) = run_propose(
        &args(|a| a.all = true),
        false,
        World {
            scan: Some(many),
            ..Default::default()
        },
        &seen,
    )
    .await;
    assert_eq!(r, Ok(false));
    let s = seen.lock().unwrap();
    assert_eq!(
        s.posted.iter().map(Vec::len).collect::<Vec<_>>(),
        [PROPOSALS, 5]
    );
    assert_eq!(field(&s.posted[1][0], "key"), format!("k.K{PROPOSALS}"));
}

#[tokio::test]
async fn the_writer_itself_an_unknown_to_and_no_writer_in_the_list_are_each_refused_with_the_reason()
 {
    let all = args(|a| a.all = true);
    let seen = Mutex::default();
    let (r, _) = run_propose(
        &all,
        false,
        World {
            role: Some("writer"),
            ..Default::default()
        },
        &seen,
    )
    .await;
    assert!(r.unwrap_err().contains("is the store's writer"));
    let seen = Mutex::default();
    let named = args(|a| {
        a.all = true;
        a.to = Some("nas".into());
    });
    let (r, _) = run_propose(&named, false, World::default(), &seen).await;
    assert!(
        r.unwrap_err()
            .contains("no backend named nas; the home backend lists desoto, mini")
    );
    let seen = Mutex::default();
    let (r, _) = run_propose(
        &all,
        false,
        World {
            writer_away: true,
            ..Default::default()
        },
        &seen,
    )
    .await;
    assert!(
        r.unwrap_err()
            .contains("answered as the store's writer; name it with --to")
    );
    assert!(seen.lock().unwrap().posted.is_empty());
}

#[tokio::test]
async fn to_sends_to_the_named_backend_without_asking_the_others_who_writes() {
    let seen = Mutex::default();
    let o = args(|a| {
        a.matches = words(&["voice"]);
        a.to = Some("mini".into());
    });
    let (r, _) = run_propose(&o, false, World::default(), &seen).await;
    assert_eq!(r, Ok(false));
    let s = seen.lock().unwrap();
    assert!(
        !s.asked
            .iter()
            .any(|a| a.ends_with("GET /api/secrets") && !a.starts_with("home "))
    );
    assert_eq!(s.posted.len(), 1);
}

// describe("a hidden line as it is typed")

fn typed(chunks: &[&str]) -> HiddenLine {
    chunks
        .iter()
        .fold(HiddenLine::default(), |l, c| type_hidden(l, c))
}

#[test]
fn enter_ends_the_line_and_what_follows_it_in_the_same_chunk_is_not_taken() {
    assert_eq!(
        typed(&["correct horse", "\r"]),
        HiddenLine {
            text: "correct horse".into(),
            esc: EscState::None,
            done: Some(Done::Line)
        }
    );
    assert_eq!(typed(&["abc\nrest"]).text, "abc");
    assert_eq!(typed(&["abc"]).done, None);
}

#[test]
fn ctrl_c_cancels() {
    assert_eq!(typed(&["abc\u{3}"]).done, Some(Done::Cancel));
}

#[test]
fn spaces_symbols_and_letters_outside_ascii_are_kept_as_typed() {
    let pass = " With Spaces & Symbols! #$%^*()'\"\\ pässwörd-日本語 ";
    assert_eq!(typed(&[pass, "\r"]).text, pass);
}

#[test]
fn backspace_takes_one_whole_character() {
    assert_eq!(typed(&["abX\u{7f}c\r"]).text, "abc");
    assert_eq!(typed(&["ab\u{8}\u{8}\u{8}\u{8}c\r"]).text, "c");
    assert_eq!(typed(&["a🌲\u{7f}b\r"]).text, "ab");
}

#[test]
fn ctrl_u_starts_the_line_over_and_ctrl_w_takes_the_last_word() {
    assert_eq!(typed(&["oops-wrong\u{15}right one\r"]).text, "right one");
    assert_eq!(typed(&["right one junk\u{17}\r"]).text, "right one ");
    assert_eq!(typed(&["right one  \u{17}two\r"]).text, "right two");
}

#[test]
fn an_arrow_the_delete_key_and_a_pastes_markers_add_nothing_even_split_across_chunks() {
    assert_eq!(typed(&["pass-0\u{1b}[D1\r"]).text, "pass-01");
    assert_eq!(typed(&["pass-01\u{1b}[3~\r"]).text, "pass-01");
    assert_eq!(typed(&["\u{1b}OApass-01\r"]).text, "pass-01");
    assert_eq!(
        typed(&["\u{1b}[200~pasted text\u{1b}[201~", "\r"]).text,
        "pasted text"
    );
    assert_eq!(
        typed(&["pass", "\u{1b}", "[", "1;5", "C", "-01\r"]).text,
        "pass-01"
    );
}

#[test]
fn other_control_keys_add_nothing_and_enter_still_ends_a_line_after_a_stray_escape() {
    assert_eq!(typed(&["pa\tss\u{1}\u{4}-01\r"]).text, "pass-01");
    assert_eq!(
        typed(&["pass-01\u{1b}\r"]),
        HiddenLine {
            text: "pass-01".into(),
            esc: EscState::None,
            done: Some(Done::Line)
        }
    );
}

// describe("a key the store does not know, and a kept passphrase")

#[test]
fn status_names_an_open_key_the_store_does_not_seal_to_with_where_to_set_it_and_fails() {
    let unlisted =
        info(json!({"lock": "open", "recipient": "age1example", "keyUnlisted": true, "sinks": []}));
    let text = status_lines(&unlisted, PLAIN).join("\n");
    assert!(text.contains("the store does not seal to this key yet"));
    assert!(text.contains("machine key mac"));
    assert!(text.contains("https://canopy.beric.ca/?view=secrets"));
    assert!(status_exit(&unlisted));
    let open = status_lines(
        &info(json!({"lock": "open", "recipient": "age1example"})),
        PLAIN,
    );
    assert!(!open.join("\n").contains("does not seal"));
}

#[test]
fn status_says_a_kept_passphrase_opens_the_key_at_the_start() {
    assert!(
        status_lines(&info(json!({"kept": true})), PLAIN)
            .join("\n")
            .contains("kept in the login Keychain")
    );
    assert!(
        !status_lines(&info(json!({})), PLAIN)
            .join("\n")
            .contains("Keychain")
    );
}

#[test]
fn an_unlock_says_nothing_of_keeping_unless_it_was_asked_and_names_the_trade_when_the_keychain_took_it()
 {
    assert_eq!(
        unlock_lines(&json!({}), PLAIN),
        ["unlocked; this machine's sinks are written now"]
    );
    let kept = unlock_lines(&json!({"kept": true}), PLAIN).join("\n");
    assert!(kept.contains("kept in the login Keychain"));
    assert!(kept.contains("any process that runs as you can read it there"));
    assert!(kept.contains("canopy secrets forget"));
    let not = unlock_lines(
        &json!({"kept": false, "why": "the keychain did not answer"}),
        PLAIN,
    )
    .join("\n");
    assert!(not.contains("unlocked"));
    assert!(not.contains("the passphrase was not kept: the keychain did not answer"));
}

// describe("a refused unlock")

#[test]
fn a_wrong_passphrase_names_the_way_out_when_it_is_lost_any_other_refusal_is_passed_on() {
    assert!(unlock_refusal("wrong passphrase").contains("canopy secrets key --replace"));
    assert_eq!(
        unlock_refusal("wrong passphrase").split('\n').next(),
        Some("wrong passphrase")
    );
    assert_eq!(
        unlock_refusal("no key for this machine yet; create one first"),
        "no key for this machine yet; create one first\nmake one with canopy secrets key"
    );
    assert_eq!(
        unlock_refusal("this call needs the admin right"),
        "this call needs the admin right"
    );
}

// describe("a new key for this machine")

const RECIPIENT: &str = "age1fixturerecipient0x5eed";
const PASS: &str = "a long enough passphrase";

#[derive(Default)]
struct KeySeen {
    prompts: Vec<String>,
    posted: Vec<Value>,
}

async fn key_world(
    lock: &str,
    role: &str,
    typed: &[&str],
    kept: bool,
    replace: bool,
) -> (Result<(), String>, Out, KeySeen) {
    let seen = Mutex::new(KeySeen::default());
    let fake = Fake(
        |_: &Target, method: &str, path: &str, body: Option<&Value>| match (method, path) {
            ("GET", "/api/secrets") => {
                let mut i = info(json!({"lock": lock, "role": role}));
                if kept {
                    i["kept"] = json!(true);
                }
                Ok(i)
            }
            ("POST", "/api/secrets/key") => {
                seen.lock().unwrap().posted.push(body.cloned().unwrap());
                Ok(json!({"recipient": RECIPIENT}))
            }
            _ => panic!("unexpected {method} {path}"),
        },
    );
    let mut left: Vec<String> = typed.iter().map(|s| s.to_string()).collect();
    let mut read = |prompt: &str| -> Result<String, String> {
        seen.lock().unwrap().prompts.push(prompt.into());
        Ok(if left.is_empty() {
            String::new()
        } else {
            left.remove(0)
        })
    };
    let mut out = Out::default();
    let r = make_key(replace, HOME, &fake, &mut read, &mut out, PLAIN).await;
    (r, out, seen.into_inner().unwrap())
}

#[tokio::test]
async fn a_machine_with_no_key_gets_one_the_passphrase_is_asked_twice_and_the_recipient_and_the_next_step_are_printed()
 {
    let (r, out, seen) = key_world("none", "reader", &[PASS, PASS], false, false).await;
    assert_eq!(r, Ok(()));
    assert_eq!(seen.prompts.len(), 2);
    assert_eq!(seen.posted, [json!({"passphrase": PASS, "replace": false})]);
    assert!(out.text.contains(RECIPIENT));
    assert!(out.text.contains("machine key mac"));
    assert!(out.text.contains("https://canopy.beric.ca/?view=secrets"));
    assert!(!out.text.contains(PASS));
}

#[tokio::test]
async fn a_machine_that_has_a_key_keeps_it_unless_replace_is_given_and_nothing_is_asked() {
    for lock in ["locked", "open"] {
        let (r, _, seen) = key_world(lock, "reader", &[PASS, PASS], false, false).await;
        assert!(r.unwrap_err().contains("canopy secrets key --replace"));
        assert!(seen.prompts.is_empty());
        assert!(seen.posted.is_empty());
    }
}

#[tokio::test]
async fn replace_makes_a_new_key_over_a_locked_one_and_says_the_old_one_no_longer_opens_anything_here()
 {
    let (r, out, seen) = key_world("locked", "reader", &[PASS, PASS], false, true).await;
    assert_eq!(r, Ok(()));
    assert_eq!(seen.posted, [json!({"passphrase": PASS, "replace": true})]);
    assert!(out.text.contains("the old key is gone"));
    assert!(!out.text.contains("Keychain"));
    let (_, out, _) = key_world("locked", "reader", &[PASS, PASS], true, true).await;
    assert!(
        out.text
            .contains("canopy secrets unlock --keep keeps the new one")
    );
}

#[tokio::test]
async fn two_passphrases_that_differ_or_one_too_short_change_nothing() {
    let longer = format!("{PASS}x");
    let (r, _, seen) = key_world("none", "reader", &[PASS, &longer], false, false).await;
    assert!(r.unwrap_err().contains("differ"));
    assert!(seen.posted.is_empty());
    let (r, _, seen) = key_world("none", "reader", &["seven77", "seven77"], false, false).await;
    assert!(r.unwrap_err().contains("at least 8 characters"));
    assert!(seen.posted.is_empty());
    let (r, _, seen) = key_world("none", "reader", &["eight888", "eight888"], false, false).await;
    assert_eq!(r, Ok(()));
    assert_eq!(
        seen.posted,
        [json!({"passphrase": "eight888", "replace": false})]
    );
    assert!(seen.prompts[0].contains("8 characters or more"));
}

#[tokio::test]
async fn the_stores_writer_has_no_key_under_a_passphrase() {
    let (r, _, seen) = key_world("locked", "writer", &[PASS, PASS], false, true).await;
    assert!(r.unwrap_err().contains("is the store's writer"));
    assert!(seen.posted.is_empty());
}

// the usage names the limits secretwire.ts holds

#[test]
fn the_usage_names_the_passphrase_and_pending_limits() {
    assert!(SECRETS_USAGE.contains(&format!("({PASSPHRASE} characters or more)")));
    assert!(SECRETS_USAGE.contains(&format!("at most {PENDING} values")));
}

// the home backend's own fetch, and pin's local config

#[tokio::test]
async fn a_home_answer_that_is_not_json_and_a_refusal_are_said_in_secrets_own_words() {
    use crate::ask::tests::{Stub, json_answer};
    let stub = Stub::start(|s| match s.path.as_str() {
        "/api/secrets" => (502, vec![], "<html>bad gateway</html>".into()),
        "/api/secrets/unlock" => json_answer(403, json!({"error": "wrong passphrase"})),
        "/api/secrets/forget" => (302, vec![("location".into(), "/x".into())], String::new()),
        _ => json_answer(500, json!({})),
    })
    .await;
    let client = crate::ask::Client::new(Caller {
        config_dir: "/nonexistent/canopy-cli-test".into(),
        env_api: Some(stub.url.clone()),
        ..Default::default()
    });
    let caller = client.caller.clone();
    let mut read = |_: &str| -> Result<String, String> { Ok("nope".into()) };
    let run = |a: &[&str]| words(a);
    let mut out = Out::default();
    let r = secrets_cmd(
        run(&["status"]),
        &caller,
        &client,
        &mut read,
        &mut out,
        PLAIN,
    )
    .await;
    assert_eq!(
        r,
        Err(format!(
            "{} answered 502 with something other than JSON",
            stub.url
        ))
    );
    let r = secrets_cmd(
        run(&["unlock"]),
        &caller,
        &client,
        &mut read,
        &mut out,
        PLAIN,
    )
    .await;
    assert_eq!(
        r,
        Err("wrong passphrase\nif the passphrase is lost, canopy secrets key --replace makes a new key".into())
    );
    let r = secrets_cmd(
        run(&["forget"]),
        &caller,
        &client,
        &mut read,
        &mut out,
        PLAIN,
    )
    .await;
    assert_eq!(
        r,
        Err(format!(
            "{} answered 302 with something other than JSON",
            stub.url
        ))
    );
    let r = secrets_cmd(
        run(&["propose", "--all"]),
        &caller,
        &client,
        &mut read,
        &mut out,
        PLAIN,
    )
    .await;
    assert_eq!(
        r,
        Err(format!(
            "{} answered 502 with something other than JSON",
            stub.url
        ))
    );
    let down = Caller {
        env_api: Some("http://127.0.0.1:1".into()),
        ..caller.clone()
    };
    let r = secrets_cmd(run(&["list"]), &down, &client, &mut read, &mut out, PLAIN).await;
    assert_eq!(r, Err("http://127.0.0.1:1 did not answer".into()));
    assert_eq!(out.text, "");
}

#[tokio::test]
async fn pin_keeps_the_key_and_the_remote_as_the_typescript_writes_them() {
    let dir = std::env::temp_dir().join(format!("canopy-secrets-pin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let caller = Caller {
        config_dir: dir.join("cfg").to_string_lossy().into_owned(),
        env_api: Some("http://127.0.0.1:1".into()),
        ..Default::default()
    };
    let fake = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
        Err(AskError::Unreachable("down".into()))
    });
    let mut read = |_: &str| -> Result<String, String> { Ok(String::new()) };
    let key = format!("{}=", "A".repeat(43));
    let mut out = Out::default();
    let r = secrets_cmd(
        words(&["pin", "short"]),
        &caller,
        &fake,
        &mut read,
        &mut out,
        PLAIN,
    )
    .await;
    assert_eq!(
        r,
        Err("the signing key is the 44-character base64 key the secrets service prints at its start".into())
    );
    let r = secrets_cmd(
        words(&["pin", &key, "--remote", "ssh://git@forge/eric/secrets.git"]),
        &caller,
        &fake,
        &mut read,
        &mut out,
        PLAIN,
    )
    .await;
    assert_eq!(r, Ok(()));
    let path = format!("{}/secrets-config.json", caller.config_dir);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        format!(
            "{{\n  \"pin\": \"{key}\",\n  \"remote\": \"ssh://git@forge/eric/secrets.git\"\n}}\n"
        )
    );
    use std::os::unix::fs::PermissionsExt as _;
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // a second pin with no --remote keeps the remote it had
    let r = secrets_cmd(
        words(&["pin", &key]),
        &caller,
        &fake,
        &mut read,
        &mut out,
        PLAIN,
    )
    .await;
    assert_eq!(r, Ok(()));
    assert_eq!(
        out.printed(),
        [
            "pinned the mini's signing key; Forgejo: ssh://git@forge/eric/secrets.git",
            "pinned the mini's signing key; Forgejo: ssh://git@forge/eric/secrets.git"
        ]
    );
    let _ = std::fs::remove_dir_all(&dir);
}
