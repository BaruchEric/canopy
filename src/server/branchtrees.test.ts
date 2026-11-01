import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTreesRecord, treeDir } from "../core/branchtrees";
import { exec } from "../core/exec";
import type { BranchTree, BranchTreesInfo, Repo, ServerEvent } from "../core/types";
import { BranchTrees, type TreesDeps } from "./branchtrees";

let root = "";
let n = 0;
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
  repo: Repo;
  trees: BranchTrees;
  events: ServerEvent[];
  setups: string[];
  shells: Map<string, number>;
  /** what the backend hears listening; set `now` to change it */
  listening: { now: number[] };
  root: string;
  deps: TreesDeps;
}

async function world(over: Partial<TreesDeps> = {}, setup = "touch setup-ran"): Promise<World> {
  const path = join(root, `r${++n}`);
  await exec(["git", "init", "-q", "-b", "main", path]);
  await sh(path, "config", "user.email", "t@t");
  await sh(path, "config", "user.name", "t");
  await commit(path, ".gitignore", "node_modules/\n.env\n");
  await commit(path, ".canopy/gates.json", JSON.stringify({ gates: [], ...(setup ? { setup } : {}) }));
  await mkdir(join(path, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(path, "node_modules", "pkg", "index.js"), "1");
  await writeFile(join(path, ".env"), "SECRET=1\n");
  const w = {
    repo: { id: `r${n}`, name: `r${n}`, path, group: "", source: "root", status: null } as Repo,
    events: [] as ServerEvent[],
    setups: [] as string[],
    shells: new Map<string, number>(),
    listening: { now: [] as number[] },
    root: join(root, `trees${n}`),
  };
  const deps: TreesDeps = {
    root: w.root,
    repos: () => [w.repo],
    gates: async () => (setup ? { setup } : {}),
    setup: async (dir, line) => {
      w.setups.push(line);
      const r = await exec(["sh", "-c", line], { cwd: dir });
      return { exit: r.code, output: `${r.stdout}${r.stderr}` };
    },
    listening: async () => w.listening.now,
    shellsIn: (dir) => w.shells.get(dir) ?? 0,
    broadcast: (ev) => w.events.push(ev),
    ports: [7900, 7901, 7902],
    portsSpec: "7900-7902",
    every: 0,
    ...over,
  };
  return { ...w, deps, trees: new BranchTrees(deps) };
}

const post = (trees: BranchTrees, path: string, body: unknown): Promise<Response> =>
  trees.handle(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), new URL(`http://x${path}`)) as Promise<Response>;
const get = (trees: BranchTrees): Promise<Response> => trees.handle(new Request("http://x/api/trees"), new URL("http://x/api/trees")) as Promise<Response>;
const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const lastTrees = (events: ServerEvent[]): BranchTreesInfo => {
  const ev = [...events].reverse().find((e) => e.type === "trees");
  if (!ev || ev.type !== "trees") throw new Error("no trees event");
  return ev.trees;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-bth-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("add makes the tree at once, then clones the caches and runs setup, and the record says so", async () => {
  const w = await world();
  const res = await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat/login" });
  expect(res.status).toBe(201);
  const { tree } = await body<{ tree: BranchTree }>(res);
  expect(tree).toMatchObject({ slug: "feat-login", branch: "feat/login", base: "main", state: "preparing", caches: true, ahead: 0, behind: 0, files: 0, shells: 0 });
  expect(tree.port).not.toBeNull();
  expect(tree.dir).toBe(treeDir(w.repo.path, "feat-login", w.root));
  expect(await sh(tree.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/login");
  await w.trees.idle();
  expect(w.setups).toEqual(["touch setup-ran"]);
  expect(existsSync(join(tree.dir, "setup-ran"))).toBe(true);
  expect(await readFile(join(tree.dir, "node_modules", "pkg", "index.js"), "utf8")).toBe("1");
  expect(await readFile(join(tree.dir, ".env"), "utf8")).toBe("SECRET=1\n");
  const rec = parseTreesRecord(await readFile(join(w.root, tree.dir.split("/").slice(-2, -1)[0] ?? "", "trees.json"), "utf8"));
  expect(rec.trees).toEqual([{ slug: "feat-login", branch: "feat/login", base: "main", port: tree.port, madeAt: tree.madeAt, caches: true, state: "ready" }]);
  const info = lastTrees(w.events);
  expect(info.ports).toBe("7900-7902");
  // the setup's own file is untracked in the tree and shows as a change; the caches never do
  expect(info.repos[0]?.trees[0]).toMatchObject({ slug: "feat-login", state: "ready", files: 1 });
  const listed = await body<BranchTreesInfo>(await get(w.trees));
  expect(listed.repos[0]?.trees[0]?.files).toBe(1);
});

test("the port is the branch's hashed one unless taken, and shells are counted", async () => {
  const w = await world();
  const first = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "a", caches: false }));
  w.listening.now = [7900, 7901, 7902].filter((p) => p !== first.tree.port);
  const second = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "b", caches: false }));
  // every port but the first tree's is listened on, and that one is the first tree's
  expect(second.tree.port).toBeNull();
  await w.trees.idle();
  w.shells.set(first.tree.dir, 2);
  const info = await body<BranchTreesInfo>(await get(w.trees));
  expect(info.repos[0]?.trees.map((t) => [t.branch, t.shells])).toEqual([
    ["a", 2],
    ["b", 0],
  ]);
  expect(existsSync(join(first.tree.dir, "node_modules"))).toBe(false);
});

test("a bad branch, a twin, a missing base and a branch checked out elsewhere are refused", async () => {
  const w = await world();
  expect((await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "a b" })).status).toBe(400);
  expect((await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "x", base: "nope" })).status).toBe(400);
  expect((await post(w.trees, "/api/trees/add", { repo: "other", branch: "x" })).status).toBe(404);
  expect((await post(w.trees, "/api/trees/add", { repo: w.repo.id })).status).toBe(400);
  const main = await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "main" });
  expect(main.status).toBe(409);
  expect((await body<{ error: string }>(main)).error).toMatch(/already/);
  expect((await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false })).status).toBe(201);
  const twin = await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "Feat", caches: false });
  expect(twin.status).toBe(409);
  expect((await body<{ error: string }>(twin)).error).toBe(`feat already has a tree in ${w.repo.name}`);
  await w.trees.idle();
});

test("an existing branch is checked out as it is, and base names what it is measured against", async () => {
  const w = await world({}, "");
  await sh(w.repo.path, "branch", "old");
  await commit(w.repo.path, "later.txt", "x\n");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "old", base: "main", caches: false }));
  await w.trees.idle();
  expect(tree).toMatchObject({ branch: "old", base: "main", behind: 1, ahead: 0 });
  expect(w.setups).toEqual([]);
  expect(lastTrees(w.events).repos[0]?.trees[0]?.state).toBe("ready");
});

test("a failed setup leaves the tree in place and says why", async () => {
  const w = await world({}, "echo nope >&2; exit 3");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  const info = await body<BranchTreesInfo>(await get(w.trees));
  expect(info.repos[0]?.trees[0]).toMatchObject({ state: "failed", why: "setup exited 3\nnope\n" });
  expect(existsSync(tree.dir)).toBe(true);
});

test("remove refuses work and open shells unless forced, and takes the branch only when asked", async () => {
  const w = await world({}, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  await writeFile(join(tree.dir, "work.txt"), "wip\n");
  const refused = await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat" });
  expect(refused.status).toBe(409);
  expect((await body<{ error: string }>(refused)).error).toBe("the tree holds 1 changed file; remove it with force to lose that");
  await rm(join(tree.dir, "work.txt"));
  w.shells.set(tree.dir, 1);
  expect((await body<{ error: string }>(await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat" }))).error).toMatch(/1 shell open/);
  w.shells.delete(tree.dir);
  expect((await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "missing" })).status).toBe(404);
  const ok = await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat" });
  expect(ok.status).toBe(200);
  expect(await body<{ removed: string }>(ok)).toEqual({ removed: "feat" });
  expect(existsSync(tree.dir)).toBe(false);
  expect((await sh(w.repo.path, "branch", "--list", "feat")).trim()).toBe("feat");
  expect(lastTrees(w.events).repos).toEqual([]);
  // forced, with the branch, over commits the base lacks
  const again = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  await commit(again.tree.dir, "more.txt", "y\n");
  expect((await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat" })).status).toBe(409);
  expect((await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat", force: true, deleteBranch: true })).status).toBe(200);
  expect((await sh(w.repo.path, "branch", "--list", "feat")).trim()).toBe("");
});

test("adopt reads the record back, drops a tree whose folder went, and takes in a worktree made by hand", async () => {
  const w = await world({}, "");
  await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "kept", caches: false });
  const gone = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "gone", caches: false }));
  await w.trees.idle();
  await rm(gone.tree.dir, { recursive: true, force: true });
  const byHand = treeDir(w.repo.path, "byhand", w.root);
  await sh(w.repo.path, "worktree", "add", "-b", "byhand", byHand, "main");
  const second = new BranchTrees(w.deps);
  await second.adopt();
  const info = await body<BranchTreesInfo>(await get(second));
  expect(info.repos[0]?.trees.map((t) => [t.slug, t.branch, t.base, t.state, t.caches])).toEqual([
    ["kept", "kept", "main", "ready", false],
    ["byhand", "byhand", "main", "ready", false],
  ]);
  expect(second.shellTree(w.repo.path, "byhand")?.dir).toBe(byHand);
  expect(second.shellTree(w.repo.path, "gone")).toBeNull();
  expect(second.shellTree(w.repo.path, "kept")?.port).toBe(info.repos[0]?.trees[0]?.port ?? -1);
});

test("a touch on the checkout publishes the list again once trees exist", async () => {
  const w = await world({}, "");
  w.trees.touched(w.repo.path);
  await Bun.sleep(1_700);
  expect(w.events).toEqual([]);
  await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false });
  await w.trees.idle();
  const before = w.events.length;
  w.trees.touched(w.repo.path);
  w.trees.touched(w.repo.path);
  await Bun.sleep(1_700);
  await w.trees.idle();
  expect(w.events.length).toBe(before + 1);
  w.trees.stop();
});
