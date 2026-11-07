/**
 * A phone keyboard typing into a shell. Android keyboards type through IME
 * composition: a word is a composition that grows a letter at a time, and a
 * correction, a suggestion or a backspace rewrites it. xterm 6 sends a
 * composition only when it ends, so on a phone a word reached the shell at
 * the space. It also reads the composition off its hidden textarea by
 * position, and a Backspace it sends itself cancels the textarea's own
 * delete, so the textarea kept text the shell had dropped and the next word
 * the keyboard took back could arrive as the wrong letters (xterm.js #3600).
 *
 * On a touch screen `takeSoftInput` takes the textarea's typing from xterm:
 * each edit goes to the shell as it lands, as the difference between the
 * textarea before and after it, and a Backspace deletes in the textarea
 * first, so the textarea and the shell's line stay the same text. Keys the
 * textarea does not type (Enter, the arrows, Tab, a hardware keyboard's
 * letters) stay xterm's, which sends them and cancels them, so nothing is
 * sent twice. `editBytes` is pure and tested (softinput.test.ts); the rest
 * needs the DOM.
 */

const DEL = "\x7f";

/** What a terminal is sent for an edit that turned `before` into `after`:
 *  a DEL for each character from the first that differs to the end, then
 *  the new text from there, a line break as Enter. Characters, not UTF-16
 *  units, so an emoji is one DEL. An edit before the end retypes the tail,
 *  which leaves the shell's line the same as the textarea. */
export function editBytes(before: string, after: string): string {
  const a = [...before];
  const b = [...after];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return DEL.repeat(a.length - same) + b.slice(same).join("").replace(/\r?\n/g, "\r");
}

/** the parts of an xterm this needs */
export interface SoftInputTerm {
  readonly textarea: HTMLTextAreaElement | undefined;
  input(data: string, wasUserInput?: boolean): void;
}

/** Takes a touch screen's typing for `term`, whose element sits in `host`.
 *  Listens in the capture phase on `host`, so its handlers run before
 *  xterm's on the textarea and stop the ones it replaces. `on` says whether
 *  to act now: a coarse pointer, read at each event. Returns the undo. */
export function takeSoftInput(term: SoftInputTerm, host: HTMLElement, on: () => boolean): () => void {
  /** the textarea as the last edit left it, for an edit with no beforeinput */
  let last = "";
  /** the textarea as this edit's beforeinput found it */
  let before: string | null = null;
  const mine = (e: Event): HTMLTextAreaElement | null => {
    const ta = term.textarea;
    return ta && e.target === ta && on() ? ta : null;
  };
  // xterm's composition helper sends at the end, by position: never here
  const composition = (e: Event) => {
    if (mine(e)) e.stopPropagation();
  };
  const beforeInput = (e: Event) => {
    const ta = mine(e);
    if (ta) before = ta.value;
  };
  const input = (e: Event) => {
    const ta = mine(e);
    if (!ta) return;
    e.stopPropagation();
    // xterm's paste handler has sent a paste and emptied the textarea, but it
    // leaves the browser to insert the text too: that insertion is not sent
    if ((e as InputEvent).inputType === "insertFromPaste") {
      before = null;
      ta.value = "";
      last = "";
      return;
    }
    const bytes = editBytes(before ?? last, ta.value);
    before = null;
    if (bytes) term.input(bytes, true);
    // a line sent empties the textarea, as xterm's own Enter does, once no
    // composition is using it
    if (ta.value.includes("\n") && !(e as InputEvent).isComposing) ta.value = "";
    last = ta.value;
  };
  const keyDown = (e: KeyboardEvent) => {
    const ta = mine(e);
    if (!ta) return;
    // the keyboard editing (229 is its stand-in key): its input event
    // follows. A real key in a composition (Enter) is still xterm's, and the
    // composition's text has already gone.
    if (e.keyCode === 229) {
      e.stopPropagation();
      return;
    }
    // A plain Backspace with text behind the caret deletes in the textarea,
    // and its input event sends the DEL. Left to xterm it would send the DEL
    // and cancel the delete, leaving the textarea a character ahead. With
    // nothing behind the caret there is nothing to delete, and xterm sends it.
    if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey && ta.selectionEnd > 0) {
      e.stopPropagation();
      return;
    }
    // xterm takes the rest, and Enter and Ctrl+C empty the textarea there;
    // after the whole dispatch, since a microtask would run before xterm's
    // listener on the textarea
    setTimeout(() => {
      last = ta.value;
    }, 0);
  };
  host.addEventListener("compositionstart", composition, true);
  host.addEventListener("compositionupdate", composition, true);
  host.addEventListener("compositionend", composition, true);
  host.addEventListener("beforeinput", beforeInput, true);
  host.addEventListener("input", input, true);
  host.addEventListener("keydown", keyDown, true);
  return () => {
    host.removeEventListener("compositionstart", composition, true);
    host.removeEventListener("compositionupdate", composition, true);
    host.removeEventListener("compositionend", composition, true);
    host.removeEventListener("beforeinput", beforeInput, true);
    host.removeEventListener("input", input, true);
    host.removeEventListener("keydown", keyDown, true);
  };
}
