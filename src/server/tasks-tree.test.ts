/**
 * Tasks in worktrees (FR-039 plan 2), with a tmux server of its own under a
 * scratch config dir: where a task runs, what it holds, and what ends it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Listening } from "../core/ports";
import { listTaskPanes, taskTermId } from "../core/taskrun";
import type { TaskTimings } from "../core/tasks";
import { killServer, tmuxBase } from "../core/tmux";
import type { Repo, ServerEvent, TaskInfo, TaskTree } from "../core/types";
import { TaskHub, type TaskHubDeps } from "./tasks";

const tmux = Bun.which("tmux") !== null;
setDefaultTimeout(30_000);
const previous = process.env["CANOPY_CONFIG_DIR"];
const TIMINGS: Partial<TaskTimings> = { tick: 50, grace: 300, backoff: 100, backoffCap: 200, giveUp: 3, uptime: 60_000, sweep: 3_600_000, readBack: 50 };

let scratch = "";
let n = 0;
let app: Repo;
let tree: TaskTree;
let hubs: TaskHub[] = [];
let held: Map<string, number[]>;
let next: number;
let events: ServerEvent[];
let said: string[];

const ports: NonNullable<TaskHubDeps["ports"]> = {
  hold: async (owner, _key, count) => {
    const have = held.get(owner);
    if (have?.length === count) return have;
    const got = Array.from({ length: count }, () => next++);
    held.set(owner, got);
    return got;
  },
  release: (owner) => void held.delete(owner),
  seed: (owner, list) => void held.set(owner, [...list]),
};

function hub(over: Partial<TaskHubDeps> = {}): TaskHub {
  const h = new TaskHub({
    tmux: tmuxBase(),
    repos: () => [app],
    own: async () => true,
    viewers: () => [],
    hold: () => {},
    broadcast: (ev) => events.push(ev),
    gaveUp: () => {},
    ports,
    treeOf: (_repo, id) => (id === tree.id ? tree : null),
    ended: (_repo, text) => said.push(text),
    ...over,
    timings: TIMINGS,
  });
  hubs.push(h);
  return h;
}

async function until(pred: () => Promise<boolean> | boolean, what: string, ms = 15_000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const panes = async () => {
  const r = await listTaskPanes(tmuxBase()!);
  return Array.isArray(r) ? r : [];
};
const treeTask = async (h: TaskHub, name = "dev"): Promise<TaskInfo | undefined> => (await h.tasksOf(app, false)).trees?.find((t) => t.name === name);

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-tasks-tree-")));
  const path = join(scratch, "app");
  await mkdir(join(path, ".canopy"), { recursive: true });
  await writeFile(
    join(path, ".canopy/tasks.json"),
    JSON.stringify([
      { name: "dev", cmd: `printf '%s %s %s\\n' "$PORT" "$API" "$PWD" > seen.txt; exec sleep 30`, env: { PORT: "${PORT}", API: "http://x:${PORT_2}${WORKTREE}" }, dev: true },
      { name: "plain", cmd: "exec sleep 30" },
      { name: "flaky", cmd: `echo "$PORT" >> runs.txt; sleep 0.1; exit 1`, env: { PORT: "${PORT}" }, keep: true },
    ]),
  );
  app = { id: "app", name: "app", path } as Repo;
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
});
beforeEach(async () => {
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, `cfg${++n}`);
  const dir = join(scratch, `tree${n}`);
  await mkdir(dir, { recursive: true });
  tree = { id: `t${n}`, dir, branch: `run/t${n}` };
  held = new Map();
  next = 7900;
  events = [];
  said = [];
  hubs = [];
});
afterEach(async () => {
  for (const h of hubs) {
    h.stop();
    await h.settled();
  }
  if (tmux) await killServer(tmuxBase()!).catch(() => {});
});

test.skipIf(!tmux)("a start names the branch: it runs in the worktree with its env filled, apart from the repo's list", async () => {
  const h = hub();
  await h.start();
  const r = await h.actIn(app, tree, "start");
  expect(r.tasks.find((t) => t.name === "dev")?.status).toBe("idle");
  expect(r.trees?.map((t) => [t.name, t.tree?.id, t.port, t.ports])).toEqual([["dev", tree.id, 7900, [7900, 7901]]]);
  await until(() => existsSync(join(tree.dir, "seen.txt")), "the task's output");
  expect((await readFile(join(tree.dir, "seen.txt"), "utf8")).trim()).toBe(`7900 http://x:7901${tree.dir} ${tree.dir}`);
  expect(existsSync(join(app.path, "seen.txt"))).toBe(false);
  const [pane] = await panes();
  expect(pane).toMatchObject({ termId: taskTermId(tree.dir, "dev"), path: app.path, tree: tree.dir, repoId: "app", task: "dev" });
  expect(h.busy(tree.dir)).toBe(true);
  expect(h.treeHolds()).toEqual([{ repoId: "app", dir: tree.dir, branch: tree.branch, task: "dev", ports: [7900, 7901] }]);
  expect(h.taskIn(tree.dir)).toEqual({ name: "dev", status: "running", port: 7900 });
  const ev = [...events].reverse().find((e) => e.type === "tasks");
  expect(ev?.type === "tasks" && ev.trees?.[0]?.name).toBe("dev");
});

test.skipIf(!tmux)("the route takes a branch id and never a folder", async () => {
  const h = hub();
  await h.start();
  const url = new URL("http://x/api/repos/tasks?id=app");
  const post = (body: unknown) => h.handle(new Request(url.href, { method: "POST", body: JSON.stringify(body) }), url, () => app);
  expect((await post({ action: "start", worktree: tree.dir }))?.status).toBe(404);
  expect((await post({ action: "start", worktree: 3 }))?.status).toBe(404);
  const ok = await post({ action: "start", worktree: tree.id });
  expect(ok?.status).toBe(200);
  expect((await post({ action: "start", worktree: tree.id }))?.status).toBe(409);
});

test.skipIf(!tmux)("the checkout's dev and a worktree's run side by side, each with its own session", async () => {
  const h = hub();
  await h.start();
  await h.act(app, "start", "dev");
  await h.actIn(app, tree, "start", "dev");
  expect((await panes()).map((p) => p.termId).sort()).toEqual([taskTermId(app.path, "dev"), taskTermId(tree.dir, "dev")].sort());
  const r = await h.tasksOf(app, false);
  expect(r.tasks.find((t) => t.name === "dev")).toMatchObject({ status: "running", port: 7900 });
  expect(r.tasks.find((t) => t.name === "dev")?.tree).toBeUndefined();
  expect(r.trees?.[0]).toMatchObject({ status: "running", port: 7902 });
  await h.act(app, "stop", "dev");
  expect((await h.tasksOf(app, false)).trees?.[0]?.status).toBe("running");
});

test.skipIf(!tmux)("a stop gives the ports back and keeps the task on the branch's list", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start");
  await h.actIn(app, tree, "stop");
  const t = await treeTask(h);
  expect(t?.status).toBe("stopped");
  expect(t?.ports).toBeUndefined();
  expect(held.size).toBe(0);
  expect(h.busy(tree.dir)).toBe(false);
  expect(h.treeHolds()).toEqual([]);
});

test.skipIf(!tmux)("a keep task that dies comes back in the worktree on the same port", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "flaky");
  await until(async () => (await readFile(join(tree.dir, "runs.txt"), "utf8").catch(() => "")).trim().split("\n").length >= 2, "a restart");
  const runs = (await readFile(join(tree.dir, "runs.txt"), "utf8")).trim().split("\n");
  expect(new Set(runs)).toEqual(new Set(["7900"]));
  expect(existsSync(join(app.path, "runs.txt"))).toBe(false);
});

test.skipIf(!tmux)("a task with no env holds nothing and its port is read back by folder", async () => {
  const ls: Listening[] = [{ port: 5173, host: "127.0.0.1", cwd: "/elsewhere" }];
  const h = hub({ listening: async () => ls });
  await h.start();
  await h.actIn(app, tree, "start", "plain");
  expect(held.size).toBe(0);
  expect((await treeTask(h, "plain"))?.port).toBeUndefined();
  ls.push({ port: 5174, host: "127.0.0.1", cwd: join(tree.dir, "ui"), command: "node" });
  await until(async () => (await treeTask(h, "plain"))?.port === 5174, "the port read back");
});

test.skipIf(!tmux)("endTree stops and forgets everything in the folder and says so", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start");
  await h.actIn(app, tree, "start", "plain");
  expect((await h.endTree(tree.dir)).sort()).toEqual(["stopped dev", "stopped plain"]);
  expect(await panes()).toEqual([]);
  expect((await h.tasksOf(app, false)).trees).toBeUndefined();
  expect(held.size).toBe(0);
  expect(await h.endTree(tree.dir)).toEqual([]);
});

test.skipIf(!tmux)("a restart takes the task back with its ports; with its folder gone it is ended with a note", async () => {
  const first = hub();
  await first.start();
  await first.actIn(app, tree, "start");
  first.stop();
  await first.settled();
  held = new Map();

  const again = hub();
  await again.start();
  expect(held.get(taskTermId(tree.dir, "dev"))).toEqual([7900, 7901]);
  await until(async () => (await treeTask(again))?.status === "running", "the task adopted");
  again.stop();
  await again.settled();

  await rm(tree.dir, { recursive: true, force: true });
  const third = hub();
  await third.start();
  await until(async () => (await panes()).length === 0, "the task ended");
  await until(() => said.includes("stopped dev"), "the note");
  expect(said[0]).toBe(`${tree.dir} is gone`);
  expect((await third.tasksOf(app, false)).trees).toBeUndefined();
  expect(held.size).toBe(0);
});

test.skipIf(!tmux)("a kept tree's card gets the tree's port as PORT and allots the rest", async () => {
  const card = { ...app, id: "card", path: tree.dir } as Repo;
  await mkdir(join(tree.dir, ".canopy"), { recursive: true });
  await writeFile(join(tree.dir, ".canopy/tasks.json"), await readFile(join(app.path, ".canopy/tasks.json"), "utf8"));
  const h = hub({ repos: () => [app, card], keptPort: (dir) => (dir === tree.dir ? 7920 : null) });
  await h.start();
  await h.act(card, "start", "dev");
  await until(() => existsSync(join(tree.dir, "seen.txt")), "the task's output");
  expect((await readFile(join(tree.dir, "seen.txt"), "utf8")).split(" ")[0]).toBe("7920");
  expect(h.busy(tree.dir)).toBe(true);
  expect(await h.endTree(tree.dir)).toEqual(["stopped dev"]);
});

test.skipIf(!tmux)("a task that asks for a port is refused when there is none", async () => {
  const h = hub({ ports: { ...ports, hold: async () => null } });
  await h.start();
  await expect(h.actIn(app, tree, "start")).rejects.toThrow("CANOPY_TREE_PORTS has too few left");
  const none = hub({ ports: undefined });
  await none.start();
  await expect(none.actIn(app, tree, "start")).rejects.toThrow("this backend allots none");
});

test.skipIf(!tmux)("a repo with no dev task says so when none is named", async () => {
  const bare = { ...app, id: "bare", path: join(scratch, "bare") } as Repo;
  await mkdir(bare.path, { recursive: true });
  const h = hub({ repos: () => [bare] });
  await h.start();
  await expect(h.actIn(bare, tree, "start")).rejects.toThrow("has no dev task");
});

test("saving a task to the repo file from the sheet keeps its env", async () => {
  const h = hub({ tmux: ["true"] });
  const url = new URL("http://x/api/repos/tasks/def?id=app");
  const res = await h.handle(new Request(url.href, { method: "POST", body: JSON.stringify({ name: "dev", target: "repo", def: { cmd: "vite --port $PORT" } }) }), url, () => app);
  expect(res?.status).toBe(200);
  const list = JSON.parse(await readFile(join(app.path, ".canopy/tasks.json"), "utf8")) as { name: string; cmd: string; env?: object }[];
  expect(list.find((t) => t.name === "dev")).toMatchObject({ cmd: "vite --port $PORT", env: { PORT: "${PORT}" } });
});
