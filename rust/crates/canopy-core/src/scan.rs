//! Finding repos under a folder, here or over ssh, and reading each one into
//! a card (`src/core/scan.ts`). Forgejo sources are not ported yet.

use crate::exec::{ExecOptions, on_host};
use crate::git::{StatusOptions, futures_join_all, get_status};
use crate::host::{parse_locator, to_locator};
use crate::meta::read_meta;
use crate::pathx::{JS_S, basename, dirname, join, js_sorted_unique, js_trim, relative};
use crate::spec::repo_spec_state;
use crate::store::js_number;
use crate::types::{LAUNCH_SOURCE, Repo, ScanResult, Source, SourcePlace, SourceState, now_ms};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};

/// The incubator's seeds folder at a root (`SEEDS_DIR` in sprout.ts).
pub const SEEDS_DIR: &str = "_incubator";

pub const DEFAULT_IGNORE: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "target",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
    ".Trash",
    "Library",
];

type TipRemotes = dyn Fn(&str) -> Option<Vec<String>> + Send + Sync;

#[derive(Default)]
pub struct ScanOptions {
    /// default 4
    pub max_depth: Option<f64>,
    /// default `DEFAULT_IGNORE`
    pub ignore: Option<Vec<String>>,
    /// which of a repo's remotes (by path) can supply its remote tip: None
    /// means every remote, an empty list none yet
    pub tip_remotes: Option<Box<TipRemotes>>,
}

impl ScanOptions {
    fn depth(&self) -> f64 {
        self.max_depth.unwrap_or(4.0)
    }
    fn ignore_list(&self) -> Vec<String> {
        self.ignore
            .clone()
            .unwrap_or_else(|| DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect())
    }
}

static MODULE_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^{JS_S}*path{JS_S}*={JS_S}*(.+?){JS_S}*$")).unwrap());

/// The `path = …` lines of a `.gitmodules` file, relative to the repo root.
/// A path that would leave the repo is dropped.
pub fn parse_gitmodules(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        let Some(m) = MODULE_PATH.captures(line) else {
            continue;
        };
        let p = m.get(1).map_or("", |g| g.as_str()).trim_end_matches('/');
        if p.is_empty() || p == "." || p.split('/').any(|s| s == "..") {
            continue;
        }
        out.push(p.to_string());
    }
    out
}

/// The checked-out submodules of a local repo: each `.gitmodules` path
/// whose folder holds a `.git` entry.
fn checked_out_submodules(dir: &str) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(join(dir, ".gitmodules")) else {
        return vec![];
    };
    parse_gitmodules(&text)
        .into_iter()
        .filter(|p| std::fs::metadata(join(&join(dir, p), ".git")).is_ok())
        .map(|p| join(dir, &p))
        .collect()
}

fn realpath_or(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
}

/// Directories holding a `.git` entry (a worktree's file counts). Does not
/// descend below a found repo, except into its checked-out submodules.
/// The walk is depth first: at each level the real folders, then the
/// symlinked ones, so a repo reachable both ways keeps its direct path.
pub fn find_repo_dirs(root: &str, opts: &ScanOptions) -> Result<Vec<String>, String> {
    if !std::fs::metadata(root).is_ok_and(|m| m.is_dir()) {
        return Err(format!("not a directory: {root}"));
    }
    let max_depth = opts.depth();
    let ignore: HashSet<String> = opts.ignore_list().into_iter().collect();
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    walk(root, 0, max_depth, &ignore, &mut seen, &mut found);
    Ok(js_sorted_unique(found))
}

fn walk(
    dir: &str,
    depth: u32,
    max_depth: f64,
    ignore: &HashSet<String>,
    seen: &mut HashSet<String>,
    found: &mut Vec<String>,
) {
    if !seen.insert(realpath_or(dir)) {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let entries: Vec<(String, std::fs::FileType)> = rd
        .flatten()
        .filter_map(|e| {
            Some((
                e.file_name().to_string_lossy().into_owned(),
                e.file_type().ok()?,
            ))
        })
        .collect();
    // an agent writes the seeds folder, so a .git there is never a repo
    let seeds_folder = depth == 1 && basename(dir) == SEEDS_DIR;
    if !seeds_folder && entries.iter().any(|(n, _)| n == ".git") {
        found_repo(dir, found);
        return;
    }
    if f64::from(depth) >= max_depth {
        return;
    }
    let visible: Vec<&(String, std::fs::FileType)> = entries
        .iter()
        .filter(|(n, _)| !n.starts_with('.') && !ignore.contains(n))
        .collect();
    let plain: Vec<&String> = visible
        .iter()
        .filter(|(_, t)| t.is_dir())
        .map(|(n, _)| n)
        .collect();
    let linked: Vec<&String> = visible
        .iter()
        .filter(|(n, t)| {
            t.is_symlink() && std::fs::metadata(join(dir, n)).is_ok_and(|m| m.is_dir())
        })
        .map(|(n, _)| n)
        .collect();
    for name in plain.into_iter().chain(linked) {
        walk(&join(dir, name), depth + 1, max_depth, ignore, seen, found);
    }
}

fn found_repo(dir: &str, found: &mut Vec<String>) {
    found.push(dir.to_string());
    for sub in checked_out_submodules(dir) {
        found_repo(&sub, found);
    }
}

/// The `find` that mirrors `find_repo_dirs` on another host.
pub fn find_command(root: &str, opts: &ScanOptions) -> Vec<String> {
    let mut skip: Vec<String> = Vec::new();
    for (i, n) in std::iter::once(".*".to_string())
        .chain(opts.ignore_list())
        .enumerate()
    {
        if i > 0 {
            skip.push("-o".into());
        }
        skip.push("-name".into());
        skip.push(n);
    }
    let mut cmd: Vec<String> = ["find", "-L", root, "-mindepth", "1", "-maxdepth"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    cmd.push(js_number(opts.depth() + 1.0));
    cmd.extend(
        [
            "(",
            "-name",
            ".git",
            "-print0",
            "-prune",
            ")",
            "-o",
            "(",
            "-name",
            ".gitmodules",
            "-print0",
            ")",
            "-o",
            "(",
            "(",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    cmd.extend(skip);
    cmd.extend([")".to_string(), "-prune".into(), ")".into()]);
    cmd
}

/// Drops every dir that sits inside another dir in the list.
pub fn prune_nested(dirs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in js_sorted_unique(dirs.to_vec()) {
        if let Some(last) = out.last()
            && (d == *last || d.starts_with(&format!("{last}/")))
        {
            continue;
        }
        out.push(d);
    }
    out
}

/// The top-level repos plus each shown repo's checked-out submodules down
/// the chain. `modules` maps a repo dir to its `.gitmodules` paths.
pub fn with_submodules(dirs: &[String], modules: &HashMap<String, Vec<String>>) -> Vec<String> {
    let all: HashSet<&String> = dirs.iter().collect();
    let mut out = Vec::new();
    fn visit(
        d: &str,
        all: &HashSet<&String>,
        modules: &HashMap<String, Vec<String>>,
        out: &mut Vec<String>,
    ) {
        out.push(d.to_string());
        for p in modules.get(d).map(Vec::as_slice).unwrap_or_default() {
            let sub = join(d, p);
            if all.contains(&sub) {
                visit(&sub, all, modules, out);
            }
        }
    }
    for d in prune_nested(dirs) {
        visit(&d, &all, modules, &mut out);
    }
    js_sorted_unique(out)
}

/// One `sh` line that prints each file as `path\0contents\0`.
pub fn cat_command(files: &[String]) -> Vec<String> {
    let mut cmd: Vec<String> = [
        "sh",
        "-c",
        r#"for f in "$@"; do printf "%s\0" "$f"; cat "$f" 2>/dev/null; printf "\0"; done"#,
        "sh",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    cmd.extend(files.iter().cloned());
    cmd
}

/// `cat_command`'s output back into a map of repo dir to submodule paths.
pub fn parse_module_dump(text: &str) -> HashMap<String, Vec<String>> {
    let parts: Vec<&str> = text.split('\0').collect();
    let mut out = HashMap::new();
    let mut i = 0;
    while i + 1 < parts.len() {
        let file = parts[i];
        if !file.is_empty() {
            out.insert(dirname(file), parse_gitmodules(parts[i + 1]));
        }
        i += 2;
    }
    out
}

pub async fn find_repo_dirs_remote(
    host: &str,
    root: &str,
    opts: &ScanOptions,
) -> Result<Vec<String>, String> {
    let r = on_host(
        Some(host),
        &find_command(root, opts),
        &ExecOptions {
            timeout_ms: Some(120_000),
            ..Default::default()
        },
    )
    .await;
    // find exits 1 after an unreadable folder while still listing the rest
    if r.code != 0 && r.stdout.is_empty() {
        let msg = js_trim(&r.stderr);
        return Err(if msg.is_empty() {
            format!("find failed on {host}")
        } else {
            msg.to_string()
        });
    }
    let entries: Vec<&str> = r.stdout.split('\0').filter(|e| !e.is_empty()).collect();
    let gits: Vec<String> = entries
        .iter()
        .filter(|e| basename(e) == ".git")
        .map(|g| dirname(g))
        .collect();
    let module_files: Vec<String> = entries
        .iter()
        .filter(|e| basename(e) == ".gitmodules")
        .map(|e| e.to_string())
        .collect();
    let mut modules = HashMap::new();
    if !module_files.is_empty() {
        let c = on_host(
            Some(host),
            &cat_command(&module_files),
            &ExecOptions {
                timeout_ms: Some(60_000),
                ..Default::default()
            },
        )
        .await;
        modules = parse_module_dump(&c.stdout);
    }
    Ok(with_submodules(&gits, &modules))
}

/// Run `f` over every item, at most `limit` at once, keeping their order.
pub async fn with_limit<T, R, F, Fut>(items: &[T], limit: usize, f: F) -> Vec<R>
where
    F: Fn(&T) -> Fut,
    Fut: Future<Output = R>,
{
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let worker = || async {
        loop {
            let i = next.fetch_add(1, Ordering::SeqCst);
            let Some(item) = items.get(i) else { break };
            let r = f(item).await;
            results.lock().expect("results lock")[i] = Some(r);
        }
    };
    futures_join_all((0..limit.min(items.len())).map(|_| worker())).await;
    results
        .into_inner()
        .expect("results lock")
        .into_iter()
        .map(|r| r.expect("every item ran"))
        .collect()
}

pub fn repo_id(root: &str, repo_path: &str) -> String {
    let rel = relative(root, repo_path);
    if rel.is_empty() { ".".into() } else { rel }
}

/// Bare under the launch root, `<source id>:<rel>` elsewhere.
pub fn source_repo_id(source: &Source, rel: &str) -> String {
    if source.launch {
        rel.to_string()
    } else {
        format!("{}:{rel}", source.id)
    }
}

/// The path relative to its source root, back out of a repo id.
pub fn repo_rel(id: &str, source: &str) -> String {
    if source == LAUNCH_SOURCE {
        id.to_string()
    } else {
        id.get(source.len() + 1..).unwrap_or("").to_string()
    }
}

/// The folder heading a repo files under.
pub fn source_group(source: &Source, rel: &str) -> String {
    let top = if rel == "." {
        ""
    } else {
        rel.split('/').next().unwrap_or("")
    };
    if source.launch {
        return top.to_string();
    }
    if top.is_empty() {
        source.label.clone()
    } else {
        format!("{}/{top}", source.label)
    }
}

/// The launch root as a source.
pub fn launch_source(root: &str) -> Source {
    let b = basename(root);
    Source {
        id: LAUNCH_SOURCE.into(),
        place: SourcePlace::Local { path: root.into() },
        label: if b.is_empty() { root.into() } else { b },
        launch: true,
    }
}

fn source_root(source: &Source) -> Result<(Option<String>, String), String> {
    match &source.place {
        SourcePlace::Local { path } => Ok((None, path.clone())),
        SourcePlace::Ssh { host, path } => Ok((Some(host.clone()), path.clone())),
        SourcePlace::Forgejo { .. } => Err("forgejo sources are not in the Rust port yet".into()),
    }
}

/// Every repo under one source, with status and meta read. Fails when the
/// root cannot be listed; a repo that will not read becomes a card with an
/// error instead.
pub async fn scan_source(source: &Source, opts: &ScanOptions) -> Result<Vec<Repo>, String> {
    let (host, root) = source_root(source)?;
    let dirs = match &host {
        // the walk is blocking file work, kept off the async workers
        None => {
            let (r, max_depth, ignore) = (root.clone(), opts.max_depth, opts.ignore.clone());
            tokio::task::spawn_blocking(move || {
                find_repo_dirs(
                    &r,
                    &ScanOptions {
                        max_depth,
                        ignore,
                        tip_remotes: None,
                    },
                )
            })
            .await
            .map_err(|e| e.to_string())??
        }
        Some(h) => find_repo_dirs_remote(h, &root, opts).await?,
    };
    Ok(with_limit(&dirs, 8, |dir| {
        let host = host.clone();
        let rel = repo_id(&root, dir);
        let dir = dir.clone();
        async move {
            let path = to_locator(host.as_deref(), &dir);
            let tip_remotes = opts.tip_remotes.as_ref().and_then(|f| f(&path));
            let st_opts = StatusOptions { tip_remotes };
            let (meta, status) = tokio::join!(read_meta(&path), get_status(&path, &st_opts));
            let spec = if host.is_none() {
                let d = dir.clone();
                tokio::task::spawn_blocking(move || repo_spec_state(&d, None))
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            let (status, error) = match status {
                Ok(s) => (Some(s), None),
                Err(e) => (None, Some(format!("Error: {e}"))),
            };
            Repo {
                id: source_repo_id(source, &rel),
                name: basename(&dir),
                path,
                group: source_group(source, &rel),
                source: source.id.clone(),
                host,
                link: meta.link,
                description: meta.description,
                remotes: meta.remotes,
                spec,
                status,
                error,
                ..Default::default()
            }
        }
    })
    .await)
}

/// One local root on its own: the CLI's tree.
pub async fn scan(root: &str, opts: &ScanOptions) -> Result<ScanResult, String> {
    let source = launch_source(root);
    let repos = scan_source(&source, opts).await?;
    let scanned_at = now_ms();
    Ok(ScanResult {
        root: root.into(),
        sources: vec![SourceState {
            source,
            repos: repos.len(),
            scanned_at,
            error: None,
        }],
        repos,
        scanned_at,
        // what this backend can do; openers.ts is not ported yet
        backend: serde_json::Value::Null,
    })
}

/// Re-read a single repo after a mutation or a file event.
pub async fn refresh_repo(repo: &Repo, tip_remotes: Option<Vec<String>>) -> Repo {
    if repo.forge.is_some() {
        return repo.clone();
    }
    let mut out = repo.clone();
    match get_status(&repo.path, &StatusOptions { tip_remotes }).await {
        Ok(s) => {
            out.status = Some(s);
            out.error = None;
        }
        Err(e) => {
            out.status = None;
            out.error = Some(format!("Error: {e}"));
        }
    }
    out
}

/// Whether a repo lives on another host.
pub fn repo_host(path: &str) -> Option<String> {
    parse_locator(path).host
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::exec;

    fn mk(root: &str, rel: &str) {
        std::fs::create_dir_all(join(root, rel)).unwrap();
    }

    fn fixture() -> (tempfile::TempDir, String) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().to_string_lossy().into_owned();
        for p in ["a/repo1", "a/repo2", "b/deep/repo3"] {
            mk(&root, &format!("{p}/.git"));
        }
        mk(&root, "a/node_modules/dep/.git");
        mk(&root, "a/repo1/sub/.git");
        mk(&root, "b/deep/repo3/mods/one/.git");
        mk(&root, "b/deep/repo3/mods/one/inner/.git");
        mk(&root, "b/deep/repo3/mods/two");
        std::fs::write(
            join(&root, "b/deep/repo3/.gitmodules"),
            "[submodule \"one\"]\n\tpath = mods/one\n\turl = x\n[submodule \"two\"]\n\tpath = mods/two\n\turl = y\n",
        )
        .unwrap();
        std::fs::write(
            join(&root, "b/deep/repo3/mods/one/.gitmodules"),
            "[submodule \"inner\"]\n\tpath = inner\n\turl = z\n",
        )
        .unwrap();
        mk(&root, "c/empty");
        (t, root)
    }

    fn rels(root: &str, dirs: &[String]) -> Vec<String> {
        dirs.iter().map(|d| repo_id(root, d)).collect()
    }

    #[test]
    fn the_seeds_folder_is_never_a_repo() {
        let t = tempfile::tempdir().unwrap();
        let w = t.path().to_string_lossy().into_owned();
        mk(&w, "_incubator/.git");
        mk(&w, "_incubator/coin/.git");
        mk(&w, "x/_incubator/.git");
        let dirs = find_repo_dirs(&w, &ScanOptions::default()).unwrap();
        assert!(dirs.contains(&join(&w, "_incubator/coin")));
        assert!(!dirs.contains(&join(&w, "_incubator")));
        assert!(dirs.contains(&join(&w, "x/_incubator")));
    }

    #[test]
    fn shared_copies_under_the_seeds_folder_never_become_cards() {
        let t = tempfile::tempdir().unwrap();
        let w = t.path().to_string_lossy().into_owned();
        mk(&w, "_incubator/coin/.git");
        mk(&w, "_incubator/.shared/workspace/sp_1/.git");
        assert_eq!(
            find_repo_dirs(&w, &ScanOptions::default()).unwrap(),
            vec![join(&w, "_incubator/coin")]
        );
    }

    #[test]
    fn finds_repos_skips_ignored_and_stops_at_roots_except_submodules() {
        let (_t, root) = fixture();
        let dirs = find_repo_dirs(&root, &ScanOptions::default()).unwrap();
        assert_eq!(
            rels(&root, &dirs),
            vec![
                "a/repo1",
                "a/repo2",
                "b/deep/repo3",
                "b/deep/repo3/mods/one",
                "b/deep/repo3/mods/one/inner"
            ]
        );
        let shallow = find_repo_dirs(
            &root,
            &ScanOptions {
                max_depth: Some(2.0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rels(&root, &shallow), vec!["a/repo1", "a/repo2"]);
        assert!(find_repo_dirs(&join(&root, "nope"), &ScanOptions::default()).is_err());
    }

    #[test]
    fn a_symlinked_folder_is_walked_once() {
        let (_t, root) = fixture();
        std::os::unix::fs::symlink(join(&root, "a"), join(&root, "link-to-a")).unwrap();
        std::os::unix::fs::symlink(&root, join(&root, "c/loop")).unwrap();
        let dirs = find_repo_dirs(&root, &ScanOptions::default()).unwrap();
        assert_eq!(
            rels(&root, &dirs),
            vec![
                "a/repo1",
                "a/repo2",
                "b/deep/repo3",
                "b/deep/repo3/mods/one",
                "b/deep/repo3/mods/one/inner"
            ]
        );
    }

    #[test]
    fn gitmodules_paths() {
        let text = "[submodule \"a\"]\n  path = services/a/\n  url = u\n[submodule \"b\"]\npath=b\n[submodule \"x\"]\n  path = ../out\n  path = .\n";
        assert_eq!(parse_gitmodules(text), vec!["services/a", "b"]);
    }

    #[test]
    fn with_submodules_keeps_the_chain() {
        let dirs: Vec<String> = [
            "/d/homelab",
            "/d/homelab/services/gate",
            "/d/homelab/services/gate/inner",
            "/d/homelab/vendor/plain",
            "/d/other",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let modules: HashMap<String, Vec<String>> = [
            (
                "/d/homelab".to_string(),
                vec!["services/gate".to_string(), "services/missing".to_string()],
            ),
            (
                "/d/homelab/services/gate".to_string(),
                vec!["inner".to_string()],
            ),
        ]
        .into();
        assert_eq!(
            with_submodules(&dirs, &modules),
            vec![
                "/d/homelab",
                "/d/homelab/services/gate",
                "/d/homelab/services/gate/inner",
                "/d/other"
            ]
        );
    }

    #[test]
    fn the_cat_dump_parses() {
        let cmd = cat_command(&["/d/homelab/.gitmodules".into()]);
        assert_eq!(&cmd[..2], ["sh", "-c"]);
        assert_eq!(cmd.last().unwrap(), "/d/homelab/.gitmodules");
        let m = parse_module_dump(
            "/d/homelab/.gitmodules\0[submodule \"g\"]\n\tpath = services/gate\n\0/d/x/.gitmodules\0\0",
        );
        assert_eq!(
            m.get("/d/homelab").unwrap(),
            &vec!["services/gate".to_string()]
        );
        assert!(m.get("/d/x").unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_cat_line_really_prints() {
        let (_t, root) = fixture();
        let r = exec(
            &cat_command(&[join(&root, "b/deep/repo3/mods/one/.gitmodules")]),
            &ExecOptions::default(),
        )
        .await;
        assert_eq!(r.code, 0);
        assert_eq!(
            parse_module_dump(&r.stdout)
                .get(&join(&root, "b/deep/repo3/mods/one"))
                .unwrap(),
            &vec!["inner".to_string()]
        );
    }

    #[test]
    fn the_find_mirrors_the_walk() {
        let cmd = find_command(
            "/home/me/dev",
            &ScanOptions {
                max_depth: Some(2.0),
                ignore: Some(vec!["node_modules".into()]),
                ..Default::default()
            },
        );
        assert_eq!(&cmd[..3], ["find", "-L", "/home/me/dev"]);
        let i = cmd.iter().position(|a| a == "-maxdepth").unwrap();
        assert_eq!(cmd[i + 1], "3");
        assert!(cmd.contains(&"-print0".to_string()) && cmd.contains(&".gitmodules".to_string()));
        assert_eq!(
            &cmd[cmd.len() - 10..],
            [
                "(",
                "(",
                "-name",
                ".*",
                "-o",
                "-name",
                "node_modules",
                ")",
                "-prune",
                ")"
            ]
        );
    }

    #[test]
    fn a_repo_inside_a_repo_counts_once() {
        let dirs: Vec<String> = [
            "/d/a/repo1/sub",
            "/d/a/repo1",
            "/d/b/repo2",
            "/d/a/repo1",
            "/d/a/repo10",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            prune_nested(&dirs),
            vec!["/d/a/repo1", "/d/a/repo10", "/d/b/repo2"]
        );
    }

    fn extra() -> Source {
        Source {
            id: "wsl-dev".into(),
            place: SourcePlace::Ssh {
                host: "wsl".into(),
                path: "/home/me/dev".into(),
            },
            label: "wsl:dev".into(),
            launch: false,
        }
    }

    #[test]
    fn source_ids_and_groups() {
        let launch = launch_source("/Users/me/dev");
        assert_eq!(source_repo_id(&launch, "web-apps/ripe"), "web-apps/ripe");
        assert_eq!(
            source_repo_id(&extra(), "web-apps/ripe"),
            "wsl-dev:web-apps/ripe"
        );
        assert_eq!(source_repo_id(&extra(), "."), "wsl-dev:.");
        assert_eq!(repo_rel("web-apps/ripe", "launch"), "web-apps/ripe");
        assert_eq!(
            repo_rel("wsl-dev:web-apps/ripe", "wsl-dev"),
            "web-apps/ripe"
        );
        assert_eq!(repo_rel("wsl-dev:.", "wsl-dev"), ".");
        assert_eq!(source_group(&launch, "web-apps/ripe"), "web-apps");
        assert_eq!(source_group(&launch, "."), "");
        assert_eq!(source_group(&extra(), "web-apps/ripe"), "wsl:dev/web-apps");
        assert_eq!(source_group(&extra(), "ripe"), "wsl:dev/ripe");
        assert_eq!(source_group(&extra(), "."), "wsl:dev");
        assert_eq!(
            serde_json::to_value(&launch).unwrap(),
            serde_json::json!({"id":"launch","kind":"local","path":"/Users/me/dev","label":"dev","launch":true})
        );
    }

    #[tokio::test]
    async fn a_local_extra_source_scans_with_prefixed_ids() {
        let (_t, root) = fixture();
        let src = Source {
            id: "extra".into(),
            place: SourcePlace::Local { path: root.clone() },
            label: "extra".into(),
            launch: false,
        };
        let repos = scan_source(
            &src,
            &ScanOptions {
                max_depth: Some(2.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            repos.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["extra:a/repo1", "extra:a/repo2"]
        );
        assert!(
            repos
                .iter()
                .all(|r| r.source == "extra" && r.host.is_none())
        );
        assert_eq!(repos[0].group, "extra/a");
    }

    #[tokio::test]
    async fn scan_reads_a_real_repo_and_survives_a_fake_one() {
        let (_t, root) = fixture();
        let repo = join(&root, "a/repo1");
        std::fs::remove_dir_all(join(&repo, ".git")).unwrap();
        let g = |args: &[&str]| {
            let mut v = vec![
                "git",
                "-C",
                &repo,
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
            ];
            v.extend_from_slice(args);
            v.into_iter().map(String::from).collect::<Vec<_>>()
        };
        exec(&g(&["init", "-q", "-b", "main"]), &ExecOptions::default()).await;
        std::fs::write(join(&repo, "hello.txt"), "hi\n").unwrap();
        exec(&g(&["add", "hello.txt"]), &ExecOptions::default()).await;
        exec(
            &g(&["commit", "-q", "-m", "add hello"]),
            &ExecOptions::default(),
        )
        .await;
        let result = scan(&root, &ScanOptions::default()).await.unwrap();
        let r1 = result.repos.iter().find(|r| r.id == "a/repo1").unwrap();
        assert_eq!(
            r1.status
                .as_ref()
                .unwrap()
                .last_commit
                .as_ref()
                .unwrap()
                .subject,
            "add hello"
        );
        assert_eq!(r1.group, "a");
        assert_eq!(r1.spec, Some(crate::types::SpecState::NotAdopted));
        let r2 = result.repos.iter().find(|r| r.id == "a/repo2").unwrap();
        assert!(r2.status.is_none());
        assert!(r2.error.as_ref().unwrap().starts_with("Error: "));
        assert_eq!(result.sources.len(), 1);
        assert!(result.sources[0].source.launch);
        assert_eq!(result.sources[0].repos, result.repos.len());
        assert!(result.repos.iter().all(|r| r.source == "launch"));
    }
}
