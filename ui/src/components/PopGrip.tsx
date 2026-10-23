import { useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useStore } from "../store";
import { type PopAnchor, type PopSize, gripSize, popRoom } from "../pop";

/** the width below which popups are sheets off the bottom edge, unsized */
const PHONE = "(max-width: 760px)";

const KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** what a popup can take right now, off where it sits */
const roomOf = (pop: HTMLElement, anchor: PopAnchor, gap: number): PopSize =>
  popRoom(pop.getBoundingClientRect(), { w: document.documentElement.clientWidth, h: window.innerHeight }, anchor, gap);

/** Sizes the popup through the custom properties its `[data-sized]` rule
 *  reads, or hands it back to the stylesheet. */
function paint(pop: HTMLElement, size: PopSize | null): void {
  if (!size) {
    pop.removeAttribute("data-sized");
    pop.style.removeProperty("--pop-w");
    pop.style.removeProperty("--pop-h");
    return;
  }
  pop.setAttribute("data-sized", "");
  pop.style.setProperty("--pop-w", `${size.w}px`);
  pop.style.setProperty("--pop-h", `${size.h}px`);
}

interface PopGripProps {
  /** the key its size is saved under, one per kind of popup */
  name: string;
  /** which edges hold as it grows; the grip sits on the corner that moves */
  anchor: PopAnchor;
  /** the gap it keeps from the window's edges, px */
  gap?: number;
}

/**
 * A corner grip that sizes the popup it sits in, the last child of the
 * popup's own element. A drag takes it as far as the window has room for,
 * and the size is saved per popup and per kind of screen; a double-click
 * hands the popup back to the stylesheet. Like the Resizer, a drag writes to
 * the DOM and only saves on release.
 */
export function PopGrip({ name, anchor, gap = 8 }: PopGripProps) {
  const saved = useStore((s) => s.settings.popSizes[name]);
  const setSetting = useStore((s) => s.setSetting);
  const ref = useRef<HTMLDivElement>(null);
  const ending = useRef<(() => void) | null>(null);

  // the saved size, held to the room there is now and again on every resize
  useLayoutEffect(() => {
    const pop = ref.current?.parentElement;
    if (!pop) return;
    const fit = () => {
      if (!saved || window.matchMedia(PHONE).matches) return paint(pop, null);
      const room = roomOf(pop, anchor, gap);
      paint(pop, { w: Math.min(saved.w, room.w), h: Math.min(saved.h, room.h) });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [saved, anchor, gap]);

  // In a popup that scrolls, an absolute box rides along with the content,
  // so the grip is moved back down by however far it has scrolled.
  useEffect(() => {
    const grip = ref.current;
    const pop = grip?.parentElement;
    if (!grip || !pop) return;
    const pin = () => {
      grip.style.translate = pop.scrollTop ? `0 ${pop.scrollTop}px` : "";
    };
    pin();
    pop.addEventListener("scroll", pin, { passive: true });
    return () => pop.removeEventListener("scroll", pin);
  }, []);

  // a grip unmounted mid-drag never sees pointerup
  useEffect(
    () => () => {
      ending.current?.();
    },
    [],
  );

  const save = (size: PopSize | null) => {
    const { [name]: _, ...rest } = useStore.getState().settings.popSizes;
    setSetting("popSizes", size ? { ...rest, [name]: size } : rest);
  };

  const cursor = anchor.x === "end" ? "resizing-nesw" : "resizing-nwse";

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // the popup's own handlers (a panel's drag, a veil's close) stay out of it
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    const pop = grip.parentElement;
    if (!pop) return;
    const r = pop.getBoundingClientRect();
    const start = { w: r.width, h: r.height };
    const room = roomOf(pop, anchor, gap);
    const { clientX: x0, clientY: y0, pointerId } = e;
    // a click that never moves saves nothing, so the two before a
    // double-click leave the popup as it was
    let live: PopSize | null = null;
    grip.setPointerCapture(pointerId);
    document.body.classList.add(cursor);
    const move = (ev: globalThis.PointerEvent) => {
      live = gripSize(start, ev.clientX - x0, ev.clientY - y0, anchor, room);
      paint(pop, live);
    };
    const end = () => {
      ending.current = null;
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.body.classList.remove(cursor);
    };
    const up = () => {
      end();
      if (live) save(live);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
    ending.current = end;
  };

  // the arrows move the grip the way they point, shift for a bigger step
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const pop = e.currentTarget.parentElement;
    if (!pop) return;
    const step = e.shiftKey ? 48 : 12;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    const r = pop.getBoundingClientRect();
    // a centered axis moves its grip half as far as it grows
    const k = { x: anchor.x === "center" ? 0.5 : 1, y: anchor.y === "center" ? 0.5 : 1 };
    save(gripSize({ w: r.width, h: r.height }, dx * k.x, dy * k.y, anchor, roomOf(pop, anchor, gap)));
  };

  return (
    <div
      ref={ref}
      className={`pop-grip${anchor.x === "end" ? " at-left" : ""}`}
      role="button"
      tabIndex={0}
      aria-label="Resize"
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => save(null)}
    />
  );
}
