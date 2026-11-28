//! `canopy fr` (`src/cli/fr.ts`): feature numbers for the repo the shell
//! sits in (FR-076). `reserve` takes the next free number before a session
//! writes it anywhere, `next` says what it would be, the bare command lists
//! who holds what, and `check` fails on a list that gives one number to two
//! entries. It runs git here and asks no backend: a reservation is a ref in
//! the repo itself, so every worktree of the repo sees it at once, and
//! origin carries it to the other machines. The names and the words are
//! canopy-core's `fr.rs`.

use crate::ask::{has, take};
use crate::out::Out;
use canopy_core::exec::{ExecOptions, ExecResult, exec};
use canopy_core::fr::{
    FR_FILE, FR_REFS, FrHolder, FrReservation, FrWhere, fr_duplicates, fr_entries, fr_id, fr_line,
    fr_message, fr_next, fr_of_ref, fr_ref, parse_fr_message, utf16_prefix,
};
use canopy_core::pathx::{join, js_trim, js_ws};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::IsTerminal;

/// `FR_USAGE`.
pub const FR_USAGE: &str = "usage: canopy fr [list] [--all] [--json] [-C dir]
       canopy fr next [-C dir]
       canopy fr reserve [-m title] [--json] [-C dir]
       canopy fr check [-C dir]";

/// What the command was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrAct {
    List { all: bool },
    Next,
    Reserve { title: String },
    Check,
}

/// `FrArgs`: the command's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrArgs {
    pub dir: Option<String>,
    pub json: bool,
    pub act: FrAct,
}

/// `parseFrArgs()`: the command's words, without changing the caller's
/// list, or the usage that says what is wrong.
pub fn parse_fr_args(argv: &[String]) -> Result<FrArgs, String> {
    let mut args = argv.to_vec();
    let dir = take(&mut args, "-C");
    let title = take(&mut args, "-m");
    let json = has(&mut args, "--json");
    let all = has(&mut args, "--all");
    let word = args.first().cloned().unwrap_or_else(|| "list".into());
    if args.len() > 1 || word.starts_with('-') {
        return Err(FR_USAGE.into());
    }
    if title.is_some() && word != "reserve" {
        return Err(format!("-m goes with reserve\n\n{FR_USAGE}"));
    }
    if all && word != "list" {
        return Err(format!("--all goes with list\n\n{FR_USAGE}"));
    }
    let act = match word.as_str() {
        "list" => FrAct::List { all },
        "next" => FrAct::Next,
        "reserve" => FrAct::Reserve {
            title: title.unwrap_or_default(),
        },
        "check" => FrAct::Check,
        _ => return Err(FR_USAGE.into()),
    };
    Ok(FrArgs { dir, json, act })
}

/// how long a call to origin may take before canopy carries on without it
const REMOTE_MS: u64 = 20_000;
/// how many numbers a reserve tries before it gives up: each miss means
/// another session took that one first
const TRIES: usize = 25;
/// the most branches whose copy of the list is read
const BRANCHES_MAX: usize = 300;
const REMOTE: &str = "origin";

/// git in a folder, never asking at a terminal
async fn git_in(cwd: &str, args: &[&str], timeout_ms: u64) -> ExecResult {
    let mut cmd = vec!["git"];
    cmd.extend_from_slice(args);
    exec(
        &cmd,
        &ExecOptions {
            cwd: Some(cwd.into()),
            timeout_ms: Some(timeout_ms),
            env: vec![("GIT_TERMINAL_PROMPT".into(), "0".into())],
            ..Default::default()
        },
    )
    .await
}

async fn git(cwd: &str, args: &[&str]) -> ExecResult {
    git_in(cwd, args, 15_000).await
}

/// `s.split(/\s+/)`: a leading or trailing run of whitespace leaves an
/// empty word, as JavaScript's split does.
fn split_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_ws = false;
    for (i, c) in s.char_indices() {
        if js_ws(c) {
            if !in_ws {
                out.push(&s[start..i]);
                in_ws = true;
            }
        } else if in_ws {
            start = i;
            in_ws = false;
        }
    }
    out.push(if in_ws { "" } else { &s[start..] });
    out
}

/// `frRoot()`: the repo's root for a folder, or a refusal.
pub async fn fr_root(dir: &str) -> Result<String, String> {
    let r = git(dir, &["rev-parse", "--show-toplevel"]).await;
    if r.code != 0 {
        return Err(format!("{dir} is not in a git repository"));
    }
    Ok(js_trim(&r.stdout).to_string())
}

async fn has_remote(root: &str) -> bool {
    git(root, &["remote", "get-url", REMOTE]).await.code == 0
}

/// Brings origin's branches and reservations here. False when origin did
/// not answer, which leaves what was fetched before. A reservation made
/// here that origin holds differently is left alone: git refuses to replace
/// it, and the rest still arrive.
async fn fetch_remote(root: &str) -> bool {
    // the repo's own refspecs, so a clone of one branch stays one, then the reservations
    let key = format!("remote.{REMOTE}.fetch");
    let own_out = git(root, &["config", "--get-all", &key]).await.stdout;
    let own: Vec<&str> = own_out.split('\n').filter(|l| !l.is_empty()).collect();
    let default = format!("+refs/heads/*:refs/remotes/{REMOTE}/*");
    let reservations = format!("{FR_REFS}/*:{FR_REFS}/*");
    let mut args = vec!["fetch", "-q", REMOTE];
    if own.is_empty() {
        args.push(&default);
    } else {
        args.extend(own.iter().copied());
    }
    args.push(&reservations);
    if git_in(root, &args, REMOTE_MS).await.code == 0 {
        return true;
    }
    // a refused ref fails the fetch though origin answered: ask it one thing more
    git_in(root, &["ls-remote", REMOTE, "HEAD"], REMOTE_MS)
        .await
        .code
        == 0
}

/// A reservation in this repo's refs.
#[derive(Debug, Clone)]
struct Local {
    n: u64,
    sha: String,
    at: i64,
    holder: FrHolder,
}

/// `Number(s)` for git's unix seconds: a whole number, else 0 (what
/// `Number(when) * 1000 || 0` leaves for a field that is not one).
fn unix_ms(when: &str) -> i64 {
    js_trim(when)
        .parse::<f64>()
        .ok()
        .filter(|s| s.is_finite())
        .map_or(0, |s| (s * 1000.0) as i64)
}

/// The reservations in this repo's refs: number, commit, message and time.
async fn local_reservations(root: &str) -> Vec<Local> {
    // one record per ref, fields and records split by bytes no message holds
    let r = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents)%1e",
            FR_REFS,
        ],
    )
    .await;
    if r.code != 0 {
        return Vec::new();
    }
    let mut out: Vec<Local> = Vec::new();
    for record in r.stdout.split('\x1e') {
        let record = record.strip_prefix('\n').unwrap_or(record);
        let mut fields = record.split('\x1f');
        let refname = fields.next().unwrap_or("");
        let sha = fields.next().unwrap_or("");
        let when = fields.next().unwrap_or("");
        let message = fields.next().unwrap_or("");
        if let Some(n) = fr_of_ref(refname)
            && !sha.is_empty()
        {
            out.push(Local {
                n,
                sha: sha.into(),
                at: unix_ms(when),
                holder: parse_fr_message(message),
            });
        }
    }
    out.sort_by_key(|r| r.n);
    out
}

fn numbers(rs: &[Local]) -> Vec<u64> {
    rs.iter().map(|r| r.n).collect()
}

/// Every copy of the list this repo can see: the file in each worktree,
/// written or not yet committed, and the one each branch holds, origin's
/// branches included.
async fn list_copies(root: &str) -> Vec<String> {
    let mut texts = Vec::new();
    let trees = git(root, &["worktree", "list", "--porcelain"]).await;
    let paths: Vec<String> = if trees.code == 0 {
        trees
            .stdout
            .split('\n')
            .filter_map(|l| l.strip_prefix("worktree "))
            .map(String::from)
            .collect()
    } else {
        vec![root.to_string()]
    };
    let mut seen = HashSet::new();
    for path in std::iter::once(root.to_string()).chain(paths) {
        if !seen.insert(path.clone()) {
            continue;
        }
        // a worktree whose folder is out of reach from here: its branch is read below
        if let Ok(bytes) = std::fs::read(join(&path, FR_FILE)) {
            texts.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    let remotes = format!("refs/remotes/{REMOTE}");
    let refs = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            &remotes,
        ],
    )
    .await;
    for r in refs
        .stdout
        .split('\n')
        .filter(|l| !l.is_empty())
        .take(BRANCHES_MAX)
    {
        let spec = format!("{r}:{FR_FILE}");
        let shown = git(root, &["show", &spec]).await;
        if shown.code == 0 {
            texts.push(shown.stdout);
        }
    }
    texts
}

/// The list as origin's default branch holds it, or as the local one does
/// where there is no origin; empty when neither has one.
async fn landed_list(root: &str) -> String {
    let head_ref = format!("refs/remotes/{REMOTE}/HEAD");
    let head = git(root, &["symbolic-ref", "-q", "--short", &head_ref]).await;
    let first = if head.code == 0 {
        js_trim(&head.stdout).to_string()
    } else {
        String::new()
    };
    let candidates = [
        first,
        format!("{REMOTE}/main"),
        format!("{REMOTE}/master"),
        "main".into(),
        "master".into(),
    ];
    for r in candidates.iter().filter(|r| !r.is_empty()) {
        let spec = format!("{r}:{FR_FILE}");
        let shown = git(root, &["show", &spec]).await;
        if shown.code == 0 {
            return shown.stdout;
        }
    }
    String::new()
}

/// `frNextHere()`: the next free number as this repo sees it now, origin
/// asked first.
pub async fn fr_next_here(root: &str) -> u64 {
    if has_remote(root).await {
        fetch_remote(root).await;
    }
    fr_next(
        &list_copies(root).await,
        &numbers(&local_reservations(root).await),
    )
}

/// `frHolderHere()`: who a reservation made in this shell belongs to,
/// `env` standing for process.env.
pub async fn fr_holder_here(
    root: &str,
    title: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> FrHolder {
    let session = env("CLAUDE_CODE_SESSION_ID").unwrap_or_default();
    let thread = env("CODEX_THREAD_ID")
        .or_else(|| env("CODEX_SESSION_ID"))
        .unwrap_or_default();
    let by = [
        env("TAILCHAN_AS").unwrap_or_default(),
        if session.is_empty() {
            String::new()
        } else {
            format!("claude-{}", utf16_prefix(&session, 6))
        },
        if thread.is_empty() {
            String::new()
        } else {
            format!("codex-{}", utf16_prefix(&thread, 6))
        },
        env("USER").unwrap_or_default(),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap_or_else(|| "someone".into());
    let branch = js_trim(&git(root, &["branch", "--show-current"]).await.stdout).to_string();
    FrHolder {
        title: title.into(),
        by,
        branch,
        backend: env("CANOPY_BACKEND").unwrap_or_default(),
    }
}

/// `crypto.randomUUID()`: a version 4 UUID from the system's random bytes.
fn random_uuid() -> String {
    use std::io::Read as _;
    let mut b = [0u8; 16];
    let read = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    if read.is_err() {
        // no /dev/urandom: the clock and the process, which still differ
        // between two sessions
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let mixed = t ^ (u128::from(std::process::id()) << 64);
        b = mixed.to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// A commit with no files that carries a reservation's words. git wants a
/// name on a commit, so a machine with none set gets canopy's.
async fn empty_commit(root: &str, message: &str) -> Result<String, String> {
    let tree = exec(
        &["git", "mktree"],
        &ExecOptions {
            cwd: Some(root.into()),
            input: Some(String::new()),
            timeout_ms: Some(15_000),
            ..Default::default()
        },
    )
    .await;
    if tree.code != 0 {
        return Err(format!(
            "git could not make an empty tree: {}",
            js_trim(&tree.stderr)
        ));
    }
    let named = git(root, &["config", "user.name"]).await.code == 0
        && git(root, &["config", "user.email"]).await.code == 0;
    let mut cmd = vec!["git"];
    if !named {
        cmd.extend([
            "-c",
            "user.name=canopy",
            "-c",
            "user.email=canopy@localhost",
        ]);
    }
    cmd.extend(["commit-tree", js_trim(&tree.stdout)]);
    let r = exec(
        &cmd,
        &ExecOptions {
            cwd: Some(root.into()),
            input: Some(message.into()),
            timeout_ms: Some(15_000),
            ..Default::default()
        },
    )
    .await;
    if r.code != 0 {
        return Err(format!(
            "git could not write the reservation: {}",
            js_trim(&r.stderr)
        ));
    }
    Ok(js_trim(&r.stdout).to_string())
}

/// `FrReserved`: the number a reserve took.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrReserved {
    pub n: u64,
    pub id: String,
    #[serde(rename = "ref")]
    pub ref_: String,
    /// origin holds it too; false means only this machine knows
    pub shared: bool,
    /// why it is not shared, when it is not
    pub note: Option<String>,
}

/// `frReserve()`: takes the next free number for this repo and returns it.
/// The ref is made only when none is there, so a second session in this
/// repo, in any of its worktrees, gets the number after. Then the ref is
/// pushed without force: when another machine pushed the same number
/// first, origin refuses, this one is dropped and the next is tried. With
/// no origin, or one that does not answer, the reservation stands on this
/// machine and says so.
pub async fn fr_reserve(root: &str, holder: &FrHolder) -> Result<FrReserved, String> {
    let remote = has_remote(root).await;
    for i in 0..TRIES {
        let online = remote && fetch_remote(root).await;
        if online && i == 0 {
            share_waiting(root).await;
        }
        let n = fr_next(
            &list_copies(root).await,
            &numbers(&local_reservations(root).await),
        );
        let r = fr_ref(n);
        let sha = empty_commit(root, &fr_message(n, holder, &random_uuid())).await?;
        // an empty old value: make the ref only when there is none
        if git(root, &["update-ref", &r, &sha, ""]).await.code != 0 {
            continue;
        }
        let reserved = |shared: bool, note: Option<String>| FrReserved {
            n,
            id: fr_id(n),
            ref_: r.clone(),
            shared,
            note,
        };
        if !remote {
            return Ok(reserved(
                false,
                Some(format!(
                    "this repo has no {REMOTE}, so only this machine knows"
                )),
            ));
        }
        if !online {
            return Ok(reserved(
                false,
                Some(format!(
                    "{REMOTE} did not answer, so only this machine knows until canopy fr runs here again with it back"
                )),
            ));
        }
        let spec = format!("{r}:{r}");
        let pushed = git_in(root, &["push", "-q", REMOTE, &spec], REMOTE_MS).await;
        if pushed.code == 0 {
            return Ok(reserved(true, None));
        }
        let theirs = git_in(root, &["ls-remote", REMOTE, &r], REMOTE_MS).await;
        let held = if theirs.code == 0 {
            split_ws(js_trim(&theirs.stdout))[0].to_string()
        } else {
            String::new()
        };
        if theirs.code == 0 && !held.is_empty() && held != sha {
            // another machine took it first: drop ours, the next fetch brings theirs
            git(root, &["update-ref", "-d", &r, &sha]).await;
            continue;
        }
        if held == sha {
            return Ok(reserved(true, None));
        }
        let why = js_trim(&pushed.stderr)
            .split('\n')
            .next_back()
            .unwrap_or("no reason given")
            .to_string();
        return Ok(reserved(
            false,
            Some(format!(
                "{REMOTE} would not take it ({why}), so only this machine knows"
            )),
        ));
    }
    Err(format!(
        "no free number after {TRIES} tries; canopy fr list shows who holds what"
    ))
}

/// Shares the reservations made while origin was away. Best effort: one
/// origin refuses stays as it is, and `list` says so.
async fn share_waiting(root: &str) {
    let pattern = format!("{FR_REFS}/*");
    let remote = git_in(root, &["ls-remote", REMOTE, &pattern], REMOTE_MS).await;
    if remote.code != 0 {
        return;
    }
    let there: HashSet<&str> = remote
        .stdout
        .split('\n')
        .map(|l| split_ws(l).get(1).copied().unwrap_or(""))
        .collect();
    let waiting: Vec<String> = local_reservations(root)
        .await
        .iter()
        .map(|r| fr_ref(r.n))
        .filter(|r| !there.contains(r.as_str()))
        .collect();
    if !waiting.is_empty() {
        let specs: Vec<String> = waiting.iter().map(|r| format!("{r}:{r}")).collect();
        let mut args = vec!["push", "-q", REMOTE];
        args.extend(specs.iter().map(String::as_str));
        git_in(root, &args, REMOTE_MS).await;
    }
}

/// `frList()`: the reservations this repo knows, lowest number first, each
/// with whether origin holds it and whether the list already has its entry.
pub async fn fr_list(root: &str) -> Vec<FrReservation> {
    let remote = has_remote(root).await;
    if remote && fetch_remote(root).await {
        share_waiting(root).await;
    }
    let mut there: HashMap<String, String> = HashMap::new();
    if remote {
        let pattern = format!("{FR_REFS}/*");
        let r = git_in(root, &["ls-remote", REMOTE, &pattern], REMOTE_MS).await;
        if r.code == 0 {
            for line in r.stdout.split('\n') {
                let words = split_ws(line);
                let sha = words.first().copied().unwrap_or("");
                let name = words.get(1).copied().unwrap_or("");
                if !name.is_empty() {
                    there.insert(name.into(), sha.into());
                }
            }
        }
    }
    let listed: HashSet<u64> = fr_entries(&landed_list(root).await).into_iter().collect();
    local_reservations(root)
        .await
        .into_iter()
        .map(|r| {
            let where_ = match there.get(&fr_ref(r.n)) {
                Some(theirs) if *theirs == r.sha => FrWhere::Shared,
                Some(theirs) if !theirs.is_empty() => FrWhere::Clash,
                _ => FrWhere::Here,
            };
            FrReservation {
                n: r.n,
                id: fr_id(r.n),
                holder: r.holder,
                at: r.at,
                where_,
                listed: listed.contains(&r.n),
            }
        })
        .collect()
}

/// `frCheck()`: the numbers the list in this folder gives to two entries.
pub fn fr_check(root: &str) -> Vec<u64> {
    match std::fs::read(join(root, FR_FILE)) {
        Ok(bytes) => fr_duplicates(&String::from_utf8_lossy(&bytes)),
        Err(_) => Vec::new(),
    }
}

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

/// `ageWord()` in cli/worktrees.ts: "2h", "3d", "5m", "now". A private copy
/// until worktrees.ts is ported.
fn age_word(ms: i64) -> String {
    let age = ms.max(0);
    if age < MINUTE {
        "now".into()
    } else if age < HOUR {
        format!("{}m", age / MINUTE)
    } else if age < DAY {
        format!("{}h", age / HOUR)
    } else {
        format!("{}d", age / DAY)
    }
}

/// `JSON.stringify(v, null, 2)`.
fn pretty<T: Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// `console.error(s)`: Bun paints it red when stderr is a terminal and
/// NO_COLOR is unset or empty.
fn say_err(s: &str) {
    let red =
        std::io::stderr().is_terminal() && std::env::var("NO_COLOR").map_or(true, |v| v.is_empty());
    if red {
        eprintln!("\x1b[0m\x1b[31m{s}\x1b[0m");
    } else {
        eprintln!("{s}");
    }
}

/// `frCommand()`: `cwd` is the shell's folder, `env` stands for
/// process.env, `now` for Date.now().
pub(crate) async fn fr_cmd(
    args: Vec<String>,
    cwd: &str,
    env: &dyn Fn(&str) -> Option<String>,
    now: i64,
    out: &mut Out,
) -> Result<(), String> {
    let parsed = parse_fr_args(&args)?;
    let root = fr_root(parsed.dir.as_deref().unwrap_or(cwd)).await?;
    match parsed.act {
        FrAct::Next => out.line(fr_id(fr_next_here(&root).await)),
        FrAct::Reserve { title } => {
            let got = fr_reserve(&root, &fr_holder_here(&root, &title, env).await).await?;
            if parsed.json {
                out.line(pretty(&got));
            } else {
                out.line(&got.id);
                if let Some(note) = &got.note {
                    say_err(&format!("canopy fr: {note}"));
                }
            }
        }
        FrAct::Check => {
            let twice = fr_check(&root);
            if !twice.is_empty() {
                let ids: Vec<String> = twice.into_iter().map(fr_id).collect();
                return Err(format!(
                    "{FR_FILE} gives one number to two entries: {}. Keep the entry that landed first and take a new number for the other with canopy fr reserve",
                    ids.join(", ")
                ));
            }
            out.line(format!("{FR_FILE} gives every number once"));
        }
        FrAct::List { all: every } => {
            let all = fr_list(&root).await;
            let shown: Vec<&FrReservation> = all.iter().filter(|r| every || !r.listed).collect();
            if parsed.json {
                out.line(pretty(&shown));
                return Ok(());
            }
            let ago =
                |ms: i64| format!("{} ago", age_word(now - ms)).replace("now ago", "just now");
            for r in &shown {
                out.line(fr_line(r, ago));
            }
            let hidden = all.len() - shown.len();
            if shown.is_empty() {
                out.line(if hidden > 0 {
                    "no number is reserved and waiting for its entry"
                } else {
                    "no number is reserved here"
                });
            }
            if hidden > 0 {
                out.line(format!(
                    "{hidden} more {} entry in the list already (--all shows them)",
                    if hidden == 1 { "has its" } else { "have their" }
                ));
            }
            let reserved: Vec<u64> = all.iter().map(|r| r.n).collect();
            out.line(format!(
                "next free: {}",
                fr_id(fr_next(&list_copies(&root).await, &reserved))
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
