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

/** an agent's input box with nothing typed in it: the prompt alone, or the
 *  placeholder it shows (Claude Code's `Try "…"`, Codex's "Ask Codex to do
 *  anything"), boxed or not */
const INPUT_PROMPT = /^[\s│┃|]*[❯›>](?:\s+(?:Try ".*"|Ask Codex to do anything))?[\s│┃|]*$/;

/**
 * Whether a terminal agent's screen shows a choice waiting on a person: a
 * numbered pick with the cursor on one of its options (Claude Code's
 * permission and its questions, `❯ 1. Yes`; Codex's approval, `› 1. Yes,
 * proceed`) or Claude Code's "Enter to confirm" (a folder's trust). A line
 * typed there and its Enter would pick an option, and an approval stays a
 * deliberate act in its own row (SPEC, 2026-11-07), so a steer waits.
 * Both agents draw a choice in place of their input box, while a prompt
 * sent or queued sits above the box behind the same `❯ ` (Claude Code
 * 2.1.325): with an empty input box on screen, only what is under it
 * counts. `screen` is the pane as tmux captures it, escapes and all.
 */
export function choiceOnScreen(screen: string): boolean {
  const lines = screen
    .replace(ESCAPES, "")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-CHOICE_TAIL);
  const below = lines.slice(lines.findLastIndex((l) => INPUT_PROMPT.test(l)) + 1);
  // a dialog drawn in a box puts its border before the cursor
  return below.some((l) => /^[\s│┃|]*[❯›>]\s*\d+\.\s/.test(l) || /\bEnter to confirm\b/.test(l));
}

/**
 * Whether Codex's agent list fills the screen: its "Agent command center",
 * which ← at an empty prompt opens (the phone's key bar has a ←, and a
 * swipe on Gboard's space bar sends one), as does esc at its folder-trust
 * question. Letters there are commands on the selected task (f forks it, r
 * renames it, x stops it, p pins it, backspace deletes it), Enter opens a
 * task, and nothing reaches the agent, so a steer waits; esc goes back to
 * the prompt. Codex 0.169 draws the title on the first line and its keys
 * (`? help  esc back  ↑/↓ move  enter open`) on the last.
 */
export function codexAgentListOnScreen(screen: string): boolean {
  const lines = screen
    .replace(ESCAPES, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  return /^\s*Agent command center\b/.test(lines[0] ?? "") || lines.slice(-3).some((l) => /^\s*\?\s+help\s+esc back\b/.test(l));
}

/** The words a person typed, ready to send: trimmed, or why they cannot go. */
export function steerWords(text: string): { ok: true; words: string } | { ok: false; error: string } {
  const words = text.trim();
  if (!words) return { ok: false, error: "say something first" };
  if (words.length > STEER_MAX) return { ok: false, error: `a message is at most ${STEER_MAX} characters` };
  return { ok: true, words };
}
