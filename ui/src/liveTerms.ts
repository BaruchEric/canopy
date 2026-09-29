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
