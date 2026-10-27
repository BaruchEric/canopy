/** Flows: one workflow on one repo, as a graph of steps. Every step is a
 *  normal Run through the Runner; ready steps start together when all but
 *  one only read; between a run and its dependants come the check and gate. */

import { chained, readOnlyStep, type RecordedWorkflow } from "./workflow";
import { busyWith, checkWhen, type ActionSpec } from "./actions";
import { limitHit, resetWord } from "./capacity";
import type { BranchStart } from "./runner";
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
  type RunBranch,
  type RunBranchState,
  type Workflow,
  type VerdictAnswers,
  type FlowBudget,
} from "./types";

export const FLEET_CONCURRENCY = 3;
/** how many steps of one flow run at once */
export const FLOW_PARALLEL = 3;

function routesCheckFailure(workflow: Workflow, name: string): boolean {
  return workflow.steps.some((s) => s.after.includes(name) && s.when.includes("check fail"));
}

/** Whether dependants may proceed, including a check failure with a route. */
export function settled(flow: Flow, workflow: Workflow, i: number): boolean {
  const step = flow.steps[i];
  return step?.status === "passed" || step?.status === "skipped" ||
    step?.status === "failed" && step.check !== undefined && step.check.exit !== 0 && routesCheckFailure(workflow, step.name);
}

/** Whether any condition holds on any predecessor. Unreadable work counts as changed. */
export function whenHolds(flow: Flow, workflow: Workflow, i: number): boolean {
  const def = workflow.steps[i];
  if (!def) return false;
  return def.when.some((condition) => condition === "always" || def.after.some((name) => {
    const step = flow.steps.find((s) => s.name === name);
    if (!step) return false;
    if (condition === "skipped") return step.status === "skipped";
    if (condition === "unchanged") return step.changed === false || !step.runId;
    if (step.status === "skipped") return false;
    switch (condition) {
      case "verdict done": return step.verdict?.answers.outcome.choice === "done";
      case "verdict partial": return step.verdict?.answers.outcome.choice === "partial";
      case "verdict blocked": return step.verdict?.answers.outcome.choice === "blocked";
      case "judge meets": return step.judgment?.answers.fit.choice === "meets";
      case "judge partly": return step.judgment?.answers.fit.choice === "partly";
      case "judge misses": return step.judgment?.answers.fit.choice === "misses";
      case "check pass": return step.check?.exit === 0;
      case "check fail": return step.check !== undefined && step.check.exit !== 0;
      case "changed": return step.changed === true || !!step.runId && step.changed === undefined;
    }
  }));
}

/** Pending steps whose predecessors have all settled, in heading order. */
export function ready(flow: Flow, workflow: Workflow): number[] {
  return workflow.steps.flatMap((def, i) =>
    flow.steps[i]?.status === "pending" && def.after.every((name) => {
      const predecessor = workflow.steps.findIndex((s) => s.name === name);
      return predecessor >= 0 && settled(flow, workflow, predecessor);
    }) ? [i] : []);
}

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
export type StepAgent = (profile: string | undefined, workflow?: string, role?: "flow" | "job") => AgentSettings;

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

type ParkCause =
  | { kind: "gate" }
  | { kind: "budget" }
  | { kind: "capacity" }
  | { kind: "stage"; check: boolean };

type PendingEnd = { end: "failed" | "stopped"; error?: string };

/** Restore is the boundary for the optional metadata older disk readers do not validate. */
function restoredEnd(value: unknown): PendingEnd | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || !("end" in value) ||
    value.end !== "failed" && value.end !== "stopped" ||
    "error" in value && value.error !== undefined && typeof value.error !== "string") throw new Error("invalid pending flow end");
  return { end: value.end, ...("error" in value && typeof value.error === "string" ? { error: value.error } : {}) };
}

function restoredParks(value: unknown, count: number): Map<number, ParkCause> {
  const parks = new Map<number, ParkCause>();
  if (value === undefined) return parks;
  if (!Array.isArray(value)) throw new Error("invalid flow parks");
  for (const item of value) {
    const entry: unknown = item;
    if (typeof entry !== "object" || entry === null || !("step" in entry) || !("cause" in entry) ||
      typeof entry.step !== "number" || !Number.isInteger(entry.step) || entry.step < 0 || entry.step >= count ||
      typeof entry.cause !== "object" || entry.cause === null || !("kind" in entry.cause)) throw new Error("invalid flow park");
    const cause = entry.cause;
    if (cause.kind === "stage" && "check" in cause && typeof cause.check === "boolean") parks.set(entry.step, { kind: "stage", check: cause.check });
    else if (cause.kind === "gate" || cause.kind === "budget" || cause.kind === "capacity") parks.set(entry.step, { kind: cause.kind });
    else throw new Error("invalid flow park cause");
  }
  return parks;
}

/** What a flow leaves on disk: the flow, the workflow it started with (so a
 *  file edited since does not change a flow in progress), the status
 *  fingerprint its outcome is judged against, and the repo's absolute path
 *  (or ssh locator), which names it on any root where a repo id would not. */
export interface FlowRecord {
  v: 1;
  flow: Flow;
  repoPath: string;
  workflow: RecordedWorkflow;
  before: string;
  savedAt: number;
  /** Intent already requested while a sibling still ran. Dead runs do not restart it. */
  pendingEnd?: PendingEnd;
  /** Each parked step owns its own resume cause; old records use flow.current. */
  parks?: { step: number; cause: ParkCause }[];
}

export const RESTART_NOTE = "canopy restarted during this step; read the repo's state and finish the step";

/** The whole message that continues a step's Claude session after a restart:
 *  the session already holds the step's prompt and its own work so far. */
export const RESUME_NOTE =
  "canopy restarted while you were working on this step, so your last turn may have been cut short. Read the repo's state and finish the step.";

/** The whole message that continues a step's Claude session when a stopped
 *  flow on a branch is picked up again. */
export const PICKED_UP_NOTE =
  "You were stopped partway through this step, and are now picked up again on the same branch. Read the repo's state and finish the step.";

/** what the browser mints for a flow or fleet start: 32 hex digits */
export const isRequestId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

/** how long a stop waits for an aborted check to exit before the flow ends anyway */
export const STOP_GRACE = 10_000;

/** What Flows needs from the Runner; the real one satisfies it. A flow on a
 *  branch passes the branch as the runner's last argument. */
export interface FlowRunner {
  start(repo: Repo, action: string, spec: ActionSpec, note: string, agent: AgentSettings, by?: string, scope?: undefined, branch?: BranchStart): Run;
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
  /** runs a step's check in the repo; the signal aborts when the flow is
   *  stopped, and the check should then kill what it started and settle */
  check: (repo: Repo, command: string, signal: AbortSignal) => Promise<CheckResult>;
  /** tools a step gets for its check line on top of its own (`@gates`
   *  gives each gate's line); null, as for most lines, adds none and starts
   *  the run without waiting */
  checkTools?: (repo: Repo, command: string) => Promise<string[]> | null;
  /** null when there is no gateway key: verdict gates then ask */
  evaluator: ((state: string) => Promise<VerdictAnswers>) | null;
  /** null or absent when there is no gateway key: judge gates then ask */
  judge?: ((state: string) => Promise<JudgeAnswers>) | null;
  /** reads a judge step's evidence files out of the repo */
  evidence?: (repo: Repo, paths: string[]) => Promise<EvidenceFile[]>;
  /** a fresh status for the repo, for the outcome; null when unreadable */
  status?: (repoId: string) => Promise<RepoStatus | null>;
  /** Tree state before and after each agent run, in its checkout or worktree. */
  fingerprint?: (repo: Repo) => Promise<string | null>;
  /** the clock, for tests; Date.now otherwise */
  now?: () => number;
  /** `STOP_GRACE` unless a test shortens it */
  stopGraceMs?: number;
  /** keeps a flow on disk; called on every change with the live objects, so
   *  it must serialize at once */
  save?: (rec: FlowRecord) => void;
  /** drops a flow's record */
  forget?: (id: string) => void;
  /** what a flow's branch holds, read from its worktree: the verdict's
   *  "changed", and the state the branch is handed over in */
  branchState?: (branch: RunBranch) => Promise<RunBranchState>;
  /** a flow on a branch is done and its worktree read: the landing queue
   *  takes the branch, through the last step run's record. Only a done flow
   *  hands its branch over; a stopped or failed one leaves it as it is. */
  onBranchEnd?: (flow: Flow, runId: string | undefined) => void;
}

/** The branch as a flow keeps it: in this state, never held (only its steps' runs are). */
function branchOf(b: RunBranch, state: RunBranchState): RunBranch {
  const { held: _held, ...rest } = b;
  return { ...rest, state };
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
  /** the run that resumes the step's session after a restart, while it goes */
  resuming: Set<string>;
  restarting: Set<number>;
  /** aborts the step's check while one runs */
  checking: Map<number, AbortController>;
  marks: Map<number, string>;
  pending?: { park: number } | PendingEnd;
  parks: Map<number, ParkCause>;
  advancing?: boolean;
  advanceAgain?: boolean;
  /** a stop waiting for the aborted check to exit, and the grace that ends it */
  stopping?: ReturnType<typeof setTimeout>;
  /** a branch flow's setup line, run before its first step's agent; gone
   *  once that run starts, and never there after a restore */
  prepare?: BranchStart["prepare"];
  /** set by a pick-up until its step's run starts: the resumed session is
   *  told it was stopped, not cut short by a restart */
  pickedUp?: boolean;
}

/** Where a flow's checks and evidence read: the branch's worktree, else the repo. */
const workRepo = (live: LiveFlow): Repo => (live.flow.branch ? { ...live.repo, path: live.flow.branch.dir } : live.repo);

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
    flowStep: { workflow: wf.name, step: step.name, source: wf.source },
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

  /** The flow going in the repo's checkout. A flow on a branch works in its
   *  own worktree and is not counted. */
  activeFor(repoId: string): Flow | undefined {
    for (const l of this.live.values()) {
      if (l.flow.repoId === repoId && !l.flow.branch && isFlowActive(l.flow)) return l.flow;
    }
    return undefined;
  }

  /** The flow a start with this client-minted id made, while it is kept. */
  forRequest(request: string): Flow | undefined {
    for (const l of this.live.values()) if (l.flow.request === request) return l.flow;
    return undefined;
  }

  /** Starts a workflow on a repo. `agent` is every step's settings, or how
   *  to pick them by the profile a step names. A `request` the client
   *  minted makes a start sent twice (a retry after the answer was lost)
   *  find the flow the first one made. A `branch` (cut by the caller, its
   *  worktree made) runs every step there instead of the repo's checkout,
   *  so the checkout's own run or flow does not stand in the way. */
  start(
    repo: Repo,
    workflow: Workflow,
    note: string,
    agent: AgentSettings | StepAgent,
    opts: { fleetId?: string; request?: string; branch?: BranchStart } = {},
  ): Flow {
    const { fleetId, request, branch } = opts;
    if (request) {
      const again = this.forRequest(request);
      if (again) {
        if (again.repoId !== repo.id) throw new Error("that request started a flow on another repo");
        return again;
      }
    }
    if (branch && fleetId) throw new Error("a fleet's flows run in each repo's checkout, not on a branch");
    const busyFlow = branch ? undefined : this.activeFor(repo.id);
    if (busyFlow) throw new Error(`${repo.name} already has ${busyFlow.verb} going`);
    const busyRun = branch ? undefined : this.runner.activeFor(repo.id);
    if (busyRun) throw new Error(busyWith(repo.name, busyRun.verb));
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
      ...(request ? { request } : {}),
      ...(branch ? { branch: branchOf(branch.branch, "working") } : {}),
    };
    const live: LiveFlow = {
      flow,
      repo,
      workflow,
      agent: stepAgent(agent),
      before: statusFingerprint(repo.status),
      checking: new Map(), marks: new Map(), resuming: new Set(), restarting: new Set(),
      parks: new Map(),
      ...(branch?.prepare ? { prepare: branch.prepare } : {}),
    };
    this.live.set(flow.id, live);
    this.prune();
    this.advance(live);
    return flow;
  }

  /** The Runner's every change comes here; a step's run ending moves the flow. */
  onRun(run: Run): void {
    const id = this.byRun.get(run.id);
    const live = id ? this.live.get(id) : undefined;
    if (!live) return;
    const i = live.flow.steps.findIndex((s) => s.runId === run.id && s.status === "running");
    const step = live.flow.steps[i];
    if (!step || !isFlowActive(live.flow)) return;
    if (run.session && (step.session !== run.session || step.harness !== run.harness)) {
      // saved at once: a restart in the middle of this run resumes it
      step.session = run.session;
      step.harness = run.harness;
      this.emit(live);
    }
    if (run.status === "working" || run.status === "waiting" || run.status === "idle") {
      this.activity(live);
      this.emit(live);
      return;
    }
    this.byRun.delete(run.id);
    if (run.status === "failed" && isSeedId(live.repo.id) && run.away === true) {
      // the stage runner went away under the run, as a hello confirmed: the
      // step waits for it. By the flag, never the error's words, which carry
      // the stage's own stderr and so whatever it chose to print.
      this.park(live, i, run.awayWhy ?? STAGE_AWAY, "gated", { kind: "stage", check: false });
      return;
    }
    const resumed = live.resuming.delete(run.id);
    if (run.status === "failed" && resumed && (run.result?.turns ?? 0) === 0) {
      // The session could not be taken up (Claude Code answers one it
      // cannot find with an error and no turns): the step starts over,
      // once, with the restart note, the session forgotten.
      this.resetStep(step);
      live.flow.restarted = true;
      live.restarting.add(i);
      void this.runStep(live, i);
      return;
    }
    if (run.status === "limited") {
      const now = this.now();
      const hit = limitHit(run.error ?? "", now);
      this.park(live, i, hit ? `waiting for capacity (resets ${resetWord(hit.resetsAt, now)})` : "waiting for capacity", "gated", { kind: "capacity" });
      return;
    }
    if (run.status === "failed") {
      step.status = "failed";
      step.reason = run.error ?? "the run failed";
      this.fail(live, i, step.reason);
      return;
    }
    if (run.status === "stopped") {
      step.status = "failed";
      step.reason = "stopped";
      if (!live.pending || !("end" in live.pending)) live.pending = { end: "stopped" };
      this.advance(live);
      return;
    }
    step.summary = summaryOf(run);
    void this.afterRun(live, i);
  }

  resume(id: string, choice: FlowChoice): Flow {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown flow: ${id}`);
    if (live.flow.status !== "gated") throw new Error("the flow is not waiting at a gate");
    const i = live.flow.current;
    const step = live.flow.steps[i];
    if (!step) throw new Error("no current step");
    live.parks.delete(i);
    if (live.flow.parkedFor === "budget" && choice !== "stop") {
      // continue and retry both mean: allow one more step, and run the one that was waiting
      delete live.flow.parkedFor;
      live.flow.grace = (live.flow.grace ?? 0) + 1;
      // a step a restart cut short keeps its session for the rerun
      this.resetStep(step, live.flow.restarted === true);
      this.resumeReady(live, i);
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
        void this.check(live, i);
        return live.flow;
      }
      // a step a restart cut short keeps its session for the rerun
      this.resetStep(step, live.flow.restarted === true);
      this.resumeReady(live, i);
      return live.flow;
    }
    if (live.flow.parkedFor === "capacity" && choice !== "stop") {
      delete live.flow.parkedFor;
      this.resetStep(step);
      this.resumeReady(live, i);
      return live.flow;
    }
    delete live.flow.parkedFor;
    delete live.flow.stageCheck;
    if (choice === "stop") {
      step.status = "failed";
      step.reason = "stopped at the gate";
      this.finish(live, "stopped");
      return live.flow;
    }
    if (step.status === "held") {
      void this.runStep(live, i);
      return live.flow;
    }
    if (choice === "retry") {
      if (step.reason) live.flow.retryReason = step.reason;
      this.resetStep(step);
      void this.runStep(live, i);
      return live.flow;
    }
    void this.pass(live, i);
    return live.flow;
  }

  /** Operational retries keep the go already given to a manual step. */
  private resumeReady(live: LiveFlow, i: number): void {
    if (live.workflow.steps[i]?.mode === "manual") void this.runStep(live, i);
    else this.advance(live);
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

  /** Picks a stopped flow on a branch up where it ended: the step it ended
   *  in runs again, resuming that step's Claude session when it has one, and
   *  the steps after it follow. Only a flow on a branch, whose worktree no one
   *  else works in, can be picked up. */
  pickUp(id: string): Flow {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown flow: ${id}`);
    const { flow } = live;
    if (!flow.branch) throw new Error("only a flow on a branch can be picked up");
    if (flow.status !== "stopped") throw new Error(`the flow is ${flow.status}, not stopped`);
    for (const s of flow.steps) if (s.status === "skipped") s.status = "pending";
    for (const [i, s] of flow.steps.entries()) {
      if (s.status === "failed" && (s.reason === "stopped" || s.reason === "stopped at the gate")) {
        this.resetStep(s, true); live.restarting.add(i);
      }
    }
    flow.restarted = true;
    live.pickedUp = true;
    flow.status = "working";
    flow.branch = branchOf(flow.branch, "working");
    delete flow.endedAt;
    delete flow.error;
    delete flow.outcome;
    this.emit(live);
    this.advance(live);
    return flow;
  }

  stop(id: string): Flow {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown flow: ${id}`);
    if (!isFlowActive(live.flow)) return live.flow;
    if (live.flow.status === "gated") return this.resume(id, "stop");
    if (live.pending && "end" in live.pending && live.pending.end === "stopped") return live.flow;
    live.pending = { end: "stopped" };
    const indices = this.liveSteps(live);
    if (live.checking.size) {
      live.stopping = setTimeout(() => {
        for (const i of live.checking.keys()) {
          const step = live.flow.steps[i];
          if (step) { step.status = "failed"; step.reason = "stopped"; }
        }
        live.checking.clear();
        this.advance(live);
      }, this.hooks.stopGraceMs ?? STOP_GRACE);
    }
    for (const i of indices) {
      const step = live.flow.steps[i];
      const run = step?.runId ? this.runner.get(step.runId) : undefined;
      if (run && isRunActive(run)) this.runner.stop(run.id);
      else if (live.checking.has(i)) live.checking.get(i)?.abort();
      else if (step) { step.status = "failed"; step.reason = "stopped"; }
    }
    this.advance(live);
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
    const pendingEnd = restoredEnd(rec.pendingEnd);
    if (flow.steps.some((s) => !s || typeof s !== "object")) throw new Error("invalid flow steps");
    delete flow.fleetId;
    const repo = resolve(rec.repoPath);
    if (repo) flow.repoId = repo.id;
    const live: LiveFlow = {
      flow,
      repo: repo ?? { id: flow.repoId, name: flow.repoId, path: rec.repoPath, group: "", source: "", status: null },
      workflow: chained(rec.workflow),
      agent: repo ? agentFor(repo) : () => DEFAULT_AGENT,
      before: rec.before,
      checking: new Map(), marks: new Map(), resuming: new Set(), restarting: new Set(),
      parks: restoredParks(rec.parks, flow.steps.length),
    };
    this.live.set(flow.id, live);
    if (!isFlowActive(flow)) return;
    if (!repo) {
      const step = flow.steps[flow.current];
      if (step) {
        step.status = "failed";
        step.reason = "the repo is not in the scan any more";
      }
      this.finish(live, "failed", "the repo is not in the scan any more");
      return;
    }
    if (!rec.parks && (flow.status === "gated" || flow.parkedFor)) {
      const cause: ParkCause = flow.parkedFor === "stage"
        ? { kind: "stage", check: flow.stageCheck === true }
        : { kind: flow.parkedFor ?? "gate" };
      live.parks.set(flow.current, cause);
    }
    if (pendingEnd) {
      for (const step of flow.steps) {
        if (step.status === "running" || step.status === "checking") {
          if (pendingEnd.end === "stopped") {
            step.status = "failed";
            step.reason = "stopped";
          } else this.resetStep(step, true);
        }
      }
      this.finish(live, pendingEnd.end, pendingEnd.error);
      return;
    }
    if (flow.status === "gated") {
      if (flow.restarted) live.restarting.add(flow.current);
      return;
    }
    for (const [i, step] of flow.steps.entries()) {
      if (step.status === "running" || step.status === "checking") {
        this.resetStep(step, true); live.restarting.add(i);
      }
    }
    flow.restarted = true;
    flow.status = "working";
    this.advance(live);
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

  /** The fleet a start with this client-minted id made, while it is kept. */
  fleetForRequest(request: string): Fleet | undefined {
    for (const f of this.fleetsLive.values()) if (f.fleet.request === request) return f.fleet;
    return undefined;
  }

  /** Starts a workflow over many repos. `agentFor` gives each repo's
   *  settings for a step, by the profile the step names, if any. A
   *  `request` works as it does for `start`. */
  startFleet(
    repos: Repo[],
    workflow: Workflow,
    note: string,
    agentFor: (repo: Repo, profile?: string) => AgentSettings,
    request?: string,
  ): Fleet {
    const again = request ? this.fleetForRequest(request) : undefined;
    if (again) return again;
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
      ...(request ? { request } : {}),
    };
    const pending = repos.filter((r) => !fleetSkipReason(r, workflow));
    this.fleetsLive.set(fleet.id, { fleet, workflow, note, pending, agentFor });
    this.pump(fleet.id);
    return fleet;
  }

  stopFleet(id: string): Fleet {
    const lf = this.fleetsLive.get(id);
    if (!lf) throw new Error(`unknown fleet: ${id}`);
    if (lf.fleet.status !== "working" || lf.fleet.stopping) return lf.fleet;
    for (const r of lf.pending) {
      const entry = lf.fleet.repos.find((x) => x.repoId === r.id);
      if (entry) entry.skipped = "stopped before it started";
    }
    lf.pending = [];
    // Marked stopping before the flows are stopped, so the last flow's end
    // pumps the fleet into stopped, not done. Until then it is working:
    // a flow still killing its check holds the fleet open.
    lf.fleet.stopping = true;
    for (const l of this.live.values()) {
      if (l.flow.fleetId === id && isFlowActive(l.flow)) this.stop(l.flow.id);
    }
    if (lf.fleet.status === "working") {
      if (this.running(id) === 0) this.finishFleet(lf, "stopped");
      else this.hooks.onFleet(lf.fleet);
    }
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
      this.finishFleet(lf, lf.fleet.stopping ? "stopped" : "done");
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
        const flow = this.start(repo, lf.workflow, lf.note, (profile) => lf.agentFor(repo, profile), { fleetId });
        if (entry) entry.flowId = flow.id;
      } catch (err) {
        if (entry) entry.skipped = String(err instanceof Error ? err.message : err);
      }
    }
  }

  private finishFleet(lf: { fleet: Fleet }, status: "done" | "stopped"): void {
    if (lf.fleet.status !== "working") return;
    lf.fleet.status = status;
    delete lf.fleet.stopping;
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
      ...(live.pending && "end" in live.pending ? { pendingEnd: live.pending } : {}),
      ...(live.parks.size ? { parks: [...live.parks].map(([step, cause]) => ({ step, cause })) } : {}),
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

  /** Back to pending, its run dismissed and everything it said dropped;
   *  its session too unless `keepSession` (a restart, which resumes it). */
  private resetStep(step: FlowStep | undefined, keepSession = false): void {
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
    delete step.changed;
    delete step.reason;
    if (!keepSession) {
      delete step.session;
      delete step.harness;
    }
    step.status = "pending";
  }

  /** A check or gate said no: back to the step's `back` while it has retries
   *  left, else whatever it would have done without retries. */
  private refuse(live: LiveFlow, i: number, reason: string, otherwise: () => void): void {
    if (!this.rewind(live, i, reason)) otherwise();
  }

  private rewind(live: LiveFlow, i: number, reason: string): boolean {
    const { flow, workflow } = live;
    const def = workflow.steps[i];
    if (!def || def.retries <= 0) return false;
    const tries = (flow.tries ??= {});
    const used = tries[def.name] ?? 0;
    if (used >= def.retries) return false;
    tries[def.name] = used + 1;
    const found = workflow.steps.findIndex((s) => s.name === def.back);
    const to = found === -1 || found > i ? i : found;
    for (let n = to; n <= i; n++) {
      if (n === i || !this.liveSteps(live).includes(n)) {
        this.resetStep(flow.steps[n]); live.parks.delete(n);
      }
    }
    const toName = workflow.steps[to]?.name ?? def.name;
    (flow.rewinds ??= []).push({ from: def.name, to: toName, reason, at: this.now() });
    flow.retryReason = to === i ? reason : `the ${def.name} step did not accept the work: ${reason}`;
    flow.current = to;
    this.advance(live);
    return true;
  }

  private summaries(live: LiveFlow): { name: string; summary: string }[] {
    return live.flow.steps
      .filter((s) => s.status === "passed")
      .map((s) => ({ name: s.name, summary: s.summary ?? "" }));
  }

  private async runStep(live: LiveFlow, i: number): Promise<void> {
    const { flow, workflow } = live;
    const def = workflow.steps[i];
    const step = flow.steps[i];
    if (!def || !step) return;
    this.clock(live, true);
    const restarted = live.restarting.has(i);
    flow.current = i;
    flow.status = "working";
    delete step.reason;
    step.status = "running";
    if (!def.body) {
      live.restarting.delete(i);
      if (!live.restarting.size) delete flow.restarted;
      // check-only: no agent, straight to the command
      flow.status = "working";
      await this.check(live, i);
      return;
    }
    let agent: AgentSettings;
    try {
      agent = live.agent(def.agent, live.workflow.name, live.workflow.agentRole ?? "flow");
    } catch (err) {
      step.status = "failed";
      step.reason = errText(err);
      this.fail(live, i, step.reason);
      return;
    }
    // A restart resumes the step's Claude session, which holds the prompt
    // and the work so far; anything else starts fresh with the restart note.
    const resume = restarted && step.session && step.harness === "claude" && agent.harness === "claude" ? step.session : undefined;
    let spec = stepSpec(workflow, i, this.summaries(live), flow.retryReason, restarted);
    if (resume) spec = { ...spec, resume, message: live.pickedUp ? PICKED_UP_NOTE : RESUME_NOTE };
    const tools = def.check ? this.hooks.checkTools?.(live.repo, def.check) : null;
    if (tools) {
      const extra = await tools.catch(() => []);
      if (!isFlowActive(flow) || step.status !== "running") return;
      if (live.pending && "end" in live.pending) {
        step.status = "pending";
        this.advance(live);
        return;
      }
      if (extra.length > 0) spec = { ...spec, allowedTools: [...new Set([...spec.allowedTools, ...extra])] };
    }
    if (this.hooks.fingerprint) {
      const before = await this.fingerprint(live);
      if (!isFlowActive(flow) || step.status !== "running") return;
      if (live.pending && "end" in live.pending) {
        step.status = "pending";
        this.advance(live);
        return;
      }
      if (before !== null) live.marks.set(i, before);
      else live.marks.delete(i);
    }
    if (def.body) {
      const over = overBudget(workflow.budget ?? null, this.spentNow(live));
      if (over) {
        if ((flow.grace ?? 0) > 0) {
          flow.grace = (flow.grace ?? 0) - 1;
        } else {
          this.park(live, i, over, "gated", { kind: "budget" });
          return;
        }
      }
    }
    // every step runs on the flow's branch, held from the landing queue
    // until the flow is done; the setup line runs before the first only
    const onBranch: BranchStart | undefined = flow.branch
      ? { branch: { ...branchOf(flow.branch, "working"), held: true }, ...(live.prepare ? { prepare: live.prepare } : {}) }
      : undefined;
    let run: Run;
    try {
      run = this.runner.start(live.repo, workflow.name, spec, flow.note, agent, undefined, undefined, onBranch);
      delete live.prepare;
    } catch (err) {
      // The stage runner is away: the step waits for it, and keeps the
      // restart note for when it runs. By name, not class, as a thrown
      // error is matched across modules.
      if (err instanceof Error && err.name === "StageAwayError") {
        this.park(live, i, err.message, "gated", { kind: "stage", check: false });
        return;
      }
      step.status = "failed";
      step.reason = String(err instanceof Error ? err.message : err);
      this.fail(live, i, step.reason);
      return;
    }
    live.restarting.delete(i);
    if (!live.restarting.size) { delete flow.restarted; delete live.pickedUp; }
    if (resume) live.resuming.add(run.id);
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

  private async afterRun(live: LiveFlow, i: number): Promise<void> {
    const step = live.flow.steps[i];
    if (!step) return;
    step.status = "checking";
    this.clock(live, true);
    if (this.hooks.fingerprint) {
      const after = await this.fingerprint(live);
      if (!isFlowActive(live.flow) || step.status !== "checking") return;
      const before = live.marks.get(i);
      if (before !== undefined && after !== null) step.changed = before !== after;
      live.marks.delete(i);
    }
    const def = live.workflow.steps[i];
    if (def?.check) await this.check(live, i);
    else await this.gate(live, i);
  }

  /** Runs the step's command; a non-zero exit ends the flow. */
  private async check(live: LiveFlow, i: number): Promise<void> {
    const def = live.workflow.steps[i];
    const step = live.flow.steps[i];
    if (!def?.check || !step) return;
    step.status = "checking";
    this.emit(live);
    const ctl = new AbortController();
    live.checking.set(i, ctl);
    let r: CheckResult;
    try {
      r = await this.hooks.check(workRepo(live), def.check, ctl.signal);
      if (live.checking.get(i) !== ctl) return;
    } finally {
      if (live.checking.get(i) === ctl) live.checking.delete(i);
    }
    // stopped while it ran: the check has exited now, so the stop lands
    if (live.pending && "end" in live.pending && live.pending.end === "stopped") {
      step.status = "failed";
      step.reason = "stopped";
      this.advance(live);
      return;
    }
    if (!isFlowActive(live.flow) || step.status !== "checking") return;
    if (r.away && isSeedId(live.repo.id)) {
      // the check never ran: it waits for the stage runner, and no retry is spent
      this.park(live, i, r.output || STAGE_AWAY, "gated", { kind: "stage", check: true });
      return;
    }
    step.check = { command: def.check, exit: r.exit, output: r.output };
    if (r.exit !== 0) {
      const reason = `check failed with exit ${r.exit}`;
      this.refuse(live, i, `${reason}:\n${tailOf(r.output)}`, () => {
        // out of retries parks, so the sheet can show the output; no retries fails as it always did
        if (routesCheckFailure(live.workflow, def.name)) {
          step.status = "failed";
          step.reason = reason;
          this.advance(live);
        } else if (def.retries > 0) this.park(live, i, reason);
        else {
          step.status = "failed";
          step.reason = reason;
          this.fail(live, i, reason);
        }
      });
      return;
    }
    await this.gate(live, i);
  }

  private async gate(live: LiveFlow, i: number): Promise<void> {
    const def = live.workflow.steps[i];
    const step = live.flow.steps[i];
    if (!def || !step) return;
    switch (def.gate) {
      case "continue":
        await this.pass(live, i);
        return;
      case "ask":
        this.park(live, i, "this step asks before the next one starts");
        return;
      case "verdict": {
        if (!this.hooks.evaluator) {
          this.park(live, i, "no gateway key, so the verdict is yours");
          return;
        }
        let changed: boolean | null = null;
        if (live.flow.branch) {
          const read = await this.readBranch(live.flow.branch);
          changed = read === null ? null : read !== "nothing";
        } else if (this.hooks.status) {
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
          if (!isFlowActive(live.flow) || step.status !== "checking") return;
          const v = decide(answers);
          step.verdict = v;
          if (v.go) await this.pass(live, i);
          else {
            const reason = v.reason ?? "the verdict said no";
            this.refuse(live, i, reason, () => this.park(live, i, reason));
          }
        } catch (err) {
          if (!isFlowActive(live.flow) || step.status !== "checking") return;
          this.park(live, i, `verdict unavailable: ${String(err instanceof Error ? err.message : err)}`);
        }
        return;
      }
      case "judge": {
        const judge = this.hooks.judge;
        if (!judge) {
          this.park(live, i, "no gateway key, so the judgment is yours");
          return;
        }
        let files: EvidenceFile[] = [];
        if (def.evidence.length > 0 && this.hooks.evidence) {
          try {
            files = await this.hooks.evidence(workRepo(live), def.evidence);
          } catch {
            files = def.evidence.map((path) => ({ path, text: null }));
          }
        } else {
          files = def.evidence.map((path) => ({ path, text: null }));
        }
        if (!isFlowActive(live.flow) || step.status !== "checking") return;
        try {
          const answers = await judge(
            judgeState({ task: def.body, summary: step.summary ?? "", check: step.check?.output ?? null, files }),
          );
          if (!isFlowActive(live.flow) || step.status !== "checking") return;
          const j = decideJudge(answers);
          step.judgment = j;
          if (j.go) await this.pass(live, i);
          else if (j.rejected) this.park(live, i, j.reason ?? "the judge turned the work down");
          else {
            const reason = j.reason ?? "the judge said no";
            this.refuse(live, i, reason, () => this.park(live, i, reason));
          }
        } catch (err) {
          if (!isFlowActive(live.flow) || step.status !== "checking") return;
          this.park(live, i, `judgment unavailable: ${errText(err)}`);
        }
        return;
      }
    }
  }

  private park(live: LiveFlow, i: number, reason: string, status: "gated" | "held" = "gated", cause: ParkCause = { kind: "gate" }): void {
    const step = live.flow.steps[i];
    if (!step) return;
    step.status = status;
    step.reason = reason;
    live.parks.set(i, cause);
    if (!live.pending) {
      live.pending = { park: i };
      this.showPark(live, i);
    }
    this.advance(live);
  }

  private showPark(live: LiveFlow, i: number): void {
    const cause = live.parks.get(i);
    delete live.flow.parkedFor;
    delete live.flow.stageCheck;
    if (cause && cause.kind !== "gate") live.flow.parkedFor = cause.kind;
    if (cause?.kind === "stage" && cause.check) live.flow.stageCheck = true;
  }

  private fail(live: LiveFlow, i: number, reason: string): void {
    const step = live.flow.steps[i];
    if (!step) return;
    step.status = "failed";
    step.reason = reason;
    // An end takes precedence over a park; an explicit stop wins over a failure.
    if (!live.pending || "park" in live.pending) live.pending = { end: "failed", error: reason };
    this.advance(live);
  }

  private async pass(live: LiveFlow, i: number): Promise<void> {
    const step = live.flow.steps[i];
    if (!step) return;
    step.status = "passed";
    delete step.reason;
    delete live.flow.retryReason;
    this.advance(live);
  }

  private skip(live: LiveFlow, i: number): void {
    const step = live.flow.steps[i];
    const def = live.workflow.steps[i];
    if (!step || !def) return;
    step.status = "skipped";
    step.reason = `none of its conditions held: ${def.when.join(", ")}`;
  }

  private async fingerprint(live: LiveFlow): Promise<string | null> {
    try { return await this.hooks.fingerprint?.(workRepo(live)) ?? null; }
    catch { return null; }
  }

  private liveSteps(live: LiveFlow): number[] {
    return live.flow.steps.flatMap((s, i) => s.status === "running" || s.status === "checking" ? [i] : []);
  }

  private activity(live: LiveFlow): void {
    const indices = this.liveSteps(live);
    const waiting = indices.some((i) => {
      const id = live.flow.steps[i]?.runId;
      return id && this.runner.get(id)?.status === "waiting";
    });
    const working = indices.some((i) => {
      const step = live.flow.steps[i];
      const run = step?.runId ? this.runner.get(step.runId) : undefined;
      return step?.status === "checking" || !run || run.status !== "waiting";
    });
    live.flow.status = waiting ? "waiting" : "working";
    this.clock(live, working);
  }

  private advance(live: LiveFlow): void {
    if (live.advancing) { live.advanceAgain = true; return; }
    live.advancing = true;
    try {
      do {
        live.advanceAgain = false;
        this.advanceOnce(live);
      } while (live.advanceAgain);
    } finally { delete live.advancing; }
  }

  private advanceOnce(live: LiveFlow): void {
    const { flow, workflow } = live;
    if (!isFlowActive(flow)) return;
    if (live.pending) {
      if (this.liveSteps(live).length) { this.activity(live); this.emit(live); return; }
      const pending = live.pending;
      delete live.pending;
      if ("end" in pending) { this.finish(live, pending.end, pending.error); return; }
      flow.current = pending.park;
      this.showPark(live, pending.park);
      flow.status = "gated";
      this.clock(live, false);
      this.emit(live);
      return;
    }
    const parked = flow.steps.findIndex((s) => s.status === "gated" || s.status === "held");
    if (parked >= 0) {
      live.pending = { park: parked };
      this.showPark(live, parked);
      // A working record may have been saved while its park drained a sibling.
      // Only those interrupted siblings restart, never an untouched successor.
      // Starting can synchronously delete and re-add a session fallback.
      const interrupted = [...live.restarting];
      for (const i of interrupted) {
        if (flow.steps[i]?.status !== "pending" || !isFlowActive(flow) || "end" in live.pending) continue;
        void this.runStep(live, i);
      }
      live.advanceAgain = true;
      return;
    }
    let skipped: boolean;
    do {
      skipped = false;
      for (const i of ready(flow, workflow)) {
        if (!whenHolds(flow, workflow, i)) { this.skip(live, i); skipped = true; }
      }
    } while (skipped);
    for (const i of ready(flow, workflow)) {
      if (this.liveSteps(live).length >= FLOW_PARALLEL) break;
      const def = workflow.steps[i];
      const step = flow.steps[i];
      if (!def || !step) continue;
      const writer = this.liveSteps(live).find((n) => {
        const other = workflow.steps[n];
        return other && !readOnlyStep(other);
      });
      if (!readOnlyStep(def) && writer !== undefined) {
        step.reason = `waits for ${workflow.steps[writer]?.name} (both change the tree)`;
        continue;
      }
      if (def.mode === "manual") {
        this.park(live, i, `${def.name} waits for your go`, "held");
        continue;
      }
      void this.runStep(live, i);
      if (live.pending && "end" in live.pending || flow.parkedFor) break;
    }
    if (!isFlowActive(flow)) return;
    if (this.liveSteps(live).length) { this.activity(live); this.emit(live); return; }
    if (live.pending) { live.advanceAgain = true; return; }
    if (flow.steps.every((s) => s.status !== "pending" && s.status !== "gated" && s.status !== "held")) this.finish(live, "done");
  }

  private finish(live: LiveFlow, status: "done" | "failed" | "stopped", error?: string): void {
    if (!isFlowActive(live.flow)) return;
    clearTimeout(live.stopping);
    delete live.stopping;
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

  /** What the branch's worktree holds, or null when it cannot be read. */
  private async readBranch(b: RunBranch): Promise<RunBranchState | null> {
    if (!this.hooks.branchState) return null;
    try {
      return await this.hooks.branchState(b);
    } catch {
      return null;
    }
  }

  /** A flow on a branch, ended: its worktree read into the branch's state
   *  and outcome, and a done flow's branch handed to the landing queue. */
  private async settleBranch(live: LiveFlow, b: RunBranch): Promise<void> {
    const read = (await this.readBranch(b)) ?? "nothing";
    // dismissed or pruned while the read was out: saving it would bring it back
    if (this.live.get(live.flow.id) !== live || isFlowActive(live.flow)) return;
    live.flow.branch = branchOf(b, read);
    live.flow.outcome = read === "nothing" ? "unchanged" : "changed";
    this.emit(live);
    if (live.flow.status !== "done") return;
    const last = [...live.flow.steps].reverse().find((s) => s.runId)?.runId;
    this.hooks.onBranchEnd?.(live.flow, last);
  }

  private async settle(live: LiveFlow): Promise<void> {
    if (live.flow.branch) return this.settleBranch(live, live.flow.branch);
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
