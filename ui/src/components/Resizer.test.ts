import { expect, test } from "bun:test";
import { followBy, keyedWidth, lentLeft } from "./Resizer";

const at = (key: string, value: number, shift = false) => keyedWidth({ key, shiftKey: shift }, { value, min: 240, top: 1200, dir: -1 });

test("the arrows step the width, the way the seam faces", () => {
  // a column seam sits on the column's left edge: rightwards narrows it
  expect(at("ArrowRight", 440)).toBe(428);
  expect(at("ArrowLeft", 440)).toBe(452);
  expect(at("ArrowLeft", 440, true)).toBe(488);
});

test("Home and End go to the limits, End to what fits now", () => {
  expect(at("Home", 440)).toBe(240);
  expect(at("End", 440)).toBe(1200);
});

test("a press at a limit, or a key it does not take, gives nothing to save", () => {
  expect(at("Home", 240)).toBeNull();
  expect(at("End", 1200)).toBeNull();
  expect(at("ArrowRight", 240)).toBeNull();
  expect(at("a", 440)).toBeNull();
});

const seam = { startLeft: 1000, startValue: 440, dir: -1 as const, factor: 1 };

test("a seam that stayed put while its column shrank scrolls back by the shrink", () => {
  // dragged 40 right, the column 40 narrower, the seam still at 1000
  expect(followBy(1000, { ...seam, next: 400 })).toBe(-40);
});

test("a seam that already moved with the width needs no scroll", () => {
  expect(followBy(1040, { ...seam, next: 400 })).toBe(0);
  expect(followBy(940, { ...seam, next: 500 })).toBe(0);
});

test("a widening the dock could not show scrolls the row on, so the seam goes left", () => {
  expect(followBy(1000, { ...seam, next: 500 })).toBe(60);
});

test("a centered pane's handle moves half the width change", () => {
  expect(followBy(1000, { startLeft: 1000, startValue: 400, next: 440, dir: 1, factor: 2 })).toBe(-20);
});

// two 440px columns at 1440x900: 892px of tracks in an 849px dock, 43px of it
// hidden on the right with nothing scrolled off the left
const capped = { startValue: 440, scrolled: 0, hidden: 43, room: 1960 };

test("at the dock's widest, a shrink with no scroll to give back widens the left neighbour by it", () => {
  expect(lentLeft({ ...capped, next: 400 })).toBe(40);
  // past the hidden overflow too: the dock stays at its widest throughout
  expect(lentLeft({ ...capped, next: 340 })).toBe(100);
});

test("a shrink scrolls back first and lends the neighbour only the rest", () => {
  expect(lentLeft({ ...capped, scrolled: 20, hidden: 23, next: 430 })).toBe(0);
  expect(lentLeft({ ...capped, scrolled: 20, hidden: 23, next: 400 })).toBe(20);
});

test("with nothing hidden on the right the dock narrows itself, so nothing is lent", () => {
  expect(lentLeft({ ...capped, hidden: 0, next: 400 })).toBe(0);
  expect(lentLeft({ ...capped, scrolled: 43, hidden: 0, next: 400 })).toBe(0);
  expect(lentLeft({ ...capped, hidden: 0.5, next: 400 })).toBe(0);
});

test("a widening lends nothing, and the neighbour takes no more than it has room for", () => {
  expect(lentLeft({ ...capped, next: 500 })).toBe(0);
  expect(lentLeft({ ...capped, room: 25, next: 400 })).toBe(25);
  expect(lentLeft({ ...capped, room: 0, next: 400 })).toBe(0);
});
