import { expect, test } from "bun:test";
import { GO, SHORTCUTS, chordView, keyCaps, pressOf, shortcutFor, shortcutsOn } from "./shortcuts";

const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  pressOf({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("pressOf names ⌘ and Ctrl alike as mod, keeps a bare key as typed, and drops Alt", () => {
  expect(press("k", { metaKey: true })).toBe("mod+k");
  expect(press("k", { ctrlKey: true })).toBe("mod+k");
  expect(press("F", { metaKey: true, shiftKey: true })).toBe("mod+shift+f");
  expect(press("?", { shiftKey: true })).toBe("?");
  expect(press("F", { shiftKey: true })).toBe("F");
  expect(press("Escape")).toBe("Escape");
  expect(press("k", { altKey: true })).toBeNull();
});

test("shortcutFor finds a press on the views it works on and nowhere else", () => {
  expect(shortcutFor("d", "git")?.action).toBe("dirty");
  expect(shortcutFor("d", "library")).toBeNull();
  expect(shortcutFor("n", "incubator")?.action).toBe("new");
  expect(shortcutFor("n", "health")).toBeNull();
  expect(shortcutFor("?", "costs")?.action).toBe("help");
  expect(shortcutFor("mod+k", "kit")?.anywhere).toBe(true);
  expect(shortcutFor("mod+shift+f", "triggers")).toBeNull();
  // Shift+F is not f
  expect(shortcutFor("F", "git")).toBeNull();
});

test("shortcutsOn lists every shortcut on git and only the everywhere ones and the view's own elsewhere", () => {
  expect(shortcutsOn("git")).toHaveLength(SHORTCUTS.length);
  expect(shortcutsOn("library").map((s) => s.press)).toEqual(["?", "mod+k", ":", "g"]);
  expect(shortcutsOn("incubator").map((s) => s.press)).toEqual(["?", "mod+k", ":", "g", "n"]);
});

test("no press means two things on one view", () => {
  for (const view of ["git", ...GO.map((g) => g.view)]) {
    const presses = shortcutsOn(view).map((s) => s.press);
    expect(new Set(presses).size).toBe(presses.length);
  }
  expect(new Set(GO.map((g) => g.key)).size).toBe(GO.length);
});

test("chordView goes to the view a letter names, and nowhere for a letter it does not", () => {
  expect(chordView("t")).toBe("triggers");
  expect(chordView("l")).toBe("library");
  expect(chordView("h")).toBe("health");
  expect(chordView("i")).toBe("incubator");
  expect(chordView("s")).toBe("sessions");
  expect(chordView("b")).toBe("agents");
  expect(chordView("g")).toBe("git");
  expect(chordView("z")).toBeNull();
});

test("keyCaps shows mod as ⌘ on Apple and Ctrl elsewhere", () => {
  expect(keyCaps("mod+k", true)).toEqual(["⌘", "K"]);
  expect(keyCaps("mod+shift+f", false)).toEqual(["Ctrl", "Shift", "F"]);
  expect(keyCaps("Escape", true)).toEqual(["Esc"]);
  expect(keyCaps("?", false)).toEqual(["?"]);
});
