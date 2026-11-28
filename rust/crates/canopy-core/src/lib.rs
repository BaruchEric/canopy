//! canopy's core logic in Rust: the port of `src/core/` (see
//! docs/rust-port.md for what is ported and what is not yet). No HTTP here;
//! the server and the CLI crates sit on top.

pub mod exec;
pub mod flowgraph;
pub mod flowmodes;
pub mod fr;
pub mod git;
pub mod gitwrite;
pub mod group;
pub mod host;
pub mod js;
pub mod landing;
pub mod meta;
pub mod notes;
pub mod pathx;
pub mod peers;
pub mod pr;
pub mod remote;
pub mod repohealth;
pub mod scan;
pub mod seedgit;
pub mod spec;
pub mod stalecopy;
pub mod store;
pub mod sweep;
pub mod tasks;
pub mod touch;
pub mod treelines;
pub mod types;
pub mod version;
pub mod work;
pub mod workflow;
pub mod workflows;
