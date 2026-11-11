import { useLayoutEffect, useRef, useState } from "react";
import { PANES, paneChosen, paneShown, paneTop, paneVar, type PaneKey } from "../panesizes";
import { useStore } from "../store";
import { Resizer } from "./Resizer";

/** The zoom an element is drawn at, its own and every one over it: a
 *  panel's gear, a section's, a popup's. A size written into it is in its
 *  own px, which the zoom scales on the screen. 1 where the browser does not
 *  say, and the seam then trails the pointer under a zoom, no worse. */
function zoomOf(el: Element): number {
  const z: unknown = Reflect.get(el, "currentCSSZoom");
  return typeof z === "number" && z > 0 ? z : 1;
}

interface PaneSeamProps {
  /** the pane this seam sizes (panesizes.ts) */
  pane: PaneKey;
  /** what the seam sizes, for screen readers */
  label: string;
  className?: string;
  /** "x" sizes the pane's width, "y" its height */
  axis?: "x" | "y";
  /** 1 when the pane sits before the seam (left of it, or over it), -1
   *  when it sits after */
  dir: 1 | -1;
  /** the element whose rules read `--pane-<name>`, resolved from the seam */
  target: (handle: HTMLElement) => HTMLElement | null;
  /** the pane itself, measured for where a drag starts; the seam's sibling
   *  on the pane's side when left out */
  part?: (handle: HTMLElement) => Element | null;
  /** the pane's size now in px on the screen, where no one element is the
   *  pane: the board's rail is a column of tiles */
  size?: (handle: HTMLElement) => number;
  /** the most the pane may take now, in px on the screen: what its
   *  container has, less what the part across the seam keeps */
  room?: (handle: HTMLElement) => number;
}

/**
 * A seam between two parts that sets a pane's size (FR-063). Until it is
 * dragged the pane keeps the stylesheet's size. A drag, or the arrows while
 * it is focused, sets one in px, kept per kind of screen with the rest of
 * the layout; a double-click hands the pane back to the stylesheet.
 *
 * The size is written on the target as `--pane-<name>`, not through React,
 * and again whenever the target or the pane resizes, since a container
 * with less room lowers what shows (`paneShown`). The setting itself is
 * kept and holds again once there is room for it.
 */
export function PaneSeam({ pane, label, className, axis = "x", dir, target, part, size, room }: PaneSeamProps) {
  const chosen = useStore((s) => s.paneSizes[pane] ?? null);
  const setPaneSize = useStore((s) => s.setPaneSize);
  const ref = useRef<HTMLDivElement>(null);
  // the pane's size now, for the drag's start, the keys and screen readers
  const [shown, setShown] = useState<number>(PANES[pane].min);
  // the size the drag in hand began at, so one let go where it started
  // changes nothing (`paneChosen`); null between drags, and so for a key
  const start = useRef<number | null>(null);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  // the readers are new functions on every render; the effect reads the
  // latest through here, and only runs again when the setting changes
  const read = useRef({ target, part, size, room });
  read.current = { target, part, size, room };

  const partOf = (h: HTMLElement) => (read.current.part ? read.current.part(h) : dir === 1 ? h.previousElementSibling : h.nextElementSibling);
  /** the pane's size in its own px, null while it is not laid out */
  const sizeNow = (h: HTMLElement): number | null => {
    if (h.getClientRects().length === 0) return null;
    const z = zoomOf(h);
    if (read.current.size) return read.current.size(h) / z;
    const box = partOf(h)?.getBoundingClientRect();
    return box ? (axis === "y" ? box.height : box.width) / z : null;
  };
  /** the most the pane may take, in its own px */
  const roomNow = (h: HTMLElement): number => {
    const px = read.current.room?.(h);
    return px === undefined || !Number.isFinite(px) ? Infinity : px / zoomOf(h);
  };
  /** Writes what shows for `px` on the target; nothing set, and the
   *  stylesheet's size stands. A seam that is not laid out (a tab behind
   *  another, the other of two layouts) has no room to read, so the
   *  setting goes on as it is. */
  const hold = (h: HTMLElement, px: number | null) => {
    const el = read.current.target(h);
    if (!el) return;
    if (px === null) el.style.removeProperty(paneVar(pane));
    else el.style.setProperty(paneVar(pane), `${h.getClientRects().length === 0 ? px : paneShown(pane, px, roomNow(h))}px`);
  };

  useLayoutEffect(() => {
    const h = ref.current;
    if (!h) return;
    const el = read.current.target(h);
    const box = read.current.size ? null : partOf(h);
    const settle = () => {
      // a drag writes the size itself as it goes, and resizes the pane
      // doing it: putting the kept size back here would undo every move
      if (start.current === null) hold(h, chosen);
      const px = sizeNow(h);
      if (px !== null && px > 0) setShown(Math.round(px));
    };
    // where the Resizer starts its drag from: the size showing, or the most
    // that fits now where that is less
    const down = (e: PointerEvent) => {
      if (e.button === 0) start.current = Math.min(shownNow.current, paneTop(pane, roomNow(h)));
    };
    settle();
    const seen = new ResizeObserver(settle);
    if (el) seen.observe(el);
    if (box) seen.observe(box);
    h.addEventListener("pointerdown", down);
    return () => {
      seen.disconnect();
      h.removeEventListener("pointerdown", down);
      el?.style.removeProperty(paneVar(pane));
    };
    // the readers come through `read`, and `hold`, `sizeNow` and `partOf` only read it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, chosen, axis, dir]);

  const commit = (px: number | null) => {
    const h = ref.current;
    const next = px === null ? null : paneChosen(pane, px, { start: start.current, room: h ? roomNow(h) : Infinity, chosen: useStore.getState().paneSizes[pane] ?? null });
    start.current = null;
    setPaneSize(pane, next);
    // a drag wrote its own value live; put back what shows for the size
    // kept, since an unchanged size re-renders nothing
    if (h) hold(h, next);
  };

  return (
    <Resizer
      ref={ref}
      className={`pane-seam${className ? ` ${className}` : ""}`}
      label={label}
      axis={axis}
      value={shown}
      min={PANES[pane].min}
      max={PANES[pane].max}
      initial={PANES[pane].min}
      onReset={() => commit(null)}
      dir={dir}
      factor={(h) => 1 / zoomOf(h)}
      cssVar={paneVar(pane)}
      target={target}
      fit={(h) => paneTop(pane, roomNow(h))}
      onCommit={(px) => commit(px)}
    />
  );
}
