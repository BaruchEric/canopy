import { expect, test } from "bun:test";
import { keyedWidth } from "./Resizer";

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
