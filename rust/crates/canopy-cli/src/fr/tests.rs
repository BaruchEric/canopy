//! fr.test.ts, on real git throughout: a bare origin, two clones of it
//! standing for two machines, and a second worktree of the first clone. The
//! TypeScript's tests share one set of repos and run in order, each
//! counting on the numbers the one before took, so the ones that do run in
//! one test here, step by step in the same order. Only flags both BSD and
//! GNU tools take.

use super::*;
use std::collections::HashMap;
use std::path::PathBuf;

/// A scratch folder, gone when the test ends however it ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Scratch {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("canopy-fr-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir.canonicalize().unwrap())
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }

    fn root(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// git with a name and no signing, failing the test when it fails.
async fn g(cwd: &str, args: &[&str]) -> String {
    let mut cmd = vec![
        "git",
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
    ];
    cmd.extend_from_slice(args);
    let r = exec(
        &cmd,
        &ExecOptions {
            cwd: Some(cwd.into()),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(r.code, 0, "git {}: {}", args.join(" "), r.stderr);
    js_trim(&r.stdout).to_string()
}

fn list(highest: u64) -> String {
    format!(
        "# Feature requests: shop\n\n## Open\n\n### FR-{highest:03} · The newest\n\n## In Progress\n\n## Shipped\n\n## Declined\n"
    )
}

fn holder(by: &str) -> FrHolder {
    FrHolder {
        title: format!("what {by} builds"),
        by: by.into(),
        branch: "main".into(),
        backend: String::new(),
    }
}

fn write(path: &str, text: &str) {
    std::fs::write(path, text).unwrap();
}

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |k: &str| map.get(k).cloned()
}

/// The TypeScript's beforeAll: origin with the list at FR-005, the two
/// machines' clones, and the first clone's second worktree on `side`.
struct Repos {
    s: Scratch,
    origin: String,
    mac: String,
    mini: String,
    tree: String,
}

async fn repos() -> Repos {
    let s = Scratch::new("repos");
    let root = s.root();
    let (origin, mac, mini, tree) = (
        s.path("origin.git"),
        s.path("mac"),
        s.path("mini"),
        s.path("mac-tree"),
    );
    g(&root, &["init", "-q", "--bare", "-b", "main", &origin]).await;
    g(&root, &["clone", "-q", &origin, &mac]).await;
    write(&format!("{mac}/FEATURES.md"), &list(5));
    g(&mac, &["add", "-A"]).await;
    g(&mac, &["commit", "-qm", "the list"]).await;
    g(&mac, &["push", "-q", "origin", "HEAD:main"]).await;
    g(&root, &["clone", "-q", &origin, &mini]).await;
    g(&mac, &["worktree", "add", "-q", "-b", "side", &tree]).await;
    Repos {
        s,
        origin,
        mac,
        mini,
        tree,
    }
}

fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn list_is_the_default_and_each_word_takes_only_its_own_flags() {
    assert_eq!(
        parse_fr_args(&[]),
        Ok(FrArgs {
            dir: None,
            json: false,
            act: FrAct::List { all: false }
        })
    );
    assert_eq!(
        parse_fr_args(&args(&["--all", "--json", "-C", "/repo"])),
        Ok(FrArgs {
            dir: Some("/repo".into()),
            json: true,
            act: FrAct::List { all: true }
        })
    );
    assert_eq!(
        parse_fr_args(&args(&["reserve", "-m", "A cart"])),
        Ok(FrArgs {
            dir: None,
            json: false,
            act: FrAct::Reserve {
                title: "A cart".into()
            }
        })
    );
    assert_eq!(parse_fr_args(&args(&["next"])).unwrap().act, FrAct::Next);
    assert_eq!(parse_fr_args(&args(&["check"])).unwrap().act, FrAct::Check);
    for bad in [
        &["next", "-m", "x"][..],
        &["reserve", "--all"],
        &["take"],
        &["reserve", "extra"],
    ] {
        assert!(parse_fr_args(&args(bad)).is_err(), "{bad:?}");
    }
    assert_eq!(
        parse_fr_args(&args(&["next", "-m", "x"])),
        Err(format!("-m goes with reserve\n\n{FR_USAGE}"))
    );
    assert_eq!(
        parse_fr_args(&args(&["--backend", "x"])),
        Err(FR_USAGE.into())
    );
}

#[tokio::test]
async fn a_folder_outside_git_is_refused_and_one_inside_names_its_root() {
    let r = repos().await;
    let outside = r.s.root();
    assert!(
        fr_root(&outside)
            .await
            .unwrap_err()
            .contains("not in a git repository")
    );
    let src = format!("{}/src", r.mac);
    std::fs::create_dir_all(&src).unwrap();
    assert_eq!(fr_root(&src).await.unwrap(), r.mac);
}

#[tokio::test]
async fn who_holds_a_reservation_comes_from_the_session_then_the_person() {
    let r = repos().await;
    let got = fr_holder_here(
        &r.mac,
        "A cart",
        &env_of(&[
            ("TAILCHAN_AS", "canopy-3d13"),
            ("CLAUDE_CODE_SESSION_ID", "f0351fe1-bc47"),
            ("CANOPY_BACKEND", "mac"),
        ]),
    )
    .await;
    assert_eq!(
        got,
        FrHolder {
            title: "A cart".into(),
            by: "canopy-3d13".into(),
            branch: "main".into(),
            backend: "mac".into()
        }
    );
    let by = |h: FrHolder| h.by;
    assert_eq!(
        by(fr_holder_here(
            &r.mac,
            "",
            &env_of(&[("CLAUDE_CODE_SESSION_ID", "f0351fe1-bc47")])
        )
        .await),
        "claude-f0351f"
    );
    assert_eq!(
        by(fr_holder_here(&r.mac, "", &env_of(&[("CODEX_THREAD_ID", "9f8e7d6c5b")])).await),
        "codex-9f8e7d"
    );
    assert_eq!(
        by(fr_holder_here(&r.tree, "", &env_of(&[("USER", "eric")])).await),
        "eric"
    );
    assert_eq!(
        fr_holder_here(&r.tree, "", &env_of(&[])).await.branch,
        "side"
    );
}

async fn refs_on(origin: &str, pattern: &str) -> String {
    g(origin, &["for-each-ref", "--format=%(refname)", pattern]).await
}

/// "reserving a number" and "with origin away", in the TypeScript's order.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reservations_in_the_typescripts_order() {
    let r = repos().await;
    takes_the_one_after_the_lists_highest_and_shares_it_through_origin(&r).await;
    another_machine_gets_the_number_after_having_never_seen_the_firsts_worktree(&r).await;
    an_entry_written_in_another_worktree_and_not_yet_committed_counts(&r).await;
    sessions_that_ask_at_the_same_moment_all_get_their_own(&r).await;
    a_number_whose_entry_reached_the_default_branch_says_so(&r).await;
    a_reservation_stands_on_this_machine_says_so_and_is_shared_once_origin_is_back(&r).await;
    a_number_origin_gave_to_someone_else_reads_as_a_clash_and_neither_is_replaced(&r).await;
}

async fn takes_the_one_after_the_lists_highest_and_shares_it_through_origin(r: &Repos) {
    assert_eq!(fr_next_here(&r.mac).await, 6);
    let got = fr_reserve(&r.mac, &holder("claude-aaaaaa")).await.unwrap();
    assert_eq!(
        got,
        FrReserved {
            n: 6,
            id: "FR-006".into(),
            ref_: "refs/canopy/fr/006".into(),
            shared: true,
            note: None
        }
    );
    assert_eq!(
        refs_on(&r.origin, "refs/canopy/fr").await,
        "refs/canopy/fr/006"
    );
    // looking takes nothing
    assert_eq!(fr_next_here(&r.mac).await, 7);
    assert_eq!(fr_next_here(&r.mac).await, 7);
}

async fn another_machine_gets_the_number_after_having_never_seen_the_firsts_worktree(r: &Repos) {
    let got = fr_reserve(&r.mini, &holder("claude-bbbbbb")).await.unwrap();
    assert_eq!((got.id.as_str(), got.shared), ("FR-007", true));
    let all = fr_list(&r.mini).await;
    let rows: Vec<(String, String, FrWhere, bool)> = all
        .into_iter()
        .map(|x| (x.id, x.holder.by, x.where_, x.listed))
        .collect();
    assert_eq!(
        rows,
        [
            (
                "FR-006".to_string(),
                "claude-aaaaaa".to_string(),
                FrWhere::Shared,
                false
            ),
            (
                "FR-007".to_string(),
                "claude-bbbbbb".to_string(),
                FrWhere::Shared,
                false
            ),
        ]
    );
}

async fn an_entry_written_in_another_worktree_and_not_yet_committed_counts(r: &Repos) {
    let file = format!("{}/FEATURES.md", r.tree);
    write(&file, &list(30));
    assert_eq!(
        fr_reserve(&r.mac, &holder("claude-aaaaaa"))
            .await
            .unwrap()
            .id,
        "FR-031"
    );
    // and so does one committed on a branch with no worktree here
    g(&r.tree, &["add", "-A"]).await;
    g(&r.tree, &["commit", "-qm", "an entry on a side branch"]).await;
    write(&file, &list(40));
    g(&r.tree, &["commit", "-qam", "a later one"]).await;
    g(&r.mac, &["branch", "-q", "parked", "side"]).await;
    write(&file, &list(5));
    g(&r.tree, &["commit", "-qam", "taken back on side"]).await;
    assert_eq!(fr_next_here(&r.mac).await, 41);
}

async fn sessions_that_ask_at_the_same_moment_all_get_their_own(r: &Repos) {
    let (h1, h2, h3, h4, h5, h6) = (
        holder("s1"),
        holder("s2"),
        holder("s3"),
        holder("s4"),
        holder("s5"),
        holder("s6"),
    );
    let got = tokio::join!(
        fr_reserve(&r.mac, &h1),
        fr_reserve(&r.tree, &h2),
        fr_reserve(&r.mac, &h3),
        fr_reserve(&r.mini, &h4),
        fr_reserve(&r.mini, &h5),
        fr_reserve(&r.tree, &h6),
    );
    let got = [got.0, got.1, got.2, got.3, got.4, got.5].map(Result::unwrap);
    let numbers: Vec<u64> = got.iter().map(|x| x.n).collect();
    assert_eq!(
        numbers.iter().collect::<HashSet<_>>().len(),
        6,
        "{numbers:?}"
    );
    // the first clone counts its own unpushed branch (FR-040); the second
    // cannot see that branch and counts from the reservations (FR-031)
    for i in [0, 1, 2, 5] {
        assert!(got[i].n > 40, "{numbers:?}");
    }
    for i in [3, 4] {
        assert!(got[i].n > 31, "{numbers:?}");
    }
    assert!(got.iter().all(|x| x.shared));
    // each machine ends up knowing all six
    for repo in [&r.mac, &r.mini] {
        let held: Vec<u64> = fr_list(repo).await.iter().map(|x| x.n).collect();
        for n in &numbers {
            assert!(held.contains(n), "{n} in {held:?}");
        }
    }
}

async fn a_number_whose_entry_reached_the_default_branch_says_so(r: &Repos) {
    g(&r.mini, &["pull", "-q", "origin", "main"]).await;
    write(&format!("{}/FEATURES.md", r.mini), &list(7));
    g(&r.mini, &["commit", "-qam", "FR-007 ships"]).await;
    g(&r.mini, &["push", "-q", "origin", "HEAD:main"]).await;
    let all = fr_list(&r.mac).await;
    assert!(all.iter().find(|x| x.n == 7).unwrap().listed);
    assert!(!all.iter().find(|x| x.n == 6).unwrap().listed);
}

async fn a_reservation_stands_on_this_machine_says_so_and_is_shared_once_origin_is_back(r: &Repos) {
    let url = g(&r.mini, &["remote", "get-url", "origin"]).await;
    let gone = r.s.path("gone.git");
    g(&r.mini, &["remote", "set-url", "origin", &gone]).await;
    let got = fr_reserve(&r.mini, &holder("offline")).await.unwrap();
    assert!(!got.shared);
    assert!(got.note.as_deref().unwrap().contains("did not answer"));
    assert_eq!(refs_on(&r.origin, &fr_ref(got.n)).await, "");
    g(&r.mini, &["remote", "set-url", "origin", &url]).await;
    let mine = fr_list(&r.mini).await;
    assert_eq!(
        mine.iter().find(|x| x.n == got.n).unwrap().where_,
        FrWhere::Shared
    );
    assert_eq!(refs_on(&r.origin, &fr_ref(got.n)).await, fr_ref(got.n));
}

async fn a_number_origin_gave_to_someone_else_reads_as_a_clash_and_neither_is_replaced(r: &Repos) {
    let url = g(&r.mini, &["remote", "get-url", "origin"]).await;
    let gone = r.s.path("gone.git");
    g(&r.mini, &["remote", "set-url", "origin", &gone]).await;
    let offline = fr_reserve(&r.mini, &holder("offline")).await.unwrap();
    let online = fr_reserve(&r.mac, &holder("online")).await.unwrap();
    assert_eq!(online.n, offline.n);
    g(&r.mini, &["remote", "set-url", "origin", &url]).await;
    let mine = fr_list(&r.mini).await;
    let mine = mine.iter().find(|x| x.n == offline.n).unwrap();
    assert_eq!(
        (mine.where_, mine.holder.by.as_str()),
        (FrWhere::Clash, "offline")
    );
    let theirs = fr_list(&r.mac).await;
    let theirs = theirs.iter().find(|x| x.n == online.n).unwrap();
    assert_eq!(
        (theirs.where_, theirs.holder.by.as_str()),
        (FrWhere::Shared, "online")
    );
    // the next one here is past both
    assert_eq!(
        fr_reserve(&r.mini, &holder("offline")).await.unwrap().n,
        offline.n + 1
    );
}

#[tokio::test]
async fn a_repo_with_no_origin_reserves_for_itself() {
    let s = Scratch::new("alone");
    let alone = s.path("alone");
    g(&s.root(), &["init", "-q", "-b", "main", &alone]).await;
    let first = fr_reserve(&alone, &holder("solo")).await.unwrap();
    assert_eq!((first.id.as_str(), first.shared), ("FR-001", false));
    assert!(first.note.as_deref().unwrap().contains("no origin"));
    assert_eq!(
        fr_reserve(&alone, &holder("solo")).await.unwrap().id,
        "FR-002"
    );
    let wheres: Vec<FrWhere> = fr_list(&alone).await.iter().map(|x| x.where_).collect();
    assert_eq!(wheres, [FrWhere::Here, FrWhere::Here]);
}

#[tokio::test]
async fn the_check_names_a_number_two_entries_share_and_passes_a_list_without_one_or_no_list() {
    let r = repos().await;
    assert!(fr_check(&r.mac).is_empty());
    let twice = r.s.path("twice");
    std::fs::create_dir_all(&twice).unwrap();
    assert!(fr_check(&twice).is_empty());
    write(
        &format!("{twice}/FEATURES.md"),
        &format!("{}\n### FR-005 · The same number again\n", list(5)),
    );
    assert_eq!(fr_check(&twice), [5]);
}

#[tokio::test]
async fn the_command_lists_checks_and_refuses_as_the_typescript_words_it() {
    let r = repos().await;
    let none = env_of(&[("USER", "eric")]);
    let run = |a: &[&str]| args(a);
    let mut o = Out::default();
    fr_cmd(run(&["next"]), &r.mac, &none, 0, &mut o)
        .await
        .unwrap();
    fr_cmd(run(&["check", "-C", &r.mac]), "/", &none, 0, &mut o)
        .await
        .unwrap();
    fr_cmd(run(&[]), &r.mac, &none, 0, &mut o).await.unwrap();
    assert_eq!(
        o.printed(),
        [
            "FR-006",
            "FEATURES.md gives every number once",
            "no number is reserved here",
            "next free: FR-006"
        ]
    );
    let mut o = Out::default();
    fr_cmd(run(&["reserve", "-m", "A cart"]), &r.mac, &none, 0, &mut o)
        .await
        .unwrap();
    let at = local_reservations(&r.mac).await[0].at;
    fr_cmd(run(&["list"]), &r.mac, &none, at + 3 * HOUR, &mut o)
        .await
        .unwrap();
    fr_cmd(run(&["--json"]), &r.mac, &none, at, &mut o)
        .await
        .unwrap();
    let text = o.text.clone();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "FR-006");
    assert_eq!(lines[1], "FR-006  A cart  · eric on main  · 3h ago");
    assert_eq!(lines[2], "next free: FR-007");
    let json: serde_json::Value = serde_json::from_str(&lines[3..].join("\n")).unwrap();
    assert_eq!(json[0]["holder"]["by"], "eric");
    assert_eq!(json[0]["where"], "shared");
    let twice = format!("{}/FEATURES.md", r.mac);
    write(
        &twice,
        &format!("{}\n### FR-005 · The same number again\n", list(5)),
    );
    let mut o = Out::default();
    assert_eq!(
        fr_cmd(run(&["check"]), &r.mac, &none, 0, &mut o).await,
        Err("FEATURES.md gives one number to two entries: FR-005. Keep the entry that landed first and take a new number for the other with canopy fr reserve".into())
    );
    let outside = r.s.root();
    assert_eq!(
        fr_cmd(run(&["next"]), &outside, &none, 0, &mut o).await,
        Err(format!("{outside} is not in a git repository"))
    );
    assert_eq!(
        fr_cmd(run(&["take"]), &r.mac, &none, 0, &mut o).await,
        Err(FR_USAGE.into())
    );
}

#[test]
fn age_words_and_whitespace_split_read_as_the_typescript_does() {
    assert_eq!(age_word(-5), "now");
    assert_eq!(age_word(59_999), "now");
    assert_eq!(age_word(5 * MINUTE), "5m");
    assert_eq!(age_word(3 * HOUR + 1), "3h");
    assert_eq!(age_word(40 * DAY), "40d");
    assert_eq!(split_ws("abc\trefs/x"), ["abc", "refs/x"]);
    assert_eq!(split_ws(""), [""]);
    assert_eq!(split_ws("\tref"), ["", "ref"]);
    assert_eq!(split_ws("a b "), ["a", "b", ""]);
    assert_eq!(unix_ms("1767225600"), 1_767_225_600_000);
    assert_eq!(unix_ms(""), 0);
    let u = random_uuid();
    assert_eq!(u.len(), 36);
    assert_eq!(&u[14..15], "4");
    assert_ne!(u, random_uuid());
}
