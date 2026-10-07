/** The carousel's pointer arithmetic: when a wheel pans the row, and where
 *  a keyboard jump lands. Pure, so the rules that keep a terminal's or a
 *  diff's own scrolling theirs are tested. */

/** a press that moves less than this is a click, not a pan */
export const PAN_SLOP = 6;

/** px to pan the row by for a wheel event, or 0 to leave it alone. A
 *  sideways swipe is the browser's already; over a head a vertical wheel
 *  pans; over content only shift+wheel does, and not where the content
 *  itself scrolls sideways (a wide diff). macOS hands a mouse's shift+wheel
 *  over as a sideways one, which is read as the vertical one it was. */
export function wheelPan(
  e: { deltaX: number; deltaY: number; shiftKey: boolean },
  over: "head" | "content",
  contentScrollsX: boolean,
): number {
  const dy = e.shiftKey && e.deltaY === 0 ? e.deltaX : e.deltaY;
  const dx = e.shiftKey && e.deltaY === 0 ? 0 : e.deltaX;
  if (Math.abs(dx) > Math.abs(dy)) return 0;
  if (over === "head") return dy;
  if (e.shiftKey && !contentScrollsX) return dy;
  return 0;
}

/** the left edge of the next panel past `scrollLeft` in `dir`, or the
 *  last edge when there is none */
export function snapTo(lefts: readonly number[], scrollLeft: number, dir: 1 | -1): number {
  const edge = 2; // px: a row resting on an edge counts as on it
  if (dir === 1) return lefts.find((l) => l > scrollLeft + edge) ?? lefts.at(-1) ?? 0;
  return [...lefts].reverse().find((l) => l < scrollLeft - edge) ?? lefts[0] ?? 0;
}
