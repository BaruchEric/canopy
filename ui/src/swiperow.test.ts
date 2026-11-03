import { describe, expect, test } from "bun:test";
import { showingAt } from "./swiperow";

// three panels of a 412px row, each a screen wide
const edges = [0, 412, 824];

describe("the swipe row's showing panel", () => {
  test("a row resting on a panel's edge shows that panel", () => {
    expect(showingAt(edges, 0)).toBe(0);
    expect(showingAt(edges, 412)).toBe(1);
    expect(showingAt(edges, 824)).toBe(2);
  });
  test("mid-swipe the dot moves once the next panel is more than half in", () => {
    expect(showingAt(edges, 205)).toBe(0);
    expect(showingAt(edges, 207)).toBe(1);
    expect(showingAt(edges, 617)).toBe(1);
    expect(showingAt(edges, 619)).toBe(2);
  });
  test("exactly half way stays with the earlier panel", () => {
    expect(showingAt(edges, 206)).toBe(0);
    expect(showingAt(edges, 618)).toBe(1);
  });
  test("a rubber band past either end is the end's panel", () => {
    expect(showingAt(edges, -40)).toBe(0);
    expect(showingAt(edges, 900)).toBe(2);
  });
  test("one panel is showing wherever the row is", () => {
    expect(showingAt([0], 0)).toBe(0);
    expect(showingAt([0], 30)).toBe(0);
  });
  test("no panels, no answer", () => {
    expect(showingAt([], 0)).toBe(-1);
  });
  test("a row the browser snapped a pixel short still shows the panel it rests on", () => {
    expect(showingAt(edges, 411)).toBe(1);
    expect(showingAt(edges, 823.5)).toBe(2);
  });
});
