import { useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { HARNESS } from "../../../src/core/harness";
import { harnessesOf } from "../agents";
import { otherHarness } from "../handoff";
import { backendOf } from "../registry";
import { atFrom, setAt, seamsOf, type Box, type PaneTree, type Seam } from "../splitpanes";
import { connOf, useStore } from "../store";
import type { TermTab } from "../term";
import { useShellAgent } from "./AgentButtons";
import { handOff } from "./Handoff";

/** a part of the main pane as an inline style, in percent */
export const boxStyle = (b: Box): CSSProperties => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

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
  /** a hand-off started a new shell, which goes in beside this one */
  onHandedOff: (before: string | null) => void;
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
 *  pane: a new shell at the same repo with the other harness, told where
 *  this session's transcript is. */
function PaneHandoff({ tab, onHandedOff }: { tab: TermTab; onHandedOff: (before: string | null) => void }) {
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
        const before = useStore.getState().activeTerm;
        setBusy(true);
        setErr(null);
        handOff(tab.repoId, from, agent.transcript, tab.id, "strip")
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
