/** The workflow graph on the flow sheet (FR-034): the boxes, wires and
 *  condition diamonds `StepGraph` draws, laid out from core/flowgraph.ts's
 *  columns, and the short state word in each box. Pure; the component only
 *  draws what this returns. */

import { graphOf, graphStep, isChain } from "../../src/core/flowgraph";
import type { Flow, GraphStep, StepStatus, WorkflowEntry } from "../../src/core/types";

/** a box's width; its height grows a line when any step has a condition */
export const NODE_W = 120;
const NODE_H = 38;
const NODE_H_WHEN = 50;
const PAD = 4;
const COL_GAP = 36;
const ROW_GAP = 10;
/** the room above or below the boxes that a wire skipping a column, or
 *  going back, runs through */
const LANE = 18;
/** a condition's diamond: its half width, and how far its centre sits left of the box */
const DIAMOND = 5;
const DIAMOND_AT = 12;

export interface GraphNode {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  manual: boolean;
  /** the step's conditions as its box's last line, or null */
  when: string | null;
}

export interface GraphWire {
  key: string;
  kind: "after" | "back";
  d: string;
  /** whether the wire ends in an arrowhead; a wire into a condition's
   *  diamond does not, the stub from the diamond to the box does */
  arrow: boolean;
}

export interface GraphDiamond {
  /** the step the condition is on */
  name: string;
  d: string;
  label: string;
}

export interface Picture {
  width: number;
  height: number;
  nodes: GraphNode[];
  wires: GraphWire[];
  diamonds: GraphDiamond[];
}

const r = (n: number): number => Math.round(n * 10) / 10;

/** The boxes in columns by depth, each column centred on the tallest, and
 *  the wires: `after` from a box's right edge to the next one's left, over
 *  the top or under the bottom when it skips a column; `back` from a box's
 *  foot to the earlier box's, under the bottom. */
export function picture(steps: readonly GraphStep[]): Picture {
  const { columns, edges } = graphOf(steps);
  const byName = new Map(steps.map((s) => [s.name, s]));
  const anyWhen = edges.some((e) => e.when);
  const h = anyWhen ? NODE_H_WHEN : NODE_H;
  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const inner = tallest * h + (tallest - 1) * ROW_GAP;
  // each step's column and its place centred on 0, as graphOf orders them
  const col = new Map<string, number>();
  const place = new Map<string, number>();
  columns.forEach((names, c) => names.forEach((name, row) => {
    col.set(name, c);
    place.set(name, row - (names.length - 1) / 2);
  }));
  const span = (from: string, to: string): number => (col.get(to) ?? 0) - (col.get(from) ?? 0);
  const lane = (from: string, to: string): "top" | "bottom" => ((place.get(from) ?? 0) + (place.get(to) ?? 0) <= 0 ? "top" : "bottom");
  const skips = edges.filter((e) => e.kind === "after" && span(e.from, e.to) > 1);
  const up = skips.some((e) => lane(e.from, e.to) === "top") ? LANE : 0;
  const down = edges.some((e) => e.kind === "back") || skips.some((e) => lane(e.from, e.to) === "bottom") ? LANE : 0;
  const top = PAD + up;

  const nodes: GraphNode[] = [];
  const at = new Map<string, GraphNode>();
  columns.forEach((names, c) => {
    const height = names.length * h + (names.length - 1) * ROW_GAP;
    names.forEach((name, row) => {
      const s = byName.get(name);
      const conditional = s !== undefined && !(s.when.length === 1 && s.when[0] === "always");
      const node: GraphNode = {
        name,
        x: PAD + c * (NODE_W + COL_GAP),
        y: top + (inner - height) / 2 + row * (h + ROW_GAP),
        w: NODE_W,
        h,
        manual: s?.mode === "manual",
        when: conditional && s ? s.when.join(", ") : null,
      };
      nodes.push(node);
      at.set(name, node);
    });
  });

  const laneMid = { top: PAD + up / 2, bottom: top + inner + down / 2 };
  // a cubic's middle sits an eighth of the way from each end to the other
  // and three quarters of the way to its control points: put that middle
  // on the lane's centre line
  const toLane = (which: "top" | "bottom", y1: number, y2: number): number => (laneMid[which] - (y1 + y2) / 8) / 0.75;
  const wires: GraphWire[] = [];
  const diamonds: GraphDiamond[] = [];
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const key = `${e.kind}:${e.from}>${e.to}`;
    if (e.kind === "back") {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y + b.h;
      const yc = toLane("bottom", y1, y2);
      wires.push({ key, kind: "back", d: `M${r(x1)} ${r(y1)} C${r(x1)} ${r(yc)} ${r(x2)} ${r(yc)} ${r(x2)} ${r(y2)}`, arrow: true });
      continue;
    }
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    // into a condition the wire stops at the diamond's left point
    const x2 = b.when ? b.x - DIAMOND_AT - DIAMOND : b.x;
    let d: string;
    if (span(e.from, e.to) > 1) {
      const yc = toLane(lane(e.from, e.to), y1, y2);
      d = `M${r(x1)} ${r(y1)} C${r(x1 + 16)} ${r(yc)} ${r(x2 - 16)} ${r(yc)} ${r(x2)} ${r(y2)}`;
    } else {
      const mx = (x1 + x2) / 2;
      d = `M${r(x1)} ${r(y1)} C${r(mx)} ${r(y1)} ${r(mx)} ${r(y2)} ${r(x2)} ${r(y2)}`;
    }
    wires.push({ key, kind: "after", d, arrow: !b.when });
  }
  for (const n of nodes) {
    if (!n.when) continue;
    const cx = n.x - DIAMOND_AT;
    const cy = n.y + n.h / 2;
    diamonds.push({ name: n.name, label: n.when, d: `M${r(cx - DIAMOND)} ${r(cy)} L${r(cx)} ${r(cy - DIAMOND)} L${r(cx + DIAMOND)} ${r(cy)} L${r(cx)} ${r(cy + DIAMOND)} Z` });
    wires.push({ key: `stub:${n.name}`, kind: "after", d: `M${r(cx + DIAMOND)} ${r(cy)} L${r(n.x)} ${r(cy)}`, arrow: true });
  }
  const count = Math.max(1, columns.length);
  return { width: 2 * PAD + count * NODE_W + (count - 1) * COL_GAP, height: top + inner + down + PAD, nodes, wires, diamonds };
}

export const STATE_WORD: Record<StepStatus, string> = {
  pending: "waits",
  running: "working",
  checking: "checking",
  gated: "asks",
  held: "held",
  passed: "done",
  failed: "failed",
  skipped: "skipped",
};

/** a box's state in one word; the strip's longer words are its title */
export const stateWord = (status: StepStatus): string => STATE_WORD[status];

/** `text`, cut to `max` characters with an ellipsis */
export const fit = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`);

/** The steps to draw a flow's graph from: its workflow in the repo's list,
 *  with the repo's modes when the list carries them, as long as its steps
 *  are still the flow's, in order, and are not a chain. Null keeps the
 *  strip: a chain, a list not fetched yet, or a file changed since the
 *  flow started. */
export function flowGraphSteps(flow: Pick<Flow, "workflow" | "steps">, entries: readonly WorkflowEntry[] | undefined): GraphStep[] | null {
  const entry = entries?.find((e) => e.ok && e.workflow.name === flow.workflow);
  if (!entry || !entry.ok) return null;
  const steps = entry.graph?.steps ?? entry.workflow.steps.map(graphStep);
  if (steps.length !== flow.steps.length || steps.some((s, i) => s.name !== flow.steps[i]?.name)) return null;
  return isChain(steps) ? null : steps;
}
