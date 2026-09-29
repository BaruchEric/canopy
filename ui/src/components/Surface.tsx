import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import { openSectionElsewhere } from "../routes";
import { closedIn, idText, useStore } from "../store";
import {
  SECTION_WORD,
  flipMode,
  frontZoomOf,
  moveSection,
  toggleHidden,
  withFrontZoom,
  withZoom,
  zoomOf,
  zoomStep,
  zoomWord,
  ZOOM_MAX,
  ZOOM_MIN,
  termFontIn,
  withTermFont,
  copiedWord,
  type CopyOut,
  type SectionKey,
  type ShellSpot,
  type SurfaceMode,
  type ZoomKind,
} from "../surface";
import { capture, copyText, readText, surfaceText } from "../share";
import { TERM_FONT, focusResize, type FocusSize } from "../term";
import { benchHolds, benchIs } from "../front";
import { TERM_FONT_MAX, TERM_FONT_MIN } from "../touch";
import type { Repo } from "../../../src/core/types";
import { Gear, type GearEntry, type GearGroup } from "./Gear";

/* ---------- the window a lone section lives in ---------- */

/** true inside a window that shows one section: it is always open there,
 *  and its gear has no place in a panel to offer */
export const SectionWindow = createContext(false);

/** whether `key` is folded in `repoId`'s panel; never in a section window,
 *  which reads the grove's folds but must not write them, nor for a pane
 *  of the project's bench while it is in front */
export function useSectionClosed(repoId: string, key: string): boolean {
  const lone = useContext(SectionWindow);
  const held = useStore((s) => benchHolds(s.front, repoId, key));
  const closed = useStore((s) => closedIn(s, repoId, key));
  return lone || held ? false : closed;
}

/** true while the project's bench holds `key` open, so its fold does nothing */
export const useBenchHeld = (repoId: string, key: string): boolean => useStore((s) => benchHolds(s.front, repoId, key));

/* ---------- zoom ---------- */

/** The gear line for one kind of surface's zoom, and the css it applies.
 *  In front (`front`) a surface has a zoom of its own, which follows the
 *  in-place one until it is set; its reset goes back to following. */
export function useZoom(kind: ZoomKind, front = false): { zoom: number; entry: GearEntry } {
  const inPlace = useStore((s) => zoomOf(s.settings.zoom, kind));
  const zoom = useStore((s) => (front ? frontZoomOf(s.settings.frontZoom, s.settings.zoom, kind) : inPlace));
  const setSetting = useStore((s) => s.setSetting);
  const set = (z: number) => {
    const { settings } = useStore.getState();
    if (front) setSetting("frontZoom", withFrontZoom(settings.frontZoom, settings.zoom, kind, z));
    else setSetting("zoom", withZoom(settings.zoom, kind, z));
  };
  const home = front ? inPlace : 1;
  return {
    zoom,
    entry: {
      type: "zoom",
      label: front ? "zoom in front" : "zoom",
      value: zoomWord(zoom),
      less: zoom > ZOOM_MIN ? () => set(zoomStep(zoom, -1)) : null,
      more: zoom < ZOOM_MAX ? () => set(zoomStep(zoom, 1)) : null,
      reset: zoom !== home ? () => set(home) : null,
      home: zoomWord(home),
    },
  };
}

/** css `zoom` for a surface, or nothing at 1 */
export const zoomStyle = (z: number): CSSProperties => (z === 1 ? {} : { zoom: z });

/** Where the shells under it show, for their text size; in place outside any set. */
export const ShellSpotHere = createContext<ShellSpot>("place");

/** Sets the shells' text size at `spot`. Away from in place, the in-place
 *  size clears the spot's own, so it follows in place again. */
export function saveTermFont(spot: ShellSpot, px: number): void {
  const { settings, setSetting } = useStore.getState();
  const size = Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, px));
  if (spot === "place") setSetting("termFont", size);
  else setSetting("termFonts", withTermFont(settings.termFonts, settings.termFont, spot, size));
}

/** The shells' zoom at `spot`, which is the terminal's font size: css zoom
 *  on an xterm puts its mouse and selection off. It is the size a pinch
 *  sets. Away from in place, reset goes back to following that size. */
export function useShellZoom(spot: ShellSpot): GearEntry {
  const font = useStore((s) => termFontIn(s.settings.termFont, s.settings.termFonts, spot));
  const home = useStore((s) => (spot === "place" ? TERM_FONT.size : s.settings.termFont));
  const set = (px: number) => saveTermFont(spot, px);
  return {
    type: "zoom",
    label: "text",
    value: `${font}px`,
    less: font > TERM_FONT_MIN ? () => set(Math.ceil(font) - 1) : null,
    more: font < TERM_FONT_MAX ? () => set(Math.floor(font) + 1) : null,
    reset: font !== home ? () => set(home) : null,
    home: spot === "place" ? `${home}px` : `${home}px, the size in place`,
  };
}

/* ---------- how a surface sits ---------- */

/** The mode picks for a surface: in place, taking the whole of `what`, or
 *  in front of the dimmed page. */
export function modeEntries(mode: SurfaceMode, setMode: (m: SurfaceMode) => void, what: string): GearEntry[] {
  return [
    { type: "item", label: "in place", on: mode === "normal", run: () => setMode("normal") },
    { type: "item", label: `fill the ${what}`, on: mode === "full", run: () => setMode(flipMode(mode, "full")) },
    { type: "item", label: "bring to the front", on: mode === "focus", run: () => setMode(flipMode(mode, "focus")) },
  ];
}

/** What sits behind a surface brought to the front: the page, dimmed. A
 *  click on it puts the surface back. */
export function FocusBackdrop({ onLeave }: { onLeave: () => void }) {
  return <div className="term-focus-back" aria-hidden="true" onClick={onLeave} />;
}

/** Escape puts a surface back while it is over the panel, the window or in
 *  front, from anywhere but a terminal, where Escape belongs to the program
 *  in it. A menu or sheet that is up takes its Escape first. */
export function useLeaveOnEscape(mode: SurfaceMode, setMode: (m: SurfaceMode) => void): void {
  const leave = useRef(setMode);
  leave.current = setMode;
  useEffect(() => {
    if (mode === "normal") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(".term-screen, .menu, .sheet")) return;
      e.preventDefault();
      leave.current("normal");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);
}

/** The focused box's size as css vars, or nothing for the default size. */
export const focusVars = (size: FocusSize | null): CSSProperties =>
  size ? ({ "--focus-w": `${size.w}px`, "--focus-h": `${size.h}px` } as CSSProperties) : {};

/** The edges and corners of a focused box, by compass point. */
const FOCUS_EDGES = ["n", "e", "s", "w", "ne", "se", "sw", "nw"] as const;
type FocusEdge = (typeof FOCUS_EDGES)[number];

/** Every edge and corner of a focused box, each dragged to size it. */
export function FocusGrips({ box }: { box: RefObject<HTMLElement | null> }) {
  return (
    <>
      {FOCUS_EDGES.map((edge) => (
        <FocusGrip key={edge} box={box} edge={edge} />
      ))}
    </>
  );
}

/** One edge or corner of a focused box: dragged to size the box, which
 *  stays centred, so pulling any side out grows it on both. Double-clicked
 *  for the default. The bottom right corner is the one keyboard stop, sized
 *  by the arrows. It writes the size live to `box` while dragging and
 *  commits on release. */
function FocusGrip({ box, edge }: { box: RefObject<HTMLElement | null>; edge: FocusEdge }) {
  // which way a drag grows the box: out past a right or bottom edge is +,
  // out past a left or top edge is -
  const sx = edge.includes("e") ? 1 : edge.includes("w") ? -1 : 0;
  const sy = edge.includes("s") ? 1 : edge.includes("n") ? -1 : 0;
  const setFocusSize = useStore((s) => s.setFocusSize);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; size: FocusSize } | null>(null);
  const view = (): FocusSize => ({ w: window.innerWidth, h: window.innerHeight });
  const current = (): FocusSize => {
    const r = box.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  };
  const sized = (e: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    return from ? focusResize(from.size, sx * (e.clientX - from.x), sy * (e.clientY - from.y), view()) : current();
  };
  const apply = (size: FocusSize) => {
    box.current?.style.setProperty("--focus-w", `${size.w}px`);
    box.current?.style.setProperty("--focus-h", `${size.h}px`);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, size: current() };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) apply(sized(e));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const size = sized(e);
    start.current = null;
    setDragging(false);
    setFocusSize(size);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (edge !== "se") return;
    const step = e.shiftKey ? 32 : 8;
    const d = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    setFocusSize(focusResize(current(), d[0] ?? 0, d[1] ?? 0, view()));
  };
  return (
    <div
      className={`focus-grip ${edge}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-label="Size of the box in front"
      aria-hidden={edge === "se" ? undefined : true}
      tabIndex={edge === "se" ? 0 : -1}
      title="Drag to resize, double-click to reset"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => {
        box.current?.style.removeProperty("--focus-w");
        box.current?.style.removeProperty("--focus-h");
        setFocusSize(null);
      }}
      onKeyDown={onKey}
    />
  );
}

/* ---------- sharing ---------- */

/**
 * The share lines for a surface: copy what it says, capture it, and paste
 * into it where it takes text. `el` is read at the click, so it is the box
 * as it shows then. `copy` stands in for the box's own text (a shell's
 * buffer, which the screen shows only part of).
 */
export function shareEntries({
  el,
  label,
  copy,
  paste,
  noCapture,
}: {
  el: () => HTMLElement | null;
  label: string;
  copy?: () => CopyOut | Promise<CopyOut>;
  paste?: ((text: string) => void) | null;
  /** why a capture cannot show this surface, when it cannot */
  noCapture?: string;
}): GearEntry[] {
  const out: GearEntry[] = [
    {
      type: "item",
      label: "copy text",
      stay: true,
      run: async () => {
        const box = el();
        const out = copy ? await copy() : box ? surfaceText(box) : "";
        const text = typeof out === "string" ? out : out.text;
        if (!text) return "nothing to copy";
        await copyText(text);
        return copiedWord(out);
      },
    },
    {
      type: "item",
      label: "capture",
      title: "A picture of this, on the clipboard or saved as a png",
      off: noCapture,
      stay: true,
      run: async () => {
        const box = el();
        if (!box) return "nothing to capture";
        return (await capture(box, label)) === "clipboard" ? "picture copied" : "picture saved to downloads";
      },
    },
  ];
  if (paste) {
    out.push({
      type: "item",
      label: "paste",
      off: window.isSecureContext ? undefined : "Reading the clipboard needs https; press ⌘V in the box instead",
      stay: true,
      run: async () => {
        const text = await readText();
        if (!text) return "the clipboard has no text";
        paste(text);
        return "pasted";
      },
    });
  }
  return out;
}

/* ---------- a panel's section ---------- */

/** The layout lines every section's gear has: where it sits, its place in
 *  the panel, and a window of its own. */
function useSectionLayout(repo: Repo, k: SectionKey, mode: SurfaceMode, setMode: (m: SurfaceMode) => void): GearEntry[] {
  const lone = useContext(SectionWindow);
  const order = useStore((s) => s.settings.sectionOrder);
  const hidden = useStore((s) => s.settings.sectionsHidden);
  const setSetting = useStore((s) => s.setSetting);
  if (lone) return [];
  const i = order.indexOf(k);
  return [
    ...modeEntries(mode, setMode, "panel"),
    ...(i > 0
      ? [{ type: "item" as const, label: "move up", stay: true, run: () => setSetting("sectionOrder", moveSection(order, k, -1)) }]
      : []),
    ...(i >= 0 && i < order.length - 1
      ? [{ type: "item" as const, label: "move down", stay: true, run: () => setSetting("sectionOrder", moveSection(order, k, 1)) }]
      : []),
    {
      type: "item",
      label: "hide in every panel",
      title: "The panel's own gear brings it back",
      run: () => setSetting("sectionsHidden", toggleHidden(hidden, k)),
    },
    { type: "item", label: "open in a new tab", run: () => openSectionElsewhere(repo.id, k, "tab") },
    { type: "item", label: "open in a new window", run: () => openSectionElsewhere(repo.id, k, "window") },
  ];
}

/**
 * One section of a repo's panel: the fold header with its gear, then the
 * body while open. The gear zooms every section of this kind, sits this one
 * in place, over the whole panel or in front of the page, moves or hides it
 * in every panel, pops it out, and shares it.
 */
export function Section({
  repo,
  k,
  className,
  label,
  head,
  title,
  after,
  layout = [],
  paste,
  copy,
  noCapture,
  tools,
  below,
  children,
}: {
  repo: Repo;
  k: SectionKey;
  className: string;
  /** what a screen reader calls the section */
  label: string;
  /** what the fold header says after the section's name */
  head: ReactNode;
  title?: string;
  /** shown under the header whether folded or not */
  after?: ReactNode;
  /** layout lines of the section's own, ahead of the common ones */
  layout?: GearEntry[];
  paste?: ((text: string) => void) | null;
  /** the section's text for a copy, when its own words read badly as text */
  copy?: () => string;
  noCapture?: string;
  /** buttons in the header ahead of the gear, or a function of how the
   *  section sits (focus while its project's bench is up) and the setter */
  tools?: ReactNode | ((mode: SurfaceMode, setMode: (m: SurfaceMode) => void) => ReactNode);
  /** shown under the zoomed body, outside its zoom: an xterm there keeps
   *  its mouse and selection */
  below?: ReactNode;
  children: ReactNode;
}) {
  const lone = useContext(SectionWindow);
  const closed = useSectionClosed(repo.id, k);
  const toggleSection = useStore((s) => s.toggleSection);
  const box = useRef<HTMLElement>(null);
  const [ownMode, setOwnMode] = useState<SurfaceMode>("normal");
  // In a panel, in front is the project's bench, which this section is one
  // part of: it lays out in place there, and its gear's "in front" is the
  // bench's. A section in a window of its own still comes forward alone.
  const bench = useStore((s) => benchIs(s.front, repo.id)) && !lone;
  const held = useBenchHeld(repo.id, k) && !lone;
  const bringProject = useStore((s) => s.bringProject);
  const setMode = (m: SurfaceMode) => {
    if (!lone && m === "focus") bringProject(repo.id);
    else {
      if (bench) bringProject(null);
      setOwnMode(m);
    }
  };
  // folded, a section is neither over the panel nor in front
  const mode: SurfaceMode = closed || bench ? "normal" : ownMode;
  const shown: SurfaceMode = bench ? "focus" : mode;
  const { zoom, entry: zoomEntry } = useZoom(k);
  const common = useSectionLayout(repo, k, shown, setMode);
  useLeaveOnEscape(mode, setMode);
  const word = SECTION_WORD[k];
  const groups: GearGroup[] = [
    { label: `${word} · every panel`, entries: [zoomEntry] },
    { label: "layout", entries: [...layout, ...common] },
    {
      label: "share",
      entries: shareEntries({ el: () => box.current, label: `${word} ${idText(repo.id)}`, copy, paste, noCapture }),
    },
  ];
  return (
    <section
        ref={box}
        className={`${className} surface${mode === "full" ? " section-full" : ""}`}
        aria-label={label}
        data-section={k}
      >
        <div className="section-head">
          <button
            type="button"
            className={`panel-label fold${closed ? "" : " open"}`}
            aria-expanded={!closed}
            disabled={lone || held}
            onClick={() => toggleSection(repo.id, k)}
            title={title}
          >
            {word} <span>{head}</span>
          </button>
          {!closed && (typeof tools === "function" ? tools(shown, setMode) : tools)}
          <Gear label={`${word} at ${repo.name}`} groups={groups} />
        </div>
        <div className="section-main" style={zoomStyle(zoom)}>
          {after}
          {!closed && children}
        </div>
        {!closed && below}
    </section>
  );
}
