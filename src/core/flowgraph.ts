/** A workflow's steps as a graph (FR-034): the column each step sits in,
 *  the edges between them, and the repo's modes laid over them. Pure and
 *  browser-safe. `ui/src/flowgraph.ts` turns the columns into boxes and
 *  wires for the flow sheet; `src/cli/workflow.ts` into indented text and
 *  Graphviz DOT. */

import { applyModes, type FlowModes } from "./flowmodes";
import type { GraphStep, StepMode, StepWhen, Workflow, WorkflowGraph } from "./types";

/** `after`: the step `to` waits for `from`. `back`: `from`'s retries send
 *  the flow back to `to`, an earlier step. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: "after" | "back";
  /** on an `after` edge into a step with conditions: the step's `when` */
  when?: StepWhen[];
}

export interface StepColumns {
  /** step names by column, left to right; a column's own order puts each
   *  step near the steps it waits for */
  columns: string[][];
  /** each step's column: the longest `after` path from a step that waits
   *  for none */
  depth: Record<string, number>;
  edges: GraphEdge[];
}

const ALWAYS: readonly StepWhen[] = ["always"];

const conditional = (when: readonly StepWhen[]): boolean => !(when.length === 1 && when[0] === ALWAYS[0]);

/** Whether the steps run as a chain: each waits for the one above, with no
 *  condition. A chain keeps the strip; anything else gets the graph. */
export function isChain(steps: readonly Pick<GraphStep, "name" | "after" | "when">[]): boolean {
  return steps.every((s, i) => {
    const above = steps[i - 1];
    const chained = above ? s.after.length === 1 && s.after[0] === above.name : s.after.length === 0;
    return chained && !conditional(s.when);
  });
}

/** The columns and edges for steps as the parser leaves them: `after`
 *  names earlier headings only, so one pass in heading order finds every
 *  depth. A name `after` does not find (an old record's step) counts as a
 *  root. */
export function graphOf(steps: readonly GraphStep[]): StepColumns {
  const depth: Record<string, number> = {};
  for (const s of steps) {
    let d = 0;
    for (const name of s.after) {
      const before = depth[name];
      if (before !== undefined) d = Math.max(d, before + 1);
    }
    depth[s.name] = d;
  }
  const count = steps.reduce((n, s) => Math.max(n, (depth[s.name] ?? 0) + 1), 0);
  const columns: string[][] = Array.from({ length: count }, () => []);
  // each step's place in its column, centred on 0, so columns of different
  // heights compare as the picture centres them
  const place: Record<string, number> = {};
  const pull = (s: GraphStep): number => {
    const at = s.after.map((name) => place[name]).filter((p): p is number => p !== undefined);
    return at.length === 0 ? 0 : at.reduce((a, b) => a + b, 0) / at.length;
  };
  for (let c = 0; c < count; c++) {
    const here = steps.filter((s) => depth[s.name] === c);
    // a stable sort keeps heading order among steps that pull the same way
    const ordered = c === 0 ? here : [...here].sort((a, b) => pull(a) - pull(b));
    const col = ordered.map((s) => s.name);
    col.forEach((name, row) => {
      place[name] = row - (col.length - 1) / 2;
    });
    columns[c] = col;
  }
  const names = new Set(steps.map((s) => s.name));
  const edges: GraphEdge[] = [];
  for (const s of steps) {
    for (const from of s.after) {
      if (!names.has(from)) continue;
      edges.push({ from, to: s.name, kind: "after", ...(conditional(s.when) ? { when: [...s.when] } : {}) });
    }
  }
  for (const s of steps) {
    if (s.retries > 0 && s.back !== s.name && names.has(s.back)) edges.push({ from: s.name, to: s.back, kind: "back" });
  }
  return { columns, depth, edges };
}

/** The fields of a step the graph reads. */
export function graphStep(s: GraphStep): GraphStep {
  return {
    name: s.name,
    after: [...s.after],
    when: [...s.when],
    mode: s.mode,
    ...(s.modeFrom ? { modeFrom: s.modeFrom } : {}),
    gate: s.gate,
    check: s.check,
    retries: s.retries,
    back: s.back,
  };
}

/** The modes file as read at HEAD: its modes, or why it cannot be read. */
export type ModesRead = { ok: true; modes: FlowModes } | { ok: false; error: string };

/** What the workflows list carries for one workflow: its steps with the
 *  repo's modes laid over, the repo's word on each step it decides, and the
 *  file's warnings. A file that cannot be read leaves the workflow's own
 *  modes and says why. */
export function workflowGraph(wf: Workflow, read: ModesRead): WorkflowGraph {
  if (!read.ok) return { steps: wf.steps.map(graphStep), modes: {}, warnings: [], error: read.error };
  const { workflow, warnings } = applyModes(wf, read.modes);
  const modes: Record<string, StepMode> = {};
  for (const s of workflow.steps) if (s.modeFrom === "repo") modes[s.name] = s.mode;
  return { steps: workflow.steps.map(graphStep), modes, warnings };
}
