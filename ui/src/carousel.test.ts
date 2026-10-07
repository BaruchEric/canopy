import { describe, expect, test } from "bun:test";
import { canPan, overflowsX, snapTo, wheelPan } from "./carousel";

describe("carousel wheel", () => {
  test("over a head, a vertical wheel pans sideways", () => {
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: false }, "head", false)).toBe(40);
  });
  test("over content, a plain wheel is the content's", () => {
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: false }, "content", false)).toBe(0);
  });
  test("shift+wheel pans unless the content scrolls sideways itself", () => {
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: true }, "content", false)).toBe(40);
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: true }, "content", true)).toBe(0);
  });
  test("a sideways trackpad swipe is left to the browser everywhere", () => {
    expect(wheelPan({ deltaX: 30, deltaY: 2, shiftKey: false }, "head", false)).toBe(0);
  });
  // macOS turns a mouse's shift+wheel into a sideways one before the page
  // sees it; it pans the same, and a terminal in mouse mode cannot eat it
  test("shift+wheel that arrives sideways pans the same", () => {
    expect(wheelPan({ deltaX: 40, deltaY: 0, shiftKey: true }, "content", false)).toBe(40);
    expect(wheelPan({ deltaX: 40, deltaY: 0, shiftKey: true }, "content", true)).toBe(0);
    expect(wheelPan({ deltaX: -40, deltaY: 0, shiftKey: true }, "head", false)).toBe(-40);
  });
  // a trackpad pinch arrives as a ctrl+wheel; both are the page's zoom
  test("a ctrl or cmd wheel is a zoom, never a pan", () => {
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: false, ctrlKey: true }, "head", false)).toBe(0);
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: false, metaKey: true }, "head", false)).toBe(0);
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: true, ctrlKey: true }, "content", false)).toBe(0);
  });
});

describe("carousel bounds", () => {
  test("content scrolls sideways only past a pixel of overflow, and only where it may", () => {
    expect(overflowsX(401, 400, "auto")).toBe(false);
    expect(overflowsX(402, 400, "auto")).toBe(true);
    expect(overflowsX(900, 400, "scroll")).toBe(true);
    expect(overflowsX(900, 400, "hidden")).toBe(false);
    expect(overflowsX(400, 400, "auto")).toBe(false);
  });
  const row = { scrollLeft: 0, scrollWidth: 2000, clientWidth: 1000 };
  test("the row takes a wheel only where it can move that way", () => {
    expect(canPan(row, 40)).toBe(true);
    expect(canPan(row, -40)).toBe(false);
    expect(canPan({ ...row, scrollLeft: 1000 }, 40)).toBe(false);
    expect(canPan({ ...row, scrollLeft: 1000 }, -40)).toBe(true);
    // a fractional rest at the far end is the end
    expect(canPan({ ...row, scrollLeft: 999.5 }, 40)).toBe(false);
    expect(canPan({ ...row, scrollLeft: 500 }, 40)).toBe(true);
    expect(canPan({ ...row, scrollWidth: 1000 }, 40)).toBe(false);
    expect(canPan(row, 0)).toBe(false);
  });
});

describe("carousel snap", () => {
  const lefts = [0, 446, 1052, 1498];
  test("next and previous panel edges", () => {
    expect(snapTo(lefts, 0, 1)).toBe(446);
    expect(snapTo(lefts, 500, 1)).toBe(1052);
    expect(snapTo(lefts, 500, -1)).toBe(446);
    expect(snapTo(lefts, 446, -1)).toBe(0);
  });
  test("stops at the ends", () => {
    expect(snapTo(lefts, 1498, 1)).toBe(1498);
    expect(snapTo(lefts, 0, -1)).toBe(0);
  });
});
