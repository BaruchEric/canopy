/**
 * On a touch screen the phone's keyboard comes up for a finger on a text
 * field and nothing else. Focus that lands any other way still lands (a
 * dialog putting the caret in its box, a shell taking focus as it connects
 * or its tab shows, a tap on a shell's screen, which xterm answers by
 * focusing its hidden textarea), so a hardware keyboard types there as
 * before, but the field wears `inputmode="none"` until it loses focus, and
 * the phone keeps its keyboard down. A tap on the field itself, or on its
 * label, gives the keyboard back; a shell's has the ⌨ key (`showKeyboard`).
 * The predicates are pure and tested (softkeys.test.ts).
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

/** whether a finger put down on `tapped` was put down on the field itself,
 *  or on a label that hands it the focus */
export function tappedOn(field: Element, tapped: Element | null): boolean {
  if (!tapped) return false;
  if (field.contains(tapped)) return true;
  return (tapped.closest("label") as HTMLLabelElement | null)?.control === field;
}

/** where the last finger (or pointer) went down */
let tapped: Element | null = null;
/** the field `showKeyboard` is focusing, which gets its keyboard */
let asked: Element | null = null;
/** fields held to no keyboard, with the inputmode each had before */
const held = new Map<HTMLElement, string | null>();

const release = (el: HTMLElement) => {
  if (!held.has(el)) return;
  const was = held.get(el);
  held.delete(el);
  if (was == null) el.removeAttribute("inputmode");
  else el.setAttribute("inputmode", was);
};

/** Holds the phone's keyboard down for focus that no finger on the field
 *  asked for. Once, before the app mounts; a no-op off a touch screen. */
export function installSoftKeys(): void {
  const coarse = matchMedia("(pointer: coarse)");
  document.addEventListener(
    "pointerdown",
    (e) => {
      tapped = e.target instanceof Element ? e.target : null;
      // a finger on the field that has the focus without its keyboard: the
      // tap that follows brings the keyboard up
      const on = document.activeElement;
      if (on instanceof HTMLElement && held.has(on) && tappedOn(on, tapped)) release(on);
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !coarse.matches || !typesInto(el)) return;
      if (el === asked || tappedOn(el, tapped) || held.has(el)) return;
      held.set(el, el.getAttribute("inputmode"));
      el.setAttribute("inputmode", "none");
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
