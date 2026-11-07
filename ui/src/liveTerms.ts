/* The xterm behind every mounted shell view, by tab id: what copy, share
   and the agent buttons reach a live terminal through. */
import type { Terminal } from "@xterm/xterm";

export const LIVE = new Map<string, Terminal>();

/** Pastes text into a shell and puts the focus there, leaving Enter to the
 *  user, who sees what it landed on first. False when no view of that shell
 *  is mounted here. */
export function typeInto(termId: string, text: string): boolean {
  const term = LIVE.get(termId);
  if (!term) return false;
  term.paste(text);
  term.focus();
  return true;
}

/** the shell the keyboard was last in, by tab id, with what its tab says */
let last: { id: string; name: string } | null = null;

/** Notes that the keyboard went into a shell, for "paste into the shell". */
export function noteShellFocus(id: string, name: string): void {
  last = { id, name };
}

/** the shell the keyboard was last in while a view of it is still mounted here, or null */
export function lastShell(): { id: string; name: string } | null {
  return last && LIVE.has(last.id) ? last : null;
}
