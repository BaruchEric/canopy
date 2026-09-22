import { describe, expect, test } from "bun:test";
import { PANEL_TERM_ROWS, cellHeight, rowsPx } from "./term";

describe("rowsPx", () => {
  test("is the rows at the cell height plus the box's padding and slack", () => {
    expect(rowsPx(5, 18)).toBe(5 * 18 + 13);
    expect(rowsPx(1, 17.5)).toBe(Math.ceil(17.5 + 13));
  });
  test("falls back to a plausible row where nothing can measure the font", () => {
    const cell = cellHeight();
    expect(cell).toBeGreaterThan(10);
    expect(cell).toBeLessThan(30);
    expect(rowsPx(PANEL_TERM_ROWS)).toBeGreaterThan(60);
  });
});
