//! A shell inside canopy, the pure half of `src/core/term.ts`: the size a
//! pty takes from the query string or a resize message, what the pty runs
//! to land at a repo, the browser's name for a shell, where it was opened,
//! the scrollback a plain pty keeps for the next socket, whether an input
//! frame is a person at the keyboard, and the environment a shell gets.
//! `shell_handle` is `shellHandle` from `src/core/tailchan.ts`, the one
//! piece of that module a shell needs.
//!
//! The pty itself (`spawnOnPty`, `startTerm`) is canopy-server's `pty.rs`.

use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

use crate::host::{parse_locator, shell_quote};

/// A pty's size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

/// what a pty is when the browser has not said
pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;
/// the bounds a browser may ask for
pub const MIN_DIM: u16 = 2;
pub const MAX_DIM: u16 = 500;

/// `Number(s)` (`js::number_of`, the one copy).
pub use crate::js::number_of as js_number;

/// One dimension as the TS's `dim` reads it: a string through `Number`, a
/// number as it is, anything else (or not finite) the fallback, and the
/// rest floored and clamped to the bounds.
fn dim(n: Option<f64>, fallback: u16) -> u16 {
    match n {
        Some(n) if n.is_finite() => n.floor().clamp(f64::from(MIN_DIM), f64::from(MAX_DIM)) as u16,
        _ => fallback,
    }
}

/// A dimension off a query string: absent is unsaid, a string is `Number`.
fn query_dim(v: Option<&str>) -> Option<f64> {
    v.map(js_number)
}

/// A dimension off a JSON message: a number, or a string read as one.
fn json_dim(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => Some(js_number(s)),
        _ => None,
    }
}

/// A size from the query string (`termSize`): anything missing or absurd
/// falls back to the default, and the rest is clamped to the bounds.
pub fn term_size(cols: Option<&str>, rows: Option<&str>) -> TermSize {
    TermSize {
        cols: dim(query_dim(cols), DEFAULT_COLS),
        rows: dim(query_dim(rows), DEFAULT_ROWS),
    }
}

/// The same off JSON values (a resize message, a restore's body).
pub fn term_size_json(cols: Option<&Value>, rows: Option<&Value>) -> TermSize {
    TermSize {
        cols: dim(json_dim(cols), DEFAULT_COLS),
        rows: dim(json_dim(rows), DEFAULT_ROWS),
    }
}

/// The ssh session a terminal tab opens for a folder on another host
/// (`sshSessionArgs(host, path, "shell")` in core/openers.ts).
pub fn ssh_shell_args(host: &str, path: &str) -> Vec<String> {
    vec![
        "ssh".into(),
        "-t".into(),
        "--".into(),
        host.into(),
        format!("cd {} && exec \"$SHELL\" -l", shell_quote(path)),
    ]
}

/// What the pty runs to land at the repo (`shellArgs`): the login shell for
/// a folder here, the same ssh session a terminal tab would open for a
/// folder elsewhere.
pub fn shell_args(locator: &str, shell: &str) -> Vec<String> {
    let l = parse_locator(locator);
    match l.host {
        None => vec![shell.into(), "-l".into(), "-i".into()],
        Some(host) => ssh_shell_args(&host, &l.path),
    }
}

/// What the browser names a shell: 32 hex digits of its own randomness.
pub fn is_term_id(v: &str) -> bool {
    v.len() == 32 && v.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Where a shell was opened, off the socket's query; the strip when unsaid.
pub fn term_place(v: Option<&str>) -> &'static str {
    if v == Some("panel") { "panel" } else { "strip" }
}

/// what a shell keeps of its output for the next socket, in bytes
pub const SCROLLBACK_CAP: usize = 512 * 1024;

/// The last `cap` bytes a pty wrote. Chunks go in whole and the oldest go
/// out whole once the total is over the cap, so a replay may open
/// mid-escape, which xterm reads past. One chunk over the cap on its own
/// keeps its tail.
#[derive(Debug, Clone)]
pub struct Scrollback {
    cap: usize,
    chunks: std::collections::VecDeque<Vec<u8>>,
    total: usize,
}

impl Default for Scrollback {
    fn default() -> Self {
        Scrollback::new(SCROLLBACK_CAP)
    }
}

impl Scrollback {
    pub fn new(cap: usize) -> Scrollback {
        Scrollback {
            cap,
            chunks: std::collections::VecDeque::new(),
            total: 0,
        }
    }

    pub fn size(&self) -> usize {
        self.total
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        if chunk.len() >= self.cap {
            self.chunks.clear();
            self.chunks
                .push_back(chunk[chunk.len() - self.cap..].to_vec());
            self.total = self.cap;
            return;
        }
        self.chunks.push_back(chunk.to_vec());
        self.total += chunk.len();
        while self.total > self.cap {
            let Some(gone) = self.chunks.pop_front() else {
                break;
            };
            self.total -= gone.len();
        }
    }

    /// everything kept, oldest first, as one buffer
    pub fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total);
        for c in &self.chunks {
            out.extend_from_slice(c);
        }
        out
    }
}

/// Replies a browser terminal sends on its own, answering a program's query
/// rather than a person typing: device attributes, a cursor position report
/// and its DEC form, the status report, a mode report, focus in and out,
/// and OSC and DCS answers.
static REPLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\x1b\[[?>=]?[0-9;]*c",
        r"|\x1b\[[0-9]+;[0-9]+R",
        r"|\x1b\[\?[0-9]+;[0-9]+(?:;[0-9]+)?R",
        r"|\x1b\[0n",
        r"|\x1b\[\??[0-9;]*\$y",
        r"|\x1b\[[IO]",
        r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)",
        r"|\x1bP[^\x1b]*\x1b\\",
    ))
    .unwrap()
});

/// Whether an input frame from a browser is a person at the keyboard (or
/// the mouse) rather than only the terminal answering a query: what makes a
/// shell "watched".
pub fn is_keystroke(data: &[u8]) -> bool {
    if data.is_empty() {
        return false;
    }
    let text = String::from_utf8_lossy(data);
    !REPLY.replace_all(&text, "").is_empty()
}

/// The one text message the browser sends, `{"resize":{"cols","rows"}}`,
/// as the size it asks for. Anything else is None and ignored.
pub fn parse_term_message(text: &str) -> Option<TermSize> {
    let v: Value = serde_json::from_str(text).ok()?;
    let r = v.as_object()?.get("resize")?;
    let r = r.as_object()?;
    Some(term_size_json(r.get("cols"), r.get("rows")))
}

/// Canopy's own secrets, which no shell, run or tmux server it starts gets
/// (`SECRET_ENV` in core/envnames.ts).
pub const SECRET_ENV: [&str; 6] = [
    "CANOPY_VAULT_TOKEN",
    "CANOPY_TRANSCRIBE_KEY",
    "VERCEL_TOKEN",
    "FIREBASE_TOKEN",
    "CANOPY_VOICE_KEY",
    "CANOPY_LIVE_KEY",
];

/// `SECRET_ENV` and the answer token (`PRIVATE_ENV`).
pub const PRIVATE_ENV: [&str; 7] = [
    "CANOPY_TAILCHAN_ANSWER_TOKEN",
    "CANOPY_VAULT_TOKEN",
    "CANOPY_TRANSCRIBE_KEY",
    "VERCEL_TOKEN",
    "FIREBASE_TOKEN",
    "CANOPY_VOICE_KEY",
    "CANOPY_LIVE_KEY",
];

/// What canopy tells each shell and run about itself. A canopy started
/// inside one of its own shells finds the outer shell's already set, and
/// must not hand them on (`INHERITED_ENV`).
pub const INHERITED_ENV: [&str; 7] = [
    "CANOPY_TERM",
    "CANOPY_API",
    "CANOPY_REPO",
    "CANOPY_BACKEND",
    "CANOPY_RUN",
    "CANOPY_TOKEN",
    "TAILCHAN_AS",
];

/// a trigger rule's secrets carry this prefix and leave the server's env at
/// its start (`TRIGGER_ENV_PREFIX` in core/envnames.ts)
pub const TRIGGER_ENV_PREFIX: &str = "CANOPY_TRIGGER_";

/// The pty's environment (`termEnv`): the base, told it is a color
/// terminal, with canopy's own secrets left out.
pub fn term_env(base: &[(String, String)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .iter()
        .filter(|(k, _)| !PRIVATE_ENV.contains(&k.as_str()) && k != "TERM" && k != "COLORTERM")
        .cloned()
        .collect();
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    env
}

/// The tailchan handle a shell runs under (`shellHandle` in
/// core/tailchan.ts): the repo's name slugged, then four hex of the shell.
pub fn shell_handle(repo_name: &str, term_id: &str) -> String {
    let lower = repo_name.to_lowercase();
    let mut slug = String::new();
    let mut gap = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            gap = false;
        } else if !gap {
            slug.push('-');
            gap = true;
        }
    }
    let slug: String = slug
        .trim_start_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .chars()
        .take(30)
        .collect();
    let slug = slug.trim_end_matches(['-', '.', '_']);
    let four: String = term_id.chars().take(4).collect::<String>().to_lowercase();
    format!("{}-{four}", if slug.is_empty() { "shell" } else { slug })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn size(cols: u16, rows: u16) -> TermSize {
        TermSize { cols, rows }
    }

    // termSize
    #[test]
    fn defaults_when_nothing_is_given() {
        assert_eq!(term_size(None, None), size(80, 24));
        assert_eq!(term_size_json(None, Some(&Value::Null)), size(80, 24));
    }

    #[test]
    fn reads_query_string_numbers_and_floors_them() {
        assert_eq!(term_size(Some("132"), Some("41.9")), size(132, 41));
    }

    #[test]
    fn clamps_the_absurd_and_rejects_the_unparseable() {
        assert_eq!(
            term_size_json(Some(&json!(0)), Some(&json!(10_000))),
            size(MIN_DIM, MAX_DIM)
        );
        assert_eq!(term_size(Some("wide"), Some("NaN")), size(80, 24));
        // Number("") is 0, which clamps up; a bool is no number at all
        assert_eq!(term_size(Some(""), Some(" 0x20 ")), size(2, 32));
        assert_eq!(
            term_size_json(Some(&json!(true)), Some(&json!("1e2"))),
            size(80, 100)
        );
    }

    // shellArgs
    #[test]
    fn a_folder_here_gets_the_login_interactive_shell() {
        assert_eq!(
            shell_args("/Users/me/dev/app", "/bin/zsh"),
            ["/bin/zsh", "-l", "-i"]
        );
    }

    #[test]
    fn a_folder_elsewhere_gets_the_ssh_session_a_terminal_tab_would() {
        let args = shell_args("ssh://mini/home/me/app", "/bin/zsh");
        assert_eq!(args[..4], ["ssh", "-t", "--", "mini"]);
        assert!(args[4].contains("cd '/home/me/app' && "));
        assert!(args[4].contains("exec \"$SHELL\" -l"));
    }

    // parseTermMessage
    #[test]
    fn a_resize() {
        assert_eq!(
            parse_term_message(r#"{"resize":{"cols":100,"rows":30}}"#),
            Some(size(100, 30))
        );
    }

    #[test]
    fn anything_else_is_ignored() {
        assert_eq!(parse_term_message("not json"), None);
        assert_eq!(parse_term_message("null"), None);
        assert_eq!(parse_term_message(r#"{"input":"ls"}"#), None);
        assert_eq!(parse_term_message(r#"{"resize":"big"}"#), None);
    }

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    // termEnv
    #[test]
    fn keeps_the_base_drops_the_undefined_and_declares_a_color_terminal() {
        assert_eq!(
            term_env(&pairs(&[("HOME", "/Users/me"), ("TERM", "dumb")])),
            pairs(&[
                ("HOME", "/Users/me"),
                ("TERM", "xterm-256color"),
                ("COLORTERM", "truecolor")
            ])
        );
    }

    #[test]
    fn term_env_keeps_canopys_answer_token_out_of_a_shell() {
        let want = pairs(&[
            ("HOME", "/h"),
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
        ]);
        assert_eq!(
            term_env(&pairs(&[
                ("CANOPY_TAILCHAN_ANSWER_TOKEN", "s"),
                ("HOME", "/h")
            ])),
            want
        );
        // and the incubator's vault token and speech model key
        assert_eq!(
            term_env(&pairs(&[
                ("CANOPY_VAULT_TOKEN", "v"),
                ("CANOPY_TRANSCRIBE_KEY", "k"),
                ("HOME", "/h")
            ])),
            want
        );
    }

    // isTermId
    #[test]
    fn thirty_two_hex_digits_nothing_else() {
        assert!(is_term_id("0123456789abcdef0123456789abcdef"));
        assert!(!is_term_id("0123456789ABCDEF0123456789abcdef"));
        assert!(!is_term_id("0123456789abcdef"));
        assert!(!is_term_id("t12"));
    }

    // termPlace
    #[test]
    fn the_panel_when_asked_the_strip_otherwise() {
        assert_eq!(term_place(Some("panel")), "panel");
        assert_eq!(term_place(Some("strip")), "strip");
        assert_eq!(term_place(Some("window")), "strip");
        assert_eq!(term_place(None), "strip");
    }

    // Scrollback
    #[test]
    fn keeps_what_it_is_given_in_order() {
        let mut sb = Scrollback::new(100);
        sb.push(b"one ");
        sb.push(b"two ");
        sb.push(b"three");
        assert_eq!(sb.bytes(), b"one two three");
        assert_eq!(sb.size(), 13);
    }

    #[test]
    fn drops_the_oldest_chunks_whole_once_over_the_cap() {
        let mut sb = Scrollback::new(10);
        sb.push(b"aaaa");
        sb.push(b"bbbb");
        sb.push(b"cccc");
        assert_eq!(sb.bytes(), b"bbbbcccc");
        assert_eq!(sb.size(), 8);
    }

    #[test]
    fn one_chunk_over_the_cap_on_its_own_keeps_its_tail() {
        let mut sb = Scrollback::new(4);
        sb.push(b"xx");
        sb.push(b"abcdefgh");
        assert_eq!(sb.bytes(), b"efgh");
        // the oldest chunk goes out whole, so a push over the cap leaves the new one
        sb.push(b"i");
        assert_eq!(sb.bytes(), b"i");
    }

    #[test]
    fn empty_chunks_and_an_empty_buffer() {
        let mut sb = Scrollback::new(4);
        sb.push(b"");
        assert_eq!(sb.size(), 0);
        assert_eq!(sb.bytes(), b"");
    }

    // isKeystroke
    #[test]
    fn typing_keys_and_the_mouse_are_a_person() {
        for k in [
            "a",
            "ls\r",
            "\x1b[A",
            "\x03",
            "\x1b[<0;10;5M",
            "\x1b[?1;2cx",
        ] {
            assert!(is_keystroke(k.as_bytes()), "{k:?}");
        }
    }

    #[test]
    fn a_terminal_answering_a_query_is_not() {
        for r in [
            "\x1b[?1;2c",
            "\x1b[>0;276;0c",
            "\x1b[12;40R",
            "\x1b[?2004;2$y",
            "\x1b[I",
            "\x1b[O",
            "\x1b]11;rgb:1e1e/1e1e/1e1e\x07",
            "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            "\x1bP>|xterm.js(6.0.0)\x1b\\",
            "\x1b[?1;2c\x1b[I",
            "",
        ] {
            assert!(!is_keystroke(r.as_bytes()), "{r:?}");
        }
    }

    #[test]
    fn xterm_6s_status_report_and_its_dec_cursor_report_are_the_terminal_too() {
        for r in [
            "\x1b[0n",
            "\x1b[?12;40R",
            "\x1b[?12;40;1R",
            "\x1b[0n\x1b[?3;1R\x1b[I",
        ] {
            assert!(!is_keystroke(r.as_bytes()), "{r:?}");
        }
    }

    // shellHandle (core/tailchan.test.ts)
    const HANDLE_ID: &str = "4f763a90aa00bb11cc22dd33ee44ff55";

    #[test]
    fn the_repo_slugged_then_four_hex_of_the_shell() {
        assert_eq!(shell_handle("canopy", HANDLE_ID), "canopy-4f76");
        assert_eq!(shell_handle("My App (v2)", HANDLE_ID), "my-app-v2-4f76");
        assert_eq!(shell_handle("__init", HANDLE_ID), "init-4f76");
    }

    #[test]
    fn fits_the_brokers_40_and_never_starts_or_ends_on_a_separator() {
        let h = shell_handle(&format!("{}-bbbbbbbbbb", "a".repeat(29)), HANDLE_ID);
        assert!(h.len() <= 40);
        assert!(
            h.chars()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        );
        assert_eq!(
            shell_handle(&format!("{}-b", "a".repeat(29)), HANDLE_ID),
            format!("{}-4f76", "a".repeat(29))
        );
        assert_eq!(shell_handle("!!!", HANDLE_ID), "shell-4f76");
    }

    #[test]
    fn number_reads_strings_as_javascript_does() {
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number("0b11"), 3.0);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert!(js_number("inf").is_nan());
        assert!(js_number("12px").is_nan());
        assert!(js_number("-0x10").is_nan());
        assert_eq!(js_number(".5"), 0.5);
    }
}
