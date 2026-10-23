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
 *  come, so the slots a sleeping Mac missed fire once, within a minute of
 *  waking. A fire closes what it may close on its own and keeps the rest a
 *  close may take unticked (`mayClose`) as the pending ask, which Eric
 *  answers or dismisses. */

import { nextFire, parseCron } from "../core/cron";
import { loadConfig, setSweep } from "../core/store";
import { mayClose, patchSweep, planSweep, spanDays, sweepComment, type PlanInputs } from "../core/sweep";
import { addSweptChat, appendLog, readAsk, readLastFire, readLog, readSweptChats, takeSweptChat, writeAsk, writeLastFire } from "../core/sweepstore";
import { SWEEP_KINDS, type AuthoredPr, type KeptShell, type PrNow, type Run, type ServerEvent, type SweepInfo, type SweepItem, type SweepKind, type SweepLogEntry, type SweepOutcome, type SweepSettings, type SweptChat } from "../core/types";

export interface SweepDeps {
  broadcast(ev: ServerEvent): void;
  /** the shells, runs and cards as they are now; the hub adds the PRs */
  facts(): Promise<Omit<PlanInputs, "prs">>;
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
  /** the open PRs the gh login authored (`AUTHORED_QUERY`); throws when
   *  gh cannot list them */
  authoredPrs(): Promise<AuthoredPr[]>;
  /** one PR as GitHub has it now; throws gh's last line when gh could not say */
  prState(slug: string, number: number): Promise<PrNow>;
  /** closes a PR with the comment and keeps its branch; throws gh's last line */
  closePr(pr: AuthoredPr, comment: string): Promise<void>;
  /** whether this backend holds its flows lock, which sweeping PRs needs
   *  besides the `prs` setting */
  holdsFlowsLock(): boolean;
  now?: () => number;
  /** the settings' read and write, in place of the config's; tests */
  loadSettings?: () => Promise<SweepSettings>;
  saveSettings?: (s: SweepSettings) => Promise<void>;
  /** arms the minute timer under `bun test` too; tests of `start` */
  timer?: boolean;
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
/** how long the authored-PR list is kept: a sweep event has every open
 *  page read the plan at once, and each read would be a GraphQL query */
const PR_LIST_MS = 60_000;

const prId = (pr: AuthoredPr): string => `${pr.slug}#${pr.number}`;

/** Whether the schedule may close an item with no one looking: its kind is
 *  one Eric let close on its own, and the plan lets a close he did not
 *  tick take it (`mayClose`). A shell running a program in the foreground
 *  is never one. */
const autoCloses = (item: SweepItem, settings: SweepSettings): boolean => settings.auto.includes(item.kind) && mayClose(item);

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
  /** set by `stop`, so a `start` whose catch-up outlives it stays stopped */
  private stopped = false;
  /** the authored-PR list and when it was asked for; the promise, so
   *  reads that arrive together share one query */
  private prList: { at: number; list: Promise<AuthoredPr[] | null> } | null = null;

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

  /** Whether this backend sweeps PRs: its `prs` setting is on and it holds
   *  its flows lock. The lock is per config dir, so it keeps two servers on
   *  one dir apart but not the Mac and the mini; the setting, meant to be
   *  on for one backend, does that. */
  private sweepsPrs(settings: SweepSettings): boolean {
    return settings.prs && this.deps.holdsFlowsLock();
  }

  /** The authored PRs, from the list kept for `PR_LIST_MS`. A backend that
   *  does not sweep PRs plans none and never asks. A list gh could not
   *  give is null, kept as long: no news about the PRs, as tmux not
   *  answering is about the shells, so the rest of the plan still reads. */
  private authored(settings: SweepSettings): Promise<AuthoredPr[] | null> {
    if (!this.sweepsPrs(settings)) return Promise.resolve([]);
    const now = this.now();
    if (this.prList && now - this.prList.at < PR_LIST_MS) return this.prList.list;
    const list = this.deps.authoredPrs().catch((err) => {
      console.error("canopy: sweep: the authored PRs could not be listed:", errText(err));
      return null;
    });
    this.prList = { at: now, list };
    return list;
  }

  /** the facts with the authored PRs, from `prs` when the caller has
   *  them; `prsDown` when there is no list (GitHub did not give one, or the
   *  caller did not read it), planned as none */
  private async facts(settings: SweepSettings, prs?: AuthoredPr[] | null): Promise<Facts> {
    const [facts, list] = await Promise.all([this.deps.facts(), prs === undefined ? this.authored(settings) : prs]);
    return { ...facts, prs: list ?? [], prsDown: list === null };
  }

  /** The plan less what this hub has closed already. A closed key the plan
   *  no longer has is let go of: whatever it was has ended. A PR key stays
   *  while there is no PR list, which says nothing about it. */
  private plan(facts: Facts, settings: SweepSettings): SweepItem[] {
    const items = planSweep(facts, settings, this.now());
    for (const k of this.closed) if (!items.some((i) => i.key === k) && !(facts.prsDown && k.startsWith("pr:"))) this.closed.delete(k);
    return items.filter((i) => !this.closed.has(i.key));
  }

  /** Arms the minute timer, then runs a catch-up tick at once. The timer
   *  goes first, so a catch-up that hangs (tmux not answering) never
   *  leaves the schedule off until the next restart; `ticking` keeps the
   *  two from overlapping. The timer stays off under `bun test`, whose
   *  tests call `tick` themselves. */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.timer && (process.env["NODE_ENV"] !== "test" || this.deps.timer)) {
      this.timer = setInterval(() => {
        this.tick(this.now()).catch((err) => console.error("canopy: sweep: the schedule:", errText(err)));
      }, TICK_MS);
    }
    // a catch-up that fails is logged; the timer is already set
    await this.tick(this.now()).catch((err) => console.error("canopy: sweep: the schedule:", errText(err)));
    // a stop while the catch-up ran stays a stop
    if (this.stopped) this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** whether the minute timer is set */
  get armed(): boolean {
    return this.timer !== null;
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

  /** Closes what the schedule may close and holds the rest a close may
   *  take unticked as the ask, replacing any ask not yet answered. One log
   *  entry, even for a fire that found nothing. */
  private fire(): Promise<void> {
    return this.queue(async () => {
      // read again on the queue: a close ahead of this fire may have taken
      // long enough for Eric to switch the schedule off or change its kinds
      const settings = await this.settings();
      if (!settings.on) return;
      const facts = await this.facts(settings);
      const items = this.plan(facts, settings);
      // a draft PR is handOnly, so it joins neither the close nor the ask
      const auto = items.filter((i) => autoCloses(i, settings)).map((i) => i.key);
      try {
        const outcomes = auto.length > 0 ? await this.closeKeys(auto, "schedule") : [];
        if (auto.length === 0) await this.log({ at: this.now(), by: "schedule", outcomes: [], items: [] });
        // switched off during the closes: the switch-off cleared the ask, and this fire writes none
        if (!(await this.settings()).on) return;
        // a busy shell is left for the sheet, out of the ask as well; a key
        // the schedule skipped because its kind left auto mid-fire is asked about
        const tried = new Set(outcomes.map((o) => o.key));
        const rest = items.filter((i) => mayClose(i) && !tried.has(i.key));
        // tmux not answering is no news about the shells, and GitHub not
        // listing is none about the PRs: the ask keeps the ones it held
        const kept = facts.shells === null || facts.prsDown ? ((await readAsk()) ?? []).filter((i) => (facts.shells === null && i.kind === "shell") || (facts.prsDown && i.kind === "pr")) : [];
        await this.keepAsk([...kept, ...rest]);
      } finally {
        this.publish();
      }
    });
  }

  /** writes the ask, logging a failure as the log's own write does, so the
   *  event for closes already made still goes out */
  private async keepAsk(items: SweepItem[] | null): Promise<void> {
    try {
      await writeAsk(items);
    } catch (err) {
      console.error("canopy: sweep: the ask could not be written:", errText(err));
    }
  }

  /** Drops from the ask the keys the plan no longer has (closed, or gone),
   *  and the ask itself once none is left, so a restored shell that goes
   *  idle again under its old id is not in an ask Eric saw closed. A shell
   *  key stays while tmux does not answer. On the queue, never from a GET,
   *  so it cannot race a fire's write. */
  private async pruneAsk(): Promise<void> {
    try {
      const ask = await readAsk();
      if (!ask) return;
      const settings = await this.settings();
      const facts = await this.facts(settings);
      const items = this.plan(facts, settings);
      const left = ask.filter((a) => items.some((i) => i.key === a.key) || (facts.shells === null && a.kind === "shell") || (facts.prsDown && a.kind === "pr"));
      if (left.length < ask.length) await writeAsk(left);
    } catch (err) {
      console.error("canopy: sweep: the ask could not be pruned:", errText(err));
    }
  }

  async info(): Promise<SweepInfo> {
    const settings = await this.settings();
    const [facts, log, shells, chats, ask] = await Promise.all([this.facts(settings), readLog(), this.deps.keptSwept(), readSweptChats(), readAsk()]);
    const items = this.plan(facts, settings);
    // the ask's keys as the plan has them now: what has closed or come back
    // into use drops out, and so does a shell that has started a program
    // since, which only the sheet closes (its key stays stored, so it is
    // back in the ask if it goes idle at its prompt again). With the
    // schedule off there is no ask, even one a fire wrote as the switch-off
    // landed (settings saves and fires run on separate queues).
    const still = ask && settings.on ? items.filter((i) => mayClose(i) && ask.some((a) => a.key === i.key)) : [];
    return {
      items,
      settings,
      lastRun: log.at(-1) ?? null,
      swept: { shells, chats },
      ask: still.length > 0 ? still : null,
    };
  }

  /** tells every stream the sweep changed, and nothing more: the stream
   *  reaches callers without admin, so the page reads the plan itself */
  private publish(): void {
    this.deps.broadcast({ type: "sweep" });
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
      if (outcomes.length > 0) {
        await this.pruneAsk();
        this.publish();
      }
      return outcomes;
    });
  }

  /** `close` without the queue or the event, for callers already on the
   *  queue. The schedule closes a key only when the fresh plan still lets
   *  it close on its own, and an answer to the ask (`asked`) only when the
   *  fresh plan lets an unticked close take it (`mayClose`): a shell that
   *  has started a program since is "in use now" to both. The schedule
   *  reads the settings again before each key: once the schedule is off
   *  it stops, and a key whose kind has left the auto kinds is skipped;
   *  either way such keys get no outcome, since nothing looked at them.
   *  The authored PRs are listed once per call, not per key: each PR is
   *  read again on its own just before its close. */
  private async closeKeys(keys: string[], by: "eric" | "schedule", asked = false): Promise<SweepOutcome[]> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) return [];
    let settings = await this.settings();
    const outcomes: SweepOutcome[] = [];
    const items: SweepItem[] = [];
    // the list only when a PR is named; without it the plan has no news
    // about the PRs, so the keys of PRs closed before stay out of it
    const prs = wanted.some((k) => k.startsWith("pr:")) ? await this.authored(settings) : null;
    let closedPr = false;
    for (const key of wanted) {
      if (by === "schedule") {
        settings = await this.settings();
        if (!settings.on) break;
        if (!(settings.auto as readonly string[]).includes(key.slice(0, key.indexOf(":")))) continue;
      }
      if (key.startsWith("pr:") && !this.sweepsPrs(settings)) {
        outcomes.push({ key, result: "failed", why: "this backend does not sweep PRs: its sweep setting prs is off, or it does not hold its flows lock" });
        continue;
      }
      const facts = await this.facts(settings, prs);
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
      if ((by === "schedule" && !autoCloses(item, settings)) || (asked && !mayClose(item))) {
        outcomes.push({ key, result: "in use now" });
        continue;
      }
      try {
        const out = await this.closeOne(item, facts, settings);
        if (out.result === "closed") {
          this.closed.add(key);
          if (item.kind === "pr") closedPr = true;
        }
        outcomes.push(out);
      } catch (err) {
        outcomes.push({ key, result: "failed", why: errText(err) });
      }
    }
    // the list still has what was closed: the next plan asks GitHub again
    if (closedPr) this.prList = null;
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
   *  as any close and only while the fresh plan still lets an unticked
   *  close take it (else "in use now"), and clears it. 404 with no ask, 400 for a key it does not hold. */
  answer(keys: string[]): Promise<SweepOutcome[]> {
    return this.queue(async () => {
      const ask = await readAsk();
      if (!ask) throw new SweepError(404, "there is no pending ask");
      const stray = keys.find((k) => !ask.some((i) => i.key === k));
      if (stray !== undefined) throw new SweepError(400, `${stray} is not in the ask`);
      await writeAsk(null);
      const outcomes = await this.closeKeys(keys, "eric", true);
      this.publish();
      return outcomes;
    });
  }

  /** Drops the ask, closing nothing. */
  dismiss(): Promise<void> {
    return this.queue(async () => {
      await writeAsk(null);
      this.publish();
    });
  }

  private async closeOne(item: SweepItem, facts: Facts, settings: SweepSettings): Promise<SweepOutcome> {
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
      case "pr": {
        const pr = facts.prs.find((p) => prId(p) === id);
        if (!pr) return { key, result: "gone" };
        // the list may be a minute old: the PR as it is now. A throw is
        // gh's last line, and the catch around this makes it "failed"
        const now = await this.deps.prState(pr.slug, pr.number);
        if (now.state !== "OPEN") return { key, result: "gone" };
        // activity, auto-merge, or a move to draft since the list: someone is at it
        if (now.updatedAt > pr.updatedAt || now.autoMerge || (now.draft && !pr.draft)) return { key, result: "in use now" };
        await this.deps.closePr(pr, sweepComment(spanDays(settings.spans.pr)));
        return { key, result: "closed" };
      }
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
      this.publish();
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
      // a schedule switched off has no question pending
      if (cur.on && !next.on) await writeAsk(null);
      this.publish();
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

/** the plan's inputs, and whether GitHub failed to list the PRs */
type Facts = PlanInputs & { prsDown: boolean };

/** What a key the fresh plan no longer has came to: "in use now" when the
 *  thing is still there, "gone" when it is not. A shell cannot be told
 *  either way while tmux does not answer, nor a PR while GitHub does not list them. */
function missing(key: string, facts: Facts): SweepOutcome {
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
    case "pr":
      if (facts.prsDown) return { key, result: "failed", why: "GitHub did not list the PRs, so it could not be checked" };
      // still open but out of the plan: pushed to, set to auto-merge, or a fix started
      there = facts.prs.some((p) => prId(p) === id);
      break;
    default:
      there = false;
  }
  return { key, result: there ? "in use now" : "gone" };
}
