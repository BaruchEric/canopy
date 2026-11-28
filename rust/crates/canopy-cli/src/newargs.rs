//! `canopy new`'s and `canopy incubator add`'s arguments
//! (`src/cli/newargs.ts`), read without touching the disk or the network.

use crate::api::LOCAL;
use crate::ask::is_origin;
use canopy_core::pathx::{JS_S, js_trim};
use canopy_core::sprout::{github_repo, repo_page, url_without_secret};
use regex::Regex;
use std::sync::LazyLock;

/// What a project's intake takes from the command line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IntakeArgs {
    pub text: String,
    pub files: Vec<String>,
    pub urls: Vec<String>,
    pub repo: Option<String>,
    /// how a lone url was taken, and the flag that takes it the other way
    pub note: Option<String>,
    /// `canopy new`'s backend, as an origin; None for `incubator add`
    pub backend: Option<String>,
}

/// `NEW_USAGE`.
pub fn new_usage() -> String {
    crate::help::verb_help("new").unwrap_or_else(|| {
        "usage: canopy new \"<idea>\" [--file f]... [--url u]... [--repo url] [--backend URL]"
            .into()
    })
}

/// `ADD_USAGE`.
pub const ADD_USAGE: &str =
    "usage: canopy incubator add <id> [\"<words>\"] [--file f]... [--url u]...";

/// `/^(https?|ssh|git):\/\/\S+\.git\/?$/i`
static GIT_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:[hH][tT][tT][pP][sS]?|[sS][sS][hH]|[gG][iI][tT])://[^{JS_S}]+\.[gG][iI][tT]/?$"
    ))
    .unwrap()
});
/// `/^https?:\/\/\S+$/i`
static WEB_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^[hH][tT][tT][pP][sS]?://[^{JS_S}]+$")).unwrap());

/// `readsAsRepo()`: a url `git clone` takes as a repo: a GitHub repo or a
/// page inside one, or any url ending in .git.
fn reads_as_repo(url: &str) -> bool {
    github_repo(url).is_some() || repo_page(url).is_some() || GIT_URL.is_match(url)
}

/// `readIntakeArgs()`: the idea's words and the valued flags in `flags`.
/// An unknown `--flag` is an error with the usage, and `--` ends the flags.
/// One url standing alone as the idea is the repo when `--repo` is a flag
/// here, none was given and it reads as a repo, else a link.
fn read_intake_args(argv: &[String], flags: &[&str], usage: &str) -> Result<IntakeArgs, String> {
    let mut words: Vec<String> = Vec::new();
    let mut a = IntakeArgs::default();
    let mut ended = false;
    let mut i = 0;
    while i < argv.len() {
        let w = &argv[i];
        if ended || !w.starts_with("--") {
            words.push(w.clone());
            i += 1;
            continue;
        }
        if w == "--" {
            ended = true;
            i += 1;
            continue;
        }
        if !flags.contains(&w.as_str()) {
            return Err(format!("unknown flag {w}\n{usage}"));
        }
        let v = match argv.get(i + 1) {
            Some(v) if !v.starts_with("--") => v.clone(),
            _ => return Err(format!("{w} needs a value")),
        };
        i += 2;
        match w.as_str() {
            "--file" => a.files.push(v),
            "--url" => a.urls.push(v),
            "--repo" => a.repo = Some(v),
            _ => a.backend = Some(v),
        }
    }
    let lone = if words.len() == 1 {
        js_trim(&words[0]).to_string()
    } else {
        String::new()
    };
    let repo_flag = flags.contains(&"--repo");
    let as_repo = !lone.is_empty() && repo_flag && a.repo.is_none() && reads_as_repo(&lone);
    if as_repo || (!lone.is_empty() && WEB_LINK.is_match(&lone)) {
        let shown = url_without_secret(&lone);
        a.note = if as_repo {
            Some(format!(
                "took {shown} as --repo; pass it with --url to give it as a link"
            ))
        } else if repo_flag {
            Some(format!(
                "took {shown} as --url; pass it with --repo to start from it"
            ))
        } else {
            None
        };
        if as_repo {
            a.repo = Some(lone);
        } else {
            a.urls.insert(0, lone);
        }
        return Ok(a);
    }
    a.text = js_trim(&words.join(" ")).to_string();
    Ok(a)
}

/// `parseNewArgs()`: the backend is the flag, else the shell's
/// $CANOPY_API, else loopback.
pub fn parse_new_args(argv: &[String], env_api: Option<&str>) -> Result<IntakeArgs, String> {
    let mut read = read_intake_args(
        argv,
        &["--file", "--url", "--repo", "--backend"],
        &new_usage(),
    )?;
    let given = read.backend.take();
    let origin = given
        .as_deref()
        .or(env_api)
        .unwrap_or(LOCAL)
        .trim_end_matches('/')
        .to_string();
    if !is_origin(&origin) {
        return Err(format!(
            "--backend must be an http(s) origin, got {}",
            given.unwrap_or(origin)
        ));
    }
    if read.text.is_empty() && read.files.is_empty() && read.urls.is_empty() && read.repo.is_none()
    {
        return Err("give an idea, --file, --url or --repo".into());
    }
    read.backend = Some(origin);
    Ok(read)
}

/// `parseAddArgs()`: `canopy incubator add`'s words and flags, after its
/// id; the backend is the command's.
pub fn parse_add_args(argv: &[String]) -> Result<IntakeArgs, String> {
    let read = read_intake_args(argv, &["--file", "--url"], ADD_USAGE)?;
    if read.text.is_empty() && read.files.is_empty() && read.urls.is_empty() {
        return Err(format!("give words, --file or --url\n{ADD_USAGE}"));
    }
    Ok(read)
}

/// `sproutLink()`: a link to the project in the page.
pub fn sprout_link(page: &str, id: &str) -> String {
    format!("{}/?view=incubator&sprout={id}", page.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn parse(a: &[&str]) -> Result<IntakeArgs, String> {
        parse_new_args(&words(a), None)
    }

    #[test]
    fn the_idea_repeated_files_and_links_a_repo() {
        assert_eq!(
            parse(&[
                "a",
                "coin",
                "counter",
                "--file",
                "a.png",
                "--url",
                "https://x.test",
                "--file",
                "b.m4a",
                "--repo",
                "https://github.com/a/b"
            ]),
            Ok(IntakeArgs {
                text: "a coin counter".into(),
                files: words(&["a.png", "b.m4a"]),
                urls: words(&["https://x.test"]),
                repo: Some("https://github.com/a/b".into()),
                note: None,
                backend: Some("http://127.0.0.1:7850".into()),
            })
        );
    }

    #[test]
    fn the_backend_the_flag_else_the_shells_canopy_api_else_loopback() {
        let b = |a: &[&str], env: Option<&str>| parse_new_args(&words(a), env).unwrap().backend;
        assert_eq!(
            b(
                &["x", "--backend", "http://mini:7850/"],
                Some("http://127.0.0.1:9")
            ),
            Some("http://mini:7850".into())
        );
        assert_eq!(
            b(&["x"], Some("http://127.0.0.1:9")),
            Some("http://127.0.0.1:9".into())
        );
    }

    #[test]
    fn nothing_given_a_flag_with_no_value_or_a_backend_that_is_not_a_web_origin_is_an_error() {
        assert_eq!(
            parse(&[]),
            Err("give an idea, --file, --url or --repo".into())
        );
        assert_eq!(parse(&["x", "--file"]), Err("--file needs a value".into()));
        assert_eq!(
            parse(&["x", "--backend", "mini"]),
            Err("--backend must be an http(s) origin, got mini".into())
        );
    }

    #[test]
    fn an_unknown_flag_is_an_error_that_lists_the_flags_canopy_new_takes_and_dashdash_ends_the_flags()
     {
        let usage = new_usage();
        assert_eq!(
            parse(&["a", "coin", "counter", "--repoo", "https://github.com/a/b"]),
            Err(format!("unknown flag --repoo\n{usage}"))
        );
        assert_eq!(
            parse(&["--fil", "a.png"]),
            Err(format!("unknown flag --fil\n{usage}"))
        );
        for flag in ["--file", "--url", "--repo", "--backend"] {
            assert!(usage.contains(flag), "{flag}");
        }
        let a = parse(&[
            "--file",
            "a.png",
            "--",
            "--verbose",
            "logs",
            "for",
            "the",
            "app",
        ])
        .unwrap();
        assert_eq!(a.text, "--verbose logs for the app");
        assert_eq!(a.files, words(&["a.png"]));
    }

    #[test]
    fn a_lone_url_is_the_repo_when_it_reads_as_one_else_a_link_with_a_note_naming_the_other_flag() {
        assert_eq!(
            parse(&["https://github.com/a/b"]),
            Ok(IntakeArgs {
                repo: Some("https://github.com/a/b".into()),
                backend: Some("http://127.0.0.1:7850".into()),
                note: Some(
                    "took https://github.com/a/b as --repo; pass it with --url to give it as a link"
                        .into()
                ),
                ..Default::default()
            })
        );
        // a page inside a GitHub repo: the server clones the repo and keeps the page as a link
        let page = parse(&["https://github.com/a/b/blob/main/README.md"]).unwrap();
        assert_eq!(
            (page.urls, page.repo.as_deref()),
            (vec![], Some("https://github.com/a/b/blob/main/README.md"))
        );
        assert_eq!(
            parse(&["git@github.com:a/b.git"]).unwrap().repo.as_deref(),
            Some("git@github.com:a/b.git")
        );
        assert_eq!(
            parse(&["https://git.example.com/a/b.git"])
                .unwrap()
                .repo
                .as_deref(),
            Some("https://git.example.com/a/b.git")
        );
        assert_eq!(
            parse(&["https://example.com/post", "--file", "a.png"]),
            Ok(IntakeArgs {
                files: words(&["a.png"]),
                urls: words(&["https://example.com/post"]),
                backend: Some("http://127.0.0.1:7850".into()),
                note: Some(
                    "took https://example.com/post as --url; pass it with --repo to start from it"
                        .into()
                ),
                ..Default::default()
            })
        );
        // with a repo already named, a lone url is a link
        let both = parse(&["https://github.com/c/d", "--repo", "https://github.com/a/b"]).unwrap();
        assert_eq!(both.urls, words(&["https://github.com/c/d"]));
        assert_eq!(both.repo.as_deref(), Some("https://github.com/a/b"));
        // the token goes to the server, which clones with it; the note never shows it
        let with_token = parse(&["https://x:tok3n@github.com/a/b"]).unwrap();
        assert_eq!(
            with_token.repo.as_deref(),
            Some("https://x:tok3n@github.com/a/b")
        );
        assert!(!with_token.note.unwrap_or_default().contains("tok3n"));
        // a url among other words stays the idea, and one plain word is an idea
        let idea = parse(&["redo", "https://example.com/post"]).unwrap();
        assert_eq!(
            (idea.text.as_str(), idea.urls.len()),
            ("redo https://example.com/post", 0)
        );
        let word = parse(&["calculator"]).unwrap();
        assert_eq!((word.text.as_str(), word.urls.len()), ("calculator", 0));
    }

    #[test]
    fn a_link_to_the_project_in_the_page() {
        assert_eq!(
            sprout_link("http://mini:7850", "sp_0123456789ab"),
            "http://mini:7850/?view=incubator&sprout=sp_0123456789ab"
        );
    }
}
