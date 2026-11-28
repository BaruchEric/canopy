//! canopy's core logic in Rust: the port of `src/core/` (see
//! docs/rust-port.md for what is ported and what is not yet). No HTTP here;
//! the server and the CLI crates sit on top.

pub mod exec;
pub mod git;
pub mod gitwrite;
pub mod host;
pub mod meta;
pub mod pathx;
pub mod peers;
pub mod remote;
pub mod scan;
pub mod seedgit;
pub mod spec;
pub mod stalecopy;
pub mod store;
pub mod treelines;
pub mod types;
pub mod version;
