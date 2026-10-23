/** The sweep's server half (docs/superpowers/specs/2026-10-22-sweep-design.md):
 *  the plan built from live state, the close of a picked subset, its routes
 *  and the `sweep` event. The rules are `core/sweep.ts`; what it keeps on
 *  disk (the swept chats, the log) is `core/sweepstore.ts`.
 *
 *  Closes run one at a time through one queue, and each item is planned
 *  again from fresh facts just before it is closed, so a shell typed into
 *  since the preview is left alone ("in use now") and a second device
 *  pressing close on the same items finds them "gone". */

import { loadConfig, setSweep } from "../core/store";
import { patchSweep, planSweep, type PlanInputs } from "../core/sweep";
import { addSweptChat, appendLog, readLog, readSweptChats, takeSweptChat } from "../core/sweepstore";
import { SWEEP_KINDS, type KeptShell, type Run, type ServerEvent, type SweepInfo, type SweepItem, type SweepKind, type SweepOutcome, type SweepSettings, type SweptChat } from "../core/types";

export interface SweepDeps {
  broadcast(ev: ServerEvent): void;
  /** the shells, runs and cards as they are now */
  facts(): Promise<PlanInputs>;
  /** ends a shell, keeping its history as a swept record first: "in use
   *  now" when it was typed into after `seen`, the last keystroke the plan
   *  saw for it (0 for none), "failed" when the record could not be
   *  written; either way it is left running */
  endShell(id: string, seen: number): Promise<"closed" | "in use now" | "failed">;
  /** a run's status as it is this moment, for the last look before a stop */
  runStatus(runId: string): Run["status"] | undefined;
  /** stops a chat between turns; throws for a run it does not know */
  stopChat(runId: string): Run;
  /** forgets a finished run */
  dismissRun(runId: string): void;
  /** starts a chat on the session a swept chat had */
  startChat(c: SweptChat): Promise<Run>;
  /** the swept shells on offer to restore */
  keptSwept(): Promise<KeptShell[]>;
  now?: () => number;
  /** the settings' read and write, in place of the config's; tests */
  loadSettings?: () => Promise<SweepSettings>;
  saveSettings?: (s: SweepSettings) => Promise<void>;
}

/** a refusal with the status its route answers */
export class SweepError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

const ENDED = new Set<Run["status"]>(["done", "failed", "stopped"]);

export class SweepHub {
  /** closes and resumes, one at a time */
  private serial: Promise<unknown> = Promise.resolve();
  /** settings changes, one at a time, so two saves in flight never lose one */
  private patching: Promise<unknown> = Promise.resolve();
  /** keys this hub closed that the facts still show: a chat's stop ends it
   *  only once its process exits, and until then it still reads as idle */
  private closed = new Set<string>();

  constructor(private readonly deps: SweepDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.serial.then(fn);
    this.serial = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private async settings(): Promise<SweepSettings> {
    if (this.deps.loadSettings) return this.deps.loadSettings();
    return (await loadConfig()).sweep;
  }

  /** The plan less what this hub has closed already. A closed key the plan
   *  no longer has is let go of: whatever it was has ended. */
  private plan(facts: PlanInputs, settings: SweepSettings): SweepItem[] {
    const items = planSweep(facts, settings, this.now());
    for (const k of this.closed) if (!items.some((i) => i.key === k)) this.closed.delete(k);
    return items.filter((i) => !this.closed.has(i.key));
  }

  /** Nothing runs on its own yet; the routes are the whole hub. */
  async start(): Promise<void> {}

  stop(): void {}

  async info(): Promise<SweepInfo> {
    const [facts, settings, log, shells, chats] = await Promise.all([this.deps.facts(), this.settings(), readLog(), this.deps.keptSwept(), readSweptChats()]);
    return {
      items: this.plan(facts, settings),
      settings,
      lastRun: log.at(-1) ?? null,
      swept: { shells, chats },
      ask: null,
    };
  }

  private async publish(): Promise<void> {
    try {
      this.deps.broadcast({ type: "sweep", sweep: await this.info() });
    } catch (err) {
      console.error("canopy: sweep:", errText(err));
    }
  }

  /**
   * Closes the items named by `keys`, each after planning again from fresh
   * facts: a key the new plan has and may close is closed; one it lacks is
   * "in use now" while the thing is still there and "gone" once it is not.
   * One log entry per call, then the new plan goes out.
   */
  close(keys: string[], by: "eric" | "schedule"): Promise<SweepOutcome[]> {
    return this.queue(async () => {
      const wanted = [...new Set(keys)];
      if (wanted.length === 0) return [];
      const settings = await this.settings();
      const outcomes: SweepOutcome[] = [];
      const items: SweepItem[] = [];
      for (const key of wanted) {
        const facts = await this.deps.facts();
        const item = this.plan(facts, settings).find((i) => i.key === key);
        if (!item) {
          outcomes.push(this.closed.has(key) ? { key, result: "gone" } : missing(key, facts));
          continue;
        }
        items.push(item);
        if (!item.closable) {
          outcomes.push({ key, result: "failed", why: "it is listed only; the sweep does not close it" });
          continue;
        }
        try {
          const out = await this.closeOne(item, facts);
          if (out.result === "closed") this.closed.add(key);
          outcomes.push(out);
        } catch (err) {
          outcomes.push({ key, result: "failed", why: errText(err) });
        }
      }
      try {
        await appendLog({ at: this.now(), by, outcomes, items });
      } catch (err) {
        console.error("canopy: sweep: the log could not be written:", errText(err));
      }
      await this.publish();
      return outcomes;
    });
  }

  private async closeOne(item: SweepItem, facts: PlanInputs): Promise<SweepOutcome> {
    const { key, id } = item;
    switch (item.kind) {
      case "shell": {
        // a keystroke after the one the plan saw is someone back at it, even
        // one that landed while the facts were read or the plan made
        const seen = facts.shells?.find((s) => s.id === id)?.lastInput ?? 0;
        const how = await this.deps.endShell(id, seen);
        return how === "failed" ? { key, result: "failed", why: "its history could not be kept, so it was left running" } : { key, result: how };
      }
      case "chat": {
        const run = facts.runs.find((r) => r.id === id);
        if (!run?.session) return { key, result: "failed", why: "it has no session to resume" };
        // the record goes first, so a stopped chat can always be resumed
        await addSweptChat({ runId: id, repoId: run.repoId, harness: run.harness, session: run.session, title: item.title, sweptAt: this.now() });
        // the record's write gave a message time to start a turn: a chat
        // that is not idle this moment is in use, and a stop would cut it off
        if (this.deps.runStatus(id) !== "idle") {
          await takeSweptChat(id);
          return { key, result: "in use now" };
        }
        try {
          this.deps.stopChat(id);
        } catch (err) {
          await takeSweptChat(id);
          throw err;
        }
        return { key, result: "closed" };
      }
      case "run":
        this.deps.dismissRun(id);
        return { key, result: "closed" };
      default:
        return { key, result: "failed", why: `the sweep does not close a ${item.kind}` };
    }
  }

  /** Starts a chat on a swept chat's session and drops its record; 404 when
   *  there is no record (resumed already, or expired). */
  resume(runId: string): Promise<Run> {
    return this.queue(async () => {
      const rec = (await readSweptChats()).find((c) => c.runId === runId);
      if (!rec) throw new SweepError(404, "no swept chat by that id");
      const run = await this.deps.startChat(rec);
      await takeSweptChat(runId);
      await this.publish();
      return run;
    });
  }

  /** applies a settings change through patchSweep; its refusal is a 400 */
  patch(body: unknown): Promise<SweepSettings> {
    const run = this.patching.then(async () => {
      const next = patchSweep(await this.settings(), body);
      if (typeof next === "string") throw new SweepError(400, next);
      if (this.deps.saveSettings) await this.deps.saveSettings(next);
      else await setSweep(next);
      await this.publish();
      return next;
    });
    this.patching = run.catch(() => {});
    return run;
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/sweep" && !path.startsWith("/api/sweep/")) return null;
    const method = req.method;
    const body = async (): Promise<unknown> => req.json().catch(() => null);
    try {
      if (path === "/api/sweep" && method === "GET") return json(await this.info());
      if (path === "/api/sweep" && method === "POST") {
        const b = await body();
        const keys = isRecord(b) ? b["keys"] : undefined;
        if (!Array.isArray(keys) || !keys.every((k): k is string => typeof k === "string")) return json({ error: "keys is a list of item keys" }, 400);
        return json({ outcomes: await this.close(keys, "eric") });
      }
      if (path === "/api/sweep/resume" && method === "POST") {
        const b = await body();
        const runId = isRecord(b) ? b["runId"] : undefined;
        if (typeof runId !== "string" || !runId) return json({ error: "runId is required" }, 400);
        return json(await this.resume(runId));
      }
      if (path === "/api/sweep/settings" && method === "GET") return json(await this.settings());
      if (path === "/api/sweep/settings" && method === "POST") return json(await this.patch(await body()));
      return json({ error: "not found" }, 404);
    } catch (err) {
      const status = err instanceof Error && "status" in err ? err.status : undefined;
      return json({ error: errText(err) }, typeof status === "number" ? status : 500);
    }
  }
}

const isKind = (k: string): k is SweepKind => (SWEEP_KINDS as readonly string[]).includes(k);

/** What a key the fresh plan no longer has came to: "in use now" when the
 *  thing is still there, "gone" when it is not. A shell cannot be told
 *  either way while tmux does not answer. */
function missing(key: string, facts: PlanInputs): SweepOutcome {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (at < 0 || !isKind(kind)) return { key, result: "gone" };
  const run = (): Run | undefined => facts.runs.find((r) => r.id === id);
  let there: boolean;
  switch (kind) {
    case "shell":
      if (facts.shells === null) return { key, result: "failed", why: "tmux did not answer, so the shell could not be checked" };
      there = facts.shells.some((s) => s.id === id);
      break;
    case "chat": {
      // a chat that has ended since is gone as a chat
      const r = run();
      there = r !== undefined && !ENDED.has(r.status);
      break;
    }
    case "run":
      there = run() !== undefined;
      break;
    case "outside":
      there = facts.outside.some((c) => c.id === id);
      break;
    default:
      there = false;
  }
  return { key, result: there ? "in use now" : "gone" };
}
