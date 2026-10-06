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
import type { TaskInfo, TasksResult } from "../core/types";
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
  scratch = await mkdtemp(join(tmpdir(), "canopy-tasks-sweep-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  repo = join(root, "app");
  await mkdir(join(repo, ".canopy"), { recursive: true });
  await Bun.$`git -C ${repo} init -q`.quiet();
  await writeFile(
    join(repo, ".canopy/tasks.json"),
    JSON.stringify([
      { name: "flood", cmd: "i=0; while [ $i -lt 80 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); sleep 0.05; done; echo flood-done; sleep 30" },
      { name: "brief", cmd: "echo brief; exit 2" },
      { name: "orphan", cmd: "echo orphan; sleep 30" },
    ]),
  );
  server = await startServer({ root, port: 0, chan: null, tasks: { tick: 100, grace: 300, logCap: 4096, reap: 300, sweep: 200, logAge: 0 } });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe.skipIf(!tmux)("rotation and the sweep", () => {
  test("a flood crosses the cap and keeps logging after the rotation", async () => {
    await post("/api/repos/tasks?id=app", { action: "start", name: "flood" });
    const t = await task("flood");
    const dir = join(scratch, "config/tasks/logs");
    const old = () => Bun.file(join(dir, `${t.termId}.log.1`));
    const cur = () => Bun.file(join(dir, `${t.termId}.log`));
    await until(async () => old().exists(), "a rotation");
    // the flood runs for seconds, so lines keep coming after a rotation: they
    // must land in a new current file, which only a re-attached pipe writes
    await until(async () => (await cur().exists()) && cur().size > 0, "output after the rotation");
    await until(async () => (await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=flood&q=flood-done")).lines.length === 1, "the end of the flood");
  }, 30_000);

  test("a dead pane nobody watches is reaped, and its exit line stays", async () => {
    await post("/api/repos/tasks?id=app", { action: "start", name: "brief" });
    await until(async () => (await task("brief")).status === "failed", "brief to fail");
    await until(async () => !(await task("brief")).live, "brief's pane to be reaped");
    const t = await task("brief");
    expect(t.status).toBe("failed");
    expect(t.exitCode).toBe(2);
  });

  test("an orphan keeps running through a sweep; a gone task's log and record go once it stops", async () => {
    await post("/api/repos/tasks?id=app", { action: "start", name: "orphan" });
    const id = (await task("orphan")).termId;
    await writeFile(join(repo, ".canopy/tasks.json"), JSON.stringify([{ name: "brief", cmd: "echo brief; exit 2" }, { name: "flood", cmd: "true" }]));
    await Bun.sleep(600); // a few sweeps
    const all = await get<{ name: string; gone?: string; status: string }[]>("/api/tasks");
    expect(all.find((t) => t.name === "orphan")).toMatchObject({ gone: "definition", status: "running" });
    expect((await post("/api/repos/tasks?id=app", { action: "stop", name: "orphan" })).status).toBe(200);
    await until(async () => !(await Bun.file(join(scratch, `config/tasks/logs/${id}.log`)).exists()), "the orphan's log to go");
    // the sweep removes the log first and drops the record after, so the saved file lags the log
    const saved = async () => JSON.parse(await readFile(join(scratch, "config/tasks/state.json"), "utf8")) as Record<string, unknown>;
    await until(async () => (await saved())[id] === undefined, "the orphan's record to go");
  });
});
