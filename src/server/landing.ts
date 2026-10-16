/** The landing queue's server half (FR-012): the branch run records, one
 *  loop per repo that lands queued entries one at a time, the routes, and
 *  the `landing` event. The model and its words are `core/landing.ts`; the
 *  git is `core/worktree.ts`; the gates are `core/gates.ts`.
 *
 *  Records live under `<configDir>/landing/`: `runs/<id>.json` per branch
 *  run and `queue/<repo key>.json` per repo. Only the server holding the
 *  flows lock writes them (`adopt`), so two canopies on one config dir never
 *  both work one queue. The queue never pushes. */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readGates, touchesLockfile, type Gates } from "../core/gates";
import { advance, enqueue, holdAll, inQueue, LandError, nextEntry, pruneLanded, restartWorking, retryWaiting, sentBack, WORKING, type LandEvent } from "../core/landing";
import { configDir } from "../core/store";
import type { LandEntry, LandingInfo, LandingOrphan, LandingRun, Repo, Run, RunBranchState, ServerEvent } from "../core/types";
import { isRunActive } from "../core/types";
import { git } from "../core/exec";
import { aheadOf, currentBranch, defaultBranch, dirtyFiles, ffMain, listRunTreeDirs, rebaseOnto, removeRunTree, repoKey, revOf, treeRepo, worktreesRoot } from "../core/worktree";

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
  dir?: string;
  worktrees?: string;
  now?: () => number;
  retryEvery?: number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class LandingHub {
  private runs = new Map<string, LandingRun>();
  private entries: LandEntry[] = [];
  private orphans: LandingOrphan[] = [];
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

  constructor(private deps: LandingDeps) {}

  private get dir(): string {
    return this.deps.dir ?? landingDir();
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  info(): LandingInfo {
    return { runs: [...this.runs.values()], entries: this.entries, orphans: this.orphans };
  }

  private publish(): void {
    this.deps.broadcast({ type: "landing", landing: this.info() });
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

  /** Resolves once every record write asked for so far is on disk. */
  async flushed(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
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
   *  an entry cut off mid-turn starts its turn again, and a run worktree no
   *  record names is an orphan. Writes from now on. */
  async adopt(): Promise<void> {
    this.keeping = true;
    const runs = await this.readDir("runs", (v) => (isRecord(v) && typeof v["id"] === "string" ? [v as unknown as LandingRun] : []));
    for (const r of runs) {
      const rec = r.state === "working" ? { ...r, state: "stopped" as const } : r;
      if (!this.runs.has(rec.id)) this.runs.set(rec.id, rec);
      if (rec !== r) await this.saveRun(rec);
    }
    const entries = await this.readDir("queue", (v) => (Array.isArray(v) ? (v.filter((e) => isRecord(e) && typeof e["id"] === "string") as LandEntry[]) : []));
    const known = new Set(this.entries.map((e) => e.id));
    this.entries = restartWorking([...this.entries, ...entries.filter((e) => !known.has(e.id))], this.now());
    for (const p of new Set(this.entries.map((e) => e.repoPath))) await this.saveQueue(p);
    await this.findOrphans();
    this.publish();
    for (const repoId of new Set(this.entries.map((e) => e.repoId))) this.kick(repoId);
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

  /** A run changed: a branch run's record follows it. When a "fix it" run
   *  settles ready, its sent-back entry rejoins the queue at the end. */
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
      };
    }
    const next: LandingRun = {
      ...rec,
      runId: run.id,
      state: b.state,
      ...(run.session ? { session: run.session } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    };
    const ended = !isRunActive(run);
    const text = JSON.stringify(next);
    let moved = text !== this.written.get(next.id);
    if (moved) {
      this.runs.set(next.id, next);
      this.written.set(next.id, text);
      void this.saveRun(next);
    }
    const entry = this.entries.find((e) => e.id === next.id);
    if (ended && entry?.fixing === run.id && next.state !== "working") {
      const { fixing: _f, ...rest } = entry;
      this.entries = this.entries.map((e) => (e.id === entry.id ? rest : e));
      if (next.state === "ready") {
        this.entries = enqueue(this.entries, next, this.now());
        this.kick(next.repoId);
      }
      void this.saveQueue(next.repoPath);
      moved = true;
    }
    if (moved) this.publish();
  }

  /** What a branch run's worktree holds once it ends: ready when it has
   *  commits its target has not and nothing left over. */
  static async branchState(run: Run): Promise<RunBranchState> {
    const b = run.branch;
    if (!b) return "nothing";
    const dirty = await dirtyFiles(b.dir).catch(() => null);
    if (dirty === null) return "nothing";
    if (dirty.length > 0) return "uncommitted";
    return (await aheadOf(b.dir, b.target)) > 0 ? "ready" : "nothing";
  }

  /* ---------- the queue ---------- */

  private find(id: string): LandingRun | undefined {
    return this.runs.get(id) ?? [...this.runs.values()].find((r) => r.runId === id);
  }

  /** "land" on a ready run: the end of its repo's queue. */
  land(id: string): LandEntry {
    const rec = this.find(id);
    if (!rec) throw new LandError("no branch run by that id", 404);
    const fixing = this.entries.find((e) => e.id === rec.id)?.fixing;
    if (this.deps.runActive(rec.runId) || (fixing && this.deps.runActive(fixing))) throw new LandError("the run is still going; land it once it ends");
    this.entries = enqueue(this.entries, rec, this.now());
    void this.saveQueue(rec.repoPath);
    this.publish();
    this.kick(rec.repoId);
    return this.entries.find((e) => e.id === rec.id)!;
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
    void this.saveQueue(rec.repoPath);
    this.publish();
    return run;
  }

  /** Drops a sent-back entry, its branch and its worktree: the work is
   *  given up. */
  async drop(id: string): Promise<void> {
    const rec = this.find(id);
    const entry = this.entries.find((e) => e.id === (rec?.id ?? id));
    if (entry && inQueue(entry)) throw new LandError("it is in the queue; wait for it to land or come back");
    if (rec && this.deps.runActive(rec.runId)) throw new LandError("the run is still going");
    const target = rec ?? entry;
    if (!target) throw new LandError("nothing by that id", 404);
    await removeRunTree(target.repoPath, target.dir, target.branch);
    this.entries = this.entries.filter((e) => e.id !== target.id);
    await this.dropRun(target.id);
    await this.saveQueue(target.repoPath);
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
    this.land(id);
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

  /** Resolves once every loop running now is done, for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.loops.size > 0) await Promise.all([...this.loops.values()]);
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
      try {
        gates = await readGates(e.repoPath);
      } catch (err) {
        this.entries = holdAll(this.entries, repoId, errText(err), this.now());
        void this.saveQueue(e.repoPath);
        this.publish();
        return;
      }
      await this.turn(e, gates);
    }
  }

  /** One entry's turn: rebase, setup, gates, fast-forward. */
  private async turn(start: LandEntry, gates: Gates): Promise<void> {
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
        this.step(e, { t: "conflict", files: rb.conflict });
        return;
      }
      if ("error" in rb) {
        this.step(e, { t: "hold", why: `rebase failed: ${rb.error}` });
        return;
      }
      const after = await revOf(e.dir, "HEAD");
      const moved = after && after !== before ? (await git(e.dir, ["diff", "--name-only", before, after])).stdout.split("\n").filter(Boolean) : [];
      const setup = gates.setup !== undefined && touchesLockfile(moved);
      const first = gates.gates[0]?.name ?? null;
      e = this.step(e, { t: "rebased", setup, first, noGates: gates.source === "none" });
      if (e.state === "setup" && gates.setup) {
        const r = await this.deps.check(e.dir, gates.setup);
        if (r.exit !== 0) {
          this.step(e, { t: "red", gate: "setup", output: r.output });
          return;
        }
        e = this.step(e, { t: "set-up", first });
      }
      for (let i = 0; e.state === "gate"; i++) {
        const g = gates.gates[i]!;
        const r = await this.deps.check(e.dir, g.run);
        if (r.exit !== 0) {
          this.step(e, { t: "red", gate: g.name, output: r.output || `exited ${r.exit ?? "on a signal"}` });
          return;
        }
        e = this.step(e, { t: "gate-ok", next: gates.gates[i + 1]?.name ?? null });
      }
      if ((await currentBranch(e.repoPath)) !== e.target) {
        this.step(e, { t: "hold", why: `checkout not on ${e.target}` });
        return;
      }
      if ((await revOf(e.repoPath, "HEAD")) !== head) {
        e = this.step(e, { t: "moved" });
        if (e.state === "moved") return;
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
        if (e.state === "moved") return;
        continue;
      }
      if ("error" in ff) {
        this.step(e, { t: "hold", why: ff.error });
        return;
      }
      const landed = (await revOf(e.repoPath, "HEAD")) ?? after ?? "";
      this.step(e, { t: "landed", head: landed });
      await removeRunTree(e.repoPath, e.dir, e.branch);
      await this.dropRun(e.id);
      this.publish();
      return;
    }
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
      if (path === "/api/landing" && req.method === "GET") return json(this.info());
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body)) return json({ error: "malformed body" }, 400);
      if (path === "/api/landing/land") {
        if (typeof body["run"] !== "string") return json({ error: "run is required" }, 400);
        return json(this.land(body["run"]));
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
