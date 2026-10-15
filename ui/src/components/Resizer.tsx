import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { clamp } from "../util";

interface ResizerProps {
  /** what the handle sizes, for screen readers */
  label: string;
  className?: string;
  /** inline style on the handle: the dock sets its CSS order beside its panel */
  style?: CSSProperties;
  value: number;
  min: number;
  max: number;
  /** width restored on double-click */
  initial: number;
  /** 1 when the pane sits left of the handle, -1 when it sits right of it */
  dir: 1 | -1;
  /** px of width per px of pointer travel: 2 for a centered pane, whose far
   *  edge moves as much as the dragged one (default 1) */
  factor?: number;
  /** custom property the live width is written to */
  cssVar: string;
  /** element that property lives on, resolved from the handle itself */
  target: (handle: HTMLElement) => HTMLElement | null;
  /** the most the pane can take right now, read off the page as a drag starts;
   *  below `max` when the window is what limits it, so the drag never runs
   *  into width nobody can see */
  fit?: (handle: HTMLElement) => number;
  /** Called as a drag starts with a cancel that ends it with no commit and
   *  puts `cssVar` back as it was; returns what lets go of it, which the
   *  drag calls before it commits. The dock's column seams use it to end a
   *  drag whose layout changed under it. */
  hold?: (cancel: () => void) => () => void;
  /** Keep the handle under the pointer by scrolling the `target` element
   *  sideways. The dock's column seams use it: a seam is its column's left
   *  edge, and once the dock is as wide as it may get and scrolls, a width
   *  change moves the column's far edge while the seam stays put. */
  follow?: boolean;
  /** The pane on the handle's far side, a column seam's left neighbour:
   *  with `follow`, a shrink the scroll cannot take back widens it instead
   *  (`lentLeft`), written live to its own `cssVar`. */
  neighbour?: { cssVar: string; value: number };
  /** For a seam with `follow` and no `neighbour`, the pane at the far end
   *  of the row, the dock's last column: a shrink the scroll cannot take
   *  back pulls the hidden overflow in from it (`pulledIn`), written live to
   *  its own `cssVar`. The dragged pane itself when it is the only one. */
  trailing?: { cssVar: string; value: number };
  /** `left` is the neighbour's new width, only when the drag lent it any;
   *  `trail` is the trailing pane's, only when the drag pulled from it */
  onCommit: (px: number, left?: number, trail?: number) => void;
}

const SIZE_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** The width a key sizes a pane to: the arrows step it the way the handle
 *  faces, Home and End go to `min` and to `top` (the most that fits now),
 *  as `aria-valuemin` and `aria-valuemax` say. Null for any other key and
 *  for a press that changes nothing, so a key at a limit saves nothing. */
export function keyedWidth(
  e: { key: string; shiftKey: boolean },
  { value, min, top, dir }: { value: number; min: number; top: number; dir: 1 | -1 },
): number | null {
  const from = Math.min(value, top);
  const step = (e.shiftKey ? 48 : 12) * (e.key === "ArrowRight" ? 1 : -1);
  const next =
    e.key === "Home" ? min : e.key === "End" ? top : e.key === "ArrowLeft" || e.key === "ArrowRight" ? clamp(from + step * dir, min, top) : null;
  return next === null || next === value ? null : next;
}

/** How far to scroll so a dragged handle stays under the pointer: the
 *  handle's place now less where the width change would have put it, from
 *  the clamped width so a drag past a limit leaves the handle at the limit.
 *  Added to the scroller's `scrollLeft`, which the browser clamps in turn. */
export function followBy(
  now: number,
  { startLeft, startValue, next, dir, factor }: { startLeft: number; startValue: number; next: number; dir: 1 | -1; factor: number },
): number {
  return now - (startLeft + ((next - startValue) * dir) / factor);
}

/** How much wider a column seam's left neighbour gets for a shrink, so the
 *  seam stays under the pointer. Only at the dock's widest with overflow
 *  hidden on the right: there the dock's left edge is fixed, and once the
 *  scroll off the left (`scrolled`, at the drag's start) is given back,
 *  nothing else can move the seam rightwards. The rest of the shrink goes
 *  to the neighbour, up to its `room`, so the tracks' total holds and the
 *  dock stays at its widest. Nothing for a widening, which scrolls. */
export function lentLeft({
  startValue,
  next,
  scrolled,
  hidden,
  room,
}: { startValue: number; next: number; scrolled: number; hidden: number; room: number }): number {
  if (hidden < 1) return 0;
  return clamp(startValue - next - scrolled, 0, Math.max(0, room));
}

/** What a seam with no neighbour (the first column's, the dock's own left
 *  edge) pulls in from the overflow hidden on the right, so the seam stays
 *  under the pointer. The dock narrows, moving that edge, only once its
 *  tracks fit it, so the moment a shrink outruns the scroll it can give
 *  back, the whole `hidden` part comes off at once: from the last column
 *  first, which is the part nobody sees, up to its `trailRoom`, then off the
 *  dragged column, down to `min`. Nothing for a widening, which scrolls. */
export function pulledIn({
  startValue,
  next,
  scrolled,
  hidden,
  trailRoom,
  min,
}: { startValue: number; next: number; scrolled: number; hidden: number; trailRoom: number; min: number }): { trail: number; self: number } {
  if (hidden < 1 || startValue - next <= scrolled) return { trail: 0, self: 0 };
  const trail = clamp(hidden, 0, Math.max(0, trailRoom));
  return { trail, self: clamp(hidden - trail, 0, Math.max(0, next - min)) };
}

/**
 * A drag strip between two panes. The drag writes `cssVar` straight to the DOM
 * and only calls `onCommit` on release — routing every pointermove through the
 * store would re-render every open dock panel on each frame.
 */
export function Resizer({
  label,
  className,
  style,
  value,
  min,
  max,
  initial,
  dir,
  factor = 1,
  cssVar,
  target,
  fit,
  hold,
  follow = false,
  neighbour,
  trailing,
  onCommit,
}: ResizerProps) {
  const [dragging, setDragging] = useState(false);
  const live = useRef(value);

  // If the handle unmounts mid-drag (a scan can prune the repo out from under
  // an open panel, or the window narrows past where the dock has seams),
  // pointerup never fires and the whole app is left unselectable with a
  // col-resize cursor until reload. Ending the drag here also lets go of
  // its `hold`, so a later layout change does not put back a stale width.
  const ending = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      ending.current?.();
      document.body.classList.remove("resizing");
    },
    [],
  );

  const ceiling = (handle: HTMLElement) => {
    const room = fit?.(handle);
    return room !== undefined && Number.isFinite(room) ? clamp(room, min, max) : max;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const top = ceiling(handle);
    const startValue = Math.min(value, top);
    live.current = startValue;
    const { pointerId } = e;
    const owner = target(handle);
    const before = owner?.style.getPropertyValue(cssVar) ?? "";
    const scrolled = owner?.scrollLeft ?? 0;
    const startLeft = handle.getBoundingClientRect().left;
    // only a seam that follows lends its neighbour width; it grows no wider
    // than a pane may, and its own width goes back on a cancel
    const lender = follow && owner && neighbour ? neighbour : undefined;
    const hidden = owner ? owner.scrollWidth - owner.clientWidth - scrolled : 0;
    const room = lender ? top - lender.value : 0;
    const lenderBefore = lender ? owner?.style.getPropertyValue(lender.cssVar) ?? "" : "";
    let lent = 0;
    // a seam with no neighbour pulls the hidden overflow in instead, from
    // the trailing pane unless that is the dragged one itself
    const puller = follow && owner && !neighbour ? trailing : undefined;
    const trail = puller && puller.cssVar !== cssVar ? puller : undefined;
    const trailBefore = trail ? owner?.style.getPropertyValue(trail.cssVar) ?? "" : "";
    let pulled = 0;
    // Capture keeps the moves coming once the cursor outruns a 6px strip.
    handle.setPointerCapture(pointerId);
    setDragging(true);
    document.body.classList.add("resizing");

    const move = (ev: globalThis.PointerEvent) => {
      const next = clamp(
        startValue + (ev.clientX - startX) * dir * factor,
        min,
        top,
      );
      // every move, a pull of 0 too, so a drag back within the scroll puts
      // the trailing pane back
      const pull = puller ? pulledIn({ startValue, next, scrolled, hidden, trailRoom: trail ? trail.value - min : 0, min }) : { trail: 0, self: 0 };
      pulled = pull.trail;
      live.current = next - pull.self;
      const el = target(handle);
      el?.style.setProperty(cssVar, `${live.current}px`);
      if (trail) el?.style.setProperty(trail.cssVar, `${trail.value - pulled}px`);
      // every move, a lent 0 too, so a drag back from lending puts it back,
      // and before the follow reads where the handle has got to
      if (lender) {
        lent = lentLeft({ startValue, next, scrolled, hidden, room });
        el?.style.setProperty(lender.cssVar, `${lender.value + lent}px`);
      }
      if (follow && el) el.scrollLeft += followBy(handle.getBoundingClientRect().left, { startLeft, startValue, next, dir, factor });
    };
    let release = () => {};
    const end = () => {
      ending.current = null;
      release();
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setDragging(false);
      document.body.classList.remove("resizing");
    };
    const up = () => {
      end();
      onCommit(live.current, lender && lent > 0 ? lender.value + lent : undefined, trail && pulled > 0 ? trail.value - pulled : undefined);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    if (hold) {
      release = hold(() => {
        end();
        if (handle.isConnected && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        if (before) owner?.style.setProperty(cssVar, before);
        else owner?.style.removeProperty(cssVar);
        if (lender && lenderBefore) owner?.style.setProperty(lender.cssVar, lenderBefore);
        else if (lender) owner?.style.removeProperty(lender.cssVar);
        if (trail && trailBefore) owner?.style.setProperty(trail.cssVar, trailBefore);
        else if (trail) owner?.style.removeProperty(trail.cssVar);
        if (follow && owner) owner.scrollLeft = scrolled;
      });
    }
    ending.current = end;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!SIZE_KEYS.has(e.key)) return;
    e.preventDefault();
    const next = keyedWidth(e, { value, min, top: ceiling(e.currentTarget), dir });
    if (next !== null) onCommit(next);
  };

  return (
    <div
      className={`resizer${className ? ` ${className}` : ""}${dragging ? " dragging" : ""}`}
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(initial)}
    />
  );
}
