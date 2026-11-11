import { expect, test } from "bun:test";
import { boxWord, pxWord, seamTag, shareWord, tagPlace } from "./seamtag";

const view = { w: 1200, h: 800 };
const tag = { w: 60, h: 20 };

test("the label sits below and right of the pointer", () => {
  expect(tagPlace({ x: 400, y: 300 }, view, tag)).toEqual({ x: 414, y: 314 });
});

test("at the window's right or bottom edge it goes to the pointer's other side", () => {
  expect(tagPlace({ x: 1180, y: 300 }, view, tag)).toEqual({ x: 1106, y: 314 });
  expect(tagPlace({ x: 400, y: 790 }, view, tag)).toEqual({ x: 414, y: 756 });
});

test("it never leaves the window by its top or left edge", () => {
  expect(tagPlace({ x: 30, y: 10 }, { w: 80, h: 30 }, tag)).toEqual({ x: 6, y: 6 });
});

test("a width or a height is said in whole px, a share as a percent, a box as both sides", () => {
  expect(pxWord(405.6)).toBe("406 px");
  expect(shareWord(0.4249)).toBe("42%");
  expect(boxWord(797.4, 682.5)).toBe("797 × 683");
});

test("with no page there is nothing to label, and nothing throws", () => {
  expect(() => seamTag("406 px", { clientX: 10, clientY: 10 })).not.toThrow();
  expect(() => seamTag(null)).not.toThrow();
});
