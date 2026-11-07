/**
 * On a touch screen the phone's keyboard comes up for a tap on a text field
 * and nothing else. Focus that lands any other way still lands (a dialog
 * putting the caret in its box, a shell taking focus as it connects or its
 * tab shows, a tap on a shell's screen, which xterm answers by focusing its
 * hidden textarea), so a hardware keyboard types there as before, but the
 * field wears `inputmode="none"` until it loses focus, and the phone keeps
 * its keyboard down. A tap on the field itself, or on its label, gives the
 * keyboard back; a shell's has the ⌨ key (`showKeyboard`).
 *
 * It is the tap that counts, the click, never the finger going down: a
 * finger that goes down on a field and scrolls leaves it held. A field put
 * away by the phone's own hide key, which leaves it focused, is held again,
 * since a phone raises its keyboard after any tap while a field has the
 * focus, and a tap on a shell's screen or on a key that keeps the focus
 * would bring it back. A shell's textarea (`KEY_ONLY`) is never tapped on:
 * it sits under the caret, and a phone aims a touch near a focused field at
 * the field. The predicates are pure and tested (softkeys.test.ts).
 */

/** the input types a phone answers with its keyboard; the rest (a checkbox,
 *  a date, a colour, a range) bring a picker or nothing */
const TYPED = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** whether focus on `el` brings up a phone's keyboard */
export function typesInto(el: { tagName: string; type?: string; isContentEditable?: boolean }): boolean {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return TYPED.has(el.type ?? "text");
  return el.isContentEditable === true;
}

/** Whether a shell in `box` may take the focus by itself (as it connects,
 *  or connects again after a drop) without pulling it out of a text field
 *  being typed in elsewhere, which on a phone also puts the keyboard down. */
export function freeToFocus(box: { contains(el: Element | null): boolean }, active: Element | null): boolean {
  if (!active || box.contains(active)) return true;
  return !typesInto(active as Element & { type?: string; isContentEditable?: boolean });
}

/** the attribute on a field whose keyboard comes from a key alone: a
 *  shell's hidden textarea */
export const KEY_ONLY = "data-key-only";

/** whether a tap on `tapped` was a tap on the field itself, or on a label
 *  that hands it the focus; never on a `KEY_ONLY` field */
export function tappedOn(field: Element, tapped: Element | null): boolean {
  if (!tapped || field.hasAttribute(KEY_ONLY)) return false;
  if (field.contains(tapped)) return true;
  return (tapped.closest("label") as HTMLLabelElement | null)?.control === field;
}

/** the least a page loses to a phone's keyboard, in CSS px: more than the
 *  address bar coming and going, less than any keyboard */
export const KEYBOARD_MIN = 120;

/** The page's size as the keyboard last left it: under
 *  `interactive-widget=resizes-content` a keyboard coming up takes its
 *  height off the page and going down gives it back. */
export interface KeyboardFit {
  w: number;
  /** the height with the keyboard down */
  rest: number;
  /** the least height since the keyboard came up */
  low: number;
  up: boolean;
}

/** The fit after the page became `w` by `h`. A change of width is the
 *  window or the fold, not the keyboard, and starts over from there. The
 *  heights are kept, not compared step to step, so a keyboard that slides
 *  in over several resizes still counts. */
export function keyboardFit(fit: KeyboardFit | null, w: number, h: number): KeyboardFit {
  if (!fit || fit.w !== w) return { w, rest: h, low: h, up: fit?.up ?? false };
  if (!fit.up)
    return fit.rest - h >= KEYBOARD_MIN ? { w, rest: fit.rest, low: h, up: true } : { w, rest: Math.max(fit.rest, h), low: h, up: false };
  return h - fit.low >= KEYBOARD_MIN ? { w, rest: h, low: h, up: false } : { ...fit, low: Math.min(fit.low, h) };
}

/** where the last finger (or pointer) went down, until it scrolls */
let tapped: Element | null = null;
/** the field `showKeyboard` is focusing, which gets its keyboard */
let asked: Element | null = null;
/** fields held to no keyboard, with the inputmode each had before */
const held = new Map<HTMLElement, string | null>();

const hold = (el: HTMLElement) => {
  if (held.has(el)) return;
  held.set(el, el.getAttribute("inputmode"));
  el.setAttribute("inputmode", "none");
};

const release = (el: HTMLElement) => {
  if (!held.has(el)) return;
  const was = held.get(el);
  held.delete(el);
  if (was == null) el.removeAttribute("inputmode");
  else el.setAttribute("inputmode", was);
};

/** Holds the phone's keyboard down for focus that no tap on the field
 *  asked for. Once, before the app mounts; a no-op off a touch screen. */
export function installSoftKeys(): void {
  const coarse = matchMedia("(pointer: coarse)");
  document.addEventListener(
    "pointerdown",
    (e) => {
      tapped = e.target instanceof Element ? e.target : null;
    },
    true,
  );
  // the browser took the finger for a scroll: it was not a tap
  document.addEventListener("pointercancel", () => (tapped = null), true);
  // A tap on the field that has the focus without its keyboard. The click
  // comes inside the phone's handling of the tap, before it decides on the
  // keyboard, so the keyboard comes up for this tap.
  document.addEventListener(
    "click",
    (e) => {
      const on = document.activeElement;
      if (on instanceof HTMLElement && held.has(on) && tappedOn(on, e.target instanceof Element ? e.target : null)) release(on);
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !coarse.matches || !typesInto(el)) return;
      if (el === asked || tappedOn(el, tapped)) return;
      hold(el);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target instanceof HTMLElement) release(e.target);
    },
    true,
  );
  // the keyboard put away with the field still focused: held again
  let fit = keyboardFit(null, window.innerWidth, window.innerHeight);
  window.addEventListener("resize", () => {
    const was = fit;
    fit = keyboardFit(fit, window.innerWidth, window.innerHeight);
    const on = document.activeElement;
    if (was.up && !fit.up && coarse.matches && on instanceof HTMLElement && typesInto(on)) hold(on);
  });
}

/** Focuses `el` with the phone's keyboard up: the ⌨ key on a shell. Called
 *  from a pointer down, which is what lets a phone raise its keyboard; a
 *  field already focused is let go and taken again, since a phone only looks
 *  at whether to show its keyboard as focus arrives. */
export function showKeyboard(el: HTMLElement | undefined): void {
  if (!el) return;
  asked = el;
  try {
    if (document.activeElement === el) el.blur();
    release(el);
    el.focus({ preventScroll: true });
  } finally {
    asked = null;
  }
}
