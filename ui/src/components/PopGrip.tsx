import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { PHONE, useMedia } from "../media";
import { useStore } from "../store";
import { type PopAnchor, type PopSize, gripSize, popRoom } from "../pop";
import { ZOOM_MAX, ZOOM_MIN, zoomStep, zoomWord } from "../surface";
import { Gear, type GearEntry } from "./Gear";
import type { TabRef } from "../sectiontabs";
import type { Arrangement } from "../grid";
import { openView } from "../clirun";

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

/** Saves a popup's size, or drops it so the stylesheet's applies. */
function saveSize(name: string, size: PopSize | null): void {
  const { settings, setSetting } = useStore.getState();
  const { [name]: _, ...rest } = settings.popSizes;
  setSetting("popSizes", size ? { ...rest, [name]: size } : rest);
}

/** Saves a popup's zoom; back at 1 the entry goes. */
function saveZoom(name: string, z: number): void {
  const { settings, setSetting } = useStore.getState();
  const { [name]: _, ...rest } = settings.popZooms;
  setSetting("popZooms", Math.abs(z - 1) < 0.001 ? rest : { ...rest, [name]: z });
}

/** A popup: the key its size and zoom are saved under, one per kind of
 *  popup, which edges hold as it grows, and the gap it keeps from the
 *  window's edges in px. */
export interface PopSpec {
  name: string;
  anchor: PopAnchor;
  gap?: number;
  /** what the popup is as a tab in a shell window (FR-030), when it can be one */
  tab?: TabRef;
}

/** Every popup and sheet closes on Escape, so one sent after a popup turns
 *  into a tab closes it, whichever kind it is. */
const closePopup = () => requestAnimationFrame(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

/** The gear lines that move a popup, a sheet or a dock panel into a tab
 *  in a shell window: the strip's, and a run's card's shells too. `from`
 *  says what it leaves, and `after` runs once it has moved. */
export function tabEntries(tab: TabRef, from = "the popup", after?: () => void): GearEntry[] {
  const to = (place: "strip" | "panel") => () => {
    useStore.getState().tabItem(place, tab);
    after?.();
  };
  return [
    { type: "item", label: "a tab in the shells strip", title: `Out of ${from} into a tab in the strip and the sessions view`, run: to("strip") },
    ...(tab.repoId
      ? [{ type: "item" as const, label: "a tab in its card's shells", title: `Out of ${from} into a tab beside the card's shells`, run: to("panel") }]
      : []),
  ];
}

/** The gear lines that move a popup or a sheet into the dock (FR-047): a
 *  card of its own beside the rest, or a tab of the cell that is showing.
 *  The dock is on the git view, so the page goes there. */
function dockEntries(tab: TabRef, after: () => void): GearEntry[] {
  const to = (into: Arrangement) => () => {
    useStore.getState().dockItem(tab, into);
    openView("git");
    after();
  };
  return [
    { type: "item", label: "a card in the dock", title: "Out of the popup into a panel of its own in the dock, side by side with the rest", run: to("columns") },
    { type: "item", label: "a tab in the dock", title: "Out of the popup into a tab of the dock's showing cell", run: to("tabs") },
  ];
}

/** The popup a sheet's parts sit in, for the gear in its head. */
export const PopHere = createContext<PopSpec | null>(null);

/**
 * A corner grip that sizes the popup it sits in, the last child of the
 * popup's own element. A drag takes it as far as the window has room for,
 * and the size is saved per popup and per kind of screen; a double-click
 * hands the popup back to the stylesheet. Like the Resizer, a drag writes to
 * the DOM and only saves on release. It also paints the popup's zoom, and
 * with `gear` puts the popup's gear in its top corner, for a popover with
 * no head to hold one.
 */
export function PopGrip({ name, anchor, gap = 8, gear = false, tab }: PopSpec & { gear?: boolean }) {
  const saved = useStore((s) => s.settings.popSizes[name]);
  const zoom = useStore((s) => s.settings.popZooms[name] ?? 1);
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

  // the zoom goes on everything in the popup but its head and its controls,
  // so the gear stays under the pointer as it steps
  useLayoutEffect(() => {
    const pop = ref.current?.parentElement;
    if (!pop) return;
    if (zoom === 1) {
      pop.removeAttribute("data-zoomed");
      pop.style.removeProperty("--pop-zoom");
    } else {
      pop.setAttribute("data-zoomed", "");
      pop.style.setProperty("--pop-zoom", String(zoom));
    }
  }, [zoom]);

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

  const save = (size: PopSize | null) => saveSize(name, size);

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
    <>
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
      {gear && <PopGear spec={{ name, anchor, gap, ...(tab ? { tab } : {}) }} corner />}
    </>
  );
}

/**
 * The lines a popup's gear holds for the popup itself: its zoom, unless it
 * keeps one of its own (the inbox), and its size, the window's whole room
 * or its own. `pop` finds the popup's element when a line runs.
 */
export function usePopEntries({ name, anchor, gap = 8, tab }: PopSpec, pop: () => HTMLElement | null, zoomed = true): GearEntry[] {
  const sized = useStore((s) => s.settings.popSizes[name] !== undefined);
  const zoom = useStore((s) => s.settings.popZooms[name] ?? 1);
  const phone = useMedia(PHONE);
  const off = phone ? "A phone's popups take its width" : undefined;
  const size: GearEntry[] = [
    {
      type: "item",
      label: "fill the window",
      title: "As big as the window has room for",
      ...(off ? { off } : {}),
      run: () => {
        const el = pop();
        if (el) saveSize(name, roomOf(el, anchor, gap));
      },
    },
    {
      type: "item",
      label: "its own size",
      title: "The size it opens at, before any drag",
      ...(off || !sized ? { off: off ?? "It is at its own size" } : {}),
      run: () => saveSize(name, null),
    },
    ...(tab ? [...dockEntries(tab, closePopup), ...tabEntries(tab, "the popup", closePopup)] : []),
  ];
  if (!zoomed) return size;
  return [
    {
      type: "zoom",
      label: "zoom",
      value: zoomWord(zoom),
      less: zoom > ZOOM_MIN ? () => saveZoom(name, zoomStep(zoom, -1)) : null,
      more: zoom < ZOOM_MAX ? () => saveZoom(name, zoomStep(zoom, 1)) : null,
      reset: zoom !== 1 ? () => saveZoom(name, 1) : null,
    },
    ...size,
  ];
}

/**
 * A popup's gear: in a sheet's head beside its close, off the sheet the
 * head sits in (`PopHere`), or in a popover's top corner (`corner`), off
 * the grip that puts it there. Nothing outside a popup.
 */
export function PopGear({ spec, corner = false }: { spec?: PopSpec; corner?: boolean }) {
  const here = useContext(PopHere);
  const of = spec ?? here;
  return of ? <PopGearOf spec={of} corner={corner} /> : null;
}

function PopGearOf({ spec, corner }: { spec: PopSpec; corner: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const entries = usePopEntries(spec, () => ref.current?.closest<HTMLElement>(".sheet, .settings-pop") ?? null);
  return (
    <span ref={ref} className={`pop-gear${corner ? " corner" : ""}`}>
      <Gear label="this popup" hint={spec.tab ? "Zoom, size and as a tab" : "Zoom and size"} groups={[{ label: "this popup", entries }]} />
    </span>
  );
}
