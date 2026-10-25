/* The preview's draw mode, the pure part (FR-029): the marks drawn over the
   framed page, their geometry for the SVG that shows them, and the words
   they become for an agent that cannot see the picture. Coordinates are
   CSS pixels from the frame's top left, which is the page's viewport. */
import type { Rect } from "./designmode";

export interface Point {
  x: number;
  y: number;
}

/** one mark: a pen stroke, an arrow, a box, or a word or two */
export type Shape =
  | { kind: "pen"; color: string; points: Point[] }
  | { kind: "arrow"; color: string; from: Point; to: Point }
  | { kind: "box"; color: string; from: Point; to: Point }
  | { kind: "text"; color: string; at: Point; text: string };

export type Tool = Shape["kind"];

/** the colours to draw in, the first the default */
export const COLORS: readonly { name: string; hex: string }[] = [
  { name: "red", hex: "#e5484d" },
  { name: "blue", hex: "#3b82f6" },
  { name: "yellow", hex: "#f5b50a" },
  { name: "green", hex: "#30a46c" },
];

/** the palette's word for a colour, else the colour itself */
export const colorName = (hex: string): string => COLORS.find((c) => c.hex === hex)?.name ?? hex;

const round = (n: number): number => Math.round(n);

const span = (a: Point, b: Point): Rect => ({
  x: round(Math.min(a.x, b.x)),
  y: round(Math.min(a.y, b.y)),
  width: round(Math.abs(a.x - b.x)),
  height: round(Math.abs(a.y - b.y)),
});

/** the shape's box, whichever corner it was drawn from, in whole pixels */
export function boxOf(s: Shape): Rect {
  switch (s.kind) {
    case "arrow":
    case "box":
      return span(s.from, s.to);
    case "text":
      return { x: round(s.at.x), y: round(s.at.y), width: 0, height: 0 };
    case "pen": {
      const first = s.points[0];
      if (!first) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = first.x, minY = first.y, maxX = first.x, maxY = first.y;
      for (const p of s.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return span({ x: minX, y: minY }, { x: maxX, y: maxY });
    }
  }
}

/** the least a mark must span to count: a click that never dragged is
 *  dropped rather than drawn */
const LEAST = 3;

/** whether the mark is a click without a drag, an empty text, or a pen
 *  that never moved, so it should be dropped */
export function tooSmall(s: Shape): boolean {
  if (s.kind === "text") return !s.text.trim();
  if (s.kind === "pen") {
    if (s.points.length < 2) return true;
    const b = boxOf(s);
    return Math.max(b.width, b.height) < LEAST;
  }
  const b = boxOf(s);
  return Math.max(b.width, b.height) < LEAST;
}

const px = (n: number): string => String(Math.round(n * 10) / 10);

/** the pen stroke as an SVG path; a lone point still draws a dot */
export function penPath(points: readonly Point[]): string {
  const first = points[0];
  if (!first) return "";
  const rest = points.length > 1 ? points.slice(1) : [first];
  return `M${px(first.x)} ${px(first.y)} ${rest.map((p) => `L${px(p.x)} ${px(p.y)}`).join(" ")}`;
}

/** the arrow's head: the two barbs at `to`, swept back along the line from
 *  `from` at thirty degrees, `size` long */
export function arrowHead(from: Point, to: Point, size = 10): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const barb = (turn: number): Point => ({ x: to.x - size * Math.cos(angle + turn), y: to.y - size * Math.sin(angle + turn) });
  return [barb(Math.PI / 6), barb(-Math.PI / 6)];
}

const at = (p: Point): string => `${round(p.x)},${round(p.y)}`;

function words(s: Shape): string {
  const colour = colorName(s.color);
  switch (s.kind) {
    case "arrow":
      return `a ${colour} arrow from ${at(s.from)} to ${at(s.to)}`;
    case "box": {
      const b = boxOf(s);
      return `a ${colour} box ${b.width}x${b.height} at ${b.x},${b.y}`;
    }
    case "text":
      return `the text ${JSON.stringify(s.text.trim())} in ${colour} at ${at(s.at)}`;
    case "pen": {
      const b = boxOf(s);
      return `a ${colour} pen stroke over ${b.width}x${b.height} at ${b.x},${b.y}`;
    }
  }
}

/** the marks in words, in the order drawn, for an agent without the
 *  picture (a browser that cannot take one) and beside it otherwise */
export const markupWords = (shapes: readonly Shape[]): string => shapes.map(words).join("; ");
