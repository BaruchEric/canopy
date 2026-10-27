/** Graph dispatch through the real Runner. Only the harness process is replaced. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskRunLogger } from "./runlog";
import { StageClient } from "./stageclient";
import type { RpcProc } from "./codexrpc";
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
    await flush();
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
    await flush();
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

test("a branch flow emits its startup note once, before location and setup in its first run", async () => {
  const { runner, flows, drivers } = setup();
  const graph = workflow("## First\n\nRead.\n\n## Second\n\nRead again.\n");
  const start = { ...branch("warm-flow"), startNote: "started in a warm worktree", prepare: async (say: (text: string) => void) => { say("$ setup"); } };
  const flow = flows.start(repo, graph, "user task", DEFAULT_AGENT, { branch: start });
  await flush();
  const first = runner.get(drivers[0]?.ctx?.env["CANOPY_RUN"] ?? "missing");
  expect(first?.steps.filter((step) => step.kind === "note").map((step) => step.text)).toEqual(["started in a warm worktree", "on branch run/warm-flow in /scratch/warm-flow", "$ setup"]);
  expect(first).toMatchObject({ note: "user task", branch: { work: "w-test2345", origin: "warm-flow" } });
  drivers[0]?.end();
  await flush();
  const second = runner.get(drivers[1]?.ctx?.env["CANOPY_RUN"] ?? "missing");
  expect(second?.steps.filter((step) => step.kind === "note").map((step) => step.text)).toEqual(["on branch run/warm-flow in /scratch/warm-flow"]);
  expect(second?.branch?.work).toBe(first?.branch?.work);
  flows.stop(flow.id);
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function releaseFixture(stage = false, logging = true) {
  const dir = await mkdtemp(join(tmpdir(), "canopy-flow-release-"));
  const log = new DiskRunLogger({ dir: join(dir, "logs"), env: () => ({}), appliedFile: join(dir, "none") });
  await log.refresh();
  const drivers: DeferredDriver[] = [];
  const reads: string[] = [];
  const handed: string[] = [];
  const handoffRuns: Run[] = [];
  let flows: Flows;
  const quiet = deferred<boolean>();
  const procExit = deferred<number | null>();
  class HeldSeed extends StageClient {
    polls = 0;
    override harnessesNow() { return ["claude"]; }
    override busy() { return ++this.polls === 1 ? Promise.resolve(true) : quiet.promise; }
  }
  class DeferredDriver extends Driver {
    stops = 0;
    override stop() { this.stops++; }
    override start(ctx: DriveCtx) {
      super.start(ctx);
      if (stage) {
        const proc: RpcProc = { stdin: { write() {}, end() {} }, stdout: new ReadableStream({ start(c) { c.close(); } }), exited: procExit.promise, kill() {} };
        if (!ctx.track) throw new Error("missing seed tracker");
        ctx.track(proc);
      }
    }
  }
  const runner = new Runner({ onChange: (run) => flows?.onRun(run), onGone: () => {}, branchState: async () => "ready" }, {
    ...(logging ? { log } : {}), driver: (harness) => { const driver = new DeferredDriver(harness); drivers.push(driver); return driver; },
    ...(stage ? { stage: () => true, stageExec: () => new HeldSeed("/unused-flow-seed"), quietWait: 1 } : {}),
  });
  flows = new Flows(runner, {
    onChange: () => {}, onGone: () => {}, onFleet: () => {}, onFleetGone: () => {}, evaluator: null,
    fingerprint: async () => { reads.push("fingerprint"); return String(reads.length); },
    check: async () => { reads.push("check"); return { exit: 0, output: "ok" }; },
    branchState: async () => { reads.push("branch"); return "ready"; },
    onBranchEnd: (_flow, runId, run) => { handed.push(runId ?? "missing"); if (run) handoffRuns.push(run); },
  });
  const result = (n: number, problem: string | null = null) => {
    const ctx = drivers[n]?.ctx;
    if (!ctx) throw new Error("driver not started");
    ctx.result({ text: "done", durationMs: 1, turns: 1 }, problem);
  };
  const exit = (n: number) => drivers[n]?.ctx?.exited({ code: 0, stderr: "" });
  return { runner, flows, drivers, reads, handed, handoffRuns, result, exit, quiet, procExit,
    cleanup: async () => { quiet.resolve(false); procExit.resolve(0); drivers.forEach((_, i) => exit(i)); await runner.stopLoggedAndWait(); await rm(dir, { recursive: true, force: true }); },
  };
}

describe("workflow release boundary", () => {
  for (const logging of [true, false]) {
    test(`a result stays visible while fingerprint, check, next writer and branch handoff wait for actual exit, even dismissed (${logging ? "logged" : "unlogged"})`, async () => {
      const f = await releaseFixture(false, logging);
      try {
        const graph = workflow("## First\ncheck: echo first\n\nwrite\n\n## Second\n\nwrite again\n");
        const flow = f.flows.start(repo, graph, "", DEFAULT_AGENT, { branch: branch("release") });
        await f.flows.whenStarted();
        const first = flow.steps[0]?.runId ?? "missing";
        f.result(0); await flush();
        expect(f.runner.get(first)?.status).toBe("done");
        expect(flow.status).toBe("working");
        expect(f.reads).toEqual(["fingerprint"]);
        expect(f.drivers).toHaveLength(1);
        expect(f.drivers[0]?.stops).toBe(0);
        expect(f.handed).toEqual([]);
        f.runner.dismiss(first);
        f.exit(0); await flush();
        expect(f.reads).toEqual(["fingerprint", "fingerprint", "check", "fingerprint"]);
        expect(f.drivers).toHaveLength(2);
        f.result(1); await flush();
        expect(f.handed).toEqual([]);
        expect(f.reads).not.toContain("branch");
        const finalRun = flow.steps[1]?.runId ?? "missing";
        f.runner.dismiss(finalRun);
        f.exit(1); await flush();
        expect(flow.status).toBe("done");
        expect(f.handed).toEqual([finalRun]);
        expect(f.handoffRuns[0]).toMatchObject({ id: finalRun, session: `session-${finalRun}`, branch: { origin: "release", held: true } });
      } finally { await f.cleanup(); }
    });
  }

  test("driver exit still waits for owned process drain and seed release before checking", async () => {
    const f = await releaseFixture(true);
    try {
      const flow = f.flows.start(repo, workflow("## First\ncheck: echo first\n\nwrite\n"), "", DEFAULT_AGENT);
      await f.flows.whenStarted();
      f.result(0); f.exit(0); await flush();
      expect(f.reads).toEqual(["fingerprint"]);
      expect(flow.status).toBe("working");
      f.procExit.resolve(0); await Bun.sleep(10);
      expect(f.runner.liveIn(repo.path)).toBe(true);
      expect(f.reads).toEqual(["fingerprint"]);
      f.quiet.resolve(false); await flush();
      expect(f.runner.liveIn(repo.path)).toBe(false);
      expect(f.reads).toEqual(["fingerprint", "fingerprint", "check"]);
      expect(flow.status).toBe("done");
    } finally { await f.cleanup(); }
  });

  test("stopping an active driver retains the checkout reservation until actual exit", async () => {
    const f = await releaseFixture();
    try {
      const flow = f.flows.start(repo, workflow("## First\n\nwrite\n"), "", DEFAULT_AGENT);
      await f.flows.whenStarted();
      f.flows.stop(flow.id); await flush();
      expect(flow.status).toBe("working");
      expect(f.flows.activeFor(repo.id)?.id).toBe(flow.id);
      expect(() => f.flows.start(repo, FAN, "unrelated", DEFAULT_AGENT)).toThrow("already has");
      expect(f.reads).toEqual(["fingerprint"]);
      f.exit(0); await flush();
      expect(flow.status).toBe("stopped");
      expect(f.flows.activeFor(repo.id)).toBeUndefined();
    } finally { await f.cleanup(); }
  });

  for (const problem of [null, "failed", "You've hit your limit · resets 3pm"]) {
    test(`stop reserves a terminal step until its actual exit (${problem ?? "success"})`, async () => {
      const f = await releaseFixture();
      try {
        const flow = f.flows.start(repo, workflow("## First\n\nwrite\n"), "", DEFAULT_AGENT, { branch: branch("stopping") });
        await f.flows.whenStarted();
        const id = flow.steps[0]?.runId ?? "missing";
        f.result(0, problem); f.runner.dismiss(id);
        f.flows.stop(flow.id); await flush();
        expect(flow.status).toBe("working");
        expect(() => f.flows.dismiss(flow.id)).toThrow("stop the flow");
        expect(() => f.flows.pickUp(flow.id)).toThrow("not stopped");
        expect(f.reads).toEqual(["fingerprint"]);
        expect(f.drivers).toHaveLength(1);
        f.exit(0); await flush();
        expect(flow.status).toBe("stopped");
        expect(f.handed).toEqual([]);
        f.flows.pickUp(flow.id); await f.flows.whenStarted();
        expect(f.drivers).toHaveLength(2);
      } finally { await f.cleanup(); }
    });
  }

  test("capacity retry cannot replace its writer before the old process releases", async () => {
    const f = await releaseFixture();
    try {
      const flow = f.flows.start(repo, workflow("## First\n\nwrite\n"), "", DEFAULT_AGENT, { branch: branch("retry") });
      await f.flows.whenStarted();
      f.result(0, "You've hit your limit · resets 3pm"); await flush();
      expect(flow.status).toBe("working");
      expect(() => f.flows.resume(flow.id, "retry")).toThrow("not waiting");
      f.exit(0); await flush();
      expect(flow.parkedFor).toBe("capacity");
      f.flows.resume(flow.id, "retry"); await f.flows.whenStarted();
      expect(f.drivers).toHaveLength(2);
    } finally { await f.cleanup(); }
  });

  test("stopping during branch preparation keeps the reservation until preparation releases", async () => {
    const f = await releaseFixture();
    const preparation = deferred<void>();
    try {
      const flow = f.flows.start(repo, workflow("## First\n\nwrite\n"), "", DEFAULT_AGENT, { branch: { ...branch("preparing"), prepare: () => preparation.promise } });
      await f.flows.whenStarted();
      f.flows.stop(flow.id); await flush();
      expect(flow.status).toBe("working");
      expect(f.reads).toEqual(["fingerprint"]);
      preparation.resolve(); await flush();
      expect(flow.status).toBe("stopped");
      expect(f.drivers[0]?.ctx).toBeUndefined();
      expect(f.handed).toEqual([]);
    } finally { preparation.resolve(); await f.cleanup(); }
  });
});
