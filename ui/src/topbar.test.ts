import { expect, test } from "bun:test";
import { TUCK_HOLD_MS, TUCK_SLOP, TUCK_START, nextTuck, scrollEdges, type Tuck } from "./topbar";

const room = 80;
const range = 2000;

let clock = 10_000;

/** Feed a run of scrollTops through, each past the hold the last one set. */
function run(tops: number[], from: Tuck = TUCK_START): Tuck {
  let t = from;
  for (const top of tops) {
    clock += TUCK_HOLD_MS + 1;
    t = nextTuck(t, { top, range, room, now: clock });
  }
  return t;
}

test("scrolling down past the slop folds the rows", () => {
  const at = { ...TUCK_START, anchor: 100 };
  expect(run([100 + TUCK_SLOP], at).tucked).toBe(false);
  expect(run([100 + TUCK_SLOP + 1], at).tucked).toBe(true);
});

test("scrolling back up past the slop brings them back", () => {
  const down = run([100, 400]);
  expect(down.tucked).toBe(true);
  expect(run([395], down).tucked).toBe(true);
  expect(run([400 - TUCK_SLOP - 1], down).tucked).toBe(false);
});

test("a turn is measured from where it began", () => {
  // down to 600, then up in small steps: each step alone is under the slop
  const t = run([100, 400, 600, 596, 592, 588]);
  expect(t.tucked).toBe(false);
});

test("near the top the rows show", () => {
  const down = run([100, 400]);
  expect(run([10], down).tucked).toBe(false);
  expect(run([0, 20]).tucked).toBe(false);
});

test("too little to scroll never folds", () => {
  // with the rows out the cards scroll a little under three rows' heights
  expect(nextTuck(TUCK_START, { top: 200, range: room * 3 - 1, room, now: 1 }).tucked).toBe(false);
  // folded, the range is measured as it would be with the rows out
  const folded = { tucked: true, anchor: 150, hold: 0 };
  expect(nextTuck(folded, { top: 145, range: room * 2 - 1, room, now: 1 }).tucked).toBe(false);
  expect(nextTuck(folded, { top: 145, range: room * 2, room, now: 1 }).tucked).toBe(true);
});

test("the hold ignores the clamp a fold causes", () => {
  const folded = nextTuck({ tucked: false, anchor: 1900, hold: 0 }, { top: 1950, range, room, now: 1000 });
  expect(folded.tucked).toBe(true);
  // the cards grew by the rows' height, so the browser pulls the scroll back
  const clamped = nextTuck(folded, { top: 1950 - room, range: range - room, room, now: 1100 });
  expect(clamped.tucked).toBe(true);
  expect(clamped.anchor).toBe(1950 - room);
});

test("an overscroll past either end reads as the end", () => {
  const t = run([100, 400]);
  expect(run([range + 300], t).anchor).toBe(range);
  expect(run([-50], t).tucked).toBe(false);
});

test("scrollEdges", () => {
  expect(scrollEdges(0, 600, 300)).toEqual({ start: false, end: true });
  expect(scrollEdges(150, 600, 300)).toEqual({ start: true, end: true });
  expect(scrollEdges(300, 600, 300)).toEqual({ start: true, end: false });
  expect(scrollEdges(0, 300, 300)).toEqual({ start: false, end: false });
});
