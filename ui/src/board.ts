/**
 * The agents board (the agents view's "board" tab): every agent the
 * registry holds, laid out one of six ways over the same tiles. A layout is
 * a CSS grid plan plus a slot per card, its grid area and what its tile
 * shows there, so a change of layout or of focus moves a tile by
 * `grid-area` and never remounts it; a live shell inside a tile survives
 * every move, the rule the dock keeps for its panels. Also the board's
 * order, its keys, follow mode, the quick answers a row offers and the
 * lanes' state segments. Pure; tested in board.test.ts.
 */

import type { PaneMsg } from "./panes";
import { BOARD_LAYOUTS, isLiveAgent, type Ask, type AgentCard, type AgentState, type BoardLayout } from "../../src/core/types";
import { groupCards, runEnd, tierOf, type IsChat, type TrailMark } from "./agentcards";
import type { InboxAnswer } from "./inbox";
import { recommendLayout } from "../../src/core/screenlayouts";

export { BOARD_LAYOUTS, type BoardLayout };

export const LAYOUT_WORD: Record<BoardLayout, string> = {
  rail: "rail and focus",
  wall: "wall",
  spotlight: "spotlight",
  dashboard: "dashboard",
  triage: "triage board",
  lanes: "lanes",
};

export const LAYOUT_TITLE: Record<BoardLayout, string> = {
  rail: "Every agent as a row; the one you pick fills the rest with its live shell or its transcript",
  wall: "Every agent as an equal tile, its shell's screen as it stands",
  spotlight: "The agent in focus large and live, the next few in the board's order beside it, the rest small",
  dashboard: "The summary, the asks waiting on you, the agents at work and the rest as chips",
  triage: "A column per state; agents move between them as their state changes",
  lanes: "The day's agents on the clock, coloured by the states this page saw",
};

/** the layouts with a place for one agent, large and live */
export const hasFocusSlot = (l: BoardLayout): boolean => l === "rail" || l === "spotlight";

export const BOARD_GROUPINGS = ["none", "machine", "repo"] as const;
export type BoardGrouping = (typeof BOARD_GROUPINGS)[number];

/** What a tile shows in its slot: the agent's screen or transcript (term),
 *  one row of facts (row), its name alone (chip), a lane on the clock
 *  (lane), or nothing at all (hidden, a phone showing one agent). */
export type TileMode = "term" | "row" | "chip" | "lane" | "hidden";

export interface Slot {
  id: string;
  area: string;
  mode: TileMode;
  /** the row offers answers to the agent's ask */
  acts: boolean;
}

/** what a layout places beside the tiles */
export type FurnKind = "summary" | "head" | "group" | "axis";

export interface Furn {
  key: string;
  kind: FurnKind;
  area: string;
  label: string;
  count: number;
  /** the state a head counts, for its colour */
  tone: AgentState | "done" | null;
}

export interface BoardPlan {
  columns: string;
  rows: string;
  slots: Slot[];
  furn: Furn[];
}

export interface BoardGroup {
  /** "" when the board is not grouped */
  key: string;
  label: string;
  cards: AgentCard[];
}

const RANK: Record<AgentState, number> = { waiting: 0, working: 1, idle: 2, lost: 3, ended: 4 };
const HOUR = 3_600_000;

/** How long a stopped agent stays on the board. */
export const RECENT_MS = 2 * HOUR;

/** Since when a card has been in its state: the page's own mark for it,
 *  else its end (ended), its last beat (lost) or its start. */
export function sinceOf(c: AgentCard, marks: readonly TrailMark[] | undefined): number {
  const last = marks?.[marks.length - 1];
  if (last && last.state === c.state) return last.at;
  if (c.state === "ended") return c.endedAt ?? c.seenAt;
  if (c.state === "lost") return c.seenAt;
  return c.startedAt;
}

/** The board's order: the running sessions first (canopy shells, hooked
 *  terminals, chats), then the runs at work or waiting, then the rest
 *  (`tierOf`). In each, waiting first, the longest wait first since it is
 *  the one to answer next, then working, idle, lost and ended, the longest
 *  in its state first in each. */
export function boardOrder(cards: readonly AgentCard[], trail: Record<string, TrailMark[]>, chat?: IsChat): AgentCard[] {
  return [...cards].sort(
    (a, b) =>
      tierOf(a, chat) - tierOf(b, chat) ||
      RANK[a.state] - RANK[b.state] ||
      sinceOf(a, trail[a.id]) - sinceOf(b, trail[b.id]) ||
      a.id.localeCompare(b.id),
  );
}

/** Every running card, and the ones that stopped within `recent`. */
export function boardCards(cards: readonly AgentCard[], now: number, recent = RECENT_MS): AgentCard[] {
  return cards.filter((c) => isLiveAgent(c) || runEnd(c, now) >= now - recent);
}

/** The board's cards in groups, each in the board's order: one group with
 *  no name when the board is not grouped, else by machine or repo with the
 *  busier groups first, as the registry tab groups them. */
export function boardGroups(cards: readonly AgentCard[], by: BoardGrouping, trail: Record<string, TrailMark[]>, chat?: IsChat): BoardGroup[] {
  if (by === "none") return cards.length ? [{ key: "", label: "", cards: boardOrder(cards, trail, chat) }] : [];
  return groupCards(cards, by, chat).map((g) => ({ key: g.key || "none", label: g.label, cards: boardOrder(g.cards, trail, chat) }));
}

/** the agent in focus: the one picked while it is on the board, else the
 *  first in the board's order */
export function focusOf(order: readonly AgentCard[], picked: string | null): string | null {
  if (picked && order.some((c) => c.id === picked)) return picked;
  return order[0]?.id ?? null;
}

export interface PlanOptions {
  focus: string | null;
  /** the board's width, CSS px, for the wall's columns */
  width: number;
  /** a phone's width: one column everywhere */
  narrow: boolean;
  /** on a phone, the agent in focus fills the board */
  focusOpen: boolean;
  /** the focus is in a window of its own, so the rail takes the board */
  focusAway: boolean;
}

/**
 * A track as tall as what is in it. Plain auto would do on its own, but a
 * tile clips (overflow hidden, so its automatic minimum is 0), and beside a
 * 1fr track the fr row takes the whole stage before auto rows grow: rows
 * collapsed to hairlines. max-content sizes them from their content.
 */
const FIT = "max-content";

const area = (r: number, c: number, r2 = r + 1, c2 = c + 1): string => `${r} / ${c} / ${r2} / ${c2}`;

const groupFurn = (g: BoardGroup, r: number, c2: number): Furn => ({
  key: `g:${g.key}`,
  kind: "group",
  area: area(r, 1, r + 1, c2),
  label: g.label,
  count: g.cards.length,
  tone: null,
});

/** the states each triage column holds */
export const TRIAGE: readonly { key: string; label: string; states: readonly AgentState[]; tone: AgentState | "done" }[] = [
  { key: "waiting", label: "waiting on you", states: ["waiting"], tone: "waiting" },
  { key: "working", label: "working", states: ["working"], tone: "working" },
  { key: "idle", label: "idle", states: ["idle"], tone: "idle" },
  { key: "done", label: "ended and lost", states: ["ended", "lost"], tone: "done" },
];

/** The board as a grid for `layout`: its tracks and where each card and
 *  each heading goes. */
export function planBoard(layout: BoardLayout, groups: readonly BoardGroup[], o: PlanOptions): BoardPlan {
  const order = groups.flatMap((g) => g.cards);
  const grouped = groups.some((g) => g.key !== "");
  if (order.length === 0) return { columns: "minmax(0, 1fr)", rows: "1fr", slots: [], furn: [] };
  const focus = focusOf(order, o.focus);
  if (o.narrow) return planNarrow(layout, groups, grouped, focus, o);
  if (hasFocusSlot(layout) && o.focusAway) return planList(groups, grouped);
  switch (layout) {
    case "rail":
      return planRail(groups, grouped, focus);
    case "wall":
      return planWall(groups, grouped, o.width);
    case "spotlight":
      return planSpotlight(order, focus);
    case "dashboard":
      return planDashboard(order, 6);
    case "triage":
      return planTriage(groups, grouped);
    case "lanes":
      return planLanes(groups, grouped);
  }
}

/** one column of rows with acts: the rail with its focus elsewhere */
function planList(groups: readonly BoardGroup[], grouped: boolean): BoardPlan {
  const rows: string[] = [];
  const slots: Slot[] = [];
  const furn: Furn[] = [];
  for (const g of groups) {
    if (grouped) {
      rows.push(FIT);
      furn.push(groupFurn(g, rows.length, 2));
    }
    for (const c of g.cards) {
      rows.push(FIT);
      slots.push({ id: c.id, area: area(rows.length, 1), mode: "row", acts: true });
    }
  }
  rows.push("1fr");
  return { columns: "minmax(0, 1fr)", rows: rows.join(" "), slots, furn };
}

function planRail(groups: readonly BoardGroup[], grouped: boolean, focus: string | null): BoardPlan {
  const rows: string[] = [];
  const slots: Slot[] = [];
  const furn: Furn[] = [];
  for (const g of groups) {
    const rest = g.cards.filter((c) => c.id !== focus);
    if (grouped && rest.length) {
      rows.push(FIT);
      furn.push(groupFurn(g, rows.length, 2));
    }
    for (const c of rest) {
      rows.push(FIT);
      slots.push({ id: c.id, area: area(rows.length, 1), mode: "row", acts: true });
    }
  }
  rows.push("1fr");
  if (focus) slots.push({ id: focus, area: area(1, 2, rows.length + 1, 3), mode: "term", acts: false });
  return { columns: "minmax(14rem, 26%) minmax(0, 1fr)", rows: rows.join(" "), slots, furn };
}

/** how many columns a wall of `n` tiles takes in `width` px */
export function wallColumns(n: number, width: number): number {
  const fit = Math.max(1, Math.floor(width / 340));
  return Math.max(1, Math.min(Math.ceil(Math.sqrt(n)), fit, n));
}

function planWall(groups: readonly BoardGroup[], grouped: boolean, width: number): BoardPlan {
  const cols = wallColumns(Math.max(...groups.map((g) => g.cards.length)), width);
  const rows: string[] = [];
  const slots: Slot[] = [];
  const furn: Furn[] = [];
  for (const g of groups) {
    if (grouped) {
      rows.push(FIT);
      furn.push(groupFurn(g, rows.length, cols + 1));
    }
    const top = rows.length + 1;
    g.cards.forEach((c, i) => {
      const r = top + Math.floor(i / cols);
      if (r > rows.length) rows.push("minmax(13rem, 1fr)");
      slots.push({ id: c.id, area: area(r, (i % cols) + 1), mode: "term", acts: false });
    });
  }
  return { columns: `repeat(${cols}, minmax(0, 1fr))`, rows: rows.join(" "), slots, furn };
}

/** The spotlight's first eight places on a 6 by 4 grid: the focus 3 by 3,
 *  the next 3 by 2, then smaller; every card past them a chip below. */
const SPOT = ["1 / 1 / 4 / 4", "1 / 4 / 3 / 7", "3 / 4 / 4 / 6", "3 / 6 / 4 / 7", "4 / 1 / 5 / 3", "4 / 3 / 5 / 5", "4 / 5 / 5 / 6", "4 / 6 / 5 / 7"];

function planSpotlight(order: readonly AgentCard[], focus: string | null): BoardPlan {
  const first = order.find((c) => c.id === focus);
  const seq = first ? [first, ...order.filter((c) => c !== first)] : [...order];
  if (seq.length === 1) return { columns: "minmax(0, 1fr)", rows: "minmax(0, 1fr)", slots: [{ id: seq[0]!.id, area: area(1, 1), mode: "term", acts: false }], furn: [] };
  const extra = Math.ceil(Math.max(0, seq.length - SPOT.length) / 6);
  const slots: Slot[] = seq.map((c, i) => {
    // every spot shows a screen; the ones beside the focus answer in place
    if (i < SPOT.length) return { id: c.id, area: SPOT[i]!, mode: "term", acts: i > 0 };
    const k = i - SPOT.length;
    return { id: c.id, area: area(5 + Math.floor(k / 6), (k % 6) + 1), mode: "chip", acts: false };
  });
  const rows = ["repeat(4, minmax(0, 1fr))", ...Array<string>(extra).fill(FIT)];
  return { columns: "repeat(6, minmax(0, 1fr))", rows: rows.join(" "), slots, furn: [] };
}

function planDashboard(order: readonly AgentCard[], cols: number): BoardPlan {
  const waiting = order.filter((c) => c.state === "waiting");
  const working = order.filter((c) => c.state === "working");
  const rest = order.filter((c) => c.state !== "waiting" && c.state !== "working");
  // One band of work (two tiles or fewer): the waits stack at their own
  // height and the work spans them and a last row that takes the rest, so
  // short rows do not each claim a share of the stage. More bands share
  // the region evenly, the waits spread down it.
  const bands = Math.ceil(working.length / 2);
  const region = bands <= 1 ? Math.max(waiting.length, 1) + 1 : Math.max(waiting.length, 2 * bands);
  const rows = [FIT, FIT, ...(bands <= 1 ? [...Array<string>(region - 1).fill(FIT), "minmax(4.75rem, 1fr)"] : Array<string>(region).fill("minmax(4.75rem, 1fr)"))];
  const slots: Slot[] = [];
  const furn: Furn[] = [
    { key: "summary", kind: "summary", area: area(1, 1, 2, cols + 1), label: "", count: 0, tone: null },
    { key: "h:waiting", kind: "head", area: area(2, 1, 3, 3), label: "waiting on you", count: waiting.length, tone: "waiting" },
    { key: "h:working", kind: "head", area: area(2, 3, 3, cols + 1), label: "working", count: working.length, tone: "working" },
  ];
  waiting.forEach((c, i) => slots.push({ id: c.id, area: area(3 + i, 1, 4 + i, 3), mode: "row", acts: true }));
  working.forEach((c, i) => {
    const r = 3 + 2 * Math.floor(i / 2);
    const col = i % 2 === 0 ? 3 : 5;
    slots.push({ id: c.id, area: area(r, col, bands <= 1 ? 3 + region : r + 2, col + 2), mode: "term", acts: false });
  });
  if (rest.length) {
    rows.push(FIT);
    furn.push({ key: "h:rest", kind: "head", area: area(rows.length, 1, rows.length + 1, cols + 1), label: "idle and done", count: rest.length, tone: null });
    const top = rows.length + 1;
    rest.forEach((c, i) => {
      const r = top + Math.floor(i / cols);
      if (r > rows.length) rows.push(FIT);
      slots.push({ id: c.id, area: area(r, (i % cols) + 1), mode: "chip", acts: false });
    });
  }
  return { columns: `repeat(${cols}, minmax(0, 1fr))`, rows: rows.join(" "), slots, furn };
}

function planTriage(groups: readonly BoardGroup[], grouped: boolean): BoardPlan {
  const rows: string[] = [FIT];
  const slots: Slot[] = [];
  const all = groups.flatMap((g) => g.cards);
  const furn: Furn[] = TRIAGE.map((t, i) => ({
    key: `h:${t.key}`,
    kind: "head" as const,
    area: area(1, i + 1),
    label: t.label,
    count: all.filter((c) => t.states.includes(c.state)).length,
    tone: t.tone,
  }));
  for (const g of groups) {
    if (grouped) {
      rows.push(FIT);
      furn.push(groupFurn(g, rows.length, TRIAGE.length + 1));
    }
    const top = rows.length + 1;
    let deepest = 0;
    TRIAGE.forEach((t, col) => {
      const these = g.cards.filter((c) => t.states.includes(c.state));
      these.forEach((c, j) => slots.push({ id: c.id, area: area(top + j, col + 1), mode: "row", acts: true }));
      deepest = Math.max(deepest, these.length);
    });
    for (let j = 0; j < deepest; j++) rows.push(FIT);
  }
  rows.push("1fr");
  return { columns: `repeat(${TRIAGE.length}, minmax(0, 1fr))`, rows: rows.join(" "), slots, furn };
}

function planLanes(groups: readonly BoardGroup[], grouped: boolean): BoardPlan {
  const rows: string[] = [FIT];
  const slots: Slot[] = [];
  const furn: Furn[] = [{ key: "axis", kind: "axis", area: area(1, 2), label: "", count: 0, tone: null }];
  for (const g of groups) {
    if (grouped) {
      rows.push(FIT);
      furn.push(groupFurn(g, rows.length, 3));
    }
    for (const c of g.cards) {
      rows.push("minmax(2.25rem, auto)");
      slots.push({ id: c.id, area: area(rows.length, 1, rows.length + 1, 3), mode: "lane", acts: false });
    }
  }
  rows.push("1fr");
  return { columns: "minmax(10rem, 15rem) minmax(0, 1fr)", rows: rows.join(" "), slots, furn };
}

/** A phone's board, one column: the rail and the spotlight are the list
 *  until an agent is opened, which then fills the board alone; the wall
 *  and the dashboard stack; triage stacks its columns under their heads;
 *  lanes keep their two tracks. */
function planNarrow(layout: BoardLayout, groups: readonly BoardGroup[], grouped: boolean, focus: string | null, o: PlanOptions): BoardPlan {
  const order = groups.flatMap((g) => g.cards);
  if (hasFocusSlot(layout)) {
    if (o.focusOpen && focus) {
      return {
        columns: "minmax(0, 1fr)",
        rows: "minmax(0, 1fr)",
        slots: order.map((c) => (c.id === focus ? { id: c.id, area: area(1, 1), mode: "term", acts: false } : { id: c.id, area: "auto", mode: "hidden", acts: false })),
        furn: [],
      };
    }
    return planList(groups, grouped);
  }
  if (layout === "lanes") return planLanes(groups, grouped);
  if (layout === "wall") return planWall(groups, grouped, 0);
  if (layout === "dashboard") return planDashboardNarrow(order);
  // triage: each state's head, then its rows
  const rows: string[] = [];
  const slots: Slot[] = [];
  const furn: Furn[] = [];
  for (const t of TRIAGE) {
    const these = order.filter((c) => t.states.includes(c.state));
    rows.push(FIT);
    furn.push({ key: `h:${t.key}`, kind: "head", area: area(rows.length, 1), label: t.label, count: these.length, tone: t.tone });
    for (const c of these) {
      rows.push(FIT);
      slots.push({ id: c.id, area: area(rows.length, 1), mode: "row", acts: true });
    }
  }
  rows.push("1fr");
  return { columns: "minmax(0, 1fr)", rows: rows.join(" "), slots, furn };
}

function planDashboardNarrow(order: readonly AgentCard[]): BoardPlan {
  const rows: string[] = [FIT];
  const slots: Slot[] = [];
  const furn: Furn[] = [{ key: "summary", kind: "summary", area: area(1, 1), label: "", count: 0, tone: null }];
  const parts: { key: string; label: string; tone: AgentState | null; cards: AgentCard[]; mode: TileMode; track: string }[] = [
    { key: "waiting", label: "waiting on you", tone: "waiting", cards: order.filter((c) => c.state === "waiting"), mode: "row", track: FIT },
    { key: "working", label: "working", tone: "working", cards: order.filter((c) => c.state === "working"), mode: "term", track: "minmax(12rem, auto)" },
    { key: "rest", label: "idle and done", tone: null, cards: order.filter((c) => c.state !== "waiting" && c.state !== "working"), mode: "chip", track: FIT },
  ];
  for (const p of parts) {
    if (!p.cards.length) continue;
    rows.push(FIT);
    furn.push({ key: `h:${p.key}`, kind: "head", area: area(rows.length, 1), label: p.label, count: p.cards.length, tone: p.tone });
    for (const c of p.cards) {
      rows.push(p.track);
      slots.push({ id: c.id, area: area(rows.length, 1), mode: p.mode, acts: p.mode === "row" });
    }
  }
  return { columns: "minmax(0, 1fr)", rows: rows.join(" "), slots, furn };
}

/* ---------- keys ---------- */

/** The next agent waiting after `focus` in the board's order, which puts
 *  a session's wait before a run's and the longest wait first in each;
 *  round to the first after the last. */
export function nextWaiting(order: readonly AgentCard[], focus: string | null): string | null {
  const waiting = order.filter((c) => c.state === "waiting");
  if (!waiting.length) return null;
  const i = waiting.findIndex((c) => c.id === focus);
  return waiting[(i + 1) % waiting.length]!.id;
}

/** the agent at place `n`, counted from 1 in the board's order */
export const nthCard = (order: readonly AgentCard[], n: number): string | null => order[n - 1]?.id ?? null;

/** the layout one step along, round at either end */
export function stepLayout(l: BoardLayout, by: 1 | -1): BoardLayout {
  const i = BOARD_LAYOUTS.indexOf(l);
  return BOARD_LAYOUTS[(i + by + BOARD_LAYOUTS.length) % BOARD_LAYOUTS.length]!;
}

/** Whether a key press is the board's: no modifier, and not typed into a
 *  field or a shell. */
export function boardKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, inField: boolean): "next" | "prev-layout" | "next-layout" | number | null {
  if (e.metaKey || e.ctrlKey || e.altKey || inField) return null;
  if (e.key === "w") return "next";
  if (e.key === "[") return "prev-layout";
  if (e.key === "]") return "next-layout";
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
  return null;
}

/* ---------- follow mode ---------- */

/** how long after a key press follow mode holds off, so it never takes the
 *  focus from under a word being typed */
export const TYPING_HOLD = 3000;

/** The cards that started waiting between two registries, or took a new
 *  wait, the latest first. */
export function startedWaiting(before: Record<string, AgentCard>, after: Record<string, AgentCard>): string[] {
  return Object.values(after)
    .filter((c) => {
      if (c.state !== "waiting") return false;
      const was = before[c.id];
      return !was || was.state !== "waiting" || was.waiting !== c.waiting;
    })
    .sort((a, b) => b.seenAt - a.seenAt || a.id.localeCompare(b.id))
    .map((c) => c.id);
}

/** Where follow mode takes the focus now: the latest agent to start
 *  waiting that still waits, unless a key went down in the last
 *  `TYPING_HOLD`, when it waits (null) and is asked again later. */
export function followTarget(pending: readonly string[], cards: Record<string, AgentCard>, lastKeyAt: number, now: number): string | null {
  if (now - lastKeyAt < TYPING_HOLD) return null;
  return pending.find((id) => cards[id]?.state === "waiting") ?? null;
}

/* ---------- keeping shells ---------- */

/** how many shells the board keeps joined, hidden, after their agent left
 *  the focus, so going back to one never drops it */
export const KEEP_SHELLS = 3;

/** the kept list with `id` at its front, the oldest dropped past `max` */
export function keepShell(kept: readonly string[], id: string, max = KEEP_SHELLS): string[] {
  if (kept[0] === id) return [...kept];
  return [id, ...kept.filter((k) => k !== id)].slice(0, max);
}

/* ---------- answering in place ---------- */

export interface QuickAnswer {
  label: string;
  answer: InboxAnswer;
  /** the one to press when unsure: allow, or a question's first option */
  main?: true;
}

/** The answers a row can give an ask in one press: allow or deny a
 *  permission or a guard; a single question with one choice, each option.
 *  Takes an ask or the inbox's item for one, a run's prompt included. Null
 *  for anything that needs the full form (several questions, several
 *  choices, a free answer). */
export function quickAnswers(ask: { kind: string; questions?: Ask["questions"] }): QuickAnswer[] | null {
  if (ask.kind === "permission" || ask.kind === "guard") {
    return [
      { label: "allow", answer: { behavior: "allow" }, main: true },
      { label: "deny", answer: { behavior: "deny" } },
    ];
  }
  const qs = ask.questions ?? [];
  const q = qs[0];
  if (qs.length !== 1 || !q || q.multiSelect || q.options.length === 0 || q.options.length > 4) return null;
  return q.options.map((opt, i) => ({ label: opt.label, answer: { answers: { [q.question]: opt.label } }, ...(i === 0 ? { main: true as const } : {}) }));
}

/* ---------- lanes ---------- */

/** a stretch of a lane: a state the page saw, `seen` while the page did
 *  not know which, `lost` after the last beat */
export interface LaneSeg {
  from: number;
  to: number;
  state: AgentState | "seen";
}

/** A card's lane between `from` and `now`, cut into the states its trail
 *  marks; before its first mark the page did not see, so `seen`. A lost
 *  card's lane runs on as `lost` from its last beat to now. */
export function laneSegs(c: AgentCard, marks: readonly TrailMark[] | undefined, from: number, now: number): LaneSeg[] {
  const start = Math.max(c.startedAt, from);
  const end = Math.max(start, runEnd(c, now));
  const segs: LaneSeg[] = [];
  let at = start;
  let state: LaneSeg["state"] = "seen";
  for (const m of marks ?? []) {
    const t = Math.min(Math.max(m.at, start), end);
    if (t > at) segs.push({ from: at, to: t, state });
    at = Math.max(at, t);
    state = m.state === "lost" || m.state === "ended" ? state : m.state;
  }
  if (end > at) segs.push({ from: at, to: end, state });
  if (c.state === "lost" && now > end) segs.push({ from: end, to: now, state: "lost" });
  return segs;
}

/* ---------- a layout per screen ---------- */

/** The layout a screen `w` by `h` starts on, the same one its recommended
 *  profile sets (`recommendLayout`): the wall, on every screen. */
export function recommendBoard(w: number, h: number): BoardLayout {
  return recommendLayout(w, h).agents ?? "wall";
}

/* ---------- the focus in a window of its own ---------- */

/** Where the board's focus is, as the pane messages tell it (`FOCUS_PANE`
 *  in panes.ts): out once its window says hello, back on its bye or its
 *  "return". Other panes' messages change nothing. */
export function focusAwayAfter(away: boolean, m: PaneMsg | null, pane: string): boolean {
  if (!m || m.type === "who" || m.type === "show" || m.id !== pane) return away;
  if (m.type === "hello") return true;
  return false;
}
