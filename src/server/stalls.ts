/** The stall watchdog's server half (FR-035, plan 3). Every `STALL_EVERY`
 *  the hub runs the Runner's pass (`Runner.watchdog`), which tells a quiet
 *  job to wrap up and stops one quiet again. For each run it stopped, the
 *  hub decides what follows, at once, before the run's end is heard:
 *
 *  - a branch run on its first stall, with a Claude session, is resumed
 *    once through `startBranchFix` with `stallResumeMessage`, after its end
 *    is read, and whatever followed it (the trigger event, the PR watch's
 *    fix) follows the resumed run;
 *  - a second stall on the same branch, a run with no Claude session, or a
 *    resume that would not start is left for Eric (`stalledWhy`);
 *  - a flow's step, and a job in the checkout, are only stopped: a flow is
 *    picked up by hand, and a checkout job has no branch to carry on.
 *
 *  The count is the branch's landing record's `stalls`, so it holds across
 *  every run on the branch, its PR's fix runs included. */

import { STALL_AFTER, STALL_EVERY, STALLS_RESUMED, stallResumeMessage, stalledWhy } from "../core/stall";
import type { LandingRun, Run } from "../core/types";

export interface StallDeps {
  /** the Runner's pass; the runs it stopped */
  watchdog: (now: number, after: number) => Run[];
  /** settles once the run has ended and its end is read; null for a run the runner never had */
  ended: (id: string) => Promise<void> | null;
  /** the branch's landing record, by its id */
  record: (origin: string) => LandingRun | undefined;
  /** counts one stall on the branch's record; the count so far */
  countStall: (origin: string) => number;
  /** starts the run that resumes the branch's session with this message */
  resume: (rec: LandingRun, message: string) => Promise<Run>;
  /** the stalled run `from` is resumed as `to`: what followed `from` follows `to` */
  carried: (from: Run, to: Run) => void;
  /** the stalled run is left for Eric, with why */
  left: (run: Run, why: string) => void;
  now?: () => number;
  /** how long a run may be quiet; tests shorten it */
  after?: number;
  every?: number;
}

/** What follows one stalled run. */
type Plan = { kind: "resume"; rec: LandingRun } | { kind: "leave"; why: string } | { kind: "none" };

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

export class StallHub {
  /** a stalled run → the run that resumed it, or null while that run starts */
  private carry = new Map<string, string | null>();
  /** the resumes and leaves going now, for `idle` */
  private pending = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: StallDeps) {}

  private get after(): number {
    return this.deps.after ?? STALL_AFTER;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.every ?? STALL_EVERY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once every resume and leave started so far is done. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  /** One pass: the Runner's, then what follows each run it stopped. The
   *  plan is made here, before any await, so a resume is known as starting
   *  (`starting`) before the stopped run's end reaches anyone. */
  tick(): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const run of this.deps.watchdog(now, this.after)) {
      const plan = this.plan(run);
      if (plan.kind === "none") continue;
      if (plan.kind === "resume") this.carry.set(run.id, null);
      const p = (plan.kind === "resume" ? this.resume(run, plan.rec) : this.leave(run, plan.why)).catch((err) => console.error(`stalls: ${errText(err)}`));
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
  }

  /** Whether a run the watchdog stopped is being resumed and its resumed
   *  run has not started yet: it counts as going meanwhile, so the PR watch
   *  and the landing queue leave its branch alone. */
  starting(id: string): boolean {
    return this.carry.get(id) === null;
  }

  /** The run that carries `id` on: the run a stall resumed it as, followed
   *  to the newest, else `id` itself. */
  latest(id: string): string {
    let at = id;
    for (let i = 0; i < 16; i++) {
      const next = this.carry.get(at);
      if (!next) return at;
      at = next;
    }
    return at;
  }

  private plan(run: Run): Plan {
    const b = run.branch;
    // a flow's step stops its flow, which is picked up by hand; a job in
    // the checkout has no branch to carry on
    if (!b || run.flowStep || b.held) return { kind: "none" };
    const rec = this.deps.record(b.origin);
    if (!rec) return { kind: "none" };
    const count = this.deps.countStall(b.origin);
    if (count > STALLS_RESUMED) return { kind: "leave", why: stalledWhy("again") };
    if (run.harness !== "claude" || !run.session) return { kind: "leave", why: stalledWhy("no-session") };
    return { kind: "resume", rec };
  }

  private async resume(run: Run, rec: LandingRun): Promise<void> {
    await this.deps.ended(run.id);
    let to: Run;
    try {
      to = await this.deps.resume(this.deps.record(rec.id) ?? rec, stallResumeMessage(this.after));
    } catch (err) {
      this.carry.delete(run.id);
      this.deps.left(run, stalledWhy("not-resumed", errText(err)));
      return;
    }
    this.carry.set(run.id, to.id);
    this.deps.carried(run, to);
  }

  private async leave(run: Run, why: string): Promise<void> {
    await this.deps.ended(run.id);
    this.deps.left(run, why);
  }
}
