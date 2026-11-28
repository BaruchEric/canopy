//! Pull requests from branch runs (FR-011, `src/core/pr.ts`). Only the CI
//! chip's words are here yet; the rest of pr.ts is not ported.

/// `checksWord()`: "no checks", "checks passed", "checks: 2 running",
/// "checks: 1 failed", from each check's state (pass, fail, pending, ...).
pub fn checks_word(states: &[&str]) -> String {
    if states.is_empty() {
        return "no checks".into();
    }
    let failed = states.iter().filter(|s| **s == "fail").count();
    if failed > 0 {
        return format!("checks: {failed} failed");
    }
    let running = states.iter().filter(|s| **s == "pending").count();
    if running > 0 {
        format!("checks: {running} running")
    } else {
        "checks passed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_outranks_a_running_check() {
        assert_eq!(checks_word(&[]), "no checks");
        assert_eq!(checks_word(&["pass", "pass"]), "checks passed");
        assert_eq!(
            checks_word(&["pass", "pending", "pending"]),
            "checks: 2 running"
        );
        assert_eq!(checks_word(&["pending", "fail"]), "checks: 1 failed");
        assert_eq!(checks_word(&["skipping"]), "checks passed");
    }
}
