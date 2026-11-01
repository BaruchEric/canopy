/** The worktrees kept by hand (FR-051): the record per repo under
 *  `<configDir>/trees/<repo key>/trees.json`, making a tree and preparing it
 *  in the background (the main checkout's ignored entries cloned in, then
 *  the repo's setup line), removing one, and the list with each tree's
 *  live counts. `GET /api/trees` needs read, the two POSTs operate. Changes
 *  publish on the `trees` event; the main checkout's own event (a commit in
 *  a tree moves refs in the common git dir) brings a fresh list too. */

import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  addBranchTree,
  copyIgnored,
  EMPTY_TREES,
  ignoredEntries,
  isBranchName,
  listTreeDirs,
  parseTreesRecord,
  removeBranchTree,
  TREE_PORTS_DEFAULT,
  treeDir,
  treePort,
  treePorts,
  treeSlug,
  treeStatus,
  treesRoot,
  TREES_RECORD,
  type BranchTreeRecord,
  type TreesRecord,
} from "../core/branchtrees";
import { git } from "../core/exec";
import { removeRefusal } from "../core/treewords";
import { parseWorktreeList } from "../core/git";
import type { BranchTree, BranchTreeRepo, BranchTreesInfo, Repo, ServerEvent } from "../core/types";
import { defaultBranch, repoKey, revOf } from "../core/worktree";

export interface TreesDeps {
  root?: string;
  /** the repos this backend scans; only local ones get trees */
  repos: () => Repo[];
  /** the repo's gates file, for its setup line */
  gates: (path: string) => Promise<{ setup?: string }>;
  /** runs the setup line in the tree under the gate environment */
  setup: (dir: string, line: string) => Promise<{ exit: number | null; output: string }>;
  /** the ports something listens on now, so a tree's is not one of them */
  listening: () => Promise<number[]>;
  /** live shells sitting in a folder */
  shellsIn: (dir: string) => number;
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
/** the record entry once its preparation ended: ready, or failed with why */
const settled = (t: BranchTreeRecord, why: string): BranchTreeRecord => {
  const { slug, branch, base, port, madeAt, caches } = t;
  return why ? { slug, branch, base, port, madeAt, caches, state: "failed", why: tail(why) } : { slug, branch, base, port, madeAt, caches, state: "ready" };
};

export class BranchTrees {
  private readonly root: string;
  private readonly ports: number[];
  private readonly records = new Map<string, TreesRecord>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly preparing = new Set<Promise<void>>();
  private readonly touches = new Map<string, ReturnType<typeof setTimeout>>();
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
    return taken;
  }
  private async allot(branch: string): Promise<number | null> {
    const listening = await this.deps.listening().catch((): number[] => []);
    return treePort(branch, this.ports, new Set([...this.takenPorts(), ...listening]));
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
      for (const t of rec.trees) {
        const dir = treeDir(repo.path, t.slug, this.root);
        if (dirs.includes(dir) && listed.has(await real(dir))) kept.push(t);
      }
      let changed = kept.length !== rec.trees.length;
      for (const dir of dirs) {
        const slug = basename(dir);
        if (kept.some((t) => t.slug === slug)) continue;
        const branch = listed.get(await real(dir));
        if (!branch) continue;
        this.records.set(repo.path, { trees: kept });
        kept.push({ slug, branch, base: (await defaultBranch(repo.path)) ?? "", port: await this.allot(branch), madeAt: this.now(), caches: false, state: "ready" });
        changed = true;
      }
      if (changed) await this.save(repo.path, { trees: kept });
      else if (kept.length > 0) this.records.set(repo.path, { trees: kept });
    }
  }

  private async tree(path: string, t: BranchTreeRecord): Promise<BranchTree> {
    const dir = treeDir(path, t.slug, this.root);
    const st = existsSync(dir) ? await treeStatus(dir, t.base) : { head: "", ahead: 0, behind: 0, files: 0 };
    return { ...t, dir, ...st, shells: this.deps.shellsIn(dir) };
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

  /** whether any repo keeps a tree */
  private any(): boolean {
    for (const rec of this.records.values()) if (rec.trees.length > 0) return true;
    return false;
  }

  async add(repo: Repo, branch: string, base: string | undefined, caches: boolean): Promise<BranchTree> {
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
      const entry: BranchTreeRecord = { slug, branch, base: from, port, madeAt: this.now(), caches, state: "preparing" };
      await this.save(repo.path, { trees: [...rec.trees, entry] });
      const job = this.prepare(repo, entry, dir);
      this.preparing.add(job);
      void job.finally(() => this.preparing.delete(job));
      void this.publish();
      return this.tree(repo.path, entry);
    });
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

  async remove(repo: Repo, name: string, force: boolean, deleteBranch: boolean): Promise<string> {
    return this.serial(repo.path, async () => {
      const rec = this.record(repo.path);
      const t = rec.trees.find((x) => x.slug === name || x.branch === name);
      if (!t) throw new TreesError(404, `${repo.name} keeps no tree named ${name}`);
      if (!force) {
        if (t.state === "preparing") throw new TreesError(409, "the tree is still being prepared; wait, or remove it with force");
        const live = await this.tree(repo.path, t);
        const refusal = removeRefusal(live);
        if (refusal) throw new TreesError(409, refusal);
      }
      await removeBranchTree(repo.path, treeDir(repo.path, t.slug, this.root), t.branch, deleteBranch);
      await this.save(repo.path, { trees: rec.trees.filter((x) => x !== t) });
      void this.publish();
      return t.slug;
    });
  }

  /** the main checkout changed; its trees' counts may have too */
  touched(repoPath: string): void {
    if (this.record(repoPath).trees.length === 0) return;
    const held = this.touches.get(repoPath);
    if (held) clearTimeout(held);
    this.touches.set(
      repoPath,
      setTimeout(() => {
        this.touches.delete(repoPath);
        void this.publish();
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
      if (this.any()) void this.publish();
    }, every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.touches.values()) clearTimeout(t);
    this.touches.clear();
  }

  /** every preparation and publish done, for a test */
  async idle(): Promise<void> {
    while (this.preparing.size > 0) await Promise.all(this.preparing);
    await this.publishing;
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== "/api/trees" && !url.pathname.startsWith("/api/trees/")) return null;
    try {
      if (url.pathname === "/api/trees" && req.method === "GET") return json(await this.info());
      if (req.method !== "POST" || !["/api/trees/add", "/api/trees/remove"].includes(url.pathname)) return json({ error: "not found" }, 404);
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body)) return json({ error: "malformed body" }, 400);
      const repo = this.deps.repos().find((r) => r.id === body["repo"]);
      if (!repo) return json({ error: "no repo by that id" }, 404);
      if (repo.host || !isAbsolute(repo.path)) return json({ error: "a tree is kept only for a repo on this backend's own disk" }, 400);
      if (url.pathname === "/api/trees/add") {
        const branch = body["branch"];
        if (typeof branch !== "string" || !branch.trim()) return json({ error: "branch must be a name" }, 400);
        const base = body["base"];
        if (base !== undefined && (typeof base !== "string" || !base.trim())) return json({ error: "base must be a ref" }, 400);
        const tree = await this.add(repo, branch.trim(), typeof base === "string" ? base.trim() : undefined, body["caches"] !== false);
        return json({ tree }, 201);
      }
      const name = body["tree"];
      if (typeof name !== "string" || !name.trim()) return json({ error: "tree must be a tree's slug or branch" }, 400);
      const removed = await this.remove(repo, name.trim(), body["force"] === true, body["deleteBranch"] === true);
      return json({ removed });
    } catch (err) {
      return json({ error: message(err) }, err instanceof TreesError ? err.status : 500);
    }
  }
}
