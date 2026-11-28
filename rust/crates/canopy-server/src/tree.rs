//! The tree the clients see (`rebuildResult` and `scanOne` in
//! src/server/index.ts): the launch root, the config's extra folders and
//! the kept worktrees' folder, each scanned as a source of its own, sorted
//! by source and id, with the archived, favorite and harness marks laid on
//! from the config. A forge source, pull request counts and peer states
//! are not ported yet.

use canopy_core::pathx::{basename, join};
use canopy_core::scan::{ScanOptions, launch_source, scan_source};
use canopy_core::store::{harness_paths, paths_of, stored_sources};
use canopy_core::types::{Repo, ScanResult, Source, SourcePlace, SourceState, now_ms};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::cmp::Ordering;

/// the kept worktrees' source id (`TREES_SOURCE` in core/treewords.ts)
pub const TREES_SOURCE: &str = "trees";

/// The trees folder as a source (`treesSource`).
pub fn trees_source(config_dir: &str) -> Source {
    Source {
        id: TREES_SOURCE.into(),
        place: SourcePlace::Local {
            path: join(config_dir, "trees"),
        },
        label: "worktrees".into(),
        launch: false,
    }
}

/// A repo's folder name under a trees root: its basename and the first
/// eight hex digits of its path's sha1 (`repoKey` in core/worktree.ts).
pub fn repo_key(path: &str) -> String {
    let hash = Sha1::digest(path.as_bytes());
    let hex: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let b = basename(path);
    format!("{}-{hex}", if b.is_empty() { "repo" } else { &b })
}

/// A string order close to `localeCompare` in the root locale for the ids
/// canopy makes: symbols before digits before letters, letters without
/// case first, then lower case before upper, then code units.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    fn key(c: char) -> (u8, char) {
        if c.is_ascii_digit() {
            (1, c)
        } else if c.is_alphabetic() {
            (2, c.to_lowercase().next().unwrap_or(c))
        } else {
            (0, c)
        }
    }
    let primary = a.chars().map(key).cmp(b.chars().map(key));
    let case = || {
        a.chars()
            .map(|c| c.is_uppercase())
            .cmp(b.chars().map(|c| c.is_uppercase()))
    };
    primary.then_with(case).then_with(|| a.cmp(b))
}

/// The kept trees' records, by repo path, as `trees.json` beside each
/// local repo's trees holds them: only the slug and branch the cards are
/// named from. The startup pass that squares them with git is not ported.
fn tree_records(root: &str, repos: &[Repo]) -> Vec<(String, Vec<(String, String)>)> {
    let mut out = vec![];
    for r in repos
        .iter()
        .filter(|r| r.host.is_none() && r.path.starts_with('/'))
    {
        let file = join(&join(root, &repo_key(&r.path)), "trees.json");
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let trees: Vec<(String, String)> = v
            .get("trees")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| {
                Some((
                    t.get("slug")?.as_str()?.to_string(),
                    t.get("branch")?.as_str()?.to_string(),
                ))
            })
            .collect();
        if !trees.is_empty() {
            out.push((r.path.clone(), trees));
        }
    }
    out
}

/// The trees source's cards dressed from the records: a tree the records
/// know is named `<repo> ⑂ <branch>` and filed under its checkout's group
/// (`dressTreeCards`).
pub fn dress_tree_cards(tree_repos: Vec<Repo>, others: &[Repo], root: &str) -> Vec<Repo> {
    let records = tree_records(root, others);
    tree_repos
        .into_iter()
        .map(|mut r| {
            for (repo_path, trees) in &records {
                let dir_of = |slug: &str| join(&join(root, &repo_key(repo_path)), slug);
                let Some((_, branch)) = trees.iter().find(|(slug, _)| dir_of(slug) == r.path)
                else {
                    continue;
                };
                let parent = others.iter().find(|o| &o.path == repo_path);
                let name = parent.map_or_else(|| basename(repo_path), |p| p.name.clone());
                r.name = format!("{name} ⑂ {branch}");
                if let Some(p) = parent {
                    r.group = p.group.clone();
                }
                return r;
            }
            r
        })
        .collect()
}

/// Lay a mark on the repos whose path a list holds.
fn mark(repos: &mut [Repo], paths: &[String], set: impl Fn(&mut Repo, bool)) {
    for r in repos.iter_mut() {
        let on = paths.contains(&r.path);
        set(r, on);
    }
}

/// The harness mark while the config has no list yet: local repos whose
/// root package is named canopy, as the first scan's seed would pick them.
/// The Bun server saves that list to the config; this port does not write.
fn seeded_harness(repos: &[Repo]) -> Vec<String> {
    repos
        .iter()
        .filter(|r| r.host.is_none() && r.forge.is_none())
        .filter(|r| {
            std::fs::read_to_string(join(&r.path, "package.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .is_some_and(|m| m.get("name").and_then(Value::as_str) == Some("canopy"))
        })
        .map(|r| r.path.clone())
        .collect()
}

/// Every source scanned and the tree built. A source whose scan fails keeps
/// the repos and counts of the last good tree and says why.
pub async fn build_tree(
    root: &str,
    config_dir: &str,
    raw: &Value,
    opts: &ScanOptions,
    backend: Value,
    last: Option<&ScanResult>,
) -> ScanResult {
    let mut sources = vec![launch_source(root)];
    sources.extend(stored_sources(raw));
    let trees = trees_source(config_dir);
    let trees_root = match &trees.place {
        SourcePlace::Local { path } => path.clone(),
        _ => String::new(),
    };
    sources.push(trees);
    let mut states: Vec<SourceState> = vec![];
    let mut found: Vec<(String, Vec<Repo>)> = vec![];
    for src in &sources {
        let before = last.and_then(|l| l.sources.iter().find(|s| s.source.id == src.id));
        // the Bun server makes the trees folder at its start; this port
        // writes nothing, so a folder not made yet holds no trees
        let unmade = src.id == TREES_SOURCE && !std::path::Path::new(&trees_root).exists();
        let scanned = if unmade {
            Ok(vec![])
        } else {
            scan_source(src, opts).await
        };
        match scanned {
            Ok(repos) => {
                states.push(SourceState {
                    source: src.clone(),
                    repos: repos.len(),
                    scanned_at: now_ms(),
                    error: None,
                });
                found.push((src.id.clone(), repos));
            }
            Err(e) => {
                states.push(SourceState {
                    source: src.clone(),
                    repos: before.map_or(0, |b| b.repos),
                    scanned_at: before.map_or(0, |b| b.scanned_at),
                    error: Some(e),
                });
                let kept = last
                    .map(|l| {
                        l.repos
                            .iter()
                            .filter(|r| r.source == src.id)
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                found.push((src.id.clone(), kept));
            }
        }
    }
    let others: Vec<Repo> = found
        .iter()
        .filter(|(id, _)| id != TREES_SOURCE)
        .flat_map(|(_, r)| r.iter().cloned())
        .collect();
    let mut repos: Vec<Repo> = vec![];
    for (id, list) in found {
        if id == TREES_SOURCE {
            let dressed = dress_tree_cards(list, &others, &trees_root);
            if let Some(s) = states.iter_mut().find(|s| s.source.id == TREES_SOURCE) {
                s.repos = dressed.len();
            }
            repos.extend(dressed);
        } else {
            repos.extend(list);
        }
    }
    let order: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let at = |id: &str| order.iter().position(|o| o == id).unwrap_or(usize::MAX);
    repos.sort_by(|a, b| {
        at(&a.source)
            .cmp(&at(&b.source))
            .then_with(|| locale_cmp(&a.id, &b.id))
    });
    let archived = paths_of(raw, "archived");
    mark(&mut repos, &archived, |r, on| {
        let github = r
            .pulls
            .as_ref()
            .and_then(|p| p.get("archived"))
            .and_then(Value::as_bool)
            == Some(true);
        r.archived = if on {
            Some("canopy".into())
        } else if github {
            Some("github".into())
        } else {
            None
        };
    });
    mark(&mut repos, &paths_of(raw, "favorites"), |r, on| {
        r.favorite = on.then_some(true);
    });
    let harness = harness_paths(raw).unwrap_or_else(|| seeded_harness(&repos));
    mark(&mut repos, &harness, |r, on| r.harness = on.then_some(true));
    ScanResult {
        root: root.into(),
        sources: states,
        repos,
        scanned_at: now_ms(),
        backend,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repo_key_is_the_basename_and_eight_hex_digits_of_the_paths_sha1() {
        // sha1("/r/app") starts 5e1a4c0f
        let k = repo_key("/r/app");
        assert!(k.starts_with("app-"));
        assert_eq!(k.len(), "app-".len() + 8);
        assert!(repo_key("/").starts_with("repo-"));
    }

    #[test]
    fn locale_order_puts_symbols_then_digits_then_letters_without_case() {
        let mut ids = vec!["b", "B", "a-b", "a", "1x", "_z", "ab"];
        ids.sort_by(|a, b| locale_cmp(a, b));
        assert_eq!(ids, ["_z", "1x", "a", "a-b", "ab", "b", "B"]);
    }

    #[tokio::test]
    async fn the_tree_scans_every_source_and_lays_the_config_marks_on() {
        let root = tempfile::tempdir().unwrap();
        let cfg = tempfile::tempdir().unwrap();
        for name in ["web", "app"] {
            let p = root.path().join(name);
            std::fs::create_dir_all(p.join(".git")).unwrap();
        }
        let root_s = root.path().to_str().unwrap();
        let app = format!("{root_s}/app");
        let raw = json!({ "favorites": [app], "archived": [app], "harness": [], "sources": [
            { "id": "gone", "label": "Gone", "kind": "local", "path": "/nonexistent/folder" }
        ]});
        let t = build_tree(
            root_s,
            cfg.path().to_str().unwrap(),
            &raw,
            &ScanOptions::default(),
            json!({ "labels": true }),
            None,
        )
        .await;
        assert_eq!(
            t.sources
                .iter()
                .map(|s| s.source.id.as_str())
                .collect::<Vec<_>>(),
            ["launch", "gone", "trees"]
        );
        assert_eq!(t.sources[2].source.label, "worktrees");
        assert_eq!(
            t.repos.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["app", "web"]
        );
        assert_eq!(t.repos[0].favorite, Some(true));
        assert_eq!(t.repos[0].archived.as_deref(), Some("canopy"));
        assert_eq!(t.repos[1].favorite, None);
        assert_eq!(t.backend, json!({ "labels": true }));
    }

    #[test]
    fn a_tree_the_records_know_is_named_after_its_checkout() {
        let trees = tempfile::tempdir().unwrap();
        let troot = trees.path().to_str().unwrap();
        let parent = Repo {
            id: "app".into(),
            name: "app".into(),
            path: "/r/app".into(),
            group: "apps".into(),
            ..Default::default()
        };
        let key = repo_key("/r/app");
        std::fs::create_dir_all(trees.path().join(&key)).unwrap();
        std::fs::write(
            trees.path().join(&key).join("trees.json"),
            r#"{"trees":[{"slug":"fix-x","branch":"fix/x"}]}"#,
        )
        .unwrap();
        let card = Repo {
            id: "trees:x".into(),
            name: "fix-x".into(),
            path: format!("{troot}/{key}/fix-x"),
            group: "worktrees".into(),
            ..Default::default()
        };
        let stray = Repo {
            id: "trees:y".into(),
            name: "y".into(),
            path: format!("{troot}/{key}/y"),
            ..Default::default()
        };
        let out = dress_tree_cards(vec![card, stray], &[parent], troot);
        assert_eq!(out[0].name, "app ⑂ fix/x");
        assert_eq!(out[0].group, "apps");
        assert_eq!(out[1].name, "y");
    }
}
