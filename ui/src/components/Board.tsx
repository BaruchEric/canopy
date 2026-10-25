import { agentName, madeWord, RUN_CARD } from "../allagents";
import { lastWords } from "../waiting";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { isLiveAgent, type AgentCard, type Run } from "../../../src/core/types";
import { cardName, clockWord, durationWord, machineOf, registrySummary, timelineOf, whereWord, type Timeline, type TrailMark } from "../agentcards";
import { agentPanel } from "../agentpanel";
import {
  BOARD_GROUPINGS,
  BOARD_LAYOUTS,
  LAYOUT_TITLE,
  LAYOUT_WORD,
  TYPING_HOLD,
  boardCards,
  boardGroups,
  boardKey,
  focusOf,
  followTarget,
  hasFocusSlot,
  keepShell,
  laneSegs,
  nextWaiting,
  nthCard,
  focusAwayAfter,
  planBoard,
  recommendBoard,
  sinceOf,
  startedWaiting,
  stepLayout,
  type BoardGrouping,
  type BoardLayout,
  type Furn,
  type Slot,
} from "../board";
import { cssId } from "../grid";
import { PHONE, useMedia } from "../media";
import { FOCUS_PANE, PANES_CHANNEL, parsePaneMsg, type PaneMsg } from "../panes";
import { popOutFocus } from "../routes";
import { screenNow } from "../screens";
import { useStore } from "../store";
import { OVER_PAGE } from "../surface";
import { AgentScreen, AskHere, QuickAnswer, useAllAgents, useShellProbe } from "./AgentFocus";
import { AgentActions, Summary, glyphOf, harnessWord, useIsChat, useNow } from "./Registry";
import { Seg } from "./Seg";
import { SweepButton } from "./Sweep";

const LAYOUT_OPTIONS = BOARD_LAYOUTS.map((l) => ({ value: l, label: LAYOUT_WORD[l], title: LAYOUT_TITLE[l] }));

const GROUPING_WORD: Record<BoardGrouping, string> = { none: "no groups", machine: "by machine", repo: "by repo" };
const GROUPING_OPTIONS = BOARD_GROUPINGS.map((g) => ({ value: g, label: GROUPING_WORD[g], title: g === "none" ? "One board: the sessions first, then the runs at work, each in order of need" : `Grouped ${GROUPING_WORD[g]}` }));

const ORIGIN_WORD: Record<AgentCard["origin"], string> = {
  "canopy-shell": "canopy shell",
  "canopy-run": "canopy run",
  elsewhere: "elsewhere",
  scan: "found by a scan",
};

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A change that moves tiles, through a view transition where the browser
 *  has one: each tile carries its own transition name, so it slides from
 *  where it was to where it lands rather than jumping. */
function moveTiles(change: () => void) {
  if (typeof document.startViewTransition !== "function" || reducedMotion()) {
    change();
    return;
  }
  document.startViewTransition(() => flushSync(change));
}

/** a tile's view transition name, unique and a valid ident whatever the id */
const tileName = (id: string): string => `bt-${cssId(id)}`;

/** the board's box, kept as it resizes */
function useBox(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [box, setBox] = useState({ width: 1200, height: 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/**
 * The board's focus in a window of its own: the window says hello when it
 * shows, and from then the board tells it every change of focus; the
 * board's rail takes the whole board meanwhile. The window can ask the
 * board to focus another agent, and the board can take its focus back.
 */
function useFocusWindow(focus: string | null) {
  const [away, setAway] = useState(false);
  const chan = useRef<BroadcastChannel | null>(null);
  const handle = useRef<Window | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const show = (c: BroadcastChannel | null) => c?.postMessage({ type: "show", id: FOCUS_PANE, card: focusRef.current } satisfies PaneMsg);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const c = new BroadcastChannel(PANES_CHANNEL);
    chan.current = c;
    c.onmessage = (e: MessageEvent) => {
      const m = parsePaneMsg(e.data);
      setAway((was) => focusAwayAfter(was, m, FOCUS_PANE));
      // a pane that just showed learns what to show
      if (m?.type === "hello" && m.id === FOCUS_PANE) show(c);
    };
    // a pane already open from before this board loaded says hello again
    c.postMessage({ type: "who" } satisfies PaneMsg);
    return () => {
      c.close();
      chan.current = null;
    };
  }, []);
  useEffect(() => {
    if (away) show(chan.current);
  }, [focus, away]);
  // the focus leaves the board only on the window's hello, so one closed
  // before it loaded (or blocked) never takes it
  return {
    away,
    can: typeof BroadcastChannel !== "undefined",
    open: () => {
      handle.current = popOutFocus(focusRef.current);
    },
    back: () => {
      chan.current?.postMessage({ type: "return", id: FOCUS_PANE } satisfies PaneMsg);
      handle.current?.close();
      handle.current = null;
      setAway(false);
    },
  };
}

/** whether a key went to something that types: a field or a shell */
const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".xterm") !== null);

/**
 * The agents view's board: every agent the page knows (the registry's, and
 * canopy's own runs, chats and agents in its shells), as tiles over
 * one grid that six layouts re-lay (board.ts plans them). Tiles stay in
 * the DOM in id order and move only by `grid-area`, so a live shell inside
 * one survives a change of layout or focus. Keys: `w` the next agent
 * waiting, 1 to 9 an agent by place, `[` and `]` the layouts. Follow mode
 * takes the focus to an agent the moment it starts waiting.
 */
export function BoardTab({ onGit }: { onGit?: () => void }) {
  useShellProbe();
  const all = useAllAgents();
  const registry = useMemo(() => Object.fromEntries(all.map((c) => [c.id, c])), [all]);
  const trail = useStore((s) => s.registryTrail);
  const saved = useStore((s) => s.settings.agentsLayout);
  const grouping = useStore((s) => s.settings.agentsGrouping);
  const follow = useStore((s) => s.settings.agentsFollow);
  const setSetting = useStore((s) => s.setSetting);
  const scr = screenNow();
  const layout: BoardLayout = saved ?? (scr ? recommendBoard(scr.w, scr.h) : "wall");
  const now = useNow(15_000);
  const chat = useIsChat();
  const cards = useMemo(() => boardCards(all, now), [all, now]);
  const groups = useMemo(() => boardGroups(cards, grouping, trail, chat), [cards, grouping, trail, chat]);
  const order = useMemo(() => groups.flatMap((g) => g.cards), [groups]);
  const timeline = useMemo(() => timelineOf(cards, now), [cards, now]);
  const [picked, setPicked] = useState<string | null>(null);
  const focus = focusOf(order, picked);
  const narrow = useMedia(PHONE);
  const [focusOpen, setFocusOpen] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const box = useBox(stage);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const setLayout = useCallback((l: BoardLayout) => moveTiles(() => setSetting("agentsLayout", l)), [setSetting]);
  /** focus an agent; `open` also takes a layout with no place for one to
   *  the rail, and opens it on a phone */
  const pick = useCallback(
    (id: string, open = true) =>
      moveTiles(() => {
        setPicked(id);
        if (!open) return;
        if (narrowRef.current) setFocusOpen(true);
        if (!hasFocusSlot(layoutRef.current)) setSetting("agentsLayout", "rail");
      }),
    [setSetting],
  );
  const win = useFocusWindow(focus);
  const plan = useMemo(
    () => planBoard(layout, groups, { focus, width: box.width, narrow, focusOpen, focusAway: win.away }),
    [layout, groups, focus, box.width, narrow, focusOpen, win.away],
  );
  const slots = useMemo(() => new Map(plan.slots.map((s) => [s.id, s])), [plan]);
  // the shell showing live, and the last few kept joined behind it
  const liveFocus = hasFocusSlot(layout) && !win.away && (!narrow || focusOpen) ? focus : null;
  const [kept, setKept] = useState<string[]>([]);
  useEffect(() => {
    if (liveFocus) setKept((k) => keepShell(k, liveFocus));
  }, [liveFocus]);

  // the focus brought into sight when it moves where the board scrolls
  useEffect(() => {
    if (!focus) return;
    const el = stage.current?.querySelector(`[data-card="${CSS.escape(focus)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [focus, layout]);

  // keys, read through refs so the listener is set once
  const orderRef = useRef(order);
  orderRef.current = order;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const focusOpenRef = useRef(focusOpen);
  focusOpenRef.current = focusOpen;
  const lastKey = useRef(0);
  useEffect(() => {
    // every key counts toward follow mode's hold, a shell's too
    const stamp = () => {
      lastKey.current = Date.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(OVER_PAGE)) return;
      if (e.key === "Escape" && narrowRef.current && focusOpenRef.current && !typing(e.target)) {
        setFocusOpen(false);
        return;
      }
      const k = boardKey(e, typing(e.target));
      if (k === null) return;
      e.preventDefault();
      if (k === "next") {
        const id = nextWaiting(orderRef.current, focusRef.current);
        if (id) pick(id, hasFocusSlot(layoutRef.current));
      } else if (k === "prev-layout" || k === "next-layout") setLayout(stepLayout(layoutRef.current, k === "next-layout" ? 1 : -1));
      else {
        const id = nthCard(orderRef.current, k);
        if (id) pick(id, hasFocusSlot(layoutRef.current));
      }
    };
    document.addEventListener("keydown", stamp, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", stamp, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pick, setLayout]);

  // follow mode: the agents that started waiting since the last registry,
  // taken to in turn once no key has gone down for a moment
  const before = useRef(registry);
  const pending = useRef<string[]>([]);
  const registryRef = useRef(registry);
  registryRef.current = registry;
  useEffect(() => {
    const started = startedWaiting(before.current, registry);
    before.current = registry;
    if (!follow) {
      pending.current = [];
      return;
    }
    pending.current = [...started, ...pending.current.filter((id) => !started.includes(id))];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryFollow = () => {
      if (!pending.current.length) return;
      const id = followTarget(pending.current, registryRef.current, lastKey.current, Date.now());
      if (id) {
        pending.current = [];
        pick(id, false);
      } else if (pending.current.some((p) => registryRef.current[p]?.state === "waiting")) timer = setTimeout(tryFollow, TYPING_HOLD);
      else pending.current = [];
    };
    tryFollow();
    return () => clearTimeout(timer);
  }, [registry, follow, pick]);

  const stageStyle = { gridTemplateColumns: plan.columns, gridTemplateRows: plan.rows, "--stage-h": `${box.height}px` } as CSSProperties;
  const ids = useMemo(() => [...cards].sort((a, b) => a.id.localeCompare(b.id)), [cards]);
  const place = useMemo(() => new Map(order.map((c, i) => [c.id, i + 1])), [order]);
  const waitingCount = order.filter((c) => c.state === "waiting").length;

  return (
    <div className={`board bl-${layout}${narrow ? " narrow" : ""}`}>
      <div className="board-bar">
        <Seg label="Board layout" value={layout} options={LAYOUT_OPTIONS} onChange={setLayout} className="board-layouts" />
        <Seg label="Group the board" value={grouping} options={GROUPING_OPTIONS} onChange={(g) => moveTiles(() => setSetting("agentsGrouping", g))} />
        <span className="spacer" />
        <SweepButton />
        <button
          type="button"
          className="mini"
          disabled={waitingCount === 0}
          title="Focus the next agent waiting on you, a session's before a run's, the longest wait first (w)"
          onClick={() => {
            const id = nextWaiting(order, focus);
            if (id) pick(id, hasFocusSlot(layout));
          }}
        >
          next waiting <kbd>w</kbd>
        </button>
        <button
          type="button"
          className={follow ? "mini board-on" : "mini"}
          aria-pressed={follow}
          title="Move the focus to an agent the moment it starts waiting; it holds off while you type"
          onClick={() => setSetting("agentsFollow", !follow)}
        >
          follow
        </button>
        {win.can && hasFocusSlot(layout) && !narrow && (
          <button
            type="button"
            className="mini"
            title={win.away ? "Show the focus on the board again and close its window" : "Show the agent in focus in a window of its own, for a second screen; the rail stays here"}
            onClick={win.away ? win.back : win.open}
          >
            {win.away ? "focus back here" : "focus in a window ↗"}
          </button>
        )}
      </div>
      {cards.length === 0 ? (
        <p className="settings-hint">No agent is running on any machine the broker hears from, and none stopped in the last two hours.</p>
      ) : (
        <div ref={stage} className="board-stage" style={stageStyle}>
          {ids.map((c) => {
            const slot = slots.get(c.id);
            if (!slot) return null;
            return (
              <BoardTile
                key={c.id}
                card={c}
                slot={slot}
                n={place.get(c.id) ?? 0}
                focused={c.id === focus}
                live={c.id === liveFocus}
                keep={kept.includes(c.id)}
                since={sinceOf(c, trail[c.id])}
                marks={trail[c.id]}
                timeline={timeline}
                now={now}
                narrow={narrow}
                onPick={pick}
                onBack={() => setFocusOpen(false)}
                onSwipe={(by) => {
                  const i = order.findIndex((o) => o.id === c.id);
                  const next = order[(i + by + order.length) % order.length];
                  if (next) pick(next.id);
                }}
                onGit={onGit}
              />
            );
          })}
          {plan.furn.map((f) => (
            <BoardFurn key={f.key} f={f} cards={all} timeline={timeline} now={now} />
          ))}
        </div>
      )}
      <p className="board-keys">
        <kbd>w</kbd> next waiting · <kbd>1</kbd>–<kbd>9</kbd> an agent by place · <kbd>[</kbd> <kbd>]</kbd> layouts · click into a shell to type in it
      </p>
    </div>
  );
}

/** what a row says under its name: the wait, else how and where it runs */
function lastLine(c: AgentCard, run: Run | undefined): string {
  if (c.state === "waiting") return `waits on: ${c.waiting ?? "your turn"}`;
  const made = madeWord(c, run);
  if (made) return [made, run ? lastWords(run) : null].filter(Boolean).join(" · ");
  return [ORIGIN_WORD[c.origin], whereWord(c), c.model].filter(Boolean).join(" · ");
}

function BoardTile({
  card,
  slot,
  n,
  focused,
  live,
  keep,
  since,
  marks,
  timeline,
  now,
  narrow,
  onPick,
  onBack,
  onSwipe,
  onGit,
}: {
  card: AgentCard;
  slot: Slot;
  /** its place in the board's order, what 1 to 9 press */
  n: number;
  focused: boolean;
  /** its live shell shows */
  live: boolean;
  /** its shell stays joined, hidden when not showing */
  keep: boolean;
  since: number;
  marks: readonly TrailMark[] | undefined;
  timeline: Timeline;
  now: number;
  narrow: boolean;
  onPick: (id: string, open?: boolean) => void;
  onBack: () => void;
  onSwipe: (by: 1 | -1) => void;
  onGit?: () => void;
}) {
  const term = slot.mode === "term";
  const swipe = useRef<number | null>(null);
  const name = agentName(card);
  const run = useStore((s) => (card.id.startsWith(RUN_CARD) ? s.runs[card.id.slice(RUN_CARD.length)] : undefined));
  // a click anywhere on a tile focuses it, but not one meant for a control
  // or for the live shell inside it
  const click = (e: MouseEvent<HTMLElement>) => {
    if (e.target instanceof Element && e.target.closest("button, a, input, select, textarea, summary, .xterm, .inbox-list")) return;
    if (!(term && focused)) onPick(card.id);
  };
  const toDock = () => {
    useStore.getState().openPanel(agentPanel(card.id));
    onGit?.();
  };
  const swipeHead = narrow && term && focused;
  return (
    <article
      className={`bt bt-${slot.mode}${focused ? " focused" : ""}${isLiveAgent(card) ? "" : " gone"}`}
      data-state={card.state}
      data-card={card.id}
      hidden={slot.mode === "hidden"}
      style={{ gridArea: slot.area, viewTransitionName: slot.mode === "hidden" ? "none" : tileName(card.id) }}
      onClick={click}
      aria-label={`${name}, ${card.state}`}
    >
      <header
        className="bt-head"
        onPointerDown={swipeHead ? (e: PointerEvent) => (swipe.current = e.clientX) : undefined}
        onPointerUp={
          swipeHead
            ? (e: PointerEvent) => {
                const from = swipe.current;
                swipe.current = null;
                if (from !== null && Math.abs(e.clientX - from) > 60) onSwipe(e.clientX < from ? 1 : -1);
              }
            : undefined
        }
      >
        {narrow && term && focused && (
          <button type="button" className="mini bt-back" onClick={onBack} aria-label="Back to every agent">
            ‹
          </button>
        )}
        {n > 0 && n <= 9 && slot.mode !== "lane" && (
          <kbd className="bt-n" title={`Press ${n} to focus it`}>
            {n}
          </kbd>
        )}
        <span className="bt-dot" aria-hidden="true" />
        <span className={`harness-glyph h-${card.harness}`} title={harnessWord(card)}>
          {glyphOf(card)}
        </span>
        <button type="button" className="bt-name" title={`${cardName(card)} · ${card.cwd}`} onClick={() => onPick(card.id)}>
          {name}
        </button>
        {card.branch && slot.mode !== "chip" && slot.mode !== "lane" && <span className="bt-branch">{card.branch}</span>}
        <span className="bt-machine">{machineOf(card)}</span>
        {/* a lane's bar and dot say the state; its label has room for the name */}
        {slot.mode !== "lane" && <span className={`bt-state rs-${card.state}`}>{card.state}</span>}
        {slot.mode !== "chip" && slot.mode !== "lane" && (
          <span className="bt-age" title={`${card.state} since ${new Date(since).toLocaleTimeString()}`}>
            {durationWord(Math.max(0, now - since))}
          </span>
        )}
        {term && (
          <span className="bt-tools">
            {focused && <AgentActions card={card} onGit={onGit} />}
            <button type="button" className="mini" title="Open this agent as a dock panel of its own, to drag, split and size with the rest" onClick={toDock}>
              dock
            </button>
            <button
              type="button"
              className="mini"
              title="Put this agent in a tab in the shells strip and the sessions view, beside the shells (FR-030)"
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().tabItem("strip", { kind: "agent", ref: card.id, label: name });
              }}
            >
              tab
            </button>
          </span>
        )}
      </header>
      {slot.mode === "row" && <div className="bt-last">{lastLine(card, run)}</div>}
      {slot.acts && card.state === "waiting" && slot.mode !== "chip" && <QuickAnswer card={card} />}
      {slot.mode === "lane" && <LaneBar card={card} marks={marks} timeline={timeline} now={now} />}
      {(term || keep) && (
        <div className="bt-body" hidden={!term}>
          {term && focused && <AskHere card={card} onGit={onGit} />}
          <AgentScreen card={card} live={keep || live} active={live} showing={term} now={now} />
        </div>
      )}
    </article>
  );
}

/** a lane: the card's states on the day's clock, as the page saw them */
function LaneBar({ card, marks, timeline, now }: { card: AgentCard; marks: readonly TrailMark[] | undefined; timeline: Timeline; now: number }) {
  const span = Math.max(1, timeline.to - timeline.from);
  const segs = laneSegs(card, marks, timeline.from, now);
  return (
    <div className="bt-bar" aria-label={`${segs.length} stretch${segs.length === 1 ? "" : "es"} since ${clockWord(timeline.from)}`}>
      {segs.map((s, i) => (
        <span
          key={i}
          className={`lane-seg ls-${s.state}`}
          style={{ left: `${((s.from - timeline.from) / span) * 100}%`, width: `${Math.max(0.3, ((s.to - s.from) / span) * 100)}%` }}
          title={`${s.state === "seen" ? "running" : s.state}, ${clockWord(s.from)} to ${clockWord(s.to)}`}
        />
      ))}
    </div>
  );
}

function BoardFurn({ f, cards, timeline, now }: { f: Furn; cards: readonly AgentCard[]; timeline: Timeline; now: number }) {
  const style = { gridArea: f.area };
  if (f.kind === "summary") {
    return (
      <div className="bf-summary" style={style}>
        <Summary s={registrySummary(cards, now)} now={now} />
      </div>
    );
  }
  if (f.kind === "axis") {
    const span = Math.max(1, timeline.to - timeline.from);
    return (
      <div className="bf-axis" style={style} aria-hidden="true">
        {/* a tick too near the right edge would sit under "now" */}
        {timeline.ticks.filter((t) => (timeline.to - t.at) / span > 0.06).map((t) => (
          <span key={t.at} style={{ left: `${((t.at - timeline.from) / span) * 100}%` }}>
            {t.label}
          </span>
        ))}
        <span className="bf-now">now</span>
      </div>
    );
  }
  return (
    <div className={f.kind === "group" ? "bf-group" : `bf-head tone-${f.tone ?? "none"}`} style={style}>
      <b>{f.label}</b> <span className="bf-count">{f.count}</span>
    </div>
  );
}
