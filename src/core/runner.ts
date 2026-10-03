/** Runs: one headless agent session per job, driven over stdio.
 *
 *  The Runner keeps what every run shares whichever agent does the work: the
 *  map of live runs, one at a time per repo, the chat's turn-taking, stops,
 *  pruning, and the git status read that says whether a run changed
 *  anything. The wire is a `RunDriver` picked by the run's harness: Claude
 *  Code's stream-json (`claudedrive.ts`) or Codex's app-server
 *  (`codexrun.ts`). Each run's half of the bookkeeping (steps, the prompt
 *  queue, the result, how an exit becomes a status) is a `RunCtx`
 *  (`driver.ts`), and the server broadcasts the `Run` whole on every change. */

import { buildPrompt, type ActionSpec } from "./actions";
import { ClaudeDriver } from "./claudedrive";
import type { RpcProc } from "./codexrpc";
import { CodexDriver } from "./codexrun";
import { RunCtx, type RunDriver } from "./driver";
import type { StageClient } from "./stageclient";
import { StageAwayError } from "./stagewire";
import {
  DEFAULT_AGENT,
  isRunActive,
  statusFingerprint,
  type AgentSettings,
  type Harness,
  type Repo,
  type RepoStatus,
  type Run,
  type RunAnswer,
} from "./types";

export { claudeBinary, cliArgs } from "./claudedrive";

/** finished runs kept for late-joining browsers */
const KEEP_FINISHED = 60;
/** how long a stage run's end waits for the stage runner to call its seed
 *  quiet before canopy takes it as quiet anyway */
const QUIET_WAIT = 5_000;
/** the pause between two busy questions while the seed is still busy */
const QUIET_POLL = 100;

export interface RunnerHooks {
  onChange: (run: Run) => void;
  onGone: (id: string) => void;
  /** a fresh git status for the repo, read when a run ends, to tell whether
   *  the run changed anything the card shows; null when unreadable */
  status?: (repoId: string) => Promise<RepoStatus | null>;
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
 *  run, repo and backend it is. A harness hook reads them (tailchan's stays
 *  out of a canopy run's permission prompts, which canopy answers itself). */
export function runEnv(run: Pick<Run, "id" | "repoId">, backend?: string): Record<string, string> {
  return {
    CANOPY_RUN: run.id,
    CANOPY_REPO: run.repoId,
    ...(backend ? { CANOPY_BACKEND: backend } : {}),
  };
}

interface Live {
  ctx: RunCtx;
  driver: RunDriver;
  /** the driver has its process: a chat that opened with nothing to say
   *  starts it with the first message */
  started: boolean;
  /** the repo as it was when the run started; also what a chat's first
   *  message reuses for the prompt's framing */
  repo: Repo;
  spec: ActionSpec;
  /** status fingerprint at start, compared with the one at the end */
  before: string;
  /** each of a stage run's processes, settled once it has exited and its
   *  seed is quiet; the end-of-run status read waits on them */
  drains: Promise<unknown>[];
}

export class Runner {
  private live = new Map<string, Live>();
  /** repo path → how many stage processes are alive there */
  private procs = new Map<string, number>();

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

  activeFor(repoId: string): Run | undefined {
    for (const l of this.live.values()) {
      if (l.ctx.run.repoId === repoId && isRunActive(l.ctx.run)) return l.ctx.run;
    }
    return undefined;
  }

  /** Whether a stage run's process is alive in the repo at `path`: from its
   *  spawn until it has exited and the stage runner says nothing is left
   *  running there, which is before the run's end-of-run status read. */
  liveIn(path: string): boolean {
    return (this.procs.get(path) ?? 0) > 0;
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
  ): Run {
    const busy = this.activeFor(repo.id);
    if (busy) {
      throw new Error(`${repo.name} already has a ${busy.verb} run going`);
    }
    if (spec.noteRequired && !note.trim()) {
      throw new Error("write what the agent should do first");
    }
    const stage = this.opts.stage?.(repo) ?? false;
    const client = stage && this.opts.stageExec ? this.opts.stageExec() : undefined;
    if (client === null) throw new StageAwayError(this.opts.stageAway?.());
    const make = this.opts.driver ?? ((h: Harness) => defaultDriver(h, this.opts.version));
    const driver = make(agent.harness);
    const missing = client ? stageRefusal(client, agent.harness) : driver.check();
    if (missing) throw new Error(missing);
    const chat = spec.mode === "chat";
    const run: Run = {
      id: crypto.randomUUID().slice(0, 8),
      repoId: repo.id,
      action,
      verb: spec.verb,
      progress: spec.progress,
      expectsChange: spec.expectsChange,
      chat,
      harness: agent.harness,
      // a chat keeps its messages as steps; the note box is not its record
      note: chat ? "" : note.trim(),
      status: chat && !note.trim() ? "idle" : "working",
      startedAt: Date.now(),
      steps: [],
      prompt: null,
    };
    if (by) run.by = by;
    const ctx = new RunCtx(
      run,
      {
        cwd: repo.path,
        agent,
        spec,
        env: runEnv(run, this.opts.backend),
        stage,
        label: driver.label,
        ...(client ? { spawn: client.spawn } : {}),
        // `live` is set before the driver starts anything
        ...(stage ? { track: (proc: RpcProc) => this.track(live, repo.path, proc, client) } : {}),
      },
      // `live` is read only once the run has ended, long after it is set
      { emit: (r) => this.hooks.onChange(r), ended: () => void this.settle(live) },
    );
    const live: Live = { ctx, driver, started: false, repo, spec, before: statusFingerprint(repo.status), drains: [] };
    this.live.set(run.id, live);
    this.prune();
    if (chat) {
      if (note.trim()) live.ctx.step({ kind: "user", text: note.trim() });
      this.hooks.onChange(run);
      if (note.trim()) this.begin(live, buildPrompt(repo, spec, note));
      return run;
    }
    this.hooks.onChange(run);
    this.begin(live, buildPrompt(repo, spec, run.note));
    return run;
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
    else this.begin(live, buildPrompt(live.repo, live.spec, message));
    return run;
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
    for (const l of this.live.values()) {
      if (isRunActive(l.ctx.run)) this.stop(l.ctx.run.id);
    }
  }

  private begin(live: Live, message: string): void {
    live.started = true;
    live.driver.start(live.ctx, message);
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
   *  driver's exit and the status read after it both find the seed quiet. */
  private track(live: Live, path: string, proc: RpcProc, client: StageClient | undefined): RpcProc {
    this.procs.set(path, (this.procs.get(path) ?? 0) + 1);
    const exited = (async () => {
      try {
        const code = await proc.exited;
        // A process gone without an exit code, not by a stop, may have gone
        // with the stage runner itself: a hello that finds no runner says so,
        // and the run's failure names it (a flow parks on that, not fails).
        if (code === null && client && !live.ctx.stopping && (await client.hello().catch(() => null)) === null) {
          live.ctx.away = true;
        }
        return code;
      } finally {
        if (client) await this.quiet(client, path);
        const n = (this.procs.get(path) ?? 1) - 1;
        if (n > 0) this.procs.set(path, n);
        else this.procs.delete(path);
      }
    })();
    live.drains.push(exited.catch(() => null));
    return { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr, exited, kill: () => proc.kill() };
  }

  /** Asks the stage runner whether anything still runs in the seed, until
   *  it says no or `QUIET_WAIT` is up. The runner kills what a run left
   *  behind when its connection ends, so a no comes at once as a rule; an
   *  answer that does not come counts as quiet, with one line in the log. */
  private async quiet(client: StageClient, path: string): Promise<void> {
    const deadline = Date.now() + QUIET_WAIT;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        console.error(`runner: ${path} still had a process in it ${QUIET_WAIT} ms after the run's own ended; taking it as quiet`);
        return;
      }
      let busy: boolean | null;
      try {
        busy = await client.busy(path, left);
      } catch {
        busy = null;
      }
      if (busy === false) return;
      if (busy === null) {
        console.error(`runner: the stage runner did not say whether ${path} is quiet; taking it as quiet`);
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(QUIET_POLL, Math.max(0, deadline - Date.now()))));
    }
  }

  /** Reads git status once the run is over and records whether it moved. */
  private async settle(live: Live): Promise<void> {
    const read = this.hooks.status;
    if (!read) return;
    // a stage run's processes first: the seed is read only once it is quiet
    if (live.drains.length) await Promise.all(live.drains);
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
