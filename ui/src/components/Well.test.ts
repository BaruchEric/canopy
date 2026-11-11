import { expect, test } from "bun:test";
import { fullHeight } from "./Well";

const box = (offsetHeight: number, clientHeight: number, scrollHeight: number, onScreen = offsetHeight) => ({
  offsetHeight,
  clientHeight,
  scrollHeight,
  getBoundingClientRect: () => ({ height: onScreen }),
});

test("a scroller showing all it holds is as tall as it would ever be", () => {
  expect(fullHeight(box(300, 284, 284))).toBe(300);
});

test("one under its cap would be taller by what it has scrolled out of sight", () => {
  // 450 tall with 16 of padding, showing 434 of 1984
  expect(fullHeight(box(450, 434, 1984))).toBe(2000);
});

test("under a zoom the hidden part is scaled as the showing part already is", () => {
  expect(fullHeight(box(400, 400, 1000, 500))).toBe(1250);
  expect(fullHeight(box(400, 400, 1000, 200))).toBe(500);
});

test("one that is not laid out has no height to reach", () => {
  expect(fullHeight(null)).toBe(0);
  expect(fullHeight(box(0, 0, 0))).toBe(0);
});
