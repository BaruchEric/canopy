//! The Library's paths (`libraryArgs` and `libraryStateDir` in
//! `src/core/library.ts`): where its Python adapter sits in canopy's
//! checkout, the state folder kept for a workspace root, and the arguments
//! every adapter call starts with. The origin gate from the same file is in
//! canopy-auth; the worker the server keeps (`Library`) is not ported.
//!
//! The TypeScript finds the adapter from its own file
//! (`import.meta.dir/../../lib/devhub/canopy.py`, so `<checkout>/lib/devhub`).
//! Rust takes the checkout as an argument: canopy-rs passes `canopy_dir()`,
//! the same checkout it reads `src/core/help.ts` from and hands other verbs
//! to (`$CANOPY_DIR`, else the checkout it was built in).

use crate::pathx::join;
use crate::spec::sha256;

/// The adapter script in a canopy checkout.
pub fn adapter_path(canopy_dir: &str) -> String {
    join(canopy_dir, "lib/devhub/canopy.py")
}

/// `libraryStateDir()`: the Library's state folder for a root already made
/// canonical, `<config>/library/<the first 24 hex digits of its sha256>`.
pub fn library_state_dir(config_dir: &str, canonical: &str) -> String {
    let id = sha256(canonical);
    join(&join(config_dir, "library"), &id[..24])
}

/// `libraryArgs()` once the root is canonical: the adapter, its root and
/// state, and the `--` the command follows.
pub fn library_args(adapter: &str, config_dir: &str, canonical: &str) -> Vec<String> {
    vec![
        adapter.to_string(),
        "--root".into(),
        canonical.to_string(),
        "--state".into(),
        library_state_dir(config_dir, canonical),
        "--".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// what library.ts printed for these roots with CANOPY_CONFIG_DIR=/cfg
    #[test]
    fn the_state_folder_is_named_for_the_root_by_its_sha256() {
        assert_eq!(
            library_state_dir("/cfg", "/home/eric/dev"),
            "/cfg/library/cd8a8431ac38376303990245"
        );
        assert_eq!(
            library_state_dir("/cfg", "/tmp/ü x"),
            "/cfg/library/456a18fb1c49432b8398c459",
            "the root is hashed as UTF-8"
        );
    }

    #[test]
    fn the_adapter_takes_its_root_and_state_then_the_command() {
        assert_eq!(
            library_args(&adapter_path("/c/canopy/"), "/cfg", "/"),
            [
                "/c/canopy/lib/devhub/canopy.py",
                "--root",
                "/",
                "--state",
                "/cfg/library/8a5edab282632443219e051e",
                "--"
            ]
        );
    }
}
