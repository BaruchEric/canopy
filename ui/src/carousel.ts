/** The carousel's pointer arithmetic: when a wheel pans the row, and where
 *  a keyboard jump lands. Pure, so the rules that keep a terminal's or a
 *  diff's own scrolling theirs are tested. */

/** a press that moves less than this is a click, not a pan */
export const PAN_SLOP = 6;

/** px to pan the row by for a wheel event, or 0 to leave it alone. A
 *  sideways swipe is the browser's already; over a head a vertical wheel
 *  pans; over content only shift+wheel does, and not where the content
 *  itself scrolls sideways (a wide diff). macOS hands a mouse's shift+wheel
 *  over as a sideways one, which is read as the vertical one it was. A ctrl
 *  or cmd wheel, which is also how a trackpad pinch arrives, is the page's
 *  zoom wherever it lands. */
export function wheelPan(
  e: { deltaX: number; deltaY: number; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean },
  over: "head" | "content",
  contentScrollsX: boolean,
): number {
  if (e.ctrlKey || e.metaKey) return 0;
  const dy = e.shiftKey && e.deltaY === 0 ? e.deltaX : e.deltaY;
  const dx = e.shiftKey && e.deltaY === 0 ? 0 : e.deltaX;
  if (Math.abs(dx) > Math.abs(dy)) return 0;
  if (over === "head") return dy;
  if (e.shiftKey && !contentScrollsX) return dy;
  return 0;
}

/** A wheel event as the row reads it: its deltas, the unit they came in
 *  (0 px, 1 lines, 2 pages, as `WheelEvent.deltaMode`) and its keys. */
export interface WheelIn {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** a wheel's delta in px, whatever unit the browser counted it in; a page
 *  is the row's width. The ctrl and cmd keys ride along, so `wheelPan`
 *  can leave a zoom alone. */
export function wheelPx(e: WheelIn, pageWidth: number): Parameters<typeof wheelPan>[0] {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageWidth : 1;
  return { deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
}

/** px the row takes from a wheel, or 0 to leave it to what is under it:
 *  `wheelPan`, then only while the row can still move that way
 *  (`canPan`). Whether the content scrolls sideways costs a layout read up
 *  its ancestors, so it is asked only for a shift+wheel over content, the
 *  one case `wheelPan` reads it. */
export function wheelTake(
  e: WheelIn,
  over: "head" | "content",
  contentScrollsX: () => boolean,
  row: { scrollLeft: number; scrollWidth: number; clientWidth: number },
): number {
  const dx = wheelPan(wheelPx(e, row.clientWidth), over, over === "content" && e.shiftKey && contentScrollsX());
  return canPan(row, dx) ? dx : 0;
}

/** whether content scrolls sideways itself: it may (`overflow-x` auto or
 *  scroll) and it overflows by more than the pixel a rounded width leaves */
export function overflowsX(scrollWidth: number, clientWidth: number, overflowX: string): boolean {
  return scrollWidth - clientWidth > 1 && /auto|scroll/.test(overflowX);
}

/** whether the row can still move `dx` px's way; a row resting within a
 *  pixel of an end is at it */
export function canPan(row: { scrollLeft: number; scrollWidth: number; clientWidth: number }, dx: number): boolean {
  if (dx < 0) return row.scrollLeft >= 1;
  if (dx > 0) return row.scrollWidth - row.clientWidth - row.scrollLeft >= 1;
  return false;
}

/** the left edge of the next panel past `scrollLeft` in `dir`, or the
 *  last edge when there is none */
export function snapTo(lefts: readonly number[], scrollLeft: number, dir: 1 | -1): number {
  const edge = 2; // px: a row resting on an edge counts as on it
  if (dir === 1) return lefts.find((l) => l > scrollLeft + edge) ?? lefts.at(-1) ?? 0;
  return [...lefts].reverse().find((l) => l < scrollLeft - edge) ?? lefts[0] ?? 0;
}
