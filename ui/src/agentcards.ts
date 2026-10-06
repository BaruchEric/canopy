/**
 * The agent registry as the page shows it (agents spec, phase 3): which
 * broker cards belong to a repo card, the words a row says, and the groups
 * the registry tab shows them in. Pure, so it is tested. (The spec calls
 * this ui/src/registry.ts; that name is the multi-backend registry's.)
 */
import { isLiveAgent, type AgentCard, type AgentState, type Repo } from "../../src/core/types";
import { webUrl } from "../../src/core/remote";
import type { RepoCard } from "./checkouts";

const DAY = 86_400_000;

/** A web url as the key cards join on, the one `remoteKey` makes for a
 *  repo card: lowercase host and path, no `.git`, no trailing slash. */
export function urlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  } catch {
    return null;
  }
}

/** every key a checkout answers to: its link and each remote's web page,
 *  since a hook takes origin first and a repo card the first that maps */
export function repoKeys(repo: Repo): string[] {
  const keys = new Set<string>();
  for (const url of [repo.link, ...(repo.remotes ?? []).map(webUrl)]) {
    const k = urlKey(url);
    if (k) keys.add(k);
  }
  return [...keys];
}

const under = (cwd: string, path: string): boolean => {
  const p = path.replace(/\/+$/, "");
  return p !== "" && (cwd === p || cwd.startsWith(`${p}/`));
};

/** Whether a card is about a checkout: by its repo's web url, or, for a
 *  card that names no repo, by its folder being under a local checkout's,
 *  on the same backend when the card says which (a canopy shell's). */
export function cardOnRepo(card: AgentCard, repo: Repo, backend = ""): boolean {
  const key = urlKey(card.repo);
  if (key) return repoKeys(repo).includes(key);
  if (repo.host || repo.forge || !card.cwd) return false;
  const on = card.where.canopy?.backend;
  if (on && backend && on !== backend) return false;
  return under(card.cwd, repo.path);
}

/** the cards about any checkout on a repo card, running first */
export function cardsFor(repoCard: RepoCard, cards: readonly AgentCard[], backendOf: (id: string) => string = () => ""): AgentCard[] {
  return orderCards(cards.filter((c) => repoCard.checkouts.some((r) => cardOnRepo(c, r, backendOf(r.id)))));
}

/** the repo a card is about among `repos`, the deepest folder when its
 *  match is by folder */
export function repoOfCard(card: AgentCard, repos: readonly Repo[]): Repo | undefined {
  const hits = repos.filter((r) => cardOnRepo(card, r));
  return hits.sort((a, b) => b.path.length - a.path.length)[0];
}

const RANK: Record<AgentState, number> = { waiting: 0, working: 1, idle: 2, lost: 3, ended: 4 };

/** waiting first, then working, idle, lost, ended; newest start first in each */
export function orderCards(cards: readonly AgentCard[]): AgentCard[] {
  return [...cards].sort((a, b) => RANK[a.state] - RANK[b.state] || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
}

export const liveCount = (cards: readonly AgentCard[]): number => cards.filter(isLiveAgent).length;

export const anyWaiting = (cards: readonly AgentCard[]): boolean => cards.some((c) => c.state === "waiting");

/** The running cards, and the ones that ended or were lost within `span`
 *  of `now`; anything older is left out. */
export function splitRecent(cards: readonly AgentCard[], now: number, span = DAY): { live: AgentCard[]; past: AgentCard[] } {
  const live: AgentCard[] = [];
  const past: AgentCard[] = [];
  for (const c of cards) {
    if (isLiveAgent(c)) live.push(c);
    else if ((c.endedAt ?? c.seenAt) >= now - span) past.push(c);
  }
  return { live: orderCards(live), past: orderCards(past) };
}

/** what a row calls an agent: its handle, or for a scan card (no handle,
 *  nothing reads a DM for it) its harness and pid */
export const cardName = (c: AgentCard): string => c.handle || `${c.harness}${c.where.pid !== null ? ` pid ${c.where.pid}` : ""}`;

/** "working", "waiting: your turn", "lost" */
export function stateWord(c: AgentCard): string {
  if (c.state === "waiting") return c.waiting ? `waiting: ${c.waiting}` : "waiting";
  return c.state;
}

/** the machine a card runs on, as the page names it: a canopy backend's
 *  own name when the card came from one, else the tailnet node */
export const machineOf = (c: AgentCard): string => c.where.canopy?.backend || c.node;

/** "canopy shell on mini", "kitty on ericmac", "container on mini", "scan on mini" */
export function whereWord(c: AgentCard): string {
  const cw = c.where.canopy;
  if (cw?.term) return `canopy shell on ${cw.backend || c.node}`;
  if (cw?.run) return `canopy run on ${cw.backend || c.node}`;
  if (c.origin === "scan") return `scan on ${c.node}`;
  if (c.where.container) return `container on ${c.node}`;
  if (c.where.term) return `${c.where.term} on ${c.node}`;
  return `on ${c.node}`;
}

/** "me/app" off a repo's web url, the host dropped */
export function repoName(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
}

/** "me/app · main", or the folder's last part for a card that names no repo */
export function repoWord(c: AgentCard): string {
  const name = repoName(c.repo) ?? (c.cwd ? c.cwd.replace(/\/+$/, "").split("/").pop() || c.cwd : "");
  return [name, c.branch].filter(Boolean).join(" · ");
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < DAY / 1000) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** a run's length as a person says it, to the minute: "45s", "12m",
 *  "1h 12m", "2d 3h" */
export function durationWord(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** when a card's run stopped: its end, its last beat once lost, else now */
export const runEnd = (c: AgentCard, now: number): number => (c.state === "ended" ? (c.endedAt ?? c.seenAt) : c.state === "lost" ? c.seenAt : now);

/** how long it has run, or ran */
export const runMs = (c: AgentCard, now: number): number => Math.max(0, runEnd(c, now) - c.startedAt);

/** how long: "1h 12m" running, "ran 42m, ended 3h ago", "ran 2h, lost 5m
 *  ago" (since its last beat) */
export function ageWord(c: AgentCard, now: number): string {
  if (c.state === "ended") return `ran ${durationWord(runMs(c, now))}, ended ${span(now - (c.endedAt ?? c.seenAt))} ago`;
  if (c.state === "lost") return `ran ${durationWord(runMs(c, now))}, lost ${span(now - c.seenAt)} ago`;
  return durationWord(runMs(c, now));
}

/** local midnight of the day `now` is in */
export function dayStartOf(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** the part of a card's run since `dayStart` */
export const todayMs = (c: AgentCard, now: number, dayStart: number): number => Math.max(0, runEnd(c, now) - Math.max(c.startedAt, dayStart));

/** The registry tab's summary: the live agents by state, the machines and
 *  repos they are on, the day's starts and ends, every agent's time since
 *  midnight added up, the longest running and the harnesses. */
export interface RegistrySummary {
  live: number;
  working: number;
  waiting: number;
  idle: number;
  machines: number;
  repos: number;
  startedToday: number;
  endedToday: number;
  lostToday: number;
  todayMs: number;
  longest: AgentCard | null;
  harnesses: { harness: AgentCard["harness"]; count: number }[];
}

export function registrySummary(cards: readonly AgentCard[], now: number, dayStart = dayStartOf(now)): RegistrySummary {
  const out: RegistrySummary = {
    live: 0,
    working: 0,
    waiting: 0,
    idle: 0,
    machines: 0,
    repos: 0,
    startedToday: 0,
    endedToday: 0,
    lostToday: 0,
    todayMs: 0,
    longest: null,
    harnesses: [],
  };
  const machines = new Set<string>();
  const repos = new Set<string>();
  const harnesses = new Map<AgentCard["harness"], number>();
  for (const c of cards) {
    if (c.startedAt >= dayStart) out.startedToday++;
    if (c.state === "ended" && (c.endedAt ?? c.seenAt) >= dayStart) out.endedToday++;
    if (c.state === "lost" && c.seenAt >= dayStart) out.lostToday++;
    out.todayMs += todayMs(c, now, dayStart);
    if (!isLiveAgent(c)) continue;
    out.live++;
    if (c.state === "working") out.working++;
    else if (c.state === "waiting") out.waiting++;
    else out.idle++;
    machines.add(machineOf(c));
    const repo = urlKey(c.repo) ?? (c.cwd || null);
    if (repo) repos.add(repo);
    harnesses.set(c.harness, (harnesses.get(c.harness) ?? 0) + 1);
    if (!out.longest || c.startedAt < out.longest.startedAt) out.longest = c;
  }
  out.machines = machines.size;
  out.repos = repos.size;
  out.harnesses = [...harnesses].map(([harness, count]) => ({ harness, count })).sort((a, b) => b.count - a.count || a.harness.localeCompare(b.harness));
  return out;
}

/** one agent's run on the day's timeline, cut at its left edge */
export interface Lane {
  card: AgentCard;
  start: number;
  end: number;
  /** it started before the timeline does */
  clipped: boolean;
}

export interface Timeline {
  from: number;
  to: number;
  lanes: Lane[];
  ticks: { at: number; label: string }[];
}

/** how many lanes the timeline draws: the live ones first, then the latest
 *  to stop */
export const TIMELINE_LANES = 24;
const HOUR = 3_600_000;
const TICK_STEPS = [15, 30, 60, 120, 180, 360].map((m) => m * 60_000);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "09:30", local */
export function clockWord(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The day's runs as lanes over time, earliest start first: every live card
 *  and every one that stopped since `dayStart`. It spans from the earliest
 *  start (never before midnight, a run from before cut there) to now, an
 *  hour at least; ticks fall on the local clock, eight at most. */
export function timelineOf(cards: readonly AgentCard[], now: number, dayStart = dayStartOf(now), max = TIMELINE_LANES): Timeline {
  const kept = cards
    .filter((c) => isLiveAgent(c) || runEnd(c, now) >= dayStart)
    .sort((a, b) => Number(isLiveAgent(b)) - Number(isLiveAgent(a)) || runEnd(b, now) - runEnd(a, now) || a.id.localeCompare(b.id))
    .slice(0, max);
  const earliest = Math.min(now, ...kept.map((c) => c.startedAt));
  const from = Math.min(Math.max(dayStart, earliest), now - HOUR);
  const lanes = kept
    .map((card) => {
      const start = Math.max(card.startedAt, from);
      return { card, start, end: Math.max(start, runEnd(card, now)), clipped: card.startedAt < from };
    })
    .sort((a, b) => a.start - b.start || a.card.id.localeCompare(b.card.id));
  const step = TICK_STEPS.find((s) => (now - from) / s <= 8) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const base = dayStartOf(from);
  const ticks: Timeline["ticks"] = [];
  for (let at = base + Math.ceil((from - base) / step) * step; at <= now; at += step) ticks.push({ at, label: clockWord(at) });
  return { from, to: now, lanes, ticks };
}

/** The backend that can read a card's transcript: the canopy backend it
 *  ran under, else one the page shows on the same machine, learned from
 *  another card that ran under a canopy backend on that node or by a
 *  backend named as the node is. Null for a card with no session (a scan's)
 *  or another harness, and for a machine no backend here is on. */
export function readerOf(card: AgentCard, shown: readonly string[], cards: readonly AgentCard[]): string | null {
  if (!card.session || card.harness === "other") return null;
  const own = card.where.canopy?.backend;
  if (own && shown.includes(own)) return own;
  for (const c of cards) {
    const b = c.where.canopy?.backend;
    if (b && c.node === card.node && shown.includes(b)) return b;
  }
  const node = card.node.toLowerCase();
  return shown.find((b) => b.toLowerCase() === node) ?? null;
}

/** a state the page saw a card take, and when */
export interface TrailMark {
  state: AgentState;
  at: number;
  /** what it waited on, for a wait */
  waiting?: string;
}

/** how many marks a card keeps, the oldest dropped */
export const TRAIL_CAP = 24;
/** a card first heard of this soon after its start is a start the page saw */
const FRESH = 2 * 60_000;

/** What the page saw of each card's states, laid over `trail`: a mark on
 *  each change of state (a new wait counts), and one for a card heard of
 *  within `FRESH` of its start; a card the page met later has no mark
 *  until it changes, since when it took its state is not known. `after` is
 *  the registry with `cards` laid in, so one it passed over (older than
 *  the card held) marks nothing; `gone` are dropped. The same object when
 *  nothing moved. */
export function markTrail(
  trail: Record<string, TrailMark[]>,
  before: Record<string, AgentCard>,
  after: Record<string, AgentCard>,
  cards: readonly AgentCard[],
  at: number,
  gone: readonly string[] = [],
): Record<string, TrailMark[]> {
  let next: Record<string, TrailMark[]> | null = null;
  for (const c of cards) {
    if (after[c.id] !== c) continue;
    const prev = Object.hasOwn(before, c.id) ? before[c.id] : undefined;
    const moved = prev ? prev.state !== c.state || (c.state === "waiting" && c.waiting !== prev.waiting) : isLiveAgent(c) && at - c.startedAt <= FRESH;
    if (!moved) continue;
    const mark: TrailMark = { state: c.state, at };
    if (c.state === "waiting" && c.waiting) mark.waiting = c.waiting;
    next ??= { ...trail };
    const list = [...(next[c.id] ?? []), mark];
    next[c.id] = list.length > TRAIL_CAP ? list.slice(-TRAIL_CAP) : list;
  }
  for (const id of gone) {
    if (!Object.hasOwn(next ?? trail, id)) continue;
    next ??= { ...trail };
    delete next[id];
  }
  return next ?? trail;
}

/** since when a live card has been in its state, when the page saw it
 *  change; null when it did not */
export function stateSince(c: AgentCard, marks: readonly TrailMark[] | undefined): number | null {
  const last = marks?.[marks.length - 1];
  return last && isLiveAgent(c) && last.state === c.state ? last.at : null;
}

export type CardGrouping = "machine" | "repo";

export interface CardGroup {
  key: string;
  label: string;
  cards: AgentCard[];
  live: number;
}

/** Cards in groups by machine or by repo, each group's running ones first;
 *  groups with more running first, then by name, cards with no repo last. */
export function groupCards(cards: readonly AgentCard[], by: CardGrouping): CardGroup[] {
  const groups = new Map<string, CardGroup>();
  for (const c of cards) {
    const key = by === "machine" ? machineOf(c) : (urlKey(c.repo) ?? "");
    const label = by === "machine" ? key : (repoName(c.repo) ?? "no repo");
    const g = groups.get(key) ?? { key, label, cards: [], live: 0 };
    g.cards.push(c);
    if (isLiveAgent(c)) g.live++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, cards: orderCards(g.cards) }))
    .sort((a, b) => Number(a.key === "") - Number(b.key === "") || b.live - a.live || a.label.localeCompare(b.label));
}

/** The shell a card runs in, qualified for this page, when it is a canopy
 *  shell on a backend the page shows; null for any other card. */
export function joinTarget(c: AgentCard, shown: readonly string[], qual: (backend: string, id: string) => string): string | null {
  const cw = c.where.canopy;
  if (!cw?.term || !cw.backend || !shown.includes(cw.backend)) return null;
  return qual(cw.backend, cw.term);
}

/** a path from one folder to another, `..` where they part */
export function relPath(from: string, to: string): string {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** Where a card's transcript opens: through a home checkout (the openers
 *  take a repo and a path in it), when the agent ran in a canopy shell or
 *  run on the home backend, so the file is on the machine the openers
 *  reach; null otherwise, since a path on another machine opens nothing. */
export function transcriptTarget(c: AgentCard, home: string, homeRepos: readonly Repo[]): { repoId: string; file: string } | null {
  if (!c.transcript?.startsWith("/") || c.where.canopy?.backend !== home) return null;
  const local = homeRepos.filter((r) => !r.host && !r.forge);
  const repo =
    local.filter((r) => c.cwd && under(c.cwd, r.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? repoOfCard(c, local);
  return repo ? { repoId: repo.id, file: relPath(repo.path, c.transcript) } : null;
}

/** Cards held by id with `incoming` laid over them, a card older than the
 *  one held (a list that raced an event) passed over, and `gone` dropped;
 *  the same object when nothing moved. */
export function mergeCards(held: Record<string, AgentCard>, incoming: readonly AgentCard[], gone: readonly string[] = []): Record<string, AgentCard> {
  let next: Record<string, AgentCard> | null = null;
  for (const c of incoming) {
    const had = held[c.id];
    if (had && (had.seenAt > c.seenAt || had === c)) continue;
    next ??= { ...held };
    next[c.id] = c;
  }
  for (const id of gone) {
    if (!(id in (next ?? held))) continue;
    next ??= { ...held };
    delete next[id];
  }
  return next ?? held;
}

/** A whole list read as the cards held: what it names, each unless the one
 *  held is newer. `since` names the cards an event told of while the list
 *  was on its way: what the event said stands, whatever the list says (the
 *  broker marks a card lost without a new beat, so a tie is no proof), a
 *  card it brought in is kept though the list lacks it, and one it said
 *  was gone stays gone. */
export function replaceCards(
  held: Record<string, AgentCard>,
  list: readonly AgentCard[],
  since: (id: string) => boolean = () => false,
): Record<string, AgentCard> {
  const out: Record<string, AgentCard> = {};
  for (const c of list) {
    const had = Object.hasOwn(held, c.id) ? held[c.id] : undefined;
    if (since(c.id)) {
      if (had) out[c.id] = had;
      continue;
    }
    out[c.id] = had && had.seenAt > c.seenAt ? had : c;
  }
  for (const [id, had] of Object.entries(held)) if (!Object.hasOwn(out, id) && since(id)) out[id] = had;
  return out;
}

/** Every repo card's agents at once, by the repo card's key, the way
 *  `cardsFor` finds them one card at a time: the url keys looked up in one
 *  map, the folder match only for cards that name no repo. */
export function cardsByRepoCard(repoCards: readonly RepoCard[], cards: readonly AgentCard[], backendOf: (id: string) => string = () => ""): Map<string, AgentCard[]> {
  const byKey = new Map<string, AgentCard[]>();
  const loose: AgentCard[] = [];
  for (const c of cards) {
    const k = urlKey(c.repo);
    if (!k) {
      loose.push(c);
      continue;
    }
    const list = byKey.get(k);
    if (list) list.push(c);
    else byKey.set(k, [c]);
  }
  const out = new Map<string, AgentCard[]>();
  for (const rc of repoCards) {
    const found = new Set<AgentCard>();
    for (const r of rc.checkouts) {
      for (const k of repoKeys(r)) for (const c of byKey.get(k) ?? []) found.add(c);
      for (const c of loose) if (cardOnRepo(c, r, backendOf(r.id))) found.add(c);
    }
    if (found.size) out.set(rc.key, orderCards([...found]));
  }
  return out;
}
