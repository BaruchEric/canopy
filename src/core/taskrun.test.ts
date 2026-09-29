/**
 * The disk and tmux side of tasks against a scratch config dir and a tmux
 * server of its own on a socket under it. The real server's sessions are
 * never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "./tmux";
import {
  appendMark,
  interruptTask,
  listLogs,
  listTaskPanes,
  logPath,
  readLog,
  readTaskFiles,
  readTaskState,
  rotateIfBig,
  startTaskSession,
  taskTermId,
  writeTaskState,
} from "./taskrun";

let scratch = "";
const prev = process.env["CANOPY_CONFIG_DIR"];
const tmux = Bun.which("tmux") !== null;

/** the panes, or none when there is no server or no answer */
const panes = async (base: string[]) => {
  const r = await listTaskPanes(base);
  return Array.isArray(r) ? r : [];
};

async function until(pred: () => Promise<boolean>, what: string, ms = 10_000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-taskrun-"));
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
});

afterAll(async () => {
  const base = tmuxBase();
  if (base) await killServer(base);
  if (prev === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = prev;
  await rm(scratch, { recursive: true, force: true });
});

describe("files and state", () => {
  test("ids are stable, 32 hex, and differ by path and name", () => {
    const a = taskTermId("/r/app", "dev");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(taskTermId("/r/app", "dev")).toBe(a);
    expect(taskTermId("/r/app", "test")).not.toBe(a);
    expect(taskTermId("/r/other", "dev")).not.toBe(a);
  });
  test("a local repo's task files", async () => {
    const repo = join(scratch, "repo");
    await mkdir(join(repo, ".canopy"), { recursive: true });
    await writeFile(join(repo, "package.json"), '{"scripts":{"dev":"vite"}}');
    await writeFile(join(repo, ".canopy/tasks.json"), "[]");
    expect(await readTaskFiles(repo)).toEqual({ pkg: '{"scripts":{"dev":"vite"}}', repoFile: "[]" });
  });
  test("state round-trips", async () => {
    expect(await readTaskState()).toEqual({});
    const id = taskTermId("/r", "dev");
    await writeTaskState({ [id]: { repoId: "r", path: "/r", name: "dev", want: "running", startedAt: 1 } });
    expect(await readTaskState()).toEqual({ [id]: { repoId: "r", path: "/r", name: "dev", want: "running", startedAt: 1 } });
  });
  test("marks, rotation and reading both files", async () => {
    const id = taskTermId("/r", "log");
    await appendMark(id, 1000, "a");
    await Bun.write(logPath(id), (await readLog(id)) + "x".repeat(50) + "\n");
    expect(await rotateIfBig(id, 10)).toBe(true);
    await appendMark(id, 2000, "b");
    expect(await rotateIfBig(id, 1000)).toBe(false);
    const text = await readLog(id);
    expect(text.startsWith("--- started 1000 · a ---\n")).toBe(true);
    expect(text.endsWith("--- started 2000 · b ---\n")).toBe(true);
    expect((await listLogs()).map((l) => l.termId)).toContain(id);
  });
});

describe.skipIf(!tmux)("a task session", () => {
  test("the first line reaches the log, the exit code is read, and a respawn keeps the pipe", async () => {
    const base = tmuxBase()!;
    const repo = join(scratch, "repo");
    const id = taskTermId(repo, "quick");
    const meta = { id, repoId: "repo", path: repo, task: "quick" };
    // Review focus 1: quotes, && and $ survive both shells
    await startTaskSession(base, meta, repo, `echo 'first line' && echo "home=$HOME" && exit 3`);
    await until(async () => (await panes(base)).some((p) => p.termId === id && p.dead), "the task to exit");
    const pane = (await panes(base)).find((p) => p.termId === id)!;
    expect(pane.code).toBe(3);
    expect(pane.task).toBe("quick");
    const log = await readLog(id);
    expect(log).toContain("first line");
    expect(log).toContain(`home=${process.env["HOME"]}`);
    // again on the same session: the new run's output lands in the log too
    await startTaskSession(base, meta, repo, "echo second run; sleep 30");
    await until(async () => (await readLog(id)).includes("second run"), "the respawned output");
    await interruptTask(base, id);
    await until(async () => (await panes(base)).some((p) => p.termId === id && p.dead), "^C to end it");
  });
  test("a folder that is not there fails the task instead of running it at home", async () => {
    const base = tmuxBase()!;
    const repo = join(scratch, "repo");
    const id = taskTermId(repo, "lost");
    await startTaskSession(base, { id, repoId: "repo", path: repo, task: "lost" }, repo, "pwd; echo ran-anyway", "missing");
    await until(async () => (await panes(base)).some((p) => p.termId === id && p.dead), "the task to exit");
    const pane = (await panes(base)).find((p) => p.termId === id)!;
    expect(pane.code).not.toBe(0);
    const log = await readLog(id);
    expect(log).not.toContain("ran-anyway");
    expect(log.split(/\r?\n/)).not.toContain(process.env["HOME"]);
    expect(log).toContain("missing");
  });
  test("a server with no session left is an empty list, not a failure", async () => {
    // the shells container's server: exit-empty off, so it outlives its last session
    const base = tmuxBase()!;
    const run = async (...args: string[]) => expect(await Bun.spawn([...base, ...args]).exited).toBe(0);
    await killServer(base);
    await run("new-session", "-d", "-s", "canopy-empty", ";", "set-option", "-g", "exit-empty", "off");
    await run("kill-session", "-t", "canopy-empty");
    expect(await listTaskPanes(base)).toEqual([]);
  });
  test("no server is said as such, not a failure", async () => {
    const base = tmuxBase()!;
    await killServer(base);
    expect(await listTaskPanes(base)).toBe("no-server");
  });
});
