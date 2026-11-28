//! `canopy run` and `canopy runs` (`src/cli/run.ts`): start a branch run
//! or a best-of-N group on a backend, take up a stopped flow, start a
//! child of a live run, and hand every transcript form (show, export,
//! fork, ls, name, stop, say, interrupt, side, model, prune and the bare
//! listing) to `transcripts.rs`.
//!
//! This is also the one copy of run.ts's pickers that other verbs read a
//! backend and a repo with: `selectedTarget`, `repoId`, `folderOf` and
//! `isPathArgument`. The map section's verbs and `worktrees` use them from
//! here. It holds `RUN_ACTIONS` from core/types.ts and `parsePriority`
//! from core/capacity.ts, which nothing else in the port reads yet.

use crate::api::Caller;
use crate::ask::{
    Ask, AskError, Target, did_not_answer, encode_component, every_target, has, is_origin, shift,
    take,
};
use crate::out::Out;
use crate::transcripts::{RUN_USAGE, transcript_cmd};
use canopy_core::group::group_word;
use canopy_core::js::{field, list_at, str_at, template, truthy_at};
use canopy_core::pathx::{js_trim, resolve_from};
use serde_json::{Map, Value, json};

/// `RUNS_USAGE`.
pub const RUNS_USAGE: &str = "usage: canopy runs child <repo> --note text --parent <run> [--action ask|propose] [--backend URL] [--on NAME]";

/// `RUN_ACTIONS` in core/types.ts: what a run is started to do. `compare`
/// is a group's own and never typed here.
pub const RUN_ACTIONS: &[&str] = &["ask", "chat", "propose", "coordinate"];

/// `parsePriority()` in core/capacity.ts: who may go first when the plan's
/// window runs low (FR-036), or None for a word it does not know.
pub fn parse_priority(value: &str) -> Option<&'static str> {
    match value {
        "interactive" => Some("interactive"),
        "normal" => Some("normal"),
        "low" => Some("low"),
        _ => None,
    }
}

/// What the CLI runs in: the folder a path argument and an export's file
/// are read against, the clock the listings age by, and the lines a start
/// says on stderr after its own line (`console.error`).
#[derive(Debug, Default)]
pub(crate) struct RunEnv {
    pub cwd: String,
    pub now: f64,
    pub warned: Vec<String>,
}

/// The folder the CLI runs in, which a path argument and a saved page are
/// read against.
pub(crate) fn here() -> String {
    std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into())
}

/// `RunArgs`: the group-start form as `parseRunArgs` reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunArgs {
    pub repo: String,
    pub action: String,
    pub note: String,
    pub times: u32,
    pub explicit_times: bool,
    pub auto_land: bool,
    pub pr: bool,
    /// one per member, None for the repo's job route; a short list repeats
    /// its last
    pub profiles: Option<Vec<Option<String>>>,
    /// 2 asks a second reviewer, who must agree on the winner; 1 is left off
    pub reviewers: Option<u8>,
    pub priority: Option<String>,
    /// canopy's tools on or off for this start (FR-038); None, the settings'
    pub canopy_tools: Option<bool>,
    pub loadout: Option<String>,
    /// the run's name, trimmed, in place of one cut from its note (FR-073)
    pub name: Option<String>,
    pub backend: Option<String>,
    pub on: Option<String>,
}

/// `/^\d+$/`: ASCII digits and nothing else.
fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `parseRunArgs()`: the group-start form, without changing the caller's
/// arguments, or the words that say what is wrong with it.
pub fn parse_run_args(argv: &[String]) -> Result<RunArgs, String> {
    let mut args = argv.to_vec();
    let flagged = |args: &[String], name: &str| args.iter().any(|a| a == name);
    let backend_flag = flagged(&args, "--backend");
    let backend = take(&mut args, "--backend");
    let on_flag = flagged(&args, "--on");
    let on = take(&mut args, "--on");
    let note_flag = flagged(&args, "-m");
    let note = take(&mut args, "-m");
    let times_flag = flagged(&args, "--times");
    let raw_times = take(&mut args, "--times");
    let profiles_flag = flagged(&args, "--profiles");
    let raw_profiles = take(&mut args, "--profiles");
    let loadout_flag = flagged(&args, "--loadout");
    let loadout = take(&mut args, "--loadout");
    let name_flag = flagged(&args, "--name");
    let name = take(&mut args, "--name");
    let reviewers_flag = flagged(&args, "--reviewers");
    let raw_reviewers = take(&mut args, "--reviewers");
    let auto_land = has(&mut args, "--auto-land");
    let pr = has(&mut args, "--pr");
    let priority_flag = flagged(&args, "--priority");
    let raw_priority = take(&mut args, "--priority");
    let tools_on = has(&mut args, "--tools");
    let tools_off = has(&mut args, "--no-tools");
    if tools_on && tools_off {
        return Err("use either --tools or --no-tools".into());
    }
    if backend_flag && backend.is_none() {
        return Err("--backend needs a value".into());
    }
    if on_flag && on.is_none() {
        return Err("--on needs a value".into());
    }
    if note_flag && note.is_none() {
        return Err("-m needs a note".into());
    }
    if times_flag && raw_times.is_none() {
        return Err("--times needs a value".into());
    }
    if profiles_flag && raw_profiles.is_none() {
        return Err("--profiles needs a list of names".into());
    }
    if loadout_flag && loadout.is_none() {
        return Err("--loadout needs a name".into());
    }
    if name_flag && name.as_deref().is_none_or(|n| js_trim(n).is_empty()) {
        return Err("--name needs the run's name".into());
    }
    let reviewers_ok = matches!(raw_reviewers.as_deref(), Some("1" | "2"));
    if reviewers_flag && !reviewers_ok {
        return Err("--reviewers must be 1 or 2".into());
    }
    let priority = raw_priority.as_deref().map(parse_priority);
    if priority_flag && !matches!(priority, Some(Some(_))) {
        return Err("--priority must be interactive, normal or low".into());
    }
    // apiBase(backend) for a given backend: the value, trailing slashes cut
    if let Some(b) = &backend
        && !is_origin(b.trim_end_matches('/'))
    {
        return Err(format!("--backend must be an http(s) origin, got {b}"));
    }
    if backend.is_some() && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }

    let repo = shift(&mut args).unwrap_or_default();
    let raw_action = shift(&mut args).unwrap_or_default();
    if repo.is_empty() || raw_action.is_empty() || !args.is_empty() {
        return Err(RUN_USAGE.into());
    }
    if !RUN_ACTIONS.contains(&raw_action.as_str()) {
        return Err(format!("unknown run action: {raw_action}"));
    }

    let mut times: f64 = 1.0;
    if let Some(raw) = &raw_times {
        if !all_digits(raw) {
            return Err("--times must be 1, 2, or 3".into());
        }
        times = raw.parse().unwrap_or(f64::INFINITY);
        if !(1.0..=3.0).contains(&times) {
            return Err("--times must be 1, 2, or 3".into());
        }
    }
    let times = times as u32;
    if loadout.as_deref().is_some_and(|l| l != "none") && (times > 1 || profiles_flag) {
        return Err("--loadout starts one run; use --profiles for a group".into());
    }
    if name.is_some() && times > 1 {
        return Err("--name names one run; a group's members share its note".into());
    }
    if name.is_some() && raw_action == "coordinate" {
        return Err("a coordinator takes no name".into());
    }
    if auto_land && times == 1 {
        return Err("--auto-land requires --times 2 or 3".into());
    }
    if profiles_flag && times == 1 {
        return Err("--profiles requires --times 2 or 3".into());
    }
    if reviewers_flag && times == 1 {
        return Err("--reviewers requires --times 2 or 3".into());
    }
    // an empty name is the repo's job route: --profiles ,codex-fast
    let profiles: Option<Vec<Option<String>>> = raw_profiles.as_deref().map(|raw| {
        raw.split(',')
            .map(|n| Some(js_trim(n).to_string()).filter(|n| !n.is_empty()))
            .collect()
    });
    if let Some(p) = &profiles
        && p.len() > times as usize
    {
        return Err(format!(
            "--profiles names {} members; --times says {times}",
            p.len()
        ));
    }

    Ok(RunArgs {
        repo,
        action: raw_action,
        note: note.unwrap_or_default(),
        times,
        explicit_times: times_flag,
        auto_land,
        pr,
        profiles,
        reviewers: (raw_reviewers.as_deref() == Some("2")).then_some(2),
        priority: priority.flatten().map(String::from),
        canopy_tools: (tools_on || tools_off).then_some(tools_on),
        loadout,
        name: name.map(|n| js_trim(&n).to_string()),
        backend,
        on,
    })
}

/// The start's body, in the order runStartCommand writes it.
pub fn start_body(p: &RunArgs) -> Value {
    let mut body = Map::new();
    body.insert("action".into(), json!(p.action));
    body.insert("note".into(), json!(p.note));
    body.insert("branch".into(), json!(true));
    if p.explicit_times {
        body.insert("times".into(), json!(p.times));
    }
    if let Some(profiles) = &p.profiles {
        body.insert("profiles".into(), json!(profiles));
    }
    if let Some(r) = p.reviewers {
        body.insert("reviewers".into(), json!(r));
    }
    if p.auto_land {
        body.insert("autoLand".into(), json!(true));
    }
    if p.pr {
        body.insert("pr".into(), json!(true));
    }
    if let Some(priority) = &p.priority {
        body.insert("priority".into(), json!(priority));
    }
    if let Some(tools) = p.canopy_tools {
        body.insert("canopyTools".into(), json!(tools));
    }
    if let Some(l) = &p.loadout {
        body.insert("loadout".into(), json!(l));
    }
    if let Some(n) = &p.name {
        body.insert("name".into(), json!(n));
    }
    Value::Object(body)
}

/// `ChildArgs`: `canopy runs child`'s words.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChildArgs {
    pub repo: String,
    pub note: String,
    pub parent: String,
    pub action: Option<String>,
    pub backend: Option<String>,
    pub on: Option<String>,
}

/// `parseChildArgs()`: `canopy runs child`'s words, without changing the
/// caller's arguments.
pub fn parse_child_args(argv: &[String]) -> Result<ChildArgs, String> {
    let mut args = argv.to_vec();
    let backend = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    let note = take(&mut args, "--note");
    let parent = take(&mut args, "--parent");
    let action = take(&mut args, "--action");
    if shift(&mut args).as_deref() != Some("child") {
        return Err(RUNS_USAGE.into());
    }
    let repo = shift(&mut args).unwrap_or_default();
    let note_ok = note.as_deref().is_some_and(|n| !js_trim(n).is_empty());
    let parent_ok = parent.as_deref().is_some_and(|p| !p.is_empty());
    if repo.is_empty() || !args.is_empty() || !note_ok || !parent_ok {
        return Err(RUNS_USAGE.into());
    }
    if backend.is_some() && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }
    Ok(ChildArgs {
        repo,
        note: note.unwrap_or_default(),
        parent: parent.unwrap_or_default(),
        action,
        backend,
        on,
    })
}

/// `runsCommand()`: the same start `canopy_run_start` makes, from a shell.
pub(crate) async fn runs_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    cwd: &str,
) -> Result<(), String> {
    let p = parse_child_args(&argv)?;
    let target = selected_target(ask, caller, p.backend.as_deref(), p.on.as_deref()).await?;
    let repo = repo_id(ask, &p.repo, &target, cwd).await?;
    let mut body = Map::new();
    body.insert("repo".into(), json!(repo));
    body.insert("note".into(), json!(p.note));
    body.insert("parent".into(), json!(p.parent));
    if let Some(a) = &p.action {
        body.insert("action".into(), json!(a));
    }
    let run = ask
        .ask(
            &target,
            "POST",
            "/api/runs/child",
            Some(&Value::Object(body)),
        )
        .await
        .map_err(|e| did_not_answer(&target.name, &e))?;
    // `run.branch?.name ?? "its branch"`
    let branch = run
        .get("branch")
        .and_then(|b| b.get("name"))
        .filter(|n| !n.is_null())
        .map_or_else(|| "its branch".to_string(), |n| template(Some(n)));
    out.line(format!(
        "started run {} on {branch}, child of {}",
        field(&run, "id"),
        p.parent
    ));
    Ok(())
}

/// Where `dispatchRunCommand()` sends an argument list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// `canopy run pickup <flow>`
    Pickup,
    /// the bare listing and every transcript form, `transcripts.rs`'s
    Transcripts,
    /// a group or branch start
    Start,
}

/// The words a transcript form starts with, or none for the bare listing.
const TRANSCRIPT_WORDS: &[&str] = &[
    "show",
    "export",
    "fork",
    "prune",
    "say",
    "interrupt",
    "ls",
    "name",
    "stop",
    "side",
    "model",
];

/// The flags whose next word is their value, so never the sub-command.
const VALUE_FLAGS: &[&str] = &[
    "-m",
    "--times",
    "--backend",
    "--on",
    "--priority",
    "--at",
    "--profile",
    "--profiles",
    "--reviewers",
    "--loadout",
    "--name",
];

/// `firstWord()`: the first word that is no flag and no flag's value.
fn first_word(args: &[String]) -> Option<&str> {
    let mut i = 0;
    while i < args.len() {
        let value = args[i].as_str();
        if VALUE_FLAGS.contains(&value) {
            i += 2;
            continue;
        }
        if !value.starts_with('-') {
            return Some(value);
        }
        i += 1;
    }
    None
}

/// `dispatchRunCommand()`'s choice: pickup, a transcript form, or a start.
pub fn route(args: &[String]) -> Route {
    match first_word(args) {
        Some("pickup") => Route::Pickup,
        None => Route::Transcripts,
        Some(w) if TRANSCRIPT_WORDS.contains(&w) => Route::Transcripts,
        Some(_) => Route::Start,
    }
}

/// `runCommand()`: the one `run` dispatch point shared by group starts,
/// pickup and the transcript tools.
pub(crate) async fn run_cmd(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    env: &mut RunEnv,
) -> Result<(), String> {
    match route(&argv) {
        Route::Pickup => pickup(argv, caller, ask, out).await,
        Route::Transcripts => transcript_cmd(argv, caller, ask, out, env).await,
        Route::Start => run_start(argv, caller, ask, out, env).await,
    }
}

/// `canopy run pickup <flow>`: take up a flow a restart or a stop left.
async fn pickup(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let mut args = argv;
    let backend_flag = args.iter().any(|a| a == "--backend");
    let backend = take(&mut args, "--backend");
    let on_flag = args.iter().any(|a| a == "--on");
    let on = take(&mut args, "--on");
    if backend_flag && backend.is_none() {
        return Err("--backend needs a value".into());
    }
    if on_flag && on.is_none() {
        return Err("--on needs a value".into());
    }
    if backend.is_some() && on.is_some() {
        return Err("use either --backend URL or --on NAME".into());
    }
    if shift(&mut args).as_deref() != Some("pickup") {
        return Err(RUN_USAGE.into());
    }
    let id = shift(&mut args).unwrap_or_default();
    if id.is_empty() || !args.is_empty() {
        return Err(RUN_USAGE.into());
    }
    let target = selected_target(ask, caller, backend.as_deref(), on.as_deref()).await?;
    let flow = ask
        .ask(
            &target,
            "POST",
            "/api/flows/pickup",
            Some(&json!({"id": id})),
        )
        .await
        .map_err(|e| did_not_answer(&target.name, &e))?;
    out.line(format!("{} {}", field(&flow, "id"), field(&flow, "status")));
    Ok(())
}

/// `selectedTarget()`: the home backend (`--backend`, else $CANOPY_API,
/// else the local one), or the one `--on` names from the home backend's
/// list. Unlike the listing verbs, a home backend that does not answer
/// the list is a failure here.
pub(crate) async fn selected_target(
    ask: &impl Ask,
    caller: &Caller,
    backend: Option<&str>,
    on: Option<&str>,
) -> Result<Target, String> {
    let home = caller.api_base(backend);
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let Some(name) = on else {
        return Ok(Target::home(&home));
    };
    let targets = every_target(ask, &home)
        .await
        .map_err(|e| did_not_answer("home", &e))?;
    match targets.iter().find(|t| t.name == name) {
        Some(t) => Ok(t.clone()),
        None => Err(format!(
            "no backend named {name}; the home backend lists {}",
            targets
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// `isPathArgument()`: ".", or a path that starts with /, ./, ../ or ~: a
/// folder, not a repo's name.
pub(crate) fn is_path_argument(v: &str) -> bool {
    v == "."
        || v.starts_with('/')
        || v.starts_with("./")
        || v.starts_with("../")
        || v.starts_with('~')
}

/// `folderOf()`: a path argument as the real folder it names, read against
/// `cwd` with a leading `~` read as $HOME, else the failure that says there
/// is none.
pub(crate) fn folder_of(arg: &str, cwd: &str) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".into());
    let tilde = arg == "~" || arg.starts_with("~/");
    let expanded = if tilde {
        format!("{home}{}", &arg[1..])
    } else {
        arg.to_string()
    };
    std::fs::canonicalize(resolve_from(cwd, &expanded))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| format!("no such folder: {arg}"))
}

/// `repoId()`: a repo's id as typed, or, for a path, the id of the repo the
/// backend scans there.
pub(crate) async fn repo_id(
    ask: &impl Ask,
    repo: &str,
    target: &Target,
    cwd: &str,
) -> Result<String, String> {
    if !is_path_argument(repo) {
        return Ok(repo.to_string());
    }
    let path = folder_of(repo, cwd)?;
    let tree = ask
        .ask(target, "GET", "/api/tree", None)
        .await
        .map_err(|e| did_not_answer(&target.name, &e))?;
    match list_at(&tree, "repos")
        .iter()
        .find(|r| str_at(r, "path") == Some(path.as_str()))
    {
        Some(r) => Ok(field(r, "id")),
        None => Err(format!("{} does not scan {path}", target.name)),
    }
}

/// `backendWord()`: a backend as a person would name it, its name, or its
/// address for --backend.
fn backend_word(target: &Target) -> String {
    if target.name == "home" {
        target.urls.first().unwrap_or(&target.name).clone()
    } else {
        target.name.clone()
    }
}

/// `runStartCommand()`: one branch run, or a group of two or three.
async fn run_start(
    argv: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    env: &mut RunEnv,
) -> Result<(), String> {
    let p = parse_run_args(&argv)?;
    let target = selected_target(ask, caller, p.backend.as_deref(), p.on.as_deref()).await?;
    let word = backend_word(&target);
    // a backend from before loadouts would take the body, drop the name and
    // start a plain run with every skill on
    if p.loadout.is_some() {
        match ask.ask(&target, "GET", "/api/loadouts", None).await {
            Ok(_) => {}
            Err(AskError::Refused { status: 404, .. }) => {
                return Err(format!("{word} predates loadouts; redeploy it"));
            }
            Err(e) => return Err(did_not_answer(&target.name, &e)),
        }
    }
    let id = repo_id(ask, &p.repo, &target, &env.cwd).await?;
    let path = format!("/api/repos/run?id={}", encode_component(&id));
    let result = ask
        .ask(&target, "POST", &path, Some(&start_body(&p)))
        .await
        .map_err(|e| did_not_answer(&target.name, &e))?;
    // `"members" in result`: a group record
    if result.get("members").is_some() {
        out.line(format!("{} {}", field(&result, "id"), group_word(&result)));
        return Ok(());
    }
    if p.times > 1 {
        return Err("the backend did not return a group record".into());
    }
    if let Some(l) = p.loadout.as_deref().filter(|l| *l != "none")
        && !truthy_at(&result, "equip")
    {
        return Err(format!(
            "run {} started on {word} without loadout {l}; stop it and redeploy {word}",
            field(&result, "id")
        ));
    }
    out.line(format!(
        "{} {}",
        field(&result, "id"),
        field(&result, "status")
    ));
    // a backend from before run names takes the body and drops the name
    if let Some(name) = &p.name
        && !truthy_at(&result, "name")
    {
        let id = field(&result, "id");
        env.warned.push(format!(
            "run {id} started without its name: {word} runs a canopy from before run names; redeploy it, then canopy run name {id} {name}"
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
