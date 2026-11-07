import { expect, test } from "bun:test";
import { KEYBOARD_MIN, KEY_ONLY, freeToFocus, keyboardFit, tappedOn, typesInto } from "./softkeys";

test("typesInto: text fields bring the keyboard, pickers and the rest do not", () => {
  expect(typesInto({ tagName: "TEXTAREA" })).toBe(true);
  for (const type of ["text", "search", "email", "url", "tel", "password", "number"])
    expect(typesInto({ tagName: "INPUT", type })).toBe(true);
  for (const type of ["checkbox", "radio", "range", "color", "date", "file", "button"])
    expect(typesInto({ tagName: "INPUT", type })).toBe(false);
  expect(typesInto({ tagName: "INPUT" })).toBe(true);
  expect(typesInto({ tagName: "DIV", isContentEditable: true })).toBe(true);
  expect(typesInto({ tagName: "DIV", isContentEditable: false })).toBe(false);
  expect(typesInto({ tagName: "BUTTON" })).toBe(false);
  expect(typesInto({ tagName: "SELECT" })).toBe(false);
});

/** A pretend tree with the things tappedOn reads off an element:
 *  `contains`, `closest("label")`, whose `control` is a field, and
 *  `hasAttribute`. */
function tree() {
  const parents = new Map<object, object | null>();
  const add = (tag: string, parent: object | null, control?: object, attrs: string[] = []) => {
    const self: object = {
      tagName: tag,
      control,
      hasAttribute: (name: string) => attrs.includes(name),
      contains: (o: object | null) => {
        for (let at = o; at; at = parents.get(at) ?? null) if (at === self) return true;
        return false;
      },
      closest: (sel: string) => {
        for (let at: object | null = self; at; at = parents.get(at) ?? null)
          if ((at as { tagName: string }).tagName.toLowerCase() === sel) return at;
        return null;
      },
    };
    parents.set(self, parent);
    return self as Element;
  };
  return add;
}

test("tappedOn: the field, a part of it, or a label for it", () => {
  const add = tree();
  const form = add("FORM", null);
  const field = add("INPUT", form);
  const editor = add("DIV", form);
  const word = add("SPAN", editor);
  const label = add("LABEL", form, field);
  const labelText = add("SPAN", label);
  const otherLabel = add("LABEL", form, editor);
  const button = add("BUTTON", form);
  expect(tappedOn(field, field)).toBe(true);
  expect(tappedOn(editor, word)).toBe(true);
  expect(tappedOn(field, label)).toBe(true);
  expect(tappedOn(field, labelText)).toBe(true);
  expect(tappedOn(field, otherLabel)).toBe(false);
  expect(tappedOn(field, button)).toBe(false);
  expect(tappedOn(field, form)).toBe(false);
  expect(tappedOn(field, null)).toBe(false);
});

test("tappedOn: a shell's textarea is never tapped on, even when the touch lands on it", () => {
  const add = tree();
  const view = add("DIV", null);
  const textarea = add("TEXTAREA", view, undefined, [KEY_ONLY]);
  const screen = add("DIV", view);
  expect(tappedOn(textarea, textarea)).toBe(false);
  expect(tappedOn(textarea, screen)).toBe(false);
});

test("keyboardFit: the page losing a keyboard's height is the keyboard up, getting it back is down", () => {
  let fit = keyboardFit(null, 412, 860);
  expect(fit.up).toBe(false);
  fit = keyboardFit(fit, 412, 520);
  expect(fit.up).toBe(true);
  fit = keyboardFit(fit, 412, 860);
  expect(fit.up).toBe(false);
});

test("keyboardFit: the address bar coming and going is not the keyboard", () => {
  let fit = keyboardFit(null, 412, 860);
  fit = keyboardFit(fit, 412, 804);
  expect(fit.up).toBe(false);
  fit = keyboardFit(fit, 412, 860);
  fit = keyboardFit(fit, 412, 860 - (KEYBOARD_MIN - 1));
  expect(fit.up).toBe(false);
});

test("keyboardFit: a keyboard that slides in and out over several resizes still counts", () => {
  let fit = keyboardFit(null, 412, 860);
  for (const h of [800, 740, 680, 620, 560]) fit = keyboardFit(fit, 412, h);
  expect(fit.up).toBe(true);
  for (const h of [590, 620, 650]) fit = keyboardFit(fit, 412, h);
  expect(fit.up).toBe(true);
  fit = keyboardFit(fit, 412, 760);
  expect(fit.up).toBe(false);
});

test("keyboardFit: a change of width starts over and keeps whether the keyboard is up", () => {
  let fit = keyboardFit(null, 412, 860);
  fit = keyboardFit(fit, 412, 520);
  // unfolded with the keyboard still up
  fit = keyboardFit(fit, 884, 560);
  expect(fit.up).toBe(true);
  fit = keyboardFit(fit, 884, 900);
  expect(fit.up).toBe(false);
  // folded with it down: a new width, not a keyboard
  fit = keyboardFit(fit, 412, 520);
  expect(fit.up).toBe(false);
});

test("freeToFocus: a shell never takes the caret from a field typed in elsewhere", () => {
  const add = tree();
  const page = add("BODY", null);
  const box = add("DIV", page);
  const own = add("TEXTAREA", box);
  const search = add("INPUT", page);
  const button = add("BUTTON", page);
  expect(freeToFocus(box, null)).toBe(true);
  expect(freeToFocus(box, page)).toBe(true);
  expect(freeToFocus(box, button)).toBe(true);
  expect(freeToFocus(box, own)).toBe(true);
  expect(freeToFocus(box, search)).toBe(false);
});
