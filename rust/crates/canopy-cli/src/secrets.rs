//! `canopy secrets` (`src/cli/secrets.ts`): the list, the status,
//! unlocking this machine's key, making one, sending chosen values of this
//! machine's files to the store for approval, and pinning the mini's
//! signing key. There is no `get`: a value leaves the store through the
//! mini's page or a sink. Every line it prints is a name, a count or an
//! address; a sealed value goes from one answer into the next request and
//! nowhere else.
//!
//! `recover` (the break-glass recovery) opens and reseals every value with
//! age and signs the file with ed25519 (core/secretcrypt.ts and
//! secretfile.ts, not ported), so main hands it to the TypeScript CLI.
//!
//! The home backend's calls go through `Ask::fetch` and are read as
//! secretsCommand's own `fetch` reads them: "<home> did not answer" with no
//! detail, a body that is not JSON refused in its own words, and the
//! backend's `error` as the failure. A call to another backend (the writer
//! a propose posts to) goes through `Ask::ask`, as `askAt` does.

use crate::api::Caller;
use crate::ask::{Ask, Body, Target, targets_of};
use crate::out::Out;
use crate::render::Paint;
use canopy_core::js::{
    field, join, keys, list_at, num, num_at, number_of, number_string, pretty, str_at, template,
    truthy, truthy_at,
};
use canopy_core::pathx::{dirname, join as path_join, js_len, pad_end};
use canopy_core::secretwire::{PASSPHRASE, PROPOSALS, ProposeCount, proposed_words, skipped_words};
use serde_json::{Map, Value, json};

/// `SECRETS_USAGE`.
pub const SECRETS_USAGE: &str = "usage: canopy secrets [list] [--json]
       canopy secrets status [--json]
       canopy secrets unlock [--keep]
       canopy secrets forget
       canopy secrets key [--replace]
       canopy secrets propose (--match TEXT... | --all) [--offset N] [--to NAME] [--dry-run] [--json]
       canopy secrets pin <signing key> [--remote URL]
       canopy secrets recover <checkout> --breakglass FILE --out DIR
  list, status, unlock and propose speak to the home backend ($CANOPY_API, else 127.0.0.1:7850);
  unlock only from the machine itself. --keep also puts the passphrase in the Mac's login Keychain, so
  canopy opens the key itself at every start; any process that runs as you can then read it there.
  forget takes it out again
  key makes this machine's key under a passphrase typed twice (8 characters or more) and prints its
  recipient for the gate page; --replace makes a new one over a key whose passphrase is lost
  propose scans this machine's import sources and sends the values whose key or file holds TEXT
  (any case, any of several --match) to the store's writer, each sealed to the mini's key; they wait
  there for an approval on its gate page. --all sends every value found, --dry-run sends none,
  --to names the writer among the backends the home one lists. One scan holds at most 500 values;
  --offset N skips the first N of those it keeps, to send the rest. It prints names, never a value
  pin keeps the mini's public signing key (and Forgejo's URL) in this machine's canopy config
  recover opens every value with the break-glass identity, puts a new mini key and signing key in DIR,
  reseals and signs secrets.json in the checkout, and prints the new public halves; it commits nothing
  there is no get: a value leaves the store through the mini's page or a sink";

/// `x ?? fallback` for a field a template prints.
fn or(v: &Value, key: &str, fallback: &str) -> String {
    match v.get(key) {
        None | Some(Value::Null) => fallback.to_string(),
        some => template(some),
    }
}

/// `listLines()`: each secret's name, when it was rotated, its tags, what
/// takes it in and what it is for; never a value.
pub fn list_lines(info: &Value, p: Paint) -> Vec<String> {
    if !truthy_at(info, "ok") {
        return vec![p.rust(&format!("secrets: {}", or(info, "error", "unavailable")))];
    }
    let secrets = list_at(info, "secrets");
    if secrets.is_empty() {
        return vec![p.dim("no secrets yet")];
    }
    let w = secrets
        .iter()
        .map(|s| js_len(&field(s, "name")))
        .max()
        .unwrap_or(0);
    secrets
        .iter()
        .map(|s| {
            let tags: Vec<String> = list_at(s, "tags")
                .iter()
                .map(|t| format!("#{}", template(Some(t))))
                .collect();
            let used = list_at(s, "usedBy");
            let users = if used.is_empty() {
                String::new()
            } else {
                format!("  {}", p.dim(&format!("into {}", join(used, ", "))))
            };
            let about = if truthy_at(s, "description") {
                format!("  {}", p.dim(&field(s, "description")))
            } else {
                String::new()
            };
            let rotated = canopy_core::clips::js_slice(&field(s, "rotated"), 10);
            format!(
                "{}  {}  {}{users}{about}",
                p.bold(&pad_end(&field(s, "name"), w)),
                p.dim(&rotated),
                tags.join(" ")
            )
        })
        .collect()
}

/// `LOCK_WORD`.
fn lock_word(lock: Option<&str>) -> &'static str {
    match lock {
        Some("open") => "this machine's key is open",
        Some("locked") => "this machine's key is locked: run canopy secrets unlock",
        Some("none") => "no key on this machine",
        // `LOCK_WORD[x]` is undefined, which join prints as nothing
        _ => "",
    }
}

fn plural(n: f64, word: &str) -> String {
    format!(
        "{} {word}{}",
        number_string(n),
        if n == 1.0 { "" } else { "s" }
    )
}

/// `statusLines()`: where this backend stands with the store: its role and
/// commit, a refusal, the key's lock, the sinks it writes, and the
/// proposals that wait.
pub fn status_lines(info: &Value, p: Paint) -> Vec<String> {
    let role = if str_at(info, "role") == Some("writer") {
        "the writer"
    } else {
        "a verified copy"
    };
    let mut out = vec![format!(
        "{}: {role}, commit {}",
        p.bold(&field(info, "backend")),
        or(info, "head", "none")
    )];
    if truthy_at(info, "error") {
        out.push(p.rust(&field(info, "error")));
    }
    if truthy_at(info, "refused") {
        out.push(p.rust(&format!("refused: {}", field(info, "refused"))));
    }
    let lock = str_at(info, "lock");
    out.push(if lock == Some("open") && truthy_at(info, "recipient") {
        format!(
            "{}, recipient {}",
            lock_word(lock),
            field(info, "recipient")
        )
    } else {
        lock_word(lock).to_string()
    });
    if truthy_at(info, "keyUnlisted") {
        out.push(p.rust(&format!(
            "the store does not seal to this key yet: at {}, under passkeys, set it as machine key {}",
            field(info, "gate"),
            field(info, "backend")
        )));
    }
    if truthy_at(info, "kept") {
        out.push("its passphrase is kept in the login Keychain: canopy opens the key itself when it starts (canopy secrets forget takes it out)".into());
    }
    let unpushed = num_at(info, "unpushed").unwrap_or(0.0);
    if unpushed > 0.0 {
        out.push(p.lichen(&format!(
            "{} waiting for Forgejo",
            plural(unpushed, "commit")
        )));
    }
    if truthy_at(info, "firstPasskey") {
        out.push(
            p.lichen("no passkey yet: the first-passkey code is in the secrets service's log"),
        );
    }
    for s in list_at(info, "sinks") {
        let state = s.get("state");
        let ks = keys(state);
        if ks.is_empty() && !truthy_at(s, "error") {
            continue;
        }
        let words: Vec<String> = ks
            .iter()
            .map(|k| {
                let st = state.and_then(|o| o.get(k.as_str()));
                if st.and_then(Value::as_str) == Some("drift") {
                    p.rust(&format!("{k} drift"))
                } else {
                    format!("{k} {}", template(st))
                }
            })
            .collect();
        let error = if truthy_at(s, "error") {
            format!(" {}", p.rust(&field(s, "error")))
        } else {
            String::new()
        };
        out.push(format!(
            "sink {} ({}) {}: {}{error}",
            field(s, "id"),
            field(s, "machine"),
            p.dim(&field(s, "path")),
            words.join(", ")
        ));
    }
    let waiting = list_at(info, "proposals").len();
    if waiting > 0 {
        out.push(format!(
            "{} waiting on {}",
            plural(waiting as f64, "import proposal"),
            field(info, "gate")
        ));
    }
    out
}

/// `statusExit()`: 1 on a store that is not read, a refusal, a key the
/// store does not seal to, a sink error or drift.
pub fn status_exit(info: &Value) -> bool {
    let not_null = |v: &Value, k: &str| !matches!(v.get(k), Some(Value::Null));
    !truthy_at(info, "ok")
        || not_null(info, "refused")
        || info.get("keyUnlisted") == Some(&Value::Bool(true))
        || list_at(info, "sinks").iter().any(|s| {
            not_null(s, "error")
                || s.get("state")
                    .and_then(Value::as_object)
                    .is_some_and(|m| m.values().any(|v| *v == "drift"))
        })
}

/// A hidden line's escape state: after ESC, inside a CSI sequence, or
/// before the one byte an SS3 carries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum EscState {
    #[default]
    None,
    Esc,
    Csi,
    One,
}

/// How a hidden line ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Done {
    Line,
    Cancel,
}

/// `HiddenLine`: a hidden line as it is typed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HiddenLine {
    pub text: String,
    pub esc: EscState,
    pub done: Option<Done>,
}

/// `\S*\s*$` taken off the end: the last word and the space after it.
fn drop_word(text: &str) -> String {
    let t = canopy_core::pathx::js_trim_end(text);
    t.trim_end_matches(|c| !canopy_core::pathx::js_ws(c))
        .to_string()
}

/// `typeHidden()`: one chunk of keys added to a hidden line. Backspace,
/// ctrl-u and ctrl-w work as at a shell's own password prompt; a key that
/// sends an escape sequence and any other control key add nothing.
pub fn type_hidden(line: HiddenLine, chunk: &str) -> HiddenLine {
    let HiddenLine {
        mut text, mut esc, ..
    } = line;
    for c in chunk.chars() {
        if c == '\r' || c == '\n' {
            return HiddenLine {
                text,
                esc: EscState::None,
                done: Some(Done::Line),
            };
        }
        if c == '\u{3}' {
            return HiddenLine {
                text,
                esc: EscState::None,
                done: Some(Done::Cancel),
            };
        }
        let code = c as u32;
        match esc {
            EscState::Esc => {
                esc = match c {
                    '[' => EscState::Csi,
                    'O' => EscState::One,
                    _ => EscState::None,
                }
            }
            EscState::One => esc = EscState::None,
            EscState::Csi => {
                if (0x40..=0x7e).contains(&code) {
                    esc = EscState::None;
                }
            }
            EscState::None => match c {
                '\u{1b}' => esc = EscState::Esc,
                '\u{7f}' | '\u{8}' => {
                    text.pop();
                }
                '\u{15}' => text.clear(),
                '\u{17}' => text = drop_word(&text),
                _ if code >= 0x20 => text.push(c),
                _ => {}
            },
        }
    }
    HiddenLine {
        text,
        esc,
        done: None,
    }
}

/// `unlockRefusal()`: what a refused unlock tells the terminal, with the
/// way out when the passphrase is lost or there is no key.
pub fn unlock_refusal(error: &str) -> String {
    if error == "wrong passphrase" {
        return format!(
            "{error}\nif the passphrase is lost, canopy secrets key --replace makes a new key"
        );
    }
    if error.starts_with("no key for this machine") {
        return format!("{error}\nmake one with canopy secrets key");
    }
    error.to_string()
}

/// `unlockLines()`: what an unlock's answer tells the terminal; keeping is
/// said only when it was asked for.
pub fn unlock_lines(a: &Value, p: Paint) -> Vec<String> {
    let mut out = vec!["unlocked; this machine's sinks are written now".to_string()];
    match a.get("kept") {
        Some(Value::Bool(true)) => {
            out.push("the passphrase is kept in the login Keychain, so canopy opens this key itself when it starts".into());
            out.push(p.lichen("any process that runs as you can read it there, an agent in a shell included; canopy secrets forget takes it out"));
        }
        Some(Value::Bool(false)) => out.push(p.rust(&format!(
            "the passphrase was not kept: {}",
            or(a, "why", "the keychain did not take it")
        ))),
        _ => {}
    }
    out
}

/// One hidden line for a prompt: typed at the terminal with no echo, or
/// the next line of piped stdin. Err is why it was not given ("cancelled").
pub type ReadLine<'a> = dyn FnMut(&str) -> Result<String, String> + 'a;

/// One call to the home backend as secretsCommand's `asking()` makes it:
/// a refusal's words go through `refusal`.
async fn home_call(
    ask: &impl Ask,
    home: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    refusal: fn(&str) -> String,
) -> Result<Value, String> {
    let r = ask
        .fetch(method, home, path, body.map(Body::Json), None)
        .await
        .map_err(|_| format!("{home} did not answer"))?;
    let Some(v) = r.json() else {
        return Err(format!(
            "{home} answered {} with something other than JSON",
            r.status
        ));
    };
    if !r.ok() {
        let error = match v.get("error") {
            None | Some(Value::Null) => format!("{home} answered {}", r.status),
            some => template(some),
        };
        return Err(refusal(&error));
    }
    Ok(v)
}

fn as_is(e: &str) -> String {
    e.to_string()
}

/// `makeKey()`: this machine's key under a passphrase typed twice, or with
/// `replace` a new one over a key that no longer opens. The store hears of
/// the new recipient only through the gate page, so that is what it prints.
pub(crate) async fn make_key(
    replace: bool,
    home: &str,
    ask: &impl Ask,
    read: &mut ReadLine<'_>,
    out: &mut Out,
    p: Paint,
) -> Result<(), String> {
    let mine = home_call(ask, home, "GET", "/api/secrets", None, as_is).await?;
    if str_at(&mine, "role") == Some("writer") {
        return Err(format!(
            "{} is the store's writer: its keys sit in its data volume with no passphrase, and canopy secrets recover replaces them",
            field(&mine, "backend")
        ));
    }
    let had = str_at(&mine, "lock") != Some("none");
    if had && !replace {
        return Err("this machine has a key: canopy secrets unlock opens it. If its passphrase is lost, canopy secrets key --replace makes a new one".into());
    }
    let pass = read(&format!(
        "{}passphrase for this machine's secrets key, {PASSPHRASE} characters or more: ",
        if had { "new " } else { "" }
    ))?;
    let again = read("the same again: ")?;
    if pass != again {
        return Err("the two passphrases differ; nothing was changed".into());
    }
    if js_len(&pass) < PASSPHRASE {
        return Err(format!(
            "use a passphrase of at least {PASSPHRASE} characters; nothing was changed"
        ));
    }
    let body = json!({"passphrase": pass, "replace": replace});
    let k = home_call(ask, home, "POST", "/api/secrets/key", Some(&body), as_is).await?;
    out.line(if had {
        "a new key is made and open; the old key is gone"
    } else {
        "the key is made and open"
    });
    out.line(format!("recipient  {}", p.bold(&field(&k, "recipient"))));
    out.line(format!(
        "next: at {}, open a passkey session and, under passkeys, set this recipient as machine key {}",
        field(&mine, "gate"),
        field(&mine, "backend")
    ));
    out.line("until then the store seals nothing to it, and this machine's sinks stay waiting");
    if truthy_at(&mine, "kept") {
        out.line("the old key's kept passphrase is out of the keychain; canopy secrets unlock --keep keeps the new one");
    }
    Ok(())
}

/// `take()` in secrets.ts: `name` and the word after it out of `args`,
/// both gone even when nothing follows.
fn take(args: &mut Vec<String>, name: &str) -> Option<String> {
    crate::ask::take(args, name)
}

/// `ProposeArgs`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProposeArgs {
    /// texts a key or a file's path may hold, in any case
    pub matches: Vec<String>,
    pub all: bool,
    /// the writer's name in the home backend's list
    pub to: Option<String>,
    pub dry: bool,
    /// how many of the values the scan keeps to skip
    pub offset: u64,
}

/// `parsePropose()`: propose's flags, or what is wrong with them.
pub fn parse_propose(flags: &[String]) -> Result<ProposeArgs, String> {
    let mut args = flags.to_vec();
    let mut matches = Vec::new();
    while args.iter().any(|a| a == "--match") {
        match take(&mut args, "--match") {
            Some(t) if !t.is_empty() && !t.starts_with("--") => matches.push(t),
            _ => return Err("--match needs a text".into()),
        }
    }
    let all = crate::ask::has(&mut args, "--all");
    let dry = crate::ask::has(&mut args, "--dry-run");
    let has_to = args.iter().any(|a| a == "--to");
    let to = take(&mut args, "--to");
    if has_to
        && to
            .as_deref()
            .is_none_or(|t| t.is_empty() || t.starts_with("--"))
    {
        return Err("--to needs a backend's name".into());
    }
    let has_offset = args.iter().any(|a| a == "--offset");
    let offset_text = take(&mut args, "--offset");
    let offset = if has_offset {
        match offset_text {
            Some(t) if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) => number_of(&t),
            _ => f64::NAN,
        }
    } else {
        0.0
    };
    // Number.isSafeInteger
    if !(offset.is_finite() && offset.fract() == 0.0 && offset.abs() <= 9_007_199_254_740_991.0) {
        return Err("--offset needs a whole number, 0 or more".into());
    }
    if !args.is_empty() {
        return Err(format!("not understood: {}", args.join(" ")));
    }
    if all == !matches.is_empty() {
        return Err(
            "name what to send: --match TEXT (as often as needed), or --all for every value found"
                .into(),
        );
    }
    Ok(ProposeArgs {
        matches,
        all,
        to,
        dry,
        offset: offset as u64,
    })
}

/// `pickProposals()`: the scanned values a propose keeps: all of them, or
/// those whose key or file holds one of the texts, in any case.
pub fn pick_proposals(items: &[Value], o: &ProposeArgs) -> Vec<Value> {
    if o.all {
        return items.to_vec();
    }
    let want: Vec<String> = o.matches.iter().map(|t| t.to_lowercase()).collect();
    items
        .iter()
        .filter(|p| {
            let key = field(p, "key").to_lowercase();
            let source = field(p, "source").to_lowercase();
            want.iter()
                .any(|t| key.contains(t.as_str()) || source.contains(t.as_str()))
        })
        .cloned()
        .collect()
}

/// What `propose` sent and where.
struct Sent {
    writer: String,
    added: f64,
    dropped: f64,
    in_step: f64,
}

/// `propose()`: scan the home backend's sources, keep what was asked for,
/// and post it to the writer a batch at a time. Returns whether the exit
/// code is 1.
pub(crate) async fn propose(
    o: &ProposeArgs,
    as_json: bool,
    home: &str,
    ask: &impl Ask,
    out: &mut Out,
    p: Paint,
) -> Result<bool, String> {
    let mine = home_call(ask, home, "GET", "/api/secrets", None, as_is).await?;
    if str_at(&mine, "role") == Some("writer") {
        return Err(format!(
            "{} is the store's writer: it scans its own sources from the gate page, {}",
            field(&mine, "backend"),
            field(&mine, "gate")
        ));
    }
    // the backend matches before its cap, so a value past the 500th can
    // still be picked; pick_proposals filters again for one that ignores it
    let wanted: Vec<String> = if o.all { vec![] } else { o.matches.clone() };
    let scan_body = json!({"match": wanted, "offset": o.offset});
    let scan = home_call(
        ask,
        home,
        "POST",
        "/api/secrets/scan",
        Some(&scan_body),
        as_is,
    )
    .await?;
    let items = list_at(&scan, "items");
    let picked = pick_proposals(items, o);
    let names: Vec<Value> = picked
        .iter()
        .map(|it| {
            let mut n = Map::new();
            for k in ["from", "source", "key"] {
                if let Some(v) = it.get(k) {
                    n.insert(k.into(), v.clone());
                }
            }
            n.insert(
                "partial".into(),
                Value::Bool(it.get("partial") == Some(&Value::Bool(true))),
            );
            Value::Object(n)
        })
        .collect();
    let missing = list_at(&scan, "missing");
    let left = match scan.get("left") {
        None | Some(Value::Null) => 0.0,
        Some(v) => v.as_f64().unwrap_or(f64::NAN),
    };
    let mut notes: Vec<String> = list_at(&scan, "skipped")
        .iter()
        .map(skipped_words)
        .collect();
    if !missing.is_empty() {
        notes.push(format!("not on this machine: {}", join(missing, ", ")));
    }
    if left > 0.0 {
        notes.push(format!(
            "{} more values come after these: once these are approved or rejected, run this again with --offset {}",
            number_string(left),
            o.offset + items.len() as u64
        ));
    }
    let found = items.len();
    let say = |sent: Option<&Sent>, out: &mut Out| {
        if as_json {
            let sent = sent.map_or(Value::Null, |s| {
                json!({"writer": s.writer, "added": num(s.added), "dropped": num(s.dropped), "inStep": num(s.in_step)})
            });
            out.line(pretty(
                &json!({"found": found, "picked": names, "sent": sent, "notes": notes}),
            ));
            return;
        }
        for n in &names {
            out.line(format!(
                "{}  {}",
                p.dim(&field(n, "source")),
                p.bold(&field(n, "key"))
            ));
        }
        for n in &notes {
            out.line(p.lichen(n));
        }
    };
    if picked.is_empty() {
        say(None, out);
        if !as_json {
            let none = if o.all {
                "at all".to_string()
            } else {
                format!("with {} in its key or file", o.matches.join(" or "))
            };
            out.line(format!(
                "nothing to send: {} found, none {none}",
                plural(found as f64, "value")
            ));
        }
        return Ok(true);
    }
    if o.dry {
        say(None, out);
        if !as_json {
            out.line(format!(
                "{} of {found} would be sent; nothing was",
                picked.len()
            ));
        }
        return Ok(false);
    }
    let listed = home_call(ask, home, "GET", "/api/backends", None, as_is).await?;
    let self_name = match listed.get("self") {
        None | Some(Value::Null) => field(&mine, "backend"),
        some => template(some),
    };
    let others: Vec<Target> = targets_of(home, &self_name, list_at(&listed, "backends"))
        .into_iter()
        .skip(1)
        .collect();
    let names_of = |ts: &[Target]| {
        ts.iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let writer = match &o.to {
        Some(to) => match others.iter().find(|t| &t.name == to) {
            Some(t) => t.clone(),
            None => {
                let listed = names_of(&others);
                return Err(format!(
                    "no backend named {to}; the home backend lists {}",
                    if listed.is_empty() { "none" } else { &listed }
                ));
            }
        },
        None => {
            let mut found_writer = None;
            for t in &others {
                let info = ask.ask(t, "GET", "/api/secrets", None).await.ok();
                if info.as_ref().and_then(|i| str_at(i, "role")) == Some("writer") {
                    found_writer = Some(t.clone());
                    break;
                }
            }
            match found_writer {
                Some(t) => t,
                None => {
                    let listed = names_of(&others);
                    return Err(format!(
                        "none of {} answered as the store's writer; name it with --to",
                        if listed.is_empty() {
                            "the backends the home one lists"
                        } else {
                            &listed
                        }
                    ));
                }
            }
        }
    };
    let mut sent = Sent {
        writer: writer.name.clone(),
        added: 0.0,
        dropped: 0.0,
        in_step: 0.0,
    };
    // the store takes a batch at a time and refuses a longer one whole
    for batch in picked.chunks(PROPOSALS) {
        let body = json!({ "items": batch });
        let r = ask
            .ask(&writer, "POST", "/api/secrets/proposals", Some(&body))
            .await
            .map_err(|e| e.message().to_string())?;
        let n = |k: &str| r.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
        sent.added += n("added");
        sent.dropped += n("dropped");
        sent.in_step += match r.get("inStep") {
            None | Some(Value::Null) => 0.0,
            Some(v) => v.as_f64().unwrap_or(f64::NAN),
        };
    }
    say(Some(&sent), out);
    if !as_json {
        let count = ProposeCount {
            added: sent.added,
            dropped: sent.dropped,
            in_step: Some(sent.in_step),
        };
        out.line(format!(
            "{} sent to {}: {}",
            picked.len(),
            sent.writer,
            proposed_words(&count)
        ));
        if sent.added > 0.0 {
            out.line(format!(
                "approve them under import at {}; they wait a day",
                field(&mine, "gate")
            ));
        }
    }
    Ok(sent.dropped > 0.0)
}

/// `PIN`: a raw ed25519 public key in base64, 32 bytes.
pub fn is_pin(s: &str) -> bool {
    s.len() == 44
        && s.ends_with('=')
        && s[..43]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// `readLocalConfig()`: the pinned key and Forgejo's URL, each null when
/// the file is missing, broken or holds something else.
pub fn read_local_config(path: &str) -> (Option<String>, Option<String>) {
    let Some(v) = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    else {
        return (None, None);
    };
    let pin = str_at(&v, "pin").filter(|p| is_pin(p)).map(String::from);
    let remote = str_at(&v, "remote")
        .filter(|r| !r.is_empty())
        .map(String::from);
    (pin, remote)
}

/// `writeLocalConfig()`: the file whole, through a rename, mode 0600, as
/// `JSON.stringify(c, null, 2)` writes it.
pub fn write_local_config(path: &str, pin: &str, remote: Option<&str>) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let tmp = format!("{path}.tmp-{}-{stamp:08x}", std::process::id());
    let text = format!("{}\n", pretty(&json!({"pin": pin, "remote": remote})));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// `secretsCommand()`.
pub(crate) async fn secrets_cmd(
    args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    read: &mut ReadLine<'_>,
    out: &mut Out,
    p: Paint,
) -> Result<(), String> {
    let home = caller.api_base(None);
    let as_json = args.iter().any(|a| a == "--json");
    let mut rest: Vec<String> = args.into_iter().filter(|a| a != "--json").collect();
    let sub = rest.first().cloned().unwrap_or_else(|| "list".into());
    let get = |method: &'static str, path: &'static str, body: Option<Value>| {
        let home = home.clone();
        async move { home_call(ask, &home, method, path, body.as_ref(), as_is).await }
    };
    match sub.as_str() {
        "list" | "status" => {
            let info = get("GET", "/api/secrets", None).await?;
            let list = sub == "list";
            if as_json {
                let shown = if list {
                    info.get("secrets")
                } else {
                    Some(&info)
                };
                out.line(shown.map_or("undefined".into(), pretty));
            } else if list {
                out.line(list_lines(&info, p).join("\n"));
            } else {
                out.line(status_lines(&info, p).join("\n"));
            }
            if !list && status_exit(&info) {
                out.failed = true;
            }
            Ok(())
        }
        "unlock" => {
            let flags = &rest[1..];
            let odd: Vec<&str> = flags
                .iter()
                .filter(|a| *a != "--keep")
                .map(String::as_str)
                .collect();
            if !odd.is_empty() {
                return Err(format!(
                    "not understood: {}\n{SECRETS_USAGE}",
                    odd.join(" ")
                ));
            }
            let keep = flags.iter().any(|a| a == "--keep");
            let pass = read("passphrase for this machine's secrets key: ")?;
            let body = if keep {
                json!({"passphrase": pass, "keep": true})
            } else {
                json!({"passphrase": pass})
            };
            let a = home_call(
                ask,
                &home,
                "POST",
                "/api/secrets/unlock",
                Some(&body),
                unlock_refusal,
            )
            .await?;
            out.lines(unlock_lines(&a, p));
            if a.get("kept") == Some(&Value::Bool(false)) {
                out.failed = true;
            }
            Ok(())
        }
        "forget" => {
            get("POST", "/api/secrets/forget", Some(json!({}))).await?;
            out.line("the kept passphrase is out of the keychain; the key stays as it is, and the next canopy start asks for the passphrase");
            Ok(())
        }
        "key" => {
            let flags = &rest[1..];
            let odd: Vec<&str> = flags
                .iter()
                .filter(|a| *a != "--replace")
                .map(String::as_str)
                .collect();
            if !odd.is_empty() {
                return Err(format!(
                    "not understood: {}\n{SECRETS_USAGE}",
                    odd.join(" ")
                ));
            }
            let replace = flags.iter().any(|a| a == "--replace");
            make_key(replace, &home, ask, read, out, p).await
        }
        "propose" => {
            let o = parse_propose(&rest[1..]).map_err(|e| format!("{e}\n{SECRETS_USAGE}"))?;
            if propose(&o, as_json, &home, ask, out, p).await? {
                out.failed = true;
            }
            Ok(())
        }
        "pin" => {
            let key = rest.get(1).cloned().unwrap_or_default();
            if !is_pin(&key) {
                return Err("the signing key is the 44-character base64 key the secrets service prints at its start".into());
            }
            let remote = take(&mut rest, "--remote");
            let config = path_join(&caller.config_dir, "secrets-config.json");
            std::fs::create_dir_all(dirname(&config)).map_err(|e| e.to_string())?;
            let (_, cur_remote) = read_local_config(&config);
            let remote = remote.or(cur_remote);
            write_local_config(&config, &key, remote.as_deref()).map_err(|e| e.to_string())?;
            out.line(format!(
                "pinned the mini's signing key; Forgejo: {}",
                remote.as_deref().unwrap_or("not set, add --remote URL")
            ));
            // a pull now, when the home backend runs; the pin stands either way
            let info = ask
                .fetch("POST", &home, "/api/secrets/pull", None, None)
                .await
                .ok()
                .filter(|r| r.ok())
                .and_then(|r| r.json());
            if let Some(info) = info.filter(truthy_value) {
                out.line(status_lines(&info, p).join("\n"));
            }
            Ok(())
        }
        _ => Err(SECRETS_USAGE.into()),
    }
}

/// `if (info)`: a JSON answer that is not null, false, 0 or "".
fn truthy_value(v: &Value) -> bool {
    truthy(Some(v))
}

/// A hidden line for each prompt, as `hiddenLines()` gives them: typed at
/// the terminal with no echo, or, piped, stdin read once and its lines
/// handed out in order with no prompt.
#[derive(Debug, Default)]
pub struct HiddenLines {
    piped: Option<Vec<String>>,
}

impl HiddenLines {
    pub fn read(&mut self, prompt: &str) -> Result<String, String> {
        use std::io::{IsTerminal as _, Read as _};
        if std::io::stdin().is_terminal() {
            return read_hidden(prompt);
        }
        let lines = self.piped.get_or_insert_with(|| {
            let mut bytes = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes)
                .split('\n')
                .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
                .collect()
        });
        Ok(if lines.is_empty() {
            String::new()
        } else {
            lines.remove(0)
        })
    }
}

/// `readHidden()`: a line typed at the terminal with no echo, in the raw
/// mode Node's `setRawMode(true)` sets, its keys read by `type_hidden`.
fn read_hidden(prompt: &str) -> Result<String, String> {
    use rustix::termios::{
        ControlModes, InputModes, LocalModes, OptionalActions, OutputModes, SpecialCodeIndex,
        tcgetattr, tcsetattr,
    };
    use std::io::{Read as _, Write as _};
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    let stdin = std::io::stdin();
    let old = tcgetattr(&stdin).map_err(|e| e.to_string())?;
    let mut raw = old.clone();
    raw.input_modes -= InputModes::BRKINT
        | InputModes::ICRNL
        | InputModes::INPCK
        | InputModes::ISTRIP
        | InputModes::IXON;
    raw.output_modes |= OutputModes::ONLCR;
    raw.control_modes |= ControlModes::CS8;
    raw.local_modes -=
        LocalModes::ECHO | LocalModes::ICANON | LocalModes::IEXTEN | LocalModes::ISIG;
    raw.special_codes[SpecialCodeIndex::VMIN] = 1;
    raw.special_codes[SpecialCodeIndex::VTIME] = 0;
    tcsetattr(&stdin, OptionalActions::Drain, &raw).map_err(|e| e.to_string())?;
    let mut line = HiddenLine::default();
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    let mut lock = stdin.lock();
    loop {
        let n = lock.read(&mut buf).unwrap_or(0);
        if n == 0 {
            line.done = Some(Done::Cancel);
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        // a character split across reads waits for its last byte
        let good = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(e) => e.valid_up_to() + e.error_len().unwrap_or(1),
        };
        let chunk = String::from_utf8_lossy(&pending[..good]).into_owned();
        pending.drain(..good);
        line = type_hidden(line, &chunk);
        if line.done.is_some() {
            break;
        }
    }
    drop(lock);
    let _ = tcsetattr(&stdin, OptionalActions::Drain, &old);
    eprintln!();
    match line.done {
        Some(Done::Line) => Ok(line.text),
        _ => Err("cancelled".into()),
    }
}

#[cfg(test)]
mod tests;
