/** The coordinator's server half (FR-010): the cards a coordinate run
 *  proposes, start these, the queue that starts them as branch runs three
 *  at a time, and the notes a settled child sends back into the chat. The
 *  model is `core/coordinator.ts`; the children are the landing queue's and
 *  the PR watch's like any branch run.
 *
 *  The cards live on the coordinator's own run (`Run.tasks`), the runner's
 *  live object, so they go out with every run change and die with the run,
 *  like the rest of it. The notes waiting for an idle turn live here. */

import { childSettled, nextToStart, settleNote, startNote, validatePlan, type ChildBranch } from "../core/coordinator";
import { isFlowActive, isRunActive, type CoordTask, type Flow, type Run } from "../core/types";
import type { Caller } from "./callers";

/** how long a ready child's card waits for the landing queue to sort or
 *  take its branch before it settles as ready anyway */
export const READY_WAIT = 2 * 60_000;
/** the largest body read; a full plan is 8 notes of 4000 characters */
export const MAX_BODY = 256 * 1024;

export class CoordError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** What starting a card came to: its child run, or the repo's branch slots are full. */
export type ChildStart = { run: Run } | { busy: string };

export interface CoordinatorDeps {
  run: (id: string) => Run | undefined;
  runs: () => Run[];
  /** starts a card as a branch run with `parent` set to the coordinator and
   *  `by` coordinator; throws when it cannot start at all */
  startChild: (coordId: string, task: CoordTask) => Promise<ChildStart>;
  /** the next user message into a chat (`Runner.say`); throws when it is not idle */
  say: (runId: string, text: string) => void;
  /** whether the repo has no branch slot free */
  repoFull: (repo: string) => boolean;
  /** where a repo id is: on this machine, elsewhere, or not known */
  known: (repo: string) => "local" | "remote" | null;
  /** what the landing queue and the PR watch know of a child's branch */
  landing: (run: Run) => ChildBranch;
  /** a coordinator's cards changed: send its run out again */
  broadcast: (run: Run) => void;
  now?: () => number;
  readyWait?: number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);
const slotWord = (repo: string): string => `waiting for a branch slot in ${repo}`;

/** a card with its outcome set, or taken off when `outcome` is undefined */
function withOutcome(t: CoordTask, outcome: string | undefined): CoordTask {
  const { outcome: _o, ...rest } = t;
  return outcome === undefined ? rest : { ...rest, outcome };
}

export class CoordinatorHub {
  /** the settle notes waiting for each coordinator's next idle turn, oldest first */
  private notes = new Map<string, string[]>();
  /** the highest card number each coordinator has given out, so a removed
   *  card's number is never given again */
  private numbers = new Map<string, number>();
  /** a recheck waiting for a ready child's `readyWait` to pass, by child id */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** every pump runs here, one after another, so two run ends never start
   *  more than three children between them */
  private serial: Promise<void> = Promise.resolve();

  constructor(private deps: CoordinatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    const p = this.serial.then(fn);
    this.serial = p.catch((err: unknown) => console.error(`coordinator: ${errText(err)}`));
    return this.serial;
  }

  /** Resolves once every pump asked for so far is done and the notes it
   *  queued have had their turn. */
  async idle(): Promise<void> {
    await this.serial;
    await new Promise((r) => setTimeout(r, 0));
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** how many ready children's waits have a timer set */
  waiting(): number {
    return this.timers.size;
  }

  /* ---------- the cards ---------- */

  /** The coordinator a request names. A coordinator's own token names its
   *  own run or none (its run is then the one meant); any other caller may
   *  name any coordinator that is still going. */
  private coordinator(id: unknown, caller: Caller | null): Run {
    let want = id;
    if (caller?.kind === "coordinator") {
      want ??= caller.run;
      if (!caller.run || want !== caller.run) throw new CoordError("a coordinator's token plans for its own run only", 403);
    }
    if (typeof want !== "string" || !want) throw new CoordError("missing run", 400);
    const run = this.deps.run(want);
    if (!run) throw new CoordError(`no run ${want}`, 404);
    if (run.action !== "coordinate") throw new CoordError(`${want} is not a coordinator`);
    if (!isRunActive(run)) throw new CoordError(`coordinator ${want} has ended`);
    return run;
  }

  private setTasks(coord: Run, tasks: CoordTask[]): void {
    coord.tasks = tasks;
    this.deps.broadcast(coord);
  }

  /** Changes one card on a coordinator, wherever its list stands now. */
  private update(coordId: string, taskId: string, fn: (t: CoordTask) => CoordTask): void {
    const coord = this.deps.run(coordId);
    const tasks = coord?.tasks;
    if (!coord || !tasks) return;
    let changed = false;
    const next = tasks.map((t) => {
      if (t.id !== taskId) return t;
      const u = fn(t);
      if (JSON.stringify(u) !== JSON.stringify(t)) changed = true;
      return u;
    });
    if (changed) this.setTasks(coord, next);
  }

  /** `POST /api/coordinator/plan {run, tasks}`: the coordinator's proposal,
   *  added as `proposed` cards numbered t1, t2, ... per coordinator. */
  plan(caller: Caller | null, b: Record<string, unknown>): { ok: true; added: CoordTask[] } {
    const coord = this.coordinator(b["run"], caller);
    const have = coord.tasks ?? [];
    const got = validatePlan(b["tasks"], { known: this.deps.known, have: have.length });
    if ("error" in got) throw new CoordError(got.error, 400);
    let last = Math.max(this.numbers.get(coord.id) ?? 0, ...have.map((t) => Number(t.id.slice(1)) || 0));
    const added = got.tasks.map((t): CoordTask => ({ id: `t${++last}`, ...t, state: "proposed" }));
    this.numbers.set(coord.id, last);
    this.setTasks(coord, [...have, ...added]);
    return { ok: true, added };
  }

  /** `POST /api/coordinator/tasks {run, id, title?, note?, repo?, action?,
   *  remove?}`: edits or removes a card that has not started, under the
   *  plan's limits. */
  edit(caller: Caller | null, b: Record<string, unknown>): { ok: true; task: CoordTask } | { ok: true; removed: string } {
    if (caller?.kind === "coordinator") throw new CoordError("a coordinator proposes; changing a card is Eric's", 403);
    const coord = this.coordinator(b["run"], caller);
    const id = b["id"];
    if (typeof id !== "string" || !id) throw new CoordError("missing card id", 400);
    const tasks = coord.tasks ?? [];
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new CoordError(`no card ${id}`, 404);
    if (t.state !== "proposed") throw new CoordError(`${id} is ${t.state}; only a proposed card changes`);
    if (b["remove"] === true) {
      this.setTasks(
        coord,
        tasks.filter((x) => x.id !== id),
      );
      return { ok: true, removed: id };
    }
    const merged = { title: b["title"] ?? t.title, note: b["note"] ?? t.note, repo: b["repo"] ?? t.repo, action: b["action"] ?? t.action };
    const got = validatePlan([merged], { known: this.deps.known, have: 0 });
    if ("error" in got) throw new CoordError(got.error.replace(/^tasks\[0\]/, id), 400);
    const [fields] = got.tasks;
    if (!fields) throw new CoordError("the card did not check out", 400);
    const task: CoordTask = { ...t, ...fields };
    this.setTasks(
      coord,
      tasks.map((x) => (x.id === id ? task : x)),
    );
    return { ok: true, task };
  }

  /** `POST /api/coordinator/start {run}`: start these. Every proposed card
   *  is queued, and as many start as the cap and the repos' slots allow. */
  async begin(caller: Caller | null, b: Record<string, unknown>): Promise<{ ok: true; tasks: CoordTask[] }> {
    if (caller?.kind === "coordinator") throw new CoordError("a coordinator proposes; starting its cards is Eric's", 403);
    const coord = this.coordinator(b["run"], caller);
    const tasks = coord.tasks ?? [];
    if (!tasks.some((t) => t.state === "proposed")) throw new CoordError("no proposed cards to start");
    this.setTasks(
      coord,
      tasks.map((t) => (t.state === "proposed" ? { ...t, state: "queued" } : t)),
    );
    await this.pump(coord.id);
    return { ok: true, tasks: this.deps.run(coord.id)?.tasks ?? [] };
  }

  /* ---------- the queue ---------- */

  /** children still working: a card whose child ended but waits on the
   *  landing queue holds no slot */
  private working(coord: Run): number {
    return (coord.tasks ?? []).filter((t) => {
      if (t.state !== "running" || !t.run) return false;
      const r = this.deps.run(t.run);
      return r !== undefined && isRunActive(r);
    }).length;
  }

  /** Starts the coordinator's queued cards, one at a time, while fewer than
   *  three of its children work and their repos have a slot. A card whose
   *  repo is full stays queued and says so; a start that throws fails its
   *  card and queues a note saying why. */
  pump(coordId: string): Promise<void> {
    return this.queue(async () => {
      const passed = new Set<string>();
      for (;;) {
        const coord = this.deps.run(coordId);
        if (!coord || !isRunActive(coord)) return;
        const tasks = coord.tasks ?? [];
        for (const t of tasks) {
          if (t.state === "queued") this.update(coordId, t.id, (x) => withOutcome(x, passed.has(x.id) || this.deps.repoFull(x.repo) ? slotWord(x.repo) : undefined));
        }
        const [next] = nextToStart(
          tasks.filter((t) => !passed.has(t.id)),
          { working: this.working(coord), repoFull: this.deps.repoFull },
        );
        if (!next) return;
        let out: ChildStart;
        try {
          out = await this.deps.startChild(coordId, next);
        } catch (err) {
          this.update(coordId, next.id, (x) => withOutcome({ ...x, state: "failed" }, errText(err)));
          this.queueNote(coordId, startNote(next, errText(err)));
          continue;
        }
        if ("busy" in out) {
          passed.add(next.id);
          this.update(coordId, next.id, (x) => withOutcome(x, slotWord(x.repo)));
          continue;
        }
        const child = out.run;
        this.update(coordId, next.id, (x) => withOutcome({ ...x, state: "running", run: child.id }, undefined));
        // a child can end inside its own start, before its card knew its id
        this.follow(child);
      }
    });
  }

  /** Pumps every coordinator still going with a card queued: any branch
   *  run's end, a child's or anyone's, may free a slot one waits for. */
  private pumpAll(): void {
    for (const r of this.deps.runs()) {
      if (r.action === "coordinate" && isRunActive(r) && r.tasks?.some((t) => t.state === "queued")) void this.pump(r.id);
    }
  }

  /* ---------- children ---------- */

  /** A child moved: its card settles when it has (see `childSettled`). */
  private follow(child: Run): void {
    if (!child.parent) return;
    const coord = this.deps.run(child.parent);
    const task = coord?.tasks?.find((t) => t.run === child.id);
    if (!coord || !task || task.state !== "running") return;
    this.settle(coord, task, child);
  }

  /** When a child counts as settled is `childSettled`'s rule: at once for a
   *  child that failed, stopped, or left its branch uncommitted or empty;
   *  for a ready branch, when the landing queue lands it or sends it back,
   *  a PR opens for it, or the sort leaves it to Eric. A ready branch that
   *  none of those reach within `readyWait` settles as ready. The card
   *  takes the state and outcome, and while the coordinator is going a
   *  note waits for its next idle turn.
   *
   *  A timer waits only for `readyWait` to pass. A child still unsettled
   *  after that has an entry in the queue, which can take any time, so it
   *  waits on the landing and PR broadcasts' `recheck` and sets none. */
  private settle(coord: Run, task: CoordTask, child: Run): void {
    if (isRunActive(child)) return;
    const branch = this.deps.landing(child);
    const ended = child.endedAt ?? this.now();
    const wait = this.deps.readyWait ?? READY_WAIT;
    const left = ended + wait - this.now();
    const got = childSettled(child, branch, left <= 0);
    if (!got) {
      if (left > 0) this.later(child.id, left);
      else this.cancel(child.id);
      return;
    }
    this.cancel(child.id);
    this.update(coord.id, task.id, (x) => withOutcome({ ...x, state: got.state }, got.outcome));
    this.queueNote(coord.id, settleNote(task, child, branch));
  }

  /** Every card waiting on a child that ended is looked at again: the
   *  landing queue or the PR watch moved, or a ready child's wait ran out. */
  recheck(): void {
    for (const coord of this.deps.runs()) {
      if (coord.action !== "coordinate") continue;
      for (const t of coord.tasks ?? []) {
        if (t.state !== "running" || !t.run) continue;
        const child = this.deps.run(t.run);
        if (child) this.settle(coord, t, child);
        else this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: "failed" }, "its run is no longer kept"));
      }
    }
  }

  private later(childId: string, ms: number): void {
    if (this.timers.has(childId)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(childId);
        this.recheck();
      },
      ms + 50,
    );
    timer.unref?.();
    this.timers.set(childId, timer);
  }

  private cancel(childId: string): void {
    const t = this.timers.get(childId);
    if (t) clearTimeout(t);
    this.timers.delete(childId);
  }

  /* ---------- notes ---------- */

  /** A note for the coordinator's chat, said on its next idle turn; nothing
   *  once it has ended. */
  private queueNote(coordId: string, text: string): void {
    const coord = this.deps.run(coordId);
    if (!coord || !isRunActive(coord)) return;
    const list = this.notes.get(coordId) ?? [];
    list.push(text);
    this.notes.set(coordId, list);
    this.flushSoon(coordId);
  }

  /** Says the oldest waiting note when the coordinator is idle. It runs
   *  after the change that called it has reached every listener, since
   *  saying moves the run under them. */
  private flushSoon(coordId: string): void {
    queueMicrotask(() => {
      const coord = this.deps.run(coordId);
      if (!coord || !isRunActive(coord)) {
        this.notes.delete(coordId);
        return;
      }
      if (coord.status !== "idle") return;
      const list = this.notes.get(coordId);
      const text = list?.shift();
      if (!list || text === undefined) return;
      try {
        this.deps.say(coordId, text);
      } catch {
        // it was not idle after all; the note waits for the next turn
        list.unshift(text);
      }
      if (!list.length) this.notes.delete(coordId);
    });
  }

  /** The coordinator ended: its cards that never started are dropped and its
   *  waiting notes go. Its children go on as branch runs of their own. */
  private end(coord: Run): void {
    this.notes.delete(coord.id);
    const tasks = coord.tasks ?? [];
    // its children's cards still settle on the broadcasts' recheck, with
    // nothing said, so no timer need outlive it
    for (const t of tasks) if (t.run) this.cancel(t.run);
    if (!tasks.some((t) => t.state === "proposed" || t.state === "queued")) return;
    this.setTasks(
      coord,
      tasks.map((t) => (t.state === "proposed" || t.state === "queued" ? withOutcome({ ...t, state: "dropped" }, undefined) : t)),
    );
  }

  /** The Runner's every change. */
  onRun(run: Run): void {
    if (run.parent) this.follow(run);
    if (run.action === "coordinate") {
      if (!isRunActive(run)) this.end(run);
      else if (run.status === "idle" && this.notes.has(run.id)) this.flushSoon(run.id);
    }
    if (!isRunActive(run)) this.pumpAll();
  }

  /** The flows' every change: a branch flow holds one of its repo's branch
   *  slots from its start to its end, so its end may free one a card waits
   *  for. */
  onFlow(flow: Pick<Flow, "status"> & { branch?: object }): void {
    if (flow.branch && !isFlowActive(flow)) this.pumpAll();
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL, caller: Caller | null): Promise<Response | null> {
    const path = url.pathname.replace(/\/+$/, "");
    if (req.method !== "POST" || !path.startsWith("/api/coordinator/")) return null;
    const act = path.slice("/api/coordinator/".length);
    if (act !== "plan" && act !== "tasks" && act !== "start") return null;
    try {
      if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) return json({ error: "body too large" }, 413);
      const text = await req.text();
      if (text.length > MAX_BODY) return json({ error: "body too large" }, 413);
      let b: unknown = null;
      try {
        b = JSON.parse(text);
      } catch {
        // answered below
      }
      if (!isRecord(b)) return json({ error: "the body must be a JSON object" }, 400);
      if (act === "plan") return json(this.plan(caller, b));
      if (act === "tasks") return json(this.edit(caller, b));
      return json(await this.begin(caller, b));
    } catch (err) {
      return json({ error: errText(err) }, err instanceof CoordError ? err.status : 500);
    }
  }
}
