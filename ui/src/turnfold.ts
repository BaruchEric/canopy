/** The folded timeline (FR-079): at the intermediate level a turn's commands
 *  and tool calls fold into one line, "worked for 40s · 12 steps", and what a
 *  person reads stays in view: their own messages, Claude's words, canopy's
 *  remarks and any step that failed. A fold is a run of two or more tool
 *  steps with nothing else between them, so the steps keep their order and a
 *  message is never moved or wrapped. Pure; tested in turnfold.test.ts. */

import type { RunStep } from "../../src/core/types";
import type { StepNode } from "./runs";

/** A run of a turn's tool steps, folded into one line. */
export interface Fold {
  kind: "fold";
  /** the first step's id: the same for as long as the fold grows */
  id: string;
  /** which turn it is in: 0 before the person's first message, then one more for each */
  turn: number;
  nodes: StepNode[];
  /** from the fold's first step to the step after its last, or to the
   *  timeline's end for a fold nothing follows; null when that end is not known */
  ms: number | null;
  /** the turn is still going and this is where it is; `stepInFlight` names its running step */
  live: boolean;
}

/** One line of the timeline: a step as it is, or a fold. */
export type TimelineItem = { kind: "step"; turn: number; node: StepNode } | Fold;

/** a tool step that failed, or an Agent call with a failed step under it:
 *  never folded away */
export const failed = (n: StepNode): boolean => n.step.tool?.status === "error" || n.kids.some((k) => k.tool?.status === "error");

/** a step a fold may take: a tool call that did not fail */
const folds = (n: StepNode): boolean => n.step.kind === "tool" && n.step.tool !== undefined && !failed(n);

/** The step in flight on a live fold: the last one still running, a
 *  subagent's before the Agent call that holds it. Null on a fold that is
 *  done, and on a live one between two calls. */
export function stepInFlight(f: Pick<Fold, "nodes" | "live">): RunStep | null {
  if (!f.live) return null;
  for (let i = f.nodes.length - 1; i >= 0; i--) {
    const n = f.nodes[i];
    if (!n) continue;
    const kid = [...n.kids].reverse().find((k) => k.tool?.status === "running");
    if (kid) return kid;
    if (n.step.tool?.status === "running") return n.step;
  }
  return null;
}

/**
 * The timeline's steps with each turn's commands folded. `live` says the run
 * is at work, so a fold at the very end is the turn in flight; `end` is when
 * the timeline ends for a fold nothing follows: now while the run works,
 * the run's end once it has one.
 *
 * A run of one tool step is left as the step: a fold of one would hide its
 * command behind a line the same height.
 */
export function foldTurns(nodes: readonly StepNode[], o: { live: boolean; end: number | null }): TimelineItem[] {
  const out: TimelineItem[] = [];
  let turn = 0;
  let run: StepNode[] = [];
  const flush = (next: StepNode | undefined) => {
    const [first] = run;
    if (!first) return;
    if (run.length < 2) {
      out.push({ kind: "step", turn, node: first });
    } else {
      const last = next === undefined;
      const until = next ? next.step.at : o.end;
      const ms = until === null ? null : Math.max(0, until - first.step.at);
      out.push({ kind: "fold", id: first.step.id, turn, nodes: run, ms, live: last && o.live });
    }
    run = [];
  };
  for (const n of nodes) {
    if (folds(n)) {
      run.push(n);
      continue;
    }
    flush(n);
    if (n.step.kind === "user") turn++;
    out.push({ kind: "step", turn, node: n });
  }
  flush(undefined);
  return out;
}

/** how long, in the fewest words that stay honest: 40s, 1m 35s, 2h 5m */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** The fold's line: "worked for 40s · 12 steps", "working for 40s · 12
 *  steps" while the turn is live. Under a second, or with no end known, the
 *  time is left out. */
export function foldWords(f: Pick<Fold, "nodes" | "ms" | "live">): string {
  const steps = `${f.nodes.length} steps`;
  if (f.ms === null || f.ms < 1000) return f.live ? `working · ${steps}` : steps;
  return `${f.live ? "working" : "worked"} for ${took(f.ms)} · ${steps}`;
}
