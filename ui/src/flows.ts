/** Words and arithmetic for flows and fleets in the UI. Pure. */

import { isFlowActive, type Fleet, type Flow, type FlowStep, type Repo, type Run } from "../../src/core/types";

/** True for a run no flow owns. A flow's step runs stay off the cards and out
 *  of the top bar, since the flow's own chip already speaks for them. */
export const ownRun = (flowRuns: Record<string, string>, run: Run): boolean => !flowRuns[run.id];

export const STEP_WORD: Record<FlowStep["status"], string> = {
  pending: "waiting its turn",
  running: "the agent is working",
  checking: "running the check",
  gated: "waiting for you",
  held: "waiting for your go",
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
      return long ? `${flow.verb}: the agent needs you` : "needs you";
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

/** A gate's ways on, as its buttons word them: what each will do. */
export interface GateWords {
  /** the continue button */
  go: string;
  /** the retry button; null when the park has one way on and both choices mean it */
  retry: string | null;
  /** The button to lead with. It is the retry when the gate said no to the
   *  work (its check failed, or its verdict or its judge refused), since
   *  going on then overrides that no. */
  lead: "go" | "retry";
  /** what going on does, for a tooltip, where the word leaves it out */
  title?: string;
}

/** whether the step a flow is parked at said no to the work */
const refusedAt = (step: FlowStep | undefined): boolean =>
  step !== undefined && ((step.check !== undefined && step.check.exit !== 0) || step.verdict?.go === false || step.judgment?.go === false);

export function gateWords(flow: Flow): GateWords {
  const one = (go: string, title: string): GateWords => ({ go, retry: null, lead: "go", title });
  if (flow.parkedFor === "budget") return one("allow one more step", "The budget is spent; this lets one more step run, then it parks again");
  if (flow.parkedFor === "stage") {
    const what = flow.stageCheck ? "check" : "step";
    return one(`run the ${what} again`, `The stage runner was not answering; this runs the ${what} again, and it parks again if the runner is still away`);
  }
  if (flow.parkedFor === "failed") return one("run the step again", "The step's run ended in an error; this runs that step again, and the steps before it stand");
  if (flow.parkedFor === "capacity") return one("start anyway", "Held for Claude's usage limit; this starts the step now");
  const step = flow.steps[flow.current];
  if (step?.status === "held") return { go: `start ${step.name}`, retry: "retry this step", lead: "go" };
  const on = flow.current + 1 >= flow.steps.length ? "accept and finish" : `continue to ${flow.steps[flow.current + 1]?.name ?? "the next step"}`;
  if (!refusedAt(step)) return { go: on, retry: "retry this step", lead: "go" };
  // A retry of the refusing step alone would ask it about the same work, so
  // it goes back to the step that made the work when the workflow names one.
  return {
    go: `${on} anyway`,
    retry: flow.backTo ? `send it back to ${flow.backTo}` : "retry this step",
    lead: "retry",
    title: `${step?.name ?? "This step"} did not accept the work; this goes on with the work as it is`,
  };
}

/** a gate nothing more is known about: go on, or the step again */
export const PLAIN_GATE: GateWords = { go: "continue", retry: "retry this step", lead: "go" };

/** The action a gate's continue button will actually take. */
export const continueWord = (flow: Flow): string => gateWords(flow).go;

export interface GateButton {
  choice: "continue" | "retry";
  word: string;
  title?: string;
  /** the one to lead with, drawn strong */
  strong: boolean;
}

/** A gate's buttons in the order they are drawn: the one to lead with
 *  first, since the first button is the one a hurried hand takes. */
export function gateButtons(words: GateWords): GateButton[] {
  const go: GateButton = { choice: "continue", word: words.go, ...(words.title ? { title: words.title } : {}), strong: words.lead === "go" };
  if (words.retry === null) return [{ ...go, strong: true }];
  const retry: GateButton = { choice: "retry", word: words.retry, strong: words.lead === "retry" };
  return words.lead === "retry" ? [retry, go] : [go, retry];
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

/** Whether a fleet may be pointed at this repo from this browser: a local
 *  checkout git can read. A forge card has no checkout and flows are local-only. */
export const pickable = (r: Repo): boolean => !r.forge && !r.error && !r.host;

/** The repos a fleet may be pointed at from this browser. */
export const selectable = (repos: Repo[]): Repo[] => repos.filter(pickable);

/** "4 of 30 runs, 1.2h of 6h" for a flow with a budget, null without one. */
export function budgetWord(flow: Flow): string | null {
  if (!flow.budget) return null;
  const s = flow.spent ?? { runs: 0, workMs: 0 };
  const hours = Math.round(s.workMs / 360_000) / 10;
  return `${s.runs} of ${flow.budget.runs} ${flow.budget.runs === 1 ? "run" : "runs"}, ${hours}h of ${flow.budget.hours}h`;
}

/** One line per rewind, oldest first. */
export const rewindLines = (flow: Flow): string[] =>
  (flow.rewinds ?? []).map((r) =>
    r.from === r.to ? `${r.from} tried again: ${r.reason}` : `${r.from} sent it back to ${r.to}: ${r.reason}`,
  );
