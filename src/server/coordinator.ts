/** The coordinator's server half (FR-010): the cards a coordinate run
 *  proposes, start these, the queue that starts them as branch runs three
 *  at a time, and the notes a settled child sends back into the chat. The
 *  model is `core/coordinator.ts`; the children are the landing queue's and
 *  the PR watch's like any branch run.
 *
 *  The cards live on the coordinator's own run (`Run.tasks`), the runner's
 *  live object, so they go out with every run change and die with the run,
 *  like the rest of it. The notes waiting for an idle turn live here. */

import { allows } from "../core/callers";
import { isCapacityWords, limitedWords } from "../core/capacity";
import {
  afterWait,
  blockedNote,
  cardLanded,
  childSettled,
  editCard,
  flowGoneNote,
  flowGoneSettled,
  flowNote,
  flowSettled,
  groupNeedsEric,
  groupNote,
  groupSettled,
  holdNote,
  landedNote,
  lateFailNote,
  laterOutcome,
  MAX_PLAN,
  MAY_LAND_LATER,
  nextToStart,
  settleNote,
  startNote,
  validatePlan,
  withCards,
  type ChildBranch,
  type PlanContext,
} from "../core/coordinator";
import type { RunGroup } from "../core/group";
import { isFlowActive, isRunActive, type CoordTask, type Flow, type HeldStart, type LoadoutsInfo, type Priority, type Run } from "../core/types";
import type { WorkSink, WorkState } from "../core/work";
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

/** What starting a card came to: its child run, the group a card with
 *  `times` started, the flow on a branch a card that names a workflow
 *  started, or the repo's branch slots are full. */
export type ChildStart = { run: Run } | { group: RunGroup } | { flow: Flow } | { busy: string };
/** What resuming a child came to: a child resumes alone, as a run. */
export type ChildResume = Exclude<ChildStart, { group: RunGroup } | { flow: Flow }>;

export interface CoordinatorDeps {
  run: (id: string) => Run | undefined;
  runs: () => Run[];
  /** starts a card as a branch run with `parent` set to the coordinator and
   *  `by` coordinator; throws when it cannot start at all. `priority` is
   *  normal unless a held card is released (FR-036); a start the governor
   *  holds answers busy with its words. */
  startChild: (coordId: string, task: CoordTask, priority?: Priority) => Promise<ChildStart>;
  /** resumes a child that ended `limited` on its own branch, its session
   *  carried on, as a new run with the same parent (FR-036) */
  resumeChild?: (coordId: string, task: CoordTask, child: Run, priority: Priority) => Promise<ChildResume>;
  /** the next user message into a chat (`Runner.say`); throws when it is not idle */
  say: (runId: string, text: string) => void;
  /** whether the repo has fewer than `need` branch slots free, one when absent */
  repoFull: (repo: string, need?: number) => boolean;
  /** the group a card started; absent on a backend with no groups */
  group?: (id: string) => RunGroup | undefined;
  /** where a repo id is: on this machine, elsewhere, or not known */
  known: (repo: string) => "local" | "remote" | null;
  /** what the landing queue and the PR watch know of a child's branch */
  landing: (run: Run) => ChildBranch;
  /** what the landing queue and the PR watch know of a branch by its origin, once its run is gone */
  branch?: (origin: string) => ChildBranch;
  /** a card's flow by its id, while the backend keeps it */
  flow?: (id: string) => Flow | undefined;
  /** kit.json's loadouts, which a card's `equip` names */
  loadouts: () => LoadoutsInfo;
  /** the workflows a card in this repo may name: bundled and user ones, and the repo's own when `withRepo` */
  workflows: (repo: string, withRepo: boolean) => Promise<{ name: string; fromRepo: boolean }[]>;
  /** a coordinator's cards changed: send its run out again */
  broadcast: (run: Run) => void;
  /** the work item's settle line; absent for pre-ledger cards */
  work?: WorkSink;
  /** a work item's state, which outlives the landing queue's pruned entry */
  workState?: (id: string) => WorkState | undefined;
  now?: () => number;
  readyWait?: number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);
const slotWord = (repo: string): string => `waiting for a branch slot in ${repo}`;
/** a held coordinator's queued card's outcome */
const HELD_WORD = "the goal is held";
/** the key a card's flow's ready wait is kept under, apart from a run's */
const flowKey = (id: string): string => `flow:${id}`;
/** a card's outcome that may still turn landed (`MAY_LAND_LATER`) */
const mayLandLater = (outcome: string | undefined): boolean => outcome !== undefined && (MAY_LAND_LATER as readonly string[]).includes(outcome);

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
  /** a recheck waiting for a ready child's `readyWait` to pass, by child id
   *  (`flowKey` for a card's flow) */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** every pump runs here, one after another, so two run ends never start
   *  more than three children between them */
  private serial: Promise<void> = Promise.resolve();
  /** cards "start anyway" let go once as interactive, `<coordinator>:<card>` */
  private released = new Set<string>();
  /** the cards a start with ids named, tried before the rest until each has
   *  started or left the queue, by coordinator */
  private first = new Map<string, string[]>();
  /** the words each queued card's blocked note said, `<coordinator>:<card>`,
   *  so the manager hears a card blocked once per reason */
  private blockedSaid = new Map<string, string>();
  /** cards whose start is in flight, `<coordinator>:<card>`: still queued,
   *  but neither edited nor removed, or the child would start with no card.
   *  A resume after the limit holds it too, so the card takes no other run
   *  on its branch meanwhile (`adopt`) and the resume's own run wins. */
  private starting = new Set<string>();

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
    if (!changed) return;
    this.setTasks(coord, next);
    // a card others wait for settled, landed or reopened: they may start now,
    // or the manager hears why they cannot
    const was = tasks.find((t) => t.id === taskId);
    const now = next.find((t) => t.id === taskId);
    const moved =
      was !== undefined &&
      now !== undefined &&
      (was.state !== now.state || (now.outcome === "landed" && was.outcome !== "landed") || groupNeedsEric(was) !== groupNeedsEric(now));
    if (moved && next.some((t) => t.state === "queued" && t.after?.includes(taskId))) void this.pump(coordId);
  }

  /** who a card's checks are for: a coordinator names a loadout and a shared
   *  workflow; whoever operates is Eric, with every field */
  private by(caller: Caller | null): "coordinator" | "person" {
    return caller === null || allows(caller.kind, "operate") ? "person" : "coordinator";
  }

  /** the highest card number a coordinator has given out */
  private last(coord: Run): number {
    return Math.max(this.numbers.get(coord.id) ?? 0, ...(coord.tasks ?? []).map((t) => Number(t.id.slice(1)) || 0));
  }

  /** The workflows each repo the cards name may run, read before the checks,
   *  which are not async. A repo the cards do not name a workflow for, or
   *  one not on this machine, reads none. */
  private async flowsFor(cards: readonly unknown[], withRepo: boolean): Promise<PlanContext["workflows"]> {
    const repos = new Set<string>();
    for (const c of cards.slice(0, MAX_PLAN)) {
      if (!isRecord(c) || (c["workflow"] === undefined && c["workflowRepo"] === undefined)) continue;
      const repo = c["repo"];
      if (typeof repo === "string" && this.deps.known(repo) === "local") repos.add(repo);
    }
    const lists = new Map<string, { name: string; fromRepo: boolean }[]>();
    for (const r of repos) lists.set(r, await this.deps.workflows(r, withRepo));
    return (r) => lists.get(r) ?? [];
  }

  /** `POST /api/coordinator/plan {run, tasks}`: the coordinator's proposal,
   *  added as `proposed` cards numbered t1, t2, ... per coordinator. A card
   *  may carry `equip`, `workflow` and `after` (`validatePlan`): a
   *  coordinator's token names a loadout and a bundled or user workflow,
   *  and Eric's may set the loadout's fields and pick the repo's own. */
  async plan(caller: Caller | null, b: Record<string, unknown>): Promise<{ ok: true; added: CoordTask[] }> {
    this.coordinator(b["run"], caller);
    const by = this.by(caller);
    const input = b["tasks"];
    const workflows = await this.flowsFor(Array.isArray(input) ? input : [], by === "person");
    // the cards may have moved while the workflows were read
    const coord = this.coordinator(b["run"], caller);
    const have = coord.tasks ?? [];
    let last = this.last(coord);
    const got = validatePlan(input, { known: this.deps.known, cards: have, next: last + 1, loadouts: this.deps.loadouts(), workflows, by, files: [] });
    if ("error" in got) throw new CoordError(got.error, 400);
    const added = got.tasks.map((t): CoordTask => ({ id: `t${++last}`, ...t, state: "proposed" }));
    this.numbers.set(coord.id, last);
    this.setTasks(coord, [...have, ...added]);
    return { ok: true, added };
  }

  /** `POST /api/coordinator/tasks {run, id, title?, note?, repo?, action?,
   *  times?, equip?, workflow?, workflowRepo?, after?, remove?}`: edits or
   *  removes a card that has not started (`editCard`). A proposed card
   *  changes in every field; a queued one in its `equip` and `after` only,
   *  and either may be removed. Eric's alone. */
  async edit(caller: Caller | null, b: Record<string, unknown>): Promise<{ ok: true; task: CoordTask } | { ok: true; removed: string }> {
    if (caller?.kind === "coordinator") throw new CoordError("a coordinator proposes; changing a card is Eric's", 403);
    const id = b["id"];
    const find = (): { coord: Run; tasks: CoordTask[]; t: CoordTask } => {
      const coord = this.coordinator(b["run"], caller);
      if (typeof id !== "string" || !id) throw new CoordError("missing card id", 400);
      const tasks = coord.tasks ?? [];
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new CoordError(`no card ${id}`, 404);
      if (t.state !== "proposed" && t.state !== "queued") throw new CoordError(`${id} is ${t.state}; only a proposed or queued card changes`);
      if (this.starting.has(`${coord.id}:${id}`)) throw new CoordError(`${id} is starting`);
      return { coord, tasks, t };
    };
    const first = find();
    if (b["remove"] === true) {
      const { coord, tasks } = first;
      this.setTasks(
        coord,
        tasks.filter((x) => x.id !== id),
      );
      this.blockedSaid.delete(`${coord.id}:${first.t.id}`);
      // the cards after it hear it was removed
      if (tasks.some((x) => x.state === "queued" && x.id !== id)) await this.pump(coord.id);
      return { ok: true, removed: first.t.id };
    }
    const workflows = await this.flowsFor([{ ...b, repo: b["repo"] ?? first.t.repo }], true);
    // the card may have moved while the workflows were read
    const { coord, tasks, t } = find();
    const got = editCard(t, b, { known: this.deps.known, cards: tasks, next: this.last(coord) + 1, loadouts: this.deps.loadouts(), workflows, by: this.by(caller), files: [] });
    // a field a queued card does not change is a conflict with its state, like a running card's
    if ("error" in got) throw new CoordError(got.error, got.error.startsWith(`${t.id} is `) ? 409 : 400);
    this.setTasks(
      coord,
      tasks.map((x) => (x.id === t.id ? got.task : x)),
    );
    // a new after, or none, may let it start, or leave it waiting with new words
    if (got.task.state === "queued") await this.pump(coord.id);
    return { ok: true, task: this.deps.run(coord.id)?.tasks?.find((x) => x.id === t.id) ?? got.task };
  }

  /** `POST /api/coordinator/start {run, ids?}`: start these. With no ids
   *  every proposed card is queued; with ids those cards are (each proposed
   *  or queued), and they go before the rest. As many start as the cap and
   *  the repos' slots allow, and none while the goal is held. */
  async begin(caller: Caller | null, b: Record<string, unknown>): Promise<{ ok: true; tasks: CoordTask[] }> {
    if (caller?.kind === "coordinator") throw new CoordError("a coordinator proposes; starting its cards is Eric's", 403);
    const coord = this.coordinator(b["run"], caller);
    const tasks = coord.tasks ?? [];
    const ids = b["ids"];
    if (ids === undefined) {
      if (!tasks.some((t) => t.state === "proposed")) throw new CoordError("no proposed cards to start");
      this.setTasks(
        coord,
        tasks.map((t) => (t.state === "proposed" ? { ...t, state: "queued" } : t)),
      );
    } else {
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== "string")) throw new CoordError("ids must list card ids", 400);
      const want = [...new Set(ids as string[])];
      for (const id of want) {
        const t = tasks.find((x) => x.id === id);
        if (!t) throw new CoordError(`no card ${id}`, 404);
        if (t.state !== "proposed" && t.state !== "queued") throw new CoordError(`${id} is ${t.state}; only a proposed or queued card starts`);
      }
      this.setTasks(
        coord,
        tasks.map((t) => (t.state === "proposed" && want.includes(t.id) ? { ...t, state: "queued" } : t)),
      );
      // the last start with ids names the cards that go first
      this.first.set(coord.id, want);
    }
    await this.pump(coord.id);
    return { ok: true, tasks: this.deps.run(coord.id)?.tasks ?? [] };
  }

  /** `POST /api/coordinator/hold {run, held}`: a held goal starts no card,
   *  through start these, a start with ids or the queue; its running
   *  children go on. The run carries `held`, and the manager hears it. */
  async hold(caller: Caller | null, b: Record<string, unknown>): Promise<{ ok: true; held: boolean }> {
    if (caller?.kind === "coordinator") throw new CoordError("a coordinator proposes; holding the goal is Eric's", 403);
    const coord = this.coordinator(b["run"], caller);
    const held = b["held"];
    if (typeof held !== "boolean") throw new CoordError("held must be true or false", 400);
    if ((coord.held === true) !== held) {
      if (held) coord.held = true;
      else delete coord.held;
      this.deps.broadcast(coord);
      this.queueNote(coord.id, holdNote(held));
    }
    await this.pump(coord.id);
    return { ok: true, held };
  }

  /* ---------- the queue ---------- */

  /** children still working: a card whose child ended but waits on the
   *  landing queue holds no slot, a group card holds one for each member
   *  still going, and a card's flow one while it is active */
  private working(coord: Run): number {
    const going = (id: string | undefined): boolean => {
      const r = id ? this.deps.run(id) : undefined;
      return r !== undefined && isRunActive(r);
    };
    return (coord.tasks ?? []).reduce((n, t) => {
      if (t.state !== "running") return n;
      if (t.flow) {
        const f = this.deps.flow?.(t.flow);
        return n + (f && isFlowActive(f) ? 1 : 0);
      }
      if (!t.group) return n + (going(t.run) ? 1 : 0);
      return n + (this.deps.group?.(t.group)?.members.filter((m) => going(m.run)).length ?? 0);
    }, 0);
  }

  /** The words a queued card waits with, most telling first: the goal is
   *  held, the cards its `after` names have not landed, this pass's words,
   *  its repo has no slot, or the governor's window it waited on. */
  private waitWords(t: CoordTask, tasks: readonly CoordTask[], held: boolean, passed: ReadonlyMap<string, string>): string | undefined {
    if (held) return HELD_WORD;
    const wait = afterWait(t, tasks);
    if (wait) return wait.words;
    return passed.get(t.id) ?? (this.deps.repoFull(t.repo, t.times ?? 1) ? slotWord(t.repo) : isCapacityWords(t.outcome) ? t.outcome : undefined);
  }

  /** A queued card whose `after` can never be met by itself: the manager
   *  hears it once for each reason, and again only if the reason changes. */
  private noteBlocked(coordId: string, t: CoordTask, tasks: readonly CoordTask[]): void {
    const key = `${coordId}:${t.id}`;
    const wait = afterWait(t, tasks);
    if (!wait?.blocked) {
      this.blockedSaid.delete(key);
      return;
    }
    if (this.blockedSaid.get(key) === wait.words) return;
    this.blockedSaid.set(key, wait.words);
    this.queueNote(coordId, blockedNote(t, wait.words, wait.reopens));
  }

  /** the cards a start with ids named that still wait in the queue */
  private firstFor(coordId: string, tasks: readonly CoordTask[]): string[] {
    const ids = (this.first.get(coordId) ?? []).filter((id) => tasks.some((t) => t.id === id && t.state === "queued"));
    if (ids.length > 0) this.first.set(coordId, ids);
    else this.first.delete(coordId);
    return ids;
  }

  /** Starts the coordinator's queued cards, one at a time, while fewer than
   *  three of its children work and their repos have a slot. A card whose
   *  repo is full stays queued and says so, as does a card waiting for the
   *  cards its `after` names to land; a held coordinator starts none. A
   *  start that throws fails its card and queues a note saying why. */
  pump(coordId: string): Promise<void> {
    return this.queue(async () => {
      /** cards looked at this pass, with the words they wait with */
      const passed = new Map<string, string>();
      for (;;) {
        const coord = this.deps.run(coordId);
        if (!coord || !isRunActive(coord)) return;
        const tasks = coord.tasks ?? [];
        const held = coord.held === true;
        for (const t of tasks) {
          if (t.state !== "queued") continue;
          this.noteBlocked(coordId, t, tasks);
          this.update(coordId, t.id, (x) => withOutcome(x, this.waitWords(x, tasks, held, passed)));
        }
        if (held) return;
        const [next] = nextToStart(
          tasks.filter((t) => !passed.has(t.id)),
          { working: this.working(coord), repoFull: this.deps.repoFull, cards: tasks, first: this.firstFor(coordId, tasks) },
        );
        if (!next) return;
        const key = `${coordId}:${next.id}`;
        const priority: Priority = this.released.delete(key) ? "interactive" : "normal";
        let out: ChildStart;
        this.starting.add(key);
        try {
          out = await this.deps.startChild(coordId, next, priority);
        } catch (err) {
          this.update(coordId, next.id, (x) => withOutcome({ ...x, state: "failed" }, errText(err)));
          this.queueNote(coordId, startNote(next, errText(err)));
          continue;
        } finally {
          this.starting.delete(key);
        }
        if ("busy" in out) {
          // the governor holds every card at once: they share its window,
          // so the rest wait with the same words and none is tried this pass
          if (isCapacityWords(out.busy)) {
            // a card waiting on its after keeps saying so
            for (const t of tasks) if (t.state === "queued" && !passed.has(t.id) && !afterWait(t, tasks)) passed.set(t.id, out.busy);
            for (const [id, words] of passed) this.update(coordId, id, (x) => (x.state === "queued" ? withOutcome(x, words) : x));
            return;
          }
          passed.set(next.id, slotWord(next.repo));
          this.update(coordId, next.id, (x) => withOutcome(x, slotWord(x.repo)));
          continue;
        }
        if ("group" in out) {
          const group = out.group;
          this.update(coordId, next.id, (x) => withOutcome({ ...x, state: "running", group: group.id }, undefined));
          // a group can settle inside its own start, as a child can
          const started = this.deps.run(coordId)?.tasks?.find((t) => t.id === next.id);
          if (started) this.settleGroup(coord, started);
          continue;
        }
        if ("flow" in out) {
          const flow = out.flow;
          this.update(coordId, next.id, (x) => {
            const { work: _work, branch: _branch, run: _run, ...rest } = x;
            return withOutcome({ ...rest, state: "running", flow: flow.id, ...(flow.branch ? { branch: flow.branch.origin } : {}), ...(flow.branch?.work ? { work: flow.branch.work } : {}) }, undefined);
          });
          // a flow can end inside its own start, before its card knew its id
          this.followFlow(this.deps.flow?.(flow.id) ?? flow);
          continue;
        }
        const child = out.run;
        this.update(coordId, next.id, (x) => {
          const { work: _work, branch: _branch, ...rest } = x;
          return withOutcome({ ...rest, state: "running", run: child.id, ...(child.branch ? { branch: child.branch.origin } : {}), ...(child.branch?.work ? { work: child.branch.work } : {}) }, undefined);
        });
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

  /** A child moved: its card settles when it has (see `childSettled`). A run
   *  no card has yet may be a later one on a card's branch, which the card
   *  takes (`adopt`). */
  private follow(child: Run): void {
    if (!child.parent) return this.followBranch(child);
    const coord = this.deps.run(child.parent);
    if (!coord) return;
    const task = coord.tasks?.find((t) => t.run === child.id) ?? this.adopt(coord, child);
    if (!task || task.state !== "running") return;
    this.settle(coord, task, child);
  }

  /** A run that names no coordinator but works on a card's branch: a
   *  landing or PR fix on a flow card's branch, since the flow hands its
   *  branch over by its last step's run, which names no parent. The card
   *  that already follows it settles on it; else the first coordinator
   *  whose card holds that branch adopts it on adopt's terms. */
  private followBranch(child: Run): void {
    if (!child.branch?.origin || child.flowStep) return;
    const coords = this.deps.runs().filter((r) => r.action === "coordinate");
    for (const coord of coords) {
      const task = coord.tasks?.find((t) => t.run === child.id);
      if (!task) continue;
      if (task.state === "running") this.settle(coord, task, child);
      return;
    }
    for (const coord of coords) {
      const task = this.adopt(coord, child);
      if (!task) continue;
      if (task.state === "running") this.settle(coord, task, child);
      return;
    }
  }

  /** A later run on a card's branch that names the coordinator (a fix, a
   *  follow-up), or names none (`followBranch`), becomes the card's run:
   *  the card goes back to running with no outcome and settles again on
   *  it, with its `limited` cleared, since the run is a fresh attempt (the
   *  limit resume's own run comes through `starting`, never here). Only a run that works now, for a coordinator
   *  still going, while the card's own run does not, so an old run's late word never takes the
   *  card back. A landed card stays closed, and a card whose start or
   *  resume is in flight keeps that start's run. A flow's step run is never
   *  taken, nor a card whose flow is still active; a card whose flow ended
   *  follows the run from then on. Not held to three at once: it counts as
   *  working from then on. */
  private adopt(coord: Run, run: Run): CoordTask | undefined {
    const origin = run.branch?.origin;
    if (!origin || run.flowStep || !isRunActive(run) || coord.action !== "coordinate" || !isRunActive(coord)) return undefined;
    const t = coord.tasks?.find((x) => x.branch === origin && (x.state === "running" || x.state === "done" || x.state === "failed"));
    if (!t || cardLanded(t) || this.starting.has(`${coord.id}:${t.id}`)) return undefined;
    const own = t.run ? this.deps.run(t.run) : undefined;
    if (own && isRunActive(own)) return undefined;
    const flow = t.flow ? this.deps.flow?.(t.flow) : undefined;
    if (flow && isFlowActive(flow)) return undefined;
    if (t.run) this.cancel(t.run);
    if (t.flow) this.cancel(flowKey(t.flow));
    this.update(coord.id, t.id, (x) => {
      const { flow: _flow, limited: _limited, ...rest } = x;
      return withOutcome({ ...rest, state: "running", run: run.id }, undefined);
    });
    return this.deps.run(coord.id)?.tasks?.find((x) => x.id === t.id);
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
    if (child.status === "limited" && (task.limited ?? 0) < 1) {
      // the work is sound and waits for the reset: the card keeps its run
      // until the child resumes on its branch (FR-036)
      if (task.limited === undefined || !isCapacityWords(task.outcome)) {
        this.update(coord.id, task.id, (x) => ({ ...withOutcome(x, limitedWords(child.limited, this.now())), limited: 0 }));
        this.queueNote(coord.id, `canopy: task ${task.id} (${task.title}) stopped at the plan's usage limit; it carries on on its branch after the reset`);
      }
      return;
    }
    if (child.status === "limited") {
      // limited again after its resume: it fails, so a misread text cannot loop
      this.cancel(child.id);
      this.update(coord.id, task.id, (x) => withOutcome({ ...x, state: "failed" }, "the plan's usage limit, twice in a row"));
      this.queueNote(coord.id, settleNote(task, child, this.deps.landing(child), "failed"));
      return;
    }
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
    if (task.work) this.deps.work?.note(task.work, `card ${task.id} settled: ${got.outcome}`);
    this.queueNote(coord.id, settleNote(task, child, branch));
  }

  /** A card's flow moved: a card that failed `stopped` goes back to running
   *  when its flow is active again (picked up) while its coordinator is
   *  still going, and a running card settles
   *  when its flow has (`settleFlow`). */
  private followFlow(flow: Flow): void {
    for (const coord of this.deps.runs()) {
      if (coord.action !== "coordinate") continue;
      const t = coord.tasks?.find((x) => x.flow === flow.id);
      if (!t) continue;
      if (t.state === "failed" && t.outcome === "stopped" && isFlowActive(flow) && isRunActive(coord)) {
        this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: "running" }, undefined));
      } else if (t.state === "running") this.settleFlow(coord, t, flow);
      return;
    }
  }

  /** A card's flow settles it by `flowSettled`, the branch read by its
   *  origin and the ready wait counted from the flow's end, as a child's
   *  is from its run's; the note is `flowNote`. */
  private settleFlow(coord: Run, task: CoordTask, flow: Flow): void {
    const key = flowKey(flow.id);
    if (isFlowActive(flow)) {
      this.cancel(key);
      return;
    }
    const branch = flow.branch ? (this.deps.branch?.(flow.branch.origin) ?? {}) : {};
    const ended = flow.endedAt ?? this.now();
    const left = ended + (this.deps.readyWait ?? READY_WAIT) - this.now();
    const got = flowSettled(flow, branch, left <= 0);
    if (!got) {
      if (left > 0) this.later(key, left);
      else this.cancel(key);
      return;
    }
    this.cancel(key);
    this.update(coord.id, task.id, (x) => withOutcome({ ...x, state: got.state }, got.outcome));
    if (task.work) this.deps.work?.note(task.work, `card ${task.id} settled: ${got.outcome}`);
    this.queueNote(coord.id, flowNote(task, flow, branch));
  }

  /** A group card settles on the group's word (`groupSettled`). A group's
   *  changes reach here through `recheck`. */
  private settleGroup(coord: Run, task: CoordTask): void {
    const group = task.group ? this.deps.group?.(task.group) : undefined;
    if (!group) {
      this.update(coord.id, task.id, (x) => withOutcome({ ...x, state: "failed" }, "its group is no longer kept"));
      return;
    }
    const got = groupSettled(group);
    if (!got) return;
    this.update(coord.id, task.id, (x) => withOutcome({ ...x, state: got.state }, got.outcome));
    this.queueNote(coord.id, groupNote(task, group, got.outcome));
  }

  /* ---------- capacity (FR-036) ---------- */

  /** The cards waiting for capacity, as the chip lists them: queued ones the
   *  governor holds and running ones whose child hit the limit. */
  heldStarts(): HeldStart[] {
    const out: HeldStart[] = [];
    for (const coord of this.deps.runs()) {
      if (coord.action !== "coordinate" || !isRunActive(coord)) continue;
      for (const t of coord.tasks ?? []) {
        const waits = (t.state === "queued" || t.state === "running") && isCapacityWords(t.outcome);
        if (!waits) continue;
        const child = t.run ? this.deps.run(t.run) : undefined;
        out.push({ id: `card:${coord.id}:${t.id}`, what: t.title, repoId: t.repo, priority: "normal", why: t.outcome ?? "waiting for capacity", since: child?.endedAt ?? coord.startedAt });
      }
    }
    return out;
  }

  /** The governor may have let go: queued cards are pumped again, and a
   *  card whose child hit the limit resumes it on its branch when `go` says
   *  normal work may start. */
  wake(go: () => boolean): void {
    this.pumpAll();
    if (!go()) return;
    for (const coord of this.deps.runs()) {
      if (coord.action !== "coordinate" || !isRunActive(coord)) continue;
      for (const t of coord.tasks ?? []) {
        if (t.state === "running" && t.limited === 0) void this.resumeLimited(coord.id, t.id, "normal");
      }
    }
  }

  /** "Start anyway" on a held card, once as interactive. */
  async release(coordId: string, taskId: string): Promise<void> {
    const coord = this.deps.run(coordId);
    const task = coord?.tasks?.find((t) => t.id === taskId);
    if (!coord || !task || !isCapacityWords(task.outcome)) throw new CoordError(`card ${taskId} is not waiting for capacity`, 404);
    if (task.state === "running") {
      const why = await this.resumeLimited(coordId, taskId, "interactive");
      if (why !== null) throw new CoordError(`card ${taskId} cannot resume: ${why}`);
      return;
    }
    this.released.add(`${coordId}:${taskId}`);
    await this.pump(coordId);
  }

  /** The child that hit the limit carries on on its branch: a new run, the
   *  card following it, its count kept so a second limit fails the card.
   *  Null once the card carries on (resumed, or held again); else why it
   *  does not. A limited child the runner no longer has (the run memory
   *  went with a restart) fails the card with that why, since nothing
   *  would ever resume it and the chip would list it for good. */
  private async resumeLimited(coordId: string, taskId: string, priority: Priority): Promise<string | null> {
    // the queue keeps its errors; the answer comes out by the side
    const answer = { why: null as string | null };
    await this.queue(async () => {
      const coord = this.deps.run(coordId);
      const task = coord?.tasks?.find((t) => t.id === taskId);
      if (!coord || !isRunActive(coord) || !task) {
        answer.why = "the coordinator has ended";
        return;
      }
      if (task.state !== "running" || task.limited !== 0) {
        answer.why = `it is ${task.state}, not waiting after a limit`;
        return;
      }
      const child = task.run ? this.deps.run(task.run) : undefined;
      if (!child) {
        answer.why = `its run ${task.run ?? "?"} is gone since it hit the limit (a restart), so nothing carries it on`;
        const why = answer.why;
        this.update(coordId, taskId, (x) => withOutcome({ ...x, state: "failed" }, why));
        return;
      }
      if (child.status !== "limited") {
        answer.why = `its run ${child.id} is ${child.status}, not limited`;
        return;
      }
      if (!this.deps.resumeChild) {
        answer.why = "this backend cannot resume a child";
        return;
      }
      let out: ChildResume;
      const key = `${coordId}:${taskId}`;
      this.starting.add(key);
      try {
        out = await this.deps.resumeChild(coordId, task, child, priority);
      } catch (err) {
        this.update(coordId, taskId, (x) => withOutcome({ ...x, state: "failed" }, errText(err)));
        this.queueNote(coordId, startNote(task, errText(err)));
        return;
      } finally {
        this.starting.delete(key);
      }
      if ("busy" in out) {
        this.update(coordId, taskId, (x) => withOutcome(x, out.busy));
        return;
      }
      const next = out.run;
      this.update(coordId, taskId, (x) => ({ ...withOutcome(x, undefined), run: next.id, limited: 1, ...(next.branch ? { branch: next.branch.origin } : {}) }));
      this.follow(next);
    });
    return answer.why;
  }

  /** Every card waiting on a child or a flow that ended is looked at again:
   *  the landing queue or the PR watch moved, or a ready child's wait ran
   *  out. So is every card that settled ready, PR opened or with a winner
   *  picked, which Eric may land long after, or drop (`landLater`), a card
   *  failed on a closed PR, whose branch may still land, and a group card
   *  whose group needs Eric, who may still pick and land a winner. */
  recheck(): void {
    for (const coord of this.deps.runs()) {
      if (coord.action !== "coordinate") continue;
      for (const t of coord.tasks ?? []) {
        if ((t.state === "done" && mayLandLater(t.outcome)) || (t.state === "failed" && (t.outcome === "PR closed" || groupNeedsEric(t)))) this.landLater(coord, t);
        if (t.state === "running" && t.flow) {
          const flow = this.deps.flow?.(t.flow);
          if (flow) this.settleFlow(coord, t, flow);
          else this.settleFlowGone(coord, t);
          continue;
        }
        if (t.state === "running" && t.group) this.settleGroup(coord, t);
        if (t.state !== "running" || !t.run) continue;
        const child = this.deps.run(t.run);
        if (child) this.settle(coord, t, child);
        else this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: "failed" }, "its run is no longer kept"));
      }
    }
  }

  /** A settled card whose work landed since: its branch landed through the
   *  queue or its PR merged (read off its run, or off its branch once the run
   *  is gone), or its group landed its winner. It turns landed, the manager
   *  hears it, and the cards after it may start. A done card whose work will
   *  not land as it stood turns failed (`laterOutcome`: its branch dropped,
   *  its PR closed unmerged; or its group dropped or sent back), the manager
   *  hears it, and the cards after it hear they are blocked. A card failed
   *  on a closed PR only turns landed. A group card whose group needed Eric
   *  takes the group's word again: a winner he picked, his landing, or his
   *  drop. */
  private landLater(coord: Run, t: CoordTask): void {
    const got = this.lateOutcome(t);
    if (got?.outcome === "landed") {
      this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: "done" }, "landed"));
      this.queueNote(coord.id, landedNote(t));
      if (isRunActive(coord) && (coord.tasks ?? []).some((x) => x.state === "queued")) void this.pump(coord.id);
      return;
    }
    if (groupNeedsEric(t)) {
      if (!got || got.outcome === t.outcome) return;
      const group = t.group ? this.deps.group?.(t.group) : undefined;
      this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: got.state }, got.outcome));
      if (got.state === "done" && group) this.queueNote(coord.id, groupNote(t, group, got.outcome));
      else if (got.state === "failed") this.queueNote(coord.id, lateFailNote(t, got.outcome));
      return;
    }
    if (!got || got.state !== "failed" || t.state !== "done") return;
    this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: "failed" }, got.outcome));
    if (t.work) this.deps.work?.note(t.work, `card ${t.id} settled again: ${got.outcome}`);
    this.queueNote(coord.id, lateFailNote(t, got.outcome));
  }

  /** What became of a settled card's work since: its group's word, or its
   *  branch's (`laterOutcome`), read off its run while the runner keeps it. */
  private lateOutcome(t: CoordTask): ReturnType<typeof laterOutcome> {
    if (t.group) {
      const g = this.deps.group?.(t.group);
      return g ? groupSettled(g) : null;
    }
    const child = t.run ? this.deps.run(t.run) : undefined;
    const b = child ? this.deps.landing(child) : t.branch ? this.deps.branch?.(t.branch) : undefined;
    return b ? laterOutcome(this.withWork(t, b)) : null;
  }

  /** A branch's facts with its card's work item read too: an item closed
   *  landed says the branch landed after the queue let its entry go. */
  private withWork(t: CoordTask, b: ChildBranch): ChildBranch {
    return t.work && this.deps.workState?.(t.work) === "landed" ? { ...b, workLanded: true } : b;
  }

  /** A running flow card whose flow the backend no longer keeps (the flows
   *  keep only the newest finished records) settles off its branch while
   *  that says how (`flowGoneSettled`, the ready wait counted from the
   *  landing record's last run), waits while the queue still holds it or
   *  the sort has yet to read it, and fails when nothing is known. */
  private settleFlowGone(coord: Run, t: CoordTask): void {
    const found = t.branch ? this.deps.branch?.(t.branch) : undefined;
    const b = found ? this.withWork(t, found) : undefined;
    const left = b?.branchEnded !== undefined ? b.branchEnded + (this.deps.readyWait ?? READY_WAIT) - this.now() : 0;
    const got = b ? flowGoneSettled(b, left <= 0) : null;
    if (got === "waits") {
      if (left > 0 && t.flow) this.later(flowKey(t.flow), left);
      return;
    }
    if (!got || !b) {
      this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: "failed" }, "its flow is no longer kept"));
      return;
    }
    if (t.flow) this.cancel(flowKey(t.flow));
    this.update(coord.id, t.id, (x) => withOutcome({ ...x, state: got.state }, got.outcome));
    if (t.work) this.deps.work?.note(t.work, `card ${t.id} settled: ${got.outcome}`);
    this.queueNote(coord.id, flowGoneNote(t, got.outcome, b));
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

  /** Says the oldest waiting note when the coordinator is idle, with every
   *  card's state as it is then under it (`withCards`). It runs after the
   *  change that called it has reached every listener, since saying moves
   *  the run under them. */
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
        this.deps.say(coordId, withCards(text, coord.tasks ?? []));
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
    this.first.delete(coord.id);
    for (const key of this.blockedSaid.keys()) if (key.startsWith(`${coord.id}:`)) this.blockedSaid.delete(key);
    const tasks = coord.tasks ?? [];
    // its children's cards still settle on the broadcasts' recheck, with
    // nothing said, so no timer need outlive it
    for (const t of tasks) {
      if (t.run) this.cancel(t.run);
      if (t.flow) this.cancel(flowKey(t.flow));
    }
    if (!tasks.some((t) => t.state === "proposed" || t.state === "queued")) return;
    this.setTasks(
      coord,
      tasks.map((t) => (t.state === "proposed" || t.state === "queued" ? withOutcome({ ...t, state: "dropped" }, undefined) : t)),
    );
  }

  /** The Runner's every change. */
  onRun(run: Run): void {
    if (run.parent || run.branch) this.follow(run);
    if (run.action === "coordinate") {
      if (!isRunActive(run)) this.end(run);
      else if (run.status === "idle" && this.notes.has(run.id)) this.flushSoon(run.id);
    }
    if (!isRunActive(run)) this.pumpAll();
  }

  /** The flows' every change: a card's flow settles its card, or puts it
   *  back to running once picked up; and a branch flow holds one of its
   *  repo's branch slots from its start to its end, so its end may free one
   *  a card waits for. */
  onFlow(flow: Flow): void {
    this.followFlow(flow);
    if (flow.branch && !isFlowActive(flow)) this.pumpAll();
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL, caller: Caller | null): Promise<Response | null> {
    const path = url.pathname.replace(/\/+$/, "");
    if (req.method !== "POST" || !path.startsWith("/api/coordinator/")) return null;
    const act = path.slice("/api/coordinator/".length);
    if (act !== "plan" && act !== "tasks" && act !== "start" && act !== "hold") return null;
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
      if (act === "plan") return json(await this.plan(caller, b));
      if (act === "tasks") return json(await this.edit(caller, b));
      if (act === "hold") return json(await this.hold(caller, b));
      return json(await this.begin(caller, b));
    } catch (err) {
      return json({ error: errText(err) }, err instanceof CoordError ? err.status : 500);
    }
  }
}
