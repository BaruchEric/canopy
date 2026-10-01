import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { clamp } from "../util";

interface ResizerProps {
  /** what the handle sizes, for screen readers */
  label: string;
  className?: string;
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
  onCommit: (px: number) => void;
}

/**
 * A drag strip between two panes. The drag writes `cssVar` straight to the DOM
 * and only calls `onCommit` on release — routing every pointermove through the
 * store would re-render every open dock panel on each frame.
 */
export function Resizer({
  label,
  className,
  value,
  min,
  max,
  initial,
  dir,
  factor = 1,
  cssVar,
  target,
  fit,
  onCommit,
}: ResizerProps) {
  const [dragging, setDragging] = useState(false);
  const live = useRef(value);

  // If the handle unmounts mid-drag — a scan can prune the repo out from under
  // an open panel — pointerup never fires and the whole app is left
  // unselectable with a col-resize cursor until reload.
  useEffect(() => () => document.body.classList.remove("resizing"), []);

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
    // Capture keeps the moves coming once the cursor outruns a 6px strip.
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.classList.add("resizing");

    const move = (ev: globalThis.PointerEvent) => {
      const next = clamp(
        startValue + (ev.clientX - startX) * dir * factor,
        min,
        top,
      );
      live.current = next;
      target(handle)?.style.setProperty(cssVar, `${next}px`);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setDragging(false);
      document.body.classList.remove("resizing");
      onCommit(live.current);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 48 : 12) * (e.key === "ArrowRight" ? 1 : -1);
    const top = ceiling(e.currentTarget);
    onCommit(clamp(Math.min(value, top) + step * dir, min, top));
  };

  return (
    <div
      className={`resizer${className ? ` ${className}` : ""}${dragging ? " dragging" : ""}`}
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
