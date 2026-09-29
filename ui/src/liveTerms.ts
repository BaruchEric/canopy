/* The xterm behind every mounted shell view, by tab id: what copy, share
   and the agent buttons reach a live terminal through. */
import type { Terminal } from "@xterm/xterm";

export const LIVE = new Map<string, Terminal>();

/** Types text into a shell as one paste, then Enter, the way a person
 *  pasting a message into Claude Code would. False when no view of that
 *  shell is mounted here. */
export function typeInto(termId: string, text: string): boolean {
  const term = LIVE.get(termId);
  if (!term) return false;
  term.paste(text);
  term.input("\r");
  return true;
}
