/** The landing queue's server half (FR-012, FR-013): the branch run
 *  records, one loop per repo that lands queued entries one at a time (the
 *  rebase, the gates one at a time, then the repo's scenarios, then
 *  fast-forward), the sort that decides what may join on its own, the
 *  routes, and the `landing` event. The model and its words are
 *  `core/landing.ts`; the git is `core/worktree.ts`; the gates are
 *  `core/gates.ts`; the review rules and the sort are `core/review.ts`; the
 *  scenario pass is `scenarios.ts` (FR-032).
 *
 *  Records live under `<configDir>/landing/`: `runs/<id>.json` per branch
 *  run, `queue/<repo key>.json` per repo and `notices.json`. Only the server
 *  holding the flows lock writes them (`adopt`), so two canopies on one
 *  config dir never both work one queue. The queue never pushes. */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readGates, touchesLockfile, type Gates } from "../core/gates";
import {
  addNotice,
  advance,
  canLand,
  enqueue,
  holdAll,
  inQueue,
  landAnyway,
  LandError,
  landWord,
  MAX_NOTICES,
  nextEntry,
  pruneLanded,
  rejoins,
  restartWorking,
  retryWaiting,
  reviewWord,
  SCENARIO_GATE,
  scoreGate,
  scoreOutput,
  sentBack,
  tail,
  unqueue,
  WORKING,
  type LandEvent,
  type QueueFlags,
} from "../core/landing";
import { foldsCase, readRules, sortBranch } from "../core/review";
import type { Collision, Touched } from "../core/touch";
import type { GroupDry } from "../core/group";
import type { ScenarioSet, ScenarioSettings } from "../core/scenario";
import { configDir } from "../core/store";
import type { EvidenceFile, LandEntry, LandingInfo, LandingOrphan, LandingRun, LandNotice, Repo, Run, RunBranch, RunBranchState, RunReview, RunWhole, ScenarioRun, ServerEvent } from "../core/types";
import type { WorkSink } from "../core/work";
import { isRunActive } from "../core/types";
import { git } from "../core/exec";
import { aheadOf, currentBranch, defaultBranch, dirtyFiles, ffMain, listRunTreeDirs, rebaseOnto, removeRunTree, repoKey, revOf, treeRepo, treeState, worktreesRoot } from "../core/worktree";
import { readScenarioSet, readScenarioSettings, runScenarioSet, scenariosRoot, setDirOf, type ScenarioJudge, type ScenarioRunner } from "./scenarios";

export const landingDir = (): string => join(configDir(), "landing");
/** how often entries waiting on a busy checkout look again */
export const RETRY_EVERY = 30_000;

export interface CheckOutcome {
  exit: number | null;
  output: string;
}

export interface LandingDeps {
  broadcast: (ev: ServerEvent) => void;
  /** the scan's repo by id */
  repo: (id: string) => Repo | undefined;
  /** the scan's repo by its absolute path */
  repoByPath: (path: string) => Repo | undefined;
  /** runs one shell line in a folder (`runCheck`) */
  check: (cwd: string, line: string) => Promise<CheckOutcome>;
  /** starts a "fix it" run on a sent-back branch */
  startFix: (rec: LandingRun, entry: LandEntry) => Run | Promise<Run>;
  /** whether a run is still going, by id; a fix waits for it */
  runActive: (id: string) => boolean;
  /** sorts a branch run's diff; `sortRun` unless a test says otherwise */
  sort?: (rec: LandingRun, now: number) => Promise<RunReview>;
  /** a run whose pre-flight said "open a PR" settled ready (FR-011) */
  openPr?: (id: string) => Promise<unknown> | void;
  /** a branch was dropped with its worktree: its PR watch goes too */
  dropped?: (id: string) => void;
  /** whether a PR watch still holds the branch: its PR open and not swept,
   *  so its worktree is the watch's to keep */
  prHeld?: (id: string) => boolean;
  /** the work ledger: one line per move of a branch that has an item (FR-037) */
  work?: WorkSink;
  /** the live collisions, for the info (FR-040) */
  collisions?: () => Collision[];
  /** the touched sets of a repo's live runs, for the mark at enqueue */
  working?: (repoId: string) => readonly Touched[];
  /** runs one scenario line in a worktree with the set's copy as SCENARIO_DIR (`runScenario`) */
  scenario: ScenarioRunner;
  judge: ScenarioJudge | null;
  evidence?: (dir: string, paths: string[]) => Promise<EvidenceFile[]>;
  /** where the sets live; `scenariosRoot()` unless a test says otherwise */
  scenariosRoot?: string;
  dir?: string;
  worktrees?: string;
  now?: () => number;
  retryEvery?: number;
}

/** Sorts a branch run's worktree against its target, with the rules and
 *  gates its main checkout holds at this moment. Command scenarios in the
 *  repo's set count as gates. */
export async function sortRun(rec: LandingRun, now: number, root = scenariosRoot()): Promise<RunReview> {
  const rules = await readRules(rec.repoPath);
  const set = await readScenarioSet(root, rec.repoPath).catch((): ScenarioSet => ({ scenarios: [], errors: [] }));
  const hasGates = await readGates(rec.repoPath).then(
    (g) => g.source !== "none" || set.scenarios.some((s) => s.kind === "command"),
    () => false,
  );
  return sortBranch(rec.dir, rec.target, rules, hasGates, await foldsCase(rec.repoPath), now);
}

/** Whether a run a restart stopped may land as its worktree is now: clean,
 *  nothing untracked that is not ignored, and commits its target lacks. */
export async function wholeOf(rec: Pick<LandingRun, "dir" | "target">): Promise<RunWhole> {
  if (!existsSync(rec.dir)) return { ok: false, why: "its worktree is gone" };
  switch (await treeState(rec.dir, rec.target)) {
    case "ready":
      return { ok: true };
    case "uncommitted":
      return { ok: false, why: "changes left uncommitted" };
    case "nothing":
      return { ok: false, why: `no commits ${rec.target} lacks` };
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class LandingHub {
  private runs = new Map<string, LandingRun>();
  private entries: LandEntry[] = [];
  private orphans: LandingOrphan[] = [];
  private notices: LandNotice[] = [];
  /** each branch's sort going now; the next waits for it */
  private sorting = new Map<string, Promise<RunReview | null>>();
  /** work started off a run's event (a sort, then a join), for `idle` */
  private pending = new Set<Promise<void>>();
  /** set while this server holds the flows lock: only then are records written */
  private keeping = false;
  private loops = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** the last record each run's change wrote, to skip writes that change nothing */
  private written = new Map<string, string>();
  /** each record file's pending writes, in order */
  private chains = new Map<string, Promise<void>>();
  /** each stopped run's worktree as the last look found it; never saved */
  private whole = new Map<string, RunWhole>();
  /** the look at the stopped runs going now, and whether another is asked for */
  private looking: Promise<void> | null = null;
  private lookAgain = false;

  constructor(private deps: LandingDeps) {}

  private get dir(): string {
    return this.deps.dir ?? landingDir();
  }
  /** where the scenario sets live */
  private get root(): string {
    return this.deps.scenariosRoot ?? scenariosRoot();
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  info(): LandingInfo {
    const runs = [...this.runs.values()].map((r) => {
      const whole = r.state === "stopped" ? this.whole.get(r.id) : undefined;
      return whole ? { ...r, whole } : r;
    });
    return { runs, entries: this.entries, orphans: this.orphans, notices: this.notices, collisions: this.deps.collisions?.() ?? [] };
  }

  /** Sends the info, then looks at the stopped runs' worktrees again. */
  private publish(): void {
    this.deps.broadcast({ type: "landing", landing: this.info() });
    void this.lookStopped();
  }

  /** a line on the item of a record, when it has one */
  private tell(id: string, text: string): void {
    const work = this.runs.get(id)?.work;
    if (work) this.deps.work?.note(work, text);
  }

  private end(id: string, state: "landed" | "dropped", text: string): void {
    const work = this.runs.get(id)?.work;
    if (work) this.deps.work?.close(work, state, text);
  }

  /** sends the info again after the live collisions changed */
  republish(): void {
    this.publish();
  }

  /** Looks at the worktree of every stopped run with no entry, after any
   *  look going now, and sends the info again when one changed: whether it
   *  may land is asked each time, since the worktree can change after the
   *  restart. A whole one with no sort is sorted, as a ready one is at
   *  adopt. */
  private lookStopped(): Promise<void> {
    if (this.looking) {
      this.lookAgain = true;
      return this.looking;
    }
    // one with an entry is the queue's: its turn works the worktree
    const open = (): LandingRun[] => [...this.runs.values()].filter((r) => r.state === "stopped" && !this.entries.some((e) => e.id === r.id));
    if (open().length === 0 && this.whole.size === 0) return Promise.resolve();
    const look = async (): Promise<void> => {
      do {
        this.lookAgain = false;
        const next = new Map<string, RunWhole>();
        for (const r of open()) next.set(r.id, await wholeOf(r));
        const changed = JSON.stringify([...next]) !== JSON.stringify([...this.whole]);
        this.whole = next;
        for (const [id, w] of next) if (w.ok && !this.runs.get(id)?.review && !this.sorting.has(id)) this.track(this.resort(id).then(() => undefined));
        // straight to the clients, not through publish, which would look again
        if (changed) this.deps.broadcast({ type: "landing", landing: this.info() });
      } while (this.lookAgain);
    };
    const p = look().finally(() => {
      this.looking = null;
      // asked for between the last pass and here
      if (this.lookAgain) void this.lookStopped();
    });
    this.looking = p;
    this.track(p);
    return p;
  }

  /* ---------- records ---------- */

  /** Writes to one file run one after another, each taking what `make`
   *  gives when its turn comes, so the last write holds the newest state;
   *  null removes the file. */
  private persist(path: string, make: () => unknown): Promise<void> {
    if (!this.keeping) return Promise.resolve();
    const write = async (): Promise<void> => {
      const data = make();
      if (data === null) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(join(path, ".."), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, path);
    };
    const next = (this.chains.get(path) ?? Promise.resolve()).then(write).catch((err) => console.error(`landing: ${errText(err)}`));
    this.chains.set(path, next);
    void next.then(() => {
      if (this.chains.get(path) === next) this.chains.delete(path);
    });
    return next;
  }

  private saveRun(rec: LandingRun): Promise<void> {
    return this.persist(join(this.dir, "runs", `${rec.id}.json`), () => this.runs.get(rec.id) ?? null);
  }

  private dropRun(id: string): Promise<void> {
    this.runs.delete(id);
    this.written.delete(id);
    return this.persist(join(this.dir, "runs", `${id}.json`), () => null);
  }

  /** Writes one repo's entries; a repo with none left loses its file. */
  private saveQueue(repoPath: string): Promise<void> {
    return this.persist(join(this.dir, "queue", `${repoKey(repoPath)}.json`), () => {
      const mine = this.entries.filter((e) => e.repoPath === repoPath);
      return mine.length === 0 ? null : mine;
    });
  }

  private saveNotices(): Promise<void> {
    return this.persist(join(this.dir, "notices.json"), () => (this.notices.length === 0 ? null : this.notices));
  }

  /** A quiet line: a run that landed on its own, or one held back. */
  notice(n: Omit<LandNotice, "id" | "at">): void {
    this.notices = addNotice(this.notices, { ...n, id: crypto.randomUUID().slice(0, 8), at: this.now() });
    void this.saveNotices();
  }

  /** "seen" on notices: they go. */
  seen(ids: readonly string[]): void {
    const drop = new Set(ids);
    const left = this.notices.filter((n) => !drop.has(n.id));
    if (left.length === this.notices.length) return;
    this.notices = left;
    void this.saveNotices();
    this.publish();
  }

  /** Resolves once every record write asked for so far is on disk. */
  async flushed(): Promise<void> {
    while (this.chains.size > 0) await Promise.all(this.chains.values());
  }

  private async readDir<T>(sub: string, parse: (v: unknown) => T[]): Promise<T[]> {
    const out: T[] = [];
    let names: string[];
    try {
      names = await readdir(join(this.dir, sub));
    } catch {
      return out;
    }
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      try {
        out.push(...parse(JSON.parse(await readFile(join(this.dir, sub, n), "utf8"))));
      } catch (err) {
        console.error(`landing: ${sub}/${n} unreadable, left alone: ${errText(err)}`);
      }
    }
    return out;
  }

  /** Takes the records the last server left, as the holder of the flows
   *  lock: a run that was working reads `stopped` with its worktree kept,
   *  an entry cut off mid-turn starts its turn again, a ready run with no
   *  sort (a plan 1 record) is sorted, and a run worktree no record names
   *  is an orphan. Writes from now on. */
  async adopt(): Promise<void> {
    const kept = await readFile(join(this.dir, "notices.json"), "utf8").then(
      (t) => JSON.parse(t) as unknown,
      () => [],
    );
    const known = new Set(this.notices.map((x) => x.id));
    const read = Array.isArray(kept) ? (kept.filter((x) => isRecord(x) && typeof x["id"] === "string" && !known.has(x["id"])) as LandNotice[]) : [];
    this.notices = [...this.notices, ...read].sort((a, b) => b.at - a.at).slice(0, MAX_NOTICES);
    this.keeping = true;
    const runs = await this.readDir("runs", (v) => (isRecord(v) && typeof v["id"] === "string" ? [v as unknown as LandingRun] : []));
    for (const r of runs) {
      const rec = r.state === "working" ? { ...r, state: "stopped" as const } : r;
      if (!this.runs.has(rec.id)) this.runs.set(rec.id, rec);
      if (rec !== r) {
        this.tell(rec.id, "cut off by a restart");
        await this.saveRun(rec);
      }
    }
    const entries = await this.readDir("queue", (v) => (Array.isArray(v) ? (v.filter((e) => isRecord(e) && typeof e["id"] === "string") as LandEntry[]) : []));
    const had = new Set(this.entries.map((e) => e.id));
    this.entries = restartWorking([...this.entries, ...entries.filter((e) => !had.has(e.id))], this.now());
    for (const p of new Set(this.entries.map((e) => e.repoPath))) await this.saveQueue(p);
    await this.findOrphans();
    this.publish();
    for (const repoId of new Set(this.entries.map((e) => e.repoId))) this.kick(repoId);
    for (const r of this.runs.values()) if (r.state === "ready" && !r.review) this.track(this.resort(r.id).then(() => undefined));
  }

  /** Stops writing: the server is going down or gave the lock up. */
  detach(): void {
    this.keeping = false;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => this.retry(), this.deps.retryEvery ?? RETRY_EVERY);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Waiting entries look again: a busy checkout may have cleared. */
  retry(): void {
    const repos = new Set(this.entries.filter((e) => e.state === "waiting").map((e) => e.repoId));
    if (repos.size === 0) return;
    for (const repoId of repos) this.entries = retryWaiting(this.entries, repoId, this.now());
    this.publish();
    for (const repoId of repos) this.kick(repoId);
  }

  private async findOrphans(): Promise<void> {
    const known = new Set([...this.runs.values()].map((r) => r.dir));
    const out: LandingOrphan[] = [];
    for (const dir of await listRunTreeDirs(this.deps.worktrees ?? worktreesRoot())) {
      if (known.has(dir)) continue;
      const repoPath = await treeRepo(dir);
      const branch = repoPath ? await currentBranch(dir) : null;
      let queueable = false;
      if (repoPath && branch) {
        const target = await defaultBranch(repoPath);
        const clean = (await dirtyFiles(dir).catch(() => ["?"])).length === 0;
        queueable = clean && target !== null && (await aheadOf(dir, target)) > 0;
      }
      out.push({ dir, repoPath, branch, queueable });
    }
    this.orphans = out;
  }

  /* ---------- runs ---------- */

  /** Work started off an event, kept so `idle` can wait for it. */
  private track(p: Promise<void>): void {
    const kept = p.catch((err) => console.error(`landing: ${errText(err)}`));
    this.pending.add(kept);
    void kept.finally(() => this.pending.delete(kept));
  }

  /** Sorts a branch run again, after any sort of it still going, and keeps
   *  the result on its record. Null when it has no record or worktree, or
   *  the sort failed (which the log says). */
  private resort(id: string): Promise<RunReview | null> {
    const prev = this.sorting.get(id) ?? Promise.resolve(null);
    const next = prev.then(async (): Promise<RunReview | null> => {
      const rec = this.runs.get(id);
      if (!rec || !existsSync(rec.dir)) return null;
      try {
        const review = await (this.deps.sort ?? ((r: LandingRun, n: number) => sortRun(r, n, this.root)))(rec, this.now());
        const cur = this.runs.get(id);
        if (cur) {
          const upd = { ...cur, review };
          this.runs.set(id, upd);
          this.written.set(id, JSON.stringify(upd));
          void this.saveRun(upd);
          this.publish();
        }
        return review;
      } catch (err) {
        console.error(`landing: sorting ${rec.branch}: ${errText(err)}`);
        return null;
      }
    });
    this.sorting.set(id, next);
    void next.then(() => {
      if (this.sorting.get(id) === next) this.sorting.delete(id);
    });
    return next;
  }

  /** A fresh run settled ready: sorted, and in the queue on its own when
   *  the sort says `auto` and nobody queued it meanwhile. */
  private async settled(id: string): Promise<void> {
    const opening = this.runs.get(id);
    // a PR run lands on GitHub, never here (call 1)
    if (opening?.pr !== undefined) return;
    if (opening?.openPr) {
      this.tell(id, "branch ready, opening a PR");
      try {
        await this.deps.openPr?.(id);
      } catch (err) {
        // it waits as ready; the notice says why its PR did not open
        this.notice({ entry: id, repoId: opening.repoId, branch: opening.branch, note: opening.note, kind: "held", why: `its PR did not open: ${errText(err)}` });
        this.publish();
      }
      return;
    }
    const review = await this.resort(id);
    const rec = this.runs.get(id);
    if (review) this.tell(id, `branch ready, ${reviewWord(review)}`);
    if (!review || review.verdict !== "auto" || !rec || rec.state !== "ready") return;
    if (this.entries.some((e) => e.id === id) || this.deps.runActive(rec.runId)) return;
    this.entries = enqueue(this.entries, rec, this.now(), { auto: true }, this.deps.working?.(rec.repoId) ?? []);
    this.tell(id, "joined the queue on its own");
    void this.saveQueue(rec.repoPath);
    this.publish();
    this.kick(rec.repoId);
  }

  /** A "fix it" run settled ready: its entry rejoins the queue when the
   *  sort allows it (call 13), else the branch waits as ready with a notice. */
  private async rejoin(id: string): Promise<void> {
    const review = await this.resort(id);
    const rec = this.runs.get(id);
    const entry = this.entries.find((e) => e.id === id);
    if (review) this.tell(id, `fix ready, ${reviewWord(review)}`);
    if (!rec || !entry || inQueue(entry) || rec.state !== "ready") return;
    const ok = review ? rejoins(review, entry) : { ok: false as const, why: "its diff could not be sorted" };
    if (ok.ok) {
      this.entries = enqueue(this.entries, rec, this.now(), undefined, this.deps.working?.(rec.repoId) ?? []);
      this.tell(id, "back in the queue");
      this.kick(rec.repoId);
    } else {
      this.entries = unqueue(this.entries, id);
      this.notice({ entry: id, repoId: rec.repoId, branch: rec.branch, note: rec.note, kind: "held", why: ok.why });
    }
    void this.saveQueue(rec.repoPath);
    this.publish();
  }

  /** A run changed: a branch run's record follows it. A run that settles
   *  ready is sorted and may join on its own; a "fix it" run that settles
   *  ready may take its sent-back entry back into the queue. */
  onRun(run: Run): void {
    const b = run.branch;
    if (!b) return;
    const had = this.runs.get(b.origin);
    let rec = had;
    if (!rec) {
      const repo = this.deps.repo(run.repoId);
      if (!repo) return;
      rec = {
        id: b.origin,
        runId: run.id,
        repoId: run.repoId,
        repoPath: repo.path,
        branch: b.name,
        target: b.target,
        base: b.base,
        dir: b.dir,
        note: run.note,
        verb: run.verb,
        harness: run.harness,
        state: b.state,
        startedAt: run.startedAt,
        ...(b.openPr ? { openPr: true as const } : {}),
        ...(b.work ? { work: b.work } : {}),
      };
    }
    const next: LandingRun = {
      ...rec,
      runId: run.id,
      state: b.state,
      ...(run.session ? { session: run.session } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    };
    // a flow's step: the record follows it, but the branch is sorted only
    // once the flow is done and hands it over without the mark
    const ended = !isRunActive(run) && !b.held;
    const text = JSON.stringify(next);
    const changed = text !== this.written.get(next.id);
    let moved = changed;
    if (changed) {
      this.runs.set(next.id, next);
      this.written.set(next.id, text);
      void this.saveRun(next);
    }
    const entry = this.entries.find((e) => e.id === next.id);
    if (ended && entry?.fixing === run.id && next.state !== "working") {
      const { fixing: _f, ...rest } = entry;
      this.entries = this.entries.map((e) => (e.id === entry.id ? rest : e));
      if (next.state === "ready") this.track(this.rejoin(next.id));
      void this.saveQueue(next.repoPath);
      moved = true;
    } else if (ended && changed && !entry && next.state === "ready") {
      this.track(this.settled(next.id));
    }
    if (moved) this.publish();
  }

  /** A flow on a branch is done: its last step's run, carrying the branch as
   *  the flow read it (no longer held), settles as a branch run ending does.
   *  The record is written again even when nothing in it changed, since the
   *  held steps already wrote the same state without sorting it. */
  handOver(run: Run): void {
    if (!run.branch || run.branch.held || isRunActive(run)) return;
    this.written.delete(run.branch.origin);
    this.onRun(run);
  }

  /** What a branch run's worktree holds once it ends: ready when it has
   *  commits its target has not and nothing left over. */
  static async branchState(run: Run): Promise<RunBranchState> {
    return run.branch ? LandingHub.stateOf(run.branch) : "nothing";
  }

  /** What a branch's worktree holds, as `branchState` reads it for a run. */
  static async stateOf(b: RunBranch): Promise<RunBranchState> {
    const dirty = await dirtyFiles(b.dir).catch(() => null);
    if (dirty === null) return "nothing";
    if (dirty.length > 0) return "uncommitted";
    return (await aheadOf(b.dir, b.target)) > 0 ? "ready" : "nothing";
  }

  /* ---------- the queue ---------- */

  private find(id: string): LandingRun | undefined {
    return this.runs.get(id) ?? [...this.runs.values()].find((r) => r.runId === id);
  }

  /** A branch run's record, by the branch's id or its latest run's. */
  record(id: string): LandingRun | undefined {
    return this.find(id);
  }

  /** Checks a ready member in its existing worktree. This dry pass reads the
   *  main checkout's gates, settings and scenario set, and never queues,
   *  rebases or lands the branch. */
  async dryGates(origin: string): Promise<GroupDry> {
    const rec = this.find(origin);
    if (!rec) throw new Error("no branch by that id");
    if (rec.state !== "ready") throw new Error("only a ready branch can be dry-checked");
    const head = await revOf(rec.dir, "HEAD");
    if (!head) throw new Error("the branch worktree has no HEAD");

    const [gates, settings, set] = await Promise.all([
      readGates(rec.repoPath),
      readScenarioSettings(rec.repoPath),
      readScenarioSet(this.root, rec.repoPath),
    ]);
    let gateResult: GroupDry["gates"] = { ok: true };
    const changed = await git(rec.dir, ["diff", "--name-only", rec.base, head]);
    if (changed.code !== 0) throw new Error("could not inspect branch changes for setup");
    const changedPaths = changed.stdout.split("\n").filter(Boolean);
    if (gates.setup !== undefined && touchesLockfile(changedPaths)) {
      const setup = await this.deps.check(rec.dir, gates.setup);
      if (setup.exit !== 0) {
        gateResult = { ok: false, red: "setup", tail: tail(setup.output || `exited ${setup.exit ?? "on a signal"}`) };
      }
    }
    if (gateResult.ok) {
      for (const gate of gates.gates) {
        const result = await this.deps.check(rec.dir, gate.run);
        if (result.exit !== 0) {
          gateResult = { ok: false, red: gate.name, tail: tail(result.output || `exited ${result.exit ?? "on a signal"}`) };
          break;
        }
      }
    }

    let scenarios: ScenarioRun | undefined;
    if (gateResult.ok && (set.scenarios.length > 0 || set.errors.length > 0)) {
      scenarios = await runScenarioSet({
        dir: rec.dir,
        setDir: setDirOf(this.root, rec.repoPath),
        set,
        settings,
        run: this.deps.scenario,
        judge: this.deps.judge,
        ...(this.deps.evidence ? { evidence: this.deps.evidence } : {}),
        head,
        now: this.now(),
      });
      const ineligible = scenarios.results.find((result) =>
        (result.kind === "command" && !result.ok) ||
        (result.kind === "judge" && result.unjudged !== undefined),
      );
      if (ineligible) {
        const detail = ineligible.kind === "judge" ? ineligible.unjudged : ineligible.tail;
        gateResult = {
          ok: false,
          red: `${SCENARIO_GATE}${ineligible.name}`,
          ...(detail !== undefined ? { tail: detail } : {}),
        };
      }
    }

    const dry = { head, gates: gateResult, ...(scenarios ? { scenarios } : {}), minimum: settings.minimum };
    const current = this.runs.get(rec.id);
    if (!current) throw new Error("branch record disappeared during dry check");
    const updated = { ...current, dry };
    this.runs.set(updated.id, updated);
    this.written.set(updated.id, JSON.stringify(updated));
    await this.saveRun(updated);
    this.publish();

    return {
      branch: rec.branch,
      base: rec.base,
      head,
      gates: gateResult,
      ...(scenarios ? { scenarios: { score: scenarios.score, passed: scenarios.passed, total: scenarios.total } } : {}),
      minimum: settings.minimum,
    };
  }

  /** Why the queue has a branch, so it may not open a PR: queued or
   *  landed. A sent-back branch may; opening its PR takes it off the list. */
  queueHold(id: string): string | null {
    const e = this.entries.find((x) => x.id === (this.find(id)?.id ?? id));
    if (e && inQueue(e)) return "it is in the queue already";
    if (e?.state === "landed") return "it has landed already";
    return null;
  }

  /** Puts the PR a branch opened on its record, or takes it off (the PR
   *  closed: the run may land here again, and its pre-flight's "open a PR"
   *  is spent, so it never opens another on its own). A sent-back entry
   *  goes when the PR is put on. */
  markPr(id: string, pr: number | null): void {
    const rec = this.find(id);
    if (!rec) return;
    const { pr: _p, openPr: _o, ...rest } = rec;
    const next: LandingRun = pr === null ? rest : { ...rest, ...(rec.openPr ? { openPr: rec.openPr } : {}), pr };
    this.runs.set(rec.id, next);
    this.written.set(rec.id, JSON.stringify(next));
    void this.saveRun(next);
    if (pr !== null && this.entries.some((e) => e.id === rec.id && sentBack(e))) {
      this.entries = unqueue(this.entries, rec.id);
      void this.saveQueue(rec.repoPath);
    }
    this.publish();
  }

  /** A branch whose PR merged: its record goes. The PR hub removed the
   *  worktree and the branch already. */
  async forget(id: string): Promise<void> {
    const rec = this.find(id);
    if (!rec) return;
    await this.dropRun(rec.id);
    this.publish();
  }

  /** The checks "land" makes before it spends a sort: the run exists,
   *  has ended, is ready (or a restart stopped it), and is not queued or
   *  landed already. */
  private landable(id: string): LandingRun {
    const rec = this.find(id);
    if (!rec) throw new LandError("no branch run by that id", 404);
    if (rec.pr !== undefined) throw new LandError(`it opened PR #${rec.pr}; a run lands or opens a PR, never both`);
    const had = this.entries.find((e) => e.id === rec.id);
    if (this.deps.runActive(rec.runId) || (had?.fixing && this.deps.runActive(had.fixing))) throw new LandError("the run is still going; land it once it ends");
    if (rec.state !== "ready" && rec.state !== "stopped") throw new LandError(`only a ready run lands, or one a restart stopped with its work whole; this one is ${rec.state}`);
    if (had && inQueue(had)) throw new LandError("it is in the queue already");
    if (had?.state === "landed") throw new LandError("it has landed already");
    return rec;
  }

  /** "land" on a ready run: sorted again with the rules main holds now
   *  (call 14), then the end of its repo's queue. A run that needs an
   *  approval lands only with `approve`, the sensitive patch id the sheet
   *  showed, and the entry keeps it. A run a restart stopped lands the same
   *  way once its worktree, looked at now, is whole. */
  async land(id: string, approve?: string, skipJudge?: boolean): Promise<LandEntry> {
    if (skipJudge) {
      const key = this.find(id)?.id ?? id;
      this.entries = landAnyway(this.entries, key, this.now());
      for (const entry of this.entries) {
        if (entry.id !== key) continue;
        void this.saveQueue(entry.repoPath);
        this.publish();
        this.kick(entry.repoId);
        return entry;
      }
      throw new LandError("no entry by that id", 404);
    }
    const rec = this.landable(id);
    if (rec.state === "stopped") {
      const whole = await wholeOf(rec);
      if (!whole.ok) {
        this.whole.set(rec.id, whole);
        this.publish();
        throw new LandError(`a restart stopped it and it cannot land: ${whole.why}`);
      }
    }
    const review = await this.resort(rec.id);
    if (!review) throw new LandError("its diff could not be sorted; the log says why");
    canLand(review, approve);
    // a second "land" may have queued it while this one sorted
    const cur = this.landable(rec.id);
    const flags: QueueFlags = review.verdict === "approve" && approve ? { approved: approve } : {};
    // a stopped run found whole joins as a ready one; its record stays stopped
    this.entries = enqueue(this.entries, { ...cur, state: "ready" }, this.now(), flags, this.deps.working?.(cur.repoId) ?? []);
    this.tell(cur.id, "queued to land");
    void this.saveQueue(cur.repoPath);
    this.publish();
    this.kick(cur.repoId);
    return this.entries.find((e) => e.id === cur.id)!;
  }

  /** "land all" in one repo: every ready run that needs no approval joins
   *  the queue, each sorted again first; the ones that need it are named. */
  async landAll(repoId: string): Promise<{ queued: string[]; skipped: { id: string; branch: string; why: string }[] }> {
    const has = new Set(this.entries.filter((e) => e.repoId === repoId).map((e) => e.id));
    const ready = [...this.runs.values()].filter((r) => r.repoId === repoId && r.state === "ready" && r.pr === undefined && !has.has(r.id) && !this.deps.runActive(r.runId));
    const queued: string[] = [];
    const skipped: { id: string; branch: string; why: string }[] = [];
    for (const r of ready.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))) {
      const review = await this.resort(r.id);
      if (!review || review.verdict === "approve") {
        skipped.push({ id: r.id, branch: r.branch, why: review ? reviewWord(review) : "its diff could not be sorted" });
        continue;
      }
      try {
      this.entries = enqueue(this.entries, this.runs.get(r.id) ?? r, this.now(), {}, this.deps.working?.(r.repoId) ?? []);
        this.tell(r.id, "queued to land");
        queued.push(r.id);
      } catch (err) {
        skipped.push({ id: r.id, branch: r.branch, why: errText(err) });
      }
    }
    if (queued.length > 0) {
      void this.saveQueue(ready[0]!.repoPath);
      this.publish();
      this.kick(repoId);
    }
    return { queued, skipped };
  }

  /** "fix it" on a sent-back entry: a run on the same branch that resumes
   *  the last session with the reason. It rejoins the queue when it settles
   *  ready. */
  async fix(id: string): Promise<Run> {
    const rec = this.find(id);
    const entry = rec && this.entries.find((e) => e.id === rec.id);
    if (!rec || !entry) throw new LandError("no sent-back entry by that id", 404);
    if (!sentBack(entry)) throw new LandError(`it is ${entry.state}, not sent back`);
    if (entry.fixing && this.deps.runActive(entry.fixing)) throw new LandError("a fix is going already");
    const run = await this.deps.startFix(rec, entry);
    this.entries = this.entries.map((e) => (e.id === entry.id ? { ...e, fixing: run.id, updatedAt: this.now() } : e));
    this.tell(rec.id, `fix started: ${landWord(entry, this.entries)}`);
    void this.saveQueue(rec.repoPath);
    this.publish();
    return run;
  }

  /** Drops a sent-back entry, its branch and its worktree: the work is
   *  given up. Not a branch whose PR is open and watched: the watch works
   *  in that worktree, and the PR is closed from its run's sheet. */
  async drop(id: string): Promise<void> {
    const rec = this.find(id);
    if (rec?.pr !== undefined && this.deps.prHeld?.(rec.id)) throw new LandError(`PR #${rec.pr} is open and canopy watches it; close the PR from its run's sheet first`);
    const entry = this.entries.find((e) => e.id === (rec?.id ?? id));
    if (entry && inQueue(entry) && entry.state !== "judge") throw new LandError("it is in the queue; wait for it to land or come back");
    if (rec && this.deps.runActive(rec.runId)) throw new LandError("the run is still going");
    const target = rec ?? entry;
    if (!target) throw new LandError("nothing by that id", 404);
    await removeRunTree(target.repoPath, target.dir, target.branch);
    this.entries = this.entries.filter((e) => e.id !== target.id);
    this.end(target.id, "dropped", "dropped with its worktree");
    await this.dropRun(target.id);
    await this.saveQueue(target.repoPath);
    this.deps.dropped?.(target.id);
    this.publish();
  }

  /** An orphaned worktree: removed, or queued as a run of its own. */
  async orphan(dir: string, action: "remove" | "queue"): Promise<void> {
    const o = this.orphans.find((x) => x.dir === dir);
    if (!o) throw new LandError("no orphaned worktree there", 404);
    if (action === "remove") {
      if (o.repoPath) await removeRunTree(o.repoPath, dir, o.branch ?? undefined);
      else await rm(dir, { recursive: true, force: true });
      this.orphans = this.orphans.filter((x) => x.dir !== dir);
      this.publish();
      return;
    }
    if (!o.queueable || !o.repoPath || !o.branch) throw new LandError("only a clean worktree with commits can be queued");
    const repo = this.deps.repoByPath(o.repoPath);
    if (!repo) throw new LandError(`${o.repoPath} is not in the tree`);
    const target = await defaultBranch(o.repoPath);
    if (!target) throw new LandError("its repo has no main or master to land on");
    const id = SAFE_ID.test(basename(dir)) ? basename(dir) : crypto.randomUUID().slice(0, 8);
    const rec: LandingRun = {
      id,
      runId: id,
      repoId: repo.id,
      repoPath: o.repoPath,
      branch: o.branch,
      target,
      base: (await git(o.repoPath, ["merge-base", target, o.branch])).stdout.trim() || target,
      dir,
      note: `orphaned worktree ${basename(dir)}`,
      verb: "orphan",
      harness: "claude",
      state: "ready",
      startedAt: this.now(),
    };
    this.runs.set(id, rec);
    await this.saveRun(rec);
    this.orphans = this.orphans.filter((x) => x.dir !== dir);
    await this.land(id);
  }

  /** Works a repo's queue, one loop at a time; a kick while it runs asks
   *  for another pass after it. */
  kick(repoId: string): void {
    if (this.stopped) return;
    if (this.loops.has(repoId)) {
      this.again.add(repoId);
      return;
    }
    const loop = (async () => {
      do {
        this.again.delete(repoId);
        await this.work(repoId).catch((err) => console.error(`landing: ${repoId}: ${errText(err)}`));
      } while (this.again.has(repoId) && !this.stopped);
    })().finally(() => this.loops.delete(repoId));
    this.loops.set(repoId, loop);
  }

  /** Resolves once every loop, sort and join running now is done, for
   *  tests and shutdown. */
  async idle(): Promise<void> {
    while (this.loops.size + this.pending.size + this.sorting.size > 0) await Promise.all([...this.loops.values(), ...this.pending, ...this.sorting.values()]);
  }

  private update(e: LandEntry): LandEntry {
    this.entries = this.entries.map((x) => (x.id === e.id ? e : x));
    if (e.state === "landed") this.entries = pruneLanded(this.entries);
    void this.saveQueue(e.repoPath);
    this.publish();
    return e;
  }

  private step(e: LandEntry, ev: LandEvent): LandEntry {
    return this.update(advance(e, ev, this.now()));
  }

  private async work(repoId: string): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const e = nextEntry(this.entries, repoId);
      if (!e) return;
      const cur = await currentBranch(e.repoPath);
      if (cur !== e.target) {
        this.entries = holdAll(this.entries, repoId, `checkout not on ${e.target}`, this.now());
        void this.saveQueue(e.repoPath);
        this.publish();
        return;
      }
      let gates: Gates;
      let scen: { set: ScenarioSet; settings: ScenarioSettings };
      try {
        gates = await readGates(e.repoPath);
        scen = { settings: await readScenarioSettings(e.repoPath), set: await readScenarioSet(this.root, e.repoPath) };
      } catch (err) {
        this.entries = holdAll(this.entries, repoId, errText(err), this.now());
        void this.saveQueue(e.repoPath);
        this.publish();
        return;
      }
      await this.turn(e, gates, scen);
    }
  }

  /** Why an entry may not land as rebased, or null: one that joined on
   *  its own must still sort `auto`, and one that needs an approval must
   *  still carry the id Eric approved. */
  private async recheck(e: LandEntry): Promise<string | null> {
    if (!this.runs.has(e.id)) return null;
    const review = await this.resort(e.id);
    if (!review) return "its diff could not be sorted after the rebase";
    if (e.auto && review.verdict !== "auto") return `after the rebase it ${reviewWord(review)}`;
    if (review.verdict === "approve" && e.approved !== review.sensitiveId) {
      return e.approved ? "the sensitive files changed since you approved them; look again" : `after the rebase it ${reviewWord(review)}`;
    }
    return null;
  }

  /** One entry's turn: rebase, setup, gates, scenarios, fast-forward. */
  private async turn(start: LandEntry, gates: Gates, { set, settings }: { set: ScenarioSet; settings: ScenarioSettings }): Promise<void> {
    const commands = set.scenarios.filter((s) => s.kind === "command");
    let e = this.step(start, { t: "begin" });
    for (;;) {
      const head = await revOf(e.repoPath, "HEAD");
      const before = await revOf(e.dir, "HEAD");
      if (!head || !before) {
        this.step(e, { t: "hold", why: !head ? "the main checkout has no HEAD" : "the worktree is gone" });
        return;
      }
      const rb = await rebaseOnto(e.dir, head);
      if ("conflict" in rb) {
        const sentBack = this.step(e, { t: "conflict", files: rb.conflict });
        this.tell(sentBack.id, `sent back: conflict in ${rb.conflict.length} file${rb.conflict.length === 1 ? "" : "s"}`);
        return;
      }
      if ("error" in rb) {
        this.step(e, { t: "hold", why: `rebase failed: ${rb.error}` });
        return;
      }
      // sorted again on the new main with the rules it holds now (call 2):
      // rules may have narrowed since the run settled
      const held = await this.recheck(e);
      if (held) {
        this.entries = unqueue(this.entries, e.id);
        this.notice({ entry: e.id, repoId: e.repoId, branch: e.branch, note: e.note, kind: "held", why: held });
        void this.saveQueue(e.repoPath);
        this.publish();
        return;
      }
      const after = await revOf(e.dir, "HEAD");
      const moved = after && after !== before ? (await git(e.dir, ["diff", "--name-only", before, after])).stdout.split("\n").filter(Boolean) : [];
      const setup = gates.setup !== undefined && touchesLockfile(moved);
      const first = gates.gates[0]?.name ?? null;
      e = this.step(e, { t: "rebased", setup, first, noGates: gates.source === "none" && set.scenarios.length === 0 && set.errors.length === 0 });
      if (e.state === "setup" && gates.setup) {
        const r = await this.deps.check(e.dir, gates.setup);
        if (r.exit !== 0) {
          const sentBack = this.step(e, { t: "red", gate: "setup", output: r.output });
          this.tell(sentBack.id, "sent back: setup failed");
          return;
        }
        e = this.step(e, { t: "set-up", first });
      }
      for (let i = 0; e.state === "gate"; i++) {
        const g = gates.gates[i]!;
        const r = await this.deps.check(e.dir, g.run);
        if (r.exit !== 0) {
          const sentBack = this.step(e, { t: "red", gate: g.name, output: r.output || `exited ${r.exit ?? "on a signal"}` });
          this.tell(sentBack.id, `sent back: ${g.name} failed`);
          return;
        }
        e = this.step(e, { t: "gate-ok", next: gates.gates[i + 1]?.name ?? null });
      }
      // the holdout scenarios (FR-032) run on a copy of the set the run never
      // saw; a broken file is the first red, commands precede judges.
      const firstScenario = set.errors[0]?.file ?? commands[0]?.name ?? set.scenarios.find(s => s.kind === "judge")?.name;
      if (e.state === "landing" && firstScenario !== undefined) {
        e = this.step(e, { t: "scenarios", first: firstScenario });
        let pass: ScenarioRun;
        try {
          pass = await runScenarioSet({
            dir: e.dir,
            setDir: setDirOf(this.root, e.repoPath),
            set,
            settings,
            run: this.deps.scenario,
            judge: this.deps.judge,
            ...(this.deps.evidence ? { evidence: this.deps.evidence } : {}),
            skipJudge: e.skipJudge === true,
            head: after ?? "",
            now: this.now(),
            onDone: (r, next) => {
              if (r.ok || r.kind === "judge") e = this.step(e, { t: "scenario-ok", next });
            },
          });
        } catch (err) {
          this.step(e, { t: "hold", why: `scenarios could not run: ${errText(err)}` });
          return;
        }
        const rec = this.runs.get(e.id);
        if (rec) {
          const upd = { ...rec, scenarios: pass };
          this.runs.set(e.id, upd);
          this.written.set(e.id, JSON.stringify(upd));
          void this.saveRun(upd);
        }
        const red = pass.results.find((r) => r.kind === "command" && !r.ok);
        if (red) {
          const gate = SCENARIO_GATE + red.name;
          const sentBack = this.step(e, { t: "red", gate, output: red.tail ?? "" });
          this.tell(sentBack.id, `sent back: ${gate} failed`);
          return;
        }
        const unjudged = pass.results.find(r => r.unjudged !== undefined);
        if (unjudged?.unjudged !== undefined) {
          this.step(e, { t: "unjudged", name: unjudged.name, why: unjudged.unjudged });
          return;
        }
        if (pass.score < settings.minimum) {
          const gate = scoreGate(pass.score, settings.minimum);
          const sentBack = this.step(e, { t: "red", gate, output: scoreOutput(pass.results) });
          this.tell(sentBack.id, `sent back: ${gate} failed`);
          return;
        }
      }
      if ((await currentBranch(e.repoPath)) !== e.target) {
        this.step(e, { t: "hold", why: `checkout not on ${e.target}` });
        return;
      }
      if ((await revOf(e.repoPath, "HEAD")) !== head) {
        e = this.step(e, { t: "moved" });
        if (e.state === "moved") {
          this.tell(e.id, "sent back: main kept moving");
          return;
        }
        continue;
      }
      // a server going down lands nothing more: the next start takes the
      // entry's turn again from the rebase
      if (this.stopped) return;
      const ff = await ffMain(e.repoPath, e.branch);
      if ("busy" in ff) {
        this.step(e, { t: "busy", files: ff.busy });
        return;
      }
      if ("moved" in ff) {
        e = this.step(e, { t: "moved" });
        if (e.state === "moved") {
          this.tell(e.id, "sent back: main kept moving");
          return;
        }
        continue;
      }
      if ("error" in ff) {
        this.step(e, { t: "hold", why: ff.error });
        return;
      }
      const landed = (await revOf(e.repoPath, "HEAD")) ?? after ?? "";
      this.step(e, { t: "landed", head: landed });
      if (e.auto) this.notice({ entry: e.id, repoId: e.repoId, branch: e.branch, note: e.note, kind: "landed", head: landed });
      this.end(e.id, "landed", `landed on ${e.target}`);
      await removeRunTree(e.repoPath, e.dir, e.branch);
      await this.dropRun(e.id);
      this.publish();
      return;
    }
  }

  /** One file's diff as the run's latest sort saw it, for the approve
   *  sheet. Only a path the sort listed (call 15), so the route never reads
   *  any other file. */
  async diff(id: string, path: string): Promise<{ path: string; diff: string }> {
    const rec = this.find(id);
    if (!rec) throw new LandError("no branch run by that id", 404);
    const f = rec.review?.files.find((x) => x.path === path);
    if (!rec.review || !f) throw new LandError("that file is not in the run's sorted diff", 404);
    const paths = f.from !== undefined ? [f.from, f.path] : [f.path];
    const r = await git(rec.dir, ["diff", "--no-ext-diff", "--no-textconv", rec.review.base, rec.review.head, "--", ...paths], 60_000);
    if (r.code !== 0) throw new LandError(`git diff: ${r.stderr.trim().split("\n").pop() ?? `exited ${r.code}`}`, 500);
    return { path, diff: r.stdout };
  }

  /** Whether anything is mid-turn: the server's shutdown can say so. */
  busy(): boolean {
    return this.entries.some((e) => WORKING.has(e.state));
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith("/api/landing")) return null;
    try {
      if (path === "/api/landing" && req.method === "GET") {
        await this.lookStopped();
        return json(this.info());
      }
      if (path === "/api/landing/diff" && req.method === "GET") {
        const id = url.searchParams.get("id");
        const file = url.searchParams.get("path");
        if (!id || !file) return json({ error: "id and path are required" }, 400);
        return json(await this.diff(id, file));
      }
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body)) return json({ error: "malformed body" }, 400);
      if (path === "/api/landing/land") {
        if (typeof body["run"] !== "string") return json({ error: "run is required" }, 400);
        const approve = body["approve"];
        if (approve !== undefined && typeof approve !== "string") return json({ error: "approve must be the id the sheet showed" }, 400);
        const skipJudge = body["skipJudge"];
        if (skipJudge !== undefined && typeof skipJudge !== "boolean") return json({ error: "skipJudge must be true or false" }, 400);
        return json(await this.land(body["run"], approve, skipJudge === true));
      }
      if (path === "/api/landing/land-all") {
        if (typeof body["repo"] !== "string") return json({ error: "repo is required" }, 400);
        return json(await this.landAll(body["repo"]));
      }
      if (path === "/api/landing/seen") {
        const ids = body["ids"];
        if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return json({ error: "ids must be a list" }, 400);
        this.seen(ids as string[]);
        return json({ ok: true });
      }
      if (path === "/api/landing/fix") {
        if (typeof body["id"] !== "string") return json({ error: "id is required" }, 400);
        return json(await this.fix(body["id"]), 201);
      }
      if (path === "/api/landing/drop") {
        if (typeof body["id"] !== "string") return json({ error: "id is required" }, 400);
        await this.drop(body["id"]);
        return json({ ok: true });
      }
      if (path === "/api/landing/orphan") {
        const action = body["action"];
        if (typeof body["dir"] !== "string" || (action !== "remove" && action !== "queue")) return json({ error: "dir and an action of remove or queue are required" }, 400);
        await this.orphan(body["dir"], action);
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      // a fix's start answers in the run routes' own errors, which carry a status
      const status = (err as { status?: unknown } | null)?.status;
      return json({ error: errText(err) }, typeof status === "number" ? status : 500);
    }
  }
}
