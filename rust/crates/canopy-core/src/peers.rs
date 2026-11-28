//! Peers: canopy backends that keep each machine's clones in step over git
//! (`src/core/peers.ts`). Only what the git write half needs is here yet.

/// The push URL a peer remote carries, so a push never goes to a peer:
/// peers are pull-only and fast-forward only.
pub const NO_PUSH: &str = "canopy-peer-no-push";

/// A peer's name: lowercase, a letter first, at most 32, never "origin".
pub fn is_peer_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && s != "origin"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_name_is_a_lowercase_slug_that_is_not_origin() {
        assert!(is_peer_name("mini"));
        assert!(is_peer_name("de-soto2"));
        assert!(!is_peer_name("origin"));
        assert!(!is_peer_name("2mini"));
        assert!(!is_peer_name("Mini"));
        assert!(!is_peer_name(""));
        assert!(!is_peer_name(&"a".repeat(33)));
    }
}
