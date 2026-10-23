import { type RefObject, useLayoutEffect } from "react";
import { ZOOM_MAX, ZOOM_MIN } from "./surface";
import { clamp } from "./util";

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

/** How a popup sits, axis by axis: on `start` its left or top edge holds
 *  and it grows right or down, on `end` its right edge holds and it grows
 *  left, and on `center` it grows both ways at once. */
export interface PopAnchor {
  x: "start" | "end" | "center";
  y: "start" | "center";
}

/** the sheets: centered both ways in their veil */
export const CENTERED: PopAnchor = { x: "center", y: "center" };
/** a popover hanging off its chip's right edge, most of them */
export const HANGS_RIGHT: PopAnchor = { x: "end", y: "start" };
/** a popover hanging off its chip's left edge (the pick menus, the folders) */
export const HANGS_LEFT: PopAnchor = { x: "start", y: "start" };

/** the smallest a popup can be sized to, px */
export const POP_MIN = { w: 240, h: 120 } as const;
/** the largest a saved size is kept at, past any screen's room */
const POP_MAX = 8000;

export interface PopSize {
  w: number;
  h: number;
}

/** each popup's size, by name; a popup with none keeps its own */
export type PopSizes = Record<string, PopSize>;

const sizeOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(clamp(v, 0, POP_MAX)) : null;

/** Saved sizes held to whole px in range; anything else is dropped, so a
 *  hand-edited entry never sizes a popup to nothing. */
export function popSizesOf(v: unknown): PopSizes {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: PopSizes = {};
  for (const [name, raw] of Object.entries(v)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const w = sizeOf(r["w"]);
    const h = sizeOf(r["h"]);
    if (w !== null && h !== null) out[name] = { w: Math.max(w, POP_MIN.w), h: Math.max(h, POP_MIN.h) };
  }
  return out;
}

/** The most a popup can take on each axis, `gap` clear of the window's
 *  edges: from its held edge to the far one, or for a centered axis twice
 *  the nearer edge's distance from its middle. Never below the minimum. */
export function popRoom(
  r: { left: number; right: number; top: number; bottom: number },
  view: { w: number; h: number },
  anchor: PopAnchor,
  gap: number,
): PopSize {
  const mid = (a: number, b: number, size: number) => 2 * Math.min((a + b) / 2 - gap, size - gap - (a + b) / 2);
  const w = anchor.x === "start" ? view.w - gap - r.left : anchor.x === "end" ? r.right - gap : mid(r.left, r.right, view.w);
  const h = anchor.y === "start" ? view.h - gap - r.top : mid(r.top, r.bottom, view.h);
  return { w: Math.floor(Math.max(w, POP_MIN.w)), h: Math.floor(Math.max(h, POP_MIN.h)) };
}

/** The size a grip drag of (`dx`, `dy`) px makes: the grip sits on the
 *  corner that moves, so it follows the pointer, at twice the travel on a
 *  centered axis (its far edge moves as much) and reversed for a popup
 *  that grows left. Held to the minimum and to `room`. */
export function gripSize(start: PopSize, dx: number, dy: number, anchor: PopAnchor, room: PopSize): PopSize {
  const sx = anchor.x === "center" ? 2 : anchor.x === "end" ? -1 : 1;
  const sy = anchor.y === "center" ? 2 : 1;
  return {
    w: Math.round(clamp(start.w + dx * sx, POP_MIN.w, room.w)),
    h: Math.round(clamp(start.h + dy * sy, POP_MIN.h, room.h)),
  };
}

/** each popup's zoom off its gear, by name; one with none is at 1 */
export type PopZooms = Record<string, number>;

/** Saved zooms held to the zoom's range, with a zoom of 1 left out, since
 *  that is what no entry means. */
export function popZoomsOf(v: unknown): PopZooms {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: PopZooms = {};
  for (const [name, z] of Object.entries(v)) {
    if (typeof z !== "number" || !Number.isFinite(z)) continue;
    const held = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(held - 1) > 0.001) out[name] = held;
  }
  return out;
}

/** Whether a pointerdown at `t` leaves the popover under `ref`, which
 *  closes it: outside it, and outside a gear's menu, which sits in a
 *  portal of its own. */
export function leavesPop(t: EventTarget | null, ref: RefObject<HTMLElement | null>): boolean {
  if (!(t instanceof Node)) return true;
  if (t instanceof Element && t.closest(".gear-pop")) return false;
  return !ref.current?.contains(t);
}

