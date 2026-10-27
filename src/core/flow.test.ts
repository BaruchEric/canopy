import { describe, expect, spyOn, test } from "bun:test";
import { Flows, FLOW_PARALLEL, whenHolds, overBudget, PICKED_UP_NOTE, RESTART_NOTE, RESUME_NOTE, stepSpec, summaryOf, type CheckResult, type FlowRecord, type FlowRunner } from "./flow";
import { STAGE_AWAY, StageAwayError } from "./stagewire";
import { parseWorkflow, type RecordedWorkflow } from "./workflow";
import { DEFAULT_AGENT, type AgentSettings, type EvidenceFile, type Fleet, type Flow, type JudgeAnswers, type Repo, type Run, type VerdictAnswers, type Workflow } from "./types";
import type { ActionSpec } from "./actions";
import type { BranchStart } from "./runner";

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
  branches: (BranchStart | undefined)[] = [];
  onChange: (run: Run) => void = () => {};
  private n = 0;
  start(r: Repo, action: string, spec: ActionSpec, note: string, agent: AgentSettings = DEFAULT_AGENT, _by?: string, _scope?: undefined, branch?: BranchStart): Run {
    this.agents.push(agent);
    this.branches.push(branch);
    this.n += 1;
    const run: Run = {
      id: `run${this.n}`, repoId: r.id, action, verb: spec.verb, progress: spec.progress,
      expectsChange: spec.expectsChange, chat: false, harness: agent.harness, note, status: "working",
      startedAt: 0, steps: [], prompt: null,
      ...(branch ? { branch: { ...branch.branch, state: "working" as const } } : {}),
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
  /** the harness names the run's session, as its first message does */
  session(id: string, session: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(id);
    run.session = session;
    this.onChange(run);
  }
  /** the last started run's id */
  last(): string { return `run${this.n}`; }
}

function setup(opts: {
  check?: (cmd: string, signal: AbortSignal) => CheckResult | Promise<CheckResult>;
  checkTools?: (repo: Repo, cmd: string) => Promise<string[]> | null;
  evaluator?: ((state: string) => Promise<VerdictAnswers>) | null;
  judge?: ((state: string) => Promise<JudgeAnswers>) | null;
  evidence?: (repo: Repo, paths: string[]) => Promise<EvidenceFile[]>;
  status?: () => Promise<Repo["status"]>;
  fingerprint?: (repo: Repo) => Promise<string | null>;
  now?: () => number;
  stopGraceMs?: number;
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
    check: async (_repo, command, signal) => {
      checks.push(command);
      return opts.check ? opts.check(command, signal) : { exit: 0, output: "" };
    },
    checkTools: opts.checkTools,
    evaluator: opts.evaluator ?? null,
    judge: opts.judge ?? null,
    evidence: opts.evidence,
    status: opts.status,
    fingerprint: opts.fingerprint,
    now: opts.now,
    ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
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

  test("a step's spec names its workflow, its step and where the file came from, the scope a remembered rule can take", () => {
    expect(stepSpec(TWO, 1, []).flowStep).toEqual({ workflow: TWO.name, step: TWO.steps[1]?.name ?? "", source: "bundled" });
    expect(stepSpec({ ...TWO, source: "repo" }, 1, []).flowStep?.source).toBe("repo");
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
  test("a step run that ends limited parks the flow for capacity; continue runs the step again (FR-036)", async () => {
    const NOW = Date.UTC(2026, 9, 26, 12);
    const { runner, flows } = setup({ now: () => NOW });
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    runner.end("run1", "limited", "", "You've hit your limit · resets 3pm");
    await flush();
    const parked = flows.get(flow.id);
    expect([parked?.status, parked?.parkedFor, parked?.steps[0]?.status, parked?.steps[0]?.reason]).toEqual(["gated", "capacity", "gated", "waiting for capacity (resets 15:00)"]);
    flows.resume(flow.id, "continue");
    await flush();
    expect([flows.get(flow.id)?.steps[0]?.status, flows.get(flow.id)?.parkedFor, runner.specs.length]).toEqual(["running", undefined, 2]);

    const b = setup({ now: () => NOW });
    const fallback = b.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    b.runner.end("run1", "limited", "", "usage limit reached");
    await flush();
    expect(b.flows.get(fallback.id)?.steps[0]?.reason).toBe("waiting for capacity (resets 13:00)");
  });

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

describe("a check line's own tools", () => {
  const GATED = wf(`---
name: gated
verb: gate
blurb: b
---

## Gates
tools: read
check: @gates

Run them.
`);

  test("a step whose check names tools gets them on top of its own", async () => {
    const asked: string[] = [];
    const { runner, flows } = setup({
      checkTools: (_r, c) => {
        asked.push(c);
        return Promise.resolve(["Bash(cargo test)"]);
      },
    });
    flows.start(repo(), GATED, "", DEFAULT_AGENT);
    await flush();
    expect(asked).toEqual(["@gates"]);
    expect(runner.specs[0]?.allowedTools).toContain("Bash(cargo test)");
    expect(runner.specs[0]?.allowedTools).toContain("Read");
  });

  test("null starts the run at once, with the step's tools alone", () => {
    const { runner, flows } = setup({ checkTools: () => null });
    flows.start(repo(), GATED, "", DEFAULT_AGENT);
    expect(runner.specs[0]?.allowedTools).not.toContain("Bash(cargo test)");
  });
});

describe("a step's own agent", () => {
  const codex: AgentSettings = { ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5" };
  const PROFILED = wf(`---\nblurb: b\n---\n\n## Plan\n\nThink.\n\n## Review\nagent: review\n\nLook.\n`);

  test("a step naming a profile starts on it; the rest follow the repo's route", async () => {
    const { runner, flows } = setup();
    const asked: (string | undefined)[] = [];
    const flow = flows.start(repo(), PROFILED, "", (profile, workflow) => {
      expect(workflow).toBe(PROFILED.name);
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

  test("restoring a trigger workflow keeps its name and job routing context", () => {
    const a = setup();
    const workflow: Workflow = { ...PROFILED, agentRole: "job" };
    const flow = a.flows.start(repo(), workflow, "", DEFAULT_AGENT);
    const b = setup();
    const asked: unknown[] = [];
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), () => (profile, name, role) => {
      asked.push({ profile, name, role });
      return DEFAULT_AGENT;
    });
    expect(asked).toEqual([{ profile: undefined, name: workflow.name, role: "job" }]);
  });

  test("a restored workflow reports an incompatible new route as failed", () => {
    const a = setup();
    const flow = a.flows.start(repo(), PROFILED, "", DEFAULT_AGENT);
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), () => () => {
      throw new Error("a trigger workflow needs Claude Code");
    });
    expect(b.flows.get(flow.id)).toMatchObject({ status: "failed", steps: [{ status: "failed", reason: "a trigger workflow needs Claude Code" }, { status: "skipped" }] });
    expect(b.runner.agents).toHaveLength(0);
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

describe("resuming the session a restart cut short", () => {
  const codex = (): AgentSettings => ({ ...DEFAULT_AGENT, harness: "codex" });

  test("the step's session is saved as soon as the harness names it", () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.session("run1", "s1");
    expect(lastRecord(a.saved, flow.id).flow.steps[0]).toMatchObject({ session: "s1", harness: "claude" });
  });

  test("a flow caught mid-step resumes the step's Claude session with the resume note", () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.session("run1", "s1");
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.runner.specs[0]?.resume).toBe("s1");
    expect(b.runner.specs[0]?.message).toBe(RESUME_NOTE);
    expect(b.flows.get(flow.id)?.steps[0]).toMatchObject({ status: "running", runId: "run1" });
  });

  test("a Codex session, or a step that would now run on Codex, starts fresh with the restart note", () => {
    const a = setup();
    const ca = a.flows.start(repo(), TWO, "", codex());
    a.runner.session("run1", "t1");
    const b = setup();
    b.flows.restore([lastRecord(a.saved, ca.id)], () => repo(), () => codex);
    expect(b.runner.specs[0]?.resume).toBeUndefined();
    expect(b.runner.specs[0]?.task.startsWith(RESTART_NOTE)).toBe(true);

    const c = setup();
    const cc = c.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    c.runner.session("run1", "s1");
    const d = setup();
    d.flows.restore([lastRecord(c.saved, cc.id)], () => repo(), () => codex);
    expect(d.runner.specs[0]?.resume).toBeUndefined();
    expect(d.runner.specs[0]?.task.startsWith(RESTART_NOTE)).toBe(true);
  });

  test("a resume that fails before a turn falls back once to a fresh run with the restart note", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.session("run1", "s1");
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    // Claude Code's answer to a session it cannot find: a result with no turns
    b.runner.session("run1", "s1");
    b.runner.end("run1", "failed", "", "No conversation found with session ID: s1");
    await flush();
    expect(b.runner.specs).toHaveLength(2);
    expect(b.runner.specs[1]?.resume).toBeUndefined();
    expect(b.runner.specs[1]?.task.startsWith(RESTART_NOTE)).toBe(true);
    expect(b.flows.get(flow.id)?.steps[0]).toMatchObject({ status: "running", runId: "run2" });
    b.runner.end("run2", "failed", "", "boom");
    await flush();
    expect(b.runner.specs).toHaveLength(2);
    expect(b.flows.get(flow.id)?.status).toBe("failed");
  });

  test("a resumed run that fails after it worked, or is stopped, does not fall back", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.session("run1", "s1");
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    b.runner.end("run1", "failed", "half done", "boom");
    await flush();
    expect(b.runner.specs).toHaveLength(1);
    expect(b.flows.get(flow.id)?.status).toBe("failed");

    const c = setup();
    c.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    c.flows.stop(flow.id);
    await flush();
    expect(c.runner.specs).toHaveLength(1);
    expect(c.flows.get(flow.id)?.status).toBe("stopped");
  });

  test("a rewind after a resumed step starts its rerun fresh", async () => {
    const a = setup({ check: () => ({ exit: 1, output: "fail" }) });
    const flow = a.flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    a.runner.session("run1", "s1");
    const b = setup({ check: () => ({ exit: 1, output: "fail" }) });
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.runner.specs[0]?.resume).toBe("s1");
    b.runner.end("run1", "done", "built");
    await flush();
    expect(b.runner.specs).toHaveLength(2);
    expect(b.runner.specs[1]?.resume).toBeUndefined();
    expect(b.runner.specs[1]?.task).not.toContain(RESTART_NOTE);
  });

  test("a restored step that parks for the stage runner keeps its session for the rerun", async () => {
    const seed = (): Repo => ({ ...repo(), id: "_incubator/coin", name: "coin", path: "/tmp/_incubator/coin" });
    const a = setup();
    const flow = a.flows.start(seed(), TWO, "", DEFAULT_AGENT);
    a.runner.session("run1", "s1");
    const b = setup();
    let away = true;
    const start = b.runner.start.bind(b.runner);
    b.runner.start = (...args) => {
      if (away) throw new StageAwayError();
      return start(...args);
    };
    b.flows.restore([lastRecord(a.saved, flow.id)], () => seed(), sameAgent);
    await flush();
    expect(b.flows.get(flow.id)).toMatchObject({ status: "gated", parkedFor: "stage" });
    away = false;
    b.flows.resume(flow.id, "continue");
    await flush();
    expect(b.runner.specs[0]?.resume).toBe("s1");
  });
});

describe("a start sent twice", () => {
  test("the same request finds the flow it started instead of starting another", () => {
    const { runner, flows } = setup();
    const first = flows.start(repo(), TWO, "", DEFAULT_AGENT, { request: "req-1" });
    const again = flows.start(repo(), TWO, "", DEFAULT_AGENT, { request: "req-1" });
    expect(again.id).toBe(first.id);
    expect(runner.specs).toHaveLength(1);
    expect(flows.forRequest("req-1")?.id).toBe(first.id);
    expect(() => flows.start({ ...repo(), id: "other", name: "other" }, TWO, "", DEFAULT_AGENT, { request: "req-1" })).toThrow("another repo");
  });

  test("a restored flow keeps its request", () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT, { request: "req-1" });
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.flows.start(repo(), TWO, "", DEFAULT_AGENT, { request: "req-1" }).id).toBe(flow.id);
    expect(b.runner.specs).toHaveLength(1);
  });

  test("the same request finds the fleet it started", () => {
    const { runner, flows } = setup();
    const repos = [{ ...repo(), id: "a", name: "a" }, { ...repo(), id: "b", name: "b" }];
    const first = flows.startFleet(repos, TWO, "", () => DEFAULT_AGENT, "req-2");
    const again = flows.startFleet(repos, TWO, "", () => DEFAULT_AGENT, "req-2");
    expect(again.id).toBe(first.id);
    expect(flows.fleets()).toHaveLength(1);
    expect(runner.specs).toHaveLength(2);
    expect(flows.fleetForRequest("req-2")?.id).toBe(first.id);
  });
});

describe("stopping from the bottom up", () => {
  const CHECK_ONLY = wf(`---\nblurb: b\n---\n\n## Test\ncheck: bun test\n`);
  /** a check that runs until its signal aborts it */
  const untilAborted = (_cmd: string, signal: AbortSignal): Promise<CheckResult> =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exit: 143, output: "killed" }), { once: true }));

  test("a stop during a check aborts the check and ends the flow once it has exited", async () => {
    let signal: AbortSignal | null = null;
    let exit: (() => void) | null = null;
    const { flows } = setup({
      check: (_cmd, s) => {
        signal = s;
        return new Promise((resolve) => (exit = () => resolve({ exit: 143, output: "killed" })));
      },
    });
    const flow = flows.start(repo(), CHECK_ONLY, "", DEFAULT_AGENT);
    await flush();
    flows.stop(flow.id);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(flows.get(flow.id)?.status).toBe("working");
    // a second stop while it winds down changes nothing
    flows.stop(flow.id);
    (exit as (() => void) | null)?.();
    await flush();
    const f = flows.get(flow.id);
    expect(f?.status).toBe("stopped");
    expect(f?.steps[0]).toMatchObject({ status: "failed", reason: "stopped" });
    expect(f?.steps[0]?.check).toBeUndefined();
  });

  test("a check that ignores the abort stops being waited on after the grace", async () => {
    const { flows } = setup({ check: () => new Promise<CheckResult>(() => {}), stopGraceMs: 5 });
    const flow = flows.start(repo(), CHECK_ONLY, "", DEFAULT_AGENT);
    await flush();
    flows.stop(flow.id);
    expect(flows.get(flow.id)?.status).toBe("working");
    await new Promise((r) => setTimeout(r, 20));
    expect(flows.get(flow.id)?.status).toBe("stopped");
  });

  test("a fleet stopping waits for every flow to end before it says stopped", async () => {
    const DIRTY_CHECK = wf(`---\nblurb: b\n---\n\n## Test\ncheck: bun test\n`);
    const { flows, fleets } = setup({ check: untilAborted, stopGraceMs: 1_000 });
    const repos = [{ ...repo(), id: "a", name: "a" }, { ...repo(), id: "b", name: "b" }];
    const fleet = flows.startFleet(repos, DIRTY_CHECK, "", () => DEFAULT_AGENT);
    await flush();
    flows.stopFleet(fleet.id);
    // the aborted checks settle on a later tick: until then the fleet is stopping
    expect(flows.getFleet(fleet.id)).toMatchObject({ status: "working", stopping: true });
    expect(() => flows.dismissFleet(fleet.id)).toThrow();
    await flush();
    expect(flows.getFleet(fleet.id)?.status).toBe("stopped");
    expect(flows.getFleet(fleet.id)?.stopping).toBeUndefined();
    expect(fleets.at(-1)?.status).toBe("stopped");
    expect(flows.list().every((f) => f.status === "stopped")).toBe(true);
  });
});

describe("a flow on a branch", () => {
  const CHECKED = wf(`---
name: checked
verb: fix
blurb: b
expects-change: true
---

## Triage

Look first.

## Fix
check: bun test
retries: 1

Fix it.
`);
  const cut = (): BranchStart => ({
    branch: { name: "run/fix-b1", target: "main", base: "abc", dir: "/cfg/worktrees/r-b1", state: "working", origin: "b1", openPr: true },
    prepare: async () => {},
  });
  function branchSetup(state: () => "ready" | "nothing" | "uncommitted" = () => "ready") {
    const runner = new FakeRunner();
    const checkedIn: string[] = [];
    const handed: { flow: Flow; runId: string | undefined }[] = [];
    const flows = new Flows(runner, {
      onChange: () => {},
      onGone: () => {},
      onFleet: () => {},
      onFleetGone: () => {},
      check: async (r) => {
        checkedIn.push(r.path);
        return { exit: 0, output: "" };
      },
      evaluator: null,
      branchState: async () => state(),
      onBranchEnd: (flow, runId) => handed.push({ flow: structuredClone(flow), runId }),
    });
    runner.onChange = (run) => flows.onRun(run);
    return { runner, flows, checkedIn, handed };
  }

  test("every step runs held on the branch, the setup only before the first, and checks run in the worktree", async () => {
    const { runner, flows, checkedIn } = branchSetup();
    const flow = flows.start(repo(), CHECKED, "an issue", DEFAULT_AGENT, { branch: cut() });
    expect(flow.branch).toMatchObject({ origin: "b1", state: "working" });
    expect(flow.branch?.held).toBeUndefined();
    expect(runner.branches[0]?.branch).toMatchObject({ origin: "b1", held: true, openPr: true });
    expect(runner.branches[0]?.prepare).toBeDefined();
    runner.end("run1", "done", "triaged");
    await flush();
    expect(runner.branches[1]?.branch.held).toBe(true);
    expect(runner.branches[1]?.prepare).toBeUndefined();
    runner.end("run2", "done", "fixed");
    await flush();
    expect(checkedIn).toEqual(["/cfg/worktrees/r-b1"]);
  });

  test("a done flow reads its worktree and hands the branch over by its last step's run", async () => {
    const { runner, flows, handed } = branchSetup();
    const flow = flows.start(repo(), CHECKED, "an issue", DEFAULT_AGENT, { branch: cut() });
    runner.end("run1", "done", "triaged");
    await flush();
    runner.end("run2", "done", "fixed");
    await flush();
    await flush();
    expect(flow.status).toBe("done");
    expect(flow.branch).toMatchObject({ state: "ready" });
    expect(flow.outcome).toBe("changed");
    expect(handed).toHaveLength(1);
    expect(handed[0]?.runId).toBe("run2");
    expect(handed[0]?.flow.branch?.held).toBeUndefined();
  });

  test("a stopped flow keeps its branch and hands nothing over", async () => {
    const { runner, flows, handed } = branchSetup(() => "uncommitted");
    const flow = flows.start(repo(), CHECKED, "an issue", DEFAULT_AGENT, { branch: cut() });
    flows.stop(flow.id);
    await flush();
    await flush();
    expect(runner.stopped).toEqual(["run1"]);
    expect(flow.status).toBe("stopped");
    expect(flow.branch?.state).toBe("uncommitted");
    expect(handed).toHaveLength(0);
  });

  test("the checkout's own run or flow does not stand in its way, and it does not count as the checkout's flow", () => {
    const { runner, flows } = branchSetup();
    runner.start(repo(), "ask", { verb: "ask" } as ActionSpec, "busy");
    const flow = flows.start(repo(), CHECKED, "an issue", DEFAULT_AGENT, { branch: cut() });
    expect(flow.status).toBe("working");
    expect(flows.activeFor("r")).toBeUndefined();
    expect(() => flows.start(repo(), CHECKED, "plain", DEFAULT_AGENT)).toThrow();
  });

  test("a stopped flow is picked up at its step, resuming that step's session, and the steps after it follow", async () => {
    const { runner, flows, handed } = branchSetup();
    const flow = flows.start(repo(), CHECKED, "an issue", DEFAULT_AGENT, { branch: cut() });
    runner.end("run1", "done", "triaged");
    await flush();
    runner.session("run2", "sess-fix");
    flows.stop(flow.id);
    await flush();
    await flush();
    expect(flow.status).toBe("stopped");
    expect(flow.steps[1]?.status).toBe("failed");
    flows.pickUp(flow.id);
    expect(flow.status).toBe("working");
    expect(flow.branch?.state).toBe("working");
    expect(runner.specs[2]).toMatchObject({ resume: "sess-fix", message: PICKED_UP_NOTE });
    expect(runner.branches[2]?.branch).toMatchObject({ origin: "b1", held: true });
    runner.end("run3", "done", "fixed");
    await flush();
    await flush();
    expect(flow.status).toBe("done");
    expect(handed.map((x) => x.runId)).toEqual(["run3"]);
  });

  test("only a stopped flow on a branch is picked up", () => {
    const { flows } = branchSetup();
    const going = flows.start(repo(), CHECKED, "an issue", DEFAULT_AGENT, { branch: cut() });
    expect(() => flows.pickUp(going.id)).toThrow("not stopped");
    expect(() => flows.pickUp("nope")).toThrow("unknown flow");
  });

  test("a restart reruns the step on the same branch, with no setup", () => {
    const { runner, flows } = branchSetup();
    const flow = flows.start(repo(), CHECKED, "an issue", DEFAULT_AGENT, { branch: cut() });
    const rec: FlowRecord = { v: 1, flow: structuredClone(flow), repoPath: "/tmp/r", workflow: CHECKED, before: "", savedAt: 0 };
    const { runner: r2, flows: f2 } = branchSetup();
    f2.restore([rec], () => repo(), () => () => DEFAULT_AGENT);
    expect(r2.branches[0]?.branch).toMatchObject({ origin: "b1", held: true });
    expect(r2.branches[0]?.prepare).toBeUndefined();
    expect(runner.branches).toHaveLength(1);
  });
});

const FAN_TEXT = `---
name: fan
verb: fan
blurb: b
---

## Build
tools: git-read, git-commit

build

## Lint
after: Build
tools: git-read

lint

## Docs
after: Build
tools: read

docs

## Ship
after: Lint, Docs
tools: git-push

ship
`;
const FAN = wf(FAN_TEXT);

describe("after: the ready set (FR-034)", () => {
test("two readers run together after their step, and the fan-in waits for both", async () => {
  const { runner, flows } = setup();
  const flow = flows.start(repo(), FAN, "", DEFAULT_AGENT);
  expect(flow.steps.map((s) => s.status)).toEqual(["running", "pending", "pending", "pending"]);
  runner.end("run1", "done", "built");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "running", "running", "pending"]);
  expect(flows.get(flow.id)?.current).toBe(2);
  expect(runner.specs.map((s) => s.label)).toEqual(["Build", "Lint", "Docs"]);
  runner.end("run2", "done", "linted");
  await flush();
  expect(flows.get(flow.id)?.steps[3]?.status).toBe("pending");
  runner.end("run3", "done", "documented");
  await flush();
  expect(flows.get(flow.id)?.steps[3]?.status).toBe("running");
  expect(runner.specs[3]?.task).toContain("- Lint: linted\n- Docs: documented");
  runner.end("run4", "done", "shipped");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
  expect(flows.get(flow.id)?.spent?.runs).toBe(4);
});

test("two writers ready together run one after the other, and the waiting one says why", async () => {
  const W = wf(`---\nblurb: b\n---\n\n## A\ntools: git-commit\n\na\n\n## B\nafter: A\ntools: git-commit\n\nb\n\n## C\nafter: A\ntools: git-commit\n\nc\n`);
  const { runner, flows } = setup();
  const flow = flows.start(repo(), W, "", DEFAULT_AGENT);
  runner.end("run1", "done", "a");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "running", "pending"]);
  expect(flows.get(flow.id)?.steps[2]?.reason).toBe("waits for B (both change the tree)");
  runner.end("run2", "done", "b");
  await flush();
  expect(flows.get(flow.id)?.steps[2]).toMatchObject({ status: "running" });
  expect(flows.get(flow.id)?.steps[2]?.reason).toBeUndefined();
});

test("a writer runs beside readers, and more than FLOW_PARALLEL ready steps queue in heading order", async () => {
  const many = `---\nblurb: b\n---\n\n## A\ntools: read\n\na\n\n## B\nafter: A\ntools: git-commit\n\nb\n\n## C\nafter: A\ntools: read\n\nc\n\n## D\nafter: A\ntools: read\n\nd\n\n## E\nafter: A\ntools: read\n\ne\n`;
  const { runner, flows } = setup();
  const flow = flows.start(repo(), wf(many), "", DEFAULT_AGENT);
  runner.end("run1", "done", "a");
  await flush();
  expect(FLOW_PARALLEL).toBe(3);
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "running", "running", "running", "pending"]);
  runner.end("run2", "done", "b");
  await flush();
  expect(flows.get(flow.id)?.steps[4]?.status).toBe("running");
});

test("a sibling that fails lets the other finish, then the flow fails with the first reason and shows both", async () => {
  const { runner, flows } = setup();
  const flow = flows.start(repo(), FAN, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  runner.end("run2", "failed", "", "lint blew up");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("working");
  expect(flows.get(flow.id)?.steps[1]).toMatchObject({ status: "failed", reason: "lint blew up" });
  runner.end("run3", "done", "documented");
  await flush();
  const f = flows.get(flow.id);
  expect([f?.status, f?.error]).toEqual(["failed", "lint blew up"]);
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "failed", "passed", "skipped"]);
  expect(runner.specs).toHaveLength(3);
});

test("a sibling that parks waits for the other, then the flow parks; continue goes on", async () => {
  const ASKS = wf(FAN_TEXT.replace("## Lint\nafter: Build\ntools: git-read\n", "## Lint\nafter: Build\ntools: git-read\ngate: ask\n"));
  const { runner, flows } = setup();
  const flow = flows.start(repo(), ASKS, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  runner.end("run2", "done", "linted");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("working");
  expect(flows.get(flow.id)?.steps[1]).toMatchObject({ status: "gated", reason: "this step asks before the next one starts" });
  runner.end("run3", "done", "documented");
  await flush();
  expect([flows.get(flow.id)?.status, flows.get(flow.id)?.current]).toEqual(["gated", 1]);
  flows.resume(flow.id, "continue");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "running"]);
});

test("a stop with two runs live stops both and ends once the second has ended", async () => {
  const { runner, flows } = setup();
  runner.stop = (id) => {
    runner.stopped.push(id);
    const run = runner.runs.get(id);
    if (!run) throw new Error(id);
    return run;
  };
  const flow = flows.start(repo(), FAN, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  flows.stop(flow.id);
  expect(runner.stopped).toEqual(["run2", "run3"]);
  runner.end("run2", "stopped");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("working");
  runner.end("run3", "stopped");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("stopped");
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "failed", "failed", "skipped"]);
});

test("a rewind leaves a running sibling alone", async () => {
  const R = wf(`---\nblurb: b\n---\n\n## Build\ntools: git-commit\n\nbuild\n\n## Docs\nafter: Build\ntools: read\n\ndocs\n\n## Test\nafter: Build\ncheck: bun test\nretries: 1\nback: Build\n`);
  let calls = 0;
  const { runner, flows } = setup({ check: () => (++calls < 2 ? { exit: 1, output: "fail" } : { exit: 0, output: "ok" }) });
  const flow = flows.start(repo(), R, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  const f = flows.get(flow.id);
  expect(f?.rewinds?.[0]).toMatchObject({ from: "Test", to: "Build" });
  expect(f?.steps[1]).toMatchObject({ status: "running", runId: "run2" });
  expect(f?.steps[0]).toMatchObject({ status: "running", runId: "run3" });
  expect(runner.dismissed).toEqual(["run1"]);
  runner.end("run2", "done", "documented");
  await flush();
  runner.end("run3", "done", "built again");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
});

test("the budget is checked before each start of a fan-out", async () => {
  const B = wf(`---\nblurb: b\nbudget: 2 runs, 9h\n---\n\n## A\ntools: read\n\na\n\n## B\nafter: A\ntools: read\n\nb\n\n## C\nafter: A\ntools: read\n\nc\n`);
  const { runner, flows } = setup();
  const flow = flows.start(repo(), B, "", DEFAULT_AGENT);
  runner.end("run1", "done", "a");
  await flush();
  let f = flows.get(flow.id);
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "running", "gated"]);
  expect([f?.status, f?.parkedFor, f?.steps[2]?.reason]).toEqual(["working", "budget", "budget spent: 2 runs"]);
  runner.end("run2", "done", "b");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("gated");
  flows.resume(flow.id, "continue");
  await flush();
  f = flows.get(flow.id);
  expect([f?.parkedFor, f?.steps[2]?.status]).toEqual([undefined, "running"]);
});

test("a record from before the keys is replayed as the chain it ran as", () => {
  const old: RecordedWorkflow = { ...TWO, steps: TWO.steps.map(({ after: _a, when: _w, mode: _m, ...s }) => s) };
  const a = setup();
  const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
  const rec: FlowRecord = { v: 1, flow: structuredClone(flow), repoPath: "/tmp/r", workflow: old, before: "", savedAt: 0 };
  const b = setup();
  b.flows.restore([rec], () => repo(), sameAgent);
  expect(b.flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["running", "pending"]);
  expect(b.runner.specs).toHaveLength(1);
});

test("a restart reruns every step that was running", async () => {
  const a = setup();
  const flow = a.flows.start(repo(), FAN, "", DEFAULT_AGENT);
  a.runner.end("run1", "done", "built");
  await flush();
  const b = setup();
  b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
  expect(b.runner.specs.map((s) => s.label)).toEqual(["Lint", "Docs"]);
  expect(b.runner.specs.every((s) => s.task.startsWith(RESTART_NOTE))).toBe(true);
});

});

describe("graph drain safety (FR-034)", () => {
  test("a failure takes precedence over a sibling park", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), wf(FAN_TEXT.replace("tools: git-read\n\nlint", "tools: git-read\ngate: ask\n\nlint")), "", DEFAULT_AGENT);
    runner.end("run1", "done"); await flush();
    runner.end("run2", "done"); await flush();
    runner.end("run3", "failed", "", "docs failed"); await flush();
    expect(flow.status).toBe("failed");
    expect(flow.error).toBe("docs failed");
    expect(runner.specs).toHaveLength(3);
  });

  test("a stop aborts every check and waits for all checks to exit", async () => {
    const exits: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    const { runner, flows } = setup({ check: (_cmd, signal) => new Promise((resolve) => {
      signals.push(signal); exits.push(() => resolve({ exit: 1, output: "aborted" }));
    }) });
    const graph = wf(FAN_TEXT.replace("tools: git-read\n\nlint", "tools: git-read\ncheck: @gates\n\nlint").replace("tools: read\n\ndocs", "tools: read\ncheck: @gates\n\ndocs"));
    const flow = flows.start(repo(), graph, "", DEFAULT_AGENT);
    runner.end("run1", "done"); await flush();
    runner.end("run2", "done"); runner.end("run3", "done"); await flush();
    flows.stop(flow.id);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    exits[0]?.(); await flush();
    expect(flow.status).toBe("working");
    exits[1]?.(); await flush();
    expect(flow.status).toBe("stopped");
  });
});

describe("when: conditions (FR-034)", () => {
const COND = wf(`---
blurb: b
---

## Review
tools: read
gate: verdict

review

## Fix
after: Review
when: verdict partial, verdict blocked
tools: git-commit

fix

## Changelog
after: Fix
when: changed
tools: git-commit

log

## Done
after: Changelog

done
`);
const doneVerdict = (): VerdictAnswers => ({ outcome: { choice: "done" }, needsYou: { probability: 0 }, offScope: { probability: 0 } });
const partialVerdict = (): VerdictAnswers => ({ outcome: { choice: "partial" }, needsYou: { probability: 0 }, offScope: { probability: 0 } });

test("a verdict of done skips Fix, a skipped step counts as unchanged, and Done still runs", async () => {
  const { runner, flows } = setup({ evaluator: async () => doneVerdict() });
  const flow = flows.start(repo(), COND, "", DEFAULT_AGENT);
  await flush();
  runner.end("run1", "done", "reviewed");
  await flush();
  const f = flows.get(flow.id);
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "skipped", "skipped", "running"]);
  expect(f?.steps[1]?.reason).toBe("none of its conditions held: verdict partial, verdict blocked");
  expect(f?.steps[2]?.reason).toBe("none of its conditions held: changed");
  expect(runner.specs[1]?.task).toContain("- Review: reviewed");
  expect(runner.specs[1]?.task).not.toContain("Fix:");
  runner.end("run2", "done", "finished");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
});

test("a verdict of partial parks as today; continue keeps it, so Fix runs, and changed is read per step", async () => {
  const prints = ["r1", "r1", "f1", "f2", "l1", "l1"];
  const { runner, flows } = setup({ evaluator: async () => partialVerdict(), fingerprint: async () => prints.shift() ?? null });
  const flow = flows.start(repo(), COND, "", DEFAULT_AGENT);
  await flush();
  runner.end("run1", "done", "reviewed");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("gated");
  flows.resume(flow.id, "continue");
  await flush();
  expect(flows.get(flow.id)?.steps[1]?.status).toBe("running");
  runner.end("run2", "done", "fixed");
  await flush();
  expect(flows.get(flow.id)?.steps[1]?.changed).toBe(true);
  expect(flows.get(flow.id)?.steps[2]?.status).toBe("running");
  runner.end("run3", "done", "logged");
  await flush();
  expect(flows.get(flow.id)?.steps[2]?.changed).toBe(false);
  expect(flows.get(flow.id)?.steps[3]?.status).toBe("running");
});

test("a tree that cannot be read counts as changed, and a check-only step as unchanged", async () => {
  const T = wf(`---\nblurb: b\n---\n\n## Work\ntools: git-commit\n\nwork\n\n## Gates\nafter: Work\ncheck: true\n\n## IfChanged\nafter: Work\nwhen: changed\n\nx\n\n## IfSame\nafter: Gates\nwhen: unchanged\n\ny\n\n## IfMoved\nafter: Gates\nwhen: changed\n\nz\n`);
  const { runner, flows } = setup({ fingerprint: async () => null });
  const flow = flows.start(repo(), T, "", DEFAULT_AGENT);
  await flush();
  runner.end("run1", "done", "worked");
  await flush();
  const f = flows.get(flow.id);
  expect(f?.steps[0]?.changed).toBeUndefined();
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "passed", "running", "running", "skipped"]);
});

test("skipped lets a step run in place of a skipped one, and the other conditions do not hold on it", async () => {
  const S = wf(`---\nblurb: b\n---\n\n## Review\ngate: verdict\n\nreview\n\n## Fix\nafter: Review\nwhen: verdict partial\ncheck: true\n\nfix\n\n## Fallback\nafter: Fix\nwhen: skipped\n\nfb\n\n## Other\nafter: Fix\nwhen: check pass\n\nother\n`);
  const { runner, flows } = setup({ evaluator: async () => doneVerdict() });
  const flow = flows.start(repo(), S, "", DEFAULT_AGENT);
  await flush();
  runner.end("run1", "done", "reviewed");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "skipped", "running", "skipped"]);
});

test("check fail with a dependant does not fail the flow: the dependant runs and the flow ends done", async () => {
  const C = wf(`---\nblurb: b\n---\n\n## Build\ntools: git-commit\ncheck: bun test\n\nbuild\n\n## Fix\nafter: Build\nwhen: check fail\ntools: git-commit\n\nfix\n\n## Recheck\nafter: Fix\ncheck: bun test\n`);
  let calls = 0;
  const { runner, flows, checks } = setup({ check: () => (++calls === 1 ? { exit: 1, output: "1 fail" } : { exit: 0, output: "ok" }) });
  const flow = flows.start(repo(), C, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  let f = flows.get(flow.id);
  expect(f?.status).toBe("working");
  expect(f?.steps[0]).toMatchObject({ status: "failed", reason: "check failed with exit 1", check: { exit: 1, output: "1 fail" } });
  expect(f?.steps[1]?.status).toBe("running");
  runner.end("run2", "done", "fixed");
  await flush();
  f = flows.get(flow.id);
  expect(checks).toEqual(["bun test", "bun test"]);
  expect(f?.status).toBe("done");
  expect(f?.steps.map((s) => s.status)).toEqual(["failed", "passed", "passed"]);
});

test("retries come first; the route is taken once they are spent", async () => {
  const C = wf(`---\nblurb: b\n---\n\n## Build\ntools: git-commit\ncheck: bun test\nretries: 1\n\nbuild\n\n## Fix\nafter: Build\nwhen: check fail\n\nfix\n`);
  const { runner, flows } = setup({ check: () => ({ exit: 1, output: "fail" }) });
  const flow = flows.start(repo(), C, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  expect(flows.get(flow.id)?.tries).toEqual({ Build: 1 });
  expect(flows.get(flow.id)?.steps[0]?.status).toBe("running");
  runner.end("run2", "done", "built again");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["failed", "running"]);
});

test("a condition over several predecessors holds when it holds on one of them", async () => {
  const M = wf(`---\nblurb: b\n---\n\n## A\ncheck: true\n\n## B\ncheck: false\n\n## C\nafter: A, B\nwhen: check fail\n\nc\n`);
  const { runner, flows } = setup({ check: (cmd) => ({ exit: cmd === "false" ? 1 : 0, output: "" }) });
  const flow = flows.start(repo(), M, "", DEFAULT_AGENT);
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "failed", "running"]);
  runner.end("run1", "done", "c");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
});

  test("conditions never reuse a skipped step's old verdict or check", () => {
    const { flows } = setup();
    const flow = flows.start(repo(), COND, "", DEFAULT_AGENT);
    const first = flow.steps[0];
    if (!first) throw new Error("missing step");
    first.status = "skipped";
    const verdict = { ...COND, steps: COND.steps.map((s, i) => i === 1 ? { ...s, when: ["verdict done"] satisfies Workflow["steps"][number]["when"] } : s) };
    expect(whenHolds(flow, verdict, 1)).toBe(false);
    const skipped = { ...COND, steps: COND.steps.map((s, i) => i === 1 ? { ...s, when: ["skipped"] satisfies Workflow["steps"][number]["when"] } : s) };
    expect(whenHolds(flow, skipped, 1)).toBe(true);
  });
});

describe("asynchronous graph preparation (FR-034)", () => {
  test("a sibling failure drains an unstarted run waiting for its fingerprint", async () => {
    let release: ((value: string) => void) | undefined;
    let calls = 0;
    const { runner, flows } = setup({ fingerprint: () => {
      calls += 1;
      if (calls === 4) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve("tree");
    } });
    const flow = flows.start(repo(), FAN, "", DEFAULT_AGENT);
    await flush();
    runner.end("run1", "done"); await flush();
    expect(runner.specs.map((s) => s.label)).toEqual(["Build", "Lint"]);
    runner.end("run2", "failed", "", "lint failed"); await flush();
    release?.("tree"); await flush();
    expect(flow.status).toBe("failed");
    expect(runner.specs.map((s) => s.label)).toEqual(["Build", "Lint"]);
  });

  test("a missing fingerprint after real work still takes the changed route", async () => {
    let reads = 0;
    const { runner, flows } = setup({ fingerprint: async () => ++reads === 1 ? "before" : null });
    const graph = wf(`---\nblurb: b\n---\n\n## Build\n\nbuild\n\n## Changed\nwhen: changed\n\nchanged\n\n## Same\nafter: Build\nwhen: unchanged\n\nsame\n`);
    const flow = flows.start(repo(), graph, "", DEFAULT_AGENT);
    await flush(); runner.end("run1", "done"); await flush();
    expect(flow.steps.map((s) => s.status)).toEqual(["passed", "running", "skipped"]);
    expect(flow.steps[0]?.changed).toBeUndefined();
  });
});
