/**
 * OSC 52, how a program in a terminal sets the clipboard: `ESC ] 52 ; Pc ;
 * Pd BEL`, Pc the selections to set (c, p, q, s, 0-7, or none for the
 * default) and Pd the text in base64. Claude Code copies its own mouse
 * selection this way, and inside tmux it wraps the sequence in tmux's
 * passthrough, which tmux unwraps for the browser's terminal. Pure and
 * tested (osc52.test.ts).
 */

const TARGETS = /^[cpqs0-7]*$/;

/**
 * The text an OSC 52 body (what follows `52;`) puts on the clipboard, or
 * null. A browser has one clipboard, so every selection a program names
 * lands there. A query (`?`) is null, and never answered: a program in the
 * shell does not get to read this browser's clipboard. So is an empty body
 * (a clear) and anything that is not valid base64 of UTF-8.
 */
export function osc52Text(body: string): string | null {
  const semi = body.indexOf(";");
  if (semi < 0) return null;
  const targets = body.slice(0, semi);
  const data = body.slice(semi + 1);
  if (!TARGETS.test(targets) || data === "" || data === "?") return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
