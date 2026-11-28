//! `canopy library` (the `case "library"` arm of src/cli/index.ts and
//! `libraryCommand` in src/core/library.ts): every command but `sync` runs
//! the Library's Python adapter, `lib/devhub/canopy.py`, with this
//! terminal's stdin, stdout and stderr, and exits with its code. `sync`
//! is `libsync.rs`.
//!
//! The root is `--root` (index.ts's `opt`, so a `--root` with nothing after
//! it stays among the adapter's words), else the working folder, made
//! absolute and then canonical, as `realpath` makes it. The state folder is
//! named for the canonical root under the config dir (canopy-core's
//! `library.rs`). The adapter is found in `canopy_dir()`, the checkout
//! canopy-rs was built in or `$CANOPY_DIR`: for the shipped layout that is
//! the same `lib/devhub` Bun's `import.meta.dir/../../lib/devhub` names, as
//! the delegate's `bin/canopy.ts` sits in that checkout too. `--help` is the
//! adapter's, not help.ts's.

use canopy_core::exec::which;
use canopy_core::library::{adapter_path, library_args};
use canopy_core::pathx::fs_error_words;

/// What `python()` says when there is no python3 on PATH.
pub const NO_PYTHON: &str =
    "Library features require Python 3.10 or newer. Install python3 and retry.";

/// The adapter's command line for `root` (absolute), or the failure the
/// TypeScript throws: no python3 first, as `Bun.spawn([python(), ...await
/// libraryArgs(root)])` asks for it before it reads the root, then the root's
/// `realpath`.
pub fn library_argv(
    root: &str,
    args: &[String],
    python: Option<String>,
    canopy_dir: &str,
    config_dir: &str,
) -> Result<Vec<String>, String> {
    let python = python.ok_or(NO_PYTHON)?;
    let canonical = std::fs::canonicalize(root)
        .map_err(|e| fs_error_words(&e, "realpath", root))?
        .to_string_lossy()
        .into_owned();
    let mut argv = vec![python];
    argv.extend(library_args(
        &adapter_path(canopy_dir),
        config_dir,
        &canonical,
    ));
    argv.extend(args.iter().cloned());
    Ok(argv)
}

/// `libraryCommand()`: runs the adapter with this terminal and gives back
/// its exit code, 128 and the signal's number for one a signal ended, as
/// Bun's `exited` reads it.
pub fn library_command(
    root: &str,
    args: &[String],
    canopy_dir: &str,
    config_dir: &str,
) -> Result<i32, String> {
    let argv = library_argv(root, args, which("python3"), canopy_dir, config_dir)?;
    let status = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .status()
        .map_err(|e| fs_error_words(&e, "posix_spawn", &argv[0]))?;
    Ok(exit_code(status))
}

/// An exit status as Bun's `exited` reads it: the code, or 128 and the
/// signal's number for one a signal ended.
pub fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_core::library::library_state_dir;

    fn scratch() -> tempfile_dir::Dir {
        tempfile_dir::Dir::new("canopy-library")
    }

    /// a scratch folder removed on drop
    mod tempfile_dir {
        pub struct Dir(pub String);
        impl Dir {
            pub fn new(prefix: &str) -> Self {
                static NEXT: std::sync::atomic::AtomicUsize =
                    std::sync::atomic::AtomicUsize::new(0);
                let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let p = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                let p = std::fs::canonicalize(p).unwrap();
                Dir(p.to_string_lossy().into_owned())
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn the_adapter_runs_on_the_canonical_root_with_the_words_given() {
        let d = scratch();
        let root = format!("{}/ws", d.0);
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&root, format!("{}/link", d.0)).unwrap();
        let argv = library_argv(
            &format!("{}/link", d.0),
            &["index".to_string()],
            Some("/usr/bin/python3".into()),
            "/c",
            "/cfg",
        )
        .unwrap();
        assert_eq!(
            argv,
            [
                "/usr/bin/python3".to_string(),
                "/c/lib/devhub/canopy.py".into(),
                "--root".into(),
                root.clone(),
                "--state".into(),
                library_state_dir("/cfg", &root),
                "--".into(),
                "index".into(),
            ]
        );
    }

    #[test]
    fn no_python_is_said_before_a_root_that_is_not_there() {
        assert_eq!(
            library_argv("/nonexistent-canopy-root", &[], None, "/c", "/cfg"),
            Err(NO_PYTHON.into())
        );
        assert_eq!(
            library_argv(
                "/nonexistent-canopy-root",
                &[],
                Some("python3".into()),
                "/c",
                "/cfg"
            ),
            Err("ENOENT: no such file or directory, realpath '/nonexistent-canopy-root'".into())
        );
        assert_eq!(
            library_argv("/etc/passwd/x", &[], Some("python3".into()), "/c", "/cfg"),
            Err("ENOTDIR: not a directory, realpath '/etc/passwd/x'".into())
        );
    }

    /// library.test.ts: "CLI shares state, supports references/relations,
    /// and returns failed dev status", the part the CLI reaches: the
    /// adapter's own help, and its state kept under the config dir. Needs
    /// python3, so it says so and passes where there is none.
    #[test]
    fn cli_shares_state_and_prints_the_adapter_help() {
        if which("python3").is_none() {
            eprintln!("skipped: no python3 on PATH for the Library's adapter");
            return;
        }
        let d = scratch();
        let root = format!("{}/ws", d.0);
        std::fs::create_dir_all(format!("{root}/apps/alpha")).unwrap();
        let cfg = format!("{}/cfg", d.0);
        let canopy = canopy_core::version::canopy_dir();
        let argv = library_argv(
            &root,
            &["--help".to_string()],
            which("python3"),
            &canopy,
            &cfg,
        )
        .unwrap();
        let out = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0));
        assert!(String::from_utf8_lossy(&out.stdout).contains("rename-category"));
        let state = library_state_dir(&cfg, &root);
        assert!(std::path::Path::new(&format!("{state}/categories.json")).is_file());
    }

    #[test]
    fn an_exit_code_and_a_signal_come_back_as_bun_reads_them() {
        let run = |script: &str| {
            exit_code(
                std::process::Command::new("sh")
                    .args(["-c", script])
                    .status()
                    .unwrap(),
            )
        };
        assert_eq!(run("exit 2"), 2);
        assert_eq!(run("kill -TERM $$"), 143);
        assert_eq!(run("kill -KILL $$"), 137);
    }
}
