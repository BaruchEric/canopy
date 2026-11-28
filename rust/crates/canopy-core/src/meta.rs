//! What a card says about a repo beyond its git state: a web link and a
//! one-line description from its manifest or README (`src/core/meta.ts`,
//! with `listRemotes` from `src/core/access.ts`).

use crate::exec::{ExecOptions, git, on_host};
use crate::host::parse_locator;
use crate::pathx::{JS_S, js_trim, js_ws};
use crate::remote::web_url;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

/// A card holds one line. Longer than this and it is a paragraph.
pub const MAX_DESCRIPTION: usize = 160;

static WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{JS_S}+")).unwrap());
static TAIL_PUNCT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?:[,;:.]|{JS_S})+$")).unwrap());

/// Collapse whitespace and cut at a word boundary. Lengths are UTF-16 code
/// units, as the TypeScript counts them.
pub fn tidy(text: &str) -> Option<String> {
    let collapsed = WS_RUN.replace_all(text, " ");
    let one = js_trim(&collapsed);
    if one.is_empty() {
        return None;
    }
    let units: Vec<u16> = one.encode_utf16().collect();
    if units.len() <= MAX_DESCRIPTION {
        return Some(one.to_string());
    }
    let cut = &units[..MAX_DESCRIPTION];
    let sp = cut.iter().rposition(|u| *u == b' ' as u16);
    let kept = match sp {
        Some(i) if i > 60 => &cut[..i],
        _ => cut,
    };
    let kept = String::from_utf16_lossy(kept);
    Some(format!("{}…", TAIL_PUNCT.replace(&kept, "")))
}

/// package.json, composer.json, deno.json: all spell it the same way.
pub fn from_json_manifest(text: &str) -> Option<String> {
    let data: serde_json::Value = serde_json::from_str(text).ok()?;
    data.as_object()?
        .get("description")?
        .as_str()
        .and_then(tidy)
}

static TOML_DESC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^[ \t]*description[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')[ \t]*$"#).unwrap()
});

/// Cargo.toml and pyproject.toml: only a single-line quoted value.
pub fn from_toml_manifest(text: &str) -> Option<String> {
    let m = TOML_DESC.captures(text)?;
    let value = m.get(1).or_else(|| m.get(2))?.as_str();
    if value.is_empty() { None } else { tidy(value) }
}

/// `/^([-*_=])\1{2,}$/`: three or more of one rule character.
fn is_rule(s: &str, chars: &[char]) -> bool {
    let mut it = s.chars();
    let Some(first) = it.next() else { return false };
    chars.contains(&first) && s.chars().count() >= 3 && s.chars().all(|c| c == first)
}

static CHROME_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(#|>|<|\||:::)").unwrap());
static LIST_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^([-*+]|\d+[.)]){JS_S}")).unwrap());
static LINK_DEF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^\[[^\]]+\]:{JS_S}*[^\s\x{{FEFF}}]+$")).unwrap());
static IMG_OR_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[[^\]]*\]\([^)]*\)").unwrap());
static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[`*_~]").unwrap());
static THREE_LETTERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z]{3}").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]\([^)]*\)").unwrap());
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(```|~~~)").unwrap());
static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static PROSE_MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[`*_]").unwrap());

/// True for a line that carries no prose: a heading, a rule, a table row,
/// raw HTML, or a row of badges.
fn is_chrome(line: &str) -> bool {
    if CHROME_START.is_match(line) {
        return true;
    }
    let squeezed: String = line.chars().filter(|c| !js_ws(*c)).collect();
    if is_rule(&squeezed, &['-', '*', '_', '=']) {
        return true;
    }
    if LIST_ITEM.is_match(line) || LINK_DEF.is_match(line) {
        return true;
    }
    let bare = IMG_OR_LINK.replace_all(line, "");
    let bare = HTML_TAG.replace_all(&bare, "");
    let bare = MARKS.replace_all(&bare, "");
    let bare = js_trim(&bare);
    if !THREE_LETTERS.is_match(bare) {
        return true;
    }
    // a row of links with a word or two of glue is a table of contents
    let links = LINK.find_iter(line).count();
    links >= 2 && bare.chars().filter(|c| c.is_ascii_alphabetic()).count() < 12
}

pub fn from_readme(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let at = |i: usize| lines.get(i).copied().unwrap_or("");
    let mut i = 0;
    // YAML frontmatter
    if lines.first().is_some_and(|l| js_trim(l) == "---") {
        i = 1;
        while i < lines.len() && js_trim(at(i)) != "---" {
            i += 1;
        }
        i += 1;
    }
    let mut fenced = false;
    while i < lines.len() {
        let line = js_trim(at(i));
        if FENCE.is_match(line) {
            fenced = !fenced;
            i += 1;
            continue;
        }
        if fenced || line.is_empty() || is_chrome(line) {
            i += 1;
            continue;
        }
        // an underlined setext heading is a title, not a description
        if is_rule(js_trim(at(i + 1)), &['-', '=']) {
            i += 1;
            continue;
        }
        // the whole paragraph, so a hard-wrapped README is not cut at its margin
        let mut para: Vec<&str> = Vec::new();
        for j in i..lines.len() {
            let next = js_trim(at(j));
            if next.is_empty() || is_chrome(next) || FENCE.is_match(next) {
                break;
            }
            para.push(next);
        }
        let joined = para.join(" ");
        let prose = IMAGE.replace_all(&joined, "");
        let prose = LINK_TEXT.replace_all(&prose, "$1");
        let prose = HTML_TAG.replace_all(&prose, "");
        let prose = PROSE_MARKS.replace_all(&prose, "");
        if let Some(one) = tidy(js_trim(&prose)) {
            return Some(one);
        }
        i += 1;
    }
    None
}

type Parse = fn(&str) -> Option<String>;
const MANIFESTS: &[(&str, Parse)] = &[
    ("package.json", from_json_manifest),
    ("cargo.toml", from_toml_manifest),
    ("pyproject.toml", from_toml_manifest),
    ("composer.json", from_json_manifest),
];

const README_NAMES: &[&str] = &[
    "readme",
    "readme.md",
    "readme.markdown",
    "readme.mdx",
    "readme.rst",
    "readme.txt",
];

fn candidates() -> Vec<&'static str> {
    MANIFESTS
        .iter()
        .map(|m| m.0)
        .chain(README_NAMES.iter().copied())
        .collect()
}

/// enough for any manifest, and for a README's opening paragraph
const READ_LIMIT: usize = 64_000;

/// The first `READ_LIMIT` UTF-16 units, as `text.slice(0, READ_LIMIT)`.
fn head(text: String) -> String {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > READ_LIMIT {
            return text[..i].to_string();
        }
    }
    text
}

/// What a card says about a repo beyond its git state. Best-effort: anything
/// unreadable is left out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RepoMeta {
    pub link: Option<String>,
    pub description: Option<String>,
    /// every remote's url, in `git config` order
    pub remotes: Option<Vec<String>>,
}

fn read_candidates_local(dir: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let wanted = candidates();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        let Ok(ft) = e.file_type() else { continue };
        if !wanted.contains(&lower.as_str()) || !(ft.is_file() || ft.is_symlink()) {
            continue;
        }
        if let Ok(bytes) = std::fs::read(e.path()) {
            out.insert(lower, head(String::from_utf8_lossy(&bytes).into_owned()));
        }
    }
    out
}

/// One ssh round trip for every candidate: `find` names them, and a tiny
/// shell prints each as `name\n<head>\n\0`.
pub fn remote_candidates_command(dir: &str) -> Vec<String> {
    let mut cmd: Vec<String> = [
        "find",
        dir,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "(",
        "-type",
        "f",
        "-o",
        "-type",
        "l",
        ")",
        "(",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for (i, n) in candidates().iter().enumerate() {
        if i > 0 {
            cmd.push("-o".into());
        }
        cmd.push("-iname".into());
        cmd.push(n.to_string());
    }
    cmd.extend(
        [
            ")",
            "-exec",
            "sh",
            "-c",
            &format!("printf '%s\\n' \"$1\"; head -c {READ_LIMIT} -- \"$1\"; printf '\\n\\0'"),
            "_",
            "{}",
            ";",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    cmd
}

/// Undo the packing above: name, newline, text, then a NUL per file.
pub fn parse_remote_candidates(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for chunk in text.split('\0') {
        let Some(nl) = chunk.find('\n') else { continue };
        let name = chunk[..nl].rsplit('/').next().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let body = &chunk[nl + 1..];
        out.insert(
            name.to_lowercase(),
            body.strip_suffix('\n').unwrap_or(body).to_string(),
        );
    }
    out
}

async fn read_description(repo_path: &str) -> Option<String> {
    let loc = parse_locator(repo_path);
    let files = match &loc.host {
        // file reads block, so they run off the async workers
        None => {
            let dir = loc.path.clone();
            tokio::task::spawn_blocking(move || read_candidates_local(&dir))
                .await
                .unwrap_or_default()
        }
        Some(h) => {
            let r = on_host(
                Some(h),
                &remote_candidates_command(&loc.path),
                &ExecOptions {
                    timeout_ms: Some(30_000),
                    ..Default::default()
                },
            )
            .await;
            parse_remote_candidates(&r.stdout)
        }
    };
    for (file, parse) in MANIFESTS {
        if let Some(desc) = files.get(*file).and_then(|t| parse(t)) {
            return Some(desc);
        }
    }
    README_NAMES
        .iter()
        .find_map(|name| files.get(*name).and_then(|t| from_readme(t)))
}

/// A configured remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub name: String,
    pub url: String,
}

/// Every configured remote, in `git config` order.
pub async fn list_remotes(repo_path: &str) -> Vec<Remote> {
    let r = git(repo_path, &["config", "--get-regexp", r"^remote\..*\.url"]).await;
    if r.code != 0 {
        return vec![];
    }
    let mut out = Vec::new();
    for line in r.stdout.split('\n') {
        let Some(sp) = line.find(' ') else { continue };
        let url = js_trim(&line[sp + 1..]).to_string();
        // remote.<name>.url, and the name itself may contain dots
        let key = &line[..sp];
        let name = match (key.get("remote.".len()..), key.rfind(".url")) {
            (Some(_), Some(end)) if end >= "remote.".len() => key["remote.".len()..end].to_string(),
            _ => String::new(),
        };
        if !url.is_empty() && !name.is_empty() {
            out.push(Remote { name, url });
        }
    }
    out
}

/// origin wins, then upstream, then whatever is configured.
pub fn pick_link(remotes: &[Remote]) -> Option<String> {
    let rank = |n: &str| match n {
        "origin" => 0,
        "upstream" => 1,
        _ => 2,
    };
    let mut order: Vec<&Remote> = remotes.iter().collect();
    order.sort_by_key(|r| rank(&r.name));
    order.iter().find_map(|r| web_url(&r.url))
}

pub async fn read_meta(repo_path: &str) -> RepoMeta {
    let (remotes, description) = tokio::join!(list_remotes(repo_path), read_description(repo_path));
    let link = pick_link(&remotes);
    let urls: Vec<String> = remotes.into_iter().map(|r| r.url).collect();
    RepoMeta {
        link,
        description,
        remotes: if urls.is_empty() { None } else { Some(urls) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_find_names_every_manifest_and_readme() {
        let cmd = remote_candidates_command("/home/me/dev/x");
        assert_eq!(&cmd[..2], ["find", "/home/me/dev/x"]);
        assert_eq!(cmd.iter().filter(|a| *a == "-iname").count(), 10);
        assert!(cmd.contains(&"readme.md".to_string()));
        assert_eq!(cmd.last().unwrap(), ";");
    }

    #[test]
    fn packed_output_comes_apart_by_nul() {
        let files = parse_remote_candidates(
            "/x/Package.json\n{\"description\":\"a\"}\n\0/x/README.md\nHello\nworld\n\0",
        );
        assert_eq!(files.get("package.json").unwrap(), r#"{"description":"a"}"#);
        assert_eq!(files.get("readme.md").unwrap(), "Hello\nworld");
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn tidy_collapses_and_cuts() {
        assert_eq!(tidy("  a\n  live   tree ").as_deref(), Some("a live tree"));
        assert_eq!(tidy("   \n "), None);
        let long = format!("{}end", "word ".repeat(60));
        let out = tidy(&long).unwrap();
        assert!(out.encode_utf16().count() <= MAX_DESCRIPTION + 1);
        assert!(out.ends_with('…'));
        assert!(!out.contains("  "));
        assert_ne!(out.chars().rev().nth(1), Some(' '));
    }

    #[test]
    fn json_manifests() {
        assert_eq!(
            from_json_manifest(r#"{"name":"x","description":"a git cockpit"}"#).as_deref(),
            Some("a git cockpit")
        );
        assert_eq!(from_json_manifest(r#"{"name":"x"}"#), None);
        assert_eq!(from_json_manifest(r#"{"description":42}"#), None);
        assert_eq!(from_json_manifest("not json at all"), None);
        assert_eq!(from_json_manifest("[1,2,3]"), None);
    }

    #[test]
    fn toml_manifests() {
        assert_eq!(
            from_toml_manifest("[package]\nname = \"canopy\"\ndescription = \"a tiny engine\"\nedition = \"2021\"\n").as_deref(),
            Some("a tiny engine")
        );
        assert_eq!(
            from_toml_manifest("[project]\ndescription = 'single quotes'\n").as_deref(),
            Some("single quotes")
        );
        assert_eq!(
            from_toml_manifest("description = \"\"\"\nlong\n\"\"\"\n"),
            None
        );
        assert_eq!(from_toml_manifest("[package]\nname = \"x\"\n"), None);
    }

    #[test]
    fn readmes() {
        assert_eq!(
            from_readme("# canopy\n\nMulti-repo git cockpit.\n").as_deref(),
            Some("Multi-repo git cockpit.")
        );
        let r = [
            "---",
            "title: thing",
            "---",
            "<p align=\"center\">",
            "  <img src=\"logo.png\" />",
            "</p>",
            "",
            "[![build](https://img.shields.io/x)](https://ci) [![npm](https://b.svg)](https://npm)",
            "",
            "===",
            "",
            "The open-source design platform.",
        ]
        .join("\n");
        assert_eq!(
            from_readme(&r).as_deref(),
            Some("The open-source design platform.")
        );
        let r = [
            "penpot",
            "======",
            "",
            "[urilicense]: https://www.mozilla.org/en-US/MPL/2.0",
            "",
            "Design and prototype in the browser.",
        ]
        .join("\n");
        assert_eq!(
            from_readme(&r).as_deref(),
            Some("Design and prototype in the browser.")
        );
        let r = [
            "# thing",
            "",
            "[Overview](#o) · [Principles](#p) · [Features](#f)",
            "",
            "```sh",
            "git clone https://github.com/o/thing.git",
            "```",
            "",
            "It captures what you care about.",
        ]
        .join("\n");
        assert_eq!(
            from_readme(&r).as_deref(),
            Some("It captures what you care about.")
        );
        let r = "# devhub\n\nA self-evolving manager for the dev workspace.\nSorts projects into\ntopic folders.\n\nMore below.\n";
        assert_eq!(
            from_readme(r).as_deref(),
            Some(
                "A self-evolving manager for the dev workspace. Sorts projects into topic folders."
            )
        );
        assert_eq!(
            from_readme("A **fast** [CLI](https://x) for `git`.\n").as_deref(),
            Some("A fast CLI for git.")
        );
        assert_eq!(from_readme("# title\n\n## install\n\n- step one\n"), None);
        assert_eq!(from_readme(""), None);
        // a byte order mark is whitespace to JavaScript's trim
        assert_eq!(
            from_readme("\u{feff}# title\n\nBody text here.\n").as_deref(),
            Some("Body text here.")
        );
    }

    fn rm(name: &str, url: &str) -> Remote {
        Remote {
            name: name.into(),
            url: url.into(),
        }
    }

    #[test]
    fn pick_link_prefers_origin_then_upstream() {
        assert_eq!(
            pick_link(&[
                rm("fork", "git@github.com:me/x.git"),
                rm("origin", "https://github.com/them/x.git")
            ])
            .as_deref(),
            Some("https://github.com/them/x")
        );
        assert_eq!(
            pick_link(&[
                rm("fork", "git@github.com:me/x.git"),
                rm("upstream", "https://gitlab.com/them/x")
            ])
            .as_deref(),
            Some("https://gitlab.com/them/x")
        );
        assert_eq!(
            pick_link(&[
                rm("origin", "ssh://git@192.168.1.10:2222/eric/x.git"),
                rm("gh", "git@github.com:eric/x.git")
            ])
            .as_deref(),
            Some("https://github.com/eric/x")
        );
        assert_eq!(pick_link(&[]), None);
    }
}
