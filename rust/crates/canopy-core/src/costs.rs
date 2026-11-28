//! The cost ledger's words (`src/core/costs.ts`). Only `SERVICE_NAME` is
//! here, for the cost sheet's lines; the rows, the price list, the
//! estimates and a run's deltas stay in the TypeScript.

/// `SERVICE_NAME[service]`: a ledger service as the costs view names it.
pub fn service_name(service: &str) -> Option<&'static str> {
    match service {
        "claude" => Some("Claude Code"),
        "codex" => Some("Codex"),
        "antigravity" => Some("Antigravity"),
        "voice" => Some("Voice"),
        "speech" => Some("Dictation"),
        _ => None,
    }
}
