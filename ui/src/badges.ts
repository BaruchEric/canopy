/** The live counts on the view tabs and the grove's group headings. Pure,
 *  so each number is tested and agrees with the place it summarises: the
 *  attention pill, the registry, the health view, the incubator, the card. */

import { isLiveAgent, type AgentCard, type HealthCheck, type Repo, type Sprout, type SproutStatus } from "../../src/core/types";

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

/** the agents tab: the home broker's live agents, rust while one waits,
 *  as the card's ✦ chip */
export function agentsBadge(cards: readonly Pick<AgentCard, "state">[]): Badge | null {
  const live = cards.filter(isLiveAgent);
  if (live.length === 0) return null;
  const waiting = live.filter((c) => c.state === "waiting").length;
  const working = live.filter((c) => c.state === "working").length;
  const words = [waiting && `${waiting} waiting`, working && `${working} working`, live.length - waiting - working && `${live.length - waiting - working} idle`].filter(Boolean).join(", ");
  return { text: `✦ ${live.length}`, tone: waiting > 0 ? "rust" : "sky", title: `${plural(live.length, "agent")} running on the broker: ${words}` };
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
  agents: number;
  waiting: number;
}

/** A group's sum: repos with changes, the lines their tracked changes come
 *  to (a backend that sends none adds none), commits not pushed, worktrees
 *  holding work, and the live agents on them, each counted once. */
export function groupSum(repos: readonly Pick<Repo, "status">[], agents: readonly (readonly Pick<AgentCard, "id" | "state">[])[]): GroupSum {
  const out: GroupSum = { dirty: 0, added: 0, deleted: 0, ahead: 0, worktrees: 0, agents: 0, waiting: 0 };
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
    out.agents++;
    if (c.state === "waiting") out.waiting++;
  }
  return out;
}

/** One piece of a group heading, tinted by `.t-*` or the line colours. */
export interface SumPart {
  text: string;
  cls: string;
  title: string;
}

/** The grid heading's pieces, left to right; `compact` (the narrow tree)
 *  keeps the dirty count and the agents and leaves the rest to `sumTitle`. */
export function sumParts(s: GroupSum, compact = false): SumPart[] {
  const out: SumPart[] = [];
  if (s.dirty > 0) out.push({ text: `${s.dirty}●`, cls: "t-lichen", title: `${plural(s.dirty, "repo")} with uncommitted changes` });
  if (!compact) {
    const lines = "lines the tracked changes add and remove against HEAD";
    if (s.added > 0) out.push({ text: `+${s.added}`, cls: "n-add", title: lines });
    if (s.deleted > 0) out.push({ text: `−${s.deleted}`, cls: "n-del", title: lines });
    if (s.ahead > 0) out.push({ text: `↑${s.ahead}`, cls: "t-sky", title: `${plural(s.ahead, "commit")} not pushed` });
    if (s.worktrees > 0) out.push({ text: `⧉ ${s.worktrees}`, cls: "t-lichen", title: `${plural(s.worktrees, "worktree")} holding work` });
  }
  if (s.agents > 0) {
    out.push({
      text: `✦ ${s.agents}`,
      cls: s.waiting > 0 ? "t-rust" : "t-sky",
      title: `${plural(s.agents, "agent")} running${s.waiting > 0 ? `, ${s.waiting} waiting` : ""}`,
    });
  }
  return out;
}

/** every piece in words, for the compact heading's tooltip */
export const sumTitle = (s: GroupSum): string => sumParts(s).map((p) => `${p.text}: ${p.title}`).join("\n");
