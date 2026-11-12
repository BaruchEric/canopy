/** The live counts on the view tabs and the grove's group headings. Pure,
 *  so each number is tested and agrees with the place it summarises: the
 *  attention pill, the registry, the health view, the incubator, the card. */

import { statusFromState, type AgentStatus } from "../../src/core/agentstatus";
import { isLiveAgent, type AgentCard, type HealthCheck, type Repo, type Sprout, type SproutStatus } from "../../src/core/types";
import { AGENT_GLYPH } from "./agentpanel";
import { tokenCount } from "./runs";
import { WAITING_GLYPH } from "./waiting";

export type BadgeTone = "rust" | "sky" | "lichen";

export interface Badge {
  text: string;
  tone: BadgeTone;
  title: string;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** the git tab: the attention pill's own count, for the views that hide it */
export function gitBadge(attention: number): Badge | null {
  if (attention === 0) return null;
  return { text: String(attention), tone: "lichen", title: `${attention} repo${attention === 1 ? " needs" : "s need"} attention: changes, unpushed commits or errors` };
}

/** a card as far as its status goes; `waiting` may be missing */
type StateCard = Pick<AgentCard, "state"> & Partial<Pick<AgentCard, "waiting">>;

/** a card's status from the card alone, where no pulse or ask is known */
const byState = (c: StateCard): AgentStatus => statusFromState(c.state, c.waiting);

/** how the agents tab's tooltip words each live status */
const LIVE_WORDS: readonly [AgentStatus, string][] = [
  ["waiting", "waiting on you"],
  ["stalled", "stalled"],
  ["working", "working"],
  ["background", "in background"],
  ["idle", "idle"],
];

/** the agents tab: the home broker's live agents, rust while one waits on
 *  you and lichen while one stalls, as the card's ✦ chip */
export function agentsBadge<C extends StateCard>(cards: readonly C[], status: (c: C) => AgentStatus = byState): Badge | null {
  const live = cards.filter(isLiveAgent);
  if (live.length === 0) return null;
  const n = new Map<AgentStatus, number>();
  for (const c of live) n.set(status(c), (n.get(status(c)) ?? 0) + 1);
  const words = LIVE_WORDS.flatMap(([s, w]) => (n.get(s) ? [`${n.get(s)} ${w}`] : [])).join(", ");
  const tone: BadgeTone = n.get("waiting") ? "rust" : n.get("stalled") ? "lichen" : "sky";
  return { text: `✦ ${live.length}`, tone, title: `${plural(live.length, "agent")} running on the broker: ${words}` };
}

const TROUBLE = new Set<HealthCheck["state"]>(["down", "healing", "gave-up"]);

/** the health tab: checks down, healing or given up on, every backend;
 *  rust unless all of them are healing */
export function healthBadge(health: Readonly<Record<string, readonly Pick<HealthCheck, "state" | "label">[]>>): Badge | null {
  const bad = Object.entries(health).flatMap(([backend, checks]) => checks.filter((c) => TROUBLE.has(c.state)).map((c) => ({ backend, c })));
  if (bad.length === 0) return null;
  return {
    text: String(bad.length),
    tone: bad.every(({ c }) => c.state === "healing") ? "lichen" : "rust",
    title: bad.map(({ backend, c }) => `${backend}: ${c.label} (${c.state})`).join("\n"),
  };
}

/** a sprout still on its way, approving included */
const MOVING = new Set<SproutStatus>(["queued", "clarifying", "researching", "building", "testing", "accepting", "deploying", "approving"]);

/** the incubator tab: sprouts still moving, rust while one waits for a yes */
export function incubatorBadge(sprouts: readonly Pick<Sprout, "status">[]): Badge | null {
  const moving = sprouts.filter((s) => MOVING.has(s.status));
  if (moving.length === 0) return null;
  const approving = moving.filter((s) => s.status === "approving").length;
  return {
    text: String(moving.length),
    tone: approving > 0 ? "rust" : "sky",
    title: `${plural(moving.length, "sprout")} on the way${approving > 0 ? `, ${approving} waiting for your yes` : ""}`,
  };
}

/** What a group of repos holds, in sum. */
export interface GroupSum {
  dirty: number;
  added: number;
  deleted: number;
  ahead: number;
  worktrees: number;
  /** agents with a turn in progress, stalled ones too */
  working: number;
  /** agents stopped on you: a permission or a question */
  waiting: number;
  /** agents open between turns that ask nothing, background work or not */
  idle: number;
}

/** A group's sum: repos with changes, the lines their tracked changes come
 *  to (a backend that sends none adds none), commits not pushed, worktrees
 *  holding work, and the live agents on them by status, each counted once. */
export function groupSum<C extends StateCard & Pick<AgentCard, "id">>(
  repos: readonly Pick<Repo, "status">[],
  agents: readonly (readonly C[])[],
  status: (c: C) => AgentStatus = byState,
): GroupSum {
  const out: GroupSum = { dirty: 0, added: 0, deleted: 0, ahead: 0, worktrees: 0, working: 0, waiting: 0, idle: 0 };
  for (const r of repos) {
    const st = r.status;
    if (!st) continue;
    if (st.files.length > 0) out.dirty++;
    out.added += st.lines?.added ?? 0;
    out.deleted += st.lines?.deleted ?? 0;
    out.ahead += st.ahead;
    out.worktrees += st.elsewhere?.worktrees.length ?? 0;
  }
  const seen = new Set<string>();
  for (const c of agents.flat()) {
    if (seen.has(c.id) || !isLiveAgent(c)) continue;
    seen.add(c.id);
    const s = status(c);
    if (s === "working" || s === "stalled") out.working++;
    else if (s === "waiting") out.waiting++;
    else out.idle++;
  }
  return out;
}

export type SumKind = "dirty" | "added" | "deleted" | "ahead" | "worktrees" | "working" | "waiting";

/** One piece of a group heading, tinted by `.t-*` or the line colours;
 *  `glyph` goes before the number in a span of its own. */
export interface SumPart {
  kind: SumKind;
  glyph?: string;
  text: string;
  cls: string;
  title: string;
}

/** The grid heading's pieces, left to right; `compact` (the narrow tree)
 *  keeps the dirty count, the lines (shortened past 999) and the agents,
 *  and leaves the rest to `sumTitle`. */
export function sumParts(s: GroupSum, compact = false): SumPart[] {
  const out: SumPart[] = [];
  const n = compact ? tokenCount : String;
  if (s.dirty > 0) out.push({ kind: "dirty", text: `${s.dirty}●`, cls: "t-lichen", title: `${plural(s.dirty, "repo")} with uncommitted changes` });
  const lines = "lines the tracked changes add and remove against HEAD";
  if (s.added > 0) out.push({ kind: "added", text: `+${n(s.added)}`, cls: "n-add", title: lines });
  if (s.deleted > 0) out.push({ kind: "deleted", text: `−${n(s.deleted)}`, cls: "n-del", title: lines });
  if (!compact) {
    if (s.ahead > 0) out.push({ kind: "ahead", text: `↑${s.ahead}`, cls: "t-sky", title: `${plural(s.ahead, "commit")} not pushed` });
    if (s.worktrees > 0) out.push({ kind: "worktrees", text: `⧉ ${s.worktrees}`, cls: "t-lichen", title: `${plural(s.worktrees, "worktree")} holding work` });
  }
  if (s.working > 0) {
    const idle = s.idle > 0 ? `, ${s.idle} more open and idle` : "";
    out.push({ kind: "working", glyph: AGENT_GLYPH, text: String(s.working), cls: "t-sky sum-live", title: `${plural(s.working, "agent")} working right now${idle}` });
  }
  if (s.waiting > 0) {
    out.push({ kind: "waiting", glyph: WAITING_GLYPH, text: String(s.waiting), cls: "t-rust", title: `${plural(s.waiting, "agent")} waiting on you: a permission or a question` });
  }
  return out;
}

/** a piece as it reads: its glyph, then its text */
export const partText = (p: Pick<SumPart, "glyph" | "text">): string => (p.glyph ? `${p.glyph} ${p.text}` : p.text);

/** every piece in words, at full numbers, for the compact heading's tooltip */
export const sumTitle = (s: GroupSum): string => sumParts(s).map((p) => `${partText(p)}: ${p.title}`).join("\n");
