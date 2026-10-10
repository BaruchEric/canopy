/** What the page says about the ranger, canopy's always-on agent: the
 *  words for its state, which backends' rangers the chip shows, how worried
 *  the chip looks, and its wakes and transcript in a few words. Pure. */

import { cardIdle } from "../../src/core/ranger";
import { isLiveAgent, type AgentCard, type RangerInfo, type RangerState, type RangerWake } from "../../src/core/types";

export const RANGER_WORD: Record<RangerState, string> = {
  off: "off",
  starting: "starting",
  trust: "waiting at Claude's trust prompt",
  running: "running",
  backoff: "restarting",
  "gave-up": "gave up",
  "handle-taken": "its handle is taken",
  "no-tmux": "no tmux here",
  "no-claude": "no Claude Code here",
  error: "cannot start",
};

/** how the chip looks: fine, on its way, needing someone, or off */
export type RangerTone = "ok" | "busy" | "warn" | "off";

export function rangerTone(r: RangerInfo, card?: AgentCard): RangerTone {
  if (!r.on) return "off";
  if (r.state === "running") return card && card.state === "waiting" && !cardIdle(card) ? "warn" : "ok";
  if (r.state === "starting" || r.state === "backoff") return "busy";
  return "warn";
}

const TONE_RANK: Record<RangerTone, number> = { off: 0, ok: 1, busy: 2, warn: 3 };

/** the worst of several, which is the chip's */
export const worstTone = (tones: readonly RangerTone[]): RangerTone => tones.reduce<RangerTone>((a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a), "off");

/** the rangers the chip shows, in the page's backend order: each one that is on */
export function shownRangers(rangers: Record<string, RangerInfo>, order: readonly string[]): [string, RangerInfo][] {
  const names = [...order, ...Object.keys(rangers).filter((n) => !order.includes(n))];
  return names.flatMap((n): [string, RangerInfo][] => {
    const r = rangers[n];
    return r?.on ? [[n, r]] : [];
  });
}

/** its live card, by the conversation it is on: working, idle or waiting */
export function rangerCard(cards: Record<string, AgentCard>, r: RangerInfo): AgentCard | undefined {
  if (!r.session) return undefined;
  return Object.values(cards).find((c) => c.session === r.session && isLiveAgent(c));
}

/** one line for what it is doing: its card's state while it runs, else the hub's word */
export function rangerLine(r: RangerInfo, card?: AgentCard): string {
  if (r.state === "running" && card) return cardIdle(card) ? "idle" : card.state === "waiting" ? `waiting on you${card.waiting ? `: ${card.waiting}` : ""}` : card.state;
  return RANGER_WORD[r.state];
}

/** "320 KB", "4.2 MB" */
export function sizeWord(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "5m", "3h", "2d" */
function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** when a wake fires, in a few words */
export function wakeWhen(w: RangerWake, now: number): string {
  if (w.run) return `when run ${w.run} ends`;
  const due = w.next !== undefined && w.next <= now ? "due now" : w.next !== undefined ? `next in ${span(w.next - now)}` : "";
  if (w.cron) return `cron ${w.cron}${due ? ` · ${due}` : ""}`;
  return due || "at a time";
}

/** the conversations the rangers are on: their cards are reached by DM, so
 *  an idle prompt there is never "your turn" in waiting on you */
export const rangerSessions = (rangers: Record<string, RangerInfo>): Set<string> =>
  new Set(Object.values(rangers).flatMap((r) => (r.on && r.session ? [r.session] : [])));

/** the crons Eric set, which Settings lists; the ranger's own are in the chip */
export const ericsCrons = (r: RangerInfo): RangerWake[] => r.wakes.filter((w) => w.by === "eric" && w.cron !== undefined);
