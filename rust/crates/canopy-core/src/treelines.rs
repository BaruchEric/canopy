//! The CLI's tree as lines of toned segments (`src/core/treelines.ts`, the
//! tree and spec listings; the drift listing waits on trigger.ts).

use crate::pathx::{js_cmp, js_len, pad_end};
use crate::types::{Repo, SpecState, dirty_count};
use std::collections::BTreeMap;

/// the canopy palette's roles, as the CLI uses them
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Moss,
    Lichen,
    Rust,
    Sky,
    Dim,
    Bold,
}

/// a run of text in one tone; `repo` makes it a link to that repo's panel
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seg {
    pub text: String,
    pub tone: Option<Tone>,
    pub repo: Option<String>,
}

pub type Line = Vec<Seg>;

fn seg(text: impl Into<String>, tone: Option<Tone>) -> Seg {
    Seg {
        text: text.into(),
        tone,
        repo: None,
    }
}

fn plain(text: impl Into<String>) -> Seg {
    seg(text, None)
}

/// a line's plain text, tones dropped
pub fn line_text(line: &[Seg]) -> String {
    line.iter().map(|s| s.text.as_str()).collect()
}

/// How long ago, in the tree's short units. `now` is milliseconds.
pub fn ago(unix_seconds: Option<i64>, now: i64) -> String {
    let Some(at) = unix_seconds.filter(|s| *s != 0) else {
        return String::new();
    };
    let s = (now as f64 / 1000.0 - at as f64).max(0.0);
    let f = |d: f64| (s / d).floor() as i64;
    if s < 3600.0 {
        format!("{}m", f(60.0))
    } else if s < 86400.0 {
        format!("{}h", f(3600.0))
    } else if s < 86400.0 * 30.0 {
        format!("{}d", f(86400.0))
    } else {
        format!("{}mo", f(86400.0 * 30.0))
    }
}

/// ✗ error, ◆ conflict, ● changes, ◐ unpushed, ○ clean
pub fn glyph_seg(r: &Repo) -> Seg {
    if r.error.is_some() {
        return seg("✗", Some(Tone::Rust));
    }
    if r.status
        .as_ref()
        .is_some_and(|s| s.files.iter().any(|f| f.conflicted))
    {
        return seg("◆", Some(Tone::Rust));
    }
    if dirty_count(r) > 0 {
        return seg("●", Some(Tone::Lichen));
    }
    if r.status.as_ref().is_some_and(|s| s.ahead > 0) {
        return seg("◐", Some(Tone::Sky));
    }
    seg("○", Some(Tone::Moss))
}

/// what a repo holds, in words and marks, joined by single spaces
pub fn summary_segs(r: &Repo) -> Vec<Seg> {
    if r.error.is_some() {
        return vec![seg("error", Some(Tone::Rust))];
    }
    let Some(st) = &r.status else { return vec![] };
    let mut parts = Vec::new();
    if !st.files.is_empty() {
        parts.push(seg(
            format!("{} changed", st.files.len()),
            Some(Tone::Lichen),
        ));
    }
    if st.ahead > 0 {
        parts.push(seg(format!("↑{}", st.ahead), Some(Tone::Sky)));
    }
    if st.behind > 0 {
        parts.push(seg(format!("↓{}", st.behind), Some(Tone::Rust)));
    }
    if let Some(tip) = &st.tip
        && Some(&tip.reference) != st.upstream.as_ref()
    {
        parts.push(seg(format!("⇣{}", tip.reference), Some(Tone::Sky)));
    }
    if parts.is_empty() {
        parts.push(seg("clean", Some(Tone::Dim)));
    }
    if let Some(e) = &st.elsewhere {
        if !e.worktrees.is_empty() {
            parts.push(seg(format!("⧉{}", e.worktrees.len()), Some(Tone::Lichen)));
        }
        if !e.branches.is_empty() {
            parts.push(seg(format!("⑂{}", e.branches.len()), Some(Tone::Sky)));
        }
        if let Some(s) = &e.stash {
            parts.push(seg(format!("≡{}", s.count), Some(Tone::Dim)));
        }
    }
    let mut out = Vec::new();
    for (i, p) in parts.into_iter().enumerate() {
        if i > 0 {
            out.push(plain(" "));
        }
        out.push(p);
    }
    out
}

/// whether `canopy status` lists a repo: changes, unpushed work, or an error
pub fn needs_attention(r: &Repo) -> bool {
    dirty_count(r) > 0 || r.status.as_ref().is_some_and(|s| s.ahead > 0) || r.error.is_some()
}

/// `canopy [dir]` and `canopy status`: the repos by group, as a tree
pub fn tree_lines(root: &str, all: &[Repo], dirty_only: bool, now: i64) -> Vec<Line> {
    let repos: Vec<&Repo> = all
        .iter()
        .filter(|r| !dirty_only || needs_attention(r))
        .collect();
    let mut lines: Vec<Line> = vec![vec![seg(root, Some(Tone::Bold))]];
    // insertion order within a group, groups sorted as JavaScript sorts
    let mut order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, Vec<&Repo>> = BTreeMap::new();
    for r in &repos {
        let g = if r.group.is_empty() {
            ".".to_string()
        } else {
            r.group.clone()
        };
        if !groups.contains_key(&g) {
            order.push(g.clone());
        }
        groups.entry(g).or_default().push(r);
    }
    let name_w = repos
        .iter()
        .map(|r| js_len(&r.name))
        .max()
        .unwrap_or(0)
        .max(4);
    let branch_w = repos
        .iter()
        .map(|r| r.status.as_ref().map_or(0, |s| js_len(&s.branch)))
        .max()
        .unwrap_or(0)
        .max(4);
    order.sort_by(|a, b| js_cmp(a, b));
    let n = order.len();
    for (gi, g) in order.iter().enumerate() {
        let last_group = gi == n - 1;
        let members = &groups[g];
        let single = members.len() == 1 && members[0].id == *g;
        if !single {
            lines.push(vec![
                plain(format!("{} ", if last_group { "└─" } else { "├─" })),
                seg(g.clone(), Some(Tone::Bold)),
            ]);
        }
        for (ri, r) in members.iter().enumerate() {
            let last = ri == members.len() - 1;
            let stem = if single {
                (if last_group { "└─" } else { "├─" }).to_string()
            } else {
                format!(
                    "{}{}",
                    if last_group { "   " } else { "│  " },
                    if last { "└─" } else { "├─" }
                )
            };
            let branch = r.status.as_ref().map_or("", |s| s.branch.as_str());
            let mut line = vec![
                plain(format!("{stem} ")),
                glyph_seg(r),
                plain(" "),
                Seg {
                    text: pad_end(&r.name, name_w),
                    tone: None,
                    repo: Some(r.id.clone()),
                },
                plain(" "),
                seg(pad_end(branch, branch_w), Some(Tone::Dim)),
                plain(" "),
            ];
            line.extend(summary_segs(r));
            line.push(plain(" "));
            line.push(seg(
                ago(
                    r.status
                        .as_ref()
                        .and_then(|s| s.last_commit.as_ref())
                        .map(|c| c.at),
                    now,
                ),
                Some(Tone::Dim),
            ));
            lines.push(line);
        }
    }
    if repos.is_empty() {
        let msg = if dirty_only {
            "everything is clean and pushed"
        } else {
            "no git repos under this directory"
        };
        lines.push(vec![seg(msg, Some(Tone::Dim))]);
    }
    lines
}

pub fn spec_word(s: SpecState) -> &'static str {
    match s {
        SpecState::InSync => "spec text in sync",
        SpecState::Behind => "behind",
        SpecState::Drifted => "drifted",
        SpecState::NotAdopted => "not adopted",
    }
}

pub fn spec_tone(s: SpecState) -> Tone {
    match s {
        SpecState::InSync => Tone::Moss,
        SpecState::Behind => Tone::Lichen,
        SpecState::Drifted => Tone::Rust,
        SpecState::NotAdopted => Tone::Dim,
    }
}

/// `canopy spec status`: one line per local checkout the scan read the spec of
pub fn spec_lines(version: Option<&str>, repos: &[Repo]) -> Vec<Line> {
    let mut lines: Vec<Line> = version
        .map(|v| vec![vec![seg(format!("shared repo spec v{v}"), Some(Tone::Dim))]])
        .unwrap_or_default();
    for r in repos {
        let Some(s) = r.spec else { continue };
        lines.push(vec![
            seg(pad_end(spec_word(s), 18), Some(spec_tone(s))),
            plain(" "),
            Seg {
                text: r.id.clone(),
                tone: None,
                repo: Some(r.id.clone()),
            },
        ]);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RepoFile, RepoStatus};

    fn status(branch: &str, n: usize, ahead: i64, behind: i64) -> RepoStatus {
        RepoStatus {
            branch: branch.into(),
            upstream: None,
            ahead,
            behind,
            files: (0..n)
                .map(|i| RepoFile {
                    path: format!("f{i}"),
                    orig: None,
                    index: ".".into(),
                    worktree: "M".into(),
                    untracked: false,
                    conflicted: false,
                    mtime: None,
                })
                .collect(),
            last_commit: None,
            user: None,
            tip: None,
            elsewhere: None,
            lines: None,
        }
    }

    fn repo(id: &str) -> Repo {
        Repo {
            id: id.into(),
            name: id.rsplit('/').next().unwrap().into(),
            group: id.split('/').next().unwrap().into(),
            path: format!("/r/{id}"),
            status: Some(status("main", 0, 0, 0)),
            ..Default::default()
        }
    }

    fn at(n: usize, ahead: i64, behind: i64) -> Repo {
        Repo {
            status: Some(status("m", n, ahead, behind)),
            ..repo("a")
        }
    }

    #[test]
    fn glyph_order() {
        assert_eq!(
            glyph_seg(&Repo {
                error: Some("x".into()),
                ..repo("a")
            }),
            seg("✗", Some(Tone::Rust))
        );
        assert_eq!(glyph_seg(&at(2, 1, 0)).text, "●");
        assert_eq!(glyph_seg(&at(0, 1, 0)).text, "◐");
        assert_eq!(glyph_seg(&repo("a")).text, "○");
    }

    #[test]
    fn summaries_join_by_single_spaces() {
        assert_eq!(line_text(&summary_segs(&at(3, 2, 1))), "3 changed ↑2 ↓1");
        assert_eq!(line_text(&summary_segs(&repo("a"))), "clean");
    }

    #[test]
    fn the_tree_groups_and_links() {
        let lines = tree_lines(
            "/root",
            &[repo("web/app"), repo("web/site"), repo("tool")],
            false,
            0,
        );
        let text: Vec<String> = lines
            .iter()
            .map(|l| line_text(l).trim_end().to_string())
            .collect();
        assert_eq!(
            text,
            vec![
                "/root",
                "├─ ○ tool main clean",
                "└─ web",
                "   ├─ ○ app  main clean",
                "   └─ ○ site main clean"
            ]
        );
        assert_eq!(
            lines[3].iter().find_map(|s| s.repo.clone()).as_deref(),
            Some("web/app")
        );
    }

    #[test]
    fn status_keeps_only_what_needs_attention() {
        let lines = tree_lines(
            "/root",
            &[
                repo("a"),
                Repo {
                    error: Some("boom".into()),
                    ..repo("b")
                },
            ],
            true,
            0,
        );
        assert!(
            lines
                .iter()
                .map(|l| line_text(l))
                .collect::<Vec<_>>()
                .join("\n")
                .contains('b')
        );
        assert!(
            !lines
                .iter()
                .any(|l| l.iter().any(|s| s.repo.as_deref() == Some("a")))
        );
        assert_eq!(
            line_text(&tree_lines("/root", &[repo("a")], true, 0)[1]),
            "everything is clean and pushed"
        );
    }

    #[test]
    fn spec_lines_skip_unread() {
        let lines = spec_lines(
            Some("3"),
            &[
                Repo {
                    spec: Some(SpecState::Drifted),
                    ..repo("a")
                },
                repo("b"),
            ],
        );
        assert_eq!(
            lines.iter().map(|l| line_text(l)).collect::<Vec<_>>(),
            vec![
                "shared repo spec v3".to_string(),
                format!("{} a", pad_end("drifted", 18))
            ]
        );
        assert_eq!(lines[1][0].tone, Some(Tone::Rust));
    }

    #[test]
    fn ago_units() {
        let now = 1_000_000_000_000;
        let s = now / 1000;
        assert_eq!(ago(None, now), "");
        assert_eq!(ago(Some(0), now), "");
        assert_eq!(ago(Some(s - 59), now), "0m");
        assert_eq!(ago(Some(s - 7200), now), "2h");
        assert_eq!(ago(Some(s - 86400 * 3), now), "3d");
        assert_eq!(ago(Some(s - 86400 * 65), now), "2mo");
        assert_eq!(ago(Some(s + 100), now), "0m");
    }
}
