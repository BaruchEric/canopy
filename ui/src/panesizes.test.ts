import { expect, test } from "bun:test";
import { PANES, isPane, paneChosen, paneShown, paneSizesOf, paneTop, paneVar, withPane } from "./panesizes";

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
