/**
 * A new column's starting width (FR-009). A column has always opened at
 * `COLUMN_WIDTH`, which on an ultrawide leaves most of the window to the
 * cards. From `WIDE_WINDOW` on, a new column starts at what the shared
 * room leaves once the cards keep their width and the open columns keep
 * theirs, each with its seam, between `COLUMN_WIDTH` and `COLUMN_CAP`.
 * The cards keep the width chosen at their seam, or a third of the room
 * while none is. Below `WIDE_WINDOW` nothing changes: a laptop and a
 * desktop start every column at `COLUMN_WIDTH` as before. The width is
 * decided once, as the column opens, and the column keeps it; a column
 * already open is never moved by a new one. Pure; tested in
 * columnwidth.test.ts.
 */

import { CARDS, SEAM, cardsFloor, sharedRoom } from "./cardswidth";
import { COLUMN_WIDTH } from "./grid";

/** the window width a column starts wider from: where the desktop class
 *  ends and the wide screens begin (SCREEN_CLASSES in screens.ts) */
export const WIDE_WINDOW = 3200;
/** the widest a column starts; past it a wider one is a drag at its seam */
export const COLUMN_CAP = 1200;
/** the share of the room the cards keep from a new column while no width
 *  is chosen at their seam */
export const CARDS_SHARE = 1 / 3;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** The room a new column opens into, read as it opens. */
export interface ColumnRoom {
  /** the window's width, CSS px; 0 where there is no window */
  window: number;
  /** what sits left of the cards: the tree and its seam, or 0 */
  before: number;
  /** the width chosen at the cards' seam, null while none is */
  cards: number | null;
  /** the open columns' widths, in order */
  columns: readonly number[];
}

/** What the cards keep from a new column in `room`: the chosen width,
 *  held as the floor is (`cardsFloor`), or a third of the room while none
 *  is chosen, never under `CARDS.min`. */
export function cardsKeep(room: number, chosen: number | null): number {
  return chosen === null ? Math.max(CARDS.min, Math.floor(room * CARDS_SHARE)) : cardsFloor(chosen, room);
}

/** A new column's starting width: `COLUMN_WIDTH` under `WIDE_WINDOW`, as
 *  it always was; from there, what the shared room leaves once the cards
 *  keep theirs and the open columns keep theirs, each column with its
 *  seam, held between `COLUMN_WIDTH` and `COLUMN_CAP`. */
export function newColumnWidth({ window, before, cards, columns }: ColumnRoom): number {
  if (!(window >= WIDE_WINDOW)) return COLUMN_WIDTH;
  const room = sharedRoom(window, before);
  const used = columns.reduce((sum, w) => sum + w + SEAM, 0);
  const spare = room - cardsKeep(room, cards) - used - SEAM;
  return clamp(Math.floor(spare), COLUMN_WIDTH, COLUMN_CAP);
}
