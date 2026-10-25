import { expect, test } from "bun:test";
import { COLORS, arrowHead, boxOf, colorName, markupWords, penPath, tooSmall, type Shape } from "./markup";

const red = COLORS[0]?.hex ?? "";
const blue = COLORS[1]?.hex ?? "";

const arrow: Shape = { kind: "arrow", color: red, from: { x: 10, y: 20 }, to: { x: 100, y: 40 } };
const box: Shape = { kind: "box", color: blue, from: { x: 85, y: 35 }, to: { x: 5, y: 5 } };
const text: Shape = { kind: "text", color: blue, at: { x: 20.4, y: 30 }, text: ' move "this" ' };
const pen: Shape = { kind: "pen", color: red, points: [{ x: 10, y: 10 }, { x: 130, y: 50 }, { x: 60, y: 12 }] };
const shapes: Shape[] = [arrow, box, text, pen];

test("colorName names the palette and keeps anything else", () => {
  expect(colorName(red)).toBe("red");
  expect(colorName(blue)).toBe("blue");
  expect(colorName("#123456")).toBe("#123456");
});

test("boxOf is the shape's box, whichever corner it was drawn from, rounded", () => {
  expect(boxOf(arrow)).toEqual({ x: 10, y: 20, width: 90, height: 20 });
  expect(boxOf(box)).toEqual({ x: 5, y: 5, width: 80, height: 30 });
  expect(boxOf(text)).toEqual({ x: 20, y: 30, width: 0, height: 0 });
  expect(boxOf(pen)).toEqual({ x: 10, y: 10, width: 120, height: 40 });
});

test("tooSmall is a click without a drag, an empty text, or a pen that never moved", () => {
  expect(tooSmall({ kind: "box", color: red, from: { x: 1, y: 1 }, to: { x: 3, y: 2 } })).toBe(true);
  expect(tooSmall({ kind: "box", color: red, from: { x: 1, y: 1 }, to: { x: 9, y: 2 } })).toBe(false);
  expect(tooSmall({ kind: "arrow", color: red, from: { x: 1, y: 1 }, to: { x: 2, y: 2 } })).toBe(true);
  expect(tooSmall({ kind: "arrow", color: red, from: { x: 1, y: 1 }, to: { x: 1, y: 9 } })).toBe(false);
  expect(tooSmall({ kind: "text", color: red, at: { x: 1, y: 1 }, text: "  " })).toBe(true);
  expect(tooSmall({ kind: "text", color: red, at: { x: 1, y: 1 }, text: "a" })).toBe(false);
  expect(tooSmall({ kind: "pen", color: red, points: [{ x: 1, y: 1 }] })).toBe(true);
  expect(tooSmall({ kind: "pen", color: red, points: [{ x: 1, y: 1 }, { x: 1.5, y: 1 }] })).toBe(true);
  expect(tooSmall({ kind: "pen", color: red, points: [{ x: 1, y: 1 }, { x: 9, y: 1 }] })).toBe(false);
});

test("penPath joins the points, and a lone point still draws a dot", () => {
  expect(penPath([{ x: 10, y: 20 }, { x: 30.26, y: 40 }])).toBe("M10 20 L30.3 40");
  expect(penPath([{ x: 10, y: 20 }])).toBe("M10 20 L10 20");
  expect(penPath([])).toBe("");
});

test("arrowHead is the two barbs at the tip, swept back along the line", () => {
  const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 10, y: 0 }, 10);
  expect(a.x).toBeCloseTo(10 - 10 * Math.cos(Math.PI / 6), 5);
  expect(a.y).toBeCloseTo(-5, 5);
  expect(b.x).toBeCloseTo(a.x, 5);
  expect(b.y).toBeCloseTo(5, 5);
  const [up] = arrowHead({ x: 0, y: 10 }, { x: 0, y: 0 }, 10);
  expect(up.y).toBeCloseTo(10 * Math.cos(Math.PI / 6), 5);
});

test("markupWords says each mark in order, colours by name, text quoted", () => {
  expect(markupWords(shapes)).toBe('a red arrow from 10,20 to 100,40; a blue box 80x30 at 5,5; the text "move \\"this\\"" in blue at 20,30; a red pen stroke over 120x40 at 10,10');
  expect(markupWords([])).toBe("");
});
