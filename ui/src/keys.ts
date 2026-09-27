/**
 * The touch key bar under a shell: the keys a phone keyboard does not have
 * (Esc, Tab, the arrows, Ctrl and Alt) as the bytes a terminal sends for
 * them. Ctrl and Alt are sticky: tapped, they apply to the next key, from
 * the bar or from the phone's own keyboard. And the desktop shortcuts a
 * shell answers itself (`shortcutOf`). Pure and tested (keys.test.ts).
 */

export interface Mods {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODS: Mods = { ctrl: false, alt: false };

/** a key on the bar that sends something (Ctrl and Alt are toggles, not here) */
export type BarKey =
  | "esc"
  | "tab"
  | "backtab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pgup"
  | "pgdn"
  | "ctrl-c"
  | "ctrl-d";

export const BAR_KEYS: readonly { key: BarKey; label: string; title: string }[] = [
  { key: "esc", label: "esc", title: "Escape (interrupts Claude Code)" },
  { key: "tab", label: "tab", title: "Tab" },
  { key: "backtab", label: "⇧tab", title: "Shift+Tab (Claude Code's mode)" },
  { key: "left", label: "←", title: "Left" },
  { key: "up", label: "↑", title: "Up" },
  { key: "down", label: "↓", title: "Down" },
  { key: "right", label: "→", title: "Right" },
  { key: "ctrl-c", label: "^C", title: "Ctrl+C" },
  { key: "ctrl-d", label: "^D", title: "Ctrl+D" },
  { key: "home", label: "home", title: "Home" },
  { key: "end", label: "end", title: "End" },
  { key: "pgup", label: "pgup", title: "Page up" },
  { key: "pgdn", label: "pgdn", title: "Page down" },
];

const ESC = "\x1b";

/** the xterm modifier parameter: 1 + shift 1 + alt 2 + ctrl 4 */
const modParam = (m: Mods, shift = false) => 1 + (shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);

/** Ctrl held with one character, or null when Ctrl means nothing for it */
export function ctrlChar(ch: string): string | null {
  if (ch.length !== 1) return null;
  const c = ch.toLowerCase();
  if (c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96);
  const table: Record<string, number> = { "@": 0, " ": 0, "2": 0, "[": 27, "3": 27, "\\": 28, "4": 28, "]": 29, "5": 29, "^": 30, "6": 30, "_": 31, "-": 31, "7": 31, "?": 127, "8": 127 };
  const code = table[c];
  return code === undefined ? null : String.fromCharCode(code);
}

/**
 * What the phone's keyboard typed, with the armed modifiers applied. Only a
 * single character takes them (a word the keyboard committed at once, or a
 * paste, goes as it came); Ctrl with a character it means nothing for is
 * dropped rather than sent bare.
 */
export function withMods(data: string, m: Mods): string {
  if (!m.ctrl && !m.alt) return data;
  if ([...data].length !== 1) return data;
  let out = data;
  if (m.ctrl) out = ctrlChar(data) ?? data;
  return m.alt ? ESC + out : out;
}

/**
 * The bytes a bar key sends. `appCursor` is the terminal's application
 * cursor mode (DECCKM), which full-screen programs such as Claude Code and
 * vim turn on, and which changes what an unmodified arrow sends.
 */
export function keyBytes(key: BarKey, m: Mods, appCursor: boolean): string {
  const mods = m.ctrl || m.alt;
  const arrow = (c: string) => (mods ? `${ESC}[1;${modParam(m)}${c}` : appCursor ? `${ESC}O${c}` : `${ESC}[${c}`);
  const tilde = (n: number) => (mods ? `${ESC}[${n};${modParam(m)}~` : `${ESC}[${n}~`);
  const alt = (s: string) => (m.alt ? ESC + s : s);
  switch (key) {
    case "esc":
      return alt(ESC);
    case "tab":
      return m.ctrl ? `${ESC}[9;${modParam(m)}u` : alt("\t");
    case "backtab":
      return `${ESC}[Z`;
    case "up":
      return arrow("A");
    case "down":
      return arrow("B");
    case "right":
      return arrow("C");
    case "left":
      return arrow("D");
    case "home":
      return arrow("H");
    case "end":
      return arrow("F");
    case "pgup":
      return tilde(5);
    case "pgdn":
      return tilde(6);
    case "ctrl-c":
      return alt("\x03");
    case "ctrl-d":
      return alt("\x04");
  }
}

/** a desktop shortcut the shell answers itself, ahead of xterm */
export type Shortcut = { kind: "copy" } | { kind: "send"; bytes: string };

/** the parts of a KeyboardEvent a shortcut is read from */
export interface KeyPress {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌘ with a key on an Apple keyboard, as a Mac terminal takes it: line
 *  start, line end and delete to line start, in the readline bytes a shell
 *  and Claude Code both know */
const MAC_LINE: Record<string, string> = {
  ArrowLeft: "\x01",
  ArrowRight: "\x05",
  Backspace: "\x15",
};

/**
 * What a key press means to the shell before xterm sees it, or null to
 * leave it to xterm and the browser. On an Apple keyboard ⌘C copies and ⌘←
 * ⌘→ ⌘⌫ edit the line; elsewhere Ctrl+Shift+C copies, since Ctrl+C is the
 * interrupt and the browser's own Ctrl+Shift+C opens its inspector. Paste
 * is not here: ⌘V and Ctrl+Shift+V already reach xterm as a paste event,
 * which needs no clipboard permission, and ⌘A is xterm's own select all.
 */
export function shortcutOf(e: KeyPress, apple: boolean): Shortcut | null {
  if (e.type !== "keydown") return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (apple) {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
    if (key === "c") return { kind: "copy" };
    const bytes = MAC_LINE[key];
    return bytes === undefined ? null : { kind: "send", bytes };
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === "c") return { kind: "copy" };
  return null;
}
