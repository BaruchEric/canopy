import { expect, test } from "bun:test";
import { GLIDE_MIN, TERM_FONT_MAX, TERM_FONT_MIN, dragLines, gapOf, glide, pinchFont, speedOf, termFontSize } from "./touch";

test("termFontSize", () => {
  expect(termFontSize(13, 12)).toBe(13);
  expect(termFontSize(13.6, 12)).toBe(13.5);
  expect(termFontSize(12.5, 12)).toBe(12.5);
  expect(termFontSize(2, 12)).toBe(TERM_FONT_MIN);
  expect(termFontSize(99, 12)).toBe(TERM_FONT_MAX);
  expect(termFontSize("14", 12)).toBe(12);
  expect(termFontSize(Number.NaN, 12)).toBe(12);
  expect(termFontSize(undefined, 12)).toBe(12);
});

test("pinchFont scales by the spread", () => {
  expect(pinchFont(12, 100, 100)).toBe(12);
  expect(pinchFont(12, 100, 150)).toBe(18);
  expect(pinchFont(12, 100, 50)).toBe(TERM_FONT_MIN);
  expect(pinchFont(12, 100, 400)).toBe(TERM_FONT_MAX);
  expect(pinchFont(12, 0, 50)).toBe(12);
});

test("gapOf", () => {
  expect(gapOf({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
});

test("dragLines: a finger moving up shows later lines", () => {
  expect(dragLines(0, -40, 20)).toEqual({ lines: 2, carry: 0 });
  expect(dragLines(0, 40, 20)).toEqual({ lines: -2, carry: 0 });
  // under a row: nothing yet, all of it carried
  expect(dragLines(0, -15, 20)).toEqual({ lines: 0, carry: 15 });
  // the carry tips the next move over a row
  expect(dragLines(15, -10, 20)).toEqual({ lines: 1, carry: 5 });
  // turning back spends the carry first
  expect(dragLines(15, 10, 20)).toEqual({ lines: 0, carry: 5 });
  expect(dragLines(5, -5, 0)).toEqual({ lines: 0, carry: 0 });
});

test("glide slows and stops", () => {
  const v = glide(2, 16);
  expect(v).toBeCloseTo(1.9);
  expect(glide(-2, 16)).toBeCloseTo(-1.9);
  expect(glide(GLIDE_MIN, 16)).toBe(0);
  let s = 3;
  let steps = 0;
  while (s !== 0 && steps < 1000) {
    s = glide(s, 16);
    steps += 1;
  }
  expect(s).toBe(0);
  expect(steps).toBeLessThan(200);
});

test("speedOf reads the last stretch only", () => {
  expect(speedOf([])).toBe(0);
  expect(speedOf([{ y: 0, t: 0 }])).toBe(0);
  expect(speedOf([{ y: 0, t: 0 }, { y: 50, t: 50 }])).toBe(1);
  // the pause before lifting leaves only the still samples
  expect(speedOf([{ y: 0, t: 0 }, { y: 100, t: 50 }, { y: 100, t: 400 }])).toBe(0);
  expect(speedOf([{ y: 0, t: 0 }, { y: 0, t: 200 }, { y: -60, t: 260 }])).toBe(-1);
});
