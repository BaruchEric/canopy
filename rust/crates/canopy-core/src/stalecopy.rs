//! A local commit that upstream holds an amended copy of (FR-048,
//! `docs/superpowers/specs/2026-11-02-push-amend-design.md`), the port of
//! `src/core/stalecopy.ts`. Pure: gitwrite.rs gathers the facts and moves
//! the branch, and the page reads an offer off a refused push.

use crate::pathx::js_trim_end;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// One commit as the match reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitFacts {
    pub hash: String,
    /// how many parents: a merge has two or more
    pub parents: usize,
    /// author time, unix seconds
    pub at: i64,
    pub email: String,
    /// subject and body as git keeps them, trailing whitespace off
    pub message: String,
}

/// A stale local commit and the upstream commit that is its amend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaleCopy {
    pub stale: String,
    pub copy: String,
    pub subject: String,
}

/// What a refused push offers: drop `copies` (oldest first) by moving
/// `branch` onto `onto`, the tip of `upstream`, keeping the `kept` local
/// commits that came after them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaleOffer {
    pub branch: String,
    pub upstream: String,
    pub onto: String,
    pub copies: Vec<StaleCopy>,
    pub kept: i64,
}

/// what `log` prints for each commit, read back by `parse_commits`
pub const COMMIT_FORMAT: &str = "%H%x1f%P%x1f%at%x1f%ae%x1f%B%x1e";

pub fn parse_commits(out: &str) -> Vec<CommitFacts> {
    let mut commits = Vec::new();
    for record in out.split('\x1e') {
        let fields: Vec<&str> = record.trim_start_matches('\n').split('\x1f').collect();
        let (Some(hash), Some(at), Some(email)) = (fields.first(), fields.get(2), fields.get(3))
        else {
            continue;
        };
        if hash.is_empty() {
            continue;
        }
        let parents = fields.get(1).copied().unwrap_or("");
        commits.push(CommitFacts {
            hash: hash.to_string(),
            parents: parents.split(' ').filter(|p| !p.is_empty()).count(),
            at: crate::git::js_int(at),
            email: email.to_string(),
            message: js_trim_end(&fields[4.min(fields.len())..].join("\x1f")).to_string(),
        });
    }
    commits
}

pub fn subject_of(c: &CommitFacts) -> String {
    c.message.split('\n').next().unwrap_or("").to_string()
}

fn short(hash: &str) -> String {
    hash.chars().take(7).collect()
}

fn commits(n: i64) -> String {
    format!("{n} commit{}", if n == 1 { "" } else { "s" })
}

/// An amend keeps the message, the author and the author time.
pub fn same_commit(a: &CommitFacts, b: &CommitFacts) -> bool {
    a.message == b.message && a.at == b.at && a.email == b.email
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pair {
    pub stale: CommitFacts,
    pub copy: CommitFacts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pairing {
    Pairs(Vec<Pair>),
    Ambiguous(String),
}

/// Each local commit with the upstream commit that matches it. A local
/// commit matching two upstream ones, or two local commits matching one,
/// cannot say which is the amend.
pub fn pair_copies(local: &[CommitFacts], upstream: &[CommitFacts]) -> Pairing {
    let mut pairs = Vec::new();
    let mut taken: HashSet<&str> = HashSet::new();
    for stale in local {
        let found: Vec<&CommitFacts> = upstream.iter().filter(|u| same_commit(stale, u)).collect();
        if found.len() > 1 {
            return Pairing::Ambiguous(format!(
                "{} has {} commits upstream with its message and author time, so canopy cannot tell which one is its amend.",
                short(&stale.hash),
                found.len()
            ));
        }
        let Some(copy) = found.first() else {
            continue;
        };
        if taken.contains(copy.hash.as_str()) {
            return Pairing::Ambiguous(format!(
                "More than one local commit has the message and author time of upstream's {}, so canopy cannot tell which one it amends.",
                short(&copy.hash)
            ));
        }
        taken.insert(&copy.hash);
        pairs.push(Pair {
            stale: stale.clone(),
            copy: (*copy).clone(),
        });
    }
    Pairing::Pairs(pairs)
}

static NUMSTAT_RECORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^([0-9]+|-)\t([0-9]+|-)\t(.*)$").expect("regex"));

/// The paths, of `paths`, where `diff --numstat -z --no-renames` from the
/// stale commit to its copy removes a line or sees a binary change: the
/// files whose lines the copy leaves out.
pub fn lines_left_out(paths: &[String], numstat: &str) -> Vec<String> {
    let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    for record in numstat.split('\0') {
        let Some(m) = NUMSTAT_RECORD.captures(record) else {
            continue;
        };
        let removed = m.get(2).map_or("", |g| g.as_str());
        let path = m.get(3).map_or("", |g| g.as_str());
        if wanted.contains(path) && removed != "0" {
            out.push(path.to_string());
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StaleVerdict {
    None,
    Refuse { why: String },
    Drop { copies: Vec<StaleCopy>, kept: i64 },
}

/// Whether the local commits (merge base to HEAD, oldest first) start with
/// stale copies canopy can drop with one `rebase --onto`. `left_out` holds,
/// per stale hash, the files whose lines its copy leaves out; a stale
/// commit missing from it counts as not checked.
pub fn judge_copies(
    local: &[CommitFacts],
    pairing: &Pairing,
    left_out: &HashMap<String, Vec<String>>,
) -> StaleVerdict {
    let pairs = match pairing {
        Pairing::Ambiguous(why) => return StaleVerdict::Refuse { why: why.clone() },
        Pairing::Pairs(p) => p,
    };
    let Some(first) = pairs.first() else {
        return StaleVerdict::None;
    };
    if local.iter().any(|c| c.parents > 1) {
        return StaleVerdict::Refuse {
            why: format!(
                "Upstream holds an amended copy of {}, but the branch has merge commits of its own, which moving it would flatten.",
                short(&first.stale.hash)
            ),
        };
    }
    for (i, Pair { stale, .. }) in pairs.iter().enumerate() {
        if local.get(i).map(|c| &c.hash) != Some(&stale.hash) {
            let at = local
                .iter()
                .position(|c| c.hash == stale.hash)
                .map_or(-1, |p| p as i64);
            return StaleVerdict::Refuse {
                why: format!(
                    "Upstream holds an amended copy of {}, but it sits on {} of your own that upstream lacks, and moving the branch past it would drop those too.",
                    short(&stale.hash),
                    commits(at - i as i64)
                ),
            };
        }
    }
    for Pair { stale, copy } in pairs {
        let files = left_out.get(&stale.hash);
        if files.is_none_or(|f| !f.is_empty()) {
            let named = match files {
                Some(f) if !f.is_empty() => format!(" in {}", f.join(", ")),
                _ => String::new(),
            };
            return StaleVerdict::Refuse {
                why: format!(
                    "Upstream's {} has the message and author time of {}, but it leaves out lines {} has{named}, so canopy will not drop it.",
                    short(&copy.hash),
                    short(&stale.hash),
                    short(&stale.hash)
                ),
            };
        }
    }
    StaleVerdict::Drop {
        copies: pairs
            .iter()
            .map(|Pair { stale, copy }| StaleCopy {
                stale: stale.hash.clone(),
                copy: copy.hash.clone(),
                subject: subject_of(stale),
            })
            .collect(),
        kept: local.len() as i64 - pairs.len() as i64,
    }
}

/// The sentence a refused push adds about the copies, and what dropping
/// them does.
pub fn offer_words(o: &StaleOffer) -> String {
    let one = if o.copies.len() == 1 {
        o.copies.first()
    } else {
        None
    };
    let head = match one {
        Some(c) => format!(
            "Upstream holds an amended copy of {} {} ({}: same message and author time, and every line {} left in its files).",
            short(&c.stale),
            c.subject,
            short(&c.copy),
            short(&c.stale)
        ),
        None => format!(
            "Upstream holds amended copies of {}: {}. Each has the same message and author time, and every line the stale one left in its files.",
            commits(o.copies.len() as i64),
            o.copies
                .iter()
                .map(|c| format!("{} {} ({})", short(&c.stale), c.subject, short(&c.copy)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    let keep = if o.kept > 0 {
        format!(
            " and keeps the {} after {}",
            commits(o.kept),
            if one.is_some() { "it" } else { "them" }
        )
    } else {
        String::new()
    };
    format!(
        "{head} Dropping the stale {} moves {} onto {} with git rebase --onto{keep}.",
        if one.is_some() { "copy" } else { "copies" },
        o.branch,
        o.upstream
    )
}

/// The button's words.
pub fn offer_action(o: &StaleOffer) -> String {
    format!(
        "drop the stale {}{}",
        if o.copies.len() == 1 {
            "copy"
        } else {
            "copies"
        },
        if o.kept > 0 { " and push" } else { "" }
    )
}

static FULL_HASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$").expect("regex"));

/// a whole commit hash, sha1 or sha256: what the offer carries and the
/// action takes back, so nothing shorter can name a different commit
pub fn is_full_hash(v: &Value) -> bool {
    v.as_str().is_some_and(|s| FULL_HASH.is_match(s))
}

/// An offer as it came over the wire, or false.
pub fn is_stale_offer(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    o.get("branch").is_some_and(Value::is_string)
        && o.get("upstream").is_some_and(Value::is_string)
        && o.get("onto").is_some_and(is_full_hash)
        && o.get("kept").is_some_and(Value::is_number)
        && o.get("copies").and_then(Value::as_array).is_some_and(|cs| {
            !cs.is_empty()
                && cs.iter().all(|c| {
                    c.as_object().is_some_and(|r| {
                        r.get("stale").is_some_and(is_full_hash)
                            && r.get("copy").is_some_and(is_full_hash)
                            && r.get("subject").is_some_and(Value::is_string)
                    })
                })
        })
}

/// the newest stale commit, which `rebase --onto` names as the old base
pub fn newest_stale(copies: &[StaleCopy]) -> String {
    copies.last().map(|c| c.stale.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn h(c: &str) -> String {
        c.repeat(40)
    }

    fn commit(hash: &str, message: &str) -> CommitFacts {
        CommitFacts {
            hash: hash.into(),
            parents: 1,
            at: 1_790_000_000,
            email: "e@x.invalid".into(),
            message: message.into(),
        }
    }

    fn clean(hashes: &[&str]) -> HashMap<String, Vec<String>> {
        hashes.iter().map(|x| (x.to_string(), vec![])).collect()
    }

    fn pairs(p: &Pairing) -> Vec<(String, String)> {
        match p {
            Pairing::Pairs(ps) => ps
                .iter()
                .map(|x| (x.stale.hash.clone(), x.copy.hash.clone()))
                .collect(),
            Pairing::Ambiguous(_) => panic!("ambiguous"),
        }
    }

    fn pair(stale: &CommitFacts, copy: &CommitFacts) -> Pairing {
        Pairing::Pairs(vec![Pair {
            stale: stale.clone(),
            copy: copy.clone(),
        }])
    }

    fn why(v: &StaleVerdict) -> &str {
        match v {
            StaleVerdict::Refuse { why } => why,
            _ => panic!("not a refusal: {v:?}"),
        }
    }

    #[test]
    fn parse_commits_reads_the_log_format_back_body_and_all() {
        let out = [
            format!(
                "{}\x1f{}\x1f1790000000\x1fe@x.invalid\x1ffix nav\n\nthe body\n\x1e",
                h("a"),
                h("0")
            ),
            format!(
                "\n{}\x1f{} {}\x1f1790000060\x1fo@x.invalid\x1fmerge\n\x1e\n",
                h("b"),
                h("a"),
                h("c")
            ),
        ]
        .join("");
        assert_eq!(
            parse_commits(&out),
            vec![
                CommitFacts {
                    hash: h("a"),
                    parents: 1,
                    at: 1_790_000_000,
                    email: "e@x.invalid".into(),
                    message: "fix nav\n\nthe body".into()
                },
                CommitFacts {
                    hash: h("b"),
                    parents: 2,
                    at: 1_790_000_060,
                    email: "o@x.invalid".into(),
                    message: "merge".into()
                },
            ]
        );
    }

    #[test]
    fn parse_commits_a_root_commit_has_no_parents_and_nothing_reads_as_nothing() {
        let c = parse_commits(&format!("{}\x1f\x1f1\x1fe\x1fone\n\x1e", h("a")));
        assert_eq!(c[0].parents, 0);
        assert_eq!(parse_commits(""), vec![]);
    }

    #[test]
    fn pair_copies_an_amend_keeps_the_message_the_author_time_and_the_email() {
        let local = [commit(&h("a"), "fix nav\n\nbody"), commit(&h("b"), "mine")];
        let upstream = [
            commit(&h("c"), "fix nav\n\nbody"),
            commit(&h("d"), "theirs"),
        ];
        assert_eq!(
            pairs(&pair_copies(&local, &upstream)),
            vec![(h("a"), h("c"))]
        );
    }

    #[test]
    fn pair_copies_a_different_body_time_or_author_is_another_commit() {
        let a = commit(&h("a"), "fix nav\n\nbody");
        let others = [
            commit(&h("c"), "fix nav\n\nother body"),
            CommitFacts {
                at: 1,
                ..commit(&h("c"), "fix nav\n\nbody")
            },
            CommitFacts {
                email: "o@x.invalid".into(),
                ..commit(&h("c"), "fix nav\n\nbody")
            },
        ];
        for other in others {
            assert_eq!(
                pair_copies(std::slice::from_ref(&a), &[other]),
                Pairing::Pairs(vec![])
            );
        }
    }

    #[test]
    fn pair_copies_two_candidates_either_way_cannot_say_which_is_the_amend() {
        let a = commit(&h("a"), "same");
        assert!(matches!(
            pair_copies(
                std::slice::from_ref(&a),
                &[commit(&h("c"), "same"), commit(&h("d"), "same")]
            ),
            Pairing::Ambiguous(_)
        ));
        assert!(matches!(
            pair_copies(&[a, commit(&h("b"), "same")], &[commit(&h("c"), "same")]),
            Pairing::Ambiguous(_)
        ));
    }

    fn sv(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn lines_left_out_a_file_the_copy_removes_a_line_from_or_changes_as_binary() {
        let numstat = [
            "3\t0\tkept.txt",
            "1\t1\tedited.txt",
            "-\t-\tlogo.png",
            "0\t4\tnot-ours.txt",
            "",
        ]
        .join("\0");
        assert_eq!(
            lines_left_out(&sv(&["kept.txt", "edited.txt", "logo.png"]), &numstat),
            sv(&["edited.txt", "logo.png"])
        );
    }

    #[test]
    fn lines_left_out_a_path_with_a_tab_or_a_newline_in_it_is_read_whole() {
        assert_eq!(
            lines_left_out(&sv(&["a\tb\nc"]), "0\t2\ta\tb\nc\0"),
            sv(&["a\tb\nc"])
        );
    }

    #[test]
    fn lines_left_out_files_the_copy_leaves_alone_are_not_listed() {
        assert_eq!(lines_left_out(&sv(&["f.txt"]), ""), Vec::<String>::new());
    }

    #[test]
    fn judge_copies_no_copy_upstream_is_no_offer() {
        let b = commit(&h("b"), "mine");
        assert_eq!(
            judge_copies(&[b], &Pairing::Pairs(vec![]), &HashMap::new()),
            StaleVerdict::None
        );
    }

    #[test]
    fn judge_copies_the_oldest_local_commit_with_a_superset_copy_is_dropped() {
        let (a, b, c) = (
            commit(&h("a"), "fix nav"),
            commit(&h("b"), "mine"),
            commit(&h("c"), "fix nav"),
        );
        assert_eq!(
            judge_copies(&[a.clone(), b], &pair(&a, &c), &clean(&[&h("a")])),
            StaleVerdict::Drop {
                copies: vec![StaleCopy {
                    stale: h("a"),
                    copy: h("c"),
                    subject: "fix nav".into()
                }],
                kept: 1
            }
        );
    }

    #[test]
    fn judge_copies_a_copy_that_leaves_lines_out_is_refused_naming_the_files() {
        let (a, c) = (commit(&h("a"), "fix nav"), commit(&h("c"), "fix nav"));
        let left = HashMap::from([(h("a"), sv(&["f.txt"]))]);
        let v = judge_copies(std::slice::from_ref(&a), &pair(&a, &c), &left);
        assert!(why(&v).contains("leaves out lines aaaaaaa has in f.txt"));
    }

    #[test]
    fn judge_copies_a_pair_whose_files_were_not_read_is_not_taken_on_trust() {
        let (a, c) = (commit(&h("a"), "fix nav"), commit(&h("c"), "fix nav"));
        let v = judge_copies(std::slice::from_ref(&a), &pair(&a, &c), &HashMap::new());
        assert!(matches!(v, StaleVerdict::Refuse { .. }));
    }

    #[test]
    fn judge_copies_a_stale_copy_above_a_commit_upstream_lacks_would_drop_it_too() {
        let (a, b, c) = (
            commit(&h("a"), "fix nav"),
            commit(&h("b"), "mine"),
            commit(&h("c"), "fix nav"),
        );
        let v = judge_copies(&[b, a.clone()], &pair(&a, &c), &clean(&[&h("a")]));
        assert!(why(&v).contains("sits on 1 commit of your own"));
    }

    #[test]
    fn judge_copies_local_merges_and_an_ambiguous_match_are_refused() {
        let (a, c) = (commit(&h("a"), "fix nav"), commit(&h("c"), "fix nav"));
        let m = CommitFacts {
            parents: 2,
            ..commit(&h("e"), "merge")
        };
        assert!(matches!(
            judge_copies(&[a.clone(), m], &pair(&a, &c), &clean(&[&h("a")])),
            StaleVerdict::Refuse { .. }
        ));
        assert_eq!(
            judge_copies(
                &[a],
                &Pairing::Ambiguous("two of them".into()),
                &HashMap::new()
            ),
            StaleVerdict::Refuse {
                why: "two of them".into()
            }
        );
    }

    fn offer() -> StaleOffer {
        StaleOffer {
            branch: "main".into(),
            upstream: "origin/main".into(),
            onto: h("f"),
            copies: vec![StaleCopy {
                stale: h("a"),
                copy: h("c"),
                subject: "fix nav".into(),
            }],
            kept: 1,
        }
    }

    #[test]
    fn the_offer_says_which_commit_which_amend_and_what_dropping_it_does() {
        let o = offer();
        assert_eq!(
            offer_words(&o),
            "Upstream holds an amended copy of aaaaaaa fix nav (ccccccc: same message and author time, and every line aaaaaaa left in its files). Dropping the stale copy moves main onto origin/main with git rebase --onto and keeps the 1 commit after it."
        );
        assert_eq!(offer_action(&o), "drop the stale copy and push");
        let none_kept = StaleOffer { kept: 0, ..o };
        assert_eq!(offer_action(&none_kept), "drop the stale copy");
        assert!(offer_words(&none_kept).ends_with("with git rebase --onto."));
    }

    #[test]
    fn the_offer_names_several_copies_in_a_row_the_newest_last() {
        let mut two = offer();
        two.copies.push(StaleCopy {
            stale: h("b"),
            copy: h("d"),
            subject: "more".into(),
        });
        assert!(offer_words(&two).contains(
            "amended copies of 2 commits: aaaaaaa fix nav (ccccccc), bbbbbbb more (ddddddd)"
        ));
        assert_eq!(offer_action(&two), "drop the stale copies and push");
        assert_eq!(newest_stale(&two.copies), h("b"));
    }

    #[test]
    fn only_a_whole_offer_over_the_wire_is_one() {
        let o = serde_json::to_value(offer()).unwrap();
        assert_eq!(
            o,
            json!({"branch": "main", "upstream": "origin/main", "onto": h("f"), "copies": [{"stale": h("a"), "copy": h("c"), "subject": "fix nav"}], "kept": 1})
        );
        assert!(is_stale_offer(&o));
        let with = |k: &str, v: Value| {
            let mut x = o.clone();
            x[k] = v;
            x
        };
        assert!(!is_stale_offer(&with("copies", json!([]))));
        assert!(!is_stale_offer(&with("onto", json!("f".repeat(7)))));
        assert!(!is_stale_offer(&with(
            "copies",
            json!([{"stale": "--output=x", "copy": h("c"), "subject": ""}])
        )));
        assert!(!is_stale_offer(&Value::Null));
        assert!(is_full_hash(&json!("a".repeat(64))));
        assert!(!is_full_hash(&json!("A".repeat(40))));
    }

    #[test]
    fn a_verdict_serializes_as_the_typescript_union() {
        assert_eq!(
            serde_json::to_value(StaleVerdict::None).unwrap(),
            json!({"kind": "none"})
        );
        assert_eq!(
            serde_json::to_value(StaleVerdict::Refuse { why: "w".into() }).unwrap(),
            json!({"kind": "refuse", "why": "w"})
        );
    }
}
