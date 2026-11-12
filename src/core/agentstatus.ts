/**
 * What a hooked agent is doing, as every view says it: its registry card's
 * state read finer, with what canopy knows beside it. Browser-safe and pure;
 * tested in agentstatus.test.ts.
 *
 * The broker's card says working, idle or waiting. Claude's own notice a
 * minute after a turn ends reaches the card as waiting "your turn"
 * (tailchan's `idle_prompt`), and Codex's Stop says the same, so a waiting
 * card is often a session at its prompt with nothing asked. That reads as
 * idle here. Only a wait on something else (a permission, a question) or
 * an open ask on the card is "waiting on you". The pulse its own backend
 * reads in the transcript (server/pulse.ts) adds two more: background, for
 * an idle session with a shell, monitor or agent it started still going,
 * and stalled, for a working one that has written nothing for minutes.
 */

import { isLiveAgent, type AgentActivity, type AgentCard, type AgentPulse, type AgentState } from "./types";

/** what tailchan's hook says a session at its prompt waits on */
export const YOUR_TURN = "your turn";

/** the statuses, the most pressing first */
export const AGENT_STATUSES = ["waiting", "stalled", "working", "background", "idle", "lost", "ended"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** the statuses of an agent still running */
export const LIVE_STATUSES: readonly AgentStatus[] = ["waiting", "stalled", "working", "background", "idle"];

/** how long a working agent may write nothing, in no tool call, before it reads as stalled */
export const STALL_MS = 10 * 60_000;
/** how long one tool call may run before it reads as stalled. A shell
 *  command times out by ten minutes, so one open for this long never got its
 *  result; a subagent (`SUBAGENT_TOOLS`) may take longer and is never stalled. */
export const TOOL_STALL_MS = 30 * 60_000;
/** how long a tool call runs before the pulse names it */
export const TOOL_SHOWN = 60_000;
/** how far before its card's start a background task may have started and
 *  still be this run's: the card's start is the broker's clock or the hook's */
const START_SLACK = 2 * 60_000;

/** the tools whose call is a subagent at work, which may run for long */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

type CardState = Pick<AgentCard, "state" | "waiting">;

/** Whether a card says its agent sits at its prompt: idle, or waiting
 *  "your turn". A permission or a question waiting is not. */
export const cardIdle = (c: CardState): boolean => c.state === "idle" || (c.state === "waiting" && c.waiting === YOUR_TURN);

/** Whether a card waits on the person: any wait but its turn. A wait with
 *  no word is one too, the safe side. */
export const cardAsks = (c: CardState): boolean => c.state === "waiting" && c.waiting !== YOUR_TURN;

/** what besides the card goes into its status */
export interface StatusFacts {
  /** what its own backend last read in its transcript */
  pulse?: AgentPulse | undefined;
  /** an ask of its is open */
  asking?: boolean;
}

/** how much background work a pulse counts */
export const backgroundCount = (p: Pick<AgentPulse, "shells" | "monitors" | "agents">): number => p.shells + p.monitors + p.agents;

/**
 * A card's status: ended and lost as the card says; waiting on you while
 * it asks (`cardAsks`, or an ask open on it); stalled or working while it
 * works; background or idle at its prompt.
 */
export function agentStatus(c: CardState, f: StatusFacts = {}): AgentStatus {
  if (c.state === "ended" || c.state === "lost") return c.state;
  if (f.asking === true || cardAsks(c)) return "waiting";
  if (c.state === "working") return f.pulse && f.pulse.stalledSince !== null ? "stalled" : "working";
  return f.pulse && backgroundCount(f.pulse) > 0 ? "background" : "idle";
}

export const isLiveStatus = (s: AgentStatus): boolean => LIVE_STATUSES.includes(s);

/** "1 shell, 2 monitors": the background work, the way Claude Code's own
 *  footer counts it; "" for none */
export function backgroundWord(p: Pick<AgentPulse, "shells" | "monitors" | "agents">): string {
  const n = (k: number, w: string): string[] => (k > 0 ? [`${k} ${w}${k === 1 ? "" : "s"}`] : []);
  return [...n(p.shells, "shell"), ...n(p.monitors, "monitor"), ...n(p.agents, "agent")].join(", ");
}

/**
 * A status in a few words, with what it is about: "waiting on you:
 * permission", "working: Bash", "background: 1 shell", "stalled", "idle".
 */
export function statusWord(c: CardState, f: StatusFacts = {}): string {
  const s = agentStatus(c, f);
  switch (s) {
    case "waiting":
      return cardAsks(c) && c.waiting ? `waiting on you: ${c.waiting}` : "waiting on you";
    case "working":
      return f.pulse?.tool ? `working: ${f.pulse.tool.name}` : "working";
    case "stalled":
      return f.pulse?.tool ? `stalled in ${f.pulse.tool.name}` : "stalled";
    case "background":
      return f.pulse ? `background: ${backgroundWord(f.pulse)}` : "background";
    default:
      return s;
  }
}

/**
 * What a backend says about one of its own live agents at `now`, from its
 * card and its transcript's reading (core/activity). Background work counts
 * from the card's start, since a resumed session's earlier tasks ended with
 * the process before it, and a monitor past its own timeout is over. A tool
 * call is named once it has run `TOOL_SHOWN`. A working card stalls when
 * nothing reached its transcript for `STALL_MS` outside a tool call, or one
 * call that is no subagent has run `TOOL_STALL_MS`.
 */
export function pulseOf(card: Pick<AgentCard, "id" | "state" | "startedAt">, a: Pick<AgentActivity, "background" | "tool" | "writtenAt">, now: number): AgentPulse {
  const open = a.background.filter((b) => (b.at === null || b.at >= card.startedAt - START_SLACK) && (b.until === null || b.until > now));
  const count = (kind: string): number => open.filter((b) => b.kind === kind).length;
  const call = a.tool && a.tool.at !== null ? { name: a.tool.name, at: a.tool.at } : null;
  let stalledSince: number | null = null;
  if (card.state === "working") {
    if (!a.tool && now - a.writtenAt >= STALL_MS) stalledSince = a.writtenAt;
    else if (call && !SUBAGENT_TOOLS.has(call.name) && now - call.at >= TOOL_STALL_MS) stalledSince = call.at;
  }
  return {
    id: card.id,
    shells: count("shell"),
    monitors: count("monitor"),
    agents: count("agent"),
    tool: call && now - call.at >= TOOL_SHOWN ? call : null,
    stalledSince,
  };
}

/** whether two pulses say the same */
export const samePulse = (a: AgentPulse | undefined, b: AgentPulse): boolean =>
  a !== undefined &&
  a.shells === b.shells &&
  a.monitors === b.monitors &&
  a.agents === b.agents &&
  a.stalledSince === b.stalledSince &&
  (a.tool?.name ?? null) === (b.tool?.name ?? null) &&
  (a.tool?.at ?? null) === (b.tool?.at ?? null);

/** a status from a card state alone, for a trail mark the page kept */
export const statusFromState = (state: AgentState, waiting: string | null | undefined): AgentStatus => agentStatus({ state, waiting: waiting ?? null });

/** whether a backend reads a card's pulse: a live one with a session to find */
export const pulsed = (c: Pick<AgentCard, "state" | "session">): boolean => isLiveAgent(c) && c.session !== null;
