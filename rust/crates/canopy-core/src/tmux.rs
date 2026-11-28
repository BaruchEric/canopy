//! canopy's tmux server, the shell half of `src/core/tmux.ts`: the argv
//! builders a shell's session needs (make, attach, kill, look up, name,
//! move, read its history, screen and text, send it keys), the session list
//! and pane line parsers, and `prime_text`, what a new client is sent ahead
//! of tmux's first draw. Every argv starts with `tmux_argv`'s front, which
//! names canopy's own socket, so nothing here reaches another tmux server.
//!
//! Tasks' and the ranger's sessions (their argv, pane lists and the setup
//! line), the steer's paste buffers and `typedAsEmpty` are not ported yet.
//! The calls that run these argv are canopy-server's `terms.rs`.

use crate::host::{parse_locator, shell_quote};
use crate::term::{TermSize, is_term_id, term_place};

/// What a session knows about the shell it holds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TmuxMeta {
    pub id: String,
    pub repo_id: String,
    /// the repo's locator, where the shell landed
    pub path: String,
    pub place: String,
    /// the tailchan handle the shell runs under (`TAILCHAN_AS`)
    pub handle: Option<String>,
    /// the name a tab gave the shell by hand (`@canopy_label`)
    pub label: Option<String>,
    /// more of the session's environment, in order
    pub env: Vec<(String, String)>,
}

const PREFIX: &str = "canopy-";

/// the session for a shell: its id is tmux-name-safe (hex, no dots or colons)
pub fn session_name(id: &str) -> String {
    format!("{PREFIX}{id}")
}

/// the shell a session name is for, or None for one canopy did not make
pub fn session_id(name: &str) -> Option<String> {
    let id = name.strip_prefix(PREFIX)?;
    is_term_id(id).then(|| id.to_string())
}

fn strings(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| w.to_string()).collect()
}

/// The front of every tmux argv: the binary, `-u` to force UTF-8, canopy's
/// socket and its config.
pub fn tmux_argv(bin: &str, socket: &str, conf: &str) -> Vec<String> {
    strings(&[bin, "-u", "-S", socket, "-f", conf])
}

/// Leaves a session's mouse to the browser terminal: tmux 3.8 turns `mouse`
/// on, and a tmux that has the mouse takes the drag, the wheel and the
/// right button for its own selection, so xterm selects nothing.
pub fn mouse_off_args(name: &str) -> Vec<String> {
    strings(&[";", "set-option", "-t", name, "mouse", "off"])
}

fn option(name: &str, key: &str, value: &str) -> Vec<String> {
    strings(&[";", "set-option", "-t", name, key, value])
}

/// A detached session for a shell, sized for the terminal that will show
/// it, running `command`, then the repo, place and path set on it in the
/// same call. A local folder is the session's start directory; a remote
/// shell is an ssh line and starts here. A handle goes into the session's
/// environment as `TAILCHAN_AS` and onto it as an option; `env` goes in
/// beside it.
pub fn new_session_args(
    base: &[String],
    meta: &TmuxMeta,
    size: TermSize,
    command: &[String],
) -> Vec<String> {
    let name = session_name(&meta.id);
    let l = parse_locator(&meta.path);
    let mut out = base.to_vec();
    out.extend(strings(&["new-session", "-d", "-s", &name]));
    if l.host.is_none() {
        out.extend(strings(&["-c", &l.path]));
    }
    if let Some(h) = &meta.handle {
        out.extend(["-e".into(), format!("TAILCHAN_AS={h}")]);
    }
    for (k, v) in &meta.env {
        out.extend(["-e".into(), format!("{k}={v}")]);
    }
    out.extend([
        "-x".into(),
        size.cols.to_string(),
        "-y".into(),
        size.rows.to_string(),
        command
            .iter()
            .map(|w| shell_quote(w))
            .collect::<Vec<_>>()
            .join(" "),
    ]);
    out.extend(option(&name, "@canopy_repo", &meta.repo_id));
    out.extend(option(&name, "@canopy_place", &meta.place));
    out.extend(option(&name, "@canopy_path", &meta.path));
    out.extend(mouse_off_args(&name));
    if let Some(h) = &meta.handle {
        out.extend(option(&name, "@canopy_handle", h));
    }
    if let Some(l) = &meta.label {
        out.extend(option(&name, "@canopy_label", l));
    }
    out
}

fn with(base: &[String], rest: &[&str]) -> Vec<String> {
    let mut out = base.to_vec();
    out.extend(strings(rest));
    out
}

/// names a session's shell by hand, or takes the name off when `label` is empty
pub fn label_args(base: &[String], id: &str, label: &str) -> Vec<String> {
    let name = session_name(id);
    if label.is_empty() {
        with(base, &["set-option", "-u", "-t", &name, "@canopy_label"])
    } else {
        with(base, &["set-option", "-t", &name, "@canopy_label", label])
    }
}

/// moves a session's shell to the strip or a repo's panel
pub fn place_args(base: &[String], id: &str, place: &str) -> Vec<String> {
    with(
        base,
        &[
            "set-option",
            "-t",
            &session_name(id),
            "@canopy_place",
            place,
        ],
    )
}

pub fn attach_args(base: &[String], id: &str) -> Vec<String> {
    with(base, &["attach-session", "-t", &session_name(id)])
}

pub fn kill_args(base: &[String], id: &str) -> Vec<String> {
    with(base, &["kill-session", "-t", &session_name(id)])
}

pub fn has_args(base: &[String], id: &str) -> Vec<String> {
    with(base, &["has-session", "-t", &session_name(id)])
}

/// how many lines of history a new client is handed
pub const HISTORY_LINES: usize = 2000;

pub fn history_size_args(base: &[String], id: &str) -> Vec<String> {
    with(
        base,
        &[
            "display-message",
            "-p",
            "-t",
            &session_name(id),
            "#{history_size}",
        ],
    )
}

/// the last `lines` of history before the screen, colors kept, wrapped
/// lines joined so the client wraps them at its own width
pub fn capture_args(base: &[String], id: &str, lines: usize) -> Vec<String> {
    with(
        base,
        &[
            "capture-pane",
            "-p",
            "-e",
            "-J",
            "-t",
            &session_name(id),
            "-S",
            &format!("-{lines}"),
            "-E",
            "-1",
        ],
    )
}

/// what tmux can say about the pane: its command, its title, whether a
/// full-screen program has the alternate screen, and the pane's own pid
pub const PANE_FORMAT: &str =
    "#{pane_current_command}\t#{pane_title}\t#{alternate_on}\t#{pane_pid}";

pub fn pane_args(base: &[String], id: &str) -> Vec<String> {
    with(
        base,
        &[
            "display-message",
            "-p",
            "-t",
            &session_name(id),
            PANE_FORMAT,
        ],
    )
}

/// keys to the pane: tmux key names (Escape, Enter), or with `literal` text typed as is
pub fn keys_args(base: &[String], id: &str, keys: &[&str], literal: bool) -> Vec<String> {
    let mut out = with(base, &["send-keys", "-t", &session_name(id)]);
    if literal {
        out.push("-l".into());
    }
    out.extend(strings(keys));
    out
}

/// A line typed into a shell, ended with C-j rather than Enter, which
/// ble.sh runs whatever waits behind it.
pub fn send_line_args(base: &[String], id: &str, line: &str) -> Vec<String> {
    with(base, &["send-keys", "-t", &session_name(id), line, "C-j"])
}

/// What a client is sent before tmux draws for it: the captured history as
/// terminal lines, then enough newlines to push them off a screen of
/// `rows`, since tmux's first draw clears the screen. Empty when there is
/// no history.
pub fn prime_text(captured: &str, rows: u16) -> String {
    let lines = captured
        .strip_suffix("\r\n")
        .or_else(|| captured.strip_suffix('\n'))
        .unwrap_or(captured);
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "{}\x1b[0m{}",
        lines.split('\n').collect::<Vec<_>>().join("\r\n"),
        "\r\n".repeat(usize::from(rows.max(1)))
    )
}

/// one line per session: name, repo, place, created (unix seconds), path,
/// handle, task, label
pub const LIST_FORMAT: &str = "#{session_name}\t#{@canopy_repo}\t#{@canopy_place}\t#{session_created}\t#{@canopy_path}\t#{@canopy_handle}\t#{@canopy_task}\t#{@canopy_label}";

pub fn list_args(base: &[String]) -> Vec<String> {
    with(base, &["list-sessions", "-F", LIST_FORMAT])
}

/// A session as the list prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxSession {
    pub id: String,
    pub repo_id: String,
    pub path: String,
    pub place: String,
    /// ms since the epoch
    pub created_at: i64,
    pub handle: Option<String>,
    /// the task a task's session runs; None for a shell
    pub task: Option<String>,
    pub label: Option<String>,
}

/// Reads `list-sessions -F LIST_FORMAT`. Sessions canopy did not make, or
/// that lost their repo, are left out; a time that does not read is `now`.
pub fn parse_sessions(out: &str, now: i64) -> Vec<TmuxSession> {
    let mut sessions = vec![];
    for line in out.split('\n') {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        let at = |i: usize| f.get(i).copied().unwrap_or("");
        let Some(id) = session_id(at(0)) else {
            continue;
        };
        let (repo_id, path) = (at(1), at(4));
        if repo_id.is_empty() || path.is_empty() {
            continue;
        }
        let secs = crate::term::js_number(at(3));
        let some = |s: &str| (!s.is_empty()).then(|| s.to_string());
        sessions.push(TmuxSession {
            id,
            repo_id: repo_id.into(),
            path: path.into(),
            place: term_place(f.get(2).copied()).into(),
            created_at: if secs.is_finite() && secs > 0.0 {
                (secs * 1000.0) as i64
            } else {
                now
            },
            handle: some(at(5)),
            task: some(at(6)),
            label: some(at(7)),
        });
    }
    sessions
}

/// where a duplicate `new-session` is what tmux said, so the shell is there already
pub fn is_duplicate(stderr: &str) -> bool {
    stderr.contains("duplicate session")
}

/// where a list failing is only the server not running yet
pub fn no_server(stderr: &str) -> bool {
    stderr.contains("no server running") || stderr.contains("No such file")
}

/// What tmux says about a pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneInfo {
    pub command: String,
    pub title: String,
    pub fullscreen: bool,
    pub pid: Option<u32>,
}

/// reads one `PANE_FORMAT` line
pub fn parse_pane(line: &str) -> PaneInfo {
    let line = line.strip_suffix('\n').unwrap_or(line);
    let f: Vec<&str> = line.split('\t').collect();
    let at = |i: usize| f.get(i).copied().unwrap_or("");
    let pid = at(3);
    let n = crate::term::js_number(pid);
    PaneInfo {
        command: at(0).into(),
        title: at(1).into(),
        fullscreen: at(2) == "1",
        pid: (!pid.is_empty() && n.fract() == 0.0 && n > 0.0 && n <= f64::from(u32::MAX))
            .then_some(n as u32),
    }
}

/// the pane as plain text, for a copy: the history and screen, or the
/// screen alone while a full-screen program is up
pub fn text_args(base: &[String], id: &str, fullscreen: bool, lines: usize) -> Vec<String> {
    let mut out = with(base, &["capture-pane", "-p", "-J", "-t", &session_name(id)]);
    if !fullscreen {
        out.extend(strings(&["-S", &format!("-{lines}"), "-E", "-"]));
    }
    out
}

/// the screen the pane shows now and nothing above it, colours kept and
/// lines left as the pane wraps them: what a peek at a shell draws
pub fn screen_args(base: &[String], id: &str) -> Vec<String> {
    with(base, &["capture-pane", "-p", "-e", "-t", &session_name(id)])
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn base() -> Vec<String> {
        tmux_argv(
            "/opt/homebrew/bin/tmux",
            "/cfg/tmux.sock",
            "/app/lib/tmux.conf",
        )
    }

    fn after(argv: &[String], n: usize) -> Vec<&str> {
        argv[n..].iter().map(String::as_str).collect()
    }

    fn meta(repo: &str, path: &str, place: &str) -> TmuxMeta {
        TmuxMeta {
            id: ID.into(),
            repo_id: repo.into(),
            path: path.into(),
            place: place.into(),
            ..TmuxMeta::default()
        }
    }

    fn size(cols: u16, rows: u16) -> TermSize {
        TermSize { cols, rows }
    }

    fn sh(words: &[&str]) -> Vec<String> {
        strings(words)
    }

    // session names
    #[test]
    fn a_shells_session_is_its_id_under_canopys_prefix_and_back() {
        assert_eq!(session_name(ID), format!("canopy-{ID}"));
        assert_eq!(session_id(&format!("canopy-{ID}")).as_deref(), Some(ID));
    }

    #[test]
    fn a_session_canopy_did_not_make_has_no_shell() {
        assert_eq!(session_id("main"), None);
        assert_eq!(session_id("canopy-t1"), None);
        assert_eq!(session_id(&format!("other-{ID}")), None);
    }

    // argv
    #[test]
    fn every_command_runs_on_canopys_socket_with_its_config() {
        let b = base();
        let name = format!("canopy-{ID}");
        assert_eq!(
            b,
            [
                "/opt/homebrew/bin/tmux",
                "-u",
                "-S",
                "/cfg/tmux.sock",
                "-f",
                "/app/lib/tmux.conf"
            ]
        );
        assert_eq!(
            after(&attach_args(&b, ID), 6),
            ["attach-session", "-t", &name]
        );
        assert_eq!(after(&kill_args(&b, ID), 6), ["kill-session", "-t", &name]);
        assert_eq!(
            after(&list_args(&b), 6),
            ["list-sessions", "-F", LIST_FORMAT]
        );
        assert_eq!(after(&has_args(&b, ID), 6), ["has-session", "-t", &name]);
        let hs = history_size_args(&b, ID);
        assert_eq!(
            after(&hs, hs.len() - 4),
            ["-p", "-t", &name, "#{history_size}"]
        );
        assert_eq!(
            after(&capture_args(&b, ID, 500), 6),
            [
                "capture-pane",
                "-p",
                "-e",
                "-J",
                "-t",
                &name,
                "-S",
                "-500",
                "-E",
                "-1"
            ]
        );
    }

    #[test]
    fn a_local_shells_session_starts_in_its_folder_sized_with_the_repo_place_and_path_set() {
        let b = base();
        let name = format!("canopy-{ID}");
        let m = meta("web-apps/ripe", "/Users/me/dev/web-apps/ripe", "panel");
        let argv = new_session_args(&b, &m, size(132, 40), &sh(&["/bin/zsh", "-l", "-i"]));
        assert_eq!(argv[..6], b[..]);
        let rest = after(&argv, 6);
        assert_eq!(
            rest[..11],
            [
                "new-session",
                "-d",
                "-s",
                &name,
                "-c",
                "/Users/me/dev/web-apps/ripe",
                "-x",
                "132",
                "-y",
                "40",
                "'/bin/zsh' '-l' '-i'"
            ]
        );
        // the options ride the same call, each after a separator tmux reads
        assert_eq!(
            rest[11..],
            [
                ";",
                "set-option",
                "-t",
                &name,
                "@canopy_repo",
                "web-apps/ripe",
                ";",
                "set-option",
                "-t",
                &name,
                "@canopy_place",
                "panel",
                ";",
                "set-option",
                "-t",
                &name,
                "@canopy_path",
                "/Users/me/dev/web-apps/ripe",
                // tmux 3.8 takes the mouse unless told not to
                ";",
                "set-option",
                "-t",
                &name,
                "mouse",
                "off"
            ]
        );
    }

    #[test]
    fn a_handle_and_the_env_go_into_the_sessions_environment() {
        let mut m = meta("app", "/dev/app", "strip");
        m.handle = Some("app-0123".into());
        m.env = vec![
            ("CANOPY_TERM".into(), ID.into()),
            ("CANOPY_BACKEND".into(), "mini".into()),
        ];
        let argv = new_session_args(&base(), &m, size(80, 24), &sh(&["/bin/bash"]));
        let at = argv.iter().position(|w| w == "-e").unwrap();
        assert_eq!(
            argv[at..at + 6],
            [
                "-e".to_string(),
                "TAILCHAN_AS=app-0123".into(),
                "-e".into(),
                format!("CANOPY_TERM={ID}"),
                "-e".into(),
                "CANOPY_BACKEND=mini".into()
            ]
        );
        assert_eq!(argv[at + 6], "-x");
    }

    #[test]
    fn a_remote_shells_session_is_the_ssh_line_started_here() {
        let m = meta("wsl:app", "ssh://wsl/home/me/app", "strip");
        let argv = new_session_args(
            &base(),
            &m,
            size(80, 24),
            &sh(&[
                "ssh",
                "-t",
                "--",
                "wsl",
                "cd '/home/me/app' && exec \"$SHELL\" -l",
            ]),
        );
        assert!(!argv.iter().any(|w| w == "-c"));
        let y = argv.iter().position(|w| w == "-y").unwrap();
        assert_eq!(
            argv[y + 2],
            r#"'ssh' '-t' '--' 'wsl' 'cd '\''/home/me/app'\'' && exec "$SHELL" -l'"#
        );
    }

    // parseSessions
    #[test]
    fn reads_canopys_sessions_and_skips_the_rest() {
        let out = [
            format!("canopy-{ID}\tweb-apps/ripe\tpanel\t1790000000\t/Users/me/dev/web-apps/ripe\t"),
            "main\t\t\t1790000001\t\t".into(),
            format!("canopy-{}\t\tstrip\t1790000002\t/x\t", ID.replace('0', "f")),
            String::new(),
        ]
        .join("\n");
        assert_eq!(
            parse_sessions(&out, 0),
            [TmuxSession {
                id: ID.into(),
                repo_id: "web-apps/ripe".into(),
                path: "/Users/me/dev/web-apps/ripe".into(),
                place: "panel".into(),
                created_at: 1_790_000_000_000,
                handle: None,
                task: None,
                label: None,
            }]
        );
    }

    #[test]
    fn an_unknown_place_is_the_strip_a_bad_time_is_now() {
        let s = parse_sessions(&format!("canopy-{ID}\tapp\twindow\tsoon\t/app\t"), 42);
        assert_eq!(s[0].place, "strip");
        assert_eq!(s[0].created_at, 42);
    }

    #[test]
    fn nothing_from_nothing() {
        assert_eq!(parse_sessions("", 0), []);
    }

    #[test]
    fn a_handle_reads_back_when_the_session_has_one() {
        let s = parse_sessions(
            &format!("canopy-{ID}\tapp\tstrip\t1790000000\t/app\tapp-0123\t"),
            0,
        );
        assert_eq!(s[0].handle.as_deref(), Some("app-0123"));
    }

    // a shell's tailchan handle
    #[test]
    fn rides_the_sessions_environment_and_an_option() {
        let mut m = meta("app", "/app", "strip");
        m.handle = Some("app-0123".into());
        let rest = new_session_args(&[], &m, size(80, 24), &sh(&["/bin/bash"]));
        let name = format!("canopy-{ID}");
        assert_eq!(
            after(&rest, 0)[..8],
            [
                "new-session",
                "-d",
                "-s",
                &name,
                "-c",
                "/app",
                "-e",
                "TAILCHAN_AS=app-0123"
            ]
        );
        assert_eq!(
            after(&rest, rest.len() - 6),
            [";", "set-option", "-t", &name, "@canopy_handle", "app-0123"]
        );
    }

    #[test]
    fn none_no_e_and_no_option() {
        let rest = new_session_args(
            &[],
            &meta("app", "/app", "strip"),
            size(80, 24),
            &sh(&["/bin/bash"]),
        );
        assert!(!rest.iter().any(|w| w == "-e"));
        assert!(!rest.iter().any(|w| w == "@canopy_handle"));
    }

    // a shell's hand-given name
    #[test]
    fn set_at_the_start_read_back_from_the_list() {
        let mut m = meta("app", "/app", "strip");
        m.label = Some("loot".into());
        let rest = new_session_args(&[], &m, size(80, 24), &sh(&["/bin/bash"]));
        let name = format!("canopy-{ID}");
        assert_eq!(
            after(&rest, rest.len() - 6),
            [";", "set-option", "-t", &name, "@canopy_label", "loot"]
        );
        let s = parse_sessions(
            &format!("canopy-{ID}\tapp\tstrip\t1790000000\t/app\t\t\tWeapons and loot"),
            0,
        );
        assert_eq!(s[0].label.as_deref(), Some("Weapons and loot"));
        let s = parse_sessions(
            &format!("canopy-{ID}\tapp\tstrip\t1790000000\t/app\t\t\t"),
            0,
        );
        assert_eq!(s[0].label, None);
    }

    #[test]
    fn renamed_later_or_taken_off_with_an_empty_name() {
        let b = base();
        let name = format!("canopy-{ID}");
        assert_eq!(
            after(&label_args(&b, ID, "maps"), 6),
            ["set-option", "-t", &name, "@canopy_label", "maps"]
        );
        assert_eq!(
            after(&label_args(&b, ID, ""), 6),
            ["set-option", "-u", "-t", &name, "@canopy_label"]
        );
    }

    #[test]
    fn moved_to_the_strip_or_a_panel_later() {
        let name = format!("canopy-{ID}");
        assert_eq!(
            after(&place_args(&base(), ID, "panel"), 6),
            ["set-option", "-t", &name, "@canopy_place", "panel"]
        );
        let s = parse_sessions(
            &format!("canopy-{ID}\tapp\tpanel\t1790000000\t/app\t\t\t"),
            0,
        );
        assert_eq!(s[0].place, "panel");
    }

    // a pane's text for a copy
    #[test]
    fn the_pane_line_says_when_a_full_screen_program_is_up() {
        let pane = |c: &str, t: &str, f: bool, pid: Option<u32>| PaneInfo {
            command: c.into(),
            title: t.into(),
            fullscreen: f,
            pid,
        };
        assert_eq!(
            parse_pane("2.1.285\t✳ fixing\t1\n"),
            pane("2.1.285", "✳ fixing", true, None)
        );
        assert_eq!(parse_pane("zsh\thost\t0"), pane("zsh", "host", false, None));
        assert_eq!(parse_pane("zsh\thost"), pane("zsh", "host", false, None));
        // the pane's own pid, for the processes under it
        assert_eq!(
            parse_pane("node\tapp\t0\t4242\n"),
            pane("node", "app", false, Some(4242))
        );
        assert_eq!(
            parse_pane("node\tapp\t0\tx"),
            pane("node", "app", false, None)
        );
    }

    #[test]
    fn a_plain_shell_copies_its_history_a_full_screen_one_its_screen_alone() {
        let b = base();
        let name = session_name(ID);
        assert_eq!(
            after(&text_args(&b, ID, false, 50), 6),
            [
                "capture-pane",
                "-p",
                "-J",
                "-t",
                &name,
                "-S",
                "-50",
                "-E",
                "-"
            ]
        );
        assert_eq!(
            after(&text_args(&b, ID, true, HISTORY_LINES), 6),
            ["capture-pane", "-p", "-J", "-t", &name]
        );
        // a peek: the screen alone, colours kept, rows as the pane wraps them
        assert_eq!(
            after(&screen_args(&b, ID), 6),
            ["capture-pane", "-p", "-e", "-t", &name]
        );
    }

    // what tmux said
    #[test]
    fn a_duplicate_session_means_the_shell_is_there_already() {
        assert!(is_duplicate("duplicate session: canopy-abc"));
        assert!(!is_duplicate("can't find session"));
    }

    #[test]
    fn no_server_is_not_an_error_for_a_list() {
        assert!(no_server("no server running on /cfg/tmux.sock"));
        assert!(no_server(
            "error connecting to /cfg/tmux.sock (No such file or directory)"
        ));
        assert!(!no_server("bad option"));
    }

    // primeText
    #[test]
    fn history_lines_become_terminal_lines_pushed_off_a_screen_of_the_clients_rows() {
        assert_eq!(prime_text("one\ntwo\n", 3), "one\r\ntwo\x1b[0m\r\n\r\n\r\n");
    }

    #[test]
    fn no_history_nothing_to_send() {
        assert_eq!(prime_text("", 24), "");
        assert_eq!(prime_text("\n", 24), "");
    }

    // tasks on tmux
    #[test]
    fn the_session_list_reads_the_task_tag() {
        let name = session_name(ID);
        let line = format!("{name}\tapp\tstrip\t100\t/r/app\t\tdev");
        assert_eq!(parse_sessions(&line, 0)[0].task.as_deref(), Some("dev"));
        let line = format!("{name}\tapp\tstrip\t100\t/r/app\t\t");
        assert_eq!(parse_sessions(&line, 0)[0].task, None);
    }

    // the ranger's session: no repo option, so the shell list passes over it
    #[test]
    fn a_placeholder_kept_on_exit_marked_as_the_rangers_and_never_as_a_shell_or_task() {
        let name = session_name(ID);
        assert_eq!(
            parse_sessions(&format!("{name}\t\tstrip\t100\t/home/eric/dev\t\t"), 0),
            []
        );
    }

    #[test]
    fn keys_args_named_keys_as_they_are_literal_text_after_l() {
        let b = sh(&["tmux", "-S", "/s"]);
        let name = session_name("ab");
        assert_eq!(
            after(&keys_args(&b, "ab", &["Escape"], false), 3),
            ["send-keys", "-t", &name, "Escape"]
        );
        assert_eq!(
            after(&keys_args(&b, "ab", &["/exit"], true), 3),
            ["send-keys", "-t", &name, "-l", "/exit"]
        );
    }

    #[test]
    fn a_line_typed_into_a_shell_ends_with_c_j_which_blesh_runs_even_with_input_waiting_behind_it()
    {
        let b = sh(&["tmux", "-S", "/s"]);
        assert_eq!(
            after(&send_line_args(&b, "ab", "codex --no-daemon"), 3),
            [
                "send-keys",
                "-t",
                &session_name("ab"),
                "codex --no-daemon",
                "C-j"
            ]
        );
    }
}
