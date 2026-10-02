/** The seam between the Runner and one harness's wire.
 *
 *  A run is the same thing whichever agent does the work: a timeline of
 *  steps, prompts that park it until the browser answers, a result, and a
 *  status that ends in done, failed or stopped. What differs is the wire:
 *  Claude Code speaks stream-json on stdio, Codex speaks JSON-RPC through
 *  `codex app-server`. A `RunDriver` owns one run's process and its wire, and
 *  reports everything through the `DriveCtx` the Runner hands it.
 *
 *  `RunCtx` is the Runner's half of one run: the step cap, the prompt queue
 *  with its "allow all" sweep, the notes a settled prompt leaves, and how an
 *  exit becomes a status. Both drivers (`claudedrive.ts`, `codexrun.ts`) are
 *  tested against the same code the Runner runs. The Runner keeps what is
 *  not per run: the map of live runs, one-at-a-time per repo, pruning, which
 *  driver a harness gets, and the git status read that sets `outcome`. */

import { stageEnv } from "./envnames";
import type { Harness, Run, RunAnswer, RunPrompt, RunQuestion, RunResult, RunStatus, RunStep, RunTokens } from "./types";

/** steps kept per run; the oldest fall off with a note */
export const STEP_CAP = 400;

export type DriveHarness = Harness;

/** Token counts for a run, where the harness reports them. */
export type DriveTokens = RunTokens;

/** A turn's result: a cost only where the harness reports one, tokens
 *  where it reports those. */
export type DriveResult = RunResult;

/** The run a context works on. */
export type DriveRun = Run;

/** The agent settings a driver reads. canopy's `AgentSettings` fits: model
 *  and effort are plain strings here since the harnesses name them
 *  differently, and the Runner has already normalized them per harness. */
export interface DriveAgent {
  model: string;
  effort: string;
  yolo: boolean;
  extra: string;
}

/** The parts of an `ActionSpec` a driver reads. */
export interface DriveSpec {
  /** Claude permission rules (`Bash(git status:*)`, `Read`, ...) */
  allowedTools: readonly string[];
  maxTurns: number;
}

/** A prompt before the Runner numbers it. */
export type PromptInput =
  | { kind: "permission"; tool: string; title: string; detail: string }
  | { kind: "question"; questions: RunQuestion[] };

/** How a driver's process ended. */
export interface DriveExit {
  /** exit code; null when a signal ended it or it never started */
  code: number | null;
  /** the last of its stderr */
  stderr: string;
  /** a failure the driver caught itself (a spawn that threw, a request the
   *  harness refused) rather than the process just ending */
  error?: string;
}

/** What the Runner hands a driver for one run. */
export interface DriveCtx {
  /** the repo's absolute path: where the process starts, and the prefix step
   *  titles drop */
  readonly cwd: string;
  /** a chat keeps its process between turns */
  readonly chat: boolean;
  readonly agent: DriveAgent;
  readonly spec: DriveSpec;
  /** extra environment for the process, on top of canopy's own */
  readonly env: Readonly<Record<string, string>>;
  /** an incubator stage's run: its process starts without what `stageEnv`
   *  drops (canopy's GitHub login, the callback API, tailchan) */
  readonly stage?: boolean;
  /** the run's status now; "idle" tells a chat between turns */
  status(): RunStatus;
  /** Appends a step and returns it. A tool step's `tool` may be updated in
   *  place later (status, output); call `changed()` after. */
  step(step: Omit<RunStep, "id" | "at">): RunStep;
  /** broadcasts the run as it is now */
  changed(): void;
  /** a one-line remark from canopy, broadcast at once */
  note(text: string): void;
  /** Parks the run on a prompt until the browser answers it, the driver
   *  withdraws it, or the run stops (a stop answers "deny"). `key` is the
   *  driver's own name for it, the wire's request id. After "allow all" a
   *  permission resolves "allow" at once without showing anything. */
  ask(prompt: PromptInput, key: string): Promise<RunAnswer>;
  /** The harness took a prompt back (Claude's control_cancel_request, Codex's
   *  serverRequest/resolved for one canopy never answered). It settles as a
   *  "deny". */
  withdraw(key: string): void;
  /** the harness's session id for the run, once it is known */
  session(id: string): void;
  /** A turn's result. A job ends with it: done, or failed with `problem`. A
   *  chat goes idle, the problem said as a note. */
  result(result: DriveResult, problem: string | null): void;
  /** The process is gone. Called once, whatever ended it. Whether that is a
   *  stop, the end of a chat, or a failure is the Runner's call. */
  exited(exit: DriveExit): void;
}

/** The environment a run's process starts with: canopy's live one with the
 *  run's own laid over it, and for an incubator stage without what
 *  `stageEnv` drops, so the harness and every command it runs go without
 *  canopy's GitHub login. */
export function spawnEnv(ctx: Pick<DriveCtx, "env" | "stage">, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string | undefined> {
  return ctx.stage ? { ...stageEnv(base), ...stageEnv(ctx.env) } : { ...base, ...ctx.env };
}

/** One run's process and wire. One instance per run. */
export interface RunDriver {
  readonly harness: DriveHarness;
  /** the harness's name in messages: "Claude Code", "Codex" */
  readonly label: string;
  /** Why this harness cannot start here (its binary is not on PATH), asked
   *  before a run exists; null when it can. */
  check(): string | null;
  /** Spawns the process and sends the first message, the framed prompt. */
  start(ctx: DriveCtx, message: string): void;
  /** A chat's next message; the Runner only calls it while the run is idle. */
  say(text: string): void;
  /** Ends the run's process. While a turn runs, it interrupts and kills. A
   *  chat between turns is closed politely, and the exit after is its end.
   *  Prompts still waiting have been answered "deny" by the Runner first. */
  stop(): void;
}

/** `isRunActive` on a bare status: a live process, working, waiting on a
 *  prompt, or a chat between turns. */
export const activeStatus = (s: RunStatus): boolean =>
  s === "working" || s === "waiting" || s === "idle";

/** The note the timeline keeps when a prompt is settled, in the words the
 *  Runner has always used. */
export function settleNote(prompt: RunPrompt | PromptInput, a: RunAnswer): string {
  if (prompt.kind === "question") {
    return a.kind === "answers" ? `answered: ${Object.values(a.answers).join("; ")}` : "question dismissed";
  }
  if (a.kind === "allow-all") return `allowed everything from here: ${prompt.title}`;
  if (a.kind === "allow") return `allowed: ${prompt.title}`;
  return `denied: ${prompt.title}`;
}

/** How a process ending becomes the run's status. `stopping` is a stop
 *  while a turn ran; `ending` is a chat closed between turns, whose clean
 *  exit is its end. Anything else that ends a run before its result is a
 *  failure, with the stderr tail as the reason. */
export function exitOutcome(
  flags: { stopping: boolean; ending: boolean },
  exit: DriveExit,
  label: string,
): { status: "done" | "failed" | "stopped"; error?: string } {
  if (flags.stopping) return { status: "stopped" };
  const tail = exit.stderr.trim();
  if (exit.error !== undefined) {
    return { status: "failed", error: tail ? `${exit.error}\n${tail}` : exit.error };
  }
  if (flags.ending && exit.code === 0) return { status: "done" };
  return {
    status: "failed",
    error: `${label} exited (code ${exit.code}) without a result${tail ? `: ${tail}` : ""}`,
  };
}

interface Pending {
  key: string;
  prompt: RunPrompt;
  settle: (a: RunAnswer) => void;
}

export interface RunCtxInit {
  cwd: string;
  agent: DriveAgent;
  spec: DriveSpec;
  env?: Record<string, string>;
  /** an incubator stage's run (`DriveCtx.stage`) */
  stage?: boolean;
  /** the harness's name in failure messages */
  label: string;
}

export interface RunCtxHooks {
  /** the run changed: the Runner broadcasts it */
  emit: (run: DriveRun) => void;
  /** the run just ended: the Runner reads git status for its outcome */
  ended?: (run: DriveRun) => void;
}

/** The Runner's half of one run: what runner.ts does in `step`, `ask`,
 *  `finish` and the result and exit branches of `drive`, over one run. */
export class RunCtx implements DriveCtx {
  /** set by the Runner's stop() while a turn runs: the exit that follows is
   *  a stop, not a failure */
  stopping = false;
  /** set by the Runner's stop() on a chat between turns: a clean exit that
   *  follows is the end of the conversation */
  ending = false;
  /** "allow all for this run" was chosen: later permissions pass silently */
  allowAll = false;
  readonly cwd: string;
  readonly agent: DriveAgent;
  readonly spec: DriveSpec;
  readonly env: Readonly<Record<string, string>>;
  readonly stage: boolean;
  /** The prompts the harness waits on, oldest first; the first is the one
   *  the run shows. More than one when tools are called in parallel. */
  private pending: Pending[] = [];
  /** numbers the prompts, so no two share an id */
  private prompts = 0;
  private seq = 0;
  private label: string;

  constructor(
    readonly run: DriveRun,
    init: RunCtxInit,
    private hooks: RunCtxHooks,
  ) {
    this.cwd = init.cwd;
    this.agent = init.agent;
    this.spec = init.spec;
    this.stage = init.stage ?? false;
    this.env = this.stage ? stageEnv(init.env ?? {}) : (init.env ?? {});
    this.label = init.label;
  }

  get chat(): boolean {
    return this.run.chat;
  }

  status(): RunStatus {
    return this.run.status;
  }

  step(step: Omit<RunStep, "id" | "at">): RunStep {
    this.seq += 1;
    const full: RunStep = { id: String(this.seq), at: Date.now(), ...step };
    const steps = this.run.steps;
    steps.push(full);
    if (steps.length > STEP_CAP) {
      steps.splice(0, steps.length - STEP_CAP);
      const first = steps[0];
      if (first && first.kind !== "note") {
        steps.unshift({ id: "trim", at: first.at, kind: "note", text: "earlier steps trimmed" });
      }
    }
    return full;
  }

  changed(): void {
    this.hooks.emit(this.run);
  }

  note(text: string): void {
    this.step({ kind: "note", text });
    this.changed();
  }

  session(id: string): void {
    this.run.session = id;
  }

  ask(prompt: PromptInput, key: string): Promise<RunAnswer> {
    if (prompt.kind === "permission" && this.allowAll) return Promise.resolve({ kind: "allow" });
    const full: RunPrompt = { ...prompt, id: `p${++this.prompts}` };
    return new Promise((resolve) => {
      const entry: Pending = {
        key,
        prompt: full,
        settle: (a) => {
          const i = this.pending.indexOf(entry);
          if (i === -1) return;
          this.pending.splice(i, 1);
          const next = this.pending[0];
          // A prompt settled after the run ended must not bring it back, and
          // one settled on a chat between turns must not wake it: only a
          // turn that is running waits on prompts.
          if (this.run.status === "working" || this.run.status === "waiting") {
            this.run.status = next ? "waiting" : "working";
            this.run.prompt = next?.prompt ?? null;
          }
          this.step({ kind: "note", text: settleNote(full, a) });
          if (a.kind === "allow-all" && full.kind === "permission") {
            this.allowAll = true;
            // the ones already queued behind it are "later" too
            for (const p of this.pending.slice()) if (p.prompt.kind === "permission") p.settle({ kind: "allow" });
          }
          this.changed();
          resolve(a);
        },
      };
      this.pending.push(entry);
      if (this.pending.length === 1) {
        this.run.status = "waiting";
        this.run.prompt = full;
        this.changed();
      }
    });
  }

  /** The browser's answer to the prompt under `promptId`. */
  answer(promptId: string, a: RunAnswer): void {
    const waiting = this.pending.find((p) => p.prompt.id === promptId);
    if (!waiting) throw new Error("that prompt is no longer waiting");
    waiting.settle(a);
  }

  withdraw(key: string): void {
    this.pending.find((p) => p.key === key)?.settle({ kind: "deny" });
  }

  /** Answers every waiting prompt "deny", for a stop. */
  denyAll(): void {
    // settling takes an entry off the queue, so walk a copy
    for (const p of this.pending.slice()) p.settle({ kind: "deny" });
  }

  result(result: DriveResult, problem: string | null): void {
    this.run.result = result;
    if (this.run.chat) {
      // A chat's result ends one reply, not the conversation: the process
      // stays, and the next message continues it. A prompt still waiting
      // belonged to the turn that just ended (a sub-agent's the harness
      // never cleared), so it is denied and dropped rather than left for
      // the browser to answer into the next turn.
      if (problem) this.step({ kind: "note", text: problem });
      this.denyAll();
      if (activeStatus(this.run.status)) {
        this.run.status = "idle";
        this.run.prompt = null;
      }
      this.changed();
      return;
    }
    if (problem) this.run.error = problem;
    this.finish(problem ? "failed" : "done");
  }

  exited(exit: DriveExit): void {
    const out = exitOutcome({ stopping: this.stopping, ending: this.ending }, exit, this.label);
    this.finish(out.status, out.error);
  }

  /** Ends the run once; later calls do nothing. */
  finish(status: "done" | "failed" | "stopped", error?: string): void {
    if (!activeStatus(this.run.status)) return;
    this.run.status = status;
    this.run.endedAt = Date.now();
    this.run.prompt = null;
    if (error) this.run.error = error;
    this.changed();
    this.hooks.ended?.(this.run);
  }
}
