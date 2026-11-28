//! The clipboard's words and checks (`src/core/clips.ts`), the parts the
//! CLI's `canopy clip` prints or refuses with: the secret shapes
//! (`looksSecret`, `looksSecretFile`), what a pipe's bytes are (`textHead`,
//! `sniffType`), what a clip is (`clipKind`, `fileKind`, `kindOf`, `clipKey`),
//! the newest-first order (`sortClips`) and the words of a line (`clipLine`,
//! `agoWord`, `sizeWord`). Clips are the JSON the backend sends. The record's
//! parsing, keeping and pruning stay in the TypeScript server.
//!
//! The patterns follow JavaScript's regex rules, not Rust's: `\b` and `\w`
//! are ASCII there, `\s` is JavaScript's whitespace (`JS_S`), `/i` folds
//! ASCII letters only, and the lookaheads are written out by hand, since
//! the regex crate has none.

use crate::js::to_fixed;
use crate::pathx::{JS_S, js_len, js_squash_ws, js_trim, js_trim_end, js_ws};
use crate::store::js_number;
use regex::Regex;
use serde_json::Value;
use std::cmp::Ordering;
use std::sync::LazyLock;

/// `CLIP_FILE_MAX`: the largest file a clip keeps.
pub const CLIP_FILE_MAX: usize = 25 * 1024 * 1024;

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("JS_S", JS_S)).expect("a clip pattern")
}

/// `SECRET_SHAPES`. JavaScript's `\b` is ASCII, as `(?-u:\b)` is; its
/// multiline `^` holds after any line terminator, which the last pattern
/// matches by eating one.
static SECRET_SHAPES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let not_s = r#"(?:[^\s\x{FEFF}"']|\x{85})"#;
    let blank = r"[[\s\x{FEFF}]&&[^\x{85}\n]]";
    [
        r"AGE-SECRET-KEY-1[0-9A-Z]{20,}".to_string(),
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----".into(),
        r"(?-u:\b)eyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}".into(),
        r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{30,}".into(),
        r"(?-u:\b)github_pat_[A-Za-z0-9_]{30,}".into(),
        r"(?-u:\b)sk-ant-[A-Za-z0-9_-]{20,}".into(),
        r"(?-u:\b)sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}".into(),
        r"(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)".into(),
        r"(?-u:\b)xox[abprs]-[A-Za-z0-9-]{10,}".into(),
        r"(?-u:\b)glpat-[A-Za-z0-9_-]{20,}".into(),
        r"(?-u:\b)AIza[0-9A-Za-z_-]{35}".into(),
        r"(?-u:\b)npm_[A-Za-z0-9]{36}(?-u:\b)".into(),
        r"(?-u:\b)[rs]k_live_[A-Za-z0-9]{20,}".into(),
        r"(?-u:\b)Bearer(?:JS_S)+[A-Za-z0-9._~+/=-]{20,}".into(),
        format!(
            r#"(?:\A|[\n\r\x{{2028}}\x{{2029}}]){blank}*(?:export{blank}+)?[A-Z0-9_]{{0,80}}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Z0-9_]{{0,80}}{blank}*={blank}*["']?{not_s}{{8,}}"#
        ),
    ]
    .iter()
    .map(|p| re(p))
    .collect()
});

/// `looksSecret()`: text carries something shaped like a key or a
/// password, which is never kept.
pub fn looks_secret(text: &str) -> bool {
    SECRET_SHAPES.iter().any(|r| r.is_match(text))
}

/// JavaScript's line terminators, which `.` never matches.
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `s` starts with `prefix`, ASCII letters folded as `/i` folds them.
fn starts_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

fn ends_ci(s: &str, suffix: &str) -> bool {
    s.len() >= suffix.len()
        && s.is_char_boundary(s.len() - suffix.len())
        && s[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// `looksSecretFile()`: a file's name says it holds a key or a password:
/// an ssh identity (not its .pub), a PEM or key file, a PKCS#12 bundle, a
/// KeePass database, .env.
pub fn looks_secret_file(name: &str) -> bool {
    // /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?!.*\.pub$)/i: the optional
    // _sk changes nothing, since a .pub ending is seen from either place
    let identity = starts_ci(name, "id_").and_then(|rest| {
        ["rsa", "dsa", "ecdsa", "ed25519"]
            .iter()
            .find_map(|k| starts_ci(rest, k))
    });
    if let Some(rest) = identity {
        let pub_key = !rest.chars().any(line_end) && ends_ci(rest, ".pub");
        if !pub_key {
            return true;
        }
    }
    // /\.(?:pem|key|p12|pfx|kdbx|keystore|jks)$/i
    if [".pem", ".key", ".p12", ".pfx", ".kdbx", ".keystore", ".jks"]
        .iter()
        .any(|e| ends_ci(name, e))
    {
        return true;
    }
    // /^\.env(?:\..*)?$/i
    match starts_ci(name, ".env") {
        Some("") => true,
        Some(rest) => rest.starts_with('.') && !rest.chars().any(line_end),
        None => false,
    }
}

/// `new TextDecoder().decode(bytes)`: UTF-8 with each bad sequence as one
/// U+FFFD, a leading byte-order mark dropped.
pub fn decode_utf8(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(body).into_owned()
}

/// `textHead()`: the first 256 KB of a file as text; None when it is not
/// text (a NUL byte, or more than a few bytes that are not UTF-8).
pub fn text_head(bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(256 * 1024)];
    if head.contains(&0) {
        return None;
    }
    let text = decode_utf8(head);
    // a cut multi-byte character at the end makes one replacement; more is not text
    let bad = text.chars().filter(|c| *c == '\u{FFFD}').count();
    (bad <= 4).then_some(text)
}

/// `sniffType()`: the type a few bytes say a file is, as (type, ext).
pub fn sniff_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    let at = |i: usize, want: &[u8]| bytes.get(i..i + want.len()) == Some(want);
    if at(0, &[0x89, 0x50, 0x4e, 0x47]) {
        return Some(("image/png", "png"));
    }
    if at(0, &[0xff, 0xd8, 0xff]) {
        return Some(("image/jpeg", "jpg"));
    }
    if at(0, b"GIF8") {
        return Some(("image/gif", "gif"));
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return Some(("image/webp", "webp"));
    }
    if at(0, b"%PDF") {
        return Some(("application/pdf", "pdf"));
    }
    if at(0, &[0x50, 0x4b, 0x03, 0x04]) {
        return Some(("application/zip", "zip"));
    }
    if at(0, &[0x1f, 0x8b]) {
        return Some(("application/gzip", "gz"));
    }
    None
}

/// `sizeWord()`: "512 B", "14 KB", "2.4 MB".
pub fn size_word(n: f64) -> String {
    if n < 1024.0 {
        return format!("{} B", js_number(n));
    }
    if n < 1024.0 * 1024.0 {
        return format!("{} KB", js_number((n / 1024.0).round()));
    }
    let mb = n / (1024.0 * 1024.0);
    if mb < 10.0 {
        format!("{} MB", to_fixed(mb, 1))
    } else {
        format!("{} MB", js_number(mb.round()))
    }
}

/// A clip's file, when it has one (`c.file` is truthy).
fn file_of(c: &Value) -> Option<&Value> {
    c.get("file").filter(|f| crate::js::truthy(Some(f)))
}

/// `clipKey()`: what a clip is the same as, its bytes for a file, else its
/// text.
pub fn clip_key(c: &Value) -> String {
    match file_of(c) {
        Some(f) => format!("file:{}", crate::js::field(f, "sha")),
        None => crate::js::field(c, "text"),
    }
}

/// `sortClips()`'s order: the newest copy first, a tie to the one kept
/// first. Stable, as JavaScript's sort is.
pub fn clip_order(a: &Value, b: &Value) -> Ordering {
    let n = |c: &Value, k: &str| c.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let by = n(b, "at") - n(a, "at");
    let d = if by != 0.0 && !by.is_nan() {
        by
    } else {
        n(b, "createdAt") - n(a, "createdAt")
    };
    // a NaN from the comparator counts as a tie
    if d > 0.0 {
        Ordering::Greater
    } else if d < 0.0 {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// `fileKind()`: a picture, a PDF, a video, a sound, or any other file.
pub fn file_kind(t: &str) -> &'static str {
    if t.starts_with("image/") {
        "image"
    } else if t == "application/pdf" {
        "pdf"
    } else if t.starts_with("video/") {
        "video"
    } else if t.starts_with("audio/") {
        "audio"
    } else {
        "file"
    }
}

/// `kindOf()`: its file's kind, else its text's.
pub fn kind_of(c: &Value) -> &'static str {
    match file_of(c) {
        Some(f) => file_kind(&crate::js::field(f, "type")),
        None => clip_kind(&crate::js::field(c, "text")),
    }
}

static COLOR_HEX: LazyLock<Regex> =
    LazyLock::new(|| re(r"^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$"));
static COLOR_FN: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[-+0-9.%,/]|JS_S|deg|grad|rad|turn|none){1,80}\)$",
    )
});
static LINK: LazyLock<Regex> = LazyLock::new(|| re(r"^https?://(?:[^\s\x{FEFF}]|\x{85})+$"));
static ABS_PATH: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:~|\.{1,2})?/[^\n\x00]*$"));
static REL_PATH: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]+)+/?$"));
static WIN_PATH: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z]:\\"));
static CODE_PUNCT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"[{};](?:JS_S)*$|=>|\(\)|^(?:JS_S)*(?:import|export|const|let|function|def|class|return|if|for)(?-u:\b)",
    )
});
static INDENT: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:JS_S){2,}|\t"));

/// the words that open a shell command often enough to call a line one
const COMMAND_WORDS: &[&str] = &[
    "awk",
    "brew",
    "bun",
    "bunx",
    "canopy",
    "cargo",
    "cat",
    "cd",
    "chmod",
    "claude",
    "code",
    "codex",
    "cp",
    "curl",
    "deno",
    "docker",
    "echo",
    "export",
    "find",
    "gh",
    "git",
    "go",
    "grep",
    "head",
    "journalctl",
    "just",
    "kill",
    "kubectl",
    "ls",
    "make",
    "mise",
    "mkdir",
    "mv",
    "node",
    "npm",
    "npx",
    "open",
    "pacman",
    "pnpm",
    "python",
    "python3",
    "rg",
    "rm",
    "rsync",
    "scp",
    "sed",
    "ssh",
    "sudo",
    "systemctl",
    "tail",
    "tailscale",
    "tmux",
    "touch",
    "uv",
    "uvx",
    "vim",
    "wget",
    "yarn",
];

/// `HASH`: seven to 64 lowercase hex characters, at least one a digit and
/// one a letter.
fn is_hash(t: &str) -> bool {
    let hex = t
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    hex && (7..=64).contains(&t.len())
        && t.bytes().any(|b| b.is_ascii_digit())
        && t.bytes().any(|b| b.is_ascii_alphabetic())
}

/// `isJson()`: a JSON parse of `t` comes back as an object or an array.
fn is_json(t: &str) -> bool {
    if js_len(t) > 200_000 {
        return false;
    }
    let wrapped =
        (t.starts_with('{') && t.ends_with('}')) || (t.starts_with('[') && t.ends_with(']'));
    wrapped && serde_json::from_str::<Value>(t).is_ok()
}

/// `codey()`: a third of the lines that hold anything are indented or carry
/// code's punctuation.
fn codey(lines: &[&str]) -> bool {
    let full: Vec<&&str> = lines.iter().filter(|l| !js_trim(l).is_empty()).collect();
    if full.len() < 2 {
        return false;
    }
    let hits = full
        .iter()
        .filter(|l| INDENT.is_match(l) || CODE_PUNCT.is_match(l))
        .count();
    hits * 3 >= full.len()
}

/// `clipKind()`: what a clip's text is, for the viewer: a link, a color, a
/// hash, a path, JSON, a shell command, code, or plain text.
pub fn clip_kind(text: &str) -> &'static str {
    let t = js_trim(text);
    if t.is_empty() {
        return "text";
    }
    let lines: Vec<&str> = t.split('\n').collect();
    if lines.len() == 1 {
        // /i on ASCII letters alone: the patterns are written in lower case
        let lower = t.to_ascii_lowercase();
        if COLOR_HEX.is_match(&lower) || COLOR_FN.is_match(&lower) {
            return "color";
        }
        if LINK.is_match(&lower) && url::Url::parse(t).is_ok() {
            return "link";
        }
        if is_hash(t) {
            return "hash";
        }
        if !t.contains("://")
            && js_len(t) <= 1024
            && (ABS_PATH.is_match(t) || REL_PATH.is_match(t) || WIN_PATH.is_match(t))
        {
            return "path";
        }
    }
    if is_json(t) {
        return "json";
    }
    let first = lines[0];
    // /^\$\s+/ off the front, then the first run up to whitespace
    let after = first
        .strip_prefix('$')
        .filter(|r| r.starts_with(js_ws))
        .map_or(first, |r| r.trim_start_matches(js_ws));
    let word = after.split(js_ws).next().unwrap_or("");
    let continued = lines[..lines.len() - 1]
        .iter()
        .all(|l| js_trim_end(l).ends_with('\\'));
    if (lines.len() == 1 || continued) && (t.starts_with("$ ") || COMMAND_WORDS.contains(&word)) {
        return "command";
    }
    if lines.len() > 1 && codey(&lines) {
        return "code";
    }
    "text"
}

/// `s.slice(0, n)` in UTF-16 code units; half of a pair left at the cut
/// prints as U+FFFD, as Bun writes a lone surrogate.
pub fn js_slice(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `clipLine()`: a clip as one line, whitespace runs folded, cut at `max`
/// with an ellipsis.
pub fn clip_line(text: &str, max: usize) -> String {
    let squashed = js_squash_ws(text);
    let flat = js_trim(&squashed);
    if js_len(flat) > max {
        format!("{}…", js_slice(flat, max - 1))
    } else {
        flat.to_string()
    }
}

/// `agoWord()`: "now", "4m", "2h", "3d", how long ago a clip was copied.
pub fn ago_word(at: f64, now: f64) -> String {
    // Math.round on what Math.max keeps at or above zero rounds a half up,
    // as f64::round does there
    let s = ((now - at) / 1000.0).round().max(0.0);
    if (now - at).is_nan() {
        return "NaNd".into();
    }
    if s < 45.0 {
        "now".into()
    } else if s < 3600.0 {
        format!("{}m", js_number((s / 60.0).round().max(1.0)))
    } else if s < 86400.0 {
        format!("{}h", js_number((s / 3600.0).round()))
    } else {
        format!("{}d", js_number((s / 86400.0).round()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_shapes_of_keys_tokens_and_passwords() {
        for s in [
            "AGE-SECRET-KEY-1QQPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
            "AKIAIOSFODNN7EXAMPLE",
            "xoxb-1234567890-abcdefghij",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
            "export ANTHROPIC_API_KEY=abcdefgh12345678",
            "DB_PASSWORD='hunter22hunter22'",
            "line one\nGITHUB_TOKEN=ghx1234567890abcd\nline three",
        ] {
            assert!(looks_secret(s), "{s}");
        }
    }

    #[test]
    fn hashes_ids_links_paths_and_code_that_only_mentions_a_token_are_kept() {
        for s in [
            "4fadb455",
            "4fadb455c3e1f4f8a2b9e7d6c5b4a3f2e1d0c9b8",
            "550e8400-e29b-41d4-a716-446655440000",
            "https://github.com/eric/canopy/pull/412",
            "/Users/ericbaruch/dev/dev-tools/canopy/src/core/clips.ts",
            "const token = await getToken();",
            "sk-short",
            "TOKEN=",
            "bun run redeploy --pull",
        ] {
            assert!(!looks_secret(s), "{s}");
        }
    }

    #[test]
    fn an_env_line_whose_whole_name_is_the_word_is_one_too_alone_on_its_line() {
        for s in [
            "TOKEN=abcdefgh12345678",
            "PASSWORD=hunter22hunter22",
            "export API_KEY='abcdefgh1234'",
            "  SECRET_KEY = abcdefgh1234",
        ] {
            assert!(looks_secret(s), "{s}");
        }
        assert!(!looks_secret("TOKEN=$(cat f) run"));
        assert!(!looks_secret("GITHUB_TOKEN\n=ghx1234567890abcd"));
        // JavaScript's multiline ^ holds after a carriage return too
        assert!(looks_secret("x\rTOKEN=abcdefgh12345678"));
        // and \b is ASCII: an accented letter before a token is a boundary
        assert!(looks_secret("éghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    }

    #[test]
    fn a_long_run_of_blank_lines_capitals_or_dashes_is_read_once() {
        let started = std::time::Instant::now();
        assert!(!looks_secret(&"\n".repeat(200_000)));
        assert!(!looks_secret(&" \n".repeat(100_000)));
        assert!(!looks_secret(&format!("{} x", "A_TOKEN".repeat(20_000))));
        assert!(!looks_secret(&"eyJ-".repeat(50_000)));
        assert!(started.elapsed().as_millis() < 5_000);
    }

    #[test]
    fn a_keys_file_name_is_refused_its_pub_is_not() {
        for n in [
            "id_rsa",
            "id_ed25519",
            "id_ed25519_sk",
            "server.pem",
            "tls.key",
            "cert.p12",
            "vault.kdbx",
            ".env",
            ".env.local",
            "ID_RSA",
        ] {
            assert!(looks_secret_file(n), "{n}");
        }
        for n in [
            "id_ed25519.pub",
            "id_ed25519_sk.pub",
            "keys.md",
            "envoy.yaml",
            "photo.png",
            "keynote.pdf",
            ".envrc",
        ] {
            assert!(!looks_secret_file(n), "{n}");
        }
    }

    #[test]
    fn text_in_a_file_and_bytes_that_are_not_text() {
        assert_eq!(
            text_head("hello, wörld".as_bytes()).as_deref(),
            Some("hello, wörld")
        );
        assert_eq!(text_head(&[0x89, 0x50, 0x4e, 0x47, 0, 1]), None);
        assert_eq!(
            text_head(&[0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]),
            None
        );
        assert_eq!(text_head(b"\xEF\xBB\xBFhi").as_deref(), Some("hi"));
    }

    #[test]
    fn a_pipes_first_bytes_name_its_type() {
        assert_eq!(
            sniff_type(&[0x89, 0x50, 0x4e, 0x47, 0x0d]),
            Some(("image/png", "png"))
        );
        assert_eq!(sniff_type(b"%PDF-1.7"), Some(("application/pdf", "pdf")));
        assert_eq!(
            sniff_type(b"RIFF\0\0\0\0WEBPVP8 "),
            Some(("image/webp", "webp"))
        );
        assert_eq!(sniff_type(b"plain"), None);
    }

    #[test]
    fn each_kind_from_its_shape() {
        for (text, kind) in [
            ("https://github.com/eric/canopy/pull/412", "link"),
            ("http://127.0.0.1:7850/?view=library", "link"),
            ("#3e7a38", "color"),
            ("oklch(62% 0.12 140 / 0.8)", "color"),
            ("rgb(12, 34, 56)", "color"),
            ("4fadb455", "hash"),
            ("/Users/ericbaruch/dev/canopy/src/core/clips.ts", "path"),
            ("~/.config/canopy/clips.json", "path"),
            ("src/core/clips.ts", "path"),
            ("{\"a\": 1, \"b\": [2, 3]}", "json"),
            ("[1, 2, 3]", "json"),
            ("git push origin main", "command"),
            ("$ bun run build", "command"),
            ("docker compose \\\n  up -d", "command"),
            ("function a() {\n  return 1;\n}", "code"),
            ("Copied text from a page,\nover two lines.", "text"),
            ("hello there", "text"),
            ("deadbeef", "text"),
            ("javascript:alert(1)", "text"),
            ("red; background: url(x)", "text"),
            ("HTTPS://EXAMPLE.COM/A", "link"),
            ("#ABC", "color"),
            ("C:\\Users\\e", "path"),
        ] {
            assert_eq!((text, clip_kind(text)), (text, kind));
        }
    }

    #[test]
    fn kinds_of_files_and_of_clips() {
        let kinds: Vec<&str> = [
            "image/png",
            "image/svg+xml",
            "application/pdf",
            "video/mp4",
            "audio/mpeg",
            "application/zip",
        ]
        .iter()
        .map(|t| file_kind(t))
        .collect();
        assert_eq!(kinds, ["image", "image", "pdf", "video", "audio", "file"]);
        assert_eq!(kind_of(&json!({"text": "https://a.b/c"})), "link");
        assert_eq!(
            kind_of(&json!({"text": "https://a.b/c", "file": {"type": "application/pdf"}})),
            "pdf"
        );
    }

    #[test]
    fn the_same_bytes_are_one_clip_and_text_is_its_own() {
        let sha = "a".repeat(64);
        assert_eq!(
            clip_key(&json!({"text": "other.png", "file": {"name": "other.png", "sha": sha}})),
            format!("file:{sha}")
        );
        assert_eq!(clip_key(&json!({"text": "shot.png"})), "shot.png");
    }

    #[test]
    fn newest_first_and_a_tie_to_the_one_kept_first() {
        let mut clips = [
            json!({"id": "c-aaaaaaaa", "at": 1, "createdAt": 1}),
            json!({"id": "c-bbbbbbbb", "at": 1, "createdAt": 2}),
            json!({"id": "c-cccccccc", "at": 5, "createdAt": 1}),
        ];
        clips.sort_by(clip_order);
        let ids: Vec<&str> = clips.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["c-cccccccc", "c-bbbbbbbb", "c-aaaaaaaa"]);
    }

    #[test]
    fn one_line_folded_and_cut() {
        assert_eq!(clip_line("  a\n\n b  ", 120), "a b");
        assert_eq!(clip_line(&"x".repeat(10), 5), "xxxx…");
        // a cut through a pair prints its half as U+FFFD, as Bun does
        assert_eq!(clip_line("a😀bcdef", 3), "a\u{FFFD}…");
    }

    #[test]
    fn now_minutes_hours_and_days() {
        const DAY: f64 = 24.0 * 60.0 * 60_000.0;
        assert_eq!(ago_word(1_000.0, 20_000.0), "now");
        assert_eq!(ago_word(0.0, 4.0 * 60_000.0), "4m");
        assert_eq!(ago_word(0.0, 2.0 * 3_600_000.0), "2h");
        assert_eq!(ago_word(0.0, 3.0 * DAY), "3d");
        assert_eq!(ago_word(5_000.0, 1_000.0), "now");
    }

    #[test]
    fn sizes_as_kept() {
        assert_eq!(size_word(512.0), "512 B");
        assert_eq!(size_word(14_000.0), "14 KB");
        assert_eq!(size_word(2.4 * 1024.0 * 1024.0), "2.4 MB");
        assert_eq!(size_word(25.0 * 1024.0 * 1024.0), "25 MB");
    }
}
