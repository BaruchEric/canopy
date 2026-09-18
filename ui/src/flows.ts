/** Words and arithmetic for flows and fleets in the UI. Pure. */

import { isFlowActive, type Fleet, type Flow, type FlowStep, type Repo, type Run } from "../../src/core/types";

/** True for a run no flow owns. A flow's step runs stay off the cards and out
 *  of the top bar, since the flow's own chip already speaks for them. */
export const ownRun = (flowRuns: Record<string, string>, run: Run): boolean => !flowRuns[run.id];

export const STEP_WORD: Record<FlowStep["status"], string> = {
  pending: "waiting its turn",
  running: "claude is working",
  checking: "running the check",
  gated: "waiting for you",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
};

export const stepWord = (step: FlowStep): string => STEP_WORD[step.status];

/** The chip's word for a flow, short on a card and long in a panel. */
export function flowWord(flow: Flow, long: boolean): string {
  const step = flow.steps[flow.current];
  const name = step?.name ?? "";
  switch (flow.status) {
    case "working":
      return long ? `${flow.verb}, step ${flow.current + 1} of ${flow.steps.length}: ${name}` : `${flow.verb}: ${name}…`;
    case "waiting":
      return long ? `${flow.verb}: claude needs you` : "needs you";
    case "gated":
      return long ? `${flow.verb}: ${name} is waiting for you` : "needs you";
    case "done":
      if (flow.outcome === "unchanged") return long ? `${flow.verb}: no change` : "no change";
      return long ? `${flow.verb} done` : "done";
    case "failed":
      return long ? `${flow.verb} failed` : "failed";
    case "stopped":
      return long ? `${flow.verb} stopped` : "stopped";
  }
}

export interface FleetCounts {
  pending: number;
  active: number;
  needsYou: number;
  done: number;
  failed: number;
  skipped: number;
}

export function fleetCounts(fleet: Fleet, flows: Record<string, Flow>): FleetCounts {
  const c: FleetCounts = { pending: 0, active: 0, needsYou: 0, done: 0, failed: 0, skipped: 0 };
  for (const r of fleet.repos) {
    if (r.skipped) c.skipped += 1;
    else if (!r.flowId) c.pending += 1;
    else {
      const f = flows[r.flowId];
      if (!f) c.pending += 1;
      else if (isFlowActive(f)) {
        c.active += 1;
        if (f.status === "gated" || f.status === "waiting") c.needsYou += 1;
      } else if (f.status === "done") c.done += 1;
      else c.failed += 1;
    }
  }
  return c;
}

/** The parked or waiting flow that has been so the longest, by start time. */
export function oldestParked(fleet: Fleet, flows: Record<string, Flow>): Flow | undefined {
  let best: Flow | undefined;
  for (const r of fleet.repos) {
    const f = r.flowId ? flows[r.flowId] : undefined;
    if (!f || (f.status !== "gated" && f.status !== "waiting")) continue;
    if (!best || f.startedAt < best.startedAt) best = f;
  }
  return best;
}

/** The repos a fleet may be pointed at from this browser. */
export const selectable = (repos: Repo[]): Repo[] => repos.filter((r) => !r.forge && !r.error && !r.host);
