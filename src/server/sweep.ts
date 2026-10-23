/** The sweep's server half (docs/superpowers/specs/2026-10-22-sweep-design.md):
 *  the plan built from live state, the close of a picked subset, its routes
 *  and the `sweep` event. The rules are `core/sweep.ts`; what it keeps on
 *  disk (the swept chats, the log) is `core/sweepstore.ts`.
 *
 *  Closes run one at a time through one queue, and each item is planned
 *  again from fresh facts just before it is closed, so a shell typed into
 *  since the preview is left alone ("in use now") and a second device
 *  pressing close on the same items finds them "gone".
 *
 *  The schedule: `tick` runs once a minute (from `start`, never under
 *  `bun test`) and fires when the cron's next time after the last fire has
 *  come, so a fire missed while the server was down runs once at start. A
 *  fire closes what it may close on its own and keeps the rest that is
 *  closable as the pending ask, which Eric answers or dismisses. */

import { nextFire, parseCron } from "../core/cron";
import { loadConfig, setSweep } from "../core/store";
import { patchSweep, planSweep, type PlanInputs } from "../core/sweep";
import { addSweptChat, appendLog, readAsk, readLastFire, readLog, readSweptChats, takeSweptChat, writeAsk, writeLastFire } from "../core/sweepstore";
import { SWEEP_KINDS, type KeptShell, type Run, type ServerEvent, type SweepInfo, type SweepItem, type SweepKind, type SweepLogEntry, type SweepOutcome, type SweepSettings, type SweptChat } from "../core/types";

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

/** how often the schedule looks at its cron */
const TICK_MS = 60_000;

/** Whether the schedule may close an item with no one looking: its kind is
 *  one Eric let close on its own, and the plan ticks it and may close it.
 *  A shell running a program in the foreground is never one. */
const autoCloses = (item: SweepItem, settings: SweepSettings): boolean => settings.auto.includes(item.kind) && item.auto && item.checked && item.closable;

export class SweepHub {
  /** closes and resumes, one at a time */
  private serial: Promise<unknown> = Promise.resolve();
  /** settings changes, one at a time, so two saves in flight never lose one */
  private patching: Promise<unknown> = Promise.resolve();
  /** keys this hub closed that the facts still show: a chat's stop ends it
   *  only once its process exits, and until then it still reads as idle */
  private closed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** a tick under way, so a slow fire is never run twice over */
  private ticking = false;

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

  /** Runs a fire missed while the server was down, then looks at the cron
   *  once a minute; the timer stays off under `bun test`, whose tests call
   *  `tick` themselves. */
  async start(): Promise<void> {
    // a catch-up that fails is logged, and the timer still starts: one bad
    // read at boot must not leave the schedule off until the next restart
    await this.tick(this.now()).catch((err) => console.error("canopy: sweep: the schedule:", errText(err)));
    if (process.env["NODE_ENV"] === "test" || this.timer) return;
    this.timer = setInterval(() => {
      this.tick(this.now()).catch((err) => console.error("canopy: sweep: the schedule:", errText(err)));
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Fires the schedule when it is on, its cron reads and the cron's next
   * time after the last fire has come. Only one fire for any number of
   * missed times. With no fire on record, or one in the future, the count
   * starts now. The fire's time is written before it runs, so a crash in
   * the middle never fires it again.
   */
  async tick(now: number): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = await this.settings();
      if (!settings.on) return;
      const cron = parseCron(settings.cron);
      if ("error" in cron) return;
      const last = await readLastFire();
      // with no fire on record, or one in the future (a clock set back, a
      // hand edit), the count starts now; a future one left in place would
      // keep every slot until it from firing
      if (last === null || last > now) {
        await writeLastFire(now);
        return;
      }
      const due = nextFire(cron, last);
      if (due === null || due > now) return;
      await writeLastFire(now);
      await this.fire();
    } finally {
      this.ticking = false;
    }
  }

  /** Closes what the schedule may close and holds the closable rest as the
   *  ask, replacing any ask not yet answered. One log entry, even for a
   *  fire that found nothing. */
  private fire(): Promise<void> {
    return this.queue(async () => {
      // read again on the queue: a close ahead of this fire may have taken
      // long enough for Eric to switch the schedule off or change its kinds
      const settings = await this.settings();
      if (!settings.on) return;
      const items = this.plan(await this.deps.facts(), settings);
      // a draft PR joins neither the close nor the ask once PRs are swept (Task 10)
      const auto = items.filter((i) => autoCloses(i, settings)).map((i) => i.key);
      const rest = items.filter((i) => i.closable && !auto.includes(i.key));
      if (auto.length > 0) await this.closeKeys(auto, "schedule");
      else await this.log({ at: this.now(), by: "schedule", outcomes: [], items: [] });
      await writeAsk(rest);
      await this.publish();
    });
  }

  async info(): Promise<SweepInfo> {
    const [facts, settings, log, shells, chats, ask] = await Promise.all([this.deps.facts(), this.settings(), readLog(), this.deps.keptSwept(), readSweptChats(), readAsk()]);
    const items = this.plan(facts, settings);
    // the ask's keys as the plan has them now, so a shell that has started a
    // program since reads unticked; what has closed or come back into use drops out
    const still = ask ? items.filter((i) => ask.some((a) => a.key === i.key)) : [];
    return {
      items,
      settings,
      lastRun: log.at(-1) ?? null,
      swept: { shells, chats },
      ask: still.length > 0 ? still : null,
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
      const outcomes = await this.closeKeys(keys, by);
      if (outcomes.length > 0) await this.publish();
      return outcomes;
    });
  }

  /** `close` without the queue or the event, for callers already on the
   *  queue. The schedule closes a key only when the fresh plan still lets
   *  it close on its own, and an answer to the ask (`ticked`) only when the
   *  fresh plan ticks it: a shell that has started a program since is
   *  "in use now" to both. */
  private async closeKeys(keys: string[], by: "eric" | "schedule", ticked = false): Promise<SweepOutcome[]> {
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
      if ((by === "schedule" && !autoCloses(item, settings)) || (ticked && !item.checked)) {
        outcomes.push({ key, result: "in use now" });
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
    await this.log({ at: this.now(), by, outcomes, items });
    return outcomes;
  }

  private async log(entry: SweepLogEntry): Promise<void> {
    try {
      await appendLog(entry);
    } catch (err) {
      console.error("canopy: sweep: the log could not be written:", errText(err));
    }
  }

  /** Answers the ask: closes those of its keys named, each after a recheck
   *  as any close and only while the fresh plan still ticks it (else "in use
   *  now"), and clears it. 404 with no ask, 400 for a key it does not hold. */
  answer(keys: string[]): Promise<SweepOutcome[]> {
    return this.queue(async () => {
      const ask = await readAsk();
      if (!ask) throw new SweepError(404, "there is no pending ask");
      const stray = keys.find((k) => !ask.some((i) => i.key === k));
      if (stray !== undefined) throw new SweepError(400, `${stray} is not in the ask`);
      await writeAsk(null);
      const outcomes = await this.closeKeys(keys, "eric", true);
      await this.publish();
      return outcomes;
    });
  }

  /** Drops the ask, closing nothing. */
  dismiss(): Promise<void> {
    return this.queue(async () => {
      await writeAsk(null);
      await this.publish();
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
      const cur = await this.settings();
      const next = patchSweep(cur, body);
      if (typeof next === "string") throw new SweepError(400, next);
      // a schedule turned on or moved counts from now, so an old last fire
      // does not set it off the minute Eric touches it; written first, so a
      // tick between the two writes never sees the new setting with the old fire
      if (next.on && (!cur.on || next.cron !== cur.cron)) await writeLastFire(this.now());
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
      if (path === "/api/sweep/ask" && method === "POST") {
        const b = await body();
        const keys = isRecord(b) ? b["keys"] : undefined;
        if (!Array.isArray(keys) || !keys.every((k): k is string => typeof k === "string")) return json({ error: "keys is a list of item keys" }, 400);
        return json({ outcomes: await this.answer(keys) });
      }
      if (path === "/api/sweep/ask" && method === "DELETE") {
        await this.dismiss();
        return json({ ok: true });
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
