import { describe, expect, test } from "bun:test";
import { workflowGraph } from "../../src/core/flowgraph";
import type { Flow, FlowStep, Workflow, WorkflowEntry } from "../../src/core/types";
import { parseWorkflow } from "../../src/core/workflow";
import { fit, flowGraphSteps, NODE_W, picture, STATE_WORD, stateWord } from "./flowgraph";

const wf = (text: string, name = "fan"): Workflow => {
  const e = parseWorkflow(text, { name, source: "user", file: `/${name}.md` });
  if (!e.ok) throw new Error(e.error);
  return e.workflow;
};

const FAN = wf("---\nblurb: b\n---\n\n## Build\n\nbuild\n\n## Lint\nafter: Build\n\nlint\n\n## Docs\nafter: Build\n\ndocs\n\n## Ship\nafter: Lint, Docs\n\nship\n");
const CHAIN = wf("---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n", "chain");

describe("picture", () => {
  test("columns left to right, a column centred on the tallest, one wire per after", () => {
    const p = picture(FAN.steps);
    const at = Object.fromEntries(p.nodes.map((n) => [n.name, [n.x, n.y]]));
    expect(at).toEqual({ Build: [4, 28], Lint: [160, 4], Docs: [160, 52], Ship: [316, 28] });
    expect(p.width).toBe(4 + 3 * NODE_W + 2 * 36 + 4);
    expect(p.height).toBe(4 + 2 * 38 + 10 + 4);
    expect(p.nodes.every((n) => n.h === 38 && n.when === null && !n.manual)).toBe(true);
    expect(p.wires.map((w) => w.key)).toEqual(["after:Build>Lint", "after:Build>Docs", "after:Lint>Ship", "after:Docs>Ship"]);
    // from the right edge of Build to the left edge of Lint, both at mid height
    expect(p.wires[0]).toEqual({ key: "after:Build>Lint", kind: "after", d: "M124 47 C142 47 142 23 160 23", arrow: true });
    expect(p.diamonds).toEqual([]);
  });

  test("a condition gets a diamond before its box, the wires stop at it, and a stub carries the arrow", () => {
    const w = wf("---\nblurb: b\n---\n\n## A\ncheck: true\n\n## B\nwhen: check fail\nmode: manual\n\nb\n");
    const p = picture(w.steps);
    expect(p.nodes.map((n) => [n.name, n.h, n.when, n.manual])).toEqual([["A", 50, null, false], ["B", 50, "check fail", true]]);
    const b = p.nodes[1];
    if (!b) throw new Error("no B");
    expect(p.diamonds).toEqual([{ name: "B", label: "check fail", d: `M${b.x - 17} 29 L${b.x - 12} 24 L${b.x - 7} 29 L${b.x - 12} 34 Z` }]);
    expect(p.wires).toEqual([
      { key: "after:A>B", kind: "after", d: `M124 29 C133.5 29 133.5 29 ${b.x - 17} 29`, arrow: false },
      { key: "stub:B", kind: "after", d: `M${b.x - 7} 29 L${b.x} 29`, arrow: true },
    ]);
  });

  test("a wire that skips a column runs through a lane above, and back runs under", () => {
    const w = wf("---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\nafter: A, B\ncheck: true\nretries: 1\nback: A\n\nc\n");
    const p = picture(w.steps);
    const y = Object.fromEntries(p.nodes.map((n) => [n.name, n.y]));
    // both lanes add room: the boxes start below the top lane
    expect(y).toEqual({ A: 22, B: 22, C: 22 });
    expect(p.height).toBe(22 + 38 + 18 + 4);
    const skip = p.wires.find((x) => x.key === "after:A>C");
    expect(skip?.d).toBe("M124 41 C140 3.7 300 3.7 316 41");
    const back = p.wires.find((x) => x.key === "back:C>A");
    expect(back).toEqual({ key: "back:C>A", kind: "back", d: "M376 60 C376 72 64 72 64 60", arrow: true });
  });

  test("a single step is one box", () => {
    const p = picture(wf("---\nblurb: b\n---\n\n## Only\n\nx\n").steps);
    expect([p.width, p.height, p.nodes.length, p.wires.length]).toEqual([NODE_W + 8, 46, 1, 0]);
  });
});

test("stateWord: one word per status", () => {
  expect(Object.keys(STATE_WORD).sort()).toEqual(["checking", "failed", "gated", "held", "passed", "pending", "running", "skipped"]);
  const shown: FlowStep["status"][] = ["pending", "held", "running", "skipped", "passed", "failed"];
  expect(shown.map(stateWord)).toEqual(["waits", "held", "working", "skipped", "done", "failed"]);
});

test("fit cuts with an ellipsis", () => {
  expect(fit("Build", 13)).toBe("Build");
  expect(fit("Changelog and release notes", 13)).toBe("Changelog an…");
});

describe("flowGraphSteps", () => {
  const flow = (w: Workflow, names = w.steps.map((s) => s.name)): Pick<Flow, "workflow" | "steps"> => ({
    workflow: w.name,
    steps: names.map((name): FlowStep => ({ name, status: "pending" })),
  });
  const entries = (w: Workflow, withGraph = false): WorkflowEntry[] => [
    { ok: true, workflow: CHAIN },
    { ok: true, workflow: w, ...(withGraph ? { graph: workflowGraph(w, { ok: true, modes: { fan: { Ship: "manual" } } }) } : {}) },
  ];

  test("the workflow's steps when they are still the flow's and form a graph", () => {
    expect(flowGraphSteps(flow(FAN), entries(FAN))?.map((s) => s.name)).toEqual(["Build", "Lint", "Docs", "Ship"]);
    // the repo's modes come along when the list carries them
    expect(flowGraphSteps(flow(FAN), entries(FAN, true))?.[3]).toMatchObject({ mode: "manual", modeFrom: "repo" });
  });

  test("the strip for a chain, a list not fetched, a missing workflow, or steps that changed", () => {
    expect(flowGraphSteps(flow(CHAIN), entries(FAN))).toBeNull();
    expect(flowGraphSteps(flow(FAN), undefined)).toBeNull();
    expect(flowGraphSteps(flow(FAN), [{ ok: false, name: "fan", source: "user", file: "/fan.md", error: "x" }])).toBeNull();
    expect(flowGraphSteps(flow(FAN, ["Build", "Lint", "Ship"]), entries(FAN))).toBeNull();
    expect(flowGraphSteps(flow(FAN, ["Build", "Docs", "Lint", "Ship"]), entries(FAN))).toBeNull();
  });
});
