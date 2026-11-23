/** A repo card's state for the board's "state" grouping (FR-079): whether
 *  something on it needs you, is at work, finished and still sits there, or
 *  none of those. One answer a card, the most pressing first, read off what
 *  the card already shows: its live row's agents (cardlive.ts), canopy's own
 *  runs and workflows on its checkouts, and the row's trace. Pure; tested in
 *  boardstate.test.ts. The store gathers the facts (`boardStates`). */

import type { AgentStatus } from "../../src/core/agentstatus";
import { isFlowActive, type Flow, type Run } from "../../src/core/types";
import { TRACE_MS } from "./cardlive";

/** the states, the most pressing first: the order the board lists its groups in */
export const BOARD_STATES = ["needs", "working", "unread", "idle"] as const;
export type BoardState = (typeof BOARD_STATES)[number];

export interface CardFacts {
  /** the status of every agent still running on the card (core/agentstatus),
   *  as its live row reads them */
  agents: readonly AgentStatus[];
  /** canopy's own runs on the card's checkouts that no flow owns: the ones
   *  going, and the finished ones not dismissed yet */
  runs: readonly Pick<Run, "status" | "steps">[];
  /** the workflows in the card's checkouts: going, or finished and not dismissed yet */
  flows: readonly Pick<Flow, "status">[];
  /** when the last agent or task left the live row (cardlive's `lastEnded`),
   *  unix ms; null when nothing has */
  endedAt: number | null;
}

/** a chat between turns that Claude has said something in: its answer waits
 *  to be read. One with nothing said yet has nothing to read. */
const answered = (r: Pick<Run, "status" | "steps">): boolean => r.status === "idle" && r.steps.some((s) => s.kind === "text" || s.kind === "tool");

/** a run that ended and still sits on its card: done, failed, stopped or out of capacity */
const ended = (r: Pick<Run, "status">): boolean => r.status === "done" || r.status === "failed" || r.status === "stopped" || r.status === "limited";

/**
 * The card's state.
 *
 * Needs you is what the live row means by it: an agent that waits on a
 * permission or a question (never one at its prompt with nothing asked).
 * A run with a prompt open and a workflow parked at a gate are the same
 * fact in canopy's own records, which is all a backend without the agent
 * registry has, and what the card's leaf edge already paints as waiting.
 *
 * Working is an agent, a run or a workflow in the middle of a turn. A
 * stalled agent's turn has not ended, so it is still here; one whose work
 * runs on in the background is at its prompt, and is not.
 *
 * Unread is the nearest thing canopy has to it, since nothing records what
 * a person has read: something finished here and has not been put away. A
 * run or a workflow that ended and was not dismissed, a chat between turns
 * that Claude answered in, or the row's trace, an agent that ended or a
 * task that finished inside `TRACE_MS`.
 *
 * Everything else is idle.
 */
export function cardState(f: CardFacts, now: number): BoardState {
  if (f.agents.includes("waiting") || f.runs.some((r) => r.status === "waiting") || f.flows.some((w) => w.status === "waiting" || w.status === "gated")) return "needs";
  if (f.agents.some((s) => s === "working" || s === "stalled") || f.runs.some((r) => r.status === "working") || f.flows.some((w) => w.status === "working")) return "working";
  if (f.runs.some((r) => ended(r) || answered(r)) || f.flows.some((w) => !isFlowActive(w)) || (f.endedAt !== null && now < f.endedAt + TRACE_MS)) return "unread";
  return "idle";
}

/** a card's state by its lead checkout, for `groupRepos`; a card the map
 *  does not hold is idle */
export const stateIn =
  (states: Readonly<Record<string, BoardState>>) =>
  (r: { id: string }): BoardState =>
    states[r.id] ?? "idle";
