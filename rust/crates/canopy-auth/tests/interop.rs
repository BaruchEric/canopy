//! The Rust book against files the TS CallerBook wrote (the fixtures under
//! `tests/fixtures/ts-book`, made by gen-fixtures.ts): it takes the TS's
//! tokens, reads its callers back, and writes the bytes the TS wrote after
//! the same steps. The ignored test at the end writes a book the other way,
//! for check-rust.ts to read with the TS.

mod common;

use std::fs;
use std::path::PathBuf;

use canopy_auth::{Caller, CallerBook, CallerKind as K, MintOpts, token_hash};
use common::{MIN, Scratch, Time};
use serde_json::{Value, json};

const T0: i64 = 1_700_000_000_000;
const B64URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/ts-book/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    fs::read_to_string(path).unwrap()
}

fn value(c: &Caller) -> Value {
    serde_json::to_value(c).unwrap()
}

/// the callers in a list, the loopback caller left out: it is never on disk,
/// so a fresh book adds it last where the TS run added it first
fn without_loopback(list: &[Value]) -> Vec<Value> {
    list.iter()
        .filter(|c| c["id"] != "loopback")
        .cloned()
        .collect()
}

/// `cnp_<kind>_` and 32 random bytes as base64url with no padding
fn token_shape(token: &str, kind: &str) -> bool {
    token
        .strip_prefix(&format!("cnp_{kind}_"))
        .is_some_and(|rest| rest.len() == 43 && rest.bytes().all(|b| B64URL.contains(&b)))
}

#[test]
fn a_ts_book_reads_back_its_tokens_check_and_a_write_gives_the_ts_bytes() {
    let tokens: Value = serde_json::from_str(&fixture("tokens.json")).unwrap();
    assert_eq!(tokens["t0"], T0);
    let s = Scratch::new();
    s.t.set(T0);
    fs::write(&s.file, fixture("callers.json")).unwrap();
    let book = s.open();
    // nothing changed, so a write gives back the TS's bytes exactly
    book.flush().unwrap();
    assert_eq!(
        fs::read_to_string(&s.file).unwrap(),
        fixture("callers.json")
    );
    let minted = tokens["minted"].as_array().unwrap();
    assert_eq!(minted.len(), 9);
    for m in minted {
        let token = m["token"].as_str().unwrap();
        let got = book
            .check(Some(token))
            .unwrap_or_else(|| panic!("{token} did not check"));
        assert_eq!(value(&got), m["caller"], "{token}");
        assert!(token_shape(token, got.kind.as_str()), "{token}");
        assert_eq!(got.id.len(), 8);
        assert!(fixture("callers.json").contains(&token_hash(token)));
        // one character off is no token
        let mut wrong = token.to_string();
        let last = wrong.pop().unwrap();
        wrong.push(if last == 'A' { 'B' } else { 'A' });
        assert!(book.check(Some(&wrong)).is_none(), "{wrong}");
    }
    // the TS's next steps: two minutes on, a check writes the bump, then a
    // revoke; each writes by itself, so no flush is needed to see them
    s.t.add(2 * MIN);
    let bumped = book.check(minted[0]["token"].as_str()).unwrap();
    assert_eq!(tokens["bumpedId"], bumped.id.as_str());
    let revoked = book.revoke(tokens["revokedId"].as_str().unwrap()).unwrap();
    assert_eq!(tokens["revoked"], revoked);
    assert_eq!(
        fs::read_to_string(&s.file).unwrap(),
        fixture("callers-after.json")
    );
    let list: Vec<Value> = book.list().iter().map(value).collect();
    assert_eq!(list, without_loopback(tokens["list"].as_array().unwrap()));
    // the revoked helper's token is gone, here and for a fresh book
    let helper = minted
        .iter()
        .find(|m| m["caller"]["kind"] == "helper")
        .unwrap()["token"]
        .as_str();
    assert!(book.check(helper).is_none());
    assert!(s.open().check(helper).is_none());
}

#[test]
fn a_messy_ts_file_is_read_as_the_ts_reads_it_and_written_as_the_ts_writes_it() {
    let expect: Value = serde_json::from_str(&fixture("messy.json.expect")).unwrap();
    let s = Scratch::new();
    s.t.set(T0);
    fs::write(&s.file, fixture("messy.json")).unwrap();
    let book = s.open();
    s.t.add(2 * MIN);
    let checked = book.check(Some("cnp_page_fixture")).unwrap();
    assert_eq!(value(&checked), expect["checked"]);
    let list: Vec<Value> = book.list().iter().map(value).collect();
    assert_eq!(list, *expect["list"].as_array().unwrap());
    // the check wrote the bump, and the file is what the TS wrote
    assert_eq!(
        fs::read_to_string(&s.file).unwrap(),
        fixture("messy-after.json")
    );
    // the entries the TS dropped are no tokens here either
    for dropped in ["cnp_admin_x", "cnp_page_y", "cnp_cli_w", "cnp_cli_v"] {
        assert!(book.check(Some(dropped)).is_none(), "{dropped}");
    }
}

#[test]
fn a_rust_minted_token_has_the_ts_shape() {
    let s = Scratch::new();
    let book = s.open();
    for kind in K::ALL.into_iter().filter(|k| *k != K::None) {
        let m = book.mint(kind, MintOpts::label("x"));
        assert!(token_shape(&m.token, kind.as_str()), "{}", m.token);
        assert_eq!(m.caller.id.len(), 8);
        assert!(m.caller.id.bytes().all(|b| B64URL.contains(&b)));
    }
}

/// Writes a book the way gen-fixtures.ts does, with the Rust, plus the tokens
/// it minted, into `$CANOPY_AUTH_INTEROP_OUT`. check-rust.ts then opens the
/// book with the TS CallerBook and checks every token.
#[test]
#[ignore = "writes into $CANOPY_AUTH_INTEROP_OUT for check-rust.ts"]
fn write_a_book_for_the_ts_to_read() {
    let out = PathBuf::from(
        std::env::var("CANOPY_AUTH_INTEROP_OUT").expect("set CANOPY_AUTH_INTEROP_OUT"),
    );
    fs::create_dir_all(&out).unwrap();
    let file = out.join("callers.json");
    let _ = fs::remove_file(&file);
    let t = Time::at(T0);
    let book = CallerBook::open_with_clock(&file, t.clock());
    book.local_caller();
    let mut minted = Vec::new();
    let mut mint = |kind: K, opts: MintOpts| {
        let m = book.mint(kind, opts);
        minted.push(json!({ "token": m.token, "caller": value(&m.caller) }));
        m.caller.id
    };
    mint(K::Page, MintOpts::label("laptop \"quoted\" \\ back"));
    mint(K::Cli, MintOpts::label("cli mac\u{1}ctl\ttab\nline"));
    mint(K::Shell, MintOpts::label("sh caf\u{e9}").term("t1"));
    mint(K::Ranger, MintOpts::label("ranger \u{1F332}").run("r1"));
    mint(
        K::Coordinator,
        MintOpts::label("coordinator web").run("co1"),
    );
    mint(
        K::Run,
        MintOpts::label("run app").run("r2").user("p-abcdefgh"),
    );
    let helper = mint(K::Helper, MintOpts::label("helper mini"));
    mint(K::Page, MintOpts::label("owner phone").user("owner"));
    mint(
        K::Page,
        MintOpts::label("member phone \u{2028} sep").user("p-averyave"),
    );
    book.flush().unwrap();
    let list: Vec<Value> = book.list().iter().map(value).collect();
    let tokens = json!({ "t0": T0, "minted": minted, "helperId": helper, "list": list });
    fs::write(
        out.join("tokens.json"),
        format!("{}\n", serde_json::to_string_pretty(&tokens).unwrap()),
    )
    .unwrap();
}
