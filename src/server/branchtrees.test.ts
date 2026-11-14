import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTreesRecord, treeDir } from "../core/branchtrees";
import { treeStep } from "../core/coordinator";
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
  expect(rec.trees).toEqual([{ slug: "feat-login", branch: "feat/login", base: "main", port: tree.port, madeAt: tree.madeAt, caches: true, state: "ready", sync: true, syncedTo: await sh(w.repo.path, "rev-parse", "main") }]);
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

test("a task's held port is never a tree's, and comes back when released", async () => {
  const w = await world();
  const held = await w.trees.hold("task-a", "feat", 2);
  expect(held).toHaveLength(2);
  const free = [7900, 7901, 7902].filter((p) => !held?.includes(p));
  const tree = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  expect(tree.tree.port).toBe(free[0] ?? null);
  await w.trees.idle();
  expect(await w.trees.hold("task-b", "other", 1)).toBeNull();
  w.trees.release("task-a");
  expect(await w.trees.hold("task-b", "other", 1)).toHaveLength(1);
});

test("a hold is the owner's: asked again it answers the same, and two at once never share", async () => {
  const w = await world();
  const [a, b] = await Promise.all([w.trees.hold("a", "feat", 1), w.trees.hold("b", "feat", 1)]);
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a?.[0]).not.toBe(b?.[0]);
  expect(await w.trees.hold("a", "something else", 1)).toEqual(a);
});

test("a port something listens on is passed over, and a seeded hold is held", async () => {
  const w = await world();
  w.listening.now = [7900];
  w.trees.seed("task-a", [7901]);
  expect(await w.trees.hold("task-b", "feat", 1)).toEqual([7902]);
  expect(await w.trees.hold("task-c", "feat", 1)).toBeNull();
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

test("merge, and remove without force, refuse while a run is at work in the tree; force still removes it", async () => {
  const at = new Map<string, string>();
  const w = await world({ runIn: (dir) => at.get(dir) }, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat/x", caches: false }));
  await w.trees.idle();
  at.set(tree.dir, "run c1a2b3c4 (Ask)");
  const words = "run c1a2b3c4 (Ask) is at work in tree feat/x; stop it first";
  const merge = await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat/x" });
  expect(merge.status).toBe(409);
  expect((await body<{ error: string }>(merge)).error).toBe(words);
  const remove = await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat/x" });
  expect(remove.status).toBe(409);
  expect((await body<{ error: string }>(remove)).error).toBe(words);
  // nothing moved: the tree is still there and still ready
  expect(existsSync(tree.dir)).toBe(true);
  expect((await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees[0]?.state).toBe("ready");
  // a run in another folder holds nothing here
  at.clear();
  at.set(join(w.root, "elsewhere"), "run d5e6f7a8 (Ask)");
  expect((await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat/x", keep: true })).status).toBe(202);
  await w.trees.idle();
  at.set(tree.dir, "run c1a2b3c4 (Ask)");
  expect((await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat/x", force: true })).status).toBe(200);
  expect(existsSync(tree.dir)).toBe(false);
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

test("treeFor finds a tree by its branch exactly, never its slug, with its state, and none once it is removed", async () => {
  // the setup waits until it is let go, so the tree is surely still being prepared
  let letGo = (): void => {};
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const w = await world({
    setup: async () => {
      await held;
      return { exit: 0, output: "" };
    },
  });
  const made = await w.trees.add(w.repo, "Feat/Login", undefined, false);
  expect(w.trees.treeFor(w.repo.path, "Feat/Login")).toEqual({ slug: "feat-login", branch: "Feat/Login", dir: made.dir, state: "preparing" });
  letGo();
  await w.trees.idle();
  expect(w.trees.treeFor(w.repo.path, "Feat/Login")).toEqual({ slug: "feat-login", branch: "Feat/Login", dir: made.dir, state: "ready" });
  expect(w.trees.treeFor(w.repo.path, "feat-login")).toBeNull();
  expect(w.trees.treeFor(w.repo.path, "feat/login")).toBeNull();
  expect(w.trees.treeFor(join(root, "elsewhere"), "Feat/Login")).toBeNull();
  await w.trees.remove(w.repo, "Feat/Login", true, false);
  expect(w.trees.treeFor(w.repo.path, "Feat/Login")).toBeNull();
});

test("treeFor carries a failed tree's why", async () => {
  const w = await world({}, "echo nope >&2; exit 3");
  await w.trees.add(w.repo, "feat", undefined, false);
  await w.trees.idle();
  expect(w.trees.treeFor(w.repo.path, "feat")).toMatchObject({ branch: "feat", state: "failed", why: "setup exited 3\nnope\n" });
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

test("merge sweeps the uncommitted work in, squashes, fast-forwards the checkout's base and removes the tree and branch", async () => {
  // a slow gate keeps the merge going long enough to be seen at it
  const w = await world({ gates: async () => ({ gates: [{ name: "slow", run: "sleep 1" }] }) }, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  await commit(tree.dir, "a.txt", "a\n");
  await commit(tree.dir, "b.txt", "b\n");
  await writeFile(join(tree.dir, "c.txt"), "c\n");
  const res = await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat" });
  expect(res.status).toBe(202);
  expect((await body<{ tree: BranchTree }>(res)).tree.state).toBe("merging");
  expect((await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees[0]?.state).toBe("merging");
  // a second merge, and a removal, wait for the first
  expect((await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat" })).status).toBe(409);
  expect((await body<{ error: string }>(await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "feat" }))).error).toMatch(/being merged/);
  await w.trees.idle();
  expect(lastTrees(w.events).repos).toEqual([]);
  expect(existsSync(tree.dir)).toBe(false);
  expect((await sh(w.repo.path, "branch", "--list", "feat")).trim()).toBe("");
  // one commit on main holding all three files, titled by the first subject
  expect(await sh(w.repo.path, "log", "--format=%s", "-3")).toBe("c a.txt\nc .canopy/gates.json\nc .gitignore");
  expect(await sh(w.repo.path, "show", "--format=", "--name-only", "HEAD")).toBe("a.txt\nb.txt\nc.txt");
  expect(await sh(w.repo.path, "status", "--porcelain")).toBe("");
});

test("merge stops on a conflict, a failing gate or the checkout's own changes, says why, and goes once that is fixed; kept, the tree stays", async () => {
  const gates = { now: [] as { name: string; run: string }[] };
  const w = await world({ gates: async () => ({ gates: gates.now }) }, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  await commit(tree.dir, "x.txt", "tree\n");
  await commit(w.repo.path, "x.txt", "main\n");
  await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat" });
  await w.trees.idle();
  let t = lastTrees(w.events).repos[0]?.trees[0];
  expect(t?.state).toBe("ready");
  expect(t?.stopped).toBe("merge stopped: the rebase onto main stopped on x.txt and was aborted; rebase by hand in the tree, then merge again");
  expect(await sh(tree.dir, "status", "--porcelain")).toBe("");
  // the conflict resolved by hand: the tree takes main's x.txt and adds its own file
  await sh(tree.dir, "reset", "-q", "--hard", "main");
  await commit(tree.dir, "y.txt", "y\n");
  gates.now = [{ name: "check", run: "exit 7" }];
  await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat" });
  await w.trees.idle();
  t = lastTrees(w.events).repos[0]?.trees[0];
  expect(t?.stopped).toBe("merge stopped: gate check exited 7");
  expect(await sh(w.repo.path, "log", "-1", "--format=%s")).toBe("c x.txt");
  // the checkout holds its own change to a file the branch touches
  gates.now = [{ name: "check", run: "test -f y.txt" }];
  await writeFile(join(w.repo.path, "y.txt"), "mine\n");
  await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat" });
  await w.trees.idle();
  t = lastTrees(w.events).repos[0]?.trees[0];
  expect(t?.stopped).toBe("merge stopped: main is checked out with changes to y.txt; commit or stash them, then merge again");
  await rm(join(w.repo.path, "y.txt"));
  await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat", keep: true });
  await w.trees.idle();
  t = lastTrees(w.events).repos[0]?.trees[0];
  expect(t).toMatchObject({ state: "ready", ahead: 0, behind: 0, files: 0 });
  expect(t?.stopped).toBeUndefined();
  expect(await sh(w.repo.path, "log", "-1", "--format=%s")).toBe("c y.txt");
  expect(existsSync(tree.dir)).toBe(true);
  // no squash keeps the commits as they are
  await commit(tree.dir, "p.txt", "p\n");
  await commit(tree.dir, "q.txt", "q\n");
  await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "feat", squash: false });
  await w.trees.idle();
  expect(lastTrees(w.events).repos).toEqual([]);
  expect(await sh(w.repo.path, "log", "--format=%s", "-3")).toBe("c q.txt\nc p.txt\nc y.txt");
});

test("a tree's tasks end before its folder goes, on remove, clean and merge", async () => {
  const stopped: [string, boolean][] = [];
  const w = await world({ stopTree: async (dir) => void stopped.push([dir, existsSync(dir)]) }, "");
  const add = async (branch: string) => (await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch, caches: false }))).tree;
  const one = await add("one");
  const two = await add("two");
  const three = await add("three");
  await w.trees.idle();
  await post(w.trees, "/api/trees/remove", { repo: w.repo.id, tree: "one", force: true });
  expect(stopped).toEqual([[one.dir, true]]);
  await post(w.trees, "/api/trees/clean", { repo: w.repo.id });
  expect(stopped).toContainEqual([two.dir, true]);
  expect(stopped).toContainEqual([three.dir, true]);
  expect(existsSync(two.dir)).toBe(false);
  const four = await add("four");
  await w.trees.idle();
  await writeFile(join(four.dir, "new.txt"), "x\n");
  await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "four" });
  await w.trees.idle();
  expect(stopped.at(-1)).toEqual([four.dir, true]);
  expect(existsSync(four.dir)).toBe(false);
});

test("clean removes the trees merged into their base that hold nothing, branch and all, and leaves the rest", async () => {
  const w = await world({}, "");
  const done = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "done", caches: false }));
  const busy = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "busy", caches: false }));
  const ahead = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "ahead", caches: false }));
  await w.trees.idle();
  await writeFile(join(busy.tree.dir, "wip.txt"), "wip\n");
  await commit(ahead.tree.dir, "more.txt", "m\n");
  const res = await post(w.trees, "/api/trees/clean", { repo: w.repo.id });
  expect(res.status).toBe(200);
  expect(await body<{ removed: unknown }>(res)).toEqual({ removed: [{ repoId: w.repo.id, slug: "done", branch: "done" }] });
  expect(existsSync(done.tree.dir)).toBe(false);
  expect((await sh(w.repo.path, "branch", "--list", "done")).trim()).toBe("");
  await w.trees.idle();
  expect(lastTrees(w.events).repos[0]?.trees.map((t) => t.branch)).toEqual(["busy", "ahead"]);
  // every repo, with nothing left to take
  expect(await body<{ removed: unknown }>(await post(w.trees, "/api/trees/clean", {}))).toEqual({ removed: [] });
  expect((await post(w.trees, "/api/trees/clean", { repo: "nope" })).status).toBe(404);
});

test("clean leaves a tree a run is at work in, however clean it looks, and takes it once the run is gone", async () => {
  const at = new Map<string, string>();
  const w = await world({ runIn: (dir) => at.get(dir) }, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "card/x", caches: false }));
  await w.trees.idle();
  at.set(tree.dir, "run c1a2b3c4 (Ask)");
  expect(await body<{ removed: unknown }>(await post(w.trees, "/api/trees/clean", { repo: w.repo.id }))).toEqual({ removed: [] });
  expect(existsSync(tree.dir)).toBe(true);
  at.clear();
  expect(await body<{ removed: unknown }>(await post(w.trees, "/api/trees/clean", { repo: w.repo.id }))).toEqual({
    removed: [{ repoId: w.repo.id, slug: tree.slug, branch: "card/x" }],
  });
  expect(existsSync(tree.dir)).toBe(false);
});

test("a record left merging by a crash comes back ready, saying so", async () => {
  const w = await world({}, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  const file = join(w.root, tree.dir.split("/").slice(-2, -1)[0] ?? "", "trees.json");
  const rec = parseTreesRecord(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ trees: rec.trees.map((t) => ({ ...t, state: "merging" })) }));
  const second = new BranchTrees(w.deps);
  await second.adopt();
  const info = await body<BranchTreesInfo>(await get(second));
  expect(info.repos[0]?.trees[0]).toMatchObject({ state: "ready", stopped: "merge stopped: the server restarted during the merge; merge again" });
});

test("a record left preparing by a restart comes back failed, saying so, and a card on its branch fails in those words", async () => {
  const w = await world({}, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat/x", caches: false }));
  await w.trees.idle();
  const file = join(w.root, tree.dir.split("/").slice(-2, -1)[0] ?? "", "trees.json");
  const rec = parseTreesRecord(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ trees: rec.trees.map((t) => ({ ...t, state: "preparing" })) }));
  const second = new BranchTrees(w.deps);
  await second.adopt();
  const why = "the server restarted while the tree was being prepared; remove it and add it again";
  const info = await body<BranchTreesInfo>(await get(second));
  expect(info.repos[0]?.trees[0]).toMatchObject({ state: "failed", why });
  expect(parseTreesRecord(await readFile(file, "utf8")).trees[0]).toMatchObject({ state: "failed", why });
  expect(treeStep("feat/x", second.treeFor(w.repo.path, "feat/x"), false)).toEqual({ fail: `tree feat/x failed: ${why}` });
});

test("sync rebases a tree onto its base with its uncommitted work put back, and a conflict stops it with a note until the base moves again", async () => {
  const w = await world({}, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  expect(tree.sync).toBe(true);
  await commit(tree.dir, "t.txt", "t\n");
  await writeFile(join(tree.dir, "wip.txt"), "wip\n");
  const moved = await commit(w.repo.path, "m.txt", "m\n");
  // the base moved: the pass brings the tree up, the uncommitted file over it
  await w.trees.autoSync(w.repo.path);
  let t = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees[0];
  expect(t).toMatchObject({ ahead: 1, behind: 0, files: 1, syncedTo: moved });
  expect(await readFile(join(tree.dir, "wip.txt"), "utf8")).toBe("wip\n");
  expect(existsSync(join(tree.dir, "m.txt"))).toBe(true);
  // both sides change one file: the rebase stops, is aborted, and the note says so
  await rm(join(tree.dir, "wip.txt"));
  await commit(tree.dir, "c.txt", "tree\n");
  const again = await commit(w.repo.path, "c.txt", "main\n");
  await w.trees.autoSync(w.repo.path);
  t = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees[0];
  expect(t).toMatchObject({ behind: 1, syncedTo: again, stopped: "sync stopped: the rebase onto main stopped on c.txt and was aborted; rebase by hand in the tree" });
  expect(await sh(tree.dir, "status", "--porcelain")).toBe("");
  // by hand it answers with the same note
  const res = await post(w.trees, "/api/trees/sync", { repo: w.repo.id, tree: "feat" });
  expect(res.status).toBe(409);
  expect((await body<{ error: string }>(res)).error).toMatch(/^sync stopped: the rebase onto main stopped on c\.txt/);
  // the conflicting commit dropped by hand, the sync goes and clears the note
  await sh(tree.dir, "reset", "-q", "--hard", "HEAD~1");
  const ok = await post(w.trees, "/api/trees/sync", { repo: w.repo.id, tree: "feat" });
  expect(ok.status).toBe(200);
  const synced = (await body<{ tree: BranchTree }>(ok)).tree;
  expect(synced).toMatchObject({ ahead: 1, behind: 0, files: 0, syncedTo: again });
  expect(synced.stopped).toBeUndefined();
  expect(await sh(tree.dir, "log", "--format=%s", "-3")).toBe("c t.txt\nc c.txt\nc m.txt");
});

/** main's tip amended in place: new content and body, the subject and author time kept */
const amend = async (cwd: string, name: string, text: string): Promise<string> => {
  await writeFile(join(cwd, name), text);
  await sh(cwd, "commit", "-q", "-a", "--amend", "-m", `c ${name}`, "-m", "amended");
  return sh(cwd, "rev-parse", "HEAD");
};

test("a commit the tree took from main and main then amended is left behind, not replayed, by sync and by merge", async () => {
  const w = await world({}, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  await commit(w.repo.path, "x.txt", "x\n");
  await w.trees.autoSync(w.repo.path);
  await commit(tree.dir, "t.txt", "t\n");
  const amended = await amend(w.repo.path, "x.txt", "x2\n");
  // replaying the old x.txt over its amend would stop on x.txt; the tree keeps only its own commit
  await w.trees.autoSync(w.repo.path);
  const t = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees[0];
  expect(t).toMatchObject({ ahead: 1, behind: 0, syncedTo: amended });
  expect(t?.stopped).toBeUndefined();
  expect(await sh(tree.dir, "rev-parse", "HEAD~1")).toBe(amended);
  expect(await readFile(join(tree.dir, "x.txt"), "utf8")).toBe("x2\n");
  // a tree that does not follow, merged after the amend, lands its own commit alone
  const { tree: still } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "still", caches: false, sync: false }));
  await w.trees.idle();
  await commit(w.repo.path, "y.txt", "y\n");
  expect((await post(w.trees, "/api/trees/sync", { repo: w.repo.id, tree: "still" })).status).toBe(200);
  await commit(still.dir, "s.txt", "s\n");
  const y2 = await amend(w.repo.path, "y.txt", "y2\n");
  await post(w.trees, "/api/trees/merge", { repo: w.repo.id, tree: "still" });
  await w.trees.idle();
  expect(lastTrees(w.events).repos[0]?.trees.map((x) => x.branch)).toEqual(["feat"]);
  expect(await sh(w.repo.path, "rev-parse", "HEAD~1")).toBe(y2);
  expect(await sh(w.repo.path, "log", "--format=%s", "-1")).toBe("c s.txt");
});

test("a commit of the tree's own that main held and then dropped is still replayed", async () => {
  const w = await world({}, "");
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  await commit(tree.dir, "t.txt", "t\n");
  // landed by hand, then undone on main: the base's reflog held t.txt's commit, and no twin of it is left there
  await sh(w.repo.path, "merge", "-q", "--ff-only", "feat");
  await sh(w.repo.path, "reset", "-q", "--hard", "HEAD~1");
  const moved = await commit(w.repo.path, "z.txt", "z\n");
  await w.trees.autoSync(w.repo.path);
  const t = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees[0];
  expect(t).toMatchObject({ ahead: 1, behind: 0, syncedTo: moved });
  expect(await sh(tree.dir, "log", "--format=%s", "-2")).toBe("c t.txt\nc z.txt");
});

test("a tree that follows waits while something is at work in it, says what, and goes once it is quiet; a sync by hand does not wait", async () => {
  const work = new Map<string, string>();
  const asked: string[][] = [];
  const w = await world(
    {
      working: async (dirs) => {
        asked.push([...dirs]);
        return new Map([...work].filter(([dir]) => dirs.includes(dir)));
      },
    },
    "",
  );
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  const other = (await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "quiet", caches: false }))).tree;
  await w.trees.idle();
  // nothing moved: nobody is asked what runs where
  await w.trees.autoSync(w.repo.path);
  expect(asked).toEqual([]);

  await writeFile(join(tree.dir, "wip.txt"), "wip\n");
  const moved = await commit(w.repo.path, "m.txt", "m\n");
  work.set(tree.dir, "bun test");
  await w.trees.autoSync(w.repo.path);
  expect(asked).toEqual([[tree.dir, other.dir]]);
  let trees = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees ?? [];
  // the busy tree stays where it was and says why; the quiet one went
  expect(trees.find((t) => t.slug === "feat")).toMatchObject({ behind: 1, waiting: "bun test" });
  expect(trees.find((t) => t.slug === "feat")?.syncedTo).not.toBe(moved);
  expect(existsSync(join(tree.dir, "m.txt"))).toBe(false);
  expect(trees.find((t) => t.slug === "quiet")).toMatchObject({ behind: 0, syncedTo: moved });
  expect(trees.find((t) => t.slug === "quiet")?.waiting).toBeUndefined();
  // the wait is not kept in the record: a backend started now has yet to ask
  const second = new BranchTrees(w.deps);
  await second.adopt();
  expect((await body<BranchTreesInfo>(await get(second))).repos[0]?.trees.find((t) => t.slug === "feat")?.waiting).toBeUndefined();

  // the next pass asks about the one still behind, and it is quiet now
  work.clear();
  await w.trees.autoSync(w.repo.path);
  expect(asked[1]).toEqual([tree.dir]);
  trees = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees ?? [];
  expect(trees.find((t) => t.slug === "feat")).toMatchObject({ behind: 0, files: 1, syncedTo: moved });
  expect(trees.find((t) => t.slug === "feat")?.waiting).toBeUndefined();
  expect(await readFile(join(tree.dir, "wip.txt"), "utf8")).toBe("wip\n");

  // by hand: the work is whoever asked's to judge, and the wait's note goes with the sync
  await commit(w.repo.path, "n.txt", "n\n");
  work.set(tree.dir, "vitest");
  await w.trees.autoSync(w.repo.path);
  expect((await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees.find((t) => t.slug === "feat")?.waiting).toBe("vitest");
  const res = await post(w.trees, "/api/trees/sync", { repo: w.repo.id, tree: "feat" });
  expect(res.status).toBe(200);
  const synced = (await body<{ tree: BranchTree }>(res)).tree;
  expect(synced.behind).toBe(0);
  expect(synced.waiting).toBeUndefined();
});

test("a tree that follows goes ahead when what runs in it cannot be read", async () => {
  const w = await world(
    {
      working: async () => {
        throw new Error("the process table could not be read");
      },
    },
    "",
  );
  const { tree } = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "feat", caches: false }));
  await w.trees.idle();
  const moved = await commit(w.repo.path, "m.txt", "m\n");
  await w.trees.autoSync(w.repo.path);
  const t = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees[0];
  expect(t).toMatchObject({ behind: 0, syncedTo: moved });
  expect(existsSync(join(tree.dir, "m.txt"))).toBe(true);
});

test("a tree told not to follow stays behind, the main checkout's touch syncs the ones that do, and auto turns it on or off", async () => {
  const w = await world({}, "");
  const a = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "a", caches: false, sync: false }));
  const b = await body<{ tree: BranchTree }>(await post(w.trees, "/api/trees/add", { repo: w.repo.id, branch: "b", caches: false }));
  await w.trees.idle();
  expect([a.tree.sync, b.tree.sync]).toEqual([false, true]);
  const first = await sh(w.repo.path, "rev-parse", "main");
  const moved = await commit(w.repo.path, "m.txt", "m\n");
  w.trees.touched(w.repo.path);
  // the touch is debounced 1.5 s, then the pass runs as a job
  await Bun.sleep(1_800);
  await w.trees.idle();
  let trees = lastTrees(w.events).repos[0]?.trees ?? [];
  expect(trees.map((t) => [t.branch, t.behind, t.syncedTo])).toEqual([["a", 1, first], ["b", 0, moved]]);
  // turned on, the next pass brings a up too
  const on = await post(w.trees, "/api/trees/auto", { repo: w.repo.id, tree: "a", sync: true });
  expect(on.status).toBe(200);
  expect((await body<{ tree: BranchTree }>(on)).tree.sync).toBe(true);
  await w.trees.autoSync(w.repo.path);
  trees = (await body<BranchTreesInfo>(await get(w.trees))).repos[0]?.trees ?? [];
  expect(trees.map((t) => [t.branch, t.behind, t.syncedTo])).toEqual([["a", 0, moved], ["b", 0, moved]]);
  expect((await post(w.trees, "/api/trees/auto", { repo: w.repo.id, tree: "a", sync: "yes" })).status).toBe(400);
  expect((await post(w.trees, "/api/trees/auto", { repo: w.repo.id, tree: "nope", sync: false })).status).toBe(404);
  expect((await post(w.trees, "/api/trees/sync", { repo: w.repo.id, tree: "nope" })).status).toBe(404);
});
