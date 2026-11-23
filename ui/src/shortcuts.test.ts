import { expect, test } from "bun:test";
import { GO, SHORTCUTS, YANK, chordView, copyKeyOf, keyCaps, pressOf, shortcutFor, shortcutsOn } from "./shortcuts";

const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  pressOf({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("pressOf names ⌘ and Ctrl alike as mod, keeps a bare key as typed, and names Alt alone", () => {
  expect(press("k", { metaKey: true })).toBe("mod+k");
  expect(press("k", { ctrlKey: true })).toBe("mod+k");
  expect(press("F", { metaKey: true, shiftKey: true })).toBe("mod+shift+f");
  expect(press("?", { shiftKey: true })).toBe("?");
  expect(press("F", { shiftKey: true })).toBe("F");
  expect(press("Escape")).toBe("Escape");
  // Alt alone is named with the key as it came; with another modifier it is no shortcut's
  expect(press("ArrowUp", { altKey: true })).toBe("alt+ArrowUp");
  expect(press("k", { altKey: true })).toBe("alt+k");
  expect(press("ArrowUp", { altKey: true, shiftKey: true })).toBeNull();
  expect(press("k", { altKey: true, metaKey: true })).toBeNull();
});

test("shortcutFor finds a press on the views it works on and nowhere else", () => {
  expect(shortcutFor("d", "git")?.action).toBe("dirty");
  expect(shortcutFor("d", "library")).toBeNull();
  expect(shortcutFor("n", "health")).toBeNull();
  expect(shortcutFor("n", "manager")?.action).toBe("new");
  expect(shortcutFor("n", "git")?.action).toBe("new");
  expect(shortcutFor("?", "costs")?.action).toBe("help");
  expect(shortcutFor("mod+k", "kit")?.anywhere).toBe(true);
  expect(shortcutFor("mod+shift+f", "triggers")).toBeNull();
  // Shift+F is not f
  expect(shortcutFor("F", "git")).toBeNull();
});

test("shortcutsOn lists every shortcut on git and only the everywhere ones and the view's own elsewhere", () => {
  expect(shortcutsOn("git")).toHaveLength(SHORTCUTS.length);
  expect(shortcutsOn("manager").map((s) => s.press)).toEqual(["?", "mod+k", ":", "g", "y", "alt+ArrowUp", "alt+ArrowDown", "n"]);
  expect(shortcutsOn("library").map((s) => s.press)).toEqual(["?", "mod+k", ":", "g", "y", "alt+ArrowUp", "alt+ArrowDown"]);
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
  expect(chordView("o")).toBe("clock");
  expect(chordView("l")).toBe("library");
  expect(chordView("h")).toBe("health");
  // the incubator's projects are in the manager's view, which is m
  expect(chordView("i")).toBeNull();
  expect(chordView("s")).toBe("sessions");
  expect(chordView("b")).toBe("agents");
  expect(chordView("g")).toBe("git");
  expect(chordView("w")).toBe("work");
  expect(chordView("m")).toBe("manager");
  expect(chordView("z")).toBeNull();
});

test("the ring's keys work on git and triggers and nowhere else", () => {
  expect(shortcutFor("j", "git")?.action).toBe("next");
  expect(shortcutFor("ArrowDown", "triggers")?.action).toBe("next");
  expect(shortcutFor("k", "triggers")?.action).toBe("prev");
  expect(shortcutFor("ArrowUp", "git")?.action).toBe("prev");
  expect(shortcutFor(" ", "git")?.action).toBe("peek");
  expect(shortcutFor("Enter", "triggers")?.action).toBe("enter");
  expect(shortcutFor("Escape", "triggers")?.action).toBe("escape");
  expect(shortcutFor("j", "library")).toBeNull();
  expect(shortcutFor(" ", "sessions")).toBeNull();
  // J is not j, and g then k is still the kit's chord
  expect(shortcutFor("J", "git")).toBeNull();
  expect(chordView("k")).toBe("kit");
  expect(chordView("e")).toBe("plugins");
});

test("keyCaps shows mod as ⌘ on Apple and Ctrl elsewhere", () => {
  expect(keyCaps("mod+k", true)).toEqual(["⌘", "K"]);
  expect(keyCaps("mod+shift+f", false)).toEqual(["Ctrl", "Shift", "F"]);
  expect(keyCaps("Escape", true)).toEqual(["Esc"]);
  expect(keyCaps("?", false)).toEqual(["?"]);
  expect(keyCaps(" ", true)).toEqual(["Space"]);
  expect(keyCaps("ArrowDown", false)).toEqual(["↓"]);
  expect(keyCaps("Enter", false)).toEqual(["Enter"]);
  // the prompt rail's arrows: ⌥ on an Apple keyboard, Alt elsewhere
  expect(keyCaps("alt+ArrowUp", true)).toEqual(["⌥", "↑"]);
  expect(keyCaps("alt+ArrowDown", false)).toEqual(["Alt", "↓"]);
});

test("the prompt rail's keys step on every view and from a text box", () => {
  for (const view of ["git", "manager", "run", "agents"]) {
    expect(shortcutFor("alt+ArrowUp", view)).toMatchObject({ action: "message-prev", anywhere: true });
    expect(shortcutFor("alt+ArrowDown", view)).toMatchObject({ action: "message-next", anywhere: true });
  }
  // the keys sheet says when a message box gives them up
  expect(shortcutFor("alt+ArrowUp", "git")?.what).toContain("while the box is empty");
  // the ring's own arrows are still the ring's
  expect(shortcutFor("ArrowUp", "git")?.action).toBe("prev");
});

test("y arms the copy chord on every view, and copyKeyOf names the part a letter copies", () => {
  expect(shortcutFor("y", "git")?.action).toBe("yank");
  expect(shortcutFor("y", "sessions")?.action).toBe("yank");
  expect(YANK.map((y) => y.key)).toEqual(["b", "p", "r"]);
  expect(copyKeyOf("b")).toBe("b");
  expect(copyKeyOf("p")).toBe("p");
  expect(copyKeyOf("r")).toBe("r");
  expect(copyKeyOf("x")).toBeNull();
  // g then b and y then b are each their own chord's
  expect(chordView("b")).toBe("agents");
});
