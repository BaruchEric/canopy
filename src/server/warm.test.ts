import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import type { LandingInfo, Repo, ServerEvent, WorktreesInfo } from "../core/types";
import { EMPTY_RECORD, WARM_AGE, WARM_BEHIND, WARM_FAILS, WARM_RETRY, WORKTREE_DISK_MIN, parseWarmRecord } from "../core/warm";
import { currentBranch, repoKey, revOf, runTreeDir } from "../core/worktree";
import type { CheckOutcome } from "./landing";
import { freeBytes, readLockfileStamp, WarmPool, type WarmDeps } from "./warm";

let root = "";
let n = 0;
const pools: WarmPool[] = [];
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (cwd: string, name: string, body: string): Promise<string> => {
  await mkdir(join(cwd, name, ".."), { recursive: true });
  await writeFile(join(cwd, name), body);
  await sh(cwd, "add", "-A");
  await sh(cwd, "commit", "-q", "-m", `c ${name}`);
  return sh(cwd, "rev-parse", "HEAD");
};

interface World {
  wts: string;
  repo: Repo;
  want: Map<string, number>;
  busy: boolean;
  free: number;
  now: number;
  setups: string[];
  setupAnswer: CheckOutcome | (() => Promise<CheckOutcome>);
  landing: LandingInfo;
  events: ServerEvent[];
  pool: WarmPool;
}

async function world(over: Partial<WarmDeps> = {}): Promise<World> {
  const path = join(root, `r${++n}`);
  await exec(["git", "init", "-q", "-b", "main", path]);
  await sh(path, "config", "user.email", "t@t");
  await sh(path, "config", "user.name", "t");
  await commit(path, ".gitignore", "node_modules/\n");
  await commit(path, "bun.lock", "lock v1\n");
  await commit(path, ".canopy/gates.json", JSON.stringify({ gates: [], setup: "bun install --frozen-lockfile", warm: 1 }));
  const w: Omit<World, "pool"> = {
    wts: join(root, `wts${n}`),
    repo: { id: `r${n}`, name: `r${n}`, path, group: "", source: "root", status: null },
    want: new Map(),
    busy: false,
    free: WORKTREE_DISK_MIN,
    now: 1_000_000,
    setups: [],
    setupAnswer: { exit: 0, output: "" },
    landing: { runs: [], entries: [], orphans: [] },
    events: [],
  };
  const pool = poolFor(w, over);
  await pool.adopt();
  return Object.assign(w, { pool });
}

function poolFor(w: Omit<World, "pool">, over: Partial<WarmDeps> = {}): WarmPool {
  const pool = new WarmPool({
    root: w.wts,
    repos: () => [w.repo],
    want: async (p) => w.want.get(p) ?? 0,
    setWant: async (p, k) => {
      if (k) w.want.set(p, k);
      else w.want.delete(p);
      return w.want.get(p) ?? 0;
    },
    setup: async (dir, line) => {
      w.setups.push(line);
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "node_modules", ".ok"), "ok");
      return typeof w.setupAnswer === "function" ? w.setupAnswer() : w.setupAnswer;
    },
    landing: () => w.landing,
    landingBusy: () => w.busy,
    removeOrphan: async (dir) => rm(dir, { recursive: true, force: true }),
    freeBytes: async () => w.free,
    broadcast: (ev) => w.events.push(ev),
    now: () => w.now,
    ...over,
  });
  pools.push(pool);
  return pool;
}
const slot = (w: World, k: number) => join(w.wts, repoKey(w.repo.path), `warm-${k}`);
const record = async (w: World) => parseWarmRecord(await readFile(join(w.wts, repoKey(w.repo.path), "warm.json"), "utf8").catch(() => "{"));
const last = (w: World): WorktreesInfo => {
  const ev = w.events.filter((e) => e.type === "worktrees").pop();
  if (!ev || ev.type !== "worktrees") throw new Error("no worktrees event");
  return ev.worktrees;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-warm-"));
});
afterAll(async () => {
  for (const pool of pools) pool.stop();
  await Promise.all(pools.map((pool) => pool.idle()));
  await rm(root, { recursive: true, force: true });
});

test("readLockfileStamp and freeBytes", async () => {
  const dir = join(root, "stamp");
  await mkdir(dir);
  expect(await readLockfileStamp(dir)).toBeNull();
  await writeFile(join(dir, "bun.lock"), "lock");
  expect(await readLockfileStamp(dir)).toMatchObject({ name: "bun.lock", size: 4 });
  expect(await freeBytes(root)).toBeGreaterThan(0);
  await expect(freeBytes(join(root, "none"))).rejects.toThrow();
});

test("a tick cuts warm-1 detached at the tip with setup run, writes the record and sends the event", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const tip = (await revOf(w.repo.path, "main"))!;
  expect(existsSync(join(slot(w, 1), "node_modules", ".ok"))).toBe(true);
  expect(await currentBranch(slot(w, 1))).toBeNull();
  expect(await revOf(slot(w, 1), "HEAD")).toBe(tip);
  expect(w.setups).toEqual(["bun install --frozen-lockfile"]);
  const rec = await record(w);
  expect(rec.trees).toHaveLength(1);
  expect(rec.trees[0]).toMatchObject({ dir: slot(w, 1), base: tip, madeAt: w.now, lockfile: { name: "bun.lock" } });
  expect(rec.trees[0]!.size).toBeGreaterThan(0);
  const info = last(w);
  expect(info.repos[0]).toMatchObject({ repoId: w.repo.id, want: 1, fileWarm: 1, refilling: null, fails: [], orphans: [] });
  expect(info.repos[0]!.warm.map((t) => t.name)).toEqual(["warm-1"]);
  expect(info.free).toBe(WORKTREE_DISK_MIN);
});

test("a take moves the tree onto the run's branch, needs no setup, and the next tick refills", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const tip = (await revOf(w.repo.path, "main"))!;
  const dir = runTreeDir(w.repo.path, "run1", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run1", tip)).toEqual({ took: true, setupAgain: false });
  expect(await currentBranch(dir)).toBe("run/x-run1");
  expect(existsSync(join(dir, "node_modules", ".ok"))).toBe(true);
  expect(existsSync(slot(w, 1))).toBe(false);
  expect((await record(w)).trees).toEqual([]);
  await w.pool.idle();
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(true);
  expect(w.setups).toHaveLength(2);
});

test("a take after the lockfile moved on main says setup again", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  await Bun.sleep(20);
  const tip = await commit(w.repo.path, "bun.lock", "lock v2\n");
  const dir = runTreeDir(w.repo.path, "run2", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run2", tip)).toEqual({ took: true, setupAgain: true });
  expect(await readFile(join(dir, "bun.lock"), "utf8")).toBe("lock v2\n");
});

test("no tree: wanted says whether the repo keeps any", async () => {
  const w = await world();
  const dir = runTreeDir(w.repo.path, "run3", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run3", "main")).toEqual({ took: false, wanted: false });
  w.want.set(w.repo.path, 1);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run3", "main")).toEqual({ took: false, wanted: true });
  expect(existsSync(dir)).toBe(false);
});

test("two takes at once: one gets the tree", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const tip = (await revOf(w.repo.path, "main"))!;
  const [a, b] = await Promise.all([w.pool.take(w.repo.path, runTreeDir(w.repo.path, "a", w.wts), "run/a", tip), w.pool.take(w.repo.path, runTreeDir(w.repo.path, "b", w.wts), "run/b", tip)]);
  expect([a.took, b.took].sort()).toEqual([false, true]);
});

test("a tree git no longer knows is not handed out; the slot is dropped and refilled", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  await rm(slot(w, 1), { recursive: true, force: true });
  expect(await w.pool.take(w.repo.path, runTreeDir(w.repo.path, "c", w.wts), "run/c", "main")).toEqual({ took: false, wanted: true });
  expect((await record(w)).trees).toEqual([]);
  await w.pool.idle();
  await w.pool.tick();
  expect(existsSync(join(slot(w, 1), "node_modules", ".ok"))).toBe(true);
});

test("nothing refills under the disk floor, while the queue is busy, or while another refill runs", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  w.free = WORKTREE_DISK_MIN - 1;
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect(await w.pool.probe()).toMatchObject({ state: "down", why: expect.stringContaining("not refilled under 5 GB") });
  w.free = WORKTREE_DISK_MIN;
  w.busy = true;
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  w.busy = false;
  let release: (() => void) | undefined;
  const started = Promise.withResolvers<void>();
  w.setupAnswer = () =>
    new Promise<CheckOutcome>((res) => {
      release = () => res({ exit: 0, output: "" });
      started.resolve();
    });
  w.want.set(w.repo.path, 2);
  const first = w.pool.tick();
  await started.promise;
  await w.pool.tick();
  expect(w.setups).toHaveLength(1);
  release!();
  await first;
  expect((await record(w)).trees).toHaveLength(1);
  expect(await w.pool.probe()).toMatchObject({ state: "ok", detail: "0 run, 1 warm, 5.0 GB free" });
});

test("a failed setup leaves the slot empty with the error, tried again after WARM_RETRY; health turns at WARM_FAILS; prune forgets", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  w.setupAnswer = { exit: 1, output: "lots\nno lockfile" };
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect((await record(w)).fails).toEqual([{ dir: slot(w, 1), why: "bun install --frozen-lockfile exited 1: no lockfile", at: w.now, fails: 1 }]);
  await w.pool.tick();
  expect(w.setups).toHaveLength(1);
  for (let k = 2; k <= WARM_FAILS; k++) {
    w.now += WARM_RETRY;
    await w.pool.tick();
  }
  expect(w.setups).toHaveLength(WARM_FAILS);
  expect(await w.pool.probe()).toEqual({ state: "down", why: `${w.repo.id}'s warm worktree failed to refill 3 times: bun install --frozen-lockfile exited 1: no lockfile`, detail: "0 run, 0 warm, 1 refill failed, 5.0 GB free" });
  expect(last(w).repos[0]!.fails).toEqual([{ name: "warm-1", why: "bun install --frozen-lockfile exited 1: no lockfile", at: w.now, fails: 3 }]);
  expect(await w.pool.prune(w.repo.path)).toEqual([]);
  expect((await record(w)).fails).toEqual([]);
  w.setupAnswer = { exit: 0, output: "" };
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(true);
});

test("a stale tree is re-cut: 20 commits on main, or 24 hours", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  for (let k = 0; k < WARM_BEHIND; k++) await commit(w.repo.path, `f${k}.txt`, `${k}\n`);
  await w.pool.tick();
  expect(w.setups).toHaveLength(2);
  expect((await record(w)).trees[0]!.base).toBe((await revOf(w.repo.path, "main"))!);
  w.now += WARM_AGE;
  await w.pool.tick();
  expect(w.setups).toHaveLength(3);
  expect((await record(w)).trees[0]!.madeAt).toBe(w.now);
});

test("want lowered removes the slots past it", async () => {
  const w = await world();
  w.want.set(w.repo.path, 2);
  await w.pool.tick();
  await w.pool.tick();
  expect([existsSync(slot(w, 1)), existsSync(slot(w, 2))]).toEqual([true, true]);
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  expect([existsSync(slot(w, 1)), existsSync(slot(w, 2))]).toEqual([true, false]);
  w.want.delete(w.repo.path);
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect(await record(w)).toEqual(EMPTY_RECORD);
});

test("adopt squares the record with the disk", async () => {
  const w = await world();
  const key = join(w.wts, repoKey(w.repo.path));
  await mkdir(join(key, "warm-2"), { recursive: true });
  await writeFile(join(key, "warm.json"), JSON.stringify({ trees: [{ dir: slot(w, 1), base: "b", lockfile: null, madeAt: 1, size: 1 }], fails: [] }));
  await w.pool.adopt();
  expect(await record(w)).toEqual(EMPTY_RECORD);
  expect(existsSync(join(key, "warm-2"))).toBe(false);
});

test("the routes: the listing, warm from a number or the file, prune", async () => {
  const w = await world();
  const orphan = join(w.wts, repoKey(w.repo.path), "zz");
  await mkdir(orphan, { recursive: true });
  w.landing = { runs: [], entries: [], orphans: [{ dir: orphan, repoPath: w.repo.path, branch: null, queueable: false }] };
  const call = (method: string, path: string, body?: unknown) =>
    w.pool.handle(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), new URL(`http://x${path}`));
  const list = (await (await call("GET", "/api/worktrees"))!.json()) as WorktreesInfo;
  expect(list.repos[0]).toMatchObject({ repoId: w.repo.id, want: 0, fileWarm: 1, orphans: [orphan] });
  expect(await (await call("POST", "/api/worktrees/warm", { repo: w.repo.id }))!.json()).toEqual({ repo: w.repo.id, want: 1 });
  expect(await (await call("POST", "/api/worktrees/warm", { repo: w.repo.id, n: 2 }))!.json()).toEqual({ repo: w.repo.id, want: 2 });
  expect(w.want.get(w.repo.path)).toBe(2);
  expect((await call("POST", "/api/worktrees/warm", { repo: w.repo.id, n: 3 }))!.status).toBe(400);
  expect((await call("POST", "/api/worktrees/warm", { repo: "zzz" }))!.status).toBe(404);
  await w.pool.idle();
  expect(await (await call("POST", "/api/worktrees/prune", { repo: w.repo.id }))!.json()).toEqual({ removed: [orphan] });
  expect(existsSync(orphan)).toBe(false);
  expect(await call("GET", "/api/other")).toBeNull();
});

test("a repo on another host is refused", async () => {
  const w = await world({ repos: () => [{ id: "far", name: "far", path: "ssh://mini/home/eric/dev/x", group: "", source: "s", host: "mini", status: null }] });
  const res = (await w.pool.handle(new Request("http://x/api/worktrees/warm", { method: "POST", body: JSON.stringify({ repo: "far", n: 1 }), headers: { "content-type": "application/json" } }), new URL("http://x/api/worktrees/warm")))!;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "warm worktrees are kept only for a repo on this backend" });
});

test("mutations require adoption and stop revokes pending refill completion", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  const before = await readFile(join(w.wts, repoKey(w.repo.path), "warm.json"), "utf8");
  let finish: (answer: CheckOutcome) => void = () => { throw new Error("setup not started"); };
  const started = Promise.withResolvers<void>();
  w.setupAnswer = () => new Promise((res) => { finish = res; started.resolve(); });
  const ticking = w.pool.tick();
  await started.promise;
  w.pool.stop();
  finish({ exit: 0, output: "" });
  await ticking;
  expect(await readFile(join(w.wts, repoKey(w.repo.path), "warm.json"), "utf8")).toBe(before);
  expect(w.events).toEqual([]);
  await expect(w.pool.prune()).rejects.toThrow("ownership");
  await expect(w.pool.take(w.repo.path, runTreeDir(w.repo.path, "stopped", w.wts), "run/stopped", "main")).rejects.toThrow("ownership");
  const response = await w.pool.handle(new Request("http://x/api/worktrees/warm", { method: "POST", body: JSON.stringify({ repo: w.repo.id, n: 2 }) }), new URL("http://x/api/worktrees/warm"));
  expect(response?.status).toBe(409);
  expect(w.want.get(w.repo.path)).toBe(1);
});

test("late refill completion obeys lowered want, including failure-only slots", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  let finish: (answer: CheckOutcome) => void = () => { throw new Error("setup not started"); };
  const started = Promise.withResolvers<void>();
  w.setupAnswer = () => new Promise((res) => { finish = res; started.resolve(); });
  const ticking = w.pool.tick();
  await started.promise;
  w.want.delete(w.repo.path);
  finish({ exit: 1, output: "failed after disable" });
  await ticking;
  expect(existsSync(slot(w, 1))).toBe(false);
  expect(await record(w)).toEqual({ trees: [], fails: [] });
  w.want.set(w.repo.path, 1);
  w.setupAnswer = { exit: 1, output: "retry" };
  await w.pool.tick();
  expect((await record(w)).fails).toHaveLength(1);
  w.want.delete(w.repo.path);
  await w.pool.tick();
  expect(await record(w)).toEqual({ trees: [], fails: [] });
});

test("failed replacement removes the previous ready tree and enforces retry", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  w.now += WARM_AGE;
  w.setupAnswer = { exit: 2, output: "broken replacement" };
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect((await record(w)).trees).toEqual([]);
  expect((await record(w)).fails[0]?.fails).toBe(1);
  await w.pool.tick();
  expect(w.setups).toHaveLength(2);
});

test("adopt ignores foreign recorded paths and preserves attached or independent repositories", async () => {
  const w = await world();
  const foreign = join(root, "foreign", "warm-1");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "precious"), "keep");
  await sh(w.repo.path, "worktree", "add", "-q", "-b", "run/keep", slot(w, 1), "main");
  await exec(["git", "init", "-q", "-b", "main", slot(w, 2)]);
  await writeFile(join(w.wts, repoKey(w.repo.path), "warm.json"), JSON.stringify({ trees: [{ dir: foreign, base: "b", lockfile: null, madeAt: 1, size: 1 }], fails: [] }));
  await w.pool.adopt();
  expect(await readFile(join(foreign, "precious"), "utf8")).toBe("keep");
  expect(await currentBranch(slot(w, 1))).toBe("run/keep");
  expect(existsSync(join(slot(w, 2), ".git"))).toBe(true);
  expect(await record(w)).toEqual({ trees: [], fails: [] });
  w.want.set(w.repo.path, 2);
  await w.pool.tick();
  expect(await currentBranch(slot(w, 1))).toBe("run/keep");
  expect(w.setups).toEqual([]);
});

test("a detached destination survives a failed post-move checkout and take rejects", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const dir = runTreeDir(w.repo.path, "bad-base", w.wts);
  await expect(w.pool.take(w.repo.path, dir, "run/bad-base", "definitely-missing-ref")).rejects.toThrow("destination");
  expect(existsSync(join(dir, "node_modules", ".ok"))).toBe(true);
  expect(await currentBranch(dir)).toBeNull();
  expect(await sh(w.repo.path, "worktree", "list", "--porcelain")).toContain(dir);
  expect((await record(w)).trees).toEqual([]);
  await w.pool.idle();
});

test("take preserves an existing target and existing branch", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const dir = runTreeDir(w.repo.path, "existing", w.wts);
  await mkdir(dir);
  await writeFile(join(dir, "precious"), "keep");
  await expect(w.pool.take(w.repo.path, dir, "run/existing", "main")).rejects.toThrow("destination");
  expect(await readFile(join(dir, "precious"), "utf8")).toBe("keep");
  await sh(w.repo.path, "branch", "run/kept", "main");
  const tip = await sh(w.repo.path, "rev-parse", "run/kept");
  const other = runTreeDir(w.repo.path, "existing-ref", w.wts);
  await expect(w.pool.take(w.repo.path, other, "run/kept", "main")).rejects.toThrow();
  expect(await sh(w.repo.path, "rev-parse", "run/kept")).toBe(tip);
  await w.pool.idle();
});

test("adopt and refill preserve symlink slots and a symlink repo directory", async () => {
  const w = await world();
  const foreign = join(root, "symlink-target");
  await mkdir(foreign);
  await writeFile(join(foreign, "precious"), "keep");
  await symlink(foreign, slot(w, 1));
  await w.pool.adopt();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  expect(await readFile(join(foreign, "precious"), "utf8")).toBe("keep");
  expect(w.setups).toEqual([]);
  await rm(join(w.wts, repoKey(w.repo.path)), { recursive: true });
  await symlink(foreign, join(w.wts, repoKey(w.repo.path)));
  await w.pool.adopt();
  await w.pool.tick();
  expect(existsSync(join(foreign, "warm.json"))).toBe(false);
  expect(w.setups).toEqual([]);
});

test("take never hands out a directory with a copied stale git pointer", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const other = runTreeDir(w.repo.path, "other", w.wts);
  await sh(w.repo.path, "worktree", "add", "-q", "-b", "run/other", other, "main");
  await writeFile(join(slot(w, 1), ".git"), await readFile(join(other, ".git"), "utf8"));
  const dir = runTreeDir(w.repo.path, "copied-pointer", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/copied-pointer", "main")).toEqual({ took: false, wanted: true });
  expect(await currentBranch(other)).toBe("run/other");
  expect(existsSync(join(slot(w, 1), "node_modules", ".ok"))).toBe(true);
  expect(await sh(w.repo.path, "worktree", "list", "--porcelain")).toContain(other);
  expect(existsSync(dir)).toBe(false);
  await w.pool.idle();
});

test("prune delegates only canonical orphan directories with safe live git ownership", async () => {
  const w = await world();
  const independent = runTreeDir(w.repo.path, "independent", w.wts);
  await exec(["git", "init", "-q", independent]);
  await writeFile(join(independent, "precious"), "keep");
  const foreign = join(root, "foreign-orphan");
  await mkdir(foreign);
  const link = runTreeDir(w.repo.path, "linked", w.wts);
  await symlink(foreign, link);
  w.landing.orphans = [independent, link, foreign].map((dir) => ({ dir, repoPath: w.repo.path, branch: null, queueable: false }));
  expect(await w.pool.prune()).toEqual([]);
  expect(await readFile(join(independent, "precious"), "utf8")).toBe("keep");
  expect(existsSync(foreign)).toBe(true);
});

test("take ignores disabled warm entries without moving or creating a run branch", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  w.want.delete(w.repo.path);
  const dir = runTreeDir(w.repo.path, "disabled", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/disabled", "main")).toEqual({ took: false, wanted: false });
  expect(existsSync(dir)).toBe(false);
  await w.pool.idle();
});

test("refill reservations do not replace a taken or newly attached slot after delayed gates", async () => {
  const gatesRead = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let wait = false;
  const w = await world({ gates: async (path) => {
    if (wait) { wait = false; gatesRead.resolve(); await gate.promise; }
    const { readGates } = await import("../core/gates");
    return readGates(path);
  } });
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  w.now += WARM_AGE;
  wait = true;
  const ticking = w.pool.tick();
  await gatesRead.promise;
  await sh(slot(w, 1), "checkout", "-q", "-b", "run/attached-during-selection");
  gate.resolve();
  await ticking;
  expect(await currentBranch(slot(w, 1))).toBe("run/attached-during-selection");
  expect(w.setups).toHaveLength(1);
});

test("a tick removes disabled failure-only and unrecorded detached slot folders", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  w.setupAnswer = { exit: 1, output: "failure" };
  await w.pool.tick();
  await sh(w.repo.path, "worktree", "add", "-q", "--detach", slot(w, 1), "main");
  await sh(w.repo.path, "worktree", "add", "-q", "--detach", slot(w, 3), "main");
  w.want.delete(w.repo.path);
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect(existsSync(slot(w, 3))).toBe(false);
  expect(await record(w)).toEqual({ trees: [], fails: [] });
});

test("two repos keep separate empty records and share one backend refill budget", async () => {
  const a = await world();
  const b = await world();
  a.pool.stop();
  b.pool.stop();
  a.want.set(a.repo.path, 1);
  a.want.set(b.repo.path, 1);
  const pool = poolFor(a, { repos: () => [a.repo, b.repo] });
  await pool.adopt();
  await pool.tick();
  const first = await pool.info();
  expect(first.repos.map((r) => r.warm.length)).toEqual([1, 0]);
  expect(first.repos[0]?.warm[0]?.dir).toBe(slot(a, 1));
  expect(EMPTY_RECORD).toEqual({ trees: [], fails: [] });
  await pool.tick();
  expect((await pool.info()).repos.map((r) => r.warm.length)).toEqual([1, 1]);
});

test("re-adoption fences an old refill before reconciling its unrecorded tree", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<CheckOutcome>();
  w.setupAnswer = () => { started.resolve(); return finish.promise; };
  const tick = w.pool.tick();
  await started.promise;
  const adopting = w.pool.adopt();
  finish.resolve({ exit: 0, output: "" });
  await Promise.all([tick, adopting]);
  expect(w.events).toEqual([]);
  expect(existsSync(slot(w, 1))).toBe(false);
  expect(await record(w)).toEqual({ trees: [], fails: [] });
  w.setupAnswer = { exit: 0, output: "" };
  await w.pool.tick();
  expect((await record(w)).trees).toHaveLength(1);
});

test("prune waits for a refill then clears retry without allowing a concurrent replacement", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<CheckOutcome>();
  w.setupAnswer = () => { started.resolve(); return finish.promise; };
  const tick = w.pool.tick();
  await started.promise;
  const pruning = w.pool.prune(w.repo.path);
  await w.pool.tick();
  expect(w.setups).toHaveLength(1);
  finish.resolve({ exit: 1, output: "failed" });
  await Promise.all([tick, pruning]);
  expect(await record(w)).toEqual({ trees: [], fails: [] });
  w.setupAnswer = { exit: 0, output: "" };
  await w.pool.tick();
  expect((await record(w)).trees).toHaveLength(1);
});

test("tick reads disk space once and publishes that observation", async () => {
  let reads = 0;
  const w = await world({ freeBytes: async () => { reads++; return WORKTREE_DISK_MIN; } });
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  expect(reads).toBe(1);
  expect(last(w).free).toBe(WORKTREE_DISK_MIN);
});

test("poke during a scheduled refill keeps a second requested tick for idle", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<CheckOutcome>();
  w.setupAnswer = () => { started.resolve(); return finish.promise; };
  w.pool.poke(w.repo.path);
  await started.promise;
  w.want.set(w.repo.path, 2);
  w.pool.poke(w.repo.path);
  w.setupAnswer = { exit: 0, output: "" };
  finish.resolve({ exit: 0, output: "" });
  await w.pool.idle();
  expect((await record(w)).trees).toHaveLength(2);
});

test("repo-file warm alone does not opt in and a main checkout mid-rebase does not refill", async () => {
  const w = await world();
  await w.pool.tick();
  expect(w.setups).toEqual([]);
  w.want.set(w.repo.path, 1);
  await mkdir(join(w.repo.path, ".git", "rebase-merge"));
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  await rm(join(w.repo.path, ".git", "rebase-merge"), { recursive: true });
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(true);
});

test("routes validate bodies and counts, require explicit warm metadata, and clear zero", async () => {
  const w = await world();
  const call = (path: string, body: string) => w.pool.handle(new Request(`http://x${path}`, { method: "POST", body }), new URL(`http://x${path}`));
  expect((await call("/api/worktrees/warm", "{"))?.status).toBe(400);
  for (const k of [-1, 0.5, 3, "1", null]) expect((await call("/api/worktrees/warm", JSON.stringify({ repo: w.repo.id, n: k })))?.status).toBe(400);
  await writeFile(join(w.repo.path, ".canopy/gates.json"), JSON.stringify({ gates: [] }));
  expect(await (await call("/api/worktrees/warm", JSON.stringify({ repo: w.repo.id })))?.json()).toEqual({ error: `${w.repo.name} has no warm in its gates file; say a number` });
  w.want.set(w.repo.path, 1);
  expect(await (await call("/api/worktrees/warm", JSON.stringify({ repo: w.repo.id, n: 0 })))?.json()).toEqual({ repo: w.repo.id, want: 0 });
  await w.pool.idle();
  expect(w.want.has(w.repo.path)).toBe(false);
});

test("stop during a route's gates read prevents the later config mutation", async () => {
  const w = await world();
  const reading = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const pool = poolFor(w, { gates: async () => { reading.resolve(); await finish.promise; return { source: "none", gates: [], warm: 1 }; } });
  await pool.adopt();
  const response = pool.handle(new Request("http://x/api/worktrees/warm", { method: "POST", body: JSON.stringify({ repo: w.repo.id }) }), new URL("http://x/api/worktrees/warm"));
  await reading.promise;
  pool.stop();
  finish.resolve();
  expect((await response)?.status).toBe(409);
  expect(w.want.size).toBe(0);
});

test("prune removes stale warm trees and keeps current trees", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  expect(await w.pool.prune()).toEqual([]);
  expect(existsSync(slot(w, 1))).toBe(true);
  w.now += WARM_AGE;
  expect(await w.pool.prune()).toEqual([slot(w, 1)]);
  expect(await record(w)).toEqual({ trees: [], fails: [] });
});

test("mutating routes wait for completed adoption before accepting new work", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<CheckOutcome>();
  w.setupAnswer = () => { started.resolve(); return finish.promise; };
  const tick = w.pool.tick();
  await started.promise;
  const adopting = w.pool.adopt();
  const response = await w.pool.handle(new Request("http://x/api/worktrees/warm", { method: "POST", body: JSON.stringify({ repo: w.repo.id, n: 2 }) }), new URL("http://x/api/worktrees/warm"));
  finish.resolve({ exit: 0, output: "" });
  await Promise.all([tick, adopting]);
  expect(response?.status).toBe(409);
  expect(w.want.get(w.repo.path)).toBe(1);
});

test("a take publishes its removal even when the following tick cannot refill", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  w.free = 0;
  await w.pool.take(w.repo.path, runTreeDir(w.repo.path, "low-disk-take", w.wts), "run/low-disk-take", "main");
  await w.pool.idle();
  expect(last(w).repos[0]?.warm).toEqual([]);
  expect(last(w).free).toBe(0);
});

test("canonical unregistered orphans are listed and pruned even without a git repo identity", async () => {
  const w = await world();
  const dir = runTreeDir(w.repo.path, "unregistered", w.wts);
  await mkdir(dir);
  await writeFile(join(dir, "leftover"), "run files");
  w.landing.orphans = [{ dir, repoPath: null, branch: null, queueable: false }];
  expect((await w.pool.info()).repos[0]?.orphans).toEqual([dir]);
  expect(await w.pool.prune(w.repo.path)).toEqual([dir]);
  expect(existsSync(dir)).toBe(false);
});

test("prune revalidates the landing hub's orphan enumeration before delegating deletion", async () => {
  const w = await world();
  const dir = runTreeDir(w.repo.path, "removed-from-enumeration", w.wts);
  await mkdir(dir);
  await writeFile(join(dir, "precious"), "keep");
  w.landing.orphans = [{ dir, repoPath: null, branch: null, queueable: false }];
  let reads = 0;
  const pool = poolFor(w, { landing: () => ++reads === 1 ? w.landing : { runs: [], entries: [], orphans: [] } });
  await pool.adopt();
  expect(await pool.prune(w.repo.path)).toEqual([]);
  expect(await readFile(join(dir, "precious"), "utf8")).toBe("keep");
});

test("a live run's canonical alias is preserved through take, opt-out and prune", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const alias = join(root, "live-alias");
  await symlink(slot(w, 1), alias);
  w.landing.runs = [{ id: "live", runId: "live", repoId: w.repo.id, repoPath: w.repo.path, branch: "run/live", target: "main", base: "main", dir: alias, note: "", verb: "work", harness: "claude", state: "working", startedAt: w.now }];
  const dir = runTreeDir(w.repo.path, "must-not-take", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/must-not-take", "main")).toEqual({ took: false, wanted: true });
  await w.pool.idle();
  w.want.delete(w.repo.path);
  await w.pool.tick();
  w.now += WARM_AGE;
  await w.pool.prune();
  expect(existsSync(join(slot(w, 1), "node_modules", ".ok"))).toBe(true);
  expect(existsSync(dir)).toBe(false);
});

test("setup does not start if the landing queue becomes busy while git creates the slot", async () => {
  const w = await world();
  w.pool.stop();
  w.want.set(w.repo.path, 1);
  const pool = poolFor(w, { want: async (path) => {
    if (existsSync(join(slot(w, 1), ".git"))) w.busy = true;
    return w.want.get(path) ?? 0;
  } });
  await pool.adopt();
  await pool.tick();
  expect(w.setups).toEqual([]);
  expect((await record(w)).trees).toEqual([]);
  expect(existsSync(slot(w, 1))).toBe(false);
});
