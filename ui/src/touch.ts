/**
 * A finger on a shell: xterm 6 carries VS Code's gesture code but wires it
 * to nothing, so a phone cannot scroll a terminal or size its text. These
 * are the sums TermView's touch handlers run on: a drag turned into whole
 * lines, the glide after a flick, and a pinch turned into a font size.
 * Pure and tested (touch.test.ts).
 */

/** how far a finger may wander and still be a tap, which xterm gets as a click */
export const TAP_SLOP = 8;

/** the font sizes a pinch can reach */
export const TERM_FONT_MIN = 8;
export const TERM_FONT_MAX = 24;

/** A size from anywhere (a pinch, a saved setting) as one a terminal can use:
 *  a half pixel step between the bounds, or `fallback` for junk. */
export function termFontSize(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(v * 2) / 2));
}

/** The font size a pinch has reached: the size it started at, scaled by how
 *  far the fingers have spread since. */
export function pinchFont(start: number, startGap: number, gap: number): number {
  if (startGap <= 0) return termFontSize(start, start);
  return termFontSize((start * gap) / startGap, start);
}

/** the distance between two touches */
export const gapOf = (a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number =>
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/**
 * A drag of `dy` pixels (down is positive) as whole lines to scroll, plus
 * what is left over for the next move. The page follows the finger, so a
 * finger moving up brings later lines into view: positive lines.
 */
export function dragLines(carry: number, dy: number, rowPx: number): { lines: number; carry: number } {
  if (rowPx <= 0) return { lines: 0, carry: 0 };
  const total = carry - dy;
  const lines = Math.trunc(total / rowPx);
  return { lines, carry: total - lines * rowPx };
}

/** below this speed, in px/ms, a released finger just stops */
export const GLIDE_MIN = 0.05;

/** A flick's speed `dt` ms later, slowing the way a native list does. */
export function glide(v: number, dt: number): number {
  const next = v * 0.95 ** (dt / 16);
  return Math.abs(next) < GLIDE_MIN ? 0 : next;
}

/** A finger's speed off its last few samples, px/ms, newest last. Samples
 *  older than `window` ms before the newest are left out, so a finger that
 *  paused before lifting does not glide. */
export function speedOf(samples: readonly { y: number; t: number }[], window = 100): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const recent = samples.filter((s) => last.t - s.t <= window);
  const first = recent[0];
  if (!first || last.t === first.t) return 0;
  return (last.y - first.y) / (last.t - first.t);
}
