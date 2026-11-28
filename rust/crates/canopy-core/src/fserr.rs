//! A file system error worded as Bun words it, for the routes that answer
//! one as their 500: `ELOOP: too many symbolic links encountered, open
//! '/path'`, libuv's code and words, then the call and its path. An error
//! with no errno, or one not in the table, keeps Rust's words.

use rustix::io::Errno;

/// libuv's code and words for the errors a state file's read or write
/// meets.
fn uv(e: Errno) -> Option<(&'static str, &'static str)> {
    let table = [
        (Errno::NOENT, "ENOENT", "no such file or directory"),
        (Errno::ACCESS, "EACCES", "permission denied"),
        (Errno::PERM, "EPERM", "operation not permitted"),
        (Errno::LOOP, "ELOOP", "too many symbolic links encountered"),
        (Errno::ISDIR, "EISDIR", "illegal operation on a directory"),
        (Errno::NOTDIR, "ENOTDIR", "not a directory"),
        (Errno::MFILE, "EMFILE", "too many open files"),
        (Errno::NFILE, "ENFILE", "file table overflow"),
        (Errno::NOSPC, "ENOSPC", "no space left on device"),
        (Errno::DQUOT, "EDQUOT", "disk quota exceeded"),
        (Errno::ROFS, "EROFS", "read-only file system"),
        (Errno::EXIST, "EEXIST", "file already exists"),
        (Errno::NOTEMPTY, "ENOTEMPTY", "directory not empty"),
        (Errno::IO, "EIO", "i/o error"),
        (Errno::NAMETOOLONG, "ENAMETOOLONG", "name too long"),
        (Errno::XDEV, "EXDEV", "cross-device link not permitted"),
        (Errno::BUSY, "EBUSY", "resource busy or locked"),
    ];
    table
        .into_iter()
        .find(|(n, _, _)| *n == e)
        .map(|(_, code, words)| (code, words))
}

/// The error of `syscall` on `path` (`open`, `mkdir`), as Bun's message
/// says it. `path` empty leaves the path out, as Bun's `read` does.
pub fn bun_message(e: &std::io::Error, syscall: &str, path: &str) -> String {
    let Some((code, words)) = Errno::from_io_error(e).and_then(uv) else {
        return e.to_string();
    };
    if path.is_empty() {
        format!("{code}: {words}, {syscall}")
    } else {
        format!("{code}: {words}, {syscall} '{path}'")
    }
}

/// A rename's error: both paths, as Bun gives them.
pub fn bun_rename_message(e: &std::io::Error, from: &str, to: &str) -> String {
    let Some((code, words)) = Errno::from_io_error(e).and_then(uv) else {
        return e.to_string();
    };
    format!("{code}: {words}, rename '{from}' -> '{to}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Bun 1.3 said for each, read off its errors on Linux.
    #[test]
    fn an_error_reads_as_buns() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("loop");
        std::os::unix::fs::symlink("loop", &link).unwrap();
        let e = std::fs::read(&link).unwrap_err();
        let p = link.to_str().unwrap();
        assert_eq!(
            bun_message(&e, "open", p),
            format!("ELOOP: too many symbolic links encountered, open '{p}'")
        );
        let e = std::fs::read(dir.path()).unwrap_err();
        assert_eq!(
            bun_message(&e, "read", ""),
            "EISDIR: illegal operation on a directory, read"
        );
        let e = std::io::Error::other("odd");
        assert_eq!(bun_message(&e, "open", "/x"), "odd");
    }
}
