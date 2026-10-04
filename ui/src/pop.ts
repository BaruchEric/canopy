import { type RefObject, useLayoutEffect } from "react";

/** the gap a popover keeps from either edge of the window */
const EDGE = 8;

/**
 * How far to move a box sideways so it sits inside [EDGE, width - EDGE]:
 * right edge first, then the left, so a box wider than the window keeps its
 * left edge in view.
 */
export function fitShift(left: number, right: number, width: number): number {
  let dx = 0;
  if (right > width - EDGE) dx = width - EDGE - right;
  if (left + dx < EDGE) dx = EDGE - left;
  return dx;
}

/**
 * Keeps the `.settings-pop` under `ref` inside the window while it is open.
 * The popovers hang off their chip's right edge, and when the top bar wraps
 * a chip can land at the left of the window with its popover off-screen.
 * The shift goes on `translate`, not `transform`, which the settle
 * animation owns. `size` is whatever else changes its width (the inbox's
 * zoom), so it fits again when that moves.
 */
export function useFitPop(ref: RefObject<HTMLElement | null>, open: boolean, size?: number): void {
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const pop = ref.current?.querySelector<HTMLElement>(".settings-pop");
      if (!pop) return;
      pop.style.translate = "";
      const r = pop.getBoundingClientRect();
      const dx = fitShift(r.left, r.right, document.documentElement.clientWidth);
      if (dx !== 0) pop.style.translate = `${Math.round(dx)}px 0`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref, open, size]);
}
