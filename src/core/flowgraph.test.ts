import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { graphOf, graphStep, isChain, workflowGraph } from "./flowgraph";
import { FLOW_MODES_FILE } from "./flowmodes";
import type { Workflow } from "./types";
import { parseWorkflow } from "./workflow";

const wf = (text: string, name = "fan"): Workflow => {
  const e = parseWorkflow(text, { name, source: "user", file: `/${name}.md` });
  if (!e.ok) throw new Error(e.error);
  return e.workflow;
};

const FAN = wf(`---
blurb: b
---

## Build
tools: git-commit

build

## Lint
after: Build
tools: read

lint

## Docs
after: Build
tools: read
check: true
retries: 1
back: Build

docs

## Ship
after: Lint, Docs
when: check pass
mode: manual

ship
`);

describe("graphOf", () => {
  test("columns by depth, edges for after and back, the condition on the edges into its step", () => {
    const g = graphOf(FAN.steps);
    expect(g.columns).toEqual([["Build"], ["Lint", "Docs"], ["Ship"]]);
    expect(g.depth).toEqual({ Build: 0, Lint: 1, Docs: 1, Ship: 2 });
    expect(g.edges).toEqual([
      { from: "Build", to: "Lint", kind: "after" },
      { from: "Build", to: "Docs", kind: "after" },
      { from: "Lint", to: "Ship", kind: "after", when: ["check pass"] },
      { from: "Docs", to: "Ship", kind: "after", when: ["check pass"] },
      { from: "Docs", to: "Build", kind: "back" },
    ]);
  });

  test("a chain is one column per step", () => {
    const chain = wf("---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\ncheck: true\nretries: 2\n\nc\n");
    const g = graphOf(chain.steps);
    expect(g.columns).toEqual([["A"], ["B"], ["C"]]);
    // retries on its own step go nowhere else, so no back edge
    expect(g.edges.map((e) => [e.from, e.to, e.kind])).toEqual([["A", "B", "after"], ["B", "C", "after"]]);
  });

  test("the longest path sets the depth, and a column follows the rows of what its steps wait for", () => {
    const w = wf("---\nblurb: b\n---\n\n## A\n\na\n\n## B\nafter: A\n\nb\n\n## C\nafter: A\n\nc\n\n## E\nafter: C\n\ne\n\n## D\nafter: B\n\nd\n\n## F\nafter: A, D\n\nf\n");
    const g = graphOf(w.steps);
    expect(g.depth).toEqual({ A: 0, B: 1, C: 1, E: 2, D: 2, F: 3 });
    // D waits for B, the upper one, so it goes above E though its heading comes later
    expect(g.columns).toEqual([["A"], ["B", "C"], ["D", "E"], ["F"]]);
  });

  test("two roots share the first column, in heading order", () => {
    const w = wf("---\nblurb: b\n---\n\n## A\n\na\n\n## B\nafter: A\n\nb\n\n## C\nafter: A\n\nc\n");
    const roots = w.steps.map((s) => (s.name === "B" ? { ...s, after: [] } : s));
    expect(graphOf(roots).columns).toEqual([["A", "B"], ["C"]]);
  });

  test("a name after does not find counts as a root rather than breaking the picture", () => {
    const steps = FAN.steps.map((s) => (s.name === "Lint" ? { ...s, after: ["Gone"] } : s));
    const g = graphOf(steps);
    expect(g.depth["Lint"]).toBe(0);
    expect(g.edges.some((e) => e.from === "Gone")).toBe(false);
  });
});

describe("isChain", () => {
  /** the bundled files that draw as graphs (FR-034 plan 3), with their columns */
  const GRAPHS: Record<string, string[][]> = {
    ship: [["Gates", "Docs"], ["Commit"], ["Push"]],
    "sentry-triage-fix": [["Triage"], ["Fix"], ["Gates"], ["Mend"], ["Commit"]],
  };

  test("every bundled workflow is a chain but ship and sentry-triage-fix, and the fan is not", async () => {
    const dir = join(import.meta.dir, "../../lib/workflows");
    for (const n of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
      const name = n.slice(0, -3);
      const e = parseWorkflow(await readFile(join(dir, n), "utf8"), { name, source: "bundled", file: n });
      if (!e.ok) throw new Error(`${n}: ${e.error}`);
      const columns = GRAPHS[name];
      expect(isChain(e.workflow.steps)).toBe(columns === undefined);
      if (columns) expect(graphOf(e.workflow.steps).columns).toEqual(columns);
    }
    expect(isChain(FAN.steps)).toBe(false);
  });

  test("a condition alone makes a graph; a manual mode alone does not", () => {
    const chain = wf("---\nblurb: b\n---\n\n## A\ncheck: true\n\n## B\nmode: manual\n\nb\n");
    expect(isChain(chain.steps)).toBe(true);
    const when = wf("---\nblurb: b\n---\n\n## A\ncheck: true\n\n## B\nwhen: check fail\n\nb\n");
    expect(isChain(when.steps)).toBe(false);
  });
});

describe("workflowGraph", () => {
  test("lays the repo's modes over the steps and says which ones it decided", () => {
    const g = workflowGraph(FAN, { ok: true, modes: { fan: { Ship: "auto", Nope: "manual" }, "*": { Build: "manual" } } });
    expect(g.steps.map((s) => [s.name, s.mode, s.modeFrom])).toEqual([["Build", "manual", "repo"], ["Lint", "auto", undefined], ["Docs", "auto", undefined], ["Ship", "auto", "repo"]]);
    expect(g.modes).toEqual({ Build: "manual", Ship: "auto" });
    expect(g.warnings).toEqual([`${FLOW_MODES_FILE}: modes.fan.Nope names no step of fan`]);
    expect(g).not.toHaveProperty("error");
    expect(g.steps[0]).not.toHaveProperty("body");
  });

  test("a file that cannot be read keeps the file's own modes and says why", () => {
    const g = workflowGraph(FAN, { ok: false, error: `${FLOW_MODES_FILE} must be an object` });
    expect(g).toEqual({ steps: FAN.steps.map(graphStep), modes: {}, warnings: [], error: `${FLOW_MODES_FILE} must be an object` });
    expect(g.steps[3]?.mode).toBe("manual");
  });
});
