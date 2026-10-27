/** Runs: one headless agent session per job, driven over stdio.
 *
 *  The Runner keeps what every run shares whichever agent does the work: the
 *  map of live runs, one checkout job or flow per repo, the chat's turn-taking, stops,
 *  pruning, and the git status read that says whether a run changed
 *  anything. The wire is a `RunDriver` picked by the run's harness: Claude
 *  Code's stream-json (`claudedrive.ts`) or Codex's app-server
 *  (`codexrun.ts`). Each run's half of the bookkeeping (steps, the prompt
 *  queue, the result, how an exit becomes a status) is a `RunCtx`
 *  (`driver.ts`), and the server broadcasts the `Run` whole on every change. */

import { branchPrompt, buildPrompt, busyWith, type ActionSpec } from "./actions";
import { normalizeAgent } from "./agent";
import { ClaudeDriver } from "./claudedrive";
import type { RpcProc } from "./codexrpc";
import { CodexDriver, runsInside } from "./codexrun";
import { answerMisfit, RunCtx, type RememberHook, type RunDriver } from "./driver";
import { rememberOffer } from "./offer";
import { pathsInside, rememberedFor, ruleCovers, type RunScope } from "./remember";
import { EDIT_TOOLS } from "./shellwords";
import { holdQuiet, type QuietHold, type StageClient } from "./stageclient";
import { StageAwayError } from "./stagewire";
import {
  DEFAULT_AGENT,
  isRunActive,
  statusFingerprint,
  type AgentSettings,
  type Harness,
  type Priority,
  type Repo,
  type RepoStatus,
  type RememberedRule,
  type Run,
  type RunAnswer,
  type RunBranch,
  type RunBranchState,
  type WorkspaceScope,
} from "./types";

/** At most this many distinct branch worktrees active in one repo. */
export const BRANCH_RUNS_PER_REPO = 3;

/** A branch run refused because its repo has `BRANCH_RUNS_PER_REPO` going.
 *  The runner counts distinct active worktrees, held ones too, which a
 *  caller's own slot count may not. */
export class BranchCapError extends Error {
  override name = "BranchCapError";
}

/** What a branch run starts with beyond a plain run's arguments. */
export interface BranchStart {
  /** the branch and worktree, made before the run starts */
  branch: RunBranch;
  /** Runs in the worktree before the agent starts: the gates' setup line.
   *  `say` adds a note to the run's timeline. A throw fails the run. */
  prepare?: (say: (text: string) => void) => Promise<void>;
  /** a Claude session to resume: a "fix it" run on a sent-back branch */
  resume?: string;
  /** the whole first message, in place of the built prompt ("fix it") */
  message?: string;
}

/** What a run the server sets up itself starts with beyond the plain
 *  arguments. */
export interface StartExtras {
  /** Private in-memory identity for steps belonging to one flow. */
  flowOwner?: symbol;
  /** best-of-N attribution, including the first event and costs */
  group?: string;
  priority?: Priority;
  /** the coordinator that started it, set before the run's first change is
   *  heard, so every listener sees a child as one */
  parent?: string;
  /** the run's id, chosen first: a coordinator's token is minted for it
   *  before the run exists */
  id?: string;
  /** more names for the run's process, over `runEnv`'s; they reach it
   *  through a stage spawn's filter too (`DriveCtx.pass`) */
  env?: Record<string, string>;
  /** where the run's process starts, in place of the repo's checkout: a
   *  coordinator's own folder under its runner's seeds */
  cwd?: string;
  /** a Claude session to resume, for a chat the sweep stopped; a branch's own
   *  `resume` wins when both are set */
  resume?: string;
}

export { claudeBinary, cliArgs } from "./claudedrive";

/** finished runs kept for late-joining browsers */
const KEEP_FINISHED = 60;
/** how long a stage run's end waits for the stage runner to call its seed
 *  quiet before the run ends anyway; the seeds stay busy past it until the
 *  runner says no */
export const QUIET_WAIT = 5_000;

export interface RunnerHooks {
  onChange: (run: Run) => void;
  onGone: (id: string) => void;
  /** a fresh git status for the repo, read when a run ends, to tell whether
   *  the run changed anything the card shows; null when unreadable */
  status?: (repoId: string) => Promise<RepoStatus | null>;
  /** what a branch run's worktree holds once it ends, read in place of the
   *  repo's status */
  branchState?: (run: Run) => Promise<RunBranchState>;
}

export interface RunnerOptions {
  /** makes the driver for a run's harness; tests swap in a stand-in */
  driver?: (harness: Harness) => RunDriver;
  /** this backend's name, handed to every run as CANOPY_BACKEND */
  backend?: string;
  /** canopy's version, which Codex hears in `initialize` */
  version?: string;
  /** whether a repo's runs are an incubator stage's (a seed), which start
   *  without canopy's GitHub login (`stageEnv`) */
  stage?: (repo: Repo) => boolean;
  /** The stage runner's client for a stage run: null while it is away, so
   *  the run refuses with `StageAwayError`, and undefined when stages run
   *  here, unisolated. Asked once per stage run, at its start. */
  stageExec?: () => StageClient | null | undefined;
  /** why a stage run cannot start when `stageExec` gives null: the
   *  runner's absence by default, or the env to set when none is set up */
  stageAway?: () => string;
  /** The coordinator's runner, a second stage runner, for a coordinate
   *  run. Null while it is away or not set up, and an unset option alike,
   *  refuse the run with `StageAwayError`: a coordinator never runs here,
   *  unisolated. Asked once per coordinate run, at its start. */
  coordExec?: () => StageClient | null;
  /** why a coordinate run cannot start when `coordExec` gives null */
  coordAway?: () => string;
  /** how long a stage run's end waits for the runner to call its seed
   *  quiet before the run ends anyway; tests shorten it */
  quietWait?: number;
  /** the remembered rules as they are now, read at every permission */
  remembered?: () => readonly RememberedRule[];
}

/** Why a stage run cannot start through the stage runner, in the words the
 *  browser shows: the runner's own list of harnesses is what counts, since
 *  the harness runs in its container and not here. */
function stageRefusal(client: StageClient, harness: Harness): string | null {
  const have = client.harnessesNow();
  if (have === null) throw new StageAwayError();
  return have.includes(harness) ? null : `${harness} is not installed in the stages container`;
}

/** The driver a harness gets when nothing is swapped in. */
export function defaultDriver(harness: Harness, version = "0"): RunDriver {
  return harness === "codex"
    ? new CodexDriver({ client: { name: "canopy", title: "canopy", version } })
    : new ClaudeDriver();
}

/** What every run's process gets on top of canopy's own environment: which
 *  run, repo and backend it is, and any names the run was started with (a
 *  coordinator's API and token). A harness hook reads them (tailchan's
 *  stays out of a canopy run's permission prompts, which canopy answers
 *  itself). */
export function runEnv(run: Pick<Run, "id" | "repoId">, backend?: string, extra?: Readonly<Record<string, string>>): Record<string, string> {
  return {
    CANOPY_RUN: run.id,
    CANOPY_REPO: run.repoId,
    ...(backend ? { CANOPY_BACKEND: backend } : {}),
    ...extra,
  };
}

/** A coordinator works from no checkout: it holds no repo, so it is never
 *  the run going there, and no status read judges its end. */
const isCoordinate = (run: Pick<Run, "action">): boolean => run.action === "coordinate";

type DriverProcess =
  | { kind: "idle" }
  | { kind: "running"; exited: Promise<void>; markExited: () => void }
  | { kind: "exited" };

interface Live {
  ctx: RunCtx;
  flowOwner?: symbol;
  driver: RunDriver;
  /** the driver has its process: a chat that opened with nothing to say
   *  starts it with the first message */
  started: boolean;
  /** the repo as it was when the run started; also what a chat's first
   *  message reuses for the prompt's framing */
  repo: Repo;
  spec: ActionSpec;
  /** the workspace a run spans, kept so a chat's later prompts say so too */
  scope?: WorkspaceScope;
  /** status fingerprint at start, compared with the one at the end */
  before: string;
  /** each of a stage run's processes, settled once it has exited and its
   *  seed is quiet or `quietWait` is up; `exited` and `whenQuiet` wait on them */
  drains: Promise<unknown>[];
  /** each of a stage run's processes, settled once the stage runner has
   *  let its seed go (`holdQuiet`'s release); the end-of-run status read
   *  waits on these too, so a run's outcome is read from a quiet seed */
  releases: Promise<unknown>[];
  /** a branch run's start: its prepare runs before the first message */
  branch?: BranchStart;
  /** a branch run's prepare is going and the driver has not started */
  preparing?: boolean;
  preparation?: Promise<void>;
  /** terminal status and its asynchronous branch-state update */
  ended: Promise<void>;
  process: DriverProcess;
}

export class Runner {
  private live = new Map<string, Live>();
  /** repo path → how many stage processes are alive there */
  private procs = new Map<string, number>();
  /** a coordinator's folder → how many of its processes are alive there;
   *  apart from `procs`, since a coordinator holds no seed or repo */
  private coordProcs = new Map<string, number>();
  /** every seed a stage run left still busy, let go of on `stopAll` */
  private holds = new Set<QuietHold>();

  constructor(
    private hooks: RunnerHooks,
    private opts: RunnerOptions = {},
  ) {}

  list(): Run[] {
    return [...this.live.values()].map((l) => l.ctx.run);
  }

  get(id: string): Run | undefined {
    return this.live.get(id)?.ctx.run;
  }

  /** The run going in the repo's checkout. A branch run works in its own
   *  worktree, shares nothing with the checkout, and is not counted; nor is
   *  a coordinator, which has no checkout at all; nor a chat ended between
   *  turns, which takes no more turns and may be a long while exiting (its
   *  async hooks run first). */
  activeFor(repoId: string): Run | undefined {
    for (const l of this.live.values()) {
      const r = l.ctx.run;
      if (r.repoId === repoId && !r.branch && !isCoordinate(r) && !l.ctx.ending && isRunActive(r)) return r;
    }
    return undefined;
  }

  /** The coordinator going at the repo, one at a time. */
  coordinatorFor(repoId: string): Run | undefined {
    for (const l of this.live.values()) {
      const r = l.ctx.run;
      if (r.repoId === repoId && isCoordinate(r) && isRunActive(r)) return r;
    }
    return undefined;
  }

  /** The branch runs going in the repo, each in its own worktree. */
  branchRunsFor(repoId: string): Run[] {
    return [...this.live.values()].map((l) => l.ctx.run).filter((r) => r.repoId === repoId && r.branch && isRunActive(r));
  }

  /** Active worktrees take capacity once, even when a flow has several step runs. */
  branchSlotsFor(repoId: string): number {
    return new Set(this.branchRunsFor(repoId).flatMap((run) => run.branch ? [run.branch.origin] : [])).size;
  }

  /** Whether a stage run's process (or a coordinator's, by its folder) is
   *  alive in the repo at `path`: from its
   *  spawn until it has exited and the stage runner says nothing is left
   *  running there, past `quietWait` while the runner keeps saying busy.
   *  The run's end-of-run status read waits for that. */
  liveIn(path: string): boolean {
    return (this.procs.get(path) ?? 0) > 0 || (this.coordProcs.get(path) ?? 0) > 0;
  }

  /** Whether anything of the stages is alive anywhere: a stage run that is
   *  active, or a stage process `liveIn` some seed. A stage can write every
   *  seed, so while this holds canopy runs git in none of them. */
  liveAny(): boolean {
    if (this.procs.size > 0) return true;
    for (const l of this.live.values()) if (isRunActive(l.ctx.run) && (this.opts.stage?.(l.repo) ?? false)) return true;
    return false;
  }

  /** `liveAny` for one seed: a stage run active on the repo at `path`, or
   *  a stage process `liveIn` it. On an isolated backend this alone holds
   *  canopy's git off a seed. */
  stageAliveIn(path: string): boolean {
    if (this.liveIn(path)) return true;
    for (const l of this.live.values()) if (l.repo.path === path && isRunActive(l.ctx.run) && (this.opts.stage?.(l.repo) ?? false)) return true;
    return false;
  }

  /** Settles once every stage process started in the repo at `path` has
   *  exited and the seed is quiet, or after `maxMs`. A run ends on its
   *  result, before its process is gone, so a flow's gate that reads the
   *  seed's status right after waits on this first. */
  async whenQuiet(path: string, maxMs = 2 * QUIET_WAIT): Promise<void> {
    const drains = [...this.live.values()].filter((l) => l.repo.path === path).flatMap((l) => l.drains);
    if (!drains.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(drains), new Promise<void>((r) => (timer = setTimeout(r, maxMs)))]);
    clearTimeout(timer);
  }

  /** Starts a run on the harness the settings name. A chat may start with
   *  nothing to say: it opens idle, with no process, and the first message
   *  spawns the agent. */
  start(
    repo: Repo,
    action: string,
    spec: ActionSpec,
    note: string,
    agent: AgentSettings = DEFAULT_AGENT,
    by?: string,
    scope?: WorkspaceScope,
    branch?: BranchStart,
    extras: StartExtras = {},
  ): Run {
    const settings = normalizeAgent(agent);
    const coordinate = isCoordinate({ action });
    if (extras.id !== undefined && this.live.has(extras.id)) throw new Error(`a run ${extras.id} exists already`);
    if (coordinate) {
      if (scope || branch) throw new Error("a coordinator starts at a repo, not on a workspace or a branch");
      if (this.coordinatorFor(repo.id)) throw new Error(`${repo.name} already has a coordinator going`);
    } else if (branch) {
      if (scope) throw new Error("a workspace run works in its folders, not on a branch");
      const sibling = extras.flowOwner !== undefined && [...this.live.values()].some((live) =>
        live.flowOwner === extras.flowOwner && live.repo.id === repo.id &&
        live.ctx.run.branch?.origin === branch.branch.origin && isRunActive(live.ctx.run));
      if (!sibling && this.branchSlotsFor(repo.id) >= BRANCH_RUNS_PER_REPO) {
        throw new BranchCapError(`${repo.name} has ${BRANCH_RUNS_PER_REPO} branch runs going; wait for one to end`);
      }
    } else {
      const busy = [...this.live.values()].find((live) => {
        const run = live.ctx.run;
        return run.repoId === repo.id && !run.branch && !isCoordinate(run) && !live.ctx.ending && isRunActive(run) &&
          (extras.flowOwner === undefined || live.flowOwner !== extras.flowOwner);
      })?.ctx.run;
      if (busy) throw new Error(busyWith(repo.name, busy.verb));
    }
    if (spec.noteRequired && !note.trim() && !branch?.message && !spec.message) {
      throw new Error("write what the agent should do first");
    }
    const stage = this.opts.stage?.(repo) ?? false;
    if (branch && stage) throw new Error("an incubator stage works in its seed, not on a branch");
    const cwd = extras.cwd ?? (branch ? branch.branch.dir : repo.path);
    // a coordinator runs through its own runner, never the stages'
    const client = coordinate ? (this.opts.coordExec?.() ?? null) : stage && this.opts.stageExec ? this.opts.stageExec() : undefined;
    if (client === null) throw new StageAwayError(coordinate ? this.opts.coordAway?.() : this.opts.stageAway?.());
    const make = this.opts.driver ?? ((h: Harness) => defaultDriver(h, this.opts.version));
    const driver = make(settings.harness);
    const missing = client ? stageRefusal(client, settings.harness) : driver.check();
    if (missing) throw new Error(missing);
    const chat = spec.mode === "chat";
    const run: Run = {
      id: extras.id ?? crypto.randomUUID().slice(0, 8),
      repoId: repo.id,
      action,
      verb: spec.verb,
      progress: spec.progress,
      expectsChange: spec.expectsChange,
      chat,
      harness: settings.harness,
      agentSettings: {
        harness: settings.harness,
        model: settings.model,
        effort: settings.effort,
        ...(settings.provider ? { provider: settings.provider } : {}),
      },
      // a chat keeps its messages as steps; the note box is not its record
      note: chat ? "" : note.trim(),
      status: chat && !note.trim() ? "idle" : "working",
      startedAt: Date.now(),
      steps: [],
      prompt: null,
    };
    if (by) run.by = by;
    if (extras.parent) run.parent = extras.parent;
    const group = extras.group ?? branch?.branch.group;
    if (group) run.group = group;
    if (extras.priority) run.priority = extras.priority;
    if (scope) run.workspace = scope.workspace;
    if (spec.flowStep) run.flowStep = { ...spec.flowStep };
    if (branch) run.branch = { ...branch.branch, state: "working", ...(group ? { group } : {}) };
    // a stage's run never takes a remembered rule (amendment 4, ruling 16):
    // a rule kept on one seed, or for one step, must not hold for the next.
    // A branch run's rules are judged by its worktree, so a repo rule kept
    // for the checkout's path does not answer there.
    // nor does a coordinator's, which runs with its permissions bypassed in
    // a folder no rule was kept for
    const remember = stage || coordinate ? null : this.rememberHook(run, cwd);
    const resume = branch?.resume ?? extras.resume;
    const driveSpec = { ...spec, ...(scope ? { addDirs: scope.others } : {}), ...(resume ? { resume } : {}) };
    let markEnded = () => {};
    const ended = new Promise<void>(resolve => { markEnded = resolve; });
    const ctx = new RunCtx(
      run,
      {
        cwd,
        agent: settings,
        spec: driveSpec,
        env: runEnv(run, this.opts.backend, extras.env),
        ...(extras.env ? { pass: extras.env } : {}),
        stage,
        label: driver.label,
        ...(remember ? { remember } : {}),
        ...(client ? { spawn: client.spawn } : {}),
        // `live` is set before the driver starts anything
        ...(stage ? { track: (proc: RpcProc) => this.track(live, repo.path, proc, client) } : {}),
        // a coordinator's process is tracked like a stage's, by its own
        // folder: a spawn its runner refuses for the fence ends the run away
        ...(coordinate && client ? { track: (proc: RpcProc) => this.track(live, cwd, proc, client, this.coordProcs) } : {}),
      },
      // `live` is read only once the run has ended, long after it is set
      { emit: (r) => this.hooks.onChange(r), ended: () => { void this.settle(live).finally(markEnded); } },
    );
    const live: Live = {
      ctx,
      ...(extras.flowOwner ? { flowOwner: extras.flowOwner } : {}),
      driver,
      started: false,
      ended,
      process: { kind: "idle" },
      repo,
      spec,
      ...(scope ? { scope } : {}),
      ...(branch ? { branch } : {}),
      before: statusFingerprint(repo.status),
      drains: [],
      releases: [],
    };
    const exited = ctx.exited.bind(ctx);
    ctx.exited = (result) => {
      try { exited(result); }
      finally {
        const process = live.process;
        live.process = { kind: "exited" };
        if (process.kind === "running") process.markExited();
      }
    };
    this.live.set(run.id, live);
    this.prune();
    if (scope?.skipped.length) live.ctx.step({ kind: "note", text: `left out of this run: ${scope.skipped.join("; ")}` });
    if (branch) live.ctx.step({ kind: "note", text: `on branch ${branch.branch.name} in ${branch.branch.dir}` });
    if (chat) {
      if (note.trim()) live.ctx.step({ kind: "user", text: note.trim() });
      this.hooks.onChange(run);
      if (note.trim()) this.begin(live, this.firstMessage(live, note));
      return run;
    }
    this.hooks.onChange(run);
    this.begin(live, branch?.message ?? spec.message ?? this.firstMessage(live, run.note));
    return run;
  }

  /** The prompt a run's first message is wrapped in: the repo's framing, or
   *  a branch run's, which names its worktree and how its work lands. */
  private firstMessage(live: Live, note: string): string {
    const b = live.ctx.run.branch;
    return b ? branchPrompt(live.repo, live.spec, note, b) : buildPrompt(live.repo, live.spec, note, live.scope);
  }

  /** a one-line remark from canopy on a live run's timeline; nothing for an unknown or ended run */
  note(id: string, text: string): void {
    const live = this.live.get(id);
    if (!live || !isRunActive(live.ctx.run)) return;
    live.ctx.note(text);
  }

  /** The user's next message in a chat. The first one starts the agent
   *  with the repo's framing around it; later ones are the conversation's
   *  next turns, which the driver sends on the same session. */
  say(id: string, text: string): Run {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown run: ${id}`);
    const run = live.ctx.run;
    if (!run.chat) throw new Error("only a chat takes messages");
    if (run.status !== "idle") throw new Error(`${live.driver.label} is still replying`);
    const message = text.trim();
    if (!message) throw new Error("say something first");
    live.ctx.step({ kind: "user", text: message });
    run.status = "working";
    this.hooks.onChange(run);
    if (live.started) live.driver.say(message);
    else this.begin(live, this.firstMessage(live, message));
    return run;
  }

  /** The remembered rules' say over one run's permissions, read fresh at
   *  each one, so a rule added mid-run counts at its next prompt. */
  private rememberHook(run: Run, path: string): RememberHook | null {
    const rules = this.opts.remembered;
    if (!rules) return null;
    const scope: RunScope = { path, ...(run.flowStep ? { flowStep: run.flowStep } : {}) };
    return {
      match: (prompt, facts) => rememberedFor(rules(), scope, prompt, facts, path)?.rule ?? null,
      inside: async (prompt, facts) => (await runsInside(facts, path)) && (await pathsInside(prompt.paths ?? [], path, { guard: EDIT_TOOLS.has(prompt.tool) })),
    };
  }

  /** What a remember on a waiting permission needs: the run's scope, after
   *  checking that `rule` is one the page offered for that very prompt
   *  (`rememberOffer`) and covers it. A stage's run, a prompt id that is no
   *  longer the one waiting, and any other rule are refused. */
  rememberScope(id: string, promptId: string, rule: string): { scope: RunScope; title: string } {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown run: ${id}`);
    if (live.ctx.stage) throw new Error("an incubator stage's run keeps no rule");
    const waiting = live.ctx.waitingPermission(promptId);
    if (!waiting) throw new Error("that permission is no longer waiting");
    if (!rememberOffer(waiting.prompt, live.repo.path)?.rules.includes(rule)) {
      throw new Error(`canopy does not offer ${rule} for this request`);
    }
    if (!ruleCovers(rule, waiting.prompt, waiting.facts, live.repo.path)) {
      throw new Error(`${rule} does not cover this request, so remembering it would not stop it asking`);
    }
    const run = live.ctx.run;
    return { scope: { path: live.repo.path, ...(run.flowStep ? { flowStep: run.flowStep } : {}) }, title: waiting.prompt.title };
  }

  /** Every live run's waiting permissions that a remembered rule now
   *  covers are let through, after a rule was added. */
  recheck(): void {
    for (const live of this.live.values()) live.ctx.recheck();
  }

  /** Whether the run ever asked the prompt under `promptId`. */
  asked(id: string, promptId: string): boolean {
    return this.live.get(id)?.ctx.asked(promptId) ?? false;
  }

  /** Whether the run is waiting on the prompt under `promptId`. */
  waiting(id: string, promptId: string): boolean {
    return this.live.get(id)?.ctx.waiting(promptId) !== undefined;
  }

  /** Why `answer` cannot settle the prompt under `promptId` (approve to
   *  a permission, allow-all to a plan), or null; null too when the run or
   *  the prompt is not waiting, which `answer` reports itself. */
  misfit(id: string, promptId: string, answer: RunAnswer): string | null {
    const waiting = this.live.get(id)?.ctx.waiting(promptId);
    return waiting ? answerMisfit(waiting, answer) : null;
  }

  /** Settles the prompt the run is waiting on. */
  answer(id: string, promptId: string, answer: RunAnswer): Run {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown run: ${id}`);
    live.ctx.answer(promptId, answer);
    return live.ctx.run;
  }

  /** Stops a run. A chat between turns ends politely: the driver closes
   *  the session, the agent exits on its own, and the chat is done rather
   *  than stopped. A chat that never started the agent is simply done. */
  stop(id: string): Run {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown run: ${id}`);
    const run = live.ctx.run;
    if (!isRunActive(run)) return run;
    // a branch run still setting up has no driver to stop yet
    if (live.preparing) {
      live.ctx.finish("stopped");
      return run;
    }
    if (run.status === "idle") {
      if (!live.started) {
        live.ctx.finish("done");
        return run;
      }
      live.ctx.ending = true;
      live.driver.stop();
      return run;
    }
    live.ctx.stopping = true;
    live.ctx.denyAll();
    live.driver.stop();
    return run;
  }

  /** A rolled-back branch cannot be removed until its process/setup and final
   * state update have stopped touching the worktree. */
  async stopAndWait(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    const active = isRunActive(live.ctx.run);
    this.stop(id);
    const process = live.process;
    if (process.kind === "running") {
      // A terminal result ends the job before the driver's process exits.
      if (!active) live.driver.stop();
      await process.exited;
    }
    await live.preparation;
    await live.ended;
    await Promise.all(live.drains);
    await Promise.all(live.releases);
    // Work may have changed after the early result but before actual exit.
    await this.settle(live);
  }

  /** Forgets a finished run. Active runs must be stopped first. */
  dismiss(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (isRunActive(live.ctx.run)) throw new Error("stop the run before dismissing it");
    this.live.delete(id);
    this.hooks.onGone(id);
  }

  /** Stops everything, for server shutdown. */
  stopAll(): void {
    for (const h of this.holds) h.cancel();
    for (const l of this.live.values()) {
      if (isRunActive(l.ctx.run)) this.stop(l.ctx.run.id);
    }
  }

  private drive(live: Live, message: string): void {
    let markExited = () => {};
    const exited = new Promise<void>(resolve => { markExited = resolve; });
    live.process = { kind: "running", exited, markExited };
    live.driver.start(live.ctx, message);
  }

  private begin(live: Live, message: string): void {
    live.started = true;
    const prepare = live.branch?.prepare;
    if (!prepare) {
      this.drive(live, message);
      return;
    }
    // once: a chat's later turns never set up again
    live.branch = { ...live.branch!, prepare: undefined };
    live.preparing = true;
    live.preparation = prepare((text) => live.ctx.note(text)).then(
      () => {
        live.preparing = false;
        if (isRunActive(live.ctx.run)) this.drive(live, message);
      },
      (err: unknown) => {
        live.preparing = false;
        if (isRunActive(live.ctx.run)) live.ctx.finish("failed", `setup failed: ${String(err instanceof Error ? err.message : err)}`);
      },
    );
  }

  private prune(): void {
    const finished = [...this.live.values()]
      .filter((l) => !isRunActive(l.ctx.run))
      .sort((a, b) => (a.ctx.run.endedAt ?? 0) - (b.ctx.run.endedAt ?? 0));
    while (finished.length > KEEP_FINISHED) {
      const oldest = finished.shift();
      if (!oldest) break;
      this.live.delete(oldest.ctx.run.id);
      this.hooks.onGone(oldest.ctx.run.id);
    }
  }

  /** Holds the seed busy (`liveIn`) for one of a stage run's processes.
   *  The proc handed back resolves `exited` only once the process is gone
   *  and, through the stage runner, nothing else runs in the seed, so the
   *  driver's exit and the status read after it both find the seed quiet.
   *  A coordinator's processes count in `coordProcs` by its own folder,
   *  which `liveIn` sees and `liveAny` does not. */
  private track(live: Live, path: string, proc: RpcProc, client: StageClient | undefined, counts = this.procs): RpcProc {
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const exited = (async () => {
      try {
        const code = await proc.exited;
        // the runner refused it for its fence, by the refusal's own field:
        // the step waits for the fence as it waits for a runner away
        const unfenced = client?.fenceRefusal(proc) ?? null;
        if (unfenced !== null && !live.ctx.stopping) {
          live.ctx.away = true;
          live.ctx.awayWhy = unfenced;
          return code;
        }
        // A process gone without an exit code, or with the 127 a connection
        // that never reached the runner reads as, not by a stop, may have
        // gone with the stage runner itself: a hello that finds no runner
        // says so, and the run carries the flag a flow parks on. A 127 the
        // runner answers after is the stage's own exit, and fails.
        if ((code === null || code === 127) && client && !live.ctx.stopping && (await client.hello().catch(() => null)) === null) {
          live.ctx.away = true;
        }
        return code;
      } finally {
        // the exit waits for the wait; the seeds stay busy past it while
        // the stage runner still says something runs there
        const hold = client ? holdQuiet(client, path, this.opts.quietWait ?? QUIET_WAIT, "runner") : null;
        const drop = (): void => {
          const n = (counts.get(path) ?? 1) - 1;
          if (n > 0) counts.set(path, n);
          else counts.delete(path);
        };
        if (hold) {
          this.holds.add(hold);
          live.releases.push(
            hold.released.then(() => {
              this.holds.delete(hold);
              drop();
            }),
          );
          await hold.settled;
        } else drop();
      }
    })();
    live.drains.push(exited.catch(() => null));
    return { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr, exited, kill: () => proc.kill() };
  }

  /** Reads git status once the run is over and records whether it moved.
   *  A branch run reads its worktree instead: commits and nothing left over
   *  is `ready`, the one state the landing queue takes. */
  private async settle(live: Live): Promise<void> {
    if (isCoordinate(live.ctx.run)) return;
    const b = live.ctx.run.branch;
    if (b) {
      const readBranch = this.hooks.branchState;
      let state: RunBranchState = "nothing";
      try {
        state = readBranch ? await readBranch(live.ctx.run) : "nothing";
      } catch {
        state = "nothing";
      }
      const run = live.ctx.run;
      if (isRunActive(run)) return;
      run.branch = { ...b, state };
      run.outcome = state === "nothing" ? "unchanged" : "changed";
      this.hooks.onChange(run);
      return;
    }
    const read = this.hooks.status;
    if (!read) return;
    // a stage run's processes first: the seed is read only once it is quiet,
    // past `quietWait` too while the stage runner still says busy
    if (live.drains.length) await Promise.all(live.drains);
    if (live.releases.length) await Promise.all(live.releases);
    const run = live.ctx.run;
    let after: string | null = null;
    try {
      const st = await read(run.repoId);
      after = st ? statusFingerprint(st) : null;
    } catch {
      after = null;
    }
    // A continuation may have started meanwhile; its own end will settle.
    if (after === null || isRunActive(run)) return;
    run.outcome = after === live.before ? "unchanged" : "changed";
    this.hooks.onChange(run);
  }
}
