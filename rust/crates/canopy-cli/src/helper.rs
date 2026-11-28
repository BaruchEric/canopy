//! `canopy helper` (the `case "helper"` arm of src/cli/index.ts): the other
//! half of a headless backend, which dials it and runs the desktop openers
//! on this machine for the browser here.
//!
//! What runs in Rust: the arguments in index.ts's order (`--token`, then
//! `--backend`, else `$CANOPY_BACKEND` when that is an origin and not a
//! backend's name, else 127.0.0.1:7850; `--name`, `--code`, `--openers`,
//! `--pair`, `--no-emulators`), the refusals (a backend that is not an
//! http(s) origin, an opener canopy does not know, a backend no URL parser
//! takes), and `--pair`: the pair request, its approval by the inbox or the
//! first code, and the helper token kept in `token-helper-<host>-<port>`
//! under the config dir, 0600, the token and a newline (`pair.rs`).
//!
//! What still goes to the TypeScript CLI: the loop itself (`runHelper` in
//! src/core/helperd.ts), which holds a websocket to the backend for the
//! life of the process, fetches a ticket for each dial, and runs each intent
//! through src/core/openers.ts and src/core/emulatord.ts, none of which is
//! ported. Once the refusals pass and any pairing is done, canopy-rs hands
//! `bun bin/canopy.ts` the same arguments, less `--pair` and the `--code`
//! it used, so the TypeScript reads the token file this wrote and starts
//! the loop as it would have. Where taking those words out would change how
//! the TypeScript reads the rest (a `--code` whose value is another flag),
//! nothing is paired here and the arguments go over whole.

use crate::api::{Caller, LOCAL};
use crate::ask::Client;
use crate::jsdate::locale_time_string;
use crate::pair::{POLL, PairOptions, WINDOW, pair_flow, pair_label, save_token};
use crate::render::Paint;
use canopy_core::pathx::{fs_error_words, js_trim};
use canopy_core::types::is_opener_id;
use std::time::Duration;

/// The helper's arguments as index.ts reads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub backend: String,
    /// `--name`; the loop takes the hostname's first label without it
    pub name: Option<String>,
    /// `--code`, the first sign-in code `--pair` passes on
    pub code: Option<String>,
    /// `--openers`, checked; the loop takes what is installed without it
    pub openers: Option<Vec<String>>,
    pub pair: bool,
    pub no_emulators: bool,
    /// `helperTokenFile(backend)`
    pub token_path: String,
    /// Where `--pair` and the `--code` it used stood among the arguments.
    pair_words: Vec<usize>,
}

/// The words after the verb, each with where it stood in the arguments.
type Words = Vec<(usize, String)>;

/// index.ts's `opt()`: a flag and the word after it, taken out only when a
/// word follows.
fn opt(w: &mut Words, name: &str) -> Option<(String, [usize; 2])> {
    let i = w.iter().position(|(_, a)| a == name)?;
    if i + 1 >= w.len() {
        return None;
    }
    let (at_value, value) = w.remove(i + 1);
    let (at_flag, _) = w.remove(i);
    Some((value, [at_flag, at_value]))
}

/// index.ts's `flag()`: a bare flag taken out.
fn flag(w: &mut Words, name: &str) -> Option<usize> {
    let i = w.iter().position(|(_, a)| a == name)?;
    Some(w.remove(i).0)
}

/// `/^https?:\/\//`.
fn is_http(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

/// The helper's arguments, `args` being the whole command line from the
/// verb on, or the failure index.ts stops at. `env_backend` is
/// `$CANOPY_BACKEND`, which stands in for `--backend` only when it is an
/// origin: inside a canopy shell it is the backend's name.
pub fn parse(
    args: &[String],
    env_backend: Option<&str>,
    caller: &Caller,
) -> Result<Parsed, String> {
    let mut w: Words = args.iter().cloned().enumerate().skip(1).collect();
    opt(&mut w, "--token");
    let env_origin = env_backend.filter(|b| is_http(b)).map(String::from);
    let backend = opt(&mut w, "--backend")
        .map(|(v, _)| v)
        .or(env_origin)
        .unwrap_or_else(|| LOCAL.to_string());
    if !is_http(&backend) {
        return Err(format!(
            "--backend must be an http(s) origin, got {backend}"
        ));
    }
    let name = opt(&mut w, "--name").map(|(v, _)| v);
    let code = opt(&mut w, "--code");
    let openers = match opt(&mut w, "--openers") {
        None => None,
        Some((listed, _)) => {
            let mut out = Vec::new();
            for raw in listed.split(',') {
                let v = js_trim(raw);
                if v.is_empty() {
                    continue;
                }
                if !is_opener_id(v) {
                    return Err(format!("unknown opener in --openers: {v}"));
                }
                out.push(v.to_string());
            }
            Some(out)
        }
    };
    let token_path = caller
        .helper_token_file(&backend)
        .ok_or_else(|| "Invalid URL".to_string())?;
    let pair = flag(&mut w, "--pair");
    let no_emulators = flag(&mut w, "--no-emulators").is_some();
    let mut pair_words = Vec::new();
    if let Some(at) = pair {
        pair_words.push(at);
        if let Some((_, at)) = &code {
            pair_words.extend(at);
        }
    }
    Ok(Parsed {
        backend,
        name,
        code: code.map(|(v, _)| v),
        openers,
        pair: pair.is_some(),
        no_emulators,
        token_path,
        pair_words,
    })
}

/// What canopy-rs does with a helper's arguments once they pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Pair here before the loop starts.
    pub pair: bool,
    /// The arguments the TypeScript CLI gets for the loop.
    pub delegate: Vec<String>,
}

/// Pair here only when the arguments without `--pair` and its `--code`
/// read the same to the TypeScript, less the pairing; else hand them over
/// whole and let the TypeScript pair.
pub fn plan(args: &[String], p: &Parsed, env_backend: Option<&str>, caller: &Caller) -> Plan {
    let whole = Plan {
        pair: false,
        delegate: args.to_vec(),
    };
    if !p.pair {
        return whole;
    }
    let rest: Vec<String> = args
        .iter()
        .enumerate()
        .filter(|(i, _)| !p.pair_words.contains(i))
        .map(|(_, a)| a.clone())
        .collect();
    match parse(&rest, env_backend, caller) {
        Ok(again)
            if !again.pair
                && again.backend == p.backend
                && again.name == p.name
                && again.openers == p.openers
                && again.no_emulators == p.no_emulators =>
        {
            Plan {
                pair: true,
                delegate: rest,
            }
        }
        _ => whole,
    }
}

/// `--pair`: the pair request and its approval, then the token kept, each
/// step's line said with the time first. The failure reads as index.ts's
/// "pairing failed: ...".
pub async fn pair_here(
    p: &Parsed,
    client: &Client,
    paint: Paint,
    poll: Duration,
    window: Duration,
    say: &dyn Fn(&str),
) -> Result<(), String> {
    let stamp = || paint.dim(&locale_time_string(canopy_core::types::now_ms() as f64));
    let said = |l: &str| say(&format!("{} {l}", stamp()));
    let label = pair_label("helper");
    let opts = PairOptions {
        base: &p.backend,
        label: &label,
        kind: "helper",
        code: p.code.as_deref().filter(|c| !c.is_empty()),
        poll,
        window,
        say: &said,
    };
    let failed = |m: String| format!("pairing failed: {m}");
    let token = pair_flow(client, &opts).await.map_err(failed)?;
    save_token(&p.token_path, &token)
        .map_err(|e| failed(fs_error_words(&e, "open", &p.token_path)))?;
    say(&format!(
        "{} {} {}",
        stamp(),
        paint.moss("paired"),
        paint.dim(&format!("(helper token kept in {})", p.token_path))
    ));
    Ok(())
}

/// `pair_here` with pairing's own pace: a poll every 2 s for 10 minutes.
pub async fn pair_now(p: &Parsed, client: &Client, paint: Paint) -> Result<(), String> {
    use std::io::Write as _;
    let say = |l: &str| {
        println!("{l}");
        let _ = std::io::stdout().flush();
    };
    pair_here(p, client, paint, POLL, WINDOW, &say).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::{Stub, json_answer};
    use serde_json::{Value, json};
    use std::sync::Mutex;

    struct Scratch(String);
    impl Scratch {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!("canopy-helper-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p.to_string_lossy().into_owned())
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn caller(dir: &Scratch) -> Caller {
        Caller {
            config_dir: format!("{}/cfg", dir.0),
            ..Default::default()
        }
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_backend_is_the_flag_else_an_origin_in_canopy_backend_else_the_local_one() {
        let d = Scratch::new();
        let c = caller(&d);
        let backend = |a: &[&str], env: Option<&str>| parse(&args(a), env, &c).map(|p| p.backend);
        assert_eq!(backend(&["helper"], None), Ok(LOCAL.to_string()));
        assert_eq!(
            backend(&["helper"], Some("mini")),
            Ok(LOCAL.to_string()),
            "a backend's name is not an origin"
        );
        assert_eq!(
            backend(&["helper"], Some("http://mini:7850")),
            Ok("http://mini:7850".into())
        );
        assert_eq!(
            backend(
                &["helper", "--backend", "https://b"],
                Some("http://mini:7850")
            ),
            Ok("https://b".into())
        );
        assert_eq!(
            backend(&["helper", "--backend"], None),
            Ok(LOCAL.to_string()),
            "a --backend with nothing after it is left, as opt() leaves it"
        );
        assert_eq!(
            backend(&["helper", "--backend", "ftp://x"], None),
            Err("--backend must be an http(s) origin, got ftp://x".into())
        );
        assert_eq!(
            backend(&["helper", "--backend", "HTTP://x"], None),
            Err("--backend must be an http(s) origin, got HTTP://x".into())
        );
        assert_eq!(
            backend(&["helper", "--backend", "http://"], None),
            Err("Invalid URL".into())
        );
        assert_eq!(
            backend(&["helper", "--token", "--backend", "x"], None),
            Ok(LOCAL.to_string()),
            "--token takes the next word first, whatever it is"
        );
    }

    #[test]
    fn openers_are_checked_one_by_one_and_blanks_skipped() {
        let d = Scratch::new();
        let c = caller(&d);
        let p = parse(
            &args(&[
                "helper",
                "--openers",
                " kitty,,agent ",
                "--backend",
                "http://b:1",
            ]),
            None,
            &c,
        )
        .unwrap();
        assert_eq!(
            p.openers,
            Some(vec!["kitty".to_string(), "agent".to_string()])
        );
        assert_eq!(p.token_path, format!("{}/cfg/token-helper-b-1", d.0));
        assert_eq!(
            parse(&args(&["helper", "--openers", "kitty,emacs"]), None, &c),
            Err("unknown opener in --openers: emacs".into())
        );
        assert_eq!(
            parse(
                &args(&["helper", "--openers", "emacs", "--backend", "ftp://x"]),
                None,
                &c
            ),
            Err("--backend must be an http(s) origin, got ftp://x".into()),
            "the backend is checked first"
        );
    }

    #[test]
    fn pairing_here_hands_over_the_rest_without_pair_and_its_code() {
        let d = Scratch::new();
        let c = caller(&d);
        let a = args(&[
            "helper",
            "--pair",
            "--code",
            "ABC123",
            "--backend",
            "http://b:1",
            "--name",
            "lap",
            "--token",
            "t",
        ]);
        let p = parse(&a, None, &c).unwrap();
        assert!(p.pair);
        assert_eq!(p.code.as_deref(), Some("ABC123"));
        assert_eq!(p.name.as_deref(), Some("lap"));
        assert_eq!(
            plan(&a, &p, None, &c),
            Plan {
                pair: true,
                delegate: args(&[
                    "helper",
                    "--backend",
                    "http://b:1",
                    "--name",
                    "lap",
                    "--token",
                    "t"
                ]),
            }
        );
        let plain = args(&["helper", "--code", "X", "--backend", "http://b:1"]);
        let p = parse(&plain, None, &c).unwrap();
        assert_eq!(
            plan(&plain, &p, None, &c),
            Plan {
                pair: false,
                delegate: plain.clone()
            },
            "no --pair, nothing paired here and every word goes over"
        );
        // --code reads "--pair" as its value, so nothing pairs on either side
        let odd = args(&["helper", "--code", "--pair", "--backend", "http://b:1"]);
        let p = parse(&odd, None, &c).unwrap();
        assert!(!p.pair);
        assert!(!plan(&odd, &p, None, &c).pair);
        // --name reads --pair as the name once --backend is out
        let named = args(&["helper", "--name", "--pair", "--backend", "http://b:1"]);
        let p = parse(&named, None, &c).unwrap();
        assert_eq!((p.name.as_deref(), p.pair), (Some("--pair"), false));
    }

    #[test]
    fn a_reparse_that_would_differ_leaves_the_pairing_to_typescript() {
        let d = Scratch::new();
        let c = caller(&d);
        let a = args(&[
            "helper",
            "--pair",
            "--backend",
            "http://b:1",
            "--name",
            "lap",
        ]);
        let mut p = parse(&a, None, &c).unwrap();
        assert_eq!(
            plan(&a, &p, None, &c),
            Plan {
                pair: true,
                delegate: args(&["helper", "--backend", "http://b:1", "--name", "lap"]),
            }
        );
        // were the words taken out to leave the name without its flag, the
        // TypeScript would read the rest another way: it pairs instead
        p.pair_words = vec![1, 4];
        assert_eq!(
            plan(&a, &p, None, &c),
            Plan {
                pair: false,
                delegate: a.clone()
            }
        );
    }

    /// auth.test.ts: "canopy auth login sends cli, and canopy helper --pair
    /// sends helper" (the helper's half): a backend that refuses every pair
    /// ends the command at once.
    #[tokio::test]
    async fn canopy_helper_pair_sends_helper() {
        let stub = Stub::start(|_| json_answer(429, json!({"error": "no"}))).await;
        let d = Scratch::new();
        let c = caller(&d);
        let p = parse(
            &args(&["helper", "--pair", "--backend", &stub.url]),
            None,
            &c,
        )
        .unwrap();
        let lines = Mutex::new(Vec::<String>::new());
        let say = |l: &str| lines.lock().unwrap().push(l.to_string());
        let r = pair_here(
            &p,
            &Client::new(c.clone()),
            Paint::default(),
            POLL,
            WINDOW,
            &say,
        )
        .await;
        assert_eq!(r, Err("pairing failed: no".into()));
        let seen = stub.seen.lock().unwrap().clone();
        let body: Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(body["kind"], "helper");
        assert!(body["label"].as_str().unwrap().starts_with("helper "));
        assert!(lines.into_inner().unwrap().is_empty());
        assert!(!std::path::Path::new(&p.token_path).exists());
    }

    #[tokio::test]
    async fn an_approved_pair_keeps_the_helper_token_0600_and_says_where() {
        use std::os::unix::fs::PermissionsExt;
        let claims = std::sync::Arc::new(Mutex::new(0));
        let n = claims.clone();
        let stub = Stub::start(move |s| match s.path.as_str() {
            "/api/auth/pair" => json_answer(200, json!({"id": "p1", "code": "QX7", "secret": "s"})),
            "/api/auth/first" => json_answer(200, json!({"ok": true})),
            _ => {
                let mut k = n.lock().unwrap();
                *k += 1;
                if *k == 1 {
                    json_answer(200, json!({"waiting": true}))
                } else {
                    json_answer(200, json!({"token": "tok-1"}))
                }
            }
        })
        .await;
        let d = Scratch::new();
        let c = caller(&d);
        let p = parse(
            &args(&[
                "helper",
                "--pair",
                "--code",
                "abc123",
                "--backend",
                &stub.url,
            ]),
            None,
            &c,
        )
        .unwrap();
        let lines = Mutex::new(Vec::<String>::new());
        let say = |l: &str| lines.lock().unwrap().push(l.to_string());
        let r = pair_here(
            &p,
            &Client::new(c.clone()),
            Paint::default(),
            Duration::from_millis(10),
            WINDOW,
            &say,
        )
        .await;
        assert_eq!(r, Ok(()));
        assert_eq!(
            stub.paths(),
            [
                "/api/auth/pair",
                "/api/auth/first",
                "/api/auth/claim",
                "/api/auth/claim"
            ]
        );
        let first: Value = serde_json::from_str(&stub.seen.lock().unwrap()[1].body).unwrap();
        assert_eq!(first, json!({"id": "p1", "code": "abc123"}));
        assert_eq!(std::fs::read_to_string(&p.token_path).unwrap(), "tok-1\n");
        let mode = std::fs::metadata(&p.token_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let lines = lines.into_inner().unwrap();
        let words: Vec<&str> = lines.iter().map(|l| l.split_once(' ').unwrap().1).collect();
        let words: Vec<&str> = words
            .iter()
            .map(|l| {
                l.trim_start_matches(|c: char| c.is_ascii_digit() || c == ':')
                    .trim_start()
            })
            .map(|l| l.strip_prefix("AM ").or(l.strip_prefix("PM ")).unwrap_or(l))
            .collect();
        assert_eq!(
            words,
            [
                "pair code QX7: approve it in the canopy inbox, or pass the first code from the server log with --code",
                &format!("paired (helper token kept in {})", p.token_path),
            ]
        );
    }

    #[tokio::test]
    async fn a_denied_pair_and_a_window_that_runs_out_fail() {
        let stub = Stub::start(|s| match s.path.as_str() {
            "/api/auth/pair" => json_answer(200, json!({"id": "p1", "secret": "s"})),
            _ => json_answer(200, json!({"waiting": true})),
        })
        .await;
        let d = Scratch::new();
        let c = caller(&d);
        let p = parse(
            &args(&["helper", "--pair", "--backend", &stub.url]),
            None,
            &c,
        )
        .unwrap();
        let lines = Mutex::new(Vec::<String>::new());
        let say = |l: &str| lines.lock().unwrap().push(l.to_string());
        let r = pair_here(
            &p,
            &Client::new(c.clone()),
            Paint::default(),
            Duration::from_millis(5),
            Duration::from_millis(30),
            &say,
        )
        .await;
        assert_eq!(
            r,
            Err("pairing failed: timed out waiting for approval".into())
        );
        assert!(lines.into_inner().unwrap()[0].ends_with("pair code ?: approve it in the canopy inbox, or pass the first code from the server log with --code"));
        let denied = Stub::start(|s| match s.path.as_str() {
            "/api/auth/pair" => json_answer(200, json!({"id": "p1", "secret": "s"})),
            _ => json_answer(404, json!({"error": "no such pair request"})),
        })
        .await;
        let p = parse(
            &args(&["helper", "--pair", "--backend", &denied.url]),
            None,
            &c,
        )
        .unwrap();
        let r = pair_here(
            &p,
            &Client::new(c.clone()),
            Paint::default(),
            POLL,
            WINDOW,
            &|_| {},
        )
        .await;
        assert_eq!(r, Err("pairing failed: no such pair request".into()));
        let redirect = Stub::start(|_| {
            (
                302,
                vec![("location".into(), "/login".into())],
                String::new(),
            )
        })
        .await;
        let p = parse(
            &args(&["helper", "--pair", "--backend", &redirect.url]),
            None,
            &c,
        )
        .unwrap();
        let r = pair_here(
            &p,
            &Client::new(c.clone()),
            Paint::default(),
            POLL,
            WINDOW,
            &|_| {},
        )
        .await;
        assert_eq!(
            r,
            Err(format!(
                "pairing failed: {} sent a redirect to a sign-in; point --backend at canopy itself",
                redirect.url
            ))
        );
    }
}
