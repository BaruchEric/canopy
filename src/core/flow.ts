/** Flows: one workflow on one repo, step by step. Every step is a normal Run
 *  through the Runner; between steps come the check and the gate. Bun-only
 *  through its hooks (the check and the evaluator), pure in its logic, so the
 *  tests drive it with a fake runner. */

import { checkWhen, type ActionSpec } from "./actions";
import { isSeedId } from "./sprout";
import { STAGE_AWAY } from "./stagewire";
import { decide, decideJudge, judgeState, verdictState } from "./verdict";
import {
  DEFAULT_AGENT,
  isFlowActive,
  isRunActive,
  statusFingerprint,
  type AgentSettings,
  type EvidenceFile,
  type Fleet,
  type Flow,
  type FlowChoice,
  type FlowStep,
  type JudgeAnswers,
  type Repo,
  type RepoStatus,
  type Run,
  type Workflow,
  type VerdictAnswers,
  type FlowBudget,
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

/**
 * Which limit a flow has reached, as the park reason, or null. Budgets are
 * checked before an agent run starts, so one long run can pass the runs or
 * hours budget; the flow parks before the next run, never in the middle of one.
 */
export function overBudget(budget: FlowBudget | null, spent: { runs: number; workMs: number }): string | null {
  if (!budget) return null;
  if (spent.runs >= budget.runs) return `budget spent: ${budget.runs} ${budget.runs === 1 ? "run" : "runs"}`;
  if (spent.workMs >= budget.hours * 3_600_000) return `budget spent: ${budget.hours}h`;
  return null;
}

const spentOf = (flow: Flow): { runs: number; workMs: number } => (flow.spent ??= { runs: 0, workMs: 0 });

export interface CheckResult {
  exit: number;
  output: string;
  /** the check never ran: the stage runner was not answering */
  away?: boolean;
}

/** What a flow leaves on disk: the flow, the workflow it started with (so a
 *  file edited since does not change a flow in progress), the status
 *  fingerprint its outcome is judged against, and the repo's absolute path
 *  (or ssh locator), which names it on any root where a repo id would not. */
export interface FlowRecord {
  v: 1;
  flow: Flow;
  repoPath: string;
  workflow: Workflow;
  before: string;
  savedAt: number;
}

export const RESTART_NOTE = "canopy restarted during this step; read the repo's state and finish the step";

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
  /** null or absent when there is no gateway key: judge gates then ask */
  judge?: ((state: string) => Promise<JudgeAnswers>) | null;
  /** reads a judge step's evidence files out of the repo */
  evidence?: (repo: Repo, paths: string[]) => Promise<EvidenceFile[]>;
  /** a fresh status for the repo, for the outcome; null when unreadable */
  status?: (repoId: string) => Promise<RepoStatus | null>;
  /** the clock, for tests; Date.now otherwise */
  now?: () => number;
  /** keeps a flow on disk; called on every change with the live objects, so
   *  it must serialize at once */
  save?: (rec: FlowRecord) => void;
  /** drops a flow's record */
  forget?: (id: string) => void;
}

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

/** The end of a check's output, which is where a failure says what failed. */
const tailOf = (s: string, n = 2000): string => (s.length > n ? s.slice(-n) : s);

interface LiveFlow {
  flow: Flow;
  repo: Repo;
  workflow: Workflow;
  /** each step's settings, by the profile it names */
  agent: StepAgent;
  before: string;
  /** when the working clock last started; absent while it is stopped */
  since?: number;
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
  restarted = false,
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
    task: [restarted ? RESTART_NOTE : "", earlier, retry, step.body].filter(Boolean).join("\n\n"),
    ...(wf.unattended ? { unattended: wf.unattended } : {}),
    flowStep: { workflow: wf.name, step: step.name },
    mode: "job",
  };
}

export class Flows {
  private saving = true;
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
      ...(workflow.budget ? { budget: workflow.budget } : {}),
      spent: { runs: 0, workMs: 0 },
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
      this.clock(live, status === "working");
      if (live.flow.status !== status) {
        live.flow.status = status;
        this.emit(live);
      }
      return;
    }
    this.byRun.delete(run.id);
    if (run.status === "failed" && isSeedId(live.repo.id) && run.away === true) {
      // the stage runner went away under the run, as a hello confirmed: the
      // step waits for it. By the flag, never the error's words, which carry
      // the stage's own stderr and so whatever it chose to print.
      live.flow.parkedFor = "stage";
      this.park(live, run.awayWhy ?? STAGE_AWAY);
      return;
    }
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
    if (live.flow.parkedFor === "budget" && choice !== "stop") {
      // continue and retry both mean: allow one more step, and run the one that was waiting
      delete live.flow.parkedFor;
      live.flow.grace = (live.flow.grace ?? 0) + 1;
      this.resetStep(step);
      void this.runStep(live);
      return live.flow;
    }
    if (live.flow.parkedFor === "stage" && choice !== "stop") {
      // continue and retry both mean: try again, the stage runner being back
      // or not (if not, it parks again). A check that found it away runs
      // alone, so the agent's work and its summary stand.
      delete live.flow.parkedFor;
      if (live.flow.stageCheck) {
        delete live.flow.stageCheck;
        delete step.check;
        delete step.reason;
        this.clock(live, true);
        live.flow.status = "working";
        void this.check(live);
        return live.flow;
      }
      this.resetStep(step);
      void this.runStep(live);
      return live.flow;
    }
    delete live.flow.parkedFor;
    delete live.flow.stageCheck;
    if (choice === "stop") {
      step.status = "failed";
      step.reason = "stopped at the gate";
      this.end(live, "stopped");
      return live.flow;
    }
    if (choice === "retry") {
      if (step.reason) live.flow.retryReason = step.reason;
      this.resetStep(step);
      void this.runStep(live);
      return live.flow;
    }
    void this.pass(live);
    return live.flow;
  }

  /** Every flow parked for the stage runner, tried again now that a hello
   *  found it: a step parked at its start or by a run that lost the runner
   *  runs again, a check park reruns its check alone. A user's gate and a
   *  budget park are never touched. Returns how many it resumed. */
  resumeStageParks(): number {
    let n = 0;
    for (const l of this.live.values()) {
      if (l.flow.status !== "gated" || l.flow.parkedFor !== "stage") continue;
      try {
        this.resume(l.flow.id, "continue");
        n += 1;
      } catch {
        // gone or moved on between the read and the resume
      }
    }
    return n;
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
    this.hooks.forget?.(id);
    this.hooks.onGone(id);
  }

  /** Takes back the flows a stopped server left on disk. A gated or finished
   *  flow comes back as it was, without a change event; one caught mid-step
   *  reruns that step, its run having gone with the old process. Fleets are
   *  not kept, so a fleet id is dropped. `resolve` finds a repo by its path
   *  in the current scan (ids are relative to a root, a path is not), and the
   *  flow takes the id the repo has there. A record the engine cannot take
   *  back is skipped with a line naming it, so one bad file never stops the
   *  server. */
  restore(records: FlowRecord[], resolve: (path: string) => Repo | undefined, agentFor: (repo: Repo) => StepAgent): void {
    for (const rec of records) {
      const id = rec.flow.id;
      if (this.live.has(id)) continue;
      try {
        this.restoreOne(rec, resolve, agentFor);
      } catch (err) {
        this.live.delete(id);
        console.error(`flows: skipping ${id}, its record could not be taken back: ${errText(err)}`);
      }
    }
    this.prune();
  }

  private restoreOne(rec: FlowRecord, resolve: (path: string) => Repo | undefined, agentFor: (repo: Repo) => StepAgent): void {
    const flow = rec.flow;
    delete flow.fleetId;
    const repo = resolve(rec.repoPath);
    if (repo) flow.repoId = repo.id;
    const live: LiveFlow = {
      flow,
      repo: repo ?? { id: flow.repoId, name: flow.repoId, path: rec.repoPath, group: "", source: "", status: null },
      workflow: rec.workflow,
      agent: repo ? agentFor(repo) : () => DEFAULT_AGENT,
      before: rec.before,
    };
    this.live.set(flow.id, live);
    if (!isFlowActive(flow)) return;
    if (!repo) {
      const step = flow.steps[flow.current];
      if (step) {
        step.status = "failed";
        step.reason = "the repo is not in the scan any more";
      }
      this.end(live, "failed", "the repo is not in the scan any more");
      return;
    }
    if (flow.status === "gated") return;
    this.resetStep(flow.steps[flow.current]);
    flow.restarted = true;
    flow.status = "working";
    void this.runStep(live);
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
    if (this.saving) this.hooks.save?.(this.record(live));
  }

  private record(live: LiveFlow): FlowRecord {
    // a shallow copy with the live working time; the consumer serializes at once
    return {
      v: 1,
      flow: { ...live.flow, spent: this.spentNow(live) },
      repoPath: live.repo.path,
      workflow: live.workflow,
      before: live.before,
      savedAt: this.now(),
    };
  }

  /** Stops saving: the server calls it before stopping every flow on its way
   *  down, so the records keep what was running for the next server. */
  detach(): void {
    this.saving = false;
  }

  private prune(): void {
    const finished = [...this.live.values()]
      .filter((l) => !isFlowActive(l.flow))
      .sort((a, b) => (a.flow.endedAt ?? 0) - (b.flow.endedAt ?? 0));
    while (finished.length > KEEP_FINISHED) {
      const oldest = finished.shift();
      if (!oldest) break;
      this.live.delete(oldest.flow.id);
      this.hooks.forget?.(oldest.flow.id);
      this.hooks.onGone(oldest.flow.id);
    }
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /** Working time runs while a step's run works or its check and gate run,
   *  and stops while the run waits on a prompt or the flow is parked. */
  private clock(live: LiveFlow, on: boolean): void {
    const now = this.now();
    if (on) {
      live.since ??= now;
      return;
    }
    if (live.since === undefined) return;
    spentOf(live.flow).workMs += now - live.since;
    delete live.since;
  }

  private spentNow(live: LiveFlow): { runs: number; workMs: number } {
    const s = spentOf(live.flow);
    return { runs: s.runs, workMs: s.workMs + (live.since === undefined ? 0 : this.now() - live.since) };
  }

  /** Back to pending, its run dismissed and everything it said dropped. */
  private resetStep(step: FlowStep | undefined): void {
    if (!step) return;
    if (step.runId) {
      try {
        this.runner.dismiss(step.runId);
      } catch {
        // still active or already gone
      }
    }
    delete step.runId;
    delete step.check;
    delete step.verdict;
    delete step.judgment;
    delete step.summary;
    delete step.reason;
    step.status = "pending";
  }

  /** A check or gate said no: back to the step's `back` while it has retries
   *  left, else whatever it would have done without retries. */
  private refuse(live: LiveFlow, reason: string, otherwise: () => void): void {
    if (!this.rewind(live, reason)) otherwise();
  }

  private rewind(live: LiveFlow, reason: string): boolean {
    const { flow, workflow } = live;
    const def = workflow.steps[flow.current];
    if (!def || def.retries <= 0) return false;
    const tries = (flow.tries ??= {});
    const used = tries[def.name] ?? 0;
    if (used >= def.retries) return false;
    tries[def.name] = used + 1;
    const found = workflow.steps.findIndex((s) => s.name === def.back);
    const to = found === -1 || found > flow.current ? flow.current : found;
    for (let i = to; i <= flow.current; i++) this.resetStep(flow.steps[i]);
    const toName = workflow.steps[to]?.name ?? def.name;
    (flow.rewinds ??= []).push({ from: def.name, to: toName, reason, at: this.now() });
    flow.retryReason = to === flow.current ? reason : `the ${def.name} step did not accept the work: ${reason}`;
    flow.current = to;
    void this.runStep(live);
    return true;
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
    if (def.body) {
      const over = overBudget(workflow.budget ?? null, this.spentNow(live));
      if (over) {
        if ((flow.grace ?? 0) > 0) {
          flow.grace = (flow.grace ?? 0) - 1;
        } else {
          flow.parkedFor = "budget";
          this.park(live, over);
          return;
        }
      }
    }
    this.clock(live, true);
    const restarted = flow.restarted === true;
    if (!def.body) {
      delete flow.restarted;
      // check-only: no agent, straight to the command
      flow.status = "working";
      await this.check(live);
      return;
    }
    const spec = stepSpec(workflow, flow.current, this.summaries(live), flow.retryReason, restarted);
    let run: Run;
    try {
      run = this.runner.start(live.repo, workflow.name, spec, flow.note, live.agent(def.agent));
    } catch (err) {
      // The stage runner is away: the step waits for it, and keeps the
      // restart note for when it runs. By name, not class, as a thrown
      // error is matched across modules.
      if (err instanceof Error && err.name === "StageAwayError") {
        flow.parkedFor = "stage";
        this.park(live, err.message);
        return;
      }
      step.status = "failed";
      step.reason = String(err instanceof Error ? err.message : err);
      this.end(live, "failed", step.reason);
      return;
    }
    delete flow.restarted;
    step.status = "running";
    step.runId = run.id;
    spentOf(flow).runs += 1;
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
    if (r.away && isSeedId(live.repo.id)) {
      // the check never ran: it waits for the stage runner, and no retry is spent
      live.flow.parkedFor = "stage";
      live.flow.stageCheck = true;
      this.park(live, r.output || STAGE_AWAY);
      return;
    }
    step.check = { command: def.check, exit: r.exit, output: r.output };
    if (r.exit !== 0) {
      const reason = `check failed with exit ${r.exit}`;
      this.refuse(live, `${reason}:\n${tailOf(r.output)}`, () => {
        // out of retries parks, so the sheet can show the output; no retries fails as it always did
        if (def.retries > 0) this.park(live, reason);
        else {
          step.status = "failed";
          step.reason = reason;
          this.end(live, "failed", reason);
        }
      });
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
          else {
            const reason = v.reason ?? "the verdict said no";
            this.refuse(live, reason, () => this.park(live, reason));
          }
        } catch (err) {
          if (!isFlowActive(live.flow)) return;
          this.park(live, `verdict unavailable: ${String(err instanceof Error ? err.message : err)}`);
        }
        return;
      }
      case "judge": {
        const judge = this.hooks.judge;
        if (!judge) {
          this.park(live, "no gateway key, so the judgment is yours");
          return;
        }
        let files: EvidenceFile[] = [];
        if (def.evidence.length > 0 && this.hooks.evidence) {
          try {
            files = await this.hooks.evidence(live.repo, def.evidence);
          } catch {
            files = def.evidence.map((path) => ({ path, text: null }));
          }
        } else {
          files = def.evidence.map((path) => ({ path, text: null }));
        }
        if (!isFlowActive(live.flow)) return;
        try {
          const answers = await judge(
            judgeState({ task: def.body, summary: step.summary ?? "", check: step.check?.output ?? null, files }),
          );
          if (!isFlowActive(live.flow)) return;
          const j = decideJudge(answers);
          step.judgment = j;
          if (j.go) await this.pass(live);
          else if (j.rejected) this.park(live, j.reason ?? "the judge turned the work down");
          else {
            const reason = j.reason ?? "the judge said no";
            this.refuse(live, reason, () => this.park(live, reason));
          }
        } catch (err) {
          if (!isFlowActive(live.flow)) return;
          this.park(live, `judgment unavailable: ${errText(err)}`);
        }
        return;
      }
    }
  }

  private park(live: LiveFlow, reason: string): void {
    const step = live.flow.steps[live.flow.current];
    if (!step) return;
    this.clock(live, false);
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
    delete live.flow.retryReason;
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
    this.clock(live, false);
    live.flow.status = status;
    delete live.flow.retryReason;
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
    // dismissed or pruned while the read was out: saving it would bring it back
    if (this.live.get(live.flow.id) !== live) return;
    if (after === null || isFlowActive(live.flow)) return;
    live.flow.outcome = after === live.before ? "unchanged" : "changed";
    this.emit(live);
  }
}
