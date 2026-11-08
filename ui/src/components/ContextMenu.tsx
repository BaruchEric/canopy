/**
 * The right-click menu's host (FR-056): one menu for the whole page, opened
 * at the pointer by a right-click or under the focused thing by the menu
 * key or Shift+F10, with what it offers built by components/ContextMenus.tsx
 * from what was clicked. The pure half (placement, the pointer's path into
 * a submenu, the filter) is ui/src/ctxmenu.ts.
 *
 * How it behaves:
 * - It opens only where canopy has something to say; text boxes, shells,
 *   pictures, the Secrets view and Shift+right-click keep the browser's.
 * - A menu is a thunk, run again on every store change while it is open,
 *   so a run that starts or a star that lands shows in it at once.
 * - Typing filters every row, submenus' rows included, through a box that
 *   holds the focus from the start. With the focus in a text box the page's
 *   own one-key shortcuts stay quiet, and the box's keydown stops each key
 *   before App's window listener hears it.
 * - Submenus open beside their row on hover or →, and a pointer crossing a
 *   sibling row on its way into an open submenu leaves it open. On a phone
 *   the menu is a sheet at the bottom and a submenu replaces its rows.
 * - A long-press (Android's right-click) opens it too, and the word the
 *   long-press selected on its way is dropped.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { onGearChange, type GearReg } from "../ctxgears";
import {
  ctxSkip,
  fuzzy,
  headingInto,
  placeAt,
  placeSub,
  placeUnder,
  searchItems,
  type Box,
  type CtxGroup,
  type CtxItem,
  type CtxNode,
  type Point,
} from "../ctxmenu";
import { PHONE, useMedia } from "../media";
import { oneMenu } from "../menus";
import { say } from "../said";
import { useStore } from "../store";
import { Entry } from "./Gear";

/** The line naming what was right-clicked, with the card's leaf edge in
 *  its state's colour. */
export interface CtxHead {
  glyph?: string;
  /** a state class (`s-dirty`) whose colour the glyph and the edge take */
  state?: string;
  title: string;
  /** facts under the name; `mono` for what is read a character at a time */
  facts?: { text: string; mono?: true; title?: string }[];
}

/** One of the glyph buttons under the head: the few things done most. */
export interface CtxQuick {
  id: string;
  /** its name, said as its tooltip and to a screen reader */
  label: string;
  icon: ReactNode;
  run: () => unknown;
  /** a toggle that is on (a star), drawn in moss */
  on?: boolean;
}

/** A run of rows: built from data, or drawn by a component that already
 *  draws them (the ⋯ menu's body, a gear's groups). `node` gets the close. */
export type CtxBlock =
  | { kind: "items"; key: string; label?: string; items: CtxItem[] }
  | { kind: "node"; key: string; node: (done: () => void) => ReactNode };

export interface CtxSpec {
  /** what a screen reader calls the menu */
  label: string;
  head?: CtxHead;
  quick?: CtxQuick[];
  blocks: CtxBlock[];
}

/** What builds the menu for a right-click: the element it landed on, its
 *  ancestors as data, and the page's selection; null leaves it to the
 *  browser. */
export type CtxBuild = (target: Element, chain: CtxNode[], selection: string) => CtxSpec | null;

type Anchor = { at: Point } | { under: Box };

interface Open {
  id: number;
  build: () => CtxSpec | null;
  anchor: Anchor;
  /** what had the focus, given back on Escape */
  restore: HTMLElement | null;
  /** opened from the keyboard: the first row is active at once */
  keyed: boolean;
  /** what was right-clicked: a scroll that moves it closes the menu, one
   *  elsewhere (a log following its run) does not */
  target: Element | null;
}

let current: Open | null = null;
let serial = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => current;
const none = () => null;

/** Opens a menu; `build` runs on every redraw while it is open. */
export function openCtx(build: () => CtxSpec | null, anchor: Anchor, keyed = false, target: Element | null = null): void {
  const was = document.activeElement;
  current = {
    id: ++serial,
    build,
    anchor,
    restore: was instanceof HTMLElement && !was.closest(".ctx-menu") ? was : (current?.restore ?? null),
    keyed,
    target,
  };
  notify();
}

/** Closes the menu, if one is open; `refocus` gives the focus back. */
export function closeCtx(refocus = false): void {
  if (!current) return;
  const back = current.restore;
  current = null;
  notify();
  if (refocus && back?.isConnected) back.focus({ preventScroll: true });
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs a row's action after the menu closes, so a sheet or a shell it
 *  opens gets the focus; a string it resolves to is said in the quiet line,
 *  a failure in rust. */
export function runCtx(fn: () => unknown): void {
  closeCtx();
  try {
    void Promise.resolve(fn()).then(
      (out) => {
        if (typeof out === "string" && out) say(out);
      },
      (err: unknown) => say(errText(err), true),
    );
  } catch (err) {
    say(errText(err), true);
  }
}

/** The element and its ancestors up to the body, as data for ctxmenu.ts. */
export function chainOf(el: Element): CtxNode[] {
  const out: CtxNode[] = [];
  for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
    const attrs: Record<string, string> = {};
    for (const a of at.attributes) attrs[a.name] = a.value;
    out.push({ tag: at.tagName.toLowerCase(), cls: [...at.classList], attrs });
  }
  return out;
}

/** The text selected on the page, if the selection is not inside a box
 *  (a box's own menu has its copy). */
function selectedText(): string {
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return "";
  const at = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (at?.closest("input, textarea, [contenteditable], .term-view")) return "";
  return sel.toString().trim();
}

/** how many opens the foot's word on filtering and Shift shows for */
const FOOT_OPENS = 6;
const FOOT_KEY = "canopy.ctxFoot";

/** Counts this open and says whether the foot still shows: for the first
 *  few in this browser, and always where storage is refused. */
function footShows(): boolean {
  try {
    const n = Number(localStorage.getItem(FOOT_KEY)) || 0;
    if (n >= FOOT_OPENS) return false;
    localStorage.setItem(FOOT_KEY, String(n + 1));
    return true;
  } catch {
    return true;
  }
}

/** how long after a keyboard open a stray contextmenu event is ignored */
const KEY_ECHO_MS = 400;
/** the longest a touch can be held before its contextmenu event and still
 *  count as that event's long-press */
const LONG_PRESS_MS = 3000;

/**
 * Mounted once per window (App mounts it in both of its branches): hears
 * every right-click and the menu keys, and draws the open menu.
 */
export function ContextMenuHost({ build }: { build: CtxBuild }) {
  const open = useSyncExternalStore(subscribe, snapshot, none);
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    let keyedAt = 0;
    // a long-press selects the word under the finger before its
    // contextmenu event comes, so the last touch's start says whether a
    // selection was there already (meant) or is the long-press's own
    let touchDown: { at: number; selected: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      touchDown = e.pointerType === "touch" ? { at: Date.now(), selected: !(getSelection()?.isCollapsed ?? true) } : null;
    };
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || !(e.target instanceof Element)) return;
      if (Date.now() - keyedAt < KEY_ECHO_MS) {
        e.preventDefault();
        return;
      }
      const target = e.target;
      const chain = chainOf(target);
      const skip = ctxSkip(chain, e.shiftKey);
      if (skip === "menu") {
        e.preventDefault();
        return;
      }
      if (skip) return;
      const pressed = touchDown !== null && Date.now() - touchDown.at < LONG_PRESS_MS;
      const madeByPress = pressed && touchDown?.selected === false;
      const selection = madeByPress ? "" : selectedText();
      if (!buildRef.current(target, chain, selection)) return;
      e.preventDefault();
      // the menu is about the thing pressed, not a word: drop the
      // long-press's selection, and with it the handles and the phone's
      // own search bar it brings up
      if (madeByPress) getSelection()?.removeAllRanges();
      // a keyboard's contextmenu event comes at 0,0 or with no pointer
      const keyed = (e.clientX === 0 && e.clientY === 0) || (e instanceof PointerEvent && e.pointerId === -1);
      const r = target.getBoundingClientRect();
      openCtx(() => buildRef.current(target, chainOf(target), selection), keyed ? { under: r } : { at: { x: e.clientX, y: e.clientY } }, keyed, target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey))) return;
      const ringed = useStore.getState().kbRing ? document.querySelector("[data-kb-on]") : null;
      const target = ringed ?? (document.activeElement instanceof Element ? document.activeElement : null);
      if (!target || target === document.body) return;
      const chain = chainOf(target);
      if (ctxSkip(chain, false)) return;
      const selection = selectedText();
      if (!buildRef.current(target, chain, selection)) return;
      e.preventDefault();
      keyedAt = Date.now();
      openCtx(() => buildRef.current(target, chainOf(target), selection), { under: target.getBoundingClientRect() }, true, target);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("contextmenu", onMenu);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("contextmenu", onMenu);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return open ? <CtxMenu key={open.id} open={open} /> : null;
}

/** An open submenu: the row that opened it and the rows it holds. */
interface Sub {
  id: string;
  label: string;
  items: CtxItem[];
  /** the row's box when it opened, which the submenu sits beside */
  row: Box;
}

const ROWS = '[role^="menuitem"]';

/** The rows the keyboard walks in a panel: shown, not filtered out, not
 *  dimmed or disabled. */
function rowsIn(panel: Element | null | undefined): HTMLElement[] {
  if (!panel) return [];
  return [...panel.querySelectorAll<HTMLElement>(ROWS)].filter(
    (el) => !el.closest("[data-miss]") && el.getAttribute("aria-disabled") !== "true" && !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
  );
}

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

let rowIds = 0;

function CtxMenu({ open }: { open: Open }) {
  // run again on every store change and every gear's redraw while open
  useSyncExternalStore(useStore.subscribe, useStore.getState);
  const [, redraw] = useState(0);
  useEffect(() => onGearChange(() => redraw((n) => n + 1)), []);
  const spec = open.build();
  const sheet = useMedia(PHONE);
  const coarse = useMedia("(pointer: coarse)");
  const [query, setQuery] = useState("");
  const [subs, setSubs] = useState<Sub[]>([]);
  // which panel the keyboard is in: 0 the menu, n the nth submenu
  const [level, setLevel] = useState(0);
  const [spot, setSpot] = useState<{ left: number; top: number; ox: number; oy: number } | null>(null);
  const [subSpots, setSubSpots] = useState<({ left: number; top: number; side: "right" | "left" } | null)[]>([]);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const activeEl = useRef<HTMLElement | null>(null);
  // the pointer where it was one move ago and where it is: the path into
  // an open submenu is read off the two
  const pointer = useRef<{ from: Point | null; to: Point | null }>({ from: null, to: null });
  const hover = useRef<number | undefined>(undefined);
  // the row a hover timer is waiting on, so moving within it does not
  // start the wait again
  const hoverRow = useRef<HTMLElement | null>(null);
  const [nodeHits, setNodeHits] = useState(0);
  const [foot] = useState(footShows);

  const close = useCallback((refocus = false) => closeCtx(refocus), []);

  // nothing to show any more (the card left the board): close
  useEffect(() => {
    if (!spec) close();
  }, [spec, close]);

  useEffect(() => {
    const release = oneMenu(() => closeCtx());
    const inside = (t: EventTarget | null) => t instanceof Node && panels.current.some((p) => p?.contains(t));
    const down = (e: PointerEvent) => {
      if (!inside(e.target)) close();
    };
    // a scroll closes the menu when it moved what was clicked from under
    // it; a log following its run elsewhere does not, and nor does the
    // scroll a right-click's own focus started, which the browser reports
    // a frame after the menu opened
    const what = open.target;
    const was = what?.getBoundingClientRect();
    const scroll = (e: Event) => {
      const t = e.target;
      if (inside(t)) return;
      // what was clicked is gone (its card moved to another group), so a
      // scroll anywhere closes the menu, as nothing holds it in place
      if (!what?.isConnected || !was) return close();
      if (t instanceof Node && !t.contains(what)) return;
      const now = what.getBoundingClientRect();
      if (Math.abs(now.top - was.top) > 2 || Math.abs(now.left - was.left) > 2) close();
    };
    const gone = () => close();
    // the focus left the menu (a click outside that kept it open cannot,
    // but a page that grabs the focus can): Escape still closes it, and any
    // other key brings the focus back to the filter box first
    const key = (e: KeyboardEvent) => {
      if (inside(document.activeElement)) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        close(true);
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        // kept from App's one-key shortcuts, as a key in the box is
        e.stopPropagation();
        input.current?.focus({ preventScroll: true });
      }
    };
    const move = (e: PointerEvent) => {
      pointer.current = { from: pointer.current.to, to: { x: e.clientX, y: e.clientY } };
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("pointermove", move, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    return () => {
      release();
      clearTimeout(hover.current);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointermove", move, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
    };
  }, [close, open.target]);

  // the focus goes to the filter box, or on a touch screen to the menu
  // itself, so no keyboard slides up; once placed, since a menu still
  // hidden while it is measured cannot take the focus
  const placed = sheet || spot !== null;
  useEffect(() => {
    if (!placed) return;
    if (coarse) panels.current[0]?.focus({ preventScroll: true });
    else input.current?.focus({ preventScroll: true });
  }, [coarse, placed]);

  const view = () => ({ w: window.innerWidth, h: window.innerHeight });

  // placed once measured; held where it is after that, so a redraw from
  // the store does not walk it away from the pointer
  useLayoutEffect(() => {
    const el = panels.current[0];
    if (!el || sheet) return;
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    setSpot((s) => {
      if (s && s.top + size.h <= window.innerHeight - 8) return s;
      return "at" in open.anchor ? placeAt(open.anchor.at, size, view()) : placeUnder(open.anchor.under, size, view());
    });
  });

  useLayoutEffect(() => {
    if (sheet) return;
    const next = subs.map((s, i) => {
      const el = panels.current[i + 1];
      const parent = panels.current[i];
      if (!el || !parent) return null;
      return placeSub(s.row, boxOf(parent.getBoundingClientRect()), { w: el.offsetWidth, h: el.offsetHeight }, view());
    });
    setSubSpots((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  }, [subs, sheet]);

  const setActive = useCallback((el: HTMLElement | null, reveal = true) => {
    if (activeEl.current === el) return;
    activeEl.current?.removeAttribute("data-active");
    activeEl.current = el;
    if (!el) {
      input.current?.removeAttribute("aria-activedescendant");
      return;
    }
    if (!el.id) el.id = `ctx-row-${++rowIds}`;
    el.setAttribute("data-active", "");
    input.current?.setAttribute("aria-activedescendant", el.id);
    if (reveal) el.scrollIntoView({ block: "nearest" });
  }, []);

  // the filter's reach into rows a component draws: a row that does not
  // match is marked and hidden, and a block with none left goes too
  useLayoutEffect(() => {
    const root = panels.current[0];
    if (!root) return;
    for (const block of root.querySelectorAll<HTMLElement>(".ctx-node")) {
      let any = false;
      for (const row of block.children) {
        if (!(row instanceof HTMLElement)) continue;
        if (!query || row.classList.contains("menu-label")) {
          row.removeAttribute("data-miss");
          continue;
        }
        const words = [row.textContent ?? "", ...[...row.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label") ?? "")].join(" ");
        const hit = fuzzy(words, query) !== null && row.querySelector(ROWS) !== null;
        if (hit) row.removeAttribute("data-miss");
        else row.setAttribute("data-miss", "");
        any ||= hit;
      }
      if (query && !any) block.setAttribute("data-miss", "");
      else block.removeAttribute("data-miss");
    }
    const n = countNodeHits(root);
    setNodeHits((was) => (was === n ? was : n));
  });

  // a keyboard open starts on the first row; a filter starts on its best
  // hit, once the rows above have been marked
  useLayoutEffect(() => {
    if (open.keyed || query) setActive(rowsIn(panels.current[0])[0] ?? null);
    else setActive(null);
  }, [query, open.keyed, setActive]);

  if (!spec) return null;

  const groups: CtxGroup[] = spec.blocks.flatMap((b) => (b.kind === "items" ? [{ ...(b.label ? { label: b.label } : {}), items: b.items }] : []));
  const hits = query ? searchItems(groups, query) : [];

  const openSub = (item: Extract<CtxItem, { kind: "sub" }>, row: HTMLElement, at: number, keyed: boolean) => {
    setSubs((was) => [...was.slice(0, at), { id: item.id, label: item.label, items: item.sub, row: boxOf(row.getBoundingClientRect()) }]);
    if (keyed) {
      setLevel(at + 1);
      requestAnimationFrame(() => setActive(rowsIn(panels.current[at + 1])[0] ?? null));
    }
  };

  const closeSubs = (from: number) => {
    setSubs((was) => (was.length > from ? was.slice(0, from) : was));
    setLevel((l) => Math.min(l, from));
  };

  // the submenu rows drawn this time, by id, for the keyboard to open
  const subRows = new Map<string, { item: Extract<CtxItem, { kind: "sub" }>; at: number }>();

  const activate = (el: HTMLElement) => {
    const sub = el.dataset["sub"] ? subRows.get(el.dataset["sub"]) : undefined;
    if (sub) {
      if (el.getAttribute("aria-disabled") !== "true") openSub(sub.item, el, sub.at, true);
      return;
    }
    el.click();
  };

  const onKey = (e: ReactKeyboardEvent) => {
    // every key stays in the menu: App's one-key shortcuts and a sheet's
    // Escape listen on the window, after React's root
    e.stopPropagation();
    const panel = panels.current[sheet ? 0 : level] ?? null;
    const rows = rowsIn(panel);
    const at = activeEl.current ? rows.indexOf(activeEl.current) : -1;
    const go = (i: number) => {
      e.preventDefault();
      setActive(rows[i] ?? null);
    };
    switch (e.key) {
      case "ArrowDown":
        return go(at < 0 ? 0 : (at + 1) % rows.length);
      case "ArrowUp":
        return go(at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length);
      case "Tab":
        return go(e.shiftKey ? (at <= 0 ? rows.length - 1 : at - 1) : (at + 1) % rows.length);
      case "Home":
        if (query) return;
        return go(0);
      case "End":
        if (query) return;
        return go(rows.length - 1);
      case "ArrowRight":
        if (activeEl.current?.dataset["sub"]) {
          e.preventDefault();
          activate(activeEl.current);
        }
        return;
      case "ArrowLeft":
        if (level > 0 && !query) {
          e.preventDefault();
          backOut();
        }
        return;
      case "Enter":
        if (activeEl.current) {
          e.preventDefault();
          activate(activeEl.current);
        }
        return;
      case " ":
        if (!query && activeEl.current) {
          e.preventDefault();
          activate(activeEl.current);
        }
        return;
      case "Escape":
        e.preventDefault();
        if (query) setQuery("");
        else if (level > 0 || (sheet && subs.length > 0)) backOut();
        else close(true);
        return;
      default:
        // a key typed with the focus on the menu itself (a touch screen
        // with a keyboard) still filters
        if (document.activeElement !== input.current && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          input.current?.focus();
        }
    }
  };

  // ← or Escape in a submenu: back to the row that opened it
  const backOut = () => {
    const depth = sheet ? subs.length : level;
    if (depth <= 0) return;
    const sub = subs[depth - 1];
    closeSubs(depth - 1);
    setLevel(depth - 1);
    requestAnimationFrame(() => {
      const parent = panels.current[sheet ? 0 : depth - 1];
      const row = sub ? parent?.querySelector<HTMLElement>(`[data-sub="${CSS.escape(sub.id)}"]`) : null;
      setActive(row ?? rowsIn(parent)[0] ?? null);
    });
  };

  // a row under the pointer is the active one; a submenu row opens its rows
  // after a breath, and a pointer on its way into an open submenu across
  // other rows leaves it open
  const onRowHover = (row: HTMLElement, at: number, item: CtxItem | null) => {
    setActive(row, false);
    setLevel(at);
    if (sheet || hoverRow.current === row) return;
    clearTimeout(hover.current);
    hoverRow.current = row;
    const shown = subs[at];
    if (shown && item?.id === shown.id) {
      closeSubs(at + 1);
      return;
    }
    const subEl = panels.current[at + 1];
    const side = subSpots[at]?.side;
    const { from, to } = pointer.current;
    const wait = shown && subEl && side && from && to && headingInto(from, to, boxOf(subEl.getBoundingClientRect()), side);
    hover.current = window.setTimeout(
      () => {
        hoverRow.current = null;
        if (!row.isConnected || activeEl.current !== row) return;
        if (item?.kind === "sub" && !item.off) openSub(item, row, at, false);
        else closeSubs(at);
      },
      wait ? 260 : shown ? 90 : item?.kind === "sub" ? 70 : 0,
    );
  };

  const swallow = (e: SyntheticEvent) => e.stopPropagation();
  // a press on a row leaves the focus in the filter box, where the keys are
  const keepFocus = (e: React.MouseEvent) => {
    if (!(e.target instanceof Element && e.target.closest("input, textarea"))) e.preventDefault();
  };

  const rowOf = (item: CtxItem, at: number, path: string[] = []) => {
    const off = item.off;
    const tone = item.tone ? ` t-${item.tone}` : "";
    const inner = (
      <>
        {item.glyph && (
          <span className="ctx-glyph" aria-hidden="true">
            {item.glyph}
          </span>
        )}
        <span className="menu-text">
          {path.length > 0 && <span className="ctx-path">{path.join(" › ")} › </span>}
          {item.label}
        </span>
        {item.fact !== undefined ? (
          <span className={typeof item.fact === "string" ? "menu-fact" : "menu-fact mono"}>{typeof item.fact === "string" ? item.fact : item.fact.code}</span>
        ) : (
          off && <span className="menu-fact">{off}</span>
        )}
        {item.keys && (
          <span className="ctx-keys" aria-hidden="true">
            {item.keys}
          </span>
        )}
        {item.kind === "sub" && (
          <span className="ctx-chev" aria-hidden="true">
            ›
          </span>
        )}
      </>
    );
    const common = {
      role: "menuitem",
      className: `menu-item ctx-item${tone}${subs[at]?.id === item.id && item.kind === "sub" ? " ctx-open" : ""}`,
      "aria-disabled": off ? true : undefined,
      title: off ?? item.title,
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType !== "touch") onRowHover(e.currentTarget, at, item);
      },
    } as const;
    if (item.kind === "link") {
      return (
        <a key={item.id} {...common} href={off ? undefined : item.href} target="_blank" rel="noreferrer noopener" onClick={() => closeCtx()}>
          {inner}
        </a>
      );
    }
    if (item.kind === "sub") {
      subRows.set(item.id, { item, at });
      return (
        <button
          key={item.id}
          type="button"
          {...common}
          aria-haspopup="menu"
          aria-expanded={subs[at]?.id === item.id}
          data-sub={item.id}
          onClick={(e) => {
            if (!off) openSub(item, e.currentTarget, at, e.detail === 0);
          }}
        >
          {inner}
        </button>
      );
    }
    return (
      <button
        key={item.id}
        type="button"
        {...common}
        onClick={() => {
          if (off) return;
          if (item.stay) {
            try {
              void Promise.resolve(item.run()).then((out) => typeof out === "string" && out && say(out));
            } catch (err) {
              say(errText(err), true);
            }
          } else runCtx(item.run);
        }}
      >
        {inner}
      </button>
    );
  };

  const head = spec.head;
  const depth = subs.length;
  // on a phone the sheet shows one level at a time: the deepest submenu
  const drilled = sheet && depth > 0 ? subs[depth - 1] : null;

  const main = (
    <div
      ref={(el) => {
        panels.current[0] = el;
      }}
      className={`menu ctx-menu${sheet ? " ctx-sheet" : ""}${query ? " ctx-filtering" : ""}`}
      role="menu"
      aria-label={spec.label}
      tabIndex={-1}
      data-level={0}
      style={
        sheet
          ? undefined
          : ({
              top: spot?.top ?? -9999,
              left: spot?.left ?? -9999,
              visibility: spot ? "visible" : "hidden",
              "--ctx-ox": `${spot?.ox ?? 0}px`,
              "--ctx-oy": `${spot?.oy ?? 0}px`,
            } as React.CSSProperties)
      }
      onKeyDown={onKey}
      onClick={swallow}
      onPointerDown={swallow}
      onMouseDown={keepFocus}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {head && !drilled && (
        <div className={`ctx-head${head.state ? ` ${head.state}` : ""}`}>
          {head.glyph && (
            <span className="ctx-head-glyph glyph" aria-hidden="true">
              {head.glyph}
            </span>
          )}
          <span className="ctx-head-words">
            <span className="ctx-head-title">{head.title}</span>
            {head.facts && head.facts.length > 0 && (
              <span className="ctx-head-facts">
                {head.facts.map((f) => (
                  <span key={f.text} className={f.mono ? "mono" : undefined} title={f.title}>
                    {f.text}
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>
      )}
      <div className={`ctx-find${query ? " on" : ""}`}>
        <span className="ctx-find-mark" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={input}
          className="ctx-find-box"
          type="text"
          value={query}
          spellCheck={false}
          autoComplete="off"
          aria-label="Filter the menu"
          onChange={(e) => {
            setQuery(e.target.value);
            closeSubs(0);
          }}
          onKeyDown={onKey}
        />
        {query && <span className="ctx-find-count">{hits.length + nodeHits}</span>}
      </div>
      {drilled ? (
        <div className="ctx-block">
          <button type="button" role="menuitem" className="menu-item ctx-item ctx-back" onClick={backOut}>
            <span className="ctx-glyph" aria-hidden="true">
              ‹
            </span>
            <span className="menu-text">{drilled.label}</span>
          </button>
          {drilled.items.map((item) => rowOf(item, depth))}
        </div>
      ) : (
        <>
          {!query && spec.quick && spec.quick.length > 0 && (
            <div className="ctx-quick" role="group" aria-label="Quick actions">
              {spec.quick.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  role="menuitem"
                  className={`ctx-quick-btn${q.on ? " on" : ""}`}
                  aria-label={q.label}
                  title={q.label}
                  onPointerMove={(e) => {
                    if (e.pointerType !== "touch") onRowHover(e.currentTarget, 0, null);
                  }}
                  onClick={() => runCtx(q.run)}
                >
                  {q.icon}
                </button>
              ))}
            </div>
          )}
          {query && hits.length > 0 && (
            <div className="ctx-block ctx-hits">
              {hits.map((h) => rowOf(h.item, 0, h.path))}
            </div>
          )}
          {spec.blocks.map((b) =>
            b.kind === "items" ? (
              query ? null : (
                <div key={b.key} className="ctx-block" role="group" aria-label={b.label}>
                  {b.label && <p className="menu-label">{b.label}</p>}
                  {b.items.map((item) => rowOf(item, 0))}
                </div>
              )
            ) : (
              <div key={b.key} className="ctx-block ctx-node">
                {b.node(() => closeCtx())}
              </div>
            ),
          )}
          {query && hits.length + nodeHits === 0 && <p className="ctx-none">Nothing in this menu matches "{query}"</p>}
        </>
      )}
      {foot && !coarse && !query && (
        <p className="ctx-foot">
          Type to filter. <kbd>⇧</kbd> right-click for the browser's own menu.
        </p>
      )}
    </div>
  );

  const flyouts = sheet
    ? null
    : subs.map((s, i) => {
        const at = i + 1;
        const where = subSpots[i];
        return (
          <div
            key={s.id}
            ref={(el) => {
              panels.current[at] = el;
            }}
            className="menu ctx-menu ctx-sub"
            role="menu"
            aria-label={s.label}
            data-level={at}
            style={{ top: where?.top ?? -9999, left: where?.left ?? -9999, visibility: where ? "visible" : "hidden" }}
            onKeyDown={onKey}
            onClick={swallow}
            onPointerDown={swallow}
            onMouseDown={keepFocus}
            onPointerEnter={() => {
              clearTimeout(hover.current);
              hoverRow.current = null;
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {s.items.map((item) => rowOf(item, at))}
          </div>
        );
      });
  panels.current.length = sheet ? 1 : subs.length + 1;

  return createPortal(
    <>
      {sheet && <div className="ctx-scrim" aria-hidden="true" onPointerDown={() => close()} />}
      {main}
      {flyouts}
    </>,
    document.body,
  );
}

/** how many rows a component drew still match the filter */
function countNodeHits(root: HTMLElement | null | undefined): number {
  if (!root) return 0;
  let n = 0;
  for (const block of root.querySelectorAll(".ctx-node")) {
    for (const row of block.children) if (!row.hasAttribute("data-miss") && !row.classList.contains("menu-label") && row.querySelector(ROWS)) n++;
  }
  return n;
}

/** A gear's groups in the menu, drawn the way the gear draws them. A zoom
 *  or a toggle keeps the menu open and shows its new state; anything else
 *  closes it. What a line resolves to is said in the quiet line. */
export function GearBlock({ reg, done }: { reg: GearReg; done: () => void }) {
  const act = (fn: () => unknown, stay: boolean) => {
    if (!stay) {
      done();
      runCtx(fn);
      return;
    }
    try {
      void Promise.resolve(fn()).then(
        (out) => {
          if (typeof out === "string" && out) say(out);
        },
        (err: unknown) => say(errText(err), true),
      );
    } catch (err) {
      say(errText(err), true);
    }
  };
  return (
    <>
      {reg
        .groups()
        .filter((g) => g.entries.length > 0)
        .flatMap((g) => [
          <p key={`label:${g.label}`} className="menu-label">
            {g.label}
          </p>,
          ...g.entries.map((entry) => (
            <Entry key={`${g.label}:${entry.type}:${entry.label}${entry.type === "forget" ? `:${entry.sub ?? ""}` : ""}`} entry={entry} act={act} />
          )),
        ])}
    </>
  );
}
