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
  onCommit: (px: number) => void;
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
      live.current = next;
      const el = target(handle);
      el?.style.setProperty(cssVar, `${next}px`);
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
      onCommit(live.current);
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
