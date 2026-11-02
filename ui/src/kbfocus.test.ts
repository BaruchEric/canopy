import { expect, test } from "bun:test";
import { OWN_ARROWS, PRESSES, TYPES_INTO, homeZone, kbKey, keepKb, parseKb, ringOf, ringTakes, stepKb, triggerKbId, triggerOf, uniqueKeys } from "./kbfocus";

const list = ["a", "b", "c", "d", "e"];

test("keys split at the first colon, so a repo id with colons of its own comes back whole", () => {
  expect(kbKey("repo", "ssh://mini/home/eric/x")).toBe("repo:ssh://mini/home/eric/x");
  expect(parseKb("repo:ssh://mini/home/eric/x")).toEqual({ kind: "repo", id: "ssh://mini/home/eric/x" });
  expect(parseKb("inbox:ask:42")).toEqual({ kind: "inbox", id: "ask:42" });
  expect(parseKb("trigger:mini:ab12cd34")).toEqual({ kind: "trigger", id: "mini:ab12cd34" });
  expect(parseKb("card:x")).toBeNull();
  expect(parseKb("repo:")).toBeNull();
  expect(parseKb(":x")).toBeNull();
  expect(parseKb("repo")).toBeNull();
});

test("a trigger row's id is its backend and its event, read back at the last colon", () => {
  expect(triggerOf(triggerKbId("mini", "ab12cd34"))).toEqual({ backend: "mini", eventId: "ab12cd34" });
  expect(triggerOf(triggerKbId("a:b", "e1"))).toEqual({ backend: "a:b", eventId: "e1" });
  expect(triggerOf("nocolon")).toBeNull();
  expect(triggerOf("mini:")).toBeNull();
});

test("ringOf says what the ring is on only while it shows", () => {
  expect(ringOf({ kbFocus: "repo:/x", kbRing: true })).toEqual({ kind: "repo", id: "/x" });
  expect(ringOf({ kbFocus: "repo:/x", kbRing: false })).toBeNull();
  expect(ringOf({ kbFocus: null, kbRing: true })).toBeNull();
});

test("uniqueKeys keeps the first of each, so a tree row and its card are one item", () => {
  expect(uniqueKeys(["repo:a", "repo:b", "repo:a", "repo:c", "repo:b"])).toEqual(["repo:a", "repo:b", "repo:c"]);
});

test("stepKb moves on and back and holds at both ends", () => {
  expect(stepKb(list, "b", 1)).toBe("c");
  expect(stepKb(list, "b", -1)).toBe("a");
  expect(stepKb(list, "a", -1)).toBe("a");
  expect(stepKb(list, "e", 1)).toBe("e");
  expect(stepKb(list, "b", 10)).toBe("e");
  expect(stepKb(list, "d", -10)).toBe("a");
});

test("the first press with no place rings the first item, either way, and an empty list rings nothing", () => {
  expect(stepKb(list, null, 1)).toBe("a");
  expect(stepKb(list, null, -1)).toBe("a");
  expect(stepKb([], null, 1)).toBeNull();
  expect(stepKb([], "a", 1)).toBeNull();
  // a place this list never had, another zone's
  expect(stepKb(list, "z", -1, ["y", "z"])).toBe("a");
});

test("from a place that left the list, j lands on the next one still there and k on the one before", () => {
  const before = ["a", "b", "c", "d", "e"];
  const now = ["a", "b", "d", "e"];
  expect(stepKb(now, "c", 1, before)).toBe("d");
  expect(stepKb(now, "c", -1, before)).toBe("b");
  // the first step lands, the rest move on from there
  expect(stepKb(now, "c", 2, before)).toBe("e");
  // several gone in a row
  expect(stepKb(["a", "e"], "c", 1, before)).toBe("e");
  expect(stepKb(["a", "e"], "c", -1, before)).toBe("a");
  // nothing left that way: the nearest the other way
  expect(stepKb(["a", "b"], "d", 1, before)).toBe("b");
  expect(stepKb(["d", "e"], "b", -1, before)).toBe("d");
  // nothing of the old list left: the first item
  expect(stepKb(["x", "y"], "c", 1, before)).toBe("x");
});

test("keepKb holds the place by key while it is listed, however the list moved around it", () => {
  expect(keepKb(["e", "c", "a"], "c", list)).toBe("c");
  expect(keepKb(list, null, list)).toBeNull();
});

test("keepKb gives a place that left the list to the next one still there, else the one before, else none", () => {
  expect(keepKb(["a", "b", "d", "e"], "c", list)).toBe("d");
  expect(keepKb(["a", "b"], "e", list)).toBe("b");
  expect(keepKb(["x"], "c", list)).toBeNull();
  expect(keepKb(["a"], "c", [])).toBeNull();
});

test("homeZone is the cards on git and the rows on triggers, and nothing elsewhere", () => {
  expect(homeZone("git")).toBe("repos");
  expect(homeZone("triggers")).toBe("triggers");
  expect(homeZone("library")).toBeNull();
});

/** a stand-in for an element: `closest` matches when the selector names one of its kinds */
const at = (...kinds: string[]) => ({
  closest: (sel: string) => (sel.split(",").some((s) => kinds.includes(s.trim())) ? {} : null),
});

test("the selectors name what the guards check", () => {
  expect(TYPES_INTO).toContain(".xterm");
  expect(TYPES_INTO).toContain("textarea");
  expect(OWN_ARROWS).toContain('[role="tab"]');
  expect(PRESSES).toContain("button");
});

test("ringTakes leaves a text box, a select and a shell their letters, Space and arrows", () => {
  for (const press of ["j", "k", "ArrowDown", "ArrowUp", " ", "Enter"] as const) {
    expect(ringTakes(press, at("input"))).toBe(false);
    expect(ringTakes(press, at("select"))).toBe(false);
    expect(ringTakes(press, at(".xterm"))).toBe(false);
    expect(ringTakes(press, at('[contenteditable]:not([contenteditable="false"])'))).toBe(false);
  }
});

test("ringTakes leaves the arrows to tabs and radios but takes j and k there", () => {
  expect(ringTakes("ArrowDown", at('[role="tab"]'))).toBe(false);
  expect(ringTakes("ArrowUp", at('[role="radio"]'))).toBe(false);
  expect(ringTakes("j", at('[role="tab"]'))).toBe(true);
  expect(ringTakes("k", at('[role="radio"]'))).toBe(true);
});

test("ringTakes leaves Space and Enter to a focused button or card, and takes them on the page itself", () => {
  expect(ringTakes(" ", at("button"))).toBe(false);
  expect(ringTakes("Enter", at('[tabindex]:not([tabindex="-1"])'))).toBe(false);
  expect(ringTakes("j", at("button"))).toBe(true);
  expect(ringTakes("ArrowDown", at("button"))).toBe(true);
  expect(ringTakes(" ", at())).toBe(true);
  expect(ringTakes("Enter", at())).toBe(true);
  expect(ringTakes("Enter", null)).toBe(true);
});
