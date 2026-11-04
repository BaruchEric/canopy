/**
 * Compose stacks in worktrees (FR-039 plan 3): the hub with a real tmux of
 * its own and a fake docker. These tasks set `compose: true` on a harmless
 * cmd, so tmux has no docker to run, and every docker call is recorded here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWN_STACK, projectName } from "../core/compose";
import { taskTermId } from "../core/taskrun";
import type { TaskTimings } from "../core/tasks";
import { killServer, tmuxBase } from "../core/tmux";
import type { Repo, TaskInfo, TaskTree } from "../core/types";
import { TaskHub, type TaskHubDeps } from "./tasks";

const tmux = Bun.which("tmux") !== null;
setDefaultTimeout(30_000);
const previous = process.env["CANOPY_CONFIG_DIR"];
const TIMINGS: Partial<TaskTimings> = { tick: 50, grace: 300, backoff: 100, backoffCap: 200, giveUp: 3, uptime: 60_000, sweep: 3_600_000 };

let scratch = "";
let n = 0;
let app: Repo;
let tree: TaskTree;
let config = "";
let hubs: TaskHub[] = [];
let held: Map<string, number[]>;
let next: number;
let said: string[];
let calls: string[][];
let ownStack: boolean;
let missing: string | null;

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

const docker: NonNullable<TaskHubDeps["compose"]> = {
  missing: async () => missing,
  ownStack: async () => ownStack,
  run: async (args) => {
    calls.push(args);
    return { code: 0, out: args[0] !== "volume" && args[1] === "ls" ? "[]" : "" };
  },
};

function hub(over: Partial<TaskHubDeps> = {}): TaskHub {
  const h = new TaskHub({
    tmux: tmuxBase(),
    repos: () => [app],
    own: async () => true,
    viewers: () => [],
    hold: () => {},
    broadcast: () => {},
    gaveUp: () => {},
    ports,
    compose: docker,
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

const treeTask = async (h: TaskHub, name: string): Promise<TaskInfo | undefined> => (await h.tasksOf(app, false)).trees?.find((t) => t.name === name);
const roots = () => ({ runs: join(config, "worktrees"), kept: join(config, "trees") });
const downs = () => calls.filter((c) => c.includes("down"));
const name = () => projectName(tree.dir, roots()) as string;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-tasks-stack-")));
  const path = join(scratch, "app");
  await mkdir(join(path, ".canopy"), { recursive: true });
  await writeFile(
    join(path, ".canopy/tasks.json"),
    JSON.stringify([
      { name: "stack", compose: true, dev: true, cmd: `printf '%s %s\\n' "$COMPOSE_PROJECT_NAME" "$PORT" > seen.txt` },
      { name: "fg", compose: true, cmd: "exec sleep 30" },
      { name: "bad", compose: true, cmd: "exit 1" },
      { name: "two", compose: true, cmd: `printf '%s %s\\n' "$PORT" "$DB" > seen.txt`, env: { PORT: "${PORT}", DB: "${PORT_2}" } },
      { name: "named", compose: true, cmd: "echo docker compose -p mine up" },
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
  config = join(scratch, `c${++n}`);
  process.env["CANOPY_CONFIG_DIR"] = config;
  const dir = join(config, "worktrees", "app-1a2b3c4d", `t${n}`);
  await mkdir(dir, { recursive: true });
  tree = { id: `t${n}`, dir, branch: `run/t${n}` };
  held = new Map();
  next = 7900;
  said = [];
  calls = [];
  ownStack = false;
  missing = null;
  hubs = [];
});
afterEach(async () => {
  for (const h of hubs) {
    h.stop();
    await h.settled();
  }
  if (tmux) await killServer(tmuxBase()!).catch(() => {});
});

test.skipIf(!tmux)("a stack runs as the folder's project on a port of its own, and an up -d that ended reads as running", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "stack");
  await until(() => existsSync(join(tree.dir, "seen.txt")), "the task's output");
  expect((await readFile(join(tree.dir, "seen.txt"), "utf8")).trim()).toBe(`cw-app-1a2b3c4d-t${n} 7900`);
  const id = taskTermId(tree.dir, "stack");
  await until(async () => (await treeTask(h, "stack"))?.exitCode === 0, "the up to end");
  await Bun.sleep(150);
  expect(held.get(id)).toEqual([7900]);
  expect(await treeTask(h, "stack")).toMatchObject({ status: "running", port: 7900 });
  expect(h.taskIn(tree.dir)).toEqual({ name: "stack", status: "running", port: 7900 });
  expect(h.treeHolds().map((t) => t.ports)).toEqual([[7900]]);
  expect(calls).toEqual([]);
});

test.skipIf(!tmux)("a stack's env decides its ports", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "two");
  await until(() => existsSync(join(tree.dir, "seen.txt")), "the task's output");
  expect((await readFile(join(tree.dir, "seen.txt"), "utf8")).trim()).toBe("7900 7901");
});

test.skipIf(!tmux)("a stop by hand runs down without -v and lets the port go", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "stack");
  await until(async () => (await treeTask(h, "stack"))?.exitCode === 0, "the up to end");
  await h.actIn(app, tree, "stop", "stack");
  expect(downs()).toEqual([["compose", "-p", name(), "down"]]);
  expect(calls.some((c) => c[0] === "volume")).toBe(false);
  expect(held.size).toBe(0);
  expect((await treeTask(h, "stack"))?.status).not.toBe("running");
});

test.skipIf(!tmux)("a worktree that goes takes its stack's volumes, and the lines say so", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "stack");
  await until(async () => (await treeTask(h, "stack"))?.exitCode === 0, "the up to end");
  const lines = await h.endTree(tree.dir);
  expect(downs()).toEqual([["compose", "-p", name(), "down", "-v"]]);
  expect(lines).toEqual(["stopped stack", `removed compose stack ${name()} and its volumes`]);
  expect(held.size).toBe(0);
  expect((await h.tasksOf(app, false)).trees ?? []).toEqual([]);
});

test.skipIf(!tmux)("a failed up holds no port, and the worktree's end still takes what it left", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "bad");
  await until(() => held.size === 0, "the port to go");
  await h.endTree(tree.dir);
  expect(downs()).toEqual([["compose", "-p", name(), "down", "-v"]]);
});

test.skipIf(!tmux)("a stack whose folder went another way is taken down by name at the next start", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "stack");
  await until(async () => (await treeTask(h, "stack"))?.exitCode === 0, "the up to end");
  h.stop();
  await h.settled();
  await rm(tree.dir, { recursive: true, force: true });
  const again = hub();
  await again.start();
  await until(() => downs().length > 0, "the down");
  expect(downs()).toEqual([["compose", "-p", name(), "down", "-v"]]);
  expect(said.join(" ")).toContain(`${tree.dir} is gone`);
});

test.skipIf(!tmux)("a kept tree's card runs under its own prefix, and a run's id cannot share it", async () => {
  const dir = join(config, "trees", "app-1a2b3c4d", tree.id);
  await mkdir(join(dir, ".canopy"), { recursive: true });
  await writeFile(join(dir, ".canopy/tasks.json"), JSON.stringify([{ name: "stack", compose: true, cmd: `printf '%s %s\\n' "$COMPOSE_PROJECT_NAME" "$PORT" > seen.txt` }]));
  const card = { id: "card", name: "card", path: dir } as Repo;
  const h = hub({ repos: () => [app, card], keptPort: (d) => (d === dir ? 7949 : null) });
  await h.start();
  await h.act(card, "start", "stack");
  await until(() => existsSync(join(dir, "seen.txt")), "the task's output");
  expect((await readFile(join(dir, "seen.txt"), "utf8")).trim()).toBe(`ck-app-1a2b3c4d-${tree.id} 7949`);
  expect(`ck-app-1a2b3c4d-${tree.id}`).not.toBe(name());
  await h.endTree(dir);
  expect(downs()).toEqual([["compose", "-p", `ck-app-1a2b3c4d-${tree.id}`, "down", "-v"]]);
});

test.skipIf(!tmux)("a compose task in a main checkout stays the repo's own: no project, no port, and no down", async () => {
  const h = hub();
  await h.start();
  await h.act(app, "start", "stack");
  await until(() => existsSync(join(app.path, "seen.txt")), "the task's output");
  const seen = (await readFile(join(app.path, "seen.txt"), "utf8")).trim();
  await rm(join(app.path, "seen.txt"));
  expect(seen).toBe("");
  await h.endTree(app.path);
  expect(calls).toEqual([]);
});

test.skipIf(!tmux)("canopy's own stack is refused at the start, in a worktree and in the main checkout", async () => {
  ownStack = true;
  const h = hub();
  await h.start();
  await expect(h.actIn(app, tree, "start", "stack")).rejects.toThrow(OWN_STACK);
  await expect(h.act(app, "start", "stack")).rejects.toThrow(OWN_STACK);
  expect(existsSync(join(tree.dir, "seen.txt"))).toBe(false);
  expect(calls).toEqual([]);
});

test.skipIf(!tmux)("canopy's own stack is refused at the end too, whatever a record says", async () => {
  const h = hub();
  await h.start();
  await h.actIn(app, tree, "start", "stack");
  await until(async () => (await treeTask(h, "stack"))?.exitCode === 0, "the up to end");
  ownStack = true;
  const lines = await h.endTree(tree.dir);
  expect(downs()).toEqual([]);
  expect(lines.join(" ")).toContain(OWN_STACK);
});

test.skipIf(!tmux)("no docker, or no compose on this backend, refuses the task with the reason", async () => {
  missing = "docker is not installed on this backend";
  const h = hub();
  await h.start();
  await expect(h.actIn(app, tree, "start", "stack")).rejects.toThrow("docker is not installed on this backend");
  missing = null;
  const bare = hub({ compose: undefined });
  await bare.start();
  await expect(bare.actIn(app, tree, "start", "stack")).rejects.toThrow("this backend runs none");
  expect(held.size).toBe(0);
});

test.skipIf(!tmux)("a cmd that names its own project is refused in a worktree", async () => {
  const h = hub();
  await h.start();
  await expect(h.actIn(app, tree, "start", "named")).rejects.toThrow("names its own compose project");
  expect(calls).toEqual([]);
});

test.skipIf(!tmux)("a down that fails is told at a stop, and the port still goes", async () => {
  const failing = { ...docker, run: async (args: string[]) => (args.includes("down") ? { code: 1, out: "Resource is still in use" } : docker.run(args, { cwd: "/", timeoutMs: 0 })) };
  const h = hub({ compose: failing });
  await h.start();
  await h.actIn(app, tree, "start", "stack");
  await until(async () => (await treeTask(h, "stack"))?.exitCode === 0, "the up to end");
  await expect(h.actIn(app, tree, "stop", "stack")).rejects.toThrow("Resource is still in use");
  expect(held.size).toBe(0);
});
