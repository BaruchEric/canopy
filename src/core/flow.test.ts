import { describe, expect, test } from "bun:test";
import { Flows, stepSpec, summaryOf, type CheckResult, type FlowRunner } from "./flow";
import { parseWorkflow } from "./workflow";
import { DEFAULT_AGENT, type Flow, type Repo, type Run, type VerdictAnswers, type Workflow } from "./types";
import type { ActionSpec } from "./actions";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function wf(text: string): Workflow {
  const e = parseWorkflow(text, { name: "t", source: "bundled", file: "/t.md" });
  if (!e.ok) throw new Error(e.error);
  return e.workflow;
}

const TWO = wf(`---
name: two
verb: do two
blurb: b
expects-change: true
---

## First
gate: ask

Do the first.

## Second

Do the second.
`);

const repo = (): Repo => ({
  id: "r",
  name: "r",
  path: "/tmp/r",
  group: "",
  source: "root",
  status: null,
});

/** A Runner that starts nothing and ends runs when told. */
class FakeRunner implements FlowRunner {
  runs = new Map<string, Run>();
  specs: ActionSpec[] = [];
  notes: string[] = [];
  stopped: string[] = [];
  dismissed: string[] = [];
  onChange: (run: Run) => void = () => {};
  private n = 0;
  start(r: Repo, action: string, spec: ActionSpec, note: string): Run {
    this.n += 1;
    const run: Run = {
      id: `run${this.n}`, repoId: r.id, action, verb: spec.verb, progress: spec.progress,
      expectsChange: spec.expectsChange, chat: false, note, status: "working",
      startedAt: 0, steps: [], prompt: null,
    };
    this.runs.set(run.id, run);
    this.specs.push(spec);
    this.notes.push(note);
    return run;
  }
  get(id: string) { return this.runs.get(id); }
  activeFor(repoId: string) {
    return [...this.runs.values()].find((r) => r.repoId === repoId && r.status === "working");
  }
  stop(id: string): Run {
    this.stopped.push(id);
    return this.end(id, "stopped");
  }
  dismiss(id: string) { this.dismissed.push(id); }
  end(id: string, status: Run["status"], text = "", error?: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(id);
    run.status = status;
    if (text) run.result = { text, costUsd: 0, durationMs: 0, turns: 1 };
    if (error) run.error = error;
    this.onChange(run);
    return run;
  }
  /** the last started run's id */
  last(): string { return `run${this.n}`; }
}

function setup(opts: {
  check?: (cmd: string) => CheckResult;
  evaluator?: ((state: string) => Promise<VerdictAnswers>) | null;
  status?: () => Promise<Repo["status"]>;
} = {}) {
  const runner = new FakeRunner();
  const changes: Flow[] = [];
  const gone: string[] = [];
  const checks: string[] = [];
  const flows = new Flows(runner, {
    onChange: (f) => changes.push(structuredClone(f)),
    onGone: (id) => gone.push(id),
    onFleet: () => {},
    onFleetGone: () => {},
    check: async (_repo, command) => {
      checks.push(command);
      return opts.check ? opts.check(command) : { exit: 0, output: "" };
    },
    evaluator: opts.evaluator ?? null,
    status: opts.status,
  });
  runner.onChange = (run) => flows.onRun(run);
  return { runner, flows, changes, gone, checks };
}

describe("stepSpec", () => {
  test("names the step, carries its tools and turns, and folds earlier summaries in", () => {
    const spec = stepSpec(TWO, 1, [{ name: "First", summary: "did the first" }]);
    expect(spec.verb).toBe("do two · Second");
    expect(spec.progress).toBe("do two: Second");
    expect(spec.maxTurns).toBe(30);
    expect(spec.mode).toBe("job");
    expect(spec.expectsChange).toBe(false);
    expect(spec.task).toContain("Earlier steps of this workflow, already done:\n- First: did the first");
    expect(spec.task.endsWith("Do the second.")).toBe(true);
  });
  test("a retry says why the last try was not accepted", () => {
    const spec = stepSpec(TWO, 0, [], "the summary asks you something");
    expect(spec.task).toContain("not accepted because: the summary asks you something");
  });
});

describe("summaryOf", () => {
  test("prefers the result, then the last text step", () => {
    const base: Run = { id: "x", repoId: "r", action: "a", verb: "v", progress: "p", expectsChange: false, chat: false, note: "", status: "done", startedAt: 0, steps: [], prompt: null };
    expect(summaryOf({ ...base, result: { text: "closing", costUsd: 0, durationMs: 0, turns: 1 } })).toBe("closing");
    expect(summaryOf({ ...base, steps: [{ id: "1", at: 0, kind: "tool" }, { id: "2", at: 0, kind: "text", text: "words" }] })).toBe("words");
    expect(summaryOf(base)).toBe("");
  });
});

describe("Flows", () => {
  test("runs steps in order, parks at an ask gate, continues on resume, and settles the outcome", async () => {
    const st = { branch: "main", upstream: "o/main", ahead: 0, behind: 0, files: [], lastCommit: null } as unknown as Repo["status"];
    const { runner, flows } = setup({ status: async () => st });
    const flow = flows.start({ ...repo(), status: st }, TWO, "note!", DEFAULT_AGENT);
    expect(flow.status).toBe("working");
    expect(flow.steps.map((s) => s.status)).toEqual(["running", "pending"]);
    expect(runner.notes).toEqual(["note!"]);
    runner.end("run1", "done", "first done");
    await flush();
    expect(flows.get(flow.id)?.status).toBe("gated");
    expect(flows.get(flow.id)?.steps[0]?.summary).toBe("first done");
    expect(flows.get(flow.id)?.steps[0]?.status).toBe("gated");
    flows.resume(flow.id, "continue");
    await flush();
    expect(flows.get(flow.id)?.steps[0]?.status).toBe("passed");
    expect(flows.get(flow.id)?.current).toBe(1);
    expect(runner.specs[1]?.task).toContain("First: first done");
    runner.end("run2", "done", "second done");
    await flush();
    const done = flows.get(flow.id);
    expect(done?.status).toBe("done");
    expect(done?.steps.map((s) => s.status)).toEqual(["passed", "passed"]);
    expect(done?.outcome).toBe("unchanged");
  });

  test("retry runs the same step again with the reason, replacing its run", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    runner.end("run1", "done", "hmm");
    await flush();
    flows.resume(flow.id, "retry");
    await flush();
    expect(flows.get(flow.id)?.current).toBe(0);
    expect(flows.get(flow.id)?.steps[0]?.runId).toBe("run2");
    expect(runner.specs[1]?.task).toContain("not accepted because");
    expect(runner.dismissed).toEqual(["run1"]);
  });

  test("stop at a gate ends the flow and skips the rest", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    runner.end("run1", "done", "x");
    await flush();
    flows.resume(flow.id, "stop");
    expect(flows.get(flow.id)?.status).toBe("stopped");
    expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
  });

  test("a failing check fails the step and the flow with the output", async () => {
    const CHECKED = wf(`---\nblurb: b\n---\n\n## Gate\ncheck: bun test\n\n## After\n\nx\n`);
    const { flows, checks } = setup({ check: () => ({ exit: 1, output: "1 fail" }) });
    const flow = flows.start(repo(), CHECKED, "", DEFAULT_AGENT);
    await flush();
    expect(checks).toEqual(["bun test"]);
    const f = flows.get(flow.id);
    expect(f?.status).toBe("failed");
    expect(f?.steps[0]?.check).toEqual({ command: "bun test", exit: 1, output: "1 fail" });
    expect(f?.steps[0]?.status).toBe("failed");
    expect(f?.steps[1]?.status).toBe("skipped");
  });

  test("a check-only step starts no run and passes on exit 0", async () => {
    const CHECKED = wf(`---\nblurb: b\n---\n\n## Gate\ncheck: true\n\n## After\n\nx\n`);
    const { runner, flows } = setup();
    const flow = flows.start(repo(), CHECKED, "", DEFAULT_AGENT);
    await flush();
    expect(runner.specs.length).toBe(1);
    expect(runner.specs[0]?.verb).toBe("t · After");
    expect(flows.get(flow.id)?.steps[0]?.status).toBe("passed");
  });

  test("a failed run fails the flow; a stopped run stops it", async () => {
    const a = setup();
    const fa = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "failed", "", "boom");
    await flush();
    expect(a.flows.get(fa.id)?.status).toBe("failed");
    expect(a.flows.get(fa.id)?.error).toBe("boom");
    const b = setup();
    const fb = b.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    b.flows.stop(fb.id);
    await flush();
    expect(b.runner.stopped).toEqual(["run1"]);
    expect(b.flows.get(fb.id)?.status).toBe("stopped");
  });

  test("the verdict gate goes on a go, parks with the reason otherwise, and falls back to ask without an evaluator", async () => {
    const V = wf(`---\nblurb: b\n---\n\n## One\ngate: verdict\n\nx\n\n## Two\n\ny\n`);
    const go: VerdictAnswers = { outcome: { choice: "done", probabilities: { done: 0.95 } }, needsYou: { probability: 0 }, offScope: { probability: 0 } };
    const a = setup({ evaluator: async () => go });
    const fa = a.flows.start(repo(), V, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "all good");
    await flush();
    expect(a.flows.get(fa.id)?.steps[0]?.verdict?.go).toBe(true);
    expect(a.flows.get(fa.id)?.current).toBe(1);

    const b = setup({ evaluator: async () => ({ ...go, needsYou: { probability: 0.9 } }) });
    const fb = b.flows.start(repo(), V, "", DEFAULT_AGENT);
    b.runner.end("run1", "done", "please decide");
    await flush();
    expect(b.flows.get(fb.id)?.status).toBe("gated");
    expect(b.flows.get(fb.id)?.steps[0]?.reason).toBe("the summary asks you something");

    const c = setup({ evaluator: null });
    const fc = c.flows.start(repo(), V, "", DEFAULT_AGENT);
    c.runner.end("run1", "done", "x");
    await flush();
    expect(c.flows.get(fc.id)?.status).toBe("gated");
    expect(c.flows.get(fc.id)?.steps[0]?.reason).toContain("no gateway key");

    const d = setup({ evaluator: async () => { throw new Error("gateway down"); } });
    const fd = d.flows.start(repo(), V, "", DEFAULT_AGENT);
    d.runner.end("run1", "done", "x");
    await flush();
    expect(d.flows.get(fd.id)?.steps[0]?.reason).toContain("gateway down");
  });

  test("mirrors a waiting run, refuses a busy repo, and dismisses only finished flows", async () => {
    const { runner, flows, gone } = setup();
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    const run = runner.get("run1");
    if (!run) throw new Error("no run");
    run.status = "waiting";
    runner.onChange(run);
    expect(flows.get(flow.id)?.status).toBe("waiting");
    expect(() => flows.start(repo(), TWO, "", DEFAULT_AGENT)).toThrow(/already/);
    expect(() => flows.dismiss(flow.id)).toThrow(/stop/);
    run.status = "working";
    runner.onChange(run);
    flows.stop(flow.id);
    await flush();
    flows.dismiss(flow.id);
    expect(gone).toEqual([flow.id]);
    expect(runner.dismissed).toContain("run1");
  });
});
