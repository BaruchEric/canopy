/** The worktrees kept by hand (FR-051): the record per repo under
 *  `<configDir>/trees/<repo key>/trees.json`, making a tree and preparing it
 *  in the background (the main checkout's ignored entries cloned in, then
 *  the repo's setup line), merging one into its base in the background
 *  (worktrunk's `wt merge`), cleaning up the merged ones, removing one, and
 *  the list with each tree's live counts. `GET /api/trees` needs read, the
 *  POSTs operate. Changes publish on the `trees` event; the main checkout's
 *  own event (a commit in a tree moves refs in the common git dir) brings a
 *  fresh list too. */

import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  addBranchTree,
  copyIgnored,
  dressTreeCards,
  EMPTY_TREES,
  ignoredEntries,
  isBranchName,
  listTreeDirs,
  mergeTree,
  parseTreesRecord,
  removeBranchTree,
  syncTree,
  TREE_PORTS_DEFAULT,
  treeDir,
  treePort,
  treePorts,
  treeSlug,
  treePortsFor,
  treeStatus,
  treesRoot,
  TREES_RECORD,
  type BranchTreeRecord,
  type MergeOptions,
  type MergeOutcome,
  type TreesRecord,
} from "../core/branchtrees";
import { git } from "../core/exec";
import { cleanable, isTreeCard, removeRefusal } from "../core/treewords";
import { parseWorktreeList } from "../core/git";
import type { BranchTree, BranchTreeRepo, BranchTreesInfo, Repo, ServerEvent } from "../core/types";
import { defaultBranch, midRebase, repoKey, revOf } from "../core/worktree";

/** a tree a clean-up removed */
export interface CleanedTree {
  repoId: string;
  slug: string;
  branch: string;
}

export interface TreesDeps {
  root?: string;
  /** the repos this backend scans; only local ones get trees */
  repos: () => Repo[];
  /** the repo's gates file: its setup line, and the gates a merge runs */
  gates: (path: string) => Promise<{ setup?: string; gates?: { name: string; run: string }[] }>;
  /** runs a setup line, or a gate, in the tree under the gate environment */
  setup: (dir: string, line: string) => Promise<{ exit: number | null; output: string }>;
  /** the ports something listens on now, so a tree's is not one of them */
  listening: () => Promise<number[]>;
  /** live shells sitting in a folder */
  shellsIn: (dir: string) => number;
  /** ends the tasks running in a tree before its folder goes */
  stopTree?: (dir: string) => Promise<unknown>;
  /** of these tree folders, the ones something is at work in, each with
   *  what in words ("bun test"); a tree that follows waits on it. Left out,
   *  or failing, nothing is taken to be at work. */
  working?: (dirs: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  broadcast: (ev: ServerEvent) => void;
  /** the port range, in place of `CANOPY_TREE_PORTS` */
  ports?: number[];
  portsSpec?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** how often the list is read again while trees exist; 0 never */
  every?: number;
}

/** why a request is refused, with the status it answers */
export class TreesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** the main checkout's event comes in bursts; one list after each */
const TOUCH_DELAY = 1_500;
const TICK = 60_000;
const WHY_CAP = 2_000;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const tail = (text: string): string => (text.length > WHY_CAP ? `…${text.slice(-WHY_CAP)}` : text);
const real = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
/** the record entry once its preparation ended: ready, or failed with why;
 *  what stopped a merge or sync is left behind */
const settled = (t: BranchTreeRecord, why: string): BranchTreeRecord => {
  const { slug, branch, base, port, madeAt, caches, sync, syncedTo } = t;
  const kept = { slug, branch, base, port, madeAt, caches, sync, ...(syncedTo ? { syncedTo } : {}) };
  return why ? { ...kept, state: "failed", why: tail(why) } : { ...kept, state: "ready" };
};
const SYNC_NOTE = "sync stopped: ";

export class BranchTrees {
  private readonly root: string;
  private readonly ports: number[];
  private readonly records = new Map<string, TreesRecord>();
  /** the ports tasks hold, by the task's term id; `takenPorts` counts them,
   *  so a tree and a task never get the same one */
  private readonly held = new Map<string, number[]>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** the preparations and merges running in the background */
  private readonly jobs = new Set<Promise<void>>();
  private readonly touches = new Map<string, ReturnType<typeof setTimeout>>();
  /** what each tree's following waits on, by the tree's folder; in memory
   *  only, since the next pass asks again */
  private readonly waits = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private publishing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TreesDeps) {
    this.root = resolve(deps.root ?? treesRoot());
    this.ports = deps.ports ?? treePorts();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private repoDir(path: string): string {
    return join(this.root, repoKey(path));
  }
  private recordPath(path: string): string {
    return join(this.repoDir(path), TREES_RECORD);
  }
  private record(path: string): TreesRecord {
    return this.records.get(path) ?? EMPTY_TREES;
  }
  private local(): Repo[] {
    return this.deps.repos().filter((r) => !r.host && isAbsolute(r.path));
  }
  private async save(path: string, rec: TreesRecord): Promise<void> {
    this.records.set(path, rec);
    await mkdir(this.repoDir(path), { recursive: true });
    await writeFile(this.recordPath(path), `${JSON.stringify(rec, null, 2)}\n`);
  }
  /** one change at a time per repo: two adds of one branch cannot both pass the checks */
  private serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(path, next.catch(() => {}));
    return next;
  }
  private takenPorts(): Set<number> {
    const taken = new Set<number>();
    for (const rec of this.records.values()) for (const t of rec.trees) if (t.port !== null) taken.add(t.port);
    for (const ports of this.held.values()) for (const p of ports) taken.add(p);
    return taken;
  }
  private async allot(branch: string): Promise<number | null> {
    const listening = await this.deps.listening().catch((): number[] => []);
    return treePort(branch, this.ports, new Set([...this.takenPorts(), ...listening]));
  }

  /** `count` ports for a task, kept for it until `release`; null when the
   *  range has too few. An owner already holding that many keeps them. The
   *  pick and the write share one synchronous stretch after the only await,
   *  which is what keeps two holds at once apart. */
  async hold(owner: string, key: string, count: number): Promise<number[] | null> {
    const have = this.held.get(owner);
    if (have?.length === count) return have;
    const listening = await this.deps.listening().catch((): number[] => []);
    const again = this.held.get(owner);
    if (again?.length === count) return again;
    this.held.delete(owner);
    const got = treePortsFor(key, count, this.ports, new Set([...this.takenPorts(), ...listening]));
    if (got !== null) this.held.set(owner, got);
    return got;
  }

  /** what a task held goes back to the range */
  release(owner: string): void {
    this.held.delete(owner);
  }

  /** a hold read back from a task's record after a restart */
  seed(owner: string, ports: readonly number[]): void {
    this.held.set(owner, [...ports]);
  }

  /** The records read back and squared with the disk: a record whose
   *  folder is gone, or that git no longer lists as a worktree, is dropped;
   *  a worktree under the repo's trees folder with no record is adopted on
   *  its branch, with the default branch as its base. */
  async adopt(): Promise<void> {
    for (const repo of this.local()) {
      const file = this.recordPath(repo.path);
      const rec = existsSync(file) ? parseTreesRecord(await readFile(file, "utf8")) : EMPTY_TREES;
      const dirs = await listTreeDirs(repo.path, this.root);
      if (rec.trees.length === 0 && dirs.length === 0) continue;
      const list = await git(repo.path, ["worktree", "list", "--porcelain"]);
      const listed = new Map<string, string | null>();
      for (const w of (list.code === 0 ? parseWorktreeList(list.stdout) : []).slice(1)) {
        if (!w.bare && !w.prunable) listed.set(await real(w.path), w.branch);
      }
      const kept: BranchTreeRecord[] = [];
      let changed = false;
      for (const t of rec.trees) {
        const dir = treeDir(repo.path, t.slug, this.root);
        if (!dirs.includes(dir) || !listed.has(await real(dir))) {
          changed = true;
          continue;
        }
        if (t.state === "merging") {
          // the server went down mid-merge: a rebase left open is aborted,
          // and the tree says so until the merge is run again
          if (await midRebase(dir)) await git(dir, ["rebase", "--abort"]);
          kept.push({ ...settled(t, ""), stopped: "merge stopped: the server restarted during the merge; merge again" });
          changed = true;
        } else kept.push(t);
      }
      for (const dir of dirs) {
        const slug = basename(dir);
        if (kept.some((t) => t.slug === slug)) continue;
        const branch = listed.get(await real(dir));
        if (!branch) continue;
        this.records.set(repo.path, { trees: kept });
        kept.push({ slug, branch, base: (await defaultBranch(repo.path)) ?? "", port: await this.allot(branch), madeAt: this.now(), caches: false, state: "ready", sync: true });
        changed = true;
      }
      if (changed) await this.save(repo.path, { trees: kept });
      else if (kept.length > 0) this.records.set(repo.path, { trees: kept });
    }
  }

  private async tree(path: string, t: BranchTreeRecord): Promise<BranchTree> {
    const dir = treeDir(path, t.slug, this.root);
    const st = existsSync(dir) ? await treeStatus(dir, t.base) : { head: "", ahead: 0, behind: 0, files: 0 };
    const waiting = this.waits.get(dir);
    return { ...t, dir, ...st, shells: this.deps.shellsIn(dir), ...(waiting ? { waiting } : {}) };
  }

  async info(): Promise<BranchTreesInfo> {
    const repos: BranchTreeRepo[] = [];
    for (const repo of this.local()) {
      const rec = this.records.get(repo.path);
      if (!rec || rec.trees.length === 0) continue;
      repos.push({ repoId: repo.id, repoPath: repo.path, trees: await Promise.all(rec.trees.map((t) => this.tree(repo.path, t))) });
    }
    return { root: this.root, ports: this.deps.portsSpec ?? process.env["CANOPY_TREE_PORTS"] ?? TREE_PORTS_DEFAULT, repos };
  }

  /** A tree a shell may open in, by its slug or its branch: its folder and
   *  port; null when the repo keeps none by that name. */
  shellTree(repoPath: string, name: string): { slug: string; branch: string; dir: string; port: number | null } | null {
    const t = this.record(repoPath).trees.find((x) => x.slug === name || x.branch === name);
    if (!t) return null;
    const dir = treeDir(repoPath, t.slug, this.root);
    return existsSync(dir) ? { slug: t.slug, branch: t.branch, dir, port: t.port } : null;
  }

  /** The tree a folder is, for a shell restored into one: its name and port. */
  treeAt(dir: string): { slug: string; port: number | null } | null {
    for (const [path, rec] of this.records) {
      const t = rec.trees.find((x) => treeDir(path, x.slug, this.root) === dir);
      if (t) return { slug: t.slug, port: t.port };
    }
    return null;
  }

  /** The trees source's scanned cards named and filed from the records
   *  (core/branchtrees.ts `dressTreeCards`); `others` are the board's
   *  other repos, where each tree's checkout is found. */
  dress(treeRepos: readonly Repo[], others: readonly Repo[]): Repo[] {
    return dressTreeCards(treeRepos, others, this.records, this.root);
  }

  /** whether any repo keeps a tree, for the rescan after adoption */
  anyKept(): boolean {
    return this.any();
  }

  /** whether any repo keeps a tree */
  private any(): boolean {
    for (const rec of this.records.values()) if (rec.trees.length > 0) return true;
    return false;
  }

  async add(repo: Repo, branch: string, base: string | undefined, caches: boolean, sync = true): Promise<BranchTree> {
    // a tree's own card keeps no trees: they belong to the checkout
    if (isTreeCard(repo)) throw new TreesError(400, `${repo.name} is a worktree; make trees from its repo's card`);
    return this.serial(repo.path, async () => {
      if (!isBranchName(branch)) throw new TreesError(400, `${branch} is not a branch name git accepts`);
      const slug = treeSlug(branch);
      if (!slug) throw new TreesError(400, `${branch} leaves nothing to name a folder by`);
      const rec = this.record(repo.path);
      const twin = rec.trees.find((t) => t.slug === slug || t.branch === branch);
      if (twin) throw new TreesError(409, `${twin.branch} already has a tree in ${repo.name}`);
      const dir = treeDir(repo.path, slug, this.root);
      if (existsSync(dir)) throw new TreesError(409, `${dir} already exists`);
      const from = base ?? (await defaultBranch(repo.path));
      if (!from) throw new TreesError(400, `${repo.name} has no default branch to start from; say a base`);
      if ((await revOf(repo.path, from)) === null) throw new TreesError(400, `${from} is not a ref in ${repo.name}`);
      const port = await this.allot(branch);
      try {
        await addBranchTree(repo.path, dir, branch, from);
      } catch (err) {
        throw new TreesError(409, message(err));
      }
      // a new branch starts at the base, so it is synced to it; an existing one is brought up on the next pass
      const syncedTo = await revOf(repo.path, from);
      const entry: BranchTreeRecord = { slug, branch, base: from, port, madeAt: this.now(), caches, state: "preparing", sync, ...(syncedTo && (await revOf(dir, "HEAD")) === syncedTo ? { syncedTo } : {}) };
      await this.save(repo.path, { trees: [...rec.trees, entry] });
      this.spawn(this.prepare(repo, entry, dir));
      void this.publish();
      return this.tree(repo.path, entry);
    });
  }

  /** a background job `idle` waits for */
  private spawn(job: Promise<void>): void {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }

  /** The caches, then the setup line; what fails is kept on the tree, which
   *  stays, since a half-prepared tree is still a tree. */
  private async prepare(repo: Repo, entry: BranchTreeRecord, dir: string): Promise<void> {
    const whys: string[] = [];
    try {
      if (entry.caches) {
        const outcome = await copyIgnored(repo.path, dir, await ignoredEntries(repo.path), this.deps.platform);
        for (const f of outcome.failed) whys.push(`${f.path}: ${f.why}`);
      }
      const setup = (await this.deps.gates(repo.path)).setup;
      if (setup) {
        const r = await this.deps.setup(dir, setup);
        if (r.exit !== 0) whys.push(`setup exited ${r.exit ?? "by signal"}`, r.output);
      }
    } catch (err) {
      whys.push(message(err));
    }
    const why = whys.filter(Boolean).join("\n");
    await this.serial(repo.path, async () => {
      const rec = this.record(repo.path);
      // removed with force while it was being prepared: nothing to mark
      if (!rec.trees.some((t) => t.slug === entry.slug)) return;
      await this.save(repo.path, { trees: rec.trees.map((t) => (t.slug === entry.slug ? settled(t, why) : t)) });
    });
    void this.publish();
  }

  /** Starts the merge of a tree's branch into its base (core/branchtrees.ts
   *  `mergeTree`: commit, squash, rebase, the repo's gates, fast-forward,
   *  remove) and answers with the tree in `merging`. The outcome lands in
   *  the record and the `trees` event: the tree gone once the merge went
   *  through (kept, with fresh counts, when asked), or back as it was with
   *  `stopped` saying why. */
  async merge(repo: Repo, name: string, opts: MergeOptions): Promise<BranchTree> {
    if (isTreeCard(repo)) throw new TreesError(400, `${repo.name} is a worktree; merge it from its repo's card`);
    return this.serial(repo.path, async () => {
      const rec = this.record(repo.path);
      const t = rec.trees.find((x) => x.slug === name || x.branch === name);
      if (!t) throw new TreesError(404, `${repo.name} keeps no tree named ${name}`);
      if (t.state === "preparing") throw new TreesError(409, "the tree is still being prepared; wait for it");
      if (t.state === "merging") throw new TreesError(409, "the tree is being merged already");
      const entry: BranchTreeRecord = { ...settled(t, ""), state: "merging" };
      await this.save(repo.path, { trees: rec.trees.map((x) => (x === t ? entry : x)) });
      this.spawn(this.runMerge(repo, entry, t, opts));
      void this.publish();
      return this.tree(repo.path, entry);
    });
  }

  private async runMerge(repo: Repo, entry: BranchTreeRecord, prior: BranchTreeRecord, opts: MergeOptions): Promise<void> {
    const dir = treeDir(repo.path, entry.slug, this.root);
    let outcome: MergeOutcome;
    try {
      outcome = await mergeTree(repo.path, dir, entry.branch, entry.base, opts, (d) => this.check(repo.path, d), this.deps.stopTree);
    } catch (err) {
      outcome = { stopped: message(err) };
    }
    // as the tree stood before the merge: failed setup and all
    const back = settled(prior, prior.state === "failed" ? (prior.why ?? "") : "");
    await this.serial(repo.path, async () => {
      const rec = this.record(repo.path);
      // removed with force while the merge ran: nothing to settle
      if (!rec.trees.some((x) => x.slug === entry.slug)) return;
      const trees =
        "ok" in outcome && !opts.keep
          ? rec.trees.filter((x) => x.slug !== entry.slug)
          : rec.trees.map((x) => (x.slug !== entry.slug ? x : "ok" in outcome ? back : { ...back, stopped: tail(`merge stopped: ${outcome.stopped}`) }));
      await this.save(repo.path, { trees });
    });
    void this.publish();
  }

  /** The tree brought up to its base now (core `syncTree`: rebased, the
   *  uncommitted work stashed and put back). The record notes the base's
   *  commit tried and, when it stopped, why, until a sync or merge goes
   *  through; a stopped sync answers 409 with that. */
  async sync(repo: Repo, name: string): Promise<BranchTree> {
    if (isTreeCard(repo)) throw new TreesError(400, `${repo.name} is a worktree; sync it from its repo's card`);
    return this.serial(repo.path, async () => {
      const rec = this.record(repo.path);
      const t = rec.trees.find((x) => x.slug === name || x.branch === name);
      if (!t) throw new TreesError(404, `${repo.name} keeps no tree named ${name}`);
      if (t.state === "preparing") throw new TreesError(409, "the tree is still being prepared; wait for it");
      if (t.state === "merging") throw new TreesError(409, "the tree is being merged, which rebases it");
      const after = await this.syncOne(repo.path, t);
      await this.save(repo.path, { trees: rec.trees.map((x) => (x === t ? after : x)) });
      void this.publish();
      if (after.stopped?.startsWith(SYNC_NOTE)) throw new TreesError(409, after.stopped);
      return this.tree(repo.path, after);
    });
  }

  /** one tree synced: its record entry after, the base's commit noted and
   *  a note of what stopped it; a merge's note stays until a sync went */
  private async syncOne(repoPath: string, t: BranchTreeRecord): Promise<BranchTreeRecord> {
    const at = await revOf(repoPath, t.base);
    this.waits.delete(treeDir(repoPath, t.slug, this.root));
    const outcome = await syncTree(treeDir(repoPath, t.slug, this.root), t.base);
    const { stopped, ...rest } = t;
    const note = "stopped" in outcome ? { stopped: tail(`${SYNC_NOTE}${outcome.stopped}`) } : stopped && !stopped.startsWith(SYNC_NOTE) ? { stopped } : {};
    return { ...rest, ...(at ? { syncedTo: at } : {}), ...note };
  }

  /** Whether the tree follows its base by itself. */
  async setAuto(repo: Repo, name: string, sync: boolean): Promise<BranchTree> {
    return this.serial(repo.path, async () => {
      const rec = this.record(repo.path);
      const t = rec.trees.find((x) => x.slug === name || x.branch === name);
      if (!t) throw new TreesError(404, `${repo.name} keeps no tree named ${name}`);
      const after: BranchTreeRecord = { ...t, sync };
      if (!sync) this.waits.delete(treeDir(repo.path, t.slug, this.root));
      await this.save(repo.path, { trees: rec.trees.map((x) => (x === t ? after : x)) });
      void this.publish();
      return this.tree(repo.path, after);
    });
  }

  /** The trees that follow their base, each rebased onto it when it has
   *  moved since the tree's last sync: run when the main checkout changed
   *  (`touched`) and each tick. A base that stopped a sync is not tried
   *  again until it moves, so a conflict is reported once. A tree with
   *  something at work in it (`deps.working`: a test run, a build) is left
   *  for a later pass, since a rebase swaps the files under what runs
   *  there; its `waiting` says what it waits on until a pass finds it quiet. */
  async autoSync(repoPath: string): Promise<void> {
    if (!this.record(repoPath).trees.some((t) => t.sync)) return;
    await this.serial(repoPath, async () => {
      const rec = this.record(repoPath);
      // the trees whose base moved since their last sync
      const due = new Set<BranchTreeRecord>();
      for (const t of rec.trees) {
        const dir = treeDir(repoPath, t.slug, this.root);
        const follows = t.sync && (t.state === "ready" || t.state === "failed") && existsSync(dir);
        const at = follows ? await revOf(repoPath, t.base) : null;
        if (at !== null && at !== t.syncedTo) due.add(t);
        else this.waits.delete(dir);
      }
      if (due.size === 0) return;
      const dirs = [...due].map((t) => treeDir(repoPath, t.slug, this.root));
      // what runs there could not be read: the trees follow as if nothing did
      const busy = (await this.deps.working?.(dirs).catch(() => null)) ?? new Map<string, string>();
      let changed = false;
      const trees: BranchTreeRecord[] = [];
      for (const t of rec.trees) {
        const dir = treeDir(repoPath, t.slug, this.root);
        const work = due.has(t) ? busy.get(dir) : undefined;
        if (work !== undefined) this.waits.set(dir, work);
        if (!due.has(t) || work !== undefined) {
          trees.push(t);
          continue;
        }
        trees.push(await this.syncOne(repoPath, t));
        changed = true;
      }
      if (changed) await this.save(repoPath, { trees });
    });
  }

  /** The repo's gates run in the tree, one after another; null when each
   *  passes (or there is none), else the first failure with its output. */
  private async check(repoPath: string, dir: string): Promise<string | null> {
    const { gates = [] } = await this.deps.gates(repoPath);
    for (const g of gates) {
      const r = await this.deps.setup(dir, g.run);
      if (r.exit !== 0) return `gate ${g.name} exited ${r.exit ?? "by signal"}\n${r.output}`.trim();
    }
    return null;
  }

  /** worktrunk's clean-up, for one repo or every one: each ready tree whose
   *  base holds all its commits, with nothing changed or open in it, goes
   *  with its branch. The trees removed. */
  async clean(repo: Repo | null): Promise<CleanedTree[]> {
    const removed: CleanedTree[] = [];
    for (const r of repo ? [repo] : this.local()) {
      if (this.record(r.path).trees.length === 0) continue;
      await this.serial(r.path, async () => {
        const rec = this.record(r.path);
        const left: BranchTreeRecord[] = [];
        for (const t of rec.trees) {
          if (!cleanable(await this.tree(r.path, t))) {
            left.push(t);
            continue;
          }
          // its base holds every commit, so the branch goes with it
          await this.deps.stopTree?.(treeDir(r.path, t.slug, this.root))?.catch(() => {});
          await removeBranchTree(r.path, treeDir(r.path, t.slug, this.root), t.branch, true).catch(() => {});
          removed.push({ repoId: r.id, slug: t.slug, branch: t.branch });
        }
        if (left.length !== rec.trees.length) await this.save(r.path, { trees: left });
      });
    }
    if (removed.length > 0) void this.publish();
    return removed;
  }

  async remove(repo: Repo, name: string, force: boolean, deleteBranch: boolean): Promise<string> {
    return this.serial(repo.path, async () => {
      const rec = this.record(repo.path);
      const t = rec.trees.find((x) => x.slug === name || x.branch === name);
      if (!t) throw new TreesError(404, `${repo.name} keeps no tree named ${name}`);
      if (!force) {
        if (t.state === "preparing") throw new TreesError(409, "the tree is still being prepared; wait, or remove it with force");
        if (t.state === "merging") throw new TreesError(409, "the tree is being merged; wait, or remove it with force");
        const live = await this.tree(repo.path, t);
        const refusal = removeRefusal(live);
        if (refusal) throw new TreesError(409, refusal);
      }
      await this.deps.stopTree?.(treeDir(repo.path, t.slug, this.root));
      await removeBranchTree(repo.path, treeDir(repo.path, t.slug, this.root), t.branch, deleteBranch);
      this.waits.delete(treeDir(repo.path, t.slug, this.root));
      await this.save(repo.path, { trees: rec.trees.filter((x) => x !== t) });
      void this.publish();
      return t.slug;
    });
  }

  /** the main checkout changed: its trees' counts may have too, and the
   *  ones that follow the base are brought up to it when it moved */
  touched(repoPath: string): void {
    if (this.record(repoPath).trees.length === 0) return;
    const held = this.touches.get(repoPath);
    if (held) clearTimeout(held);
    this.touches.set(
      repoPath,
      setTimeout(() => {
        this.touches.delete(repoPath);
        this.spawn(this.autoSync(repoPath).catch(() => {}).then(() => this.publish()));
      }, TOUCH_DELAY),
    );
  }

  publish(): Promise<void> {
    const next = this.publishing.then(async () => {
      this.deps.broadcast({ type: "trees", trees: await this.info() });
    });
    this.publishing = next.catch(() => {});
    return next;
  }

  start(): void {
    const every = this.deps.every ?? TICK;
    if (every <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      if (!this.any()) return;
      this.spawn(Promise.all(this.local().map((r) => this.autoSync(r.path).catch(() => {}))).then(() => this.publish()));
    }, every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.touches.values()) clearTimeout(t);
    this.touches.clear();
  }

  /** every preparation, merge and publish done, for a test */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all(this.jobs);
    await this.publishing;
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== "/api/trees" && !url.pathname.startsWith("/api/trees/")) return null;
    try {
      if (url.pathname === "/api/trees" && req.method === "GET") return json(await this.info());
      const posts = ["/api/trees/add", "/api/trees/remove", "/api/trees/merge", "/api/trees/clean", "/api/trees/sync", "/api/trees/auto"];
      if (req.method !== "POST" || !posts.includes(url.pathname)) return json({ error: "not found" }, 404);
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body)) return json({ error: "malformed body" }, 400);
      // a clean-up names a repo, or sweeps every one
      if (url.pathname === "/api/trees/clean" && body["repo"] === undefined) return json({ removed: await this.clean(null) });
      const repo = this.deps.repos().find((r) => r.id === body["repo"]);
      if (!repo) return json({ error: "no repo by that id" }, 404);
      if (repo.host || !isAbsolute(repo.path)) return json({ error: "a tree is kept only for a repo on this backend's own disk" }, 400);
      if (url.pathname === "/api/trees/clean") return json({ removed: await this.clean(repo) });
      if (url.pathname === "/api/trees/add") {
        const branch = body["branch"];
        if (typeof branch !== "string" || !branch.trim()) return json({ error: "branch must be a name" }, 400);
        const base = body["base"];
        if (base !== undefined && (typeof base !== "string" || !base.trim())) return json({ error: "base must be a ref" }, 400);
        const tree = await this.add(repo, branch.trim(), typeof base === "string" ? base.trim() : undefined, body["caches"] !== false, body["sync"] !== false);
        return json({ tree }, 201);
      }
      const name = body["tree"];
      if (typeof name !== "string" || !name.trim()) return json({ error: "tree must be a tree's slug or branch" }, 400);
      if (url.pathname === "/api/trees/sync") return json({ tree: await this.sync(repo, name.trim()) });
      if (url.pathname === "/api/trees/auto") {
        if (typeof body["sync"] !== "boolean") return json({ error: "sync must be true or false" }, 400);
        return json({ tree: await this.setAuto(repo, name.trim(), body["sync"]) });
      }
      if (url.pathname === "/api/trees/merge") {
        const tree = await this.merge(repo, name.trim(), { commit: body["commit"] !== false, squash: body["squash"] !== false, keep: body["keep"] === true });
        return json({ tree }, 202);
      }
      const removed = await this.remove(repo, name.trim(), body["force"] === true, body["deleteBranch"] === true);
      return json({ removed });
    } catch (err) {
      return json({ error: message(err) }, err instanceof TreesError ? err.status : 500);
    }
  }
}
