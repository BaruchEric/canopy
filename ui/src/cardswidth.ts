/**
 * The cards' width beside the dock (FR-015). Left alone, the cards take what
 * the dock leaves them, down to `CARDS.min` (`--cards-min` in styles.css).
 * A width chosen at the seam between the two is the cards' floor instead:
 * widening a column takes room from the cards only down to it, and past it
 * the dock scrolls; when the columns leave more, the cards take it, as they
 * always did. A narrow window lowers the floor, never under `CARDS.min`, so
 * the dock keeps `DOCK_KEEP`; the choice itself is kept and holds again
 * once the window is wide enough. Pure; tested in cardswidth.test.ts.
 */

/** the bounds of a chosen width, CSS px; `min` is the stylesheet's `--cards-min` */
export const CARDS = { min: 320, max: 4800 };
/** a seam's width, the cards' own and a dock column's */
export const SEAM = 6;
/** what the dock keeps however wide the cards are set: its narrowest
 *  column (PANEL.min in store.ts) and that column's seam */
export const DOCK_KEEP = 240 + SEAM;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** The room the cards and the dock share: the body's width less what sits
 *  left of the cards (the tree and its seam, `before`) and the cards' seam. */
export function sharedRoom(body: number, before: number): number {
  return Math.max(0, body - before - SEAM);
}

/** The most the cards may take in `room`: all of it but `DOCK_KEEP`, and
 *  never less than `CARDS.min`, which a window too narrow for both keeps. */
export function cardsTop(room: number): number {
  return Math.max(CARDS.min, Math.floor(room - DOCK_KEEP));
}

/** The cards' floor now: `CARDS.min` while nothing is chosen, else the
 *  choice held between `CARDS.min` and `cardsTop`. */
export function cardsFloor(chosen: number | null, room: number): number {
  return chosen === null ? CARDS.min : clamp(Math.round(chosen), CARDS.min, cardsTop(room));
}

/** What a drag or a key at the seam leaves chosen: `px` rounded and held
 *  between `CARDS.min` and what fits now. A drag let go where it started
 *  (`start`, the cards' width as it began; null for a key) changes nothing,
 *  so a click on the seam never turns a width on. */
export function chosenWidth(px: number, { start, room, chosen }: { start: number | null; room: number; chosen: number | null }): number | null {
  if (start !== null && Math.round(px) === Math.round(start)) return chosen;
  return clamp(Math.round(px), CARDS.min, Math.min(CARDS.max, cardsTop(room)));
}
