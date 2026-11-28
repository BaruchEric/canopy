//! The processes under a shell's pane (`src/core/procs.ts`), for telling
//! which agent it runs when what tmux says is not enough: a bun-installed
//! codex runs as `node`, so only the argv under the shell tells. Linux
//! reads `/proc`; a Mac asks `ps`. The parsers and the walk are pure and
//! tested; the reads are best effort and come back empty rather than fail.
//!
//! Only the pid, ppid and argv are read. The comm, state, CPU time and
//! start the TypeScript also keeps (for the ports list and the scan) are
//! not ported yet.

use std::collections::{HashMap, HashSet, VecDeque};

/// One process off the table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub argv: Vec<String>,
}

/// how many processes under a pane are looked at, at most
pub const TREE_CAP: usize = 64;

/// The ppid out of a `/proc/<pid>/stat` line: the field after the state,
/// which comes after the command in parens, and the command may itself hold
/// spaces and parens, so the split starts at the last one.
pub fn parse_stat_ppid(stat: &str) -> Option<u32> {
    let close = stat.rfind(')')?;
    let rest = stat.get(close + 2..)?;
    rest.split(' ').nth(1)?.parse::<u32>().ok()
}

/// `/proc/<pid>/cmdline`: NUL-separated words, none for a kernel thread.
pub fn parse_cmdline(raw: &str) -> Vec<String> {
    raw.split('\0')
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// `ps -axo pid=,ppid=,args=`: one process a line, the args split on
/// whitespace.
pub fn parse_ps(text: &str) -> Vec<Proc> {
    let mut out = vec![];
    for line in text.split('\n') {
        let mut words = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (words.next(), words.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        out.push(Proc {
            pid,
            ppid,
            argv: words.map(String::from).collect(),
        });
    }
    out
}

/// The processes under `root`, root first, each before its children, at
/// most `cap` of them. A root that has gone still has its children walked.
pub fn descendants(procs: &[Proc], root: u32, cap: usize) -> Vec<Proc> {
    let mut kids: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in procs {
        kids.entry(p.ppid).or_default().push(p);
    }
    let mut queue: VecDeque<&Proc> = match procs.iter().find(|p| p.pid == root) {
        Some(p) => VecDeque::from([p]),
        None => kids.get(&root).cloned().unwrap_or_default().into(),
    };
    let mut out = vec![];
    let mut seen = HashSet::new();
    while out.len() < cap {
        let Some(p) = queue.pop_front() else { break };
        if !seen.insert(p.pid) {
            continue;
        }
        out.push(p.clone());
        for k in kids.get(&p.pid).into_iter().flatten() {
            queue.push_back(k);
        }
    }
    out
}

/// Every process `/proc` shows, with its ppid and argv.
pub fn linux_procs() -> Vec<Proc> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return vec![];
    };
    dir.flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let ppid = parse_stat_ppid(&stat)?;
            let cmd = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
            Some(Proc {
                pid,
                ppid,
                argv: parse_cmdline(&String::from_utf8_lossy(&cmd)),
            })
        })
        .collect()
}

fn ps_procs() -> Vec<Proc> {
    std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,args="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// every process on this machine: `/proc` on Linux, `ps` elsewhere
pub fn all_procs() -> Vec<Proc> {
    if cfg!(target_os = "linux") {
        linux_procs()
    } else {
        ps_procs()
    }
}

/// the argv of every process under `root` on this machine
pub fn process_tree(root: u32) -> Vec<Vec<String>> {
    descendants(&all_procs(), root, TREE_CAP)
        .into_iter()
        .map(|p| p.argv)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, ppid: u32, argv: &[&str]) -> Proc {
        Proc {
            pid,
            ppid,
            argv: argv.iter().map(|s| s.to_string()).collect(),
        }
    }

    // reading the process table
    #[test]
    fn a_stat_lines_ppid_whatever_the_commands_name_holds() {
        assert_eq!(
            parse_stat_ppid("4242 (node) S 4200 4242 4200 34816 4242 4194304 0 0"),
            Some(4200)
        );
        assert_eq!(
            parse_stat_ppid("77 (my (odd) name) R 1 77 77 0 -1"),
            Some(1)
        );
        assert_eq!(parse_stat_ppid("garbage"), None);
        assert_eq!(parse_stat_ppid("5 (x) S notanumber"), None);
    }

    #[test]
    fn a_cmdlines_words_and_none_for_a_kernel_thread() {
        assert_eq!(
            parse_cmdline("node\0/x/@openai/codex/bin/codex.js\0--no-daemon\0"),
            ["node", "/x/@openai/codex/bin/codex.js", "--no-daemon"]
        );
        assert_eq!(parse_cmdline(""), Vec::<String>::new());
    }

    #[test]
    fn ps_lines_on_a_mac() {
        assert_eq!(
            parse_ps(
                "  101     1 /bin/zsh -l\n  202   101 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js\nbad line\n"
            ),
            [
                proc(101, 1, &["/bin/zsh", "-l"]),
                proc(
                    202,
                    101,
                    &[
                        "node",
                        "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"
                    ]
                ),
            ]
        );
    }

    fn table() -> Vec<Proc> {
        vec![
            proc(1, 0, &["init"]),
            proc(10, 1, &["-bash"]),
            proc(11, 10, &["node", "codex.js"]),
            proc(12, 11, &["codex-native"]),
            proc(20, 1, &["other"]),
        ]
    }

    fn pids(ps: Vec<Proc>) -> Vec<u32> {
        ps.into_iter().map(|p| p.pid).collect()
    }

    // the processes under a pane
    #[test]
    fn the_root_first_then_each_before_its_children_nothing_from_beside_it() {
        assert_eq!(pids(descendants(&table(), 10, TREE_CAP)), [10, 11, 12]);
        assert_eq!(pids(descendants(&table(), 20, TREE_CAP)), [20]);
    }

    #[test]
    fn a_root_that_has_gone_still_has_its_children_looked_at_and_the_walk_is_capped() {
        let gone: Vec<Proc> = table().into_iter().filter(|p| p.pid != 10).collect();
        assert_eq!(pids(descendants(&gone, 10, TREE_CAP)), [11, 12]);
        assert_eq!(pids(descendants(&table(), 1, 2)), [1, 10]);
        assert_eq!(
            pids(descendants(&table(), 999, TREE_CAP)),
            Vec::<u32>::new()
        );
    }

    #[test]
    fn this_process_is_on_the_table_with_its_own_argv() {
        let me = std::process::id();
        let all = all_procs();
        assert!(all.iter().any(|p| p.pid == me && !p.argv.is_empty()));
    }
}
