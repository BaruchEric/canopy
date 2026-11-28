//! Whether a pane's foreground command is a shell at its prompt
//! (`src/core/shellname.ts`).

const SHELL_COMMANDS: [&str; 10] = [
    "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login",
];

/// whether a pane's command is a shell at its prompt, which runs no agent
/// and no program of its own; a login shell's leading "-" counts too
pub fn is_shell_command(command: &str) -> bool {
    let lower = crate::pathx::js_trim(command).to_lowercase();
    let name = lower.strip_prefix('-').unwrap_or(&lower);
    name.is_empty() || SHELL_COMMANDS.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_or_a_login_shell_is_at_its_prompt() {
        assert!(is_shell_command("zsh"));
        assert!(is_shell_command("-bash"));
        assert!(is_shell_command(" "));
        assert!(!is_shell_command("node"));
        assert!(!is_shell_command("claude"));
    }
}
