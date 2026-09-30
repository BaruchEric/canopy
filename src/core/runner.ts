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
import { CodexDriver } from "./codexrun";
import { RunCtx, type RunDriver } from "./driver";
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
}

export class Runner {
  private live = new Map<string, Live>();

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
    const make = this.opts.driver ?? ((h: Harness) => defaultDriver(h, this.opts.version));
    const driver = make(agent.harness);
    const missing = driver.check();
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
      { cwd: repo.path, agent, spec, env: runEnv(run, this.opts.backend), label: driver.label },
      // `live` is read only once the run has ended, long after it is set
      { emit: (r) => this.hooks.onChange(r), ended: () => void this.settle(live) },
    );
    const live: Live = { ctx, driver, started: false, repo, spec, before: statusFingerprint(repo.status) };
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

  /** Reads git status once the run is over and records whether it moved. */
  private async settle(live: Live): Promise<void> {
    const read = this.hooks.status;
    if (!read) return;
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
