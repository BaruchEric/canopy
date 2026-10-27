/** Graph dispatch through the real Runner. Only the harness process is replaced. */
import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions";
import type { DriveCtx, RunDriver } from "./driver";
import { Flows, type FlowRecord } from "./flow";
import { BranchCapError, Runner, type BranchStart } from "./runner";
import { DEFAULT_AGENT, type Harness, type Repo, type Run, type Workflow } from "./types";
import { parseWorkflow } from "./workflow";

const repo: Repo = { id: "graph", name: "graph", path: "/scratch/graph", group: "", source: "root", status: null };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function workflow(text: string): Workflow {
  const parsed = parseWorkflow(`---\nblurb: b\n---\n\n${text}`, { name: "graph", source: "user", file: "/graph.md" });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workflow;
}
const FAN = workflow(`## Build\ntools: git-commit\n\nbuild\n\n## Lint\nafter: Build\ntools: read\n\nlint\n\n## Docs\nafter: Build\ntools: read\n\ndocs\n\n## Ship\nafter: Lint, Docs\nmode: manual\n\nship\n`);
const branch = (origin: string): BranchStart => ({ branch: { name: `run/${origin}`, target: "main", base: "base", dir: `/scratch/${origin}`, state: "working", origin, work: "w-test2345" } });
class Driver implements RunDriver {
  readonly label = "Local graph test";
  ctx?: DriveCtx;
  constructor(readonly harness: Harness) {}
  check() { return null; }
  start(ctx: DriveCtx) { this.ctx = ctx; ctx.session(`session-${ctx.env["CANOPY_RUN"]}`); }
  say() {}
  stop() { this.ctx?.exited({ code: null, stderr: "" }); }
  end(problem: string | null = null) {
    if (!this.ctx) throw new Error("driver not started");
    this.ctx.result({ text: "done", durationMs: 1, turns: 1 }, problem);
    this.ctx.exited({ code: problem ? 1 : 0, stderr: "" });
  }
}
function setup() {
  const drivers: Driver[] = [];
  const saved: FlowRecord[] = [];
  let changed = (_run: Run) => {};
  const runner = new Runner({ onChange: (run) => changed(run), onGone: () => {}, branchState: async () => "nothing" }, {
    driver: (harness) => { const driver = new Driver(harness); drivers.push(driver); return driver; },
  });
  const flows = new Flows(runner, { onChange: () => {}, onGone: () => {}, onFleet: () => {}, onFleetGone: () => {}, evaluator: null, check: async () => ({ exit: 0, output: "ok" }), save: (record) => saved.push(structuredClone(record)) });
  changed = (run) => flows.onRun(run);
  return { runner, flows, drivers, saved };
}
const activeDrivers = (drivers: Driver[]) => drivers.filter((driver) => driver.ctx?.status() === "working");

describe("real Runner graph ownership", () => {
  test("checkout siblings coexist, unrelated runs stay busy, and held Ship starts only on continue", async () => {
    const { flows, runner, drivers } = setup();
    const flow = flows.start(repo, FAN, "", DEFAULT_AGENT);
    drivers[0]?.end(); await flush();
    expect(flow.steps.map((step) => step.status)).toEqual(["passed", "running", "running", "pending"]);
    expect(activeDrivers(drivers)).toHaveLength(2);
    expect(() => runner.start(repo, FAN.name, ACTIONS.ask, "unrelated", DEFAULT_AGENT)).toThrow("already has");
    expect(() => flows.start(repo, FAN, "another flow", DEFAULT_AGENT)).toThrow("already has");
    drivers[1]?.end(); await flush();
    expect(flow.steps[3]?.status).toBe("pending");
    drivers[2]?.end(); await flush();
    expect(flow.steps[3]?.status).toBe("held");
    flows.resume(flow.id, "continue");
    expect(drivers).toHaveLength(4);
    expect(flow.steps[3]?.status).toBe("running");
    drivers[3]?.end(); await flush();
    expect(flow.status).toBe("done");
  });

  test("the real runner preserves the engine's three-step cap and one-writer queue", async () => {
    const { flows, drivers } = setup();
    const graph = workflow(`## A\n\na\n\n## B\nafter: A\ntools: git-commit\n\nb\n\n## C\nafter: A\ntools: read\n\nc\n\n## D\nafter: A\ntools: read\n\nd\n\n## E\nafter: A\ntools: git-commit\n\ne\n`);
    const flow = flows.start(repo, graph, "", DEFAULT_AGENT);
    drivers[0]?.end(); await flush();
    expect(flow.steps.map((step) => step.status)).toEqual(["passed", "running", "running", "running", "pending"]);
    expect(activeDrivers(drivers)).toHaveLength(3);
    expect(flow.steps[4]?.reason).toBeUndefined();
    drivers[2]?.end(); await flush();
    expect(flow.steps[4]?.reason).toBe("waits for B (both change the tree)");
    drivers[1]?.end(); await flush();
    expect(flow.steps[4]?.status).toBe("running");
    expect(activeDrivers(drivers)).toHaveLength(2);
    flows.stop(flow.id);
    expect(flow.status).toBe("stopped");
    expect(activeDrivers(drivers)).toHaveLength(0);
  });

  test("branch siblings reuse one origin slot at the cap and stop frees only their slot", async () => {
    const { flows, runner, drivers } = setup();
    const graph = workflow(`## Build\n\nbuild\n\n## A\nafter: Build\ntools: read\n\na\n\n## B\nafter: Build\ntools: read\n\nb\n\n## C\nafter: Build\ntools: read\n\nc\n`);
    runner.start(repo, "ask", ACTIONS.ask, "first", DEFAULT_AGENT, undefined, undefined, branch("other-a"));
    runner.start(repo, "ask", ACTIONS.ask, "second", DEFAULT_AGENT, undefined, undefined, branch("other-b"));
    const flow = flows.start(repo, graph, "", DEFAULT_AGENT, { branch: branch("flow-tree") });
    drivers[2]?.end(); await flush();
    expect(flow.steps.map((step) => step.status)).toEqual(["passed", "running", "running", "running"]);
    expect(runner.branchRunsFor(repo.id)).toHaveLength(5);
    expect(runner.branchSlotsFor(repo.id)).toBe(3);
    expect(runner.branchRunsFor(repo.id).filter((run) => run.branch?.origin === "flow-tree").every((run) => run.branch?.work === "w-test2345")).toBe(true);
    expect(() => runner.start(repo, graph.name, ACTIONS.ask, "new origin", DEFAULT_AGENT, undefined, undefined, branch("fourth"))).toThrow(BranchCapError);
    flows.stop(flow.id);
    expect(flow.status).toBe("stopped");
    expect(runner.branchSlotsFor(repo.id)).toBe(2);
    expect(() => runner.start(repo, "ask", ACTIONS.ask, "free slot", DEFAULT_AGENT, undefined, undefined, branch("fourth"))).not.toThrow();
    runner.stopAll();
  });

  test("restored interrupted checkout siblings regain one private owner and still exclude unrelated work", async () => {
    const a = setup();
    const flow = a.flows.start(repo, FAN, "", DEFAULT_AGENT);
    a.drivers[0]?.end(); await flush();
    const record = a.saved.at(-1);
    if (!record) throw new Error("record missing");
    const b = setup();
    b.flows.restore([structuredClone(record)], () => repo, () => () => DEFAULT_AGENT);
    expect(b.flows.get(flow.id)?.steps.map((step) => step.status)).toEqual(["passed", "running", "running", "pending"]);
    expect(activeDrivers(b.drivers)).toHaveLength(2);
    expect(() => b.runner.start(repo, FAN.name, ACTIONS.ask, "unrelated", DEFAULT_AGENT)).toThrow("already has");
    b.flows.stop(flow.id); a.flows.stop(flow.id);
    expect(activeDrivers(b.drivers)).toHaveLength(0);
  });

  test("a real branch limit drains its sibling and retries on the same worktree and work item", async () => {
    const { flows, runner, drivers } = setup();
    const flow = flows.start(repo, FAN, "", DEFAULT_AGENT, { branch: branch("limited") });
    drivers[0]?.end(); await flush();
    const oldRun = flow.steps[1]?.runId;
    drivers[1]?.end("You've hit your limit · resets 3pm"); await flush();
    expect(flow.status).toBe("working");
    expect(runner.get(oldRun ?? "")?.status).toBe("limited");
    drivers[2]?.end(); await flush();
    expect(flow.parkedFor).toBe("capacity");
    const before = structuredClone(flow.branch);
    flows.resume(flow.id, "continue"); await flush();
    expect(flow.steps[1]?.runId).not.toBe(oldRun);
    expect(flow.branch).toEqual(before);
    expect(drivers.at(-1)?.ctx?.cwd).toBe("/scratch/limited");
    expect(runner.branchSlotsFor(repo.id)).toBe(1);
    flows.stop(flow.id);
  });
});
