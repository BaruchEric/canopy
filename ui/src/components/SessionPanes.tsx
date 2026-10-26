import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from "react";
import { HARNESS } from "../../../src/core/harness";
import { harnessesOf } from "../agents";
import { otherHarness } from "../handoff";
import { backendOf } from "../registry";
import { canMove, movableOf, movedId, movePage, type Spot } from "../panemove";
import { atFrom, dropBox, edgeAt, leaveGroup, pruneGroups, setAt, seamsOf, splitIn, type Box, type Edge, type PaneTree, type Seam } from "../splitpanes";
import { connOf, dockless, useStore } from "../store";
import { openView } from "../clirun";
import type { TermTab } from "../term";
import { isItemTab, itemTabsAt, sectionTabsAt, type ItemTab, type PageTab, type SectionPlace, type SectionTab } from "../sectiontabs";
import { SECTION_WORD, type SectionKey } from "../surface";
import { useShellAgent } from "./AgentButtons";
import { handOff } from "./Handoff";

/** a part of the main pane as an inline style, in percent */
export const boxStyle = (b: Box): CSSProperties => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

/** where split groups are kept: the sessions view's strip shells, the
 *  repo panels' shells, or a shell window's */
type SplitsKey = "sessionSplits" | "panelSplits" | "windowSplits";
const SPLITS_OF: Record<SectionPlace, SplitsKey> = { strip: "sessionSplits", panel: "panelSplits", window: "windowSplits" };

/** every tab at `place` that a split may hold: its shells, the ones named
 *  in `also` (a shell window's own, which is not in the store), and the
 *  section tabs there (FR-030) */
function liveAt(terms: readonly TermTab[], tabs: readonly SectionTab[], items: readonly ItemTab[], place: SectionPlace, also: readonly string[]): Set<string> {
  return new Set([...terms.filter((t) => t.place === place).map((t) => t.id), ...also, ...sectionTabsAt(tabs, place).map((t) => t.id), ...itemTabsAt(items, place).map((t) => t.id)]);
}

const NONE: readonly string[] = [];
const NO_PAGES: readonly PageTab[] = [];

/** The saved split groups for one place's shells and section tabs, with
 *  the tabs since closed taken out, and a writer that reads them fresh, so
 *  two changes in one handler both land. */
export function useSplits(place: SectionPlace, also: readonly string[] = NONE) {
  const key = SPLITS_OF[place];
  const terms = useStore((s) => s.terms);
  const tabs = useStore((s) => s.settings.sectionTabs);
  const items = useStore((s) => s.settings.itemTabs);
  const splits = useStore((s) => s.settings[key]);
  const groups = useMemo(() => pruneGroups(splits, liveAt(terms, tabs, items, place, also)), [splits, terms, tabs, items, place, also]);
  const write = (f: (g: PaneTree[]) => PaneTree[]) => writeSplitsAt(place, f, also);
  return { groups, write };
}

/** One change to a place's split groups, read fresh from the store and
 *  pruned first, so two changes in one handler both land. */
export function writeSplitsAt(place: SectionPlace, f: (g: PaneTree[]) => PaneTree[], also: readonly string[] = NONE): void {
  const key = SPLITS_OF[place];
  const st = useStore.getState();
  st.setSetting(key, f(pruneGroups(st.settings[key], liveAt(st.terms, st.settings.sectionTabs, st.settings.itemTabs, place, also))));
}

/** the tab `id` names in the store, shell or page */
const movableNow = (id: string) => {
  const st = useStore.getState();
  return movableOf(st.terms, st.settings.sectionTabs, st.settings.itemTabs, id);
};

/** whether the shell window at `to` takes the tab `id` from another */
export const takes = (id: string, to: Spot): boolean => {
  const m = movableNow(id);
  return m !== null && canMove(m, to);
};

/**
 * A tab from another shell window landed on `beside`'s `edge` here (FR-031):
 * out of its old window's splits, moved (a shell on its backend first, so
 * every device's tab follows), and split in beside. The order matters: a
 * page tab's id names its place, so the old groups let go of the old id
 * before the tab moves, and the new groups take the new id after it has.
 * With no `beside` (a tab menu's move) it lands as a tab of its own. The
 * id the tab has now, or null when it did not move.
 */
export async function moveTo(id: string, to: Spot, beside: string | null = null, edge: Edge = "right"): Promise<string | null> {
  const m = movableNow(id);
  if (!m || !canMove(m, to)) return null;
  const from = m.tab.place;
  const st = useStore.getState();
  if (m.kind === "shell") {
    if (to.place === "window" || !(await st.placeTerm(id, to.place))) return null;
    writeSplitsAt(from, (g) => leaveGroup(g, id));
  } else {
    writeSplitsAt(from, (g) => leaveGroup(g, id));
    const moved = movePage(st.settings.sectionTabs, st.settings.itemTabs, m.tab, to);
    st.setSetting("sectionTabs", moved.sections);
    st.setSetting("itemTabs", moved.items);
  }
  const now = movedId(m, to);
  if (beside) writeSplitsAt(to.place, (g) => splitIn(g, beside, now, edge));
  if (to.place === "strip") {
    if (m.kind === "page") useStore.getState().showStripPage(now);
    else useStore.getState().showTerm(now);
  }
  return now;
}

/** every shell's id now, to tell the one opened after it */
export const termIds = (): ReadonlySet<string> => new Set(useStore.getState().terms.map((t) => t.id));
/** the shell opened since `before`, if one was */
export const openedSince = (before: ReadonlySet<string>): string | null => useStore.getState().terms.find((t) => !before.has(t.id))?.id ?? null;

/** how far a press on a tab or a pane's grip moves before it is a drag */
const DRAG_PX = 6;

/** a pane being dragged, and where it would land */
export interface PaneDrag {
  id: string;
  target: string | null;
  edge: Edge;
}

/** A shell window a drag can land in: its body, the panes in it, its own
 *  drop, and for a tab from another window, whether it takes it and how. */
interface Zone {
  body: RefObject<HTMLElement | null>;
  targets: Record<string, Box>;
  onDrop: (id: string, target: string, edge: Edge) => void;
  receive?: Receive;
  /** a tab lands here whole, as a tab of its own, never on an edge: the
   *  strip showing one tab at a time */
  whole: boolean;
}

/** what a shell window does with a tab dragged in from another (FR-031) */
export interface Receive {
  accepts: (id: string) => boolean;
  drop: (id: string, target: string, edge: Edge) => void;
}

/** every shell window on the page, so a drag from one finds the others */
const ZONES = new Set<{ current: Zone }>();

/** The innermost shell window under the point. elementFromPoint, so a
 *  window under an overlay or folded away is never hit. */
function zoneAt(x: number, y: number): { current: Zone } | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  let best: { current: Zone } | null = null;
  for (const z of ZONES) {
    const b = z.current.body.current;
    if (b?.contains(el) && (!best || best.current.body.current?.contains(b))) best = z;
  }
  return best;
}

/** the drag going on now, wherever it started, and the window it is over */
type Shared = (PaneDrag & { zone: { current: Zone } | null }) | null;
let shared: Shared = null;
const heard = new Set<() => void>();
const share = (next: Shared) => {
  shared = next;
  for (const f of heard) f();
};
const hear = (f: () => void) => {
  heard.add(f);
  return () => heard.delete(f);
};

/**
 * A press on a tab or a pane's grip: a click as before, or, once it moves
 * DRAG_PX, a drag that lands the pane on the edge of the pane under the
 * pointer (`targets`, parts of `body`). The pane under the pointer may be
 * in another shell window on the page, which lands it there through its
 * `receive` when it takes the tab (FR-031). A window that takes tabs
 * `whole` has no edges: a tab from elsewhere lands as a tab of its own, and
 * its own tabs do not split there. Escape or a release off every pane
 * leaves things as they were.
 */
export function usePaneDrag(
  body: RefObject<HTMLElement | null>,
  targets: Record<string, Box>,
  onDrop: (id: string, target: string, edge: Edge) => void,
  receive?: Receive,
  whole = false,
) {
  const [drag, setDrag] = useState<PaneDrag | null>(null);
  // read by the listeners, which outlive the render that set them up, and
  // by a drag from another window
  const live = useRef<Zone>({ body, targets, onDrop, receive, whole });
  live.current = { body, targets, onDrop, receive, whole };
  useEffect(() => {
    ZONES.add(live);
    return () => {
      ZONES.delete(live);
    };
  }, []);
  const over = useSyncExternalStore(hear, () => (shared?.zone === live ? shared : null));
  const grab = (id: string, e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest("button"))) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moving = false;
    let at: Shared = null;
    const move = (ev: globalThis.PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return;
      if (!moving) document.body.classList.add("ss-grabbing");
      moving = true;
      const zone = zoneAt(ev.clientX, ev.clientY);
      const own = zone === live;
      const z = zone && (own ? !zone.current.whole : zone.current.receive?.accepts(id)) ? zone : null;
      const r = z?.current.body.current?.getBoundingClientRect();
      const fx = r ? (ev.clientX - r.left) / r.width : -1;
      const fy = r ? (ev.clientY - r.top) / r.height : -1;
      const hit = z ? Object.entries(z.current.targets).find(([pid, b]) => (!own || pid !== id) && fx >= b.x && fx <= b.x + b.w && fy >= b.y && fy <= b.y + b.h) : undefined;
      at = { id, zone: hit ? z : null, target: hit?.[0] ?? null, edge: hit ? edgeAt((fx - hit[1].x) / hit[1].w, (fy - hit[1].y) / hit[1].h) : "right" };
      setDrag(at);
      share(at);
    };
    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc, true);
      document.body.classList.remove("ss-grabbing");
      setDrag(null);
      share(null);
      if (!moving) return;
      // the press was a drag, so the click it ends in is not a pick
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      const target = at?.target;
      if (!drop || !at || !target || !at.zone) return;
      if (at.zone === live) live.current.onDrop(id, target, at.edge);
      else at.zone.current.receive?.drop(id, target, at.edge);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const esc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc, true);
  };
  // the preview shows in the window the pane would land in, this one or not
  const box = over?.target ? targets[over.target] : undefined;
  const preview = over && box ? <div className="ss-drop" aria-hidden="true" style={boxStyle(whole ? box : dropBox(box, over.edge))} /> : null;
  return { drag, grab, preview };
}

/** the step a seam's arrow keys move it */
const SEAM_STEP = 0.05;

// Orca's pane icons (lucide's message-square-plus, square-split-vertical
// and x), drawn here since the page has no icon set.
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const HandoffIcon = () => (
  <Icon>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M12 7v6M9 10h6" />
  </Icon>
);
const SplitIcon = () => (
  <Icon>
    <path d="M5 8V5c0-1 1-2 2-2h10c1 0 2 1 2 2v3" />
    <path d="M19 16v3c0 1-1 2-2 2H7c-1 0-2-1-2-2v-3" />
    <path d="M4 12h16" />
  </Icon>
);
const CloseIcon = () => (
  <Icon>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

/**
 * A section tab's pane header (FR-030), shaped as a shell's: the grip, the
 * section's name, and at the right a split (a new shell beside it) and a
 * close that puts the section back in its card. A right-click opens the
 * tab's menu.
 */
export function SectionPaneHead({
  label,
  item = false,
  grouped,
  canSplit,
  onGrab,
  onSplit,
  onClose,
  onMenu,
}: {
  label: string;
  /** a chat's or a popup's, whose close only closes the tab */
  item?: boolean;
  grouped: boolean;
  /** a new shell can open beside it (a shell window has only its own) */
  canSplit: boolean;
  onGrab: (e: PointerEvent<HTMLElement>) => void;
  onSplit: () => void;
  onClose: () => void;
  onMenu: (at: DOMRect) => void;
}) {
  return (
    <div
      className="ss-pane-head"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.currentTarget.getBoundingClientRect());
      }}
    >
      {grouped && (
        <span className="ss-pane-grip" title="Drag onto another pane's edge to move it there" onPointerDown={onGrab}>
          ⠿
        </span>
      )}
      <span className="sec-tab-mark" aria-hidden="true">
        {item ? "◇" : "§"}
      </span>
      <span className="ss-pane-name">{label}</span>
      <span className="ss-pane-acts">
        {canSplit && (
          <button type="button" aria-label="Split right with a shell" title="Split right: a new shell beside it" onClick={onSplit}>
            <SplitIcon />
          </button>
        )}
        <button
          type="button"
          className="x"
          aria-label={item ? "Close the tab" : "Back to the card"}
          title={item ? "Close the tab; what it showed carries on" : "Back to the card: closes the tab, the section goes back in its card"}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </span>
    </div>
  );
}

/**
 * A pane's header: a grip to drag it onto another pane's edge (once there
 * is more than one), its name, and at the right Orca's three: hand the
 * agent's work to the other harness (the focused pane, while an agent runs
 * there), split right, and close. A right-click opens the tab's menu.
 */
export function PaneHead({
  tab,
  label,
  focused,
  grouped,
  onGrab,
  onSplit,
  onClose,
  onMenu,
  onHandedOff,
}: {
  tab: TermTab;
  label: string;
  focused: boolean;
  grouped: boolean;
  onGrab: (e: PointerEvent<HTMLElement>) => void;
  onSplit: () => void;
  onClose: () => void;
  onMenu: (at: DOMRect) => void;
  /** a hand-off started a new shell, which goes in beside this one; the
   *  shells there were before it */
  onHandedOff: (before: ReadonlySet<string>) => void;
}) {
  return (
    <div
      className="ss-pane-head"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.currentTarget.getBoundingClientRect());
      }}
    >
      {grouped && (
        <span className="ss-pane-grip" title="Drag onto another pane's edge to move it there" onPointerDown={onGrab}>
          ⠿
        </span>
      )}
      <span className={`dot ${tab.exit === undefined ? "moss" : "faint"}`} aria-hidden="true" />
      <span className="ss-pane-name" title={tab.path}>
        {label}
      </span>
      <span className="ss-pane-acts">
        {focused && tab.task === undefined && tab.exit === undefined && <PaneHandoff tab={tab} onHandedOff={onHandedOff} />}
        <button type="button" aria-label="Split terminal right" title="Split terminal right (Ctrl+Shift+D)" onClick={onSplit}>
          <SplitIcon />
        </button>
        <button type="button" className="x" aria-label={grouped ? "Close pane" : "Close tab"} title={`${grouped ? "Close pane" : "Close tab"}: ends the shell`} onClick={onClose}>
          <CloseIcon />
        </button>
      </span>
    </div>
  );
}

/** The hand-off button, there only while Claude Code or Codex runs in the
 *  pane: a new shell at the same repo and place with the other harness,
 *  told where this session's transcript is. */
function PaneHandoff({ tab, onHandedOff }: { tab: TermTab; onHandedOff: (before: ReadonlySet<string>) => void }) {
  const agent = useShellAgent(tab);
  const backend = backendOf(tab.id);
  const has = useStore((s) => harnessesOf(connOf(s, backend).backend));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const from = agent.harness;
  if (!from) return null;
  const to = otherHarness(from);
  const missing = !has.includes(to);
  const label = `Hand off to ${HARNESS[to].label}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={err ?? (missing ? `${HARNESS[to].label} is not installed on ${backend}` : `${label}: a new pane with ${HARNESS[to].label}, told where this session's transcript is`)}
      disabled={missing || busy}
      onClick={() => {
        const before = termIds();
        setBusy(true);
        setErr(null);
        handOff(tab.repoId, from, agent.transcript, tab.id, tab.place)
          .then(() => onHandedOff(before))
          .catch((e: unknown) => setErr(String(e instanceof Error ? e.message : e)))
          .finally(() => setBusy(false));
      }}
    >
      <HandoffIcon />
    </button>
  );
}

/**
 * The lines between a split tab's panes. A drag moves one (the tree is
 * redrawn live through `onDraft`, and saved once on release through
 * `onCommit`), a double-click puts it back to halves, and the arrow keys,
 * Home and End move it too.
 */
export function Seams({
  tree,
  body,
  onDraft,
  onCommit,
}: {
  tree: PaneTree;
  body: () => HTMLElement | null;
  onDraft: (tree: PaneTree | null) => void;
  onCommit: (path: string, at: number) => void;
}) {
  const [held, setHeld] = useState<string | null>(null);
  const seams = seamsOf(tree);
  const place = (s: Seam): CSSProperties => {
    const at = s.dir === "row" ? s.box.x + s.box.w * s.at : s.box.y + s.box.h * s.at;
    return s.dir === "row"
      ? { left: `${at * 100}%`, top: `${s.box.y * 100}%`, height: `${s.box.h * 100}%` }
      : { top: `${at * 100}%`, left: `${s.box.x * 100}%`, width: `${s.box.w * 100}%` };
  };
  const down = (s: Seam) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = body();
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setHeld(s.path);
    let at = s.at;
    const move = (ev: globalThis.PointerEvent) => {
      const r = el.getBoundingClientRect();
      at = s.dir === "row" ? atFrom(s, ev.clientX, r.left, r.width) : atFrom(s, ev.clientY, r.top, r.height);
      onDraft(setAt(tree, s.path, at));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setHeld(null);
      onDraft(null);
      if (at !== s.at) onCommit(s.path, at);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const key = (s: Seam) => (e: KeyboardEvent<HTMLDivElement>) => {
    const back = s.dir === "row" ? "ArrowLeft" : "ArrowUp";
    const on = s.dir === "row" ? "ArrowRight" : "ArrowDown";
    const at = e.key === back ? s.at - SEAM_STEP : e.key === on ? s.at + SEAM_STEP : e.key === "Home" ? 0 : e.key === "End" ? 1 : null;
    if (at === null) return;
    e.preventDefault();
    onCommit(s.path, at);
  };
  return (
    <>
      {seams.map((s) => (
        <div
          key={s.path || "top"}
          role="separator"
          tabIndex={0}
          aria-orientation={s.dir === "row" ? "vertical" : "horizontal"}
          aria-label={s.dir === "row" ? "Resize the panes side by side" : "Resize the panes above and below"}
          aria-valuenow={Math.round(s.at * 100)}
          aria-valuemin={10}
          aria-valuemax={90}
          title="Drag to resize; double-click for halves"
          className={`ss-seam ${s.dir}${held === s.path ? " on" : ""}`}
          style={place(s)}
          onPointerDown={down(s)}
          onDoubleClick={() => onCommit(s.path, 0.5)}
          onKeyDown={key(s)}
        />
      ))}
    </>
  );
}

/** A tab's menu: rename, a new shell beside it, split it right or down,
 *  take it out of its split, move it along the row, hide it (the shell runs
 *  on) or close it (the shell ends). The items a place has no use for
 *  (`onNew`, `onMove`) are left out. */
export function TabMenu({
  id,
  at,
  tabs,
  onClose,
  inRow,
  grouped,
  onRename,
  onNew,
  onMove,
  onSplit,
  onLeave,
  pages = NO_PAGES,
  onUntab,
  sectionsFor,
  onAddSection,
  moveOut,
}: {
  id: string;
  at: DOMRect;
  tabs: readonly TermTab[];
  /** the tab has a place of its own in the row, where a rename is typed */
  inRow: boolean;
  /** the tab is a pane of a split tab */
  grouped: boolean;
  onClose: () => void;
  onRename: (id: string) => void;
  onNew?: (repoId: string) => void;
  onMove?: (id: string, by: 1 | -1) => void;
  onSplit: (id: string, edge: Edge) => void;
  onLeave: (id: string) => void;
  /** the section, chat and popup tabs in the row (FR-030), whose menu is
   *  their own */
  pages?: readonly PageTab[];
  /** a page tab closed, a section back in its card */
  onUntab?: (id: string) => void;
  /** the sections a shell's repo can add as a tab here, and the add: a
   *  tab of its own, or with `edge`, split in beside the shell on it */
  sectionsFor?: (repoId: string) => SectionKey[];
  onAddSection?: (repoId: string, key: SectionKey, edge?: Edge) => void;
  /** the tab into another shell window on the page, when one takes it
   *  (FR-031): the strip from a card, a card from the strip */
  moveOut?: { label: string; run: (id: string) => void };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  // read by the listeners below, set up once
  const close = useRef(onClose);
  close.current = onClose;
  const hideTerm = useStore((s) => s.hideTerm);
  const closeTerm = useStore((s) => s.closeTerm);
  const tab = tabs.find((t) => t.id === id);
  const page = pages.find((t) => t.id === id);
  const i = tabs.findIndex((t) => t.id === id);
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
    const down = (e: globalThis.PointerEvent) => {
      if (!(e.target instanceof Node) || !box.current?.contains(e.target)) close.current();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  const act = (f: () => void) => () => {
    onClose();
    f();
  };
  // under the tab, kept 8px inside the window by the menu's measured size,
  // so a long submenu on a low tab moves up instead of running off the
  // bottom; measured again when the submenu opens or closes
  const [spot, setSpot] = useState(() => ({ top: at.bottom + 2, left: at.left }));
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(at.left, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(at.bottom + 2, window.innerHeight - r.height - 8));
    setSpot((s) => (s.top === top && s.left === left ? s : { top, left }));
  }, [at, adding]);
  const { top, left } = spot;
  if (page)
    return (
      <div ref={box} className="ss-tabmenu" role="menu" aria-label={`The ${isItemTab(page) ? page.label : SECTION_WORD[page.key]} tab`} style={{ top, left }}>
        <button type="button" role="menuitem" title="A shell beside it, on its right" onClick={act(() => onSplit(id, "right"))}>
          split right
        </button>
        <button type="button" role="menuitem" title="A shell beside it, below" onClick={act(() => onSplit(id, "bottom"))}>
          split down
        </button>
        {grouped && (
          <button type="button" role="menuitem" title="Its own tab again" onClick={act(() => onLeave(id))}>
            out of the split
          </button>
        )}
        {moveOut && (
          <button type="button" role="menuitem" title="Into that shell window, as a tab of its own; drag the tab onto a pane there to split instead" onClick={act(() => moveOut.run(id))}>
            move {moveOut.label}
          </button>
        )}
        {onUntab &&
          (isItemTab(page) ? (
            <>
              {!dockless() && (
                <button
                  type="button"
                  role="menuitem"
                  title="Out of the tab into a panel of its own in the dock, on the git view (FR-047)"
                  onClick={act(() => {
                    useStore.getState().dockItem(page);
                    openView("git");
                  })}
                >
                  a card in the dock
                </button>
              )}
              <button type="button" role="menuitem" title="Closes the tab; what it showed carries on" onClick={act(() => onUntab(id))}>
                close the tab
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" title="Closes the tab and puts the section back in its card" onClick={act(() => onUntab(id))}>
              back to the card
            </button>
          ))}
      </div>
    );
  if (!tab) return null;
  const addable = sectionsFor && onAddSection && tab.task === undefined ? sectionsFor(tab.repoId) : [];
  return (
    <div ref={box} className="ss-tabmenu" role="menu" aria-label={`The tab at ${tab.label ?? tab.name}`} style={{ top, left }}>
      <button type="button" role="menuitem" disabled={!inRow} onClick={act(() => onRename(id))}>
        rename <span className="ss-faint">F2</span>
      </button>
      {onNew && (
        <button type="button" role="menuitem" onClick={act(() => onNew(tab.repoId))}>
          new tab at {tab.name}…
        </button>
      )}
      <button type="button" role="menuitem" onClick={act(() => onSplit(id, "right"))}>
        split right <span className="ss-faint">^⇧D</span>
      </button>
      <button type="button" role="menuitem" onClick={act(() => onSplit(id, "bottom"))}>
        split down <span className="ss-faint">⌥⇧D</span>
      </button>
      {grouped && (
        <button type="button" role="menuitem" title="Its own tab again; the shell keeps running" onClick={act(() => onLeave(id))}>
          out of the split
        </button>
      )}
      {addable.length > 0 && (
        <button type="button" role="menuitem" aria-expanded={adding} title={`Moves a section out of ${tab.name}'s card into a tab here`} onClick={() => setAdding(!adding)}>
          a section as a tab {adding ? "▾" : "▸"}
        </button>
      )}
      {adding && (
        <div className="ss-tabmenu-sub">
          {addable.map((k) => (
            <div key={k} className="ss-tabmenu-row">
              <button type="button" role="menuitem" title={`${SECTION_WORD[k]} as a tab of its own`} onClick={act(() => onAddSection?.(tab.repoId, k))}>
                {SECTION_WORD[k]}
              </button>
              <button
                type="button"
                role="menuitem"
                className="ss-tabmenu-edge"
                aria-label={`${SECTION_WORD[k]} split right`}
                title={`Split right: ${SECTION_WORD[k]} beside this shell, on its right`}
                onClick={act(() => onAddSection?.(tab.repoId, k, "right"))}
              >
                →
              </button>
              <button
                type="button"
                role="menuitem"
                className="ss-tabmenu-edge"
                aria-label={`${SECTION_WORD[k]} split down`}
                title={`Split down: ${SECTION_WORD[k]} beside this shell, below`}
                onClick={act(() => onAddSection?.(tab.repoId, k, "bottom"))}
              >
                ↓
              </button>
            </div>
          ))}
        </div>
      )}
      {moveOut && (
        <button type="button" role="menuitem" title="Into that shell window, as a tab of its own; drag the tab onto a pane there to split instead" onClick={act(() => moveOut.run(id))}>
          move {moveOut.label}
        </button>
      )}
      {onMove && (
        <>
          <button type="button" role="menuitem" disabled={i <= 0} onClick={act(() => onMove(id, -1))}>
            move left
          </button>
          <button type="button" role="menuitem" disabled={i < 0 || i >= tabs.length - 1} onClick={act(() => onMove(id, 1))}>
            move right
          </button>
        </>
      )}
      <button type="button" role="menuitem" title="Takes the tab away here and leaves the shell running" onClick={act(() => hideTerm(id))}>
        hide, keep running
      </button>
      <button type="button" role="menuitem" className="t-rust" title="Ends the shell on every device" onClick={act(() => closeTerm(id))}>
        close and end the shell
      </button>
    </div>
  );
}
