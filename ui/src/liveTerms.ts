/* The xterm behind every mounted shell view, by tab id: what copy, share
   and the agent buttons reach a live terminal through. */
import type { Terminal } from "@xterm/xterm";
import type { TermTab } from "./term";

export const LIVE = new Map<string, Terminal>();

/** A shell view's screen: the terminal drawn there and the tab it shows. */
export interface ShellScreen {
  term: Terminal;
  /** as the view has it now, a rename included */
  tab: () => TermTab;
}

/** by the screen's element (`[data-term]`), not the tab's id: two views of
 *  one shell can be mounted at once, and a view's tab is not always in the
 *  store (a shell's own window, a task's, an agent's) */
const SCREENS = new WeakMap<Element, ShellScreen>();

/** A view says what its screen is, and null when it goes. */
export function noteScreen(el: Element, screen: ShellScreen | null): void {
  if (screen) SCREENS.set(el, screen);
  else SCREENS.delete(el);
}

/** The shell screen an element is in, for the screen's menu (FR-086). */
export function screenAt(el: Element | null): ShellScreen | null {
  const host = el?.closest("[data-term]");
  return host ? (SCREENS.get(host) ?? null) : null;
}

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

/** Whether the page may read the clipboard to paste it: a secure page in a
 *  browser that has `readText`. Over plain http on a tailnet address it may
 *  not, and the browser's own paste (⌘V, Ctrl+Shift+V) is what works. */
export const canPaste = (): boolean => isSecureContext && typeof navigator.clipboard?.readText === "function";

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
