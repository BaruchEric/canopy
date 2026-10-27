/** The warm worktree pool (FR-039, plan 1): prepared worktrees per repo
 * under the config dir, their record, the refill off a tick, the take a
 * branch run makes, the listing and the health probe. Bun-only; the model
 * is core/warm.ts. */

import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { git } from "../core/exec";
import { LOCKFILES, readGates, type Gates } from "../core/gates";
import type { ProbeResult } from "../core/health";
import type { LandingInfo, LockfileStamp, Repo, ServerEvent, WorktreesInfo } from "../core/types";
import { isWarmName, nextRefill, overWant, parseWarmRecord, reconcile, sameStamp, staleWhy, WARM_MAX, WARM_RECORD, WARM_TICK, worktreesProbe, type WarmRecord } from "../core/warm";
import { aheadOf, currentBranch, defaultBranch, detachedTree, listWarmTreeDirs, midRebase, removeRunTree, repoKey, revOf, takeWarm, treeSize, worktreesRoot } from "../core/worktree";
import type { CheckOutcome } from "./landing";

export async function readLockfileStamp(dir: string): Promise<LockfileStamp | null> {
  for (const name of LOCKFILES) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isFile()) return { name, size: s.size, mtime: s.mtimeMs };
  }
  return null;
}

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export interface WarmDeps {
  root?: string;
  repos: () => Repo[];
  want: (repoPath: string) => Promise<number>;
  setWant: (repoPath: string, n: number | null) => Promise<number>;
  gates?: (repoPath: string) => Promise<Gates>;
  setup: (dir: string, line: string) => Promise<CheckOutcome>;
  landing: () => LandingInfo;
  landingBusy: (repoPath: string) => boolean;
  /** Forward the assertion to LandingHub.orphan for every removal step. */
  removeOrphan: (dir: string, assertOwner: () => void) => Promise<void>;
  freeBytes?: (dir: string) => Promise<number>;
  broadcast: (ev: ServerEvent) => void;
  now?: () => number;
  every?: number;
}

export type Take = { took: true; setupAgain: boolean } | { took: false; wanted: boolean };

const empty = (): WarmRecord => ({ trees: [], fails: [] });
const real = (path: string): string => {
  try { return realpathSync(path); }
  catch { return resolve(path); }
};
const local = (r: Repo): boolean => !r.host && isAbsolute(r.path);
const message = (err: unknown): string => err instanceof Error ? err.message : String(err);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const pathStat = async (path: string) => lstat(path).catch((err: unknown) => {
  if (isRecord(err) && err["code"] === "ENOENT") return null;
  throw err;
});
const count = (n: number): number => Number.isInteger(n) && n >= 0 && n <= WARM_MAX ? n : 0;

class OwnershipLost extends Error {
  constructor() { super("warm pool ownership is not held"); }
}

type Slot = "missing" | "plain" | "detached" | "attached" | "blocked";

export class WarmPool {
  private readonly root: string;
  private records = new Map<string, WarmRecord>();
  private ownership: { phase: "adopting" | "ready"; token: symbol } | null = null;
  private chains = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private poked = false;
  private ticking: Promise<void> | null = null;
  private refilling: { repo: string; dir: string; owner: symbol } | null = null;
  private writes = 0;
  private published: string | null = null;

  constructor(private readonly deps: WarmDeps) {
    this.root = resolve(deps.root ?? worktreesRoot());
  }

  private get owner(): symbol | null { return this.ownership?.token ?? null; }
  private get ready(): boolean { return this.ownership?.phase === "ready"; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private gates(path: string): Promise<Gates> { return (this.deps.gates ?? readGates)(path); }
  private repoDir(path: string): string { return join(this.root, repoKey(path)); }
  private slot(path: string, n: number): string { return join(this.repoDir(path), `warm-${n}`); }
  private record(path: string): WarmRecord { return this.records.get(path) ?? empty(); }
  private epoch(): symbol {
    if (this.ownership?.phase !== "ready") throw new OwnershipLost();
    return this.ownership.token;
  }
  private check(owner: symbol): void {
    if (this.owner !== owner) throw new OwnershipLost();
  }
  private repo(path: string): Repo {
    const repo = this.deps.repos().find((r) => r.path === path && local(r));
    if (!repo) throw new Error("warm worktrees are kept only for a repo on this backend");
    return repo;
  }
  private canonical(path: string, dir: string): boolean {
    const name = basename(dir);
    return isWarmName(name) && Number.isSafeInteger(Number(name.slice(5))) && dir === join(this.repoDir(path), name);
  }
  private orphanFor(path: string, orphan: LandingInfo["orphans"][number]): boolean {
    return orphan.repoPath === path || orphan.repoPath === null && dirname(orphan.dir) === this.repoDir(path);
  }
  private live(dir: string): boolean {
    return this.deps.landing().runs.some((r) => real(r.dir) === real(dir));
  }
  private async serial<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(path) ?? Promise.resolve();
    const current = previous.then(run);
    const settled = current.then(() => {}, () => {});
    this.chains.set(path, settled);
    try { return await current; }
    finally { if (this.chains.get(path) === settled) this.chains.delete(path); }
  }

  /** Symlink directories never grant the pool permission to write or remove. */
  private async safeParents(path: string): Promise<boolean> {
    for (const dir of [this.root, this.repoDir(path)]) {
      const s = await pathStat(dir);
      if (s && (!s.isDirectory() || s.isSymbolicLink())) return false;
    }
    return true;
  }

  /** A basename is not ownership: check Git's live registration and common dir. */
  private async state(path: string, dir: string, orphan = false): Promise<Slot> {
    if (!(orphan ? dirname(dir) === this.repoDir(path) : this.canonical(path, dir)) || this.live(dir) || !(await this.safeParents(path))) return "blocked";
    const s = await pathStat(dir);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) return "blocked";
    const registry = await git(path, ["worktree", "list", "--porcelain", "-z"]);
    if (registry.code !== 0) return "blocked";
    const realDir = await realpath(dir).catch(async () => join(await realpath(dirname(dir)).catch(() => dirname(dir)), basename(dir)));
    const entry = registry.stdout.split("\0\0").map((block) => block.split("\0")).find((lines) => lines.includes(`worktree ${realDir}`));
    const dot = await pathStat(join(dir, ".git"));
    if (dot?.isSymbolicLink() || dot?.isDirectory()) return "blocked";
    if (!s) return entry && !entry.includes("detached") ? "blocked" : "missing";
    if (!entry) {
      // Bare repositories have no .git child. Git's own directory is
      // enough to reject one before granting plain-folder deletion rights.
      const repository = await git(dir, ["rev-parse", "--absolute-git-dir"]);
      if (repository.code === 0 && real(repository.stdout.trim()) === realDir) return "blocked";
      const current = await pathStat(dir);
      if (dot || !current || current.isSymbolicLink() || current.dev !== s.dev || current.ino !== s.ino || this.live(dir)) return "blocked";
      return "plain";
    }
    if ((!orphan && !entry.includes("detached")) || !dot?.isFile()) return "blocked";
    const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const main = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0 || main.code !== 0 || common.stdout.trim() !== main.stdout.trim()) return "blocked";
    const gitDir = await git(dir, ["rev-parse", "--absolute-git-dir"]);
    if (gitDir.code !== 0) return "blocked";
    const backlink = await readFile(join(gitDir.stdout.trim(), "gitdir"), "utf8").catch(() => "");
    const actualDot = await realpath(join(dir, ".git")).catch(() => "");
    if (!backlink.trim() || await realpath(backlink.trim()).catch(() => "") !== actualDot || this.live(dir)) return "blocked";
    const branch = await git(dir, ["symbolic-ref", "-q", "HEAD"]);
    const current = await pathStat(dir);
    if (!current || current.isSymbolicLink() || current.dev !== s.dev || current.ino !== s.ino || this.live(dir)) return "blocked";
    if (branch.code === 0) return orphan ? "attached" : "blocked";
    return branch.code === 1 && entry.includes("detached") ? "detached" : "blocked";
  }

  private async remove(path: string, dir: string, owner: symbol): Promise<boolean> {
    const state = await this.state(path, dir);
    this.check(owner);
    if (state === "blocked" || state === "attached") return false;
    if (state !== "missing") await removeRunTree(path, dir, undefined, () => {
      this.check(owner);
      if (this.live(dir)) throw new Error("warm slot belongs to a live run");
    });
    this.check(owner);
    return state !== "missing";
  }

  private async save(path: string, owner: symbol): Promise<void> {
    this.check(owner);
    if (!(await this.safeParents(path))) throw new Error("unsafe warm record directory");
    this.check(owner);
    await mkdir(this.repoDir(path), { recursive: true });
    this.check(owner);
    const file = join(this.repoDir(path), WARM_RECORD);
    const tmp = `${file}.${process.pid}.${++this.writes}.tmp`;
    await writeFile(tmp, JSON.stringify(this.record(path)) + "\n", { flag: "wx" });
    this.check(owner);
    await rename(tmp, file);
    this.check(owner);
  }

  private async publish(owner: symbol, free?: number): Promise<void> {
    const worktrees = await this.snapshot(free);
    this.check(owner);
    const text = JSON.stringify(worktrees);
    if (text === this.published) return;
    this.published = text;
    this.deps.broadcast({ type: "worktrees", worktrees });
  }

  async adopt(): Promise<void> {
    const owner = Symbol("warm owner");
    this.ownership = { phase: "adopting", token: owner };
    this.records = new Map();
    for (const repo of this.deps.repos().filter(local)) {
      await this.serial(repo.path, async () => {
        this.check(owner);
        if (!(await this.safeParents(repo.path))) return;
        this.check(owner);
        const raw = parseWarmRecord(await readFile(join(this.repoDir(repo.path), WARM_RECORD), "utf8").catch(() => ""));
        this.check(owner);
        const disk = await listWarmTreeDirs(repo.path, this.root);
        this.check(owner);
        const trees = [];
        for (const tree of raw.trees) {
          if (await this.state(repo.path, tree.dir) === "detached") trees.push(tree);
          this.check(owner);
        }
        const result = reconcile({ trees, fails: raw.fails.filter((f) => this.canonical(repo.path, f.dir)) }, disk.filter((dir) => this.canonical(repo.path, dir)));
        this.records.set(repo.path, result.record);
        for (const dir of result.remove) await this.remove(repo.path, dir, owner);
        await this.save(repo.path, owner);
      });
      this.check(owner);
    }
    this.check(owner);
    this.ownership = { phase: "ready", token: owner };
  }

  start(): void {
    if (this.timer || process.env["NODE_ENV"] === "test" || !this.ready) return;
    this.timer = setInterval(() => this.poke(""), this.deps.every ?? WARM_TICK);
    this.timer.unref();
    this.poke("");
  }

  stop(): void {
    this.ownership = null;
    this.poked = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poke(_repoPath: string): void {
    if (!this.ready) return;
    this.poked = true;
    if (this.pending) return;
    const owner = this.epoch();
    const pending = new Promise<void>((res) => setTimeout(res, 0)).then(async () => {
      while (this.owner === owner && this.poked) {
        this.poked = false;
        if (this.ticking) await this.ticking;
        if (this.owner === owner) await this.tick();
      }
    }).catch(() => {}).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
  }

  tick(): Promise<void> {
    if (!this.ready || this.ticking) return Promise.resolve();
    const owner = this.epoch();
    const ticking = this.turn(owner).catch((err: unknown) => {
      if (!(err instanceof OwnershipLost)) throw err;
    }).finally(() => { if (this.ticking === ticking) this.ticking = null; });
    this.ticking = ticking;
    return ticking;
  }

  private async trim(path: string, owner: symbol): Promise<boolean> {
    const want = count(await this.deps.want(path));
    this.check(owner);
    const record = this.record(path);
    const excess = overWant(record, want, (n) => this.slot(path, n));
    const disk = await listWarmTreeDirs(path, this.root);
    this.check(owner);
    const dirs = new Set([...excess.map((tree) => tree.dir), ...disk.filter((dir) => this.canonical(path, dir) && Number(basename(dir).slice(5)) > want)]);
    let removed = false;
    for (const dir of dirs) removed = await this.remove(path, dir, owner) || removed;
    this.check(owner);
    const trees = record.trees.filter((t) => !excess.includes(t));
    const fails = record.fails.filter((f) => Number(basename(f.dir).slice(5)) <= want);
    if (!removed && trees.length === record.trees.length && fails.length === record.fails.length) return false;
    this.records.set(path, { trees, fails });
    await this.save(path, owner);
    return true;
  }

  private async turn(owner: symbol): Promise<void> {
    const repos = this.deps.repos().filter(local);
    for (const repo of repos) await this.serial(repo.path, () => this.trim(repo.path, owner));
    const free = await (this.deps.freeBytes ?? freeBytes)(this.root).catch(() => 0);
    this.check(owner);
    for (const repo of repos) {
      const refilled = await this.serial(repo.path, async () => {
        this.check(owner);
        const want = count(await this.deps.want(repo.path));
        this.check(owner);
        const busy = this.deps.landingBusy(repo.path) || await midRebase(repo.path);
        this.check(owner);
        const record = this.record(repo.path);
        const stale = new Map<string, string | null>();
        for (const tree of record.trees) {
          stale.set(tree.dir, staleWhy(tree, this.now(), await aheadOf(repo.path, tree.base)));
          this.check(owner);
        }
        const next = nextRefill({ want, record, now: this.now(), refilling: this.refilling !== null, busy, free, stale: (t) => stale.get(t.dir) ?? null, dirOf: (n) => this.slot(repo.path, n) });
        if (!next) return false;
        // The repo chain reserves this slot across all following awaits.
        const state = await this.state(repo.path, next.dir);
        this.check(owner);
        if (state === "blocked" || state === "attached") return false;
        const gates = await this.gates(repo.path);
        this.check(owner);
        const stillWant = count(await this.deps.want(repo.path));
        this.check(owner);
        const rebase = await midRebase(repo.path);
        this.check(owner);
        if (next.n > stillWant || this.deps.landingBusy(repo.path) || rebase) return false;
        this.refilling = { repo: repo.path, dir: next.dir, owner };
        try { await this.refill(repo.path, next.dir, next.n, gates, owner); }
        finally { if (this.refilling?.owner === owner) this.refilling = null; }
        return true;
      });
      this.check(owner);
      if (refilled) break;
    }
    await this.publish(owner, free);
  }

  private async refill(path: string, dir: string, n: number, gates: Gates, owner: symbol): Promise<void> {
    const previous = this.record(path).fails.find((f) => f.dir === dir)?.fails ?? 0;
    const forget = (): void => {
      const record = this.record(path);
      this.records.set(path, { trees: record.trees.filter((t) => t.dir !== dir), fails: record.fails.filter((f) => f.dir !== dir) });
    };
    forget();
    await this.save(path, owner);
    try {
      await this.remove(path, dir, owner);
      const branch = await defaultBranch(path);
      this.check(owner);
      const tip = branch ? await revOf(path, `refs/heads/${branch}`) : null;
      this.check(owner);
      if (!tip) throw new Error("default branch has no commit");
      if (await this.state(path, dir) !== "missing") throw new Error("warm slot is no longer empty");
      this.check(owner);
      if (n > count(await this.deps.want(path))) return;
      this.check(owner);
      if (this.deps.landingBusy(path) || await midRebase(path)) return;
      this.check(owner);
      await detachedTree(path, dir, tip, () => {
        this.check(owner);
        if (this.live(dir)) throw new Error("warm slot belongs to a live run");
      });
      this.check(owner);
      const wanted = count(await this.deps.want(path));
      this.check(owner);
      const busy = this.deps.landingBusy(path) || await midRebase(path);
      this.check(owner);
      if (n > wanted || busy) { await this.remove(path, dir, owner); return; }
      if (gates.setup) {
        const answer = await this.deps.setup(dir, gates.setup);
        this.check(owner);
        if (answer.exit !== 0) throw new Error(`${gates.setup} exited ${answer.exit}: ${answer.output.trim().split("\n").at(-1) ?? ""}`);
      }
      const lockfile = await readLockfileStamp(dir);
      this.check(owner);
      const size = await treeSize(dir);
      this.check(owner);
      const state = await this.state(path, dir);
      this.check(owner);
      if (state !== "detached") throw new Error("warm slot lost its detached registration");
      const want = count(await this.deps.want(path));
      this.check(owner);
      if (n > want) { await this.remove(path, dir, owner); return; }
      this.record(path).trees.push({ dir, base: tip, lockfile, madeAt: this.now(), size });
    } catch (err) {
      this.check(owner);
      await this.remove(path, dir, owner);
      const want = count(await this.deps.want(path));
      this.check(owner);
      if (n <= want) this.record(path).fails.push({ dir, why: message(err), at: this.now(), fails: previous + 1 });
    } finally {
      if (this.owner === owner) await this.save(path, owner);
    }
  }

  async take(path: string, dir: string, branch: string, base: string): Promise<Take> {
    const owner = this.epoch();
    this.repo(path);
    try {
      return await this.serial(path, async () => {
        this.check(owner);
        const wanted = count(await this.deps.want(path)) > 0;
        this.check(owner);
        if (!wanted) return { took: false, wanted: false };
        if (dir !== join(this.repoDir(path), basename(dir)) || isWarmName(basename(dir)) || basename(dir) === WARM_RECORD || this.live(dir) || !(await this.safeParents(path))) throw new Error("unsafe warm destination");
        this.check(owner);
        if (await pathStat(dir)) throw new Error(`warm destination already exists: ${dir}`);
        this.check(owner);
        const ref = await git(path, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        this.check(owner);
        if (ref.code === 0) throw new Error(`warm destination branch already exists: ${branch}`);
        for (const tree of this.record(path).trees) {
          const state = await this.state(path, tree.dir);
          this.check(owner);
          this.records.set(path, { trees: this.record(path).trees.filter((t) => t !== tree), fails: this.record(path).fails });
          await this.save(path, owner);
          if (state !== "detached") continue;
          const stillWanted = count(await this.deps.want(path)) > 0;
          this.check(owner);
          if (!stillWanted) { await this.remove(path, tree.dir, owner); return { took: false, wanted: false }; }
          const current = await this.state(path, tree.dir);
          this.check(owner);
          if (current !== "detached") continue;
          try {
            await takeWarm(path, tree.dir, dir, branch, base, () => {
              this.check(owner);
              if (this.live(tree.dir) || this.live(dir)) throw new Error("warm destination belongs to a live run");
            });
            this.check(owner);
          } catch (err) {
            this.check(owner);
            // A checkout can fail after the move. The caller must not fall
            // back to creating over that registered detached destination.
            if (await pathStat(dir)) throw new Error(`warm destination remains occupied after take failed: ${message(err)}`);
            this.check(owner);
            await this.remove(path, tree.dir, owner);
            break;
          }
          const stamp = await readLockfileStamp(dir);
          this.check(owner);
          return { took: true, setupAgain: !sameStamp(tree.lockfile, stamp) };
        }
        const stillWanted = count(await this.deps.want(path)) > 0;
        this.check(owner);
        return { took: false, wanted: stillWanted };
      });
    } finally { if (this.owner === owner) this.poke(path); }
  }

  async prune(repoPath?: string): Promise<string[]> {
    const owner = this.epoch();
    if (repoPath !== undefined) this.repo(repoPath);
    const removed: string[] = [];
    for (const repo of this.deps.repos().filter((r) => local(r) && (repoPath === undefined || r.path === repoPath))) {
      await this.serial(repo.path, async () => {
        this.check(owner);
        for (const orphan of this.deps.landing().orphans.filter((o) => this.orphanFor(repo.path, o))) {
          if (dirname(orphan.dir) !== this.repoDir(repo.path) || isWarmName(basename(orphan.dir)) || this.live(orphan.dir) || !(await this.safeParents(repo.path))) continue;
          this.check(owner);
          const s = await pathStat(orphan.dir);
          this.check(owner);
          if (!s?.isDirectory() || s.isSymbolicLink()) continue;
          const state = await this.state(repo.path, orphan.dir, true);
          this.check(owner);
          if (state === "blocked" || state === "missing" || this.live(orphan.dir)) continue;
          const branch = state === "plain" ? null : await currentBranch(orphan.dir);
          this.check(owner);
          if (branch !== orphan.branch) continue;
          const listed = this.deps.landing().orphans.some((o) => o.dir === orphan.dir && o.repoPath === orphan.repoPath && o.branch === orphan.branch);
          if (!listed) continue;
          this.check(owner);
          await this.deps.removeOrphan(orphan.dir, () => this.check(owner));
          this.check(owner);
          removed.push(orphan.dir);
        }
        this.check(owner);
        const record = this.record(repo.path);
        const trees = [];
        for (const tree of record.trees) {
          const why = staleWhy(tree, this.now(), await aheadOf(repo.path, tree.base));
          this.check(owner);
          if (why) {
            if (await this.remove(repo.path, tree.dir, owner)) removed.push(tree.dir);
          } else trees.push(tree);
        }
        this.records.set(repo.path, { trees, fails: [] });
        await this.save(repo.path, owner);
      });
      this.check(owner);
    }
    await this.publish(owner);
    return removed;
  }

  async info(): Promise<WorktreesInfo> { return this.snapshot(); }

  private async snapshot(free?: number): Promise<WorktreesInfo> {
    const landing = this.deps.landing();
    const repos: WorktreesInfo["repos"] = [];
    for (const repo of this.deps.repos().filter(local)) {
      const record = this.record(repo.path);
      const want = count(await this.deps.want(repo.path));
      const gates = await this.gates(repo.path);
      repos.push({
        repoId: repo.id,
        repoPath: repo.path,
        want,
        ...(gates.warm === undefined ? {} : { fileWarm: gates.warm }),
        runs: landing.runs.filter((r) => r.repoPath === repo.path).map(({ dir, id, runId, branch, state }) => ({ dir, id, runId, branch, state })),
        warm: record.trees.map((t) => ({ ...t, name: basename(t.dir) })),
        refilling: this.refilling?.repo === repo.path && this.refilling.owner === this.owner ? basename(this.refilling.dir) : null,
        fails: record.fails.map((f) => ({ name: basename(f.dir), why: f.why, at: f.at, fails: f.fails })),
        orphans: landing.orphans.filter((o) => this.orphanFor(repo.path, o)).map((o) => o.dir),
      });
    }
    return { root: this.root, free: free ?? await (this.deps.freeBytes ?? freeBytes)(this.root).catch(() => 0), repos };
  }

  async probe(): Promise<ProbeResult> { return worktreesProbe(await this.info()); }

  async idle(): Promise<void> {
    while (this.ticking || this.pending || this.chains.size) await Promise.all([this.ticking, this.pending, ...this.chains.values()]);
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== "/api/worktrees" && !url.pathname.startsWith("/api/worktrees/")) return null;
    try {
      if (url.pathname === "/api/worktrees" && req.method === "GET") return json(await this.info());
      if (req.method !== "POST" || !["/api/worktrees/warm", "/api/worktrees/prune"].includes(url.pathname)) return json({ error: "not found" }, 404);
      const owner = this.epoch();
      const body: unknown = await req.json().catch(() => null);
      this.check(owner);
      if (!isRecord(body)) return json({ error: "malformed body" }, 400);
      let repo: Repo | undefined;
      if (body["repo"] !== undefined) {
        repo = this.deps.repos().find((r) => r.id === body["repo"]);
        if (!repo) return json({ error: "no repo by that id" }, 404);
        if (!local(repo)) return json({ error: "warm worktrees are kept only for a repo on this backend" }, 400);
      }
      if (url.pathname === "/api/worktrees/prune") return json({ removed: await this.prune(repo?.path) });
      if (!repo) return json({ error: "no repo by that id" }, 404);
      let n = body["n"];
      if (n === undefined) {
        n = (await this.gates(repo.path)).warm;
        this.check(owner);
        if (n === undefined) return json({ error: `${repo.name} has no warm in its gates file; say a number` }, 400);
      }
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > WARM_MAX) return json({ error: "warm must be a whole number from 0 to 2" }, 400);
      this.check(owner);
      const want = await this.deps.setWant(repo.path, n === 0 ? null : n);
      this.check(owner);
      this.poke(repo.path);
      return json({ repo: repo.id, want });
    } catch (err) { return json({ error: message(err) }, err instanceof OwnershipLost ? 409 : 500); }
  }
}
