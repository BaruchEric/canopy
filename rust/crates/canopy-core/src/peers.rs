//! Peers: canopy backends that keep each machine's clones in step over git
//! (`src/core/peers.ts`). Only what the git write half needs is here yet.

/// The push URL a peer remote carries, so a push never goes to a peer:
/// peers are pull-only and fast-forward only.
pub const NO_PUSH: &str = "canopy-peer-no-push";
