//! `canopy-rs`, the Rust port of the `canopy` CLI (`src/cli/index.ts`).
//!
//! It answers `canopy [dir]`, `canopy tree`, `canopy status` and `canopy
//! version` itself, with output byte for byte the TypeScript CLI's. Every
//! other verb, and any of those four with a flag, still goes to the
//! TypeScript CLI (`bun bin/canopy.ts`) until it is ported, so the binary
//! can stand in for `canopy` today. docs/rust-port.md has the ledger.

use canopy_core::pathx::resolve;
use canopy_core::scan::{DEFAULT_IGNORE, ScanOptions, scan};
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

/// What the Rust binary does with an argument list.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Tree { dir: String, dirty_only: bool },
    Version,
    Delegate,
}

fn plan(args: &[String]) -> Plan {
    let (cmd, rest) = match args.first() {
        Some(a) if COMMANDS.contains(&a.as_str()) => (Some(a.as_str()), &args[1..]),
        _ => (None, args),
    };
    // a flag (--help, --token, --backend, ...) changes what the verb does
    // in ways only the TypeScript CLI knows yet
    if rest.iter().any(|a| a.starts_with('-')) {
        return Plan::Delegate;
    }
    match cmd {
        None | Some("tree") | Some("status") if rest.len() <= 1 => Plan::Tree {
            dir: rest.first().cloned().unwrap_or_else(|| ".".into()),
            dirty_only: cmd == Some("status"),
        },
        Some("version" | "--version" | "-V") => Plan::Version,
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
        Plan::Tree { dir, dirty_only } => match tree(&dir, dirty_only).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
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
        assert_eq!(plan(&args(&["tree", "--help"])), Plan::Delegate);
        assert_eq!(plan(&args(&["--token", "x"])), Plan::Delegate);
        assert_eq!(plan(&args(&["tree", "a", "b"])), Plan::Delegate);
        assert_eq!(plan(&args(&["runs"])), Plan::Delegate);
        assert_eq!(plan(&args(&["help"])), Plan::Delegate);
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
