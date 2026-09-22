/** The terminal's type, and the height a shell needs to show a number of
 *  lines of it. Both the xterm in TermDock.tsx and the store's default
 *  shell height read from here, so they agree on what a row is. */

export const TERM_FONT = {
  family: '"Berkeley Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  size: 12.5,
  lineHeight: 1.2,
};

/** the lines a panel shell opens at */
export const PANEL_TERM_ROWS = 5;

/** the `.term-view` box's vertical padding (styles.css), plus slack so the
 *  fit addon's floor never rounds the last row away */
const TERM_PAD = 10 + 3;

/** what a row measures when nothing here can measure the font */
const FALLBACK_CELL = 18;

let cell: number | null = null;

/** One row's height in css px, worked out the way xterm 6 does: the font's
 *  ascent plus descent off a canvas, to device px, times the line height,
 *  floored, back to css px. Measured once; the font never changes. */
export function cellHeight(): number {
  if (cell !== null) return cell;
  cell = FALLBACK_CELL;
  try {
    const ctx = new OffscreenCanvas(100, 100).getContext("2d");
    if (ctx) {
      ctx.font = `${TERM_FONT.size}px ${TERM_FONT.family}`;
      const m = ctx.measureText("W");
      const glyph = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
      const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
      const device = Math.floor(Math.ceil(glyph * dpr) * TERM_FONT.lineHeight);
      if (Number.isFinite(device) && device > 0) cell = device / dpr;
    }
  } catch {
    // no canvas here (tests, an old browser): the fallback stands
  }
  return cell;
}

/** the px a shell's body takes to show `rows` lines */
export function rowsPx(rows: number, cellPx = cellHeight()): number {
  return Math.ceil(rows * cellPx + TERM_PAD);
}
