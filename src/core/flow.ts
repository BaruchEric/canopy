/** Flows: one workflow on one repo, step by step. Every step is a normal Run
 *  through the Runner; between steps come the check and the gate. Bun-only
 *  through its hooks (the check and the evaluator), pure in its logic, so the
 *  tests drive it with a fake runner. */

import { checkWhen, type ActionSpec } from "./actions";
import { decide, verdictState } from "./verdict";
import {
  isFlowActive,
  isRunActive,
  statusFingerprint,
  type AgentSettings,
  type Fleet,
  type Flow,
  type FlowChoice,
  type Repo,
  type RepoStatus,
  type Run,
  type Workflow,
  type VerdictAnswers,
} from "./types";

export const FLEET_CONCURRENCY = 3;

/** Why a fleet passes a repo over, or null when it may run. */
export function fleetSkipReason(repo: Repo, workflow: Workflow): string | null {
  if (repo.forge) return "a forge repo has no checkout";
  if (repo.error) return "not a readable repo";
  if (repo.host) return "agent runs only work on this machine";
  const c = checkWhen(repo, workflow.when);
  return c.ok ? null : c.why;
}

const KEEP_FINISHED = 60;

/** The settings a step's run starts with, given the agent profile the step
 *  names (its `agent:` line), or undefined for the repo's own flow route. */
export type StepAgent = (profile: string | undefined) => AgentSettings;

const stepAgent = (agent: AgentSettings | StepAgent): StepAgent => (typeof agent === "function" ? agent : () => agent);

export interface CheckResult {
  exit: number;
  output: string;
}

/** What Flows needs from the Runner; the real one satisfies it. */
export interface FlowRunner {
  start(repo: Repo, action: string, spec: ActionSpec, note: string, agent: AgentSettings): Run;
  get(id: string): Run | undefined;
  activeFor(repoId: string): Run | undefined;
  stop(id: string): Run;
  dismiss(id: string): void;
}

export interface FlowHooks {
  onChange: (flow: Flow) => void;
  onGone: (id: string) => void;
  onFleet: (fleet: Fleet) => void;
  onFleetGone: (id: string) => void;
  /** runs a step's check in the repo */
  check: (repo: Repo, command: string) => Promise<CheckResult>;
  /** null when there is no gateway key: verdict gates then ask */
  evaluator: ((state: string) => Promise<VerdictAnswers>) | null;
  /** a fresh status for the repo, for the outcome; null when unreadable */
  status?: (repoId: string) => Promise<RepoStatus | null>;
}

interface LiveFlow {
  flow: Flow;
  repo: Repo;
  workflow: Workflow;
  /** each step's settings, by the profile it names */
  agent: StepAgent;
  before: string;
  /** the gate's reason a retry carries into the next prompt */
  retry?: string;
}

/** The agent's closing words: the result, else the last text step. */
export function summaryOf(run: Run): string {
  if (run.result?.text) return run.result.text;
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const s = run.steps[i];
    if (s?.kind === "text" && s.text) return s.text;
  }
  return "";
}

/** The spec for one step's run: the step's prompt behind what earlier
 *  steps reported, framed by the runner the way any job is. */
export function stepSpec(
  wf: Workflow,
  index: number,
  summaries: { name: string; summary: string }[],
  retryReason?: string,
): ActionSpec {
  const step = wf.steps[index];
  if (!step) throw new Error(`${wf.name} has no step ${index}`);
  const earlier = summaries.length
    ? `Earlier steps of this workflow, already done:\n${summaries
        .map((s) => `- ${s.name}: ${s.summary.trim() || "(no summary)"}`)
        .join("\n")}`
    : "";
  const retry = retryReason
    ? `This step is being run again. The last try was not accepted because: ${retryReason}. Address that.`
    : "";
  return {
    label: step.name,
    verb: `${wf.verb} · ${step.name}`,
    blurb: wf.blurb,
    notePlaceholder: wf.notePlaceholder,
    noteRequired: wf.noteRequired,
    allowedTools: step.tools,
    maxTurns: step.turns,
    progress: `${wf.verb}: ${step.name}`,
    // the flow judges the outcome over all its steps
    expectsChange: false,
    task: [earlier, retry, step.body].filter(Boolean).join("\n\n"),
    mode: "job",
  };
}

export class Flows {
  private live = new Map<string, LiveFlow>();
  /** run id to flow id, for onRun */
  private byRun = new Map<string, string>();
  private fleetsLive = new Map<
    string,
    { fleet: Fleet; workflow: Workflow; note: string; pending: Repo[]; agentFor: (repo: Repo, profile?: string) => AgentSettings }
  >();
  /** fleet ids whose pump() is on the call stack right now, to keep a flow that
   *  ends inside start() from re-entering and finishing the fleet early */
  private pumping = new Set<string>();
  /** fleet ids a nested pump() call asked to be pumped again once the
   *  outermost call's start loop unwinds */
  private pumpAgain = new Set<string>();

  /** whether a verdict gate can evaluate; without one it behaves like ask */
  readonly hasEvaluator: boolean;

  constructor(
    private runner: FlowRunner,
    private hooks: FlowHooks,
  ) {
    this.hasEvaluator = hooks.evaluator !== null;
  }

  list(): Flow[] {
    return [...this.live.values()].map((l) => l.flow);
  }

  get(id: string): Flow | undefined {
    return this.live.get(id)?.flow;
  }

  activeFor(repoId: string): Flow | undefined {
    for (const l of this.live.values()) {
      if (l.flow.repoId === repoId && isFlowActive(l.flow)) return l.flow;
    }
    return undefined;
  }

  /** Starts a workflow on a repo. `agent` is every step's settings, or how
   *  to pick them by the profile a step names. */
  start(repo: Repo, workflow: Workflow, note: string, agent: AgentSettings | StepAgent, fleetId?: string): Flow {
    const busyFlow = this.activeFor(repo.id);
    if (busyFlow) throw new Error(`${repo.name} already has ${busyFlow.verb} going`);
    const busyRun = this.runner.activeFor(repo.id);
    if (busyRun) throw new Error(`${repo.name} already has a ${busyRun.verb} run going`);
    if (workflow.noteRequired && !note.trim()) throw new Error("write what the agent should do first");
    const flow: Flow = {
      id: crypto.randomUUID().slice(0, 8),
      repoId: repo.id,
      workflow: workflow.name,
      verb: workflow.verb,
      ...(fleetId ? { fleetId } : {}),
      note: note.trim(),
      status: "working",
      steps: workflow.steps.map((s) => ({ name: s.name, status: "pending", ...(s.agent ? { profile: s.agent } : {}) })),
      current: 0,
      startedAt: Date.now(),
    };
    const live: LiveFlow = {
      flow,
      repo,
      workflow,
      agent: stepAgent(agent),
      before: statusFingerprint(repo.status),
    };
    this.live.set(flow.id, live);
    this.prune();
    void this.runStep(live);
    return flow;
  }

  /** The Runner's every change comes here; a step's run ending moves the flow. */
  onRun(run: Run): void {
    const id = this.byRun.get(run.id);
    const live = id ? this.live.get(id) : undefined;
    if (!live) return;
    const step = live.flow.steps[live.flow.current];
    if (!step || step.runId !== run.id) return;
    if (run.status === "working" || run.status === "waiting" || run.status === "idle") {
      const status = run.status === "waiting" ? "waiting" : "working";
      if (live.flow.status !== status) {
        live.flow.status = status;
        this.emit(live);
      }
      return;
    }
    this.byRun.delete(run.id);
    if (run.status === "failed") {
      step.status = "failed";
      step.reason = run.error ?? "the run failed";
      this.end(live, "failed", step.reason);
      return;
    }
    if (run.status === "stopped") {
      step.status = "failed";
      step.reason = "stopped";
      this.end(live, "stopped");
      return;
    }
    step.summary = summaryOf(run);
    void this.afterRun(live);
  }

  resume(id: string, choice: FlowChoice): Flow {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown flow: ${id}`);
    if (live.flow.status !== "gated") throw new Error("the flow is not waiting at a gate");
    const step = live.flow.steps[live.flow.current];
    if (!step) throw new Error("no current step");
    if (choice === "stop") {
      step.status = "failed";
      step.reason = "stopped at the gate";
      this.end(live, "stopped");
      return live.flow;
    }
    if (choice === "retry") {
      live.retry = step.reason;
      if (step.runId) {
        try {
          this.runner.dismiss(step.runId);
        } catch {
          // an active run cannot be dismissed; it is not, or we would not be gated
        }
      }
      delete step.runId;
      delete step.check;
      delete step.verdict;
      delete step.summary;
      delete step.reason;
      void this.runStep(live);
      return live.flow;
    }
    void this.pass(live);
    return live.flow;
  }

  stop(id: string): Flow {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown flow: ${id}`);
    if (!isFlowActive(live.flow)) return live.flow;
    if (live.flow.status === "gated") return this.resume(id, "stop");
    const step = live.flow.steps[live.flow.current];
    const run = step && step.runId ? this.runner.get(step.runId) : undefined;
    if (step && step.runId && run && isRunActive(run)) {
      // the run's stopped status comes back through onRun and ends the flow
      this.runner.stop(step.runId);
    } else {
      // the run already ended (or never started) while we were awaiting a
      // check or the evaluator: nothing more will come back through onRun,
      // so end the flow here instead of waiting for an event that will not arrive
      if (step) {
        step.status = "failed";
        step.reason = "stopped";
      }
      this.end(live, "stopped");
    }
    return live.flow;
  }

  dismiss(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (isFlowActive(live.flow)) throw new Error("stop the flow before dismissing it");
    for (const s of live.flow.steps) {
      if (s.runId) {
        try {
          this.runner.dismiss(s.runId);
        } catch {
          // already gone
        }
      }
    }
    this.live.delete(id);
    this.hooks.onGone(id);
  }

  stopAll(): void {
    for (const f of this.fleetsLive.values()) if (f.fleet.status === "working") this.stopFleet(f.fleet.id);
    for (const l of this.live.values()) if (isFlowActive(l.flow)) this.stop(l.flow.id);
  }

  fleets(): Fleet[] {
    return [...this.fleetsLive.values()].map((f) => f.fleet);
  }

  getFleet(id: string): Fleet | undefined {
    return this.fleetsLive.get(id)?.fleet;
  }

  /** Starts a workflow over many repos. `agentFor` gives each repo's
   *  settings for a step, by the profile the step names, if any. */
  startFleet(repos: Repo[], workflow: Workflow, note: string, agentFor: (repo: Repo, profile?: string) => AgentSettings): Fleet {
    const fleet: Fleet = {
      id: crypto.randomUUID().slice(0, 8),
      workflow: workflow.name,
      verb: workflow.verb,
      note: note.trim(),
      repos: repos.map((r) => {
        const skipped = fleetSkipReason(r, workflow);
        return skipped ? { repoId: r.id, skipped } : { repoId: r.id };
      }),
      status: "working",
      startedAt: Date.now(),
    };
    const pending = repos.filter((r) => !fleetSkipReason(r, workflow));
    this.fleetsLive.set(fleet.id, { fleet, workflow, note, pending, agentFor });
    this.pump(fleet.id);
    return fleet;
  }

  stopFleet(id: string): Fleet {
    const lf = this.fleetsLive.get(id);
    if (!lf) throw new Error(`unknown fleet: ${id}`);
    if (lf.fleet.status !== "working") return lf.fleet;
    for (const r of lf.pending) {
      const entry = lf.fleet.repos.find((x) => x.repoId === r.id);
      if (entry) entry.skipped = "stopped before it started";
    }
    lf.pending = [];
    // Marked stopped before the flows end, or the last flow's end would
    // pump the fleet and finish it as done.
    lf.fleet.status = "stopped";
    lf.fleet.endedAt = Date.now();
    for (const l of this.live.values()) {
      if (l.flow.fleetId === id && isFlowActive(l.flow)) this.stop(l.flow.id);
    }
    this.hooks.onFleet(lf.fleet);
    return lf.fleet;
  }

  dismissFleet(id: string): void {
    const lf = this.fleetsLive.get(id);
    if (!lf) return;
    if (lf.fleet.status === "working") throw new Error("stop the fleet before dismissing it");
    for (const r of lf.fleet.repos) {
      if (r.flowId && this.live.has(r.flowId)) {
        try {
          this.dismiss(r.flowId);
        } catch {
          // a flow still active stays; it can be dismissed on its own later
        }
      }
    }
    this.fleetsLive.delete(id);
    this.hooks.onFleetGone(id);
  }

  private running(fleetId: string): number {
    let n = 0;
    for (const l of this.live.values()) if (l.flow.fleetId === fleetId && isFlowActive(l.flow)) n += 1;
    return n;
  }

  /** Starts pending repos up to the cap; ends the fleet when nothing is left.
   *  `this.start(...)` can run a whole flow synchronously (a run that ends
   *  inside start() feeds straight through onRun, pass, end, onFlowEnd, and
   *  back into pump()) before the line below gets to record its flow id. A
   *  nested call like that only marks the fleet in pumpAgain and returns;
   *  the outermost call keeps starting repos until a pass leaves nothing
   *  marked, and only it emits or finishes the fleet, exactly once. */
  private pump(fleetId: string): void {
    if (this.pumping.has(fleetId)) {
      this.pumpAgain.add(fleetId);
      return;
    }
    this.pumping.add(fleetId);
    try {
      do {
        this.pumpAgain.delete(fleetId);
        this.startPending(fleetId);
      } while (this.pumpAgain.has(fleetId));
    } finally {
      this.pumping.delete(fleetId);
    }
    const lf = this.fleetsLive.get(fleetId);
    if (!lf || lf.fleet.status !== "working") return;
    if (!lf.pending.length && this.running(fleetId) === 0) {
      this.finishFleet(lf, "done");
      return;
    }
    this.hooks.onFleet(lf.fleet);
  }

  private startPending(fleetId: string): void {
    const lf = this.fleetsLive.get(fleetId);
    if (!lf || lf.fleet.status !== "working") return;
    while (lf.pending.length && this.running(fleetId) < FLEET_CONCURRENCY) {
      const repo = lf.pending.shift();
      if (!repo) break;
      const entry = lf.fleet.repos.find((x) => x.repoId === repo.id);
      try {
        const flow = this.start(repo, lf.workflow, lf.note, (profile) => lf.agentFor(repo, profile), fleetId);
        if (entry) entry.flowId = flow.id;
      } catch (err) {
        if (entry) entry.skipped = String(err instanceof Error ? err.message : err);
      }
    }
  }

  private finishFleet(lf: { fleet: Fleet }, status: "done" | "stopped"): void {
    if (lf.fleet.status !== "working") return;
    lf.fleet.status = status;
    lf.fleet.endedAt = Date.now();
    this.hooks.onFleet(lf.fleet);
  }

  private emit(live: LiveFlow): void {
    this.hooks.onChange(live.flow);
  }

  private prune(): void {
    const finished = [...this.live.values()]
      .filter((l) => !isFlowActive(l.flow))
      .sort((a, b) => (a.flow.endedAt ?? 0) - (b.flow.endedAt ?? 0));
    while (finished.length > KEEP_FINISHED) {
      const oldest = finished.shift();
      if (!oldest) break;
      this.live.delete(oldest.flow.id);
      this.hooks.onGone(oldest.flow.id);
    }
  }

  private summaries(live: LiveFlow): { name: string; summary: string }[] {
    return live.flow.steps
      .slice(0, live.flow.current)
      .filter((s) => s.status === "passed")
      .map((s) => ({ name: s.name, summary: s.summary ?? "" }));
  }

  private async runStep(live: LiveFlow): Promise<void> {
    const { flow, workflow } = live;
    const def = workflow.steps[flow.current];
    const step = flow.steps[flow.current];
    if (!def || !step) return;
    if (!def.body) {
      // check-only: no agent, straight to the command
      flow.status = "working";
      await this.check(live);
      return;
    }
    const spec = stepSpec(workflow, flow.current, this.summaries(live), live.retry);
    delete live.retry;
    let run: Run;
    try {
      run = this.runner.start(live.repo, workflow.name, spec, flow.note, live.agent(def.agent));
    } catch (err) {
      step.status = "failed";
      step.reason = String(err instanceof Error ? err.message : err);
      this.end(live, "failed", step.reason);
      return;
    }
    step.status = "running";
    step.runId = run.id;
    flow.status = "working";
    this.byRun.set(run.id, flow.id);
    this.emit(live);
    // the runner may call its onChange hook synchronously inside start(), before
    // step.runId and byRun were set up to receive it; re-read the run now that
    // both are in place, and if it already ended, feed that end through onRun
    // ourselves so it is not lost.
    const latest = this.runner.get(run.id);
    if (latest && !isRunActive(latest)) this.onRun(latest);
  }

  private async afterRun(live: LiveFlow): Promise<void> {
    const def = live.workflow.steps[live.flow.current];
    if (def?.check) await this.check(live);
    else await this.gate(live);
  }

  /** Runs the step's command; a non-zero exit ends the flow. */
  private async check(live: LiveFlow): Promise<void> {
    const def = live.workflow.steps[live.flow.current];
    const step = live.flow.steps[live.flow.current];
    if (!def?.check || !step) return;
    step.status = "checking";
    this.emit(live);
    const r = await this.hooks.check(live.repo, def.check);
    if (!isFlowActive(live.flow)) return;
    step.check = { command: def.check, exit: r.exit, output: r.output };
    if (r.exit !== 0) {
      step.status = "failed";
      step.reason = `check failed with exit ${r.exit}`;
      this.end(live, "failed", step.reason);
      return;
    }
    await this.gate(live);
  }

  private async gate(live: LiveFlow): Promise<void> {
    const def = live.workflow.steps[live.flow.current];
    const step = live.flow.steps[live.flow.current];
    if (!def || !step) return;
    switch (def.gate) {
      case "continue":
        await this.pass(live);
        return;
      case "ask":
        this.park(live, "this step asks before the next one starts");
        return;
      case "verdict": {
        if (!this.hooks.evaluator) {
          this.park(live, "no gateway key, so the verdict is yours");
          return;
        }
        let changed: boolean | null = null;
        if (this.hooks.status) {
          try {
            const st = await this.hooks.status(live.flow.repoId);
            changed = st ? statusFingerprint(st) !== live.before : null;
          } catch {
            changed = null;
          }
        }
        try {
          const answers = await this.hooks.evaluator(
            verdictState({ summary: step.summary ?? "", check: step.check?.output ?? null, changed }),
          );
          if (!isFlowActive(live.flow)) return;
          const v = decide(answers);
          step.verdict = v;
          if (v.go) await this.pass(live);
          else this.park(live, v.reason ?? "the verdict said no");
        } catch (err) {
          if (!isFlowActive(live.flow)) return;
          this.park(live, `verdict unavailable: ${String(err instanceof Error ? err.message : err)}`);
        }
        return;
      }
    }
  }

  private park(live: LiveFlow, reason: string): void {
    const step = live.flow.steps[live.flow.current];
    if (!step) return;
    step.status = "gated";
    step.reason = reason;
    live.flow.status = "gated";
    this.emit(live);
  }

  private async pass(live: LiveFlow): Promise<void> {
    const step = live.flow.steps[live.flow.current];
    if (!step) return;
    step.status = "passed";
    delete step.reason;
    if (live.flow.current + 1 >= live.flow.steps.length) {
      this.end(live, "done");
      return;
    }
    live.flow.current += 1;
    this.emit(live);
    await this.runStep(live);
  }

  private end(live: LiveFlow, status: "done" | "failed" | "stopped", error?: string): void {
    if (!isFlowActive(live.flow)) return;
    live.flow.status = status;
    live.flow.endedAt = Date.now();
    if (error) live.flow.error = error;
    for (const s of live.flow.steps) if (s.status === "pending") s.status = "skipped";
    this.emit(live);
    this.onFlowEnd(live.flow);
    void this.settle(live);
  }

  protected onFlowEnd(flow: Flow): void {
    if (flow.fleetId) this.pump(flow.fleetId);
  }

  private async settle(live: LiveFlow): Promise<void> {
    if (!live.workflow.expectsChange || !this.hooks.status) return;
    let after: string | null = null;
    try {
      const st = await this.hooks.status(live.flow.repoId);
      after = st ? statusFingerprint(st) : null;
    } catch {
      after = null;
    }
    if (after === null || isFlowActive(live.flow)) return;
    live.flow.outcome = after === live.before ? "unchanged" : "changed";
    this.emit(live);
  }
}
