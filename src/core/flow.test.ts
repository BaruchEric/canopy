import { describe, expect, spyOn, test } from "bun:test";
import { Flows, overBudget, RESTART_NOTE, stepSpec, summaryOf, type CheckResult, type FlowRecord, type FlowRunner } from "./flow";
import { STAGE_AWAY, StageAwayError } from "./stagewire";
import { parseWorkflow } from "./workflow";
import { DEFAULT_AGENT, type AgentSettings, type EvidenceFile, type Fleet, type Flow, type JudgeAnswers, type Repo, type Run, type VerdictAnswers, type Workflow } from "./types";
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
  agents: AgentSettings[] = [];
  stopped: string[] = [];
  dismissed: string[] = [];
  onChange: (run: Run) => void = () => {};
  private n = 0;
  start(r: Repo, action: string, spec: ActionSpec, note: string, agent: AgentSettings = DEFAULT_AGENT): Run {
    this.agents.push(agent);
    this.n += 1;
    const run: Run = {
      id: `run${this.n}`, repoId: r.id, action, verb: spec.verb, progress: spec.progress,
      expectsChange: spec.expectsChange, chat: false, harness: "claude", note, status: "working",
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
  end(id: string, status: Run["status"], text = "", error?: string, away = false): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(id);
    run.status = status;
    if (text) run.result = { text, costUsd: 0, durationMs: 0, turns: 1 };
    if (error) run.error = error;
    if (away) run.away = true;
    this.onChange(run);
    return run;
  }
  /** moves a run between working and waiting without ending it */
  set(id: string, status: Run["status"]): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(id);
    run.status = status;
    this.onChange(run);
  }
  /** the last started run's id */
  last(): string { return `run${this.n}`; }
}

function setup(opts: {
  check?: (cmd: string) => CheckResult;
  evaluator?: ((state: string) => Promise<VerdictAnswers>) | null;
  judge?: ((state: string) => Promise<JudgeAnswers>) | null;
  evidence?: (repo: Repo, paths: string[]) => Promise<EvidenceFile[]>;
  status?: () => Promise<Repo["status"]>;
  now?: () => number;
} = {}) {
  const runner = new FakeRunner();
  const changes: Flow[] = [];
  const gone: string[] = [];
  const checks: string[] = [];
  const fleets: Fleet[] = [];
  const fleetGone: string[] = [];
  const saved: FlowRecord[] = [];
  const forgotten: string[] = [];
  const flows = new Flows(runner, {
    onChange: (f) => changes.push(structuredClone(f)),
    onGone: (id) => gone.push(id),
    onFleet: (f) => fleets.push(structuredClone(f)),
    onFleetGone: (id) => fleetGone.push(id),
    check: async (_repo, command) => {
      checks.push(command);
      return opts.check ? opts.check(command) : { exit: 0, output: "" };
    },
    evaluator: opts.evaluator ?? null,
    judge: opts.judge ?? null,
    evidence: opts.evidence,
    status: opts.status,
    now: opts.now,
    // the record is the one this hook was just handed; the round trip copies it
    save: (rec) => saved.push(JSON.parse(JSON.stringify(rec)) as FlowRecord),
    forget: (id) => forgotten.push(id),
  });
  runner.onChange = (run) => flows.onRun(run);
  return { runner, flows, changes, gone, checks, fleets, fleetGone, saved, forgotten };
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
  test("a workflow nobody attends runs each step's run unattended, with its message", () => {
    expect(stepSpec({ ...TWO, unattended: "finish within your tools" }, 0, []).unattended).toBe("finish within your tools");
    expect(stepSpec(TWO, 0, []).unattended).toBeUndefined();
  });

  test("a step's spec names its workflow and step, the scope a remembered rule can take", () => {
    expect(stepSpec(TWO, 1, []).flowStep).toEqual({ workflow: TWO.name, step: TWO.steps[1]?.name ?? "" });
  });
  test("a retry says why the last try was not accepted", () => {
    const spec = stepSpec(TWO, 0, [], "the summary asks you something");
    expect(spec.task).toContain("not accepted because: the summary asks you something");
  });
});

describe("summaryOf", () => {
  test("prefers the result, then the last text step", () => {
    const base: Run = { id: "x", repoId: "r", action: "a", verb: "v", progress: "p", expectsChange: false, chat: false, harness: "claude", note: "", status: "done", startedAt: 0, steps: [], prompt: null };
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

  test("a run that ends inside start is not lost", () => {
    /** Mirrors the real Runner: its onChange hook can fire synchronously
     *  inside start(), before the caller has anywhere to put the run's id. */
    class FailFastRunner extends FakeRunner {
      override start(r: Repo, action: string, spec: ActionSpec, note: string): Run {
        const run = super.start(r, action, spec, note);
        this.end(run.id, "failed", "", "spawn failed");
        return run;
      }
    }
    const runner = new FailFastRunner();
    const flows = new Flows(runner, {
      onChange: () => {},
      onGone: () => {},
      onFleet: () => {},
      onFleetGone: () => {},
      check: async () => ({ exit: 0, output: "" }),
      evaluator: null,
    });
    runner.onChange = (run) => flows.onRun(run);
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    expect(flow.status).toBe("failed");
    expect(flow.error).toBe("spawn failed");
    expect(() => flows.start(repo(), TWO, "", DEFAULT_AGENT)).not.toThrow();
  });

  test("stop during a check ends the flow and starts nothing else", async () => {
    const CHECKED_TWO = wf(`---\nblurb: b\n---\n\n## First\ncheck: slow\n\nDo the first.\n\n## Second\n\nDo the second.\n`);
    const runner = new FakeRunner();
    const checks: string[] = [];
    let resolveCheck: (r: CheckResult) => void = () => {};
    const pending = new Promise<CheckResult>((res) => {
      resolveCheck = res;
    });
    const flows = new Flows(runner, {
      onChange: () => {},
      onGone: () => {},
      onFleet: () => {},
      onFleetGone: () => {},
      check: async (_repo, command) => {
        checks.push(command);
        return pending;
      },
      evaluator: null,
    });
    runner.onChange = (run) => flows.onRun(run);
    const flow = flows.start(repo(), CHECKED_TWO, "", DEFAULT_AGENT);
    runner.end("run1", "done", "x");
    await flush();
    expect(checks).toEqual(["slow"]);
    flows.stop(flow.id);
    resolveCheck({ exit: 0, output: "" });
    await flush();
    const f = flows.get(flow.id);
    expect(f?.status).toBe("stopped");
    expect(f?.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(runner.specs.length).toBe(1);
  });
});

describe("a step's own agent", () => {
  const codex: AgentSettings = { ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5" };
  const PROFILED = wf(`---\nblurb: b\n---\n\n## Plan\n\nThink.\n\n## Review\nagent: review\n\nLook.\n`);

  test("a step naming a profile starts on it; the rest follow the repo's route", async () => {
    const { runner, flows } = setup();
    const asked: (string | undefined)[] = [];
    const flow = flows.start(repo(), PROFILED, "", (profile) => {
      asked.push(profile);
      return profile === "review" ? codex : DEFAULT_AGENT;
    });
    expect(flow.steps.map((s) => s.profile)).toEqual([undefined, "review"]);
    runner.end("run1", "done", "planned");
    await flush();
    expect(asked).toEqual([undefined, "review"]);
    expect(runner.agents.map((a) => a.harness)).toEqual(["claude", "codex"]);
  });

  test("settings handed over whole still serve every step", async () => {
    const { runner, flows } = setup();
    flows.start(repo(), PROFILED, "", codex);
    runner.end("run1", "done", "planned");
    await flush();
    expect(runner.agents).toEqual([codex, codex]);
  });

  test("a fleet asks per repo, with the step's profile", async () => {
    const { runner, flows } = setup();
    const asked: string[] = [];
    const repos = [{ ...repo(), id: "a", name: "a" }, { ...repo(), id: "b", name: "b" }];
    flows.startFleet(repos, PROFILED, "", (r, profile) => {
      asked.push(`${r.id}:${profile ?? "-"}`);
      return profile ? codex : DEFAULT_AGENT;
    });
    runner.end("run1", "done", "x");
    runner.end("run2", "done", "x");
    await flush();
    expect(asked.sort()).toEqual(["a:-", "a:review", "b:-", "b:review"]);
    expect(runner.agents.filter((a) => a.harness === "codex").length).toBe(2);
  });
});

describe("fleets", () => {
  const dirty = (id: string): Repo => ({
    ...repo(),
    id,
    name: id,
    path: `/tmp/${id}`,
    status: { branch: "main", upstream: "o/main", ahead: 0, behind: 0, files: [{ path: "a", index: "M", worktree: " ", untracked: false }], lastCommit: null } as unknown as Repo["status"],
  });
  const DIRTY_WF = wf(`---\nblurb: b\nwhen: dirty\n---\n\n## Do\n\nx\n`);

  test("skips repos the precondition or the machine rules out, runs three at a time, and ends when all have", async () => {
    const { runner, flows, fleets } = setup();
    const repos = [dirty("a"), dirty("b"), dirty("c"), dirty("d"), { ...repo(), id: "clean", name: "clean" }, { ...dirty("far"), host: "box" }, { ...dirty("forge"), forge: "x" } as unknown as Repo, { ...dirty("bad"), error: "nope" }];
    const fleet = flows.startFleet(repos, DIRTY_WF, "n", () => DEFAULT_AGENT);
    expect(fleet.repos.map((r) => r.skipped ?? "run")).toEqual(["run", "run", "run", "run", "nothing to commit", "agent runs only work on this machine", "a forge repo has no checkout", "not a readable repo"]);
    expect(runner.specs.length).toBe(3);
    expect(flows.list().filter((f) => f.fleetId === fleet.id).length).toBe(3);
    runner.end("run1", "done", "ok");
    await flush();
    expect(runner.specs.length).toBe(4);
    runner.end("run2", "done", "ok");
    runner.end("run3", "done", "ok");
    runner.end("run4", "done", "ok");
    await flush();
    const f = flows.getFleet(fleet.id);
    expect(f?.status).toBe("done");
    expect(f?.repos.filter((r) => r.flowId).length).toBe(4);
    expect(fleets.at(-1)?.status).toBe("done");
  });

  test("a parked flow holds its slot", async () => {
    const ASK = wf(`---\nblurb: b\n---\n\n## Do\ngate: ask\n\nx\n`);
    const { runner, flows } = setup();
    flows.startFleet([dirty("a"), dirty("b"), dirty("c"), dirty("d")], ASK, "", () => DEFAULT_AGENT);
    runner.end("run1", "done", "ok");
    await flush();
    expect(runner.specs.length).toBe(3);
    const parked = flows.list().find((f) => f.status === "gated");
    if (!parked) throw new Error("nothing parked");
    flows.resume(parked.id, "continue");
    await flush();
    expect(runner.specs.length).toBe(4);
  });

  test("stop ends the running flows and drops the pending ones", async () => {
    const { runner, flows, fleetGone } = setup();
    const fleet = flows.startFleet([dirty("a"), dirty("b"), dirty("c"), dirty("d")], DIRTY_WF, "", () => DEFAULT_AGENT);
    flows.stopFleet(fleet.id);
    await flush();
    expect(runner.stopped.sort()).toEqual(["run1", "run2", "run3"]);
    const f = flows.getFleet(fleet.id);
    expect(f?.status).toBe("stopped");
    expect(f?.repos[3]?.skipped).toBe("stopped before it started");
    flows.dismissFleet(fleet.id);
    expect(fleetGone).toEqual([fleet.id]);
  });

  test("a repo that is busy when its turn comes is skipped, not failed", async () => {
    const { runner, flows } = setup();
    flows.start(dirty("a"), TWO, "", DEFAULT_AGENT);
    const fleet = flows.startFleet([dirty("a"), dirty("b")], DIRTY_WF, "", () => DEFAULT_AGENT);
    expect(flows.getFleet(fleet.id)?.repos[0]?.skipped).toContain("already has");
    expect(runner.specs.length).toBe(2);
  });

  test("a fleet whose runs end inside start records every flow id", async () => {
    /** Mirrors task 5's FailFastRunner, but ends done with a result rather
     *  than failed: start() feeds the whole flow through synchronously,
     *  onFlowEnd's pump() re-enters before this repo's flowId is recorded. */
    class InstantRunner extends FakeRunner {
      override start(r: Repo, action: string, spec: ActionSpec, note: string): Run {
        const run = super.start(r, action, spec, note);
        this.end(run.id, "done", "ok");
        return run;
      }
    }
    const runner = new InstantRunner();
    const fleets: Fleet[] = [];
    const flows = new Flows(runner, {
      onChange: () => {},
      onGone: () => {},
      onFleet: (f) => fleets.push(structuredClone(f)),
      onFleetGone: () => {},
      check: async () => ({ exit: 0, output: "" }),
      evaluator: null,
    });
    runner.onChange = (run) => flows.onRun(run);
    const fleet = flows.startFleet([dirty("a"), dirty("b"), dirty("c")], DIRTY_WF, "", () => DEFAULT_AGENT);
    await flush();
    const f = flows.getFleet(fleet.id);
    expect(f?.status).toBe("done");
    expect(f?.repos.filter((r) => r.flowId).length).toBe(3);
    expect(fleets.at(-1)?.repos.every((r) => r.flowId)).toBe(true);
    expect(flows.list().every((fl) => fl.status === "done")).toBe(true);
  });
});

describe("a flow reports the run ids it owns", () => {
  test("every step that has run names the run the runner started", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    expect(flow.steps[0]?.runId).toBe("run1");
    expect(runner.get("run1")?.repoId).toBe("r");
    runner.end("run1", "done", "did the first");
    await flush();
    // The first step is gated; continue so the second one runs too.
    flows.resume(flow.id, "continue");
    await flush();
    const after = flows.get(flow.id);
    expect(after?.steps.map((s) => s.runId)).toEqual(["run1", "run2"]);
    expect(runner.get("run2")).toBeDefined();
  });
});

const MEETS: JudgeAnswers = { fit: { choice: "meets", probabilities: { meets: 0.9 } }, evidence: { probability: 0.9 }, rules: { probability: 0 } };

const JUDGED = wf(`---
blurb: b
---

## Build

Build it.

## Accept
gate: judge
evidence: .canopy/intent.md

Does it meet the intent?

## Ship

Ship it.
`);

describe("the judge gate", () => {
  test("reads the evidence, asks the judge, and goes on a meets", async () => {
    const states: string[] = [];
    const asked: string[][] = [];
    const { runner, flows } = setup({
      judge: async (s) => {
        states.push(s);
        return MEETS;
      },
      evidence: async (_r, paths) => {
        asked.push(paths);
        return [{ path: ".canopy/intent.md", text: "be useful" }];
      },
    });
    const flow = flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    runner.end("run1", "done", "built");
    await flush();
    runner.end("run2", "done", "it does");
    await flush();
    const f = flows.get(flow.id);
    expect(asked).toEqual([[".canopy/intent.md"]]);
    expect(states[0]).toContain("Task the work was judged against:\nDoes it meet the intent?");
    expect(states[0]).toContain("Step summary:\nit does");
    expect(states[0]).toContain("File .canopy/intent.md:\nbe useful");
    expect(f?.steps[1]?.judgment?.go).toBe(true);
    expect(f?.current).toBe(2);
    expect(f?.steps[2]?.status).toBe("running");
  });

  test("a sure miss parks as a rejection", async () => {
    const { runner, flows } = setup({ judge: async () => ({ ...MEETS, fit: { choice: "misses", probabilities: { misses: 0.9 } } }) });
    const flow = flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    runner.end("run1", "done", "built");
    await flush();
    runner.end("run2", "done", "it does not");
    await flush();
    const f = flows.get(flow.id);
    expect(f?.status).toBe("gated");
    expect(f?.steps[1]?.judgment?.rejected).toBe(true);
    expect(f?.steps[1]?.reason).toBe("the judge says the work misses the intent");
  });

  test("without a judge it asks; a judge that fails parks with the error", async () => {
    const a = setup({ judge: null });
    const fa = a.flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    a.runner.end("run2", "done", "y");
    await flush();
    expect(a.flows.get(fa.id)?.steps[1]?.reason).toBe("no gateway key, so the judgment is yours");

    const b = setup({ judge: async () => { throw new Error("gateway down"); } });
    const fb = b.flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    b.runner.end("run1", "done", "x");
    await flush();
    b.runner.end("run2", "done", "y");
    await flush();
    expect(b.flows.get(fb.id)?.steps[1]?.reason).toBe("judgment unavailable: gateway down");
  });

  test("evidence that cannot be read reaches the judge as missing", async () => {
    const states: string[] = [];
    const { runner, flows } = setup({
      judge: async (s) => {
        states.push(s);
        return MEETS;
      },
      evidence: async () => { throw new Error("EACCES"); },
    });
    flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    runner.end("run1", "done", "x");
    await flush();
    runner.end("run2", "done", "y");
    await flush();
    expect(states[0]).toContain("File .canopy/intent.md: (missing)");
  });
});

const CHECKED_RETRY = wf(`---
blurb: b
---

## Build

Build it.

## Test
check: bun test
retries: 2
back: Build
`);

describe("retries", () => {
  test("a failing check goes back to its back step with the reason, and passes once the check does", async () => {
    let calls = 0;
    const { runner, flows } = setup({ check: () => (++calls < 3 ? { exit: 1, output: "2 fail" } : { exit: 0, output: "ok" }) });
    const flow = flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    runner.end("run1", "done", "built");
    await flush();
    expect(flows.get(flow.id)?.current).toBe(0);
    expect(flows.get(flow.id)?.tries).toEqual({ Test: 1 });
    expect(flows.get(flow.id)?.rewinds?.[0]).toMatchObject({ from: "Test", to: "Build" });
    expect(runner.specs[1]?.task).toContain("the Test step did not accept the work: check failed with exit 1:\n2 fail");
    expect(runner.dismissed).toEqual(["run1"]);
    runner.end("run2", "done", "built again");
    await flush();
    runner.end("run3", "done", "built a third time");
    await flush();
    expect(flows.get(flow.id)?.status).toBe("done");
    expect(flows.get(flow.id)?.tries).toEqual({ Test: 2 });
  });

  test("out of retries, a failing check parks the flow", async () => {
    const { runner, flows } = setup({ check: () => ({ exit: 1, output: "fail" }) });
    const flow = flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    for (const id of ["run1", "run2", "run3"]) {
      runner.end(id, "done", "x");
      await flush();
    }
    const f = flows.get(flow.id);
    expect(f?.status).toBe("gated");
    expect(f?.steps[1]?.reason).toBe("check failed with exit 1");
    expect(runner.specs.length).toBe(3);
  });

  test("the retry reason stays while the rewound-to step runs and goes once it passes", async () => {
    let calls = 0;
    const { runner, flows } = setup({ check: () => (++calls < 2 ? { exit: 1, output: "bad" } : { exit: 0, output: "ok" }) });
    const flow = flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    runner.end("run1", "done", "built");
    await flush();
    expect(flows.get(flow.id)?.retryReason).toContain("the Test step did not accept the work");
    runner.end("run2", "done", "again");
    await flush();
    expect(flows.get(flow.id)?.retryReason).toBeUndefined();
  });

  test("a judge that says partly sends the work back, then parks once retries run out", async () => {
    const J = wf(`---\nblurb: b\n---\n\n## Build\n\nBuild.\n\n## Accept\ngate: judge\nretries: 1\nback: Build\n\nJudge.\n`);
    const partly: JudgeAnswers = { fit: { choice: "partly", probabilities: { partly: 0.9 } }, evidence: { probability: 0.9 }, rules: { probability: 0 } };
    const { runner, flows } = setup({ judge: async () => partly });
    const flow = flows.start(repo(), J, "", DEFAULT_AGENT);
    for (const id of ["run1", "run2", "run3", "run4"]) {
      runner.end(id, "done", "x");
      await flush();
    }
    const f = flows.get(flow.id);
    expect(f?.status).toBe("gated");
    expect(f?.current).toBe(1);
    expect(f?.steps[1]?.reason).toBe("the judge says it only partly meets the intent");
    expect(runner.specs.length).toBe(4);
  });

  test("a rejection and a missing evaluator never retry", async () => {
    const J = wf(`---\nblurb: b\n---\n\n## Accept\ngate: judge\nretries: 2\n\nJudge.\n`);
    const a = setup({ judge: async () => ({ fit: { choice: "misses", probabilities: { misses: 0.9 } }, evidence: { probability: 0.9 }, rules: { probability: 0 } }) });
    const fa = a.flows.start(repo(), J, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    expect(a.flows.get(fa.id)?.status).toBe("gated");
    expect(a.flows.get(fa.id)?.tries).toBeUndefined();

    const V = wf(`---\nblurb: b\n---\n\n## One\ngate: verdict\nretries: 2\n\nx\n`);
    const b = setup({ evaluator: null });
    const fb = b.flows.start(repo(), V, "", DEFAULT_AGENT);
    b.runner.end("run1", "done", "x");
    await flush();
    expect(b.flows.get(fb.id)?.steps[0]?.reason).toContain("no gateway key");
    expect(b.flows.get(fb.id)?.tries).toBeUndefined();
  });
});

describe("overBudget", () => {
  test("says which limit was reached, runs first", () => {
    expect(overBudget(null, { runs: 99, workMs: 9e9 })).toBeNull();
    expect(overBudget({ runs: 3, hours: 1 }, { runs: 2, workMs: 0 })).toBeNull();
    expect(overBudget({ runs: 3, hours: 1 }, { runs: 3, workMs: 0 })).toBe("budget spent: 3 runs");
    expect(overBudget({ runs: 1, hours: 1 }, { runs: 1, workMs: 0 })).toBe("budget spent: 1 run");
    expect(overBudget({ runs: 3, hours: 1 }, { runs: 1, workMs: 3_600_000 })).toBe("budget spent: 1h");
  });
});

describe("budgets", () => {
  const ABC = (budget: string) => wf(`---\nblurb: b\nbudget: ${budget}\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n`);

  test("parks before the run that would pass the run budget; continue grants one more step", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), ABC("2 runs, 9h"), "", DEFAULT_AGENT);
    expect(flow.budget).toEqual({ runs: 2, hours: 9 });
    runner.end("run1", "done", "a");
    await flush();
    runner.end("run2", "done", "b");
    await flush();
    let f = flows.get(flow.id);
    expect(f?.status).toBe("gated");
    expect(f?.parkedFor).toBe("budget");
    expect(f?.steps[2]?.reason).toBe("budget spent: 2 runs");
    expect(f?.spent?.runs).toBe(2);
    flows.resume(flow.id, "continue");
    await flush();
    f = flows.get(flow.id);
    expect(f?.parkedFor).toBeUndefined();
    expect(f?.steps[2]?.status).toBe("running");
    runner.end("run3", "done", "c");
    await flush();
    expect(flows.get(flow.id)?.status).toBe("done");
  });

  test("parks on working time", async () => {
    let t = 0;
    const { runner, flows } = setup({ now: () => t });
    const flow = flows.start(repo(), ABC("9 runs, 1h"), "", DEFAULT_AGENT);
    t = 3_600_000;
    runner.end("run1", "done", "a");
    await flush();
    const f = flows.get(flow.id);
    expect(f?.steps[1]?.reason).toBe("budget spent: 1h");
    expect(f?.spent?.workMs).toBe(3_600_000);
  });

  test("time waiting on a prompt or parked at a gate is not counted", async () => {
    let t = 0;
    const W = wf(`---\nblurb: b\nbudget: 9 runs, 1h\n---\n\n## A\ngate: ask\n\na\n\n## B\n\nb\n`);
    const { runner, flows } = setup({ now: () => t });
    const flow = flows.start(repo(), W, "", DEFAULT_AGENT);
    t = 10 * 60_000;
    runner.set("run1", "waiting");
    t += 2 * 3_600_000;
    runner.set("run1", "working");
    t += 5 * 60_000;
    runner.end("run1", "done", "a");
    await flush();
    t += 5 * 3_600_000;
    flows.resume(flow.id, "continue");
    await flush();
    const f = flows.get(flow.id);
    expect(f?.spent?.workMs).toBe(15 * 60_000);
    expect(f?.steps[1]?.status).toBe("running");
  });

  test("stop at a budget park stops the flow", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), ABC("1 run, 9h"), "", DEFAULT_AGENT);
    runner.end("run1", "done", "a");
    await flush();
    flows.resume(flow.id, "stop");
    expect(flows.get(flow.id)?.status).toBe("stopped");
  });
});

const lastRecord = (saved: FlowRecord[], id: string): FlowRecord => {
  const rec = saved.filter((r) => r.flow.id === id).at(-1);
  if (!rec) throw new Error(`no record for ${id}`);
  // the record is one this test just wrote through the save hook
  return JSON.parse(JSON.stringify(rec)) as FlowRecord;
};
const sameAgent = () => () => DEFAULT_AGENT;

describe("records and restore", () => {
  test("a gated flow comes back gated and goes on from its snapshot", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "first done");
    await flush();
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.flows.get(flow.id)?.status).toBe("gated");
    expect(b.runner.specs.length).toBe(0);
    b.flows.resume(flow.id, "continue");
    await flush();
    expect(b.runner.specs[0]?.verb).toBe("do two · Second");
    expect(b.runner.specs[0]?.task).toContain("First: first done");
  });

  test("a flow caught mid-step reruns that step with the restart note, the rerun counted", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.runner.specs[0]?.task.startsWith(RESTART_NOTE)).toBe(true);
    expect(b.flows.get(flow.id)?.steps[0]).toMatchObject({ status: "running", runId: "run1" });
    expect(b.flows.get(flow.id)?.spent?.runs).toBe(2);
    expect(b.flows.get(flow.id)?.restarted).toBeUndefined();
  });

  test("the retry count survives, so a flow with one retry left gets exactly one", async () => {
    const fail = () => ({ exit: 1, output: "fail" });
    const a = setup({ check: fail });
    const flow = a.flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const rec = lastRecord(a.saved, flow.id);
    expect(rec.flow.tries).toEqual({ Test: 1 });
    const b = setup({ check: fail });
    b.flows.restore([rec], () => repo(), sameAgent);
    expect(b.runner.specs[0]?.task).toContain(RESTART_NOTE);
    expect(b.runner.specs[0]?.task).toContain("the Test step did not accept the work");
    b.runner.end("run1", "done", "x");
    await flush();
    b.runner.end("run2", "done", "x");
    await flush();
    expect(b.flows.get(flow.id)?.status).toBe("gated");
    expect(b.flows.get(flow.id)?.steps[1]?.reason).toBe("check failed with exit 1");
    expect(b.flows.get(flow.id)?.tries).toEqual({ Test: 2 });
    expect(b.runner.specs.length).toBe(2);
  });

  test("a budget park still resumes after a restart", async () => {
    const W = wf(`---\nblurb: b\nbudget: 1 run, 9h\n---\n\n## A\n\na\n\n## B\n\nb\n`);
    const a = setup();
    const flow = a.flows.start(repo(), W, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "a");
    await flush();
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.flows.get(flow.id)?.parkedFor).toBe("budget");
    b.flows.resume(flow.id, "continue");
    await flush();
    expect(b.flows.get(flow.id)?.steps[1]?.status).toBe("running");
  });

  test("a flow whose repo left the scan fails with the reason; a finished one stays finished; a fleet id is dropped", async () => {
    const a = setup();
    const working = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    const rec = lastRecord(a.saved, working.id);
    rec.flow.fleetId = "gone";
    const b = setup();
    b.flows.restore([rec], () => undefined, sameAgent);
    const f = b.flows.get(working.id);
    expect(f?.status).toBe("failed");
    expect(f?.error).toBe("the repo is not in the scan any more");
    expect(f?.fleetId).toBeUndefined();
    expect(b.runner.specs.length).toBe(0);

    const c = setup();
    const done = c.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    c.flows.stop(done.id);
    await flush();
    const d = setup();
    d.flows.restore([lastRecord(c.saved, done.id)], () => repo(), sameAgent);
    expect(d.flows.get(done.id)?.status).toBe("stopped");
    expect(d.runner.specs.length).toBe(0);
  });

  test("restoring a gated and a finished record emits nothing", async () => {
    const a = setup();
    const gated = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const c = setup();
    const done = c.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    c.flows.stop(done.id);
    await flush();
    const b = setup();
    b.flows.restore([lastRecord(a.saved, gated.id), lastRecord(c.saved, done.id)], () => repo(), sameAgent);
    expect(b.flows.get(gated.id)?.status).toBe("gated");
    expect(b.flows.get(done.id)?.status).toBe("stopped");
    expect(b.changes.length).toBe(0);
    expect(b.saved.length).toBe(0);
  });

  test("a record carries the live working time, not the banked one", async () => {
    let t = 0;
    const W = wf(`---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n`);
    const a = setup({ now: () => t });
    const flow = a.flows.start(repo(), W, "", DEFAULT_AGENT);
    t = 5000;
    a.runner.end("run1", "done", "a");
    await flush();
    // step B started with the clock still running, so nothing is banked yet
    expect(a.flows.get(flow.id)?.spent?.workMs).toBe(0);
    expect(lastRecord(a.saved, flow.id).flow.spent?.workMs).toBe(5000);
  });

  test("a gated flow whose repo left the scan fails", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => undefined, sameAgent);
    expect(b.flows.get(flow.id)?.status).toBe("failed");
    expect(b.flows.get(flow.id)?.error).toBe("the repo is not in the scan any more");
  });

  test("detach stops saving, so a server stopping does not save every flow as stopped", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const before = a.saved.length;
    a.flows.detach();
    a.flows.stopAll();
    expect(a.flows.get(flow.id)?.status).toBe("stopped");
    expect(a.saved.length).toBe(before);
    expect(lastRecord(a.saved, flow.id).flow.status).toBe("gated");
  });

  test("one bad record is skipped with a line naming it, and the rest come back", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const good = lastRecord(a.saved, flow.id);
    const bad = lastRecord(a.saved, flow.id);
    // steps that are no objects, which the engine cannot reset
    Object.assign(bad.flow, { id: "badbad01", status: "working", steps: ["x", "y"] });
    const b = setup();
    const logged: string[] = [];
    const log = spyOn(console, "error").mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      b.flows.restore([bad, good], () => repo(), sameAgent);
    } finally {
      log.mockRestore();
    }
    expect(b.flows.get("badbad01")).toBeUndefined();
    expect(b.flows.get(flow.id)?.status).toBe("gated");
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("badbad01");
  });

  test("a repo is found by its path, and the flow takes the id it has in this scan", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const rec = lastRecord(a.saved, flow.id);
    expect(rec.repoPath).toBe("/tmp/r");
    rec.flow.repoId = "an-id-from-another-root";
    const b = setup();
    b.flows.restore([rec], (path) => (path === "/tmp/r" ? repo() : undefined), sameAgent);
    expect(b.flows.get(flow.id)?.status).toBe("gated");
    expect(b.flows.get(flow.id)?.repoId).toBe("r");
  });

  test("a status read that lands after the flow was dismissed neither saves nor emits it", async () => {
    let answer: (st: Repo["status"]) => void = () => {};
    const a = setup({ status: () => new Promise((r) => (answer = r)) });
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.flows.stop(flow.id);
    a.flows.dismiss(flow.id);
    const saves = a.saved.length;
    const changes = a.changes.length;
    answer({ branch: "main", upstream: null, ahead: 0, behind: 0, files: [], lastCommit: null, user: null });
    await flush();
    await flush();
    expect(a.saved.length).toBe(saves);
    expect(a.changes.length).toBe(changes);
  });

  test("dismissing forgets the record", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.flows.stop(flow.id);
    await flush();
    a.flows.dismiss(flow.id);
    expect(a.forgotten).toEqual([flow.id]);
  });
});

describe("the stage runner away", () => {
  /** a runner whose start throws the stage runner's away error while `away` */
  const awayRunner = (s: ReturnType<typeof setup>) => {
    const state = { away: true };
    const start = s.runner.start.bind(s.runner);
    s.runner.start = (...args: Parameters<FakeRunner["start"]>) => {
      if (state.away) throw new StageAwayError();
      return start(...args);
    };
    return state;
  };

  test("a step whose start finds the stage runner away parks, and resume runs it", async () => {
    const s = setup();
    const state = awayRunner(s);
    const f = s.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    let now = s.flows.get(f.id);
    expect(now?.status).toBe("gated");
    expect(now?.parkedFor).toBe("stage");
    expect(now?.steps[0]?.reason).toContain("the stage runner is not answering");
    expect(now?.spent?.runs ?? 0).toBe(0);
    state.away = false;
    s.flows.resume(f.id, "continue");
    await flush();
    now = s.flows.get(f.id);
    expect(now?.status).toBe("working");
    expect(now?.parkedFor).toBeUndefined();
    expect(now?.steps[0]).toMatchObject({ status: "running", runId: "run1" });
    // no extra step was granted: the stage park is not a budget
    expect(now?.grace).toBeUndefined();
  });

  test("any other throw at a step's start still fails the flow", () => {
    const s = setup();
    s.runner.start = () => {
      throw new Error("r already has a run going");
    };
    const f = s.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    expect(s.flows.get(f.id)?.status).toBe("failed");
  });

  test("a restored mid-step flow that finds the runner away keeps its restart note for the rerun", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    const b = setup();
    const state = awayRunner(b);
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.flows.get(flow.id)?.parkedFor).toBe("stage");
    state.away = false;
    b.flows.resume(flow.id, "continue");
    await flush();
    expect(b.runner.specs[0]?.task.startsWith(RESTART_NOTE)).toBe(true);
  });

  const seedRepo = (): Repo => ({ ...repo(), id: "_incubator/coin", name: "coin", path: "/tmp/_incubator/coin" });

  test("a seed run whose error names the stage runner, while the runner answered, fails and parks for nothing", async () => {
    const { runner, flows } = setup();
    const f = flows.start(seedRepo(), TWO, "", DEFAULT_AGENT);
    // what a stage could print to its own stderr before it exits
    runner.end("run1", "failed", "", `Claude Code exited (code 1) without a result: ${STAGE_AWAY}`);
    await flush();
    expect(flows.get(f.id)?.status).toBe("failed");
    expect(flows.get(f.id)?.parkedFor).toBeUndefined();
    expect(flows.resumeStageParks()).toBe(0);
    expect(runner.specs).toHaveLength(1);
  });

  test("a non-seed run whose error happens to name the stage runner still fails", async () => {
    const { runner, flows } = setup();
    const f = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    runner.end("run1", "failed", "", `Claude Code exited (code 1) without a result: ${STAGE_AWAY}`);
    await flush();
    expect(flows.get(f.id)?.status).toBe("failed");
    expect(flows.get(f.id)?.parkedFor).toBeUndefined();
  });

  const BUILD_CHECKED = wf(`---
blurb: b
---

## Build
check: bun test
retries: 1

Build it.

## Ship

Ship it.
`);

  test("a check that finds the stage runner away parks without spending a retry, and resume reruns the check alone", async () => {
    let calls = 0;
    const s = setup({ check: () => (++calls === 1 ? { exit: 127, output: STAGE_AWAY, away: true } : { exit: 0, output: "ok" }) });
    const f = s.flows.start(seedRepo(), BUILD_CHECKED, "", DEFAULT_AGENT);
    s.runner.end("run1", "done", "built it");
    await flush();
    let now = s.flows.get(f.id);
    expect(now?.status).toBe("gated");
    expect(now?.parkedFor).toBe("stage");
    expect(now?.stageCheck).toBe(true);
    expect(now?.tries).toBeUndefined();
    expect(now?.steps[0]?.reason).toBe(STAGE_AWAY);
    expect(now?.steps[0]?.summary).toBe("built it");
    s.flows.resume(f.id, "continue");
    await flush();
    now = s.flows.get(f.id);
    expect(s.checks).toEqual(["bun test", "bun test"]);
    // the agent's step is not run again: the next run is the Ship step's
    expect(s.runner.specs).toHaveLength(2);
    expect(s.runner.specs[1]?.verb).toContain("Ship");
    expect(now?.parkedFor).toBeUndefined();
    expect(now?.stageCheck).toBeUndefined();
    expect(now?.steps[0]).toMatchObject({ status: "passed", summary: "built it", check: { command: "bun test", exit: 0, output: "ok" } });
    expect(now?.steps[1]?.status).toBe("running");
  });

  test("a check parked for the stage runner comes back from a restart still a check park", async () => {
    const a = setup({ check: () => ({ exit: 127, output: STAGE_AWAY, away: true }) });
    const f = a.flows.start(seedRepo(), BUILD_CHECKED, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "built it");
    await flush();
    expect(a.flows.get(f.id)?.stageCheck).toBe(true);
    const b = setup();
    b.flows.restore([lastRecord(a.saved, f.id)], () => seedRepo(), sameAgent);
    expect(b.flows.get(f.id)).toMatchObject({ status: "gated", parkedFor: "stage", stageCheck: true });
    b.flows.resume(f.id, "continue");
    await flush();
    expect(b.checks).toEqual(["bun test"]);
    // the agent's step is not run again: the one run is the Ship step's
    expect(b.runner.specs).toHaveLength(1);
    expect(b.runner.specs[0]?.verb).toContain("Ship");
    expect(b.flows.get(f.id)?.steps[0]).toMatchObject({ status: "passed", summary: "built it" });
  });

  test("a check-only step that finds the runner away parks, and resume reruns its check, not the step it goes back to", async () => {
    let calls = 0;
    const s = setup({ check: () => (++calls === 1 ? { exit: 127, output: STAGE_AWAY, away: true } : { exit: 0, output: "ok" }) });
    const f = s.flows.start(seedRepo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    s.runner.end("run1", "done", "built");
    await flush();
    expect(s.flows.get(f.id)).toMatchObject({ status: "gated", parkedFor: "stage", current: 1 });
    s.flows.resume(f.id, "retry");
    await flush();
    expect(s.runner.specs).toHaveLength(1);
    expect(s.flows.get(f.id)?.status).toBe("done");
    expect(s.flows.get(f.id)?.tries).toBeUndefined();
  });

  test("a check park gives the words the check gave, as when no runner is set up", async () => {
    const why = "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1";
    const s = setup({ check: () => ({ exit: 127, output: why, away: true }) });
    const f = s.flows.start(seedRepo(), BUILD_CHECKED, "", DEFAULT_AGENT);
    s.runner.end("run1", "done", "built it");
    await flush();
    expect(s.flows.get(f.id)).toMatchObject({ status: "gated", parkedFor: "stage", stageCheck: true });
    expect(s.flows.get(f.id)?.steps[0]?.reason).toBe(why);
  });

  test("a check that only prints the runner's words and exits 127 is a failed check, not a park", async () => {
    const s = setup({ check: () => ({ exit: 127, output: STAGE_AWAY }) });
    const f = s.flows.start(seedRepo(), BUILD_CHECKED, "", DEFAULT_AGENT);
    s.runner.end("run1", "done", "built it");
    await flush();
    expect(s.flows.get(f.id)?.parkedFor).toBeUndefined();
    expect(s.flows.get(f.id)?.tries).toEqual({ Build: 1 });
  });

  describe("resumeStageParks, on every good hello", () => {
    test("a step parked at its start runs again", async () => {
      const s = setup();
      const state = awayRunner(s);
      const f = s.flows.start(seedRepo(), TWO, "", DEFAULT_AGENT);
      expect(s.flows.get(f.id)?.parkedFor).toBe("stage");
      state.away = false;
      expect(s.flows.resumeStageParks()).toBe(1);
      await flush();
      expect(s.flows.get(f.id)?.parkedFor).toBeUndefined();
      expect(s.flows.get(f.id)?.steps[0]).toMatchObject({ status: "running", runId: "run1" });
    });

    test("a step whose run lost the runner runs again", async () => {
      const { runner, flows } = setup();
      const f = flows.start(seedRepo(), TWO, "", DEFAULT_AGENT);
      runner.end("run1", "failed", "", `Claude Code exited (code 127) without a result: ${STAGE_AWAY}`, true);
      await flush();
      expect(flows.get(f.id)?.parkedFor).toBe("stage");
      expect(flows.resumeStageParks()).toBe(1);
      await flush();
      expect(flows.get(f.id)?.steps[0]).toMatchObject({ status: "running", runId: "run2" });
    });

    test("a check park reruns the check alone", async () => {
      let calls = 0;
      const s = setup({ check: () => (++calls === 1 ? { exit: 127, output: STAGE_AWAY, away: true } : { exit: 0, output: "ok" }) });
      const f = s.flows.start(seedRepo(), BUILD_CHECKED, "", DEFAULT_AGENT);
      s.runner.end("run1", "done", "built it");
      await flush();
      expect(s.flows.get(f.id)?.stageCheck).toBe(true);
      expect(s.flows.resumeStageParks()).toBe(1);
      await flush();
      expect(s.checks).toEqual(["bun test", "bun test"]);
      expect(s.runner.specs).toHaveLength(2);
      expect(s.runner.specs[1]?.verb).toContain("Ship");
      expect(s.flows.get(f.id)?.steps[0]).toMatchObject({ status: "passed", summary: "built it" });
    });

    test("a user's gate and a budget park stay as they are", async () => {
      const gate = setup();
      const g = gate.flows.start(seedRepo(), TWO, "", DEFAULT_AGENT);
      gate.runner.end("run1", "done", "first");
      await flush();
      expect(gate.flows.get(g.id)).toMatchObject({ status: "gated" });
      expect(gate.flows.get(g.id)?.parkedFor).toBeUndefined();
      expect(gate.flows.resumeStageParks()).toBe(0);
      await flush();
      expect(gate.flows.get(g.id)?.status).toBe("gated");
      expect(gate.runner.specs).toHaveLength(1);

      const budget = setup();
      const B = wf(`---\nblurb: b\nbudget: 1 run, 9h\n---\n\n## A\n\na\n\n## B\n\nb\n`);
      const b = budget.flows.start(seedRepo(), B, "", DEFAULT_AGENT);
      budget.runner.end("run1", "done", "a");
      await flush();
      expect(budget.flows.get(b.id)).toMatchObject({ status: "gated", parkedFor: "budget" });
      expect(budget.flows.resumeStageParks()).toBe(0);
      await flush();
      expect(budget.flows.get(b.id)).toMatchObject({ status: "gated", parkedFor: "budget" });
      expect(budget.runner.specs).toHaveLength(1);
    });
  });

  test("a step run that ends because the stage runner went away parks too", async () => {
    const { runner, flows } = setup();
    const f = flows.start(seedRepo(), TWO, "", DEFAULT_AGENT);
    runner.end("run1", "failed", "", `Claude Code exited (code 127) without a result: ${STAGE_AWAY}: connect ENOENT /run/canopy-stage/stage.sock`, true);
    await flush();
    const now = flows.get(f.id);
    expect(now?.status).toBe("gated");
    expect(now?.parkedFor).toBe("stage");
    flows.resume(f.id, "continue");
    await flush();
    expect(flows.get(f.id)?.steps[0]).toMatchObject({ status: "running", runId: "run2" });
  });
});
