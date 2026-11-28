//! Small string helpers that keep JavaScript's semantics where the TS relied
//! on them.

/// `String.prototype.trim` (canopy-core's, the one copy).
pub use canopy_core::pathx::js_trim;

/// `s.slice(0, n)`: the first `n` UTF-16 code units. A cut through a
/// surrogate pair drops that character, since a Rust string cannot hold half
/// of one (the TS would keep a lone surrogate).
pub fn utf16_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// Only ASCII digits, as JavaScript's `\d` matches, and at least one.
pub fn ascii_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_like_js() {
        assert_eq!(js_trim("\u{feff} a \u{2028}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        assert_eq!(js_trim("\t\n a \r\u{a0}"), "a");
    }

    #[test]
    fn utf16_cut() {
        assert_eq!(utf16_prefix("abc", 2), "ab");
        assert_eq!(utf16_prefix("abc", 5), "abc");
        // the tree is two code units: a cut through it drops it
        assert_eq!(utf16_prefix("a\u{1F332}b", 2), "a");
        assert_eq!(utf16_prefix("a\u{1F332}b", 3), "a\u{1F332}");
        assert_eq!(utf16_prefix("\u{e9}\u{e9}", 1), "\u{e9}");
    }
}
