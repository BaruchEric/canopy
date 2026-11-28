//! Node's `path` functions and JavaScript's string ordering, so paths, ids
//! and padded columns come out byte for byte as the TypeScript made them.
//! Paths here are POSIX and lexical: nothing touches the filesystem.

use std::cmp::Ordering;

/// `path.normalize`: collapse `//`, `.` and `..`, keep a trailing-slash-free
/// result except for the root itself. A relative path keeps leading `..`.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let body = parts.join("/");
    match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".into(),
        (false, false) => body,
    }
}

/// `path.join(a, b)`
pub fn join(a: &str, b: &str) -> String {
    if a.is_empty() {
        return normalize(b);
    }
    if b.is_empty() {
        return normalize(a);
    }
    normalize(&format!("{a}/{b}"))
}

/// `path.resolve(p)` against the process's working directory.
pub fn resolve(p: &str) -> String {
    if p.starts_with('/') {
        return normalize(p);
    }
    let cwd = std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into());
    join(&cwd, p)
}

/// `path.resolve(base, p)`
pub fn resolve_from(base: &str, p: &str) -> String {
    if p.starts_with('/') {
        normalize(p)
    } else {
        join(&resolve(base), p)
    }
}

/// `path.relative(from, to)` for two paths, both resolved first.
pub fn relative(from: &str, to: &str) -> String {
    let from = resolve(from);
    let to = resolve(to);
    if from == to {
        return String::new();
    }
    let f: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let mut out: Vec<&str> = std::iter::repeat_n("..", f.len() - common).collect();
    out.extend(&t[common..]);
    out.join("/")
}

/// `path.basename(p)`: the last segment, trailing slashes ignored.
pub fn basename(p: &str) -> String {
    let trimmed = p.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("").to_string()
}

/// `path.dirname(p)`
pub fn dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".into();
    }
    match trimmed.rfind('/') {
        None => ".".into(),
        Some(0) => "/".into(),
        Some(i) => {
            let d = trimmed[..i].trim_end_matches('/');
            if d.is_empty() && absolute {
                "/".into()
            } else {
                d.to_string()
            }
        }
    }
}

/// A string's length as JavaScript counts it: UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.padEnd(width)` as JavaScript pads: by UTF-16 code units.
pub fn pad_end(s: &str, width: usize) -> String {
    let len = js_len(s);
    if len >= width {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + width - len);
    out.push_str(s);
    out.extend(std::iter::repeat_n(' ', width - len));
    out
}

/// `s.padStart(width)` as JavaScript pads: by UTF-16 code units.
pub fn pad_start(s: &str, width: usize) -> String {
    let len = js_len(s);
    if len >= width {
        return s.to_string();
    }
    let mut out: String = std::iter::repeat_n(' ', width - len).collect();
    out.push_str(s);
    out
}

/// The order JavaScript's default `sort()` gives strings: by UTF-16 code
/// units, which differs from Rust's byte order only past the BMP.
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Sort and drop duplicates the way `[...new Set(xs)].sort()` does.
pub fn js_sorted_unique(mut xs: Vec<String>) -> Vec<String> {
    xs.sort_by(|a, b| js_cmp(a, b));
    xs.dedup();
    xs
}

/// JavaScript's whitespace (`trim()`, `\s`): Unicode's White_Space with
/// U+FEFF added and U+0085 taken out.
pub fn js_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `/^https?:\/\/[^/\s]+$/`: a bare http(s) origin, `\s` as JavaScript
/// reads it. The CLI's verbs and a tenant's origins test against this one.
pub fn is_bare_origin(s: &str) -> bool {
    let rest = s
        .strip_prefix("http://")
        .or_else(|| s.strip_prefix("https://"));
    rest.is_some_and(|r| !r.is_empty() && !r.chars().any(|c| c == '/' || js_ws(c)))
}

/// `s.trim()` as JavaScript trims.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_ws)
}

/// `s.trimStart()` as JavaScript trims.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(js_ws)
}

/// `s.trimEnd()` as JavaScript trims.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(js_ws)
}

/// `s.replace(/\s+/g, " ")`: each run of JavaScript whitespace as one space.
pub fn js_squash_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if js_ws(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// A regex class for JavaScript's `\s`, to splice into a pattern.
pub const JS_S: &str = r"[[\s\x{FEFF}]&&[^\x{85}]]";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_like_node() {
        assert_eq!(normalize("/a//b/./c/.."), "/a/b");
        assert_eq!(normalize("/a/b/"), "/a/b");
        assert_eq!(normalize("/"), "/");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(normalize("a/../.."), "..");
        assert_eq!(normalize(""), ".");
    }

    #[test]
    fn joins_and_resolves() {
        assert_eq!(join("/a/", "b"), "/a/b");
        assert_eq!(join("/a", "../b"), "/b");
        assert_eq!(resolve_from("/x/y", "z"), "/x/y/z");
        assert_eq!(resolve_from("/x/y", "/z"), "/z");
    }

    #[test]
    fn relative_paths() {
        assert_eq!(relative("/root", "/root"), "");
        assert_eq!(relative("/root", "/root/a/b"), "a/b");
        assert_eq!(relative("/root/a", "/root/b"), "../b");
    }

    #[test]
    fn base_and_dir() {
        assert_eq!(basename("/a/b"), "b");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("a/b"), "a");
        assert_eq!(dirname("/"), "/");
    }

    #[test]
    fn js_string_rules() {
        assert_eq!(js_len("é"), 1);
        assert_eq!(js_len("😀"), 2);
        assert_eq!(pad_end("😀", 3), "😀 ");
        // U+FF5E sorts after an astral char in UTF-8 byte order but before it in UTF-16
        assert_eq!(js_cmp("\u{ff5e}", "😀"), Ordering::Greater);
        assert_eq!(
            js_sorted_unique(vec!["b".into(), "a".into(), "b".into()]),
            vec!["a", "b"]
        );
        assert_eq!(js_trim("\u{feff} a \u{a0}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        let re = regex::Regex::new(&format!("^{JS_S}+$")).unwrap();
        assert!(re.is_match(" \t\u{feff}"));
        assert!(!re.is_match("\u{85}"));
        assert_eq!(
            js_squash_ws("two  words\nand\u{a0}\u{feff}a line "),
            "two words and a line "
        );
        assert_eq!(js_squash_ws("a\u{85}b"), "a\u{85}b");
    }
}
