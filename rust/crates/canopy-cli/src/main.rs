//! `canopy-rs`, the Rust port of the `canopy` CLI (`src/cli/index.ts`).
//!
//! It answers `canopy [dir]`, `canopy tree`, `canopy status`, `canopy
//! version`, `canopy commit`, `canopy push` and `canopy pull` itself, the
//! backend verbs `note`, `awake`, `issues`, `pr`, `prs`, `scenarios`,
//! `sweep`, `kit`, `loadouts`, `groups`, `work`, `land`, `queue`,
//! `collisions`, `floorplan`, `archify`, `diagnosis`, `understand`,
//! `capacity`, `costs` and `plugins` over HTTP (`HTTP_VERBS`), and every
//! verb's `--help`, with output byte for byte the TypeScript CLI's.
//! `--token` is read for every verb, as index.ts reads it. Every other
//! verb, and a local verb with a flag the port does not read yet
//! (`--backend` on tree or status, or in front of the repo, `commit --ai`,
//! `push test|ls`), still goes
//! to the TypeScript CLI (`bun bin/canopy.ts`) until it is ported, so the
//! binary can stand in for `canopy` today. docs/rust-port.md has the
//! ledger.

mod api;
mod archify;
mod ask;
mod awake;
mod capacity;
mod costs;
mod diagnosis;
mod floorplan;
mod groups;
mod help;
mod issues;
mod jsdate;
mod kit;
mod land;
mod loadouts;
mod mapsection;
mod notes;
mod out;
mod plugins;
mod prs;
mod scenarios;
mod sweep;
mod understand;
mod work;

use canopy_core::git::{StatusOptions, get_status};
use canopy_core::gitwrite::{GitError, commit, drop_stale_copies, pull, push};
use canopy_core::pathx::resolve;
use canopy_core::scan::{DEFAULT_IGNORE, ScanOptions, scan};
use canopy_core::stalecopy::newest_stale;
use canopy_core::store::load_config;
use canopy_core::treelines::{Seg, Tone, tree_lines};
use canopy_core::types::now_ms;
use canopy_core::version::{canopy_dir, read_build, version_line};
use std::io::IsTerminal;
use std::process::{Command, ExitCode};

/// The TypeScript CLI's verbs (`COMMANDS` in src/cli/index.ts). A first
/// argument that is none of these is the directory for the tree. A test
/// below fails when the two lists part.
pub const COMMANDS: &[&str] = &[
    "new",
    "incubator",
    "ranger",
    "sweep",
    "note",
    "notes",
    "people",
    "tenant",
    "tenants",
    "clip",
    "clips",
    "awake",
    "run",
    "runs",
    "groups",
    "health",
    "costs",
    "capacity",
    "loadouts",
    "coordinator",
    "kit",
    "plugins",
    "mcp",
    "land",
    "worktrees",
    "floorplan",
    "archify",
    "diagnosis",
    "understand",
    "fr",
    "queue",
    "collisions",
    "scenarios",
    "workflow",
    "pr",
    "prs",
    "work",
    "issues",
    "secrets",
    "library",
    "tree",
    "status",
    "ui",
    "helper",
    "auth",
    "commit",
    "suggest",
    "push",
    "pull",
    "open",
    "launch",
    "ws",
    "source",
    "sources",
    "peers",
    "spec",
    "help",
    "--help",
    "-h",
    "version",
    "--version",
    "-V",
];

/// What the Rust binary does with an argument list. A repo is the word as
/// typed, None when it was left out (a usage error, said at run time).
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Tree {
        dir: String,
        dirty_only: bool,
    },
    Version,
    Commit {
        repo: Option<String>,
        message: Option<String>,
        all: bool,
        push: bool,
    },
    Push {
        repo: Option<String>,
        drop_stale: bool,
    },
    Pull {
        repo: Option<String>,
    },
    /// One verb's lines from the help, or the whole help when it has none
    /// or no verb was named.
    Help {
        verb: Option<String>,
    },
    /// A verb that is a call to a backend, with the run's `--token` and the
    /// `--backend` it was pointed at.
    Http {
        verb: String,
        rest: Vec<String>,
        token: Option<String>,
        home_base: Option<String>,
    },
    Delegate,
}

/// The verbs canopy-rs sends to a backend itself.
const HTTP_VERBS: &[&str] = &[
    "note",
    "notes",
    "awake",
    "issues",
    "pr",
    "prs",
    "scenarios",
    "sweep",
    "kit",
    "loadouts",
    "groups",
    "work",
    "land",
    "queue",
    "collisions",
    "floorplan",
    "archify",
    "diagnosis",
    "understand",
    "capacity",
    "costs",
    "plugins",
];

/// `flag()` in index.ts: take a bare flag out of the arguments.
fn flag(args: &mut Vec<String>, name: &str) -> bool {
    match args.iter().position(|a| a == name) {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    }
}

/// `opt()` in index.ts: take a flag and the word after it, whatever that
/// word is; a flag with nothing after it stays where it is.
fn opt(args: &mut Vec<String>, name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    if i + 1 >= args.len() {
        return None;
    }
    let value = args.remove(i + 1);
    args.remove(i);
    Some(value)
}

/// `asksHelp()` in core/help.ts: --help or -h before any `--`.
fn asks_help(args: &[String]) -> bool {
    args.iter()
        .take_while(|a| *a != "--")
        .any(|a| a == "--help" || a == "-h")
}

/// A `--backend` (and the word after it) that comes after the repo: index.ts
/// reads only `args[0]` for commit, push and pull, so it is ignored there.
/// One in front of the repo stays, and the verb goes to the TypeScript CLI.
fn drop_backend(a: &mut Vec<String>) {
    if let Some(i) = a.iter().position(|w| w == "--backend")
        && i > 0
    {
        a.remove(i);
        if i < a.len() {
            a.remove(i);
        }
    }
}

/// `PUSH_WORDS` in cli/push.ts: web push's test and list, not a repo.
const PUSH_WORDS: &[&str] = &["test", "ls"];

fn plan(args: &[String]) -> Plan {
    let (cmd, rest) = match args.first() {
        Some(a) if COMMANDS.contains(&a.as_str()) => (Some(a.as_str()), &args[1..]),
        _ => (None, args),
    };
    let flagged = |a: &[String]| a.iter().any(|w| w.starts_with('-'));
    // --help or -h after a verb prints its lines and runs nothing; library
    // has its own help
    if let Some(c) = cmd
        && c != "library"
        && asks_help(rest)
    {
        return Plan::Help {
            verb: Some(c.to_string()),
        };
    }
    // --token is every verb's except source's, which carries a Forgejo token
    if matches!(cmd, Some("source" | "sources")) {
        return Plan::Delegate;
    }
    let mut stripped = rest.to_vec();
    let token = opt(&mut stripped, "--token");
    let rest = stripped.as_slice();
    let pointed = rest.iter().position(|a| a == "--backend");
    match cmd {
        Some("help" | "--help" | "-h") => {
            return Plan::Help {
                verb: rest.first().cloned(),
            };
        }
        Some(verb) if HTTP_VERBS.contains(&verb) => {
            return Plan::Http {
                verb: verb.to_string(),
                rest: rest.to_vec(),
                token,
                home_base: pointed.and_then(|i| rest.get(i + 1).cloned()),
            };
        }
        // commit, push and pull read only the first word left for the repo,
        // so a --backend after it changes nothing; before it, the repo would
        // be "--backend", and that stays with the TypeScript CLI
        Some("commit" | "push" | "pull") => {}
        // another backend for any other local verb: only the TypeScript CLI
        // knows that yet
        _ if pointed.is_some() => return Plan::Delegate,
        _ => {}
    }
    match cmd {
        None | Some("tree") | Some("status") if rest.len() <= 1 && !flagged(rest) => Plan::Tree {
            dir: rest.first().cloned().unwrap_or_else(|| ".".into()),
            dirty_only: cmd == Some("status"),
        },
        Some("version" | "--version" | "-V") if !flagged(rest) => Plan::Version,
        Some("commit") => {
            // flags first, in index.ts's order, so `--all <repo>` never
            // reads "--all" as the repo
            let mut a = rest.to_vec();
            let all = flag(&mut a, "--all");
            let push = flag(&mut a, "--push");
            let ai = flag(&mut a, "--ai");
            let message = match opt(&mut a, "-m") {
                Some(m) => Some(m),
                None => opt(&mut a, "--message"),
            };
            drop_backend(&mut a);
            // --ai asks an agent for the message, which is not ported yet
            if ai || flagged(&a) {
                return Plan::Delegate;
            }
            Plan::Commit {
                repo: a.first().cloned(),
                message,
                all,
                push,
            }
        }
        Some("push") => {
            if rest
                .first()
                .is_some_and(|w| PUSH_WORDS.contains(&w.as_str()))
            {
                return Plan::Delegate;
            }
            let mut a = rest.to_vec();
            let drop_stale = flag(&mut a, "--drop-stale");
            drop_backend(&mut a);
            if flagged(&a) {
                return Plan::Delegate;
            }
            Plan::Push {
                repo: a.first().cloned(),
                drop_stale,
            }
        }
        Some("pull") => {
            let mut a = rest.to_vec();
            drop_backend(&mut a);
            if flagged(&a) {
                return Plan::Delegate;
            }
            Plan::Pull {
                repo: a.first().cloned(),
            }
        }
        _ => Plan::Delegate,
    }
}

/// The palette, as render.ts paints it.
fn paint(seg: &Seg, color: bool) -> String {
    let rgb = |r: u8, g: u8, b: u8| format!("\x1b[38;2;{r};{g};{b}m{}\x1b[0m", seg.text);
    match (color, seg.tone) {
        (false, _) | (true, None) => seg.text.clone(),
        (true, Some(Tone::Moss)) => rgb(147, 201, 139),
        (true, Some(Tone::Lichen)) => rgb(217, 179, 107),
        (true, Some(Tone::Rust)) => rgb(201, 123, 95),
        (true, Some(Tone::Sky)) => rgb(127, 180, 201),
        (true, Some(Tone::Dim)) => format!("\x1b[2m{}\x1b[0m", seg.text),
        (true, Some(Tone::Bold)) => format!("\x1b[1m{}\x1b[0m", seg.text),
    }
}

fn use_color() -> bool {
    std::io::stdout().is_terminal() && std::env::var("NO_COLOR").map_or(true, |v| v.is_empty())
}

async fn tree(dir: &str, dirty_only: bool) -> Result<(), String> {
    let root = resolve(dir);
    let cfg = load_config().map_err(|e| e.to_string())?;
    let mut ignore: Vec<String> = DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect();
    ignore.extend(cfg.ignore);
    let result = scan(
        &root,
        &ScanOptions {
            max_depth: Some(cfg.max_depth),
            ignore: Some(ignore),
            tip_remotes: None,
        },
    )
    .await?;
    let color = use_color();
    let text: Vec<String> = tree_lines(&result.root, &result.repos, dirty_only, now_ms())
        .iter()
        .map(|line| line.iter().map(|s| paint(s, color)).collect())
        .collect();
    println!("{}", text.join("\n"));
    Ok(())
}

fn git_err(e: GitError) -> String {
    e.message().to_string()
}

/// `canopy commit <repo> [-m msg] [--all] [--push]`, in index.ts's order:
/// the usage, the status read, the message, then something staged.
async fn commit_cmd(
    repo: Option<String>,
    message: Option<String>,
    all: bool,
    push_after: bool,
) -> Result<(), String> {
    let repo = resolve(&repo.ok_or("usage: canopy commit <repo>")?);
    let st = get_status(&repo, &StatusOptions::default()).await?;
    let Some(message) = message.filter(|m| !m.is_empty()) else {
        return Err("pass -m \"message\" or --ai".into());
    };
    let staged = st.files.iter().any(|f| f.index != "." && !f.untracked);
    if !staged && !all {
        return Err("nothing staged — pass --all to stage everything".into());
    }
    println!("{}", commit(&repo, &message, all).await.map_err(git_err)?);
    if push_after {
        println!("{}", push(&repo).await.map_err(git_err)?);
    }
    Ok(())
}

/// `canopy push <repo> [--drop-stale]`. With --drop-stale, a push refused
/// over an upstream amend (FR-048) drops the stale copy and pushes what is
/// left; without it the refusal says how.
async fn push_cmd(repo: Option<String>, drop_stale: bool) -> Result<(), String> {
    let arg = repo.ok_or("usage: canopy push <repo> [--drop-stale]")?;
    let repo = resolve(&arg);
    match push(&repo).await {
        Ok(out) => println!("{out}"),
        Err(GitError::StaleCopy { message, offer }) => {
            if !drop_stale {
                return Err(format!(
                    "{message}\n\nRun canopy push {arg} --drop-stale to drop it."
                ));
            }
            let moved = drop_stale_copies(&repo, &newest_stale(&offer.copies), &offer.onto)
                .await
                .map_err(git_err)?;
            println!("{}", moved.out);
            if moved.kept > 0 {
                println!("{}", push(&repo).await.map_err(git_err)?);
            }
        }
        Err(e) => return Err(git_err(e)),
    }
    Ok(())
}

async fn pull_cmd(repo: Option<String>) -> Result<(), String> {
    let repo = resolve(&repo.ok_or("usage: canopy pull <repo>")?);
    println!("{}", pull(&repo).await.map_err(git_err)?);
    Ok(())
}

/// What bin/canopy.ts does with a command's error: its words on stderr and
/// exit 1. Bun's console.error paints a string red when stderr is a
/// terminal and NO_COLOR is unset or empty, so this does too.
fn finish(r: Result<(), String>) -> ExitCode {
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            let red = std::io::stderr().is_terminal()
                && std::env::var("NO_COLOR").map_or(true, |v| v.is_empty());
            if red {
                eprintln!("\x1b[0m\x1b[31m{e}\x1b[0m");
            } else {
                eprintln!("{e}");
            }
            ExitCode::FAILURE
        }
    }
}

/// A backend verb's lines on stdout, or its failure as `finish` says it.
fn finish_lines(r: Result<Vec<String>, String>) -> ExitCode {
    finish(r.map(|lines| {
        for line in lines {
            println!("{line}");
        }
    }))
}

async fn http_verb(
    verb: &str,
    rest: Vec<String>,
    token: Option<String>,
    home_base: Option<String>,
) -> ExitCode {
    let client = ask::Client::new(api::Caller::from_env(token, home_base));
    let caller = client.caller.clone();
    let mut o = out::Out::default();
    let r = match verb {
        "note" | "notes" => {
            return finish_lines(notes::note_cmd(rest, &caller, &client, now_ms() as f64).await);
        }
        "awake" => return finish_lines(awake::awake_cmd(rest, &caller, &client).await),
        "issues" => return finish_lines(issues::issues_cmd(rest, &caller, &client).await),
        "pr" | "prs" => return finish_lines(prs::pr_cmd(verb, rest, &caller, &client).await),
        "scenarios" => scenarios::scenarios_cmd(rest, &caller, &client, &mut o).await,
        "sweep" => sweep::sweep_cmd(rest, &caller, &client, &mut o, now_ms() as f64).await,
        "kit" => kit::kit_cmd(rest, &caller, &client, &mut o).await,
        "loadouts" => loadouts::loadouts_cmd(rest, &caller, &client, &mut o).await,
        "groups" => groups::groups_cmd(rest, &caller, &client, &mut o).await,
        "work" => {
            let cwd = std::env::current_dir()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".into());
            work::work_cmd(rest, &caller, &client, &mut o, &cwd).await
        }
        "floorplan" | "archify" | "diagnosis" | "understand" => {
            let now = || now_ms() as f64;
            let clock = mapsection::Clock {
                now: &now,
                naps: true,
            };
            let cwd = mapsection::here();
            match verb {
                "floorplan" => {
                    floorplan::floorplan_cmd(rest, &caller, &client, &mut o, &cwd, &clock).await
                }
                "archify" => {
                    archify::archify_cmd(rest, &caller, &client, &mut o, &cwd, &clock).await
                }
                "diagnosis" => {
                    diagnosis::diagnosis_cmd(rest, &caller, &client, &mut o, &cwd, &clock).await
                }
                _ => understand::understand_cmd(rest, &caller, &client, &mut o, &cwd, &clock).await,
            }
        }
        "capacity" => {
            let tz = jiff::tz::TimeZone::system();
            capacity::capacity_cmd(
                rest,
                &caller,
                &client,
                &mut o,
                now_ms() as f64,
                &tz,
                use_color(),
            )
            .await
        }
        "costs" => costs::costs_cmd(rest, &caller, &client, &mut o, use_color()).await,
        "plugins" => plugins::plugins_cmd(rest, &caller, &client, &mut o).await,
        _ => land::land_cmd(verb, rest, &caller, &client, &mut o).await,
    };
    finish_out(o, r)
}

/// A verb's kept stdout, then its failure as `finish` says it, or exit 1
/// for a verb that set `process.exitCode`.
fn finish_out(o: out::Out, r: Result<(), String>) -> ExitCode {
    use std::io::Write as _;
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(o.text.as_bytes());
    let _ = stdout.flush();
    match r {
        Err(e) => finish(Err(e)),
        Ok(()) if o.failed => ExitCode::FAILURE,
        Ok(()) => ExitCode::SUCCESS,
    }
}

/// Hand the arguments to the TypeScript CLI and take its exit code.
fn delegate(args: &[String]) -> ExitCode {
    let entry = std::env::var("CANOPY_TS_CLI")
        .unwrap_or_else(|_| format!("{}/bin/canopy.ts", canopy_dir()));
    match Command::new("bun").arg(&entry).args(args).status() {
        Ok(s) => ExitCode::from(s.code().map_or(1, |c| c.clamp(0, 255) as u8)),
        Err(e) => {
            eprintln!("canopy-rs: cannot run bun {entry}: {e}");
            ExitCode::from(127)
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match plan(&args) {
        Plan::Delegate => delegate(&args),
        Plan::Version => {
            println!("canopy {}", version_line(&read_build(&canopy_dir())));
            ExitCode::SUCCESS
        }
        Plan::Tree { dir, dirty_only } => finish(tree(&dir, dirty_only).await),
        Plan::Commit {
            repo,
            message,
            all,
            push,
        } => finish(commit_cmd(repo, message, all, push).await),
        Plan::Push { repo, drop_stale } => finish(push_cmd(repo, drop_stale).await),
        Plan::Pull { repo } => finish(pull_cmd(repo).await),
        Plan::Help { verb } => {
            let text = verb.as_deref().and_then(help::verb_help);
            println!("{}", text.unwrap_or_else(|| help::help(use_color())));
            ExitCode::SUCCESS
        }
        Plan::Http {
            verb,
            rest,
            token,
            home_base,
        } => http_verb(&verb, rest, token, home_base).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn what_runs_here_and_what_goes_to_typescript() {
        assert_eq!(
            plan(&args(&[])),
            Plan::Tree {
                dir: ".".into(),
                dirty_only: false
            }
        );
        assert_eq!(
            plan(&args(&["~/dev"])),
            Plan::Tree {
                dir: "~/dev".into(),
                dirty_only: false
            }
        );
        assert_eq!(
            plan(&args(&["tree", "/x"])),
            Plan::Tree {
                dir: "/x".into(),
                dirty_only: false
            }
        );
        assert_eq!(
            plan(&args(&["status"])),
            Plan::Tree {
                dir: ".".into(),
                dirty_only: true
            }
        );
        assert_eq!(plan(&args(&["-V"])), Plan::Version);
        assert_eq!(plan(&args(&["version"])), Plan::Version);
        assert_eq!(
            plan(&args(&["--token", "x"])),
            Plan::Tree {
                dir: ".".into(),
                dirty_only: false
            },
            "the token goes, as index.ts takes it"
        );
        assert_eq!(plan(&args(&["tree", "a", "b"])), Plan::Delegate);
        assert_eq!(plan(&args(&["runs"])), Plan::Delegate);
        assert_eq!(plan(&args(&["runs", "--token", "t"])), Plan::Delegate);
        assert_eq!(plan(&args(&["version", "--json"])), Plan::Delegate);
        assert_eq!(
            plan(&args(&["tree", "--backend", "http://x"])),
            Plan::Delegate
        );
    }

    #[test]
    fn help_is_answered_here_for_every_verb_but_library() {
        let help = |v: Option<&str>| Plan::Help {
            verb: v.map(String::from),
        };
        assert_eq!(plan(&args(&["tree", "--help"])), help(Some("tree")));
        assert_eq!(plan(&args(&["runs", "start", "-h"])), help(Some("runs")));
        assert_eq!(
            plan(&args(&["run", "x", "--", "-h"])),
            Plan::Delegate,
            "after -- it belongs to another program"
        );
        assert_eq!(plan(&args(&["library", "--help"])), Plan::Delegate);
        assert_eq!(plan(&args(&["help"])), help(None));
        assert_eq!(plan(&args(&["--help"])), help(None));
        assert_eq!(plan(&args(&["help", "note"])), help(Some("note")));
        assert_eq!(
            plan(&args(&["help", "--token", "t", "pr"])),
            help(Some("pr"))
        );
        assert_eq!(plan(&args(&["help", "--help"])), help(Some("help")));
        assert_eq!(
            plan(&args(&["source", "add", "--help"])),
            help(Some("source"))
        );
    }

    #[test]
    fn a_backend_verb_carries_the_token_and_the_backend_it_was_pointed_at() {
        assert_eq!(
            plan(&args(&[
                "note",
                "add",
                "x",
                "--token",
                "t",
                "--backend",
                "http://b:1"
            ])),
            Plan::Http {
                verb: "note".into(),
                rest: args(&["add", "x", "--backend", "http://b:1"]),
                token: Some("t".into()),
                home_base: Some("http://b:1".into()),
            }
        );
        assert_eq!(
            plan(&args(&["prs", "--backend"])),
            Plan::Http {
                verb: "prs".into(),
                rest: args(&["--backend"]),
                token: None,
                home_base: None,
            }
        );
        assert_eq!(
            plan(&args(&["awake", "--token"])),
            Plan::Http {
                verb: "awake".into(),
                rest: args(&["--token"]),
                token: None,
                home_base: None,
            },
            "a --token with nothing after it stays, as opt() leaves it"
        );
        assert_eq!(
            plan(&args(&["sources", "add", "--token", "f"])),
            Plan::Delegate
        );
    }

    #[test]
    fn the_second_batch_of_backend_verbs_runs_here_and_the_rest_still_delegates() {
        for verb in [
            "scenarios",
            "sweep",
            "kit",
            "loadouts",
            "groups",
            "work",
            "land",
            "queue",
            "collisions",
        ] {
            assert!(
                matches!(plan(&args(&[verb])), Plan::Http { verb: v, .. } if v == verb),
                "{verb}"
            );
        }
        for verb in ["run", "runs", "secrets", "people"] {
            assert_eq!(plan(&args(&[verb])), Plan::Delegate, "{verb}");
        }
    }

    #[test]
    fn the_map_section_verbs_run_here() {
        for verb in ["floorplan", "archify", "diagnosis", "understand"] {
            assert!(
                matches!(plan(&args(&[verb, "app"])), Plan::Http { verb: v, .. } if v == verb),
                "{verb}"
            );
            assert_eq!(
                plan(&args(&[verb, "app", "--help"])),
                Plan::Help {
                    verb: Some(verb.into())
                }
            );
        }
    }

    #[test]
    fn capacity_costs_and_plugins_run_here() {
        for verb in ["capacity", "costs", "plugins"] {
            assert!(
                matches!(plan(&args(&[verb])), Plan::Http { verb: v, .. } if v == verb),
                "{verb}"
            );
        }
    }

    #[test]
    fn commit_reads_its_flags_as_index_ts_does() {
        let commit =
            |repo: Option<&str>, message: Option<&str>, all: bool, push: bool| Plan::Commit {
                repo: repo.map(String::from),
                message: message.map(String::from),
                all,
                push,
            };
        assert_eq!(
            plan(&args(&["commit", "--all", "r", "-m", "fix it"])),
            commit(Some("r"), Some("fix it"), true, false)
        );
        assert_eq!(
            plan(&args(&["commit", "-m", "-starts-with-dash", "--push", "r"])),
            commit(Some("r"), Some("-starts-with-dash"), false, true)
        );
        assert_eq!(
            plan(&args(&["commit", "r", "--message", "m"])),
            commit(Some("r"), Some("m"), false, false)
        );
        // -m wins and --message is left behind, which only the TS reads
        assert_eq!(
            plan(&args(&["commit", "r", "-m", "a", "--message", "b"])),
            Plan::Delegate
        );
        assert_eq!(plan(&args(&["commit"])), commit(None, None, false, false));
        assert_eq!(plan(&args(&["commit", "r", "--ai"])), Plan::Delegate);
        assert_eq!(
            plan(&args(&["commit", "r", "-m", "-h"])),
            Plan::Help {
                verb: Some("commit".into())
            },
            "index.ts asks for help before it reads -m"
        );
        assert_eq!(
            plan(&args(&["commit", "r", "--token", "t"])),
            commit(Some("r"), None, false, false)
        );
        assert_eq!(
            plan(&args(&["commit", "r", "-m", "x", "--backend", "http://b"])),
            commit(Some("r"), Some("x"), false, false)
        );
        assert_eq!(
            plan(&args(&["commit", "--backend", "http://b", "r"])),
            Plan::Delegate,
            "index.ts would read --backend as the repo"
        );
        assert_eq!(plan(&args(&["commit", "r", "-m"])), Plan::Delegate);
    }

    #[test]
    fn push_and_pull_take_a_repo_and_web_push_goes_to_typescript() {
        assert_eq!(
            plan(&args(&["push", "r", "--drop-stale"])),
            Plan::Push {
                repo: Some("r".into()),
                drop_stale: true
            }
        );
        assert_eq!(
            plan(&args(&["push"])),
            Plan::Push {
                repo: None,
                drop_stale: false
            }
        );
        assert_eq!(plan(&args(&["push", "test"])), Plan::Delegate);
        assert_eq!(plan(&args(&["push", "ls"])), Plan::Delegate);
        assert_eq!(plan(&args(&["push", "r", "--force"])), Plan::Delegate);
        assert_eq!(
            plan(&args(&["pull", "r"])),
            Plan::Pull {
                repo: Some("r".into())
            }
        );
        assert_eq!(plan(&args(&["pull", "r", "--rebase"])), Plan::Delegate);
        assert_eq!(
            plan(&args(&[
                "push",
                "r",
                "--backend",
                "http://b",
                "--drop-stale"
            ])),
            Plan::Push {
                repo: Some("r".into()),
                drop_stale: true
            }
        );
        assert_eq!(
            plan(&args(&["pull", "r", "--backend"])),
            Plan::Pull {
                repo: Some("r".into())
            }
        );
        assert_eq!(
            plan(&args(&["pull", "--backend", "http://b", "r"])),
            Plan::Delegate
        );
        assert_eq!(
            plan(&args(&["pull", "--help"])),
            Plan::Help {
                verb: Some("pull".into())
            }
        );
    }

    #[test]
    fn the_command_list_matches_the_typescript_cli() {
        let src = std::fs::read_to_string(format!("{}/src/cli/index.ts", canopy_dir())).unwrap();
        let start = src
            .find("export const COMMANDS = new Set([")
            .expect("COMMANDS in index.ts");
        let end = start + src[start..].find("]);").unwrap();
        let ts: Vec<&str> = src[start..end].split('"').skip(1).step_by(2).collect();
        assert_eq!(ts, COMMANDS);
    }
}
