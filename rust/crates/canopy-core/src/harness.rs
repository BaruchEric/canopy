//! The harness table's pure half (`src/core/harness.ts`): each agent CLI's
//! binary, the models and efforts it takes, and the checks that keep a
//! value from another harness off a command line. The argv builders are
//! not ported yet.

use regex::Regex;
use std::sync::LazyLock;

/// every harness, in the TS's order
pub const HARNESSES: [&str; 3] = ["claude", "codex", "antigravity"];

/// claude's models, which are also the names no open list may take
pub const AGENT_MODELS: [&str; 5] = ["default", "fable", "opus", "sonnet", "haiku"];

pub struct HarnessInfo {
    pub id: &'static str,
    /// the binary on PATH
    pub binary: &'static str,
    /// the models the form offers; for a closed list the only ones taken
    pub models: &'static [&'static str],
    /// whether a plain name outside `models` is taken
    pub open_models: bool,
    /// the efforts it takes, "default" first
    pub efforts: &'static [&'static str],
}

const CLAUDE: HarnessInfo = HarnessInfo {
    id: "claude",
    binary: "claude",
    models: &AGENT_MODELS,
    open_models: false,
    efforts: &["default", "low", "medium", "high", "xhigh", "max"],
};

const CODEX: HarnessInfo = HarnessInfo {
    id: "codex",
    binary: "codex",
    models: &[
        "default",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
    ],
    open_models: true,
    efforts: &["default", "low", "medium", "high", "xhigh", "max", "ultra"],
};

const ANTIGRAVITY: HarnessInfo = HarnessInfo {
    id: "antigravity",
    binary: "agy",
    models: &["default"],
    open_models: true,
    efforts: &["default", "low", "medium", "high", "xhigh", "max"],
};

pub fn is_harness(v: &str) -> bool {
    HARNESSES.contains(&v)
}

/// The table entry for a harness id; None for a word that is not one.
pub fn harness(h: &str) -> Option<&'static HarnessInfo> {
    match h {
        "claude" => Some(&CLAUDE),
        "codex" => Some(&CODEX),
        "antigravity" => Some(&ANTIGRAVITY),
        _ => None,
    }
}

static MODEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$").unwrap());
static PROVIDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$").unwrap());

/// Whether `h` takes this model: "default" always, a listed one, or for an
/// open list a plain name that is none of claude's.
pub fn takes_model(h: &str, model: &str) -> bool {
    if model == "default" {
        return true;
    }
    let Some(info) = harness(h) else { return false };
    if info.models.contains(&model) {
        return true;
    }
    if !info.open_models || AGENT_MODELS.contains(&model) {
        return false;
    }
    MODEL_RE.is_match(model)
}

pub fn takes_effort(h: &str, effort: &str) -> bool {
    harness(h).is_some_and(|i| i.efforts.contains(&effort))
}

/// A configured provider id: never antigravity's, never "default".
pub fn takes_provider(h: &str, provider: &str) -> bool {
    is_harness(h) && h != "antigravity" && provider != "default" && PROVIDER_RE.is_match(provider)
}

/// The harnesses whose binary `has` finds (`presentHarnesses`).
pub fn present_harnesses(has: impl Fn(&str) -> bool) -> Vec<&'static str> {
    HARNESSES
        .into_iter()
        .filter(|h| harness(h).is_some_and(|i| has(i.binary)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_takes_only_its_own_models_and_codex_takes_any_plain_name_but_claudes() {
        assert!(takes_model("claude", "opus"));
        assert!(!takes_model("claude", "gpt-5.5"));
        assert!(takes_model("codex", "gpt-5.5"));
        assert!(takes_model("codex", "my-model:1"));
        assert!(!takes_model("codex", "opus"));
        assert!(!takes_model("codex", "-bad"));
        assert!(takes_model("antigravity", "default"));
    }

    #[test]
    fn efforts_and_providers_follow_each_harness() {
        assert!(takes_effort("codex", "ultra"));
        assert!(!takes_effort("claude", "ultra"));
        assert!(takes_provider("claude", "local"));
        assert!(!takes_provider("antigravity", "local"));
        assert!(!takes_provider("codex", "default"));
        assert!(!takes_provider("codex", "1x"));
    }

    #[test]
    fn present_harnesses_keeps_the_tables_order() {
        assert_eq!(
            present_harnesses(|b| b == "agy" || b == "claude"),
            vec!["claude", "antigravity"]
        );
    }
}
