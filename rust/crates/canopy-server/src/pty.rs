//! A process on a pty (`spawnOnPty` in src/core/term.ts): the child leads
//! a session of its own with the pty as its controlling terminal, so its
//! signals to its group stay there and Ctrl-C reaches it. The pty comes
//! from `pty-process` (rustix underneath), so canopy's own code holds no
//! `unsafe`. Output is read on a task of its own and handed over in chunks;
//! a resize sets the pty's size and tells the process with SIGWINCH as the
//! TypeScript does; a hangup is SIGHUP, then SIGKILL after three seconds
//! for a process that ignores it.
//!
//! canopy-server runs only tmux clients on a pty (`terms.rs`); a plain pty
//! shell, which ends with the server, is not ported.

use canopy_core::term::TermSize;
use rustix::process::{Pid, Signal, kill_process};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// how long a hung-up process has before it is killed
pub const HANGUP_GRACE: Duration = Duration::from_secs(3);
/// how long output still on its way is read after the process exits
const DRAIN: Duration = Duration::from_millis(300);

/// What a pty runs: the argv, its folder, and its whole environment.
#[derive(Debug, Clone, Default)]
pub struct PtyCommand {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
}

/// What the process on the pty did next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Data(Vec<u8>),
    /// it exited, with its code (128 and the signal for one a signal ended)
    Exit(i32),
}

/// One process on its pty.
pub struct PtyProcess {
    child: tokio::process::Child,
    pid: Option<Pid>,
    writer: pty_process::OwnedWritePty,
    output: mpsc::Receiver<Vec<u8>>,
    output_done: bool,
    exited: Option<i32>,
}

fn exit_code(status: std::io::Result<std::process::ExitStatus>) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    match status {
        Ok(s) => s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0)),
        Err(_) => 1,
    }
}

fn pty_size(size: TermSize) -> pty_process::Size {
    pty_process::Size::new(size.rows, size.cols)
}

/// Starts `what` on a pty of `size`. Fails when the pty or the spawn does
/// (a folder that is gone, a binary that is not there).
pub fn spawn_on_pty(what: &PtyCommand, size: TermSize) -> std::io::Result<PtyProcess> {
    let Some((prog, args)) = what.argv.split_first() else {
        return Err(std::io::Error::other("no command"));
    };
    let (pty, pts) = pty_process::open().map_err(std::io::Error::other)?;
    pty.resize(pty_size(size)).map_err(std::io::Error::other)?;
    let mut cmd = pty_process::Command::new(prog)
        .args(args)
        .env_clear()
        .envs(what.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .kill_on_drop(true);
    if let Some(cwd) = &what.cwd {
        cmd = cmd.current_dir(cwd);
    }
    let child = cmd.spawn(pts).map_err(std::io::Error::other)?;
    let pid = child.id().and_then(|p| Pid::from_raw(p as i32));
    let (mut reader, writer) = pty.into_split();
    let (tx, output) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            // EIO once the last process holding the terminal side is gone
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    Ok(PtyProcess {
        child,
        pid,
        writer,
        output,
        output_done: false,
        exited: None,
    })
}

impl PtyProcess {
    /// Keystrokes to the process; nothing once it has exited.
    pub async fn write(&mut self, data: &[u8]) {
        if self.exited.is_some() {
            return;
        }
        let _ = self.writer.write_all(data).await;
        let _ = self.writer.flush().await;
    }

    /// A new size: the pty's, and SIGWINCH to the process directly too, as
    /// it was told when it never had the pty as its terminal.
    pub fn resize(&self, size: TermSize) {
        if self.exited.is_some() {
            return;
        }
        let _ = self.writer.resize(pty_size(size));
        self.signal(Signal::WINCH);
    }

    fn signal(&self, sig: Signal) {
        if let Some(pid) = self.pid
            && self.exited.is_none()
        {
            let _ = kill_process(pid, sig);
        }
    }

    /// The next chunk of output, or the exit once the output is spent. Output
    /// still on its way when the process exits is read first, for a moment.
    pub async fn next(&mut self) -> PtyEvent {
        if let Some(code) = self.exited
            && self.output_done
        {
            return PtyEvent::Exit(code);
        }
        loop {
            if self.output_done {
                let code = match self.exited {
                    Some(c) => c,
                    None => exit_code(self.child.wait().await),
                };
                self.exited = Some(code);
                return PtyEvent::Exit(code);
            }
            if self.exited.is_some() {
                match tokio::time::timeout(DRAIN, self.output.recv()).await {
                    Ok(Some(chunk)) => return PtyEvent::Data(chunk),
                    Ok(None) | Err(_) => self.output_done = true,
                }
                continue;
            }
            tokio::select! {
                chunk = self.output.recv() => match chunk {
                    Some(c) => return PtyEvent::Data(c),
                    None => self.output_done = true,
                },
                status = self.child.wait() => self.exited = Some(exit_code(status)),
            }
        }
    }

    /// Hangs the process up and waits for it: SIGHUP, then SIGKILL after
    /// `HANGUP_GRACE` for one that ignores it. Its exit code.
    pub async fn hang_up(&mut self) -> i32 {
        if let Some(code) = self.exited {
            return code;
        }
        self.signal(Signal::HUP);
        let code = match tokio::time::timeout(HANGUP_GRACE, self.child.wait()).await {
            Ok(status) => exit_code(status),
            Err(_) => {
                let _ = self.child.start_kill();
                exit_code(self.child.wait().await)
            }
        };
        self.exited = Some(code);
        code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> PtyCommand {
        PtyCommand {
            argv: vec!["sh".into(), "-c".into(), script.into()],
            cwd: None,
            env: std::env::vars().filter(|(k, _)| k == "PATH").collect(),
        }
    }

    /// output until `want` shows, or what came before the process exited
    async fn until(p: &mut PtyProcess, out: &mut String, want: &str) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !out.contains(want) {
            match tokio::time::timeout_at(deadline, p.next()).await {
                Ok(PtyEvent::Data(d)) => out.push_str(&String::from_utf8_lossy(&d)),
                Ok(PtyEvent::Exit(_)) | Err(_) => return false,
            }
        }
        true
    }

    // A resize reaches the process whether or not the kernel's SIGWINCH to
    // the pty's foreground group does; it keeps drawing at the new size.
    #[tokio::test]
    async fn a_resize_reaches_the_process_on_the_pty() {
        let mut p = spawn_on_pty(
            &sh(r#"trap "stty size" WINCH; echo ready; while :; do sleep 0.05; done"#),
            TermSize { cols: 80, rows: 24 },
        )
        .unwrap();
        let mut out = String::new();
        assert!(until(&mut p, &mut out, "ready").await, "{out}");
        p.resize(TermSize {
            cols: 132,
            rows: 41,
        });
        assert!(until(&mut p, &mut out, "41 132").await, "{out}");
        p.hang_up().await;
    }

    // In canopy's process group, a shell's signal to its group (a job's
    // hangup, ble.sh's cleanup) reached canopy itself, and here the tests.
    #[tokio::test]
    async fn the_process_leads_a_session_of_its_own_on_the_pty() {
        let mut p = spawn_on_pty(
            &sh(r#"echo "ids $$ $(ps -o pgid= -p $$) $(ps -o stat= -p $$) $(ps -o tty= -p $$)"; kill -HUP 0"#),
            TermSize { cols: 80, rows: 24 },
        )
        .unwrap();
        let mut out = String::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), p.next()).await {
                Ok(PtyEvent::Data(d)) => out.push_str(&String::from_utf8_lossy(&d)),
                Ok(PtyEvent::Exit(_)) => break,
                Err(_) => panic!("the process never exited: {out}"),
            }
        }
        let ids = out.split("ids ").nth(1).unwrap_or("").trim().to_string();
        let f: Vec<&str> = ids.split_whitespace().collect();
        // stat's "s" marks a session leader; a tty of "?" would be none
        assert!(f.len() >= 4, "{out}");
        assert_eq!(f[1], f[0], "{out}");
        assert!(f[2].contains('s'), "{out}");
        assert_ne!(f[3], "?", "{out}");
        // and the hangup to its group reached nothing here: this test still runs
    }

    #[tokio::test]
    async fn keystrokes_reach_the_process_and_its_exit_comes_after_its_output() {
        let mut p = spawn_on_pty(
            &sh("read line; echo got-$line; exit 3"),
            TermSize { cols: 80, rows: 24 },
        )
        .unwrap();
        p.write(b"hi\n").await;
        let mut out = String::new();
        let code = loop {
            match tokio::time::timeout(Duration::from_secs(10), p.next()).await {
                Ok(PtyEvent::Data(d)) => out.push_str(&String::from_utf8_lossy(&d)),
                Ok(PtyEvent::Exit(c)) => break c,
                Err(_) => panic!("no exit: {out}"),
            }
        };
        assert!(out.contains("got-hi"), "{out}");
        assert_eq!(code, 3);
        assert_eq!(p.next().await, PtyEvent::Exit(3));
    }

    #[tokio::test]
    async fn a_process_that_ignores_the_hangup_is_killed() {
        let mut p = spawn_on_pty(
            &sh(r#"trap "" HUP; echo ready; while :; do sleep 0.05; done"#),
            TermSize { cols: 80, rows: 24 },
        )
        .unwrap();
        let mut out = String::new();
        assert!(until(&mut p, &mut out, "ready").await, "{out}");
        assert_eq!(p.hang_up().await, 128 + 9);
    }

    #[test]
    fn a_spawn_that_fails_says_so() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let gone = PtyCommand {
                argv: vec!["/no/such/binary".into()],
                ..PtyCommand::default()
            };
            assert!(spawn_on_pty(&gone, TermSize { cols: 80, rows: 24 }).is_err());
        });
    }
}
