/**
 * Tasks through the HTTP API against a real server on a scratch root and a
 * tmux server of its own under the scratch config dir. Timings are shrunk
 * through startServer's `tasks` option.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "../core/tmux";
import type { TaskInfo, TasksResult, TermInfo } from "../core/types";
import { startServer } from "./index";

const tmux = Bun.which("tmux") !== null;
let scratch = "";
let previous: string | undefined;
let server: { port: number; stop: () => void };
let repo = "";

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const get = async <T>(p: string): Promise<T> => (await fetch(url(p))).json() as Promise<T>;
const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
const tasks = () => get<TasksResult>("/api/repos/tasks?id=app");
const task = async (name: string): Promise<TaskInfo> => (await tasks()).tasks.find((t) => t.name === name)!;

async function until(pred: () => Promise<boolean>, what: string, ms = 15_000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-tasks-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  repo = join(root, "app");
  await mkdir(join(repo, ".canopy"), { recursive: true });
  await Bun.$`git -C ${repo} init -q`.quiet();
  await writeFile(
    join(repo, ".canopy/tasks.json"),
    JSON.stringify([
      { name: "hello", cmd: "echo hello-task; sleep 30" },
      { name: "quick", cmd: "echo quick-out; exit 3" },
      { name: "stubborn", cmd: "trap '' INT; echo stubborn; sleep 30" },
      { name: "auto", cmd: "echo auto; sleep 30", keep: true },
    ]),
  );
  server = await startServer({ root, port: 0, chan: null, tasks: { tick: 100, grace: 500 } });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe.skipIf(!tmux)("tasks", () => {
  test("the repo file's tasks list idle, and someone else's auto flags are only suggested", async () => {
    const r = await tasks();
    expect(r.errors).toEqual([]);
    expect(r.tasks.map((t) => [t.name, t.status, t.source])).toEqual([
      ["hello", "idle", "repo"],
      ["quick", "idle", "repo"],
      ["stubborn", "idle", "repo"],
      ["auto", "idle", "repo"],
    ]);
    const auto = r.tasks.find((t) => t.name === "auto")!;
    expect(auto.keep).toBeUndefined();
    expect(auto.suggested).toEqual({ keep: true });
    expect(auto.termId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("start, a second start, and the shell lists leave it out", async () => {
    // Review focus 2: two starts at once, one wins
    const [a, b] = await Promise.all([
      post("/api/repos/tasks?id=app", { action: "start", name: "hello" }),
      post("/api/repos/tasks?id=app", { action: "start", name: "hello" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const t = await task("hello");
    expect(t.status).toBe("running");
    expect(t.live).toBe(true);
    const shells = await get<TermInfo[]>("/api/terms");
    expect(shells.some((s) => s.id === t.termId)).toBe(false);
    const del = await fetch(url(`/api/terms?term=${t.termId}`), { method: "DELETE" });
    expect(del.status).toBe(400);
    const log = await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=hello");
    await until(async () => (await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=hello")).lines.some((l) => l.text === "hello-task"), "the output in the log");
    expect(log.lines[0]?.text.startsWith("--- started ")).toBe(true);
  });

  test("the terminal socket joins a task with attach=1", async () => {
    const t = await task("hello");
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?id=app&term=${t.termId}&attach=1&cols=80&rows=24`);
    ws.binaryType = "arraybuffer";
    let text = "";
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== "string") text += new TextDecoder().decode(new Uint8Array(e.data));
    };
    await until(async () => text.includes("hello-task"), "the task's screen over the socket");
    ws.close();
  });

  test("a socket without attach=1 is refused on a task's id", async () => {
    const t = await task("hello");
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?id=app&term=${t.termId}&cols=80&rows=24`);
    const code = await new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
    });
    expect(code).toBe(4404);
    expect((await get<TermInfo[]>("/api/terms")).some((s) => s.id === t.termId)).toBe(false);
    expect((await task("hello")).status).toBe("running");
  });

  test("a command that exits at once keeps its output and code", async () => {
    // Review focus 3
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "quick" })).status).toBe(200);
    await until(async () => (await task("quick")).status === "failed", "quick to fail");
    const t = await task("quick");
    expect(t.exitCode).toBe(3);
    const log = await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=quick");
    expect(log.lines.some((l) => l.text === "quick-out")).toBe(true);
  });

  test("restart keeps the session; stop ends it, killing what ignores ^C", async () => {
    const before = await task("hello");
    expect((await post("/api/repos/tasks?id=app", { action: "restart", name: "hello" })).status).toBe(200);
    const after = await task("hello");
    expect(after.termId).toBe(before.termId);
    expect(after.status).toBe("running");
    await post("/api/repos/tasks?id=app", { action: "start", name: "stubborn" });
    // wait for the trap to be set: a ^C that lands while the login shell is still starting ends it politely
    await until(async () => (await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=stubborn")).lines.some((l) => l.text === "stubborn"), "stubborn's output");
    expect((await post("/api/repos/tasks?id=app", { action: "stop", name: "stubborn" })).status).toBe(200);
    const s = await task("stubborn");
    expect(s.status).toBe("stopped");
    expect(s.live).toBe(false);
    expect((await post("/api/repos/tasks?id=app", { action: "stop", name: "stubborn" })).status).toBe(200);
  });

  test("the shell route refuses a task's id with no session left", async () => {
    const s = await task("stubborn");
    // a list reconciles the held sessions, so nothing is held under that id any more
    await get<TermInfo[]>("/api/terms");
    expect((await fetch(url(`/api/terms?term=${s.termId}`), { method: "DELETE" })).status).toBe(400);
  });

  test("bad requests", async () => {
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "nope" })).status).toBe(404);
    expect((await post("/api/repos/tasks?id=app", { action: "jump", name: "hello" })).status).toBe(400);
    expect((await post("/api/repos/tasks?id=app", { action: "start" })).status).toBe(400);
    expect((await fetch(url("/api/repos/tasks?id=missing"))).status).toBe(404);
  });

  test("every non-idle task across repos", async () => {
    const all = await get<TaskInfo[]>("/api/tasks");
    expect(all.map((t) => t.name).sort()).toEqual(["hello", "quick", "stubborn"]);
  });

  test("the record is on disk", async () => {
    const st = JSON.parse(await readFile(join(scratch, "config/tasks/state.json"), "utf8")) as Record<string, { name: string; want: string }>;
    expect(Object.values(st).find((r) => r.name === "stubborn")?.want).toBe("stopped");
    expect(Object.values(st).find((r) => r.name === "hello")?.want).toBe("running");
  });
});

describe("without tmux", () => {
  test("the routes say tasks need tmux", async () => {
    const was = process.env["CANOPY_TMUX"];
    process.env["CANOPY_TMUX"] = "0";
    const root = join(scratch, "root2");
    await mkdir(join(root, "b"), { recursive: true });
    await Bun.$`git -C ${join(root, "b")} init -q`.quiet();
    const s = await startServer({ root, port: 0, chan: null });
    try {
      expect((await fetch(`http://127.0.0.1:${s.port}/api/repos/tasks?id=b`)).status).toBe(503);
    } finally {
      s.stop();
      if (was === undefined) delete process.env["CANOPY_TMUX"];
      else process.env["CANOPY_TMUX"] = was;
    }
  });
});
