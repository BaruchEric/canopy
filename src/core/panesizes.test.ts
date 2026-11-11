import { expect, test } from "bun:test";
import { PANES, isPane, paneChosen, paneShown, paneSizesOf, paneTop, paneVar, paneWords, parsePaneSizes, withPane } from "./panesizes";

test("saved sizes keep the names known here, each rounded and in its bounds", () => {
  expect(paneSizesOf({ lede: 300.6, "finder-list": 20, "prefs-rail": 9000, gone: 400, "clips-list": "wide", "board-rail": Number.NaN })).toEqual({
    lede: 301,
    "finder-list": PANES["finder-list"].min,
    "prefs-rail": PANES["prefs-rail"].max,
  });
});

test("anything but a record of sizes is no sizes", () => {
  for (const bad of [undefined, null, 4, "lede", [300]]) expect(paneSizesOf(bad)).toEqual({});
});

test("a pane is a name from the list, and its size lives in a property named after it", () => {
  expect(isPane("lede")).toBe(true);
  expect(isPane("toString")).toBe(false);
  expect(paneVar("sessions-side")).toBe("--pane-sessions-side");
});

test("setting a size rounds it and holds it in the pane's bounds", () => {
  expect(withPane({}, "lede", 300.4)).toEqual({ lede: 300 });
  expect(withPane({}, "lede", 10)).toEqual({ lede: PANES.lede.min });
  expect(withPane({ lede: 300 }, "board-rail", 99999)).toEqual({ lede: 300, "board-rail": PANES["board-rail"].max });
});

test("null hands the pane back to the stylesheet", () => {
  expect(withPane({ lede: 300, "prefs-rail": 200 }, "lede", null)).toEqual({ "prefs-rail": 200 });
  expect(withPane({ lede: 300 }, "lede", Number.NaN)).toEqual({});
});

test("a set that changes nothing returns the same sizes, so nothing is saved", () => {
  const sizes = { lede: 300 };
  expect(withPane(sizes, "lede", 300.2)).toBe(sizes);
  expect(withPane(sizes, "prefs-rail", null)).toBe(sizes);
});

test("the most a pane takes is what its container leaves, never under its own floor", () => {
  expect(paneTop("lede", 500.9)).toBe(500);
  expect(paneTop("lede", 40)).toBe(PANES.lede.min);
  expect(paneTop("lede", 99999)).toBe(PANES.lede.max);
  expect(paneTop("lede", Infinity)).toBe(PANES.lede.max);
});

test("a size shows held to the room there is now, and the setting is not what changes", () => {
  expect(paneShown("lede", 600, 2000)).toBe(600);
  expect(paneShown("lede", 600, 420)).toBe(420);
  expect(paneShown("lede", 600, 100)).toBe(PANES.lede.min);
});

test("a drag keeps the size it ends on, held to what fits", () => {
  expect(paneChosen("lede", 412.3, { start: 266, room: 2000, chosen: null })).toBe(412);
  expect(paneChosen("lede", 900, { start: 266, room: 500, chosen: null })).toBe(500);
});

test("a drag let go where it began changes nothing, set or not", () => {
  expect(paneChosen("lede", 266.2, { start: 266, room: 2000, chosen: null })).toBeNull();
  expect(paneChosen("lede", 420, { start: 420.4, room: 2000, chosen: 600 })).toBe(600);
});

test("a key has no start, so it always sets", () => {
  expect(paneChosen("lede", 266, { start: null, room: 2000, chosen: null })).toBe(266);
});

test("a well's drag stops at the height of what it holds, and the cap it leaves is every well's", () => {
  // a diff 300px of lines tall, under a cap of 800 set at a longer one
  expect(paneChosen("diff", 300, { start: 300, room: 300, chosen: 800 })).toBe(800);
  expect(paneChosen("diff", 220.4, { start: 300, room: 300, chosen: 800 })).toBe(220);
  expect(paneChosen("diff", 2000, { start: 450, room: 1310, chosen: null })).toBe(1310);
  expect(paneTop("diff", 40)).toBe(PANES.diff.min);
});

test("every pane has a word, and no two share one", () => {
  const words = Object.values(PANES).map((p) => p.word);
  expect(words.every((w) => w.length > 0)).toBe(true);
  expect(new Set(words).size).toBe(words.length);
});

test("a profile's sizes are checked: whole px in bounds, a name unknown here left out", () => {
  expect(parsePaneSizes({ lede: 320.6, diff: 640, gone: 5 })).toEqual({ paneSizes: { lede: 321, diff: 640 } });
  expect(parsePaneSizes({})).toEqual({ paneSizes: {} });
});

test("a size out of its pane's bounds, or no number, is an error that names the pane", () => {
  expect(parsePaneSizes({ lede: 10 })).toEqual({ error: "paneSizes.lede is a number from 180 to 960" });
  expect(parsePaneSizes({ "prefs-rail": "wide" })).toEqual({ error: "paneSizes.prefs-rail is a number from 140 to 480" });
  expect(parsePaneSizes({ diff: Number.NaN })).toEqual({ error: "paneSizes.diff is a number from 72 to 4800" });
  for (const bad of [null, 4, "lede", [300]]) expect("error" in parsePaneSizes(bad)).toBe(true);
});

test("a profile's sizes are said in the list's order, and an empty record as the default", () => {
  expect(paneWords({ diff: 640, lede: 320 })).toBe("summary column 320, diffs 640");
  expect(paneWords({})).toBe("default sizes");
});
