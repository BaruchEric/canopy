/**
 * The phone's top bar folds its tool rows away while the cards scroll down
 * and brings them back on the way up, so a short screen gives the cards the
 * room. These are the sums the bar runs on each scroll of `.main`, and the
 * test that tells the sideways row which of its ends hold more. Pure and
 * tested (topbar.test.ts).
 */

/** how far the cards must move one way before the rows follow */
export const TUCK_SLOP = 10;
/** near the top the rows always show */
export const TUCK_TOP = 24;
/** how long after a fold the scrolls are ignored: the fold moves the cards'
 *  height, and the browser clamps the scroll as it does, which would read as
 *  the reader scrolling back */
export const TUCK_HOLD_MS = 320;

export interface Tuck {
  tucked: boolean;
  /** where the cards were when the rows last moved, or the last scroll seen
   *  in the other direction */
  anchor: number;
  /** no change before this time, in ms */
  hold: number;
}

export const TUCK_START: Tuck = { tucked: false, anchor: 0, hold: 0 };

export interface Scroll {
  /** the cards' scrollTop */
  top: number;
  /** scrollHeight less clientHeight, as it is now */
  range: number;
  /** the height the folded rows take when shown */
  room: number;
  now: number;
}

/**
 * The rows' next state for one scroll. They fold after the cards have moved
 * down `TUCK_SLOP` past the anchor and come back after the same distance up,
 * or near the top. A list with too little to scroll never folds: its range
 * is measured as it would be with the rows shown, and it needs three times
 * their height, so folding cannot leave the cards with nothing to scroll.
 */
export function nextTuck(t: Tuck, s: Scroll): Tuck {
  const top = Math.max(0, Math.min(s.top, s.range));
  if (s.now < t.hold) return { ...t, anchor: top };
  // the range with the rows out: folded, the cards are `room` taller
  const full = t.tucked ? s.range + s.room : s.range;
  if (top <= TUCK_TOP || full < s.room * 3) {
    return t.tucked ? { tucked: false, anchor: top, hold: s.now + TUCK_HOLD_MS } : { ...t, anchor: top };
  }
  const moved = top - t.anchor;
  if (!t.tucked && moved > TUCK_SLOP) return { tucked: true, anchor: top, hold: s.now + TUCK_HOLD_MS };
  if (t.tucked && moved < -TUCK_SLOP) return { tucked: false, anchor: top, hold: s.now + TUCK_HOLD_MS };
  // moving the way the rows already went keeps the anchor at the far end, so
  // a turn is measured from where it began
  if (t.tucked ? top > t.anchor : top < t.anchor) return { ...t, anchor: top };
  return t;
}

/** Whether a sideways row has more past its left and right edges. */
export function scrollEdges(left: number, width: number, client: number): { start: boolean; end: boolean } {
  return { start: left > 1, end: left + client < width - 1 };
}
