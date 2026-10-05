import { expect, test } from "bun:test";
import { tappedOn, typesInto } from "./softkeys";

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

/** A pretend tree with the two things tappedOn reads off an element:
 *  `contains` and `closest("label")`, whose `control` is a field. */
function tree() {
  const parents = new Map<object, object | null>();
  const add = (tag: string, parent: object | null, control?: object) => {
    const self: object = {
      tagName: tag,
      control,
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
