/** Steering what runs: a person's words into a run, a chat, a shell's
 *  agent or a task's terminal while it works. The pure half, browser-safe,
 *  shared by the server and the page. */

/** the most one steer carries: a person's message, not a file */
export const STEER_MAX = 8_000;

/** what a terminal's escape sequences are, so a screen reads as its words */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** how far up a screen a live choice is looked for: a dialog draws in the
 *  pane's last lines */
const CHOICE_TAIL = 25;

/**
 * Whether a terminal agent's screen shows a choice waiting on a person: a
 * numbered pick with the cursor on one of its options (Claude Code's
 * permission and its questions, `❯ 1. Yes`; Codex's approval, `› 1. Yes,
 * proceed`) or Claude Code's "Enter to confirm" (a folder's trust). A line
 * typed there and its Enter would pick an option, and an approval stays a
 * deliberate act in its own row (SPEC, 2026-11-07), so a steer waits.
 * `screen` is the pane as tmux captures it, escapes and all.
 */
export function choiceOnScreen(screen: string): boolean {
  const lines = screen
    .replace(ESCAPES, "")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-CHOICE_TAIL);
  // a dialog drawn in a box puts its border before the cursor
  return lines.some((l) => /^[\s│┃|]*[❯›>]\s*\d+\.\s/.test(l) || /\bEnter to confirm\b/.test(l));
}

/** The words a person typed, ready to send: trimmed, or why they cannot go. */
export function steerWords(text: string): { ok: true; words: string } | { ok: false; error: string } {
  const words = text.trim();
  if (!words) return { ok: false, error: "say something first" };
  if (words.length > STEER_MAX) return { ok: false, error: `a message is at most ${STEER_MAX} characters` };
  return { ok: true, words };
}
