import { describe, expect, test } from "bun:test";
import { fitShift } from "./pop";

describe("fitShift", () => {
  test("a box inside the window stays put", () => {
    expect(fitShift(100, 440, 1600)).toBe(0);
  });
  test("a box off the left edge moves right to the gap", () => {
    expect(fitShift(-291, 49, 1100)).toBe(299);
  });
  test("a box off the right edge moves left to the gap", () => {
    expect(fitShift(300, 640, 600)).toBe(-48);
  });
  test("a box wider than the window keeps its left edge in view", () => {
    expect(fitShift(-100, 500, 390)).toBe(108);
  });
});
