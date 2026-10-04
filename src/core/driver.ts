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

import type { RpcProc, RpcSpawn } from "./codexrpc";
// a type alone: codexrun imports this module at run time
import type { ApprovalFacts } from "./codexrun";
import { stageEnv } from "./envnames";
import { STAGE_AWAY } from "./stagewire";
import type { Harness, PermissionAsk, Run, RunAnswer, RunPrompt, RunQuestion, RunResult, RunStatus, RunStep, RunTokens } from "./types";

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
  /** no one answers this run: every prompt is denied at once with this
   *  message, and the run never waits */
  unattended?: string;
}

/** A prompt before the Runner numbers it. */
export type PromptInput = PermissionAsk | { kind: "question"; questions: RunQuestion[] };

/** What a run's remembered rules say about a permission (`core/remember.ts`,
 *  wired by the Runner). */
export interface RememberHook {
  /** the remembered rule that answers this permission, or null */
  match(prompt: PermissionAsk, facts: ApprovalFacts): string | null;
  /** a command's folder, checked on disk (a symlink out of the repo) before
   *  a match answers it */
  inside(facts: ApprovalFacts): Promise<boolean>;
}

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
  /** a stage's process, started in the stages container; its env is the
   *  runner's own, so `spawnEnv` is only what the runner may pass on. Set
   *  only for an isolated stage run: the driver then starts its harness by
   *  bare program name, never a path found here. */
  readonly spawn?: RpcSpawn;
  /** Every process the driver starts goes through this before the driver
   *  uses it, whichever spawn made it. The Runner sets it on a stage run to
   *  hold the seed busy until the process is gone; the proc it hands back
   *  resolves `exited` only once the seed is quiet. */
  readonly track?: (proc: RpcProc) => RpcProc;
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
   *  permission resolves "allow" at once without showing anything, and so
   *  does one a remembered rule covers. `facts` are what the rule is matched
   *  on, when the driver has its own (Codex); else they are read off the
   *  prompt's fields. */
  ask(prompt: PromptInput, key: string, facts?: ApprovalFacts): Promise<RunAnswer>;
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
 *  canopy's GitHub login. A stage started through the stage runner gets the
 *  run's own names alone: none of canopy's env crosses the socket, and the
 *  runner builds the child's env from its own. */
export function spawnEnv(
  ctx: Pick<DriveCtx, "env" | "stage" | "spawn">,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  if (ctx.spawn) return { ...stageEnv(ctx.env) };
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
  if (a.kind === "allow" && a.remember) return `allowed, and remembered ${a.remember.rule}: ${prompt.title}`;
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
  /** what a remembered rule is matched on, for a permission */
  facts: ApprovalFacts;
  /** settles it; `note` replaces the timeline's usual words */
  settle: (a: RunAnswer, note?: string) => void;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The facts a prompt's own fields give: a shell command, a file tool's
 *  paths, or anything else (`factsOf` in remember.ts, here without its
 *  imports). */
export function promptFacts(p: PromptInput): ApprovalFacts {
  if (p.kind !== "permission") return { kind: "other" };
  if (p.tool === "Bash") return { kind: "command", command: p.command ?? null, cwd: p.cwd ?? null };
  if (EDIT_TOOLS.has(p.tool)) return { kind: "fileChange", paths: p.paths ?? null, grantRoot: null };
  return { kind: "other" };
}

export interface RunCtxInit {
  cwd: string;
  agent: DriveAgent;
  spec: DriveSpec;
  env?: Record<string, string>;
  /** an incubator stage's run (`DriveCtx.stage`) */
  stage?: boolean;
  /** the stage runner's spawn (`DriveCtx.spawn`) */
  spawn?: RpcSpawn;
  /** the Runner's tap on every process (`DriveCtx.track`) */
  track?: (proc: RpcProc) => RpcProc;
  /** the harness's name in failure messages */
  label: string;
  /** the remembered rules that answer this run's permissions */
  remember?: RememberHook;
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
  /** set by the Runner when a stage run's process died with the stage
   *  runner itself: the failure says so, and a flow parks on it */
  away = false;
  /** with `away`, the stage runner's words when it refused for its fence */
  awayWhy: string | null = null;
  readonly cwd: string;
  readonly agent: DriveAgent;
  readonly spec: DriveSpec;
  readonly env: Readonly<Record<string, string>>;
  readonly stage: boolean;
  readonly spawn?: RpcSpawn;
  readonly track?: (proc: RpcProc) => RpcProc;
  /** The prompts the harness waits on, oldest first; the first is the one
   *  the run shows. More than one when tools are called in parallel. */
  private pending: Pending[] = [];
  /** numbers the prompts, so no two share an id */
  private prompts = 0;
  private seq = 0;
  private label: string;
  private remember: RememberHook | null;

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
    if (init.spawn) this.spawn = init.spawn;
    if (init.track) this.track = init.track;
    this.label = init.label;
    this.remember = init.remember ?? null;
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

  ask(prompt: PromptInput, key: string, given?: ApprovalFacts): Promise<RunAnswer> {
    if (prompt.kind === "permission" && this.allowAll) return Promise.resolve({ kind: "allow" });
    const unattended = this.spec.unattended;
    if (unattended) {
      this.note(`denied, as no one answers this run: ${prompt.kind === "permission" ? prompt.title : "the question"}`);
      return Promise.resolve({ kind: "deny", message: unattended });
    }
    const facts = given ?? promptFacts(prompt);
    // a remembered rule answers a permission, never a question
    const rule = prompt.kind === "permission" ? this.remembered(prompt, facts) : null;
    if (rule) {
      const allowed = (): RunAnswer => {
        this.note(`allowed by a remembered rule (${rule}): ${prompt.kind === "permission" ? prompt.title : ""}`);
        return { kind: "allow" };
      };
      // a folder the request names is checked on disk first; the words
      // alone already passed
      if (facts.kind === "command" && facts.cwd !== null && this.remember) {
        return this.remember.inside(facts).then((ok) => (ok ? allowed() : this.park(prompt, key, facts)));
      }
      return Promise.resolve(allowed());
    }
    return this.park(prompt, key, facts);
  }

  /** the remembered rule answering a permission now, or null */
  private remembered(prompt: PermissionAsk, facts: ApprovalFacts): string | null {
    return this.remember?.match(prompt, facts) ?? null;
  }

  /** Settles every waiting permission a remembered rule now covers, after
   *  a rule was added. */
  recheck(): void {
    for (const p of this.pending.slice()) {
      if (p.prompt.kind !== "permission") continue;
      const prompt = p.prompt;
      const rule = this.remembered(prompt, p.facts);
      if (!rule || !this.remember) continue;
      const settle = () => p.settle({ kind: "allow" }, `allowed by a remembered rule (${rule}): ${prompt.title}`);
      if (p.facts.kind === "command" && p.facts.cwd !== null) {
        void this.remember.inside(p.facts).then((ok) => ok && settle());
      } else settle();
    }
  }

  /** The waiting permission under `promptId`, with the facts a rule is
   *  matched on; undefined when it is not waiting. */
  waitingPermission(promptId: string): { prompt: PermissionAsk & { id: string }; facts: ApprovalFacts } | undefined {
    const p = this.pending.find((x) => x.prompt.id === promptId);
    return p && p.prompt.kind === "permission" ? { prompt: p.prompt, facts: p.facts } : undefined;
  }

  /** Parks the run on a prompt until it is settled. */
  private park(prompt: PromptInput, key: string, facts: ApprovalFacts): Promise<RunAnswer> {
    const full: RunPrompt = { ...prompt, id: `p${++this.prompts}` };
    return new Promise((resolve) => {
      const entry: Pending = {
        key,
        prompt: full,
        facts,
        settle: (a, note) => {
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
          this.step({ kind: "note", text: note ?? settleNote(full, a) });
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
    const away = this.away && out.status === "failed";
    // the words are for people; a flow parks on the flag alone
    if (away) this.run.away = true;
    if (away && this.awayWhy !== null) this.run.awayWhy = this.awayWhy;
    this.finish(out.status, away ? (this.awayWhy ?? `${STAGE_AWAY}: ${out.error ?? ""}`) : out.error);
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
