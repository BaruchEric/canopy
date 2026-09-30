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
const timings = { tick: 100, grace: 300, backoff: 100, backoffCap: 200, giveUp: 3, uptime: 5000 };
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
      { name: "flaky", cmd: "echo flaky; exit 1" },
      { name: "steady", cmd: "echo steady; sleep 30" },
      { name: "clean", cmd: "echo clean; exit 0" },
      { name: "panel", cmd: "echo panel; sleep 30" },
    ]),
  );
  server = await startServer({ root, port: 0, chan: null, tasks: timings });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

const def = (name: string, patch: object) => post("/api/repos/tasks/def?id=app", { name, def: { name, ...patch }, target: "canopy" });
const again = () => startServer({ root: join(scratch, "root"), port: 0, chan: null, tasks: timings });

describe.skipIf(!tmux)("keep running", () => {
  test("canopy's layer turns keep on; a failing task backs off, then gives up", async () => {
    expect((await def("flaky", { keep: true })).status).toBe(200);
    expect((await task("flaky")).keep).toBe(true);
    await post("/api/repos/tasks?id=app", { action: "start", name: "flaky" });
    await until(async () => (await task("flaky")).status === "gave-up", "flaky to give up");
    const t = await task("flaky");
    expect(t.restarts).toBe(2);
    const log = await get<{ lines: { text: string; mark?: true }[] }>("/api/repos/tasks/log?id=app&name=flaky");
    expect(log.lines.filter((l) => l.mark).length).toBe(3);
  });

  test("a clean exit is not restarted", async () => {
    await def("clean", { keep: true });
    await post("/api/repos/tasks?id=app", { action: "start", name: "clean" });
    await until(async () => (await task("clean")).status === "exited", "clean to finish");
    await Bun.sleep(400);
    expect((await task("clean")).restarts).toBe(0);
  });

  test("a manual start clears gave-up", async () => {
    await def("flaky", { cmd: "echo fixed; sleep 30" });
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "flaky" })).status).toBe(200);
    expect((await task("flaky")).status).toBe("running");
  });

  test("start with panel starts only flagged tasks that are not running", async () => {
    await def("panel", { withPanel: true });
    expect((await post("/api/repos/tasks?id=app", { action: "start", reason: "panel" })).status).toBe(200);
    expect((await task("panel")).status).toBe("running");
    expect((await task("steady")).status).toBe("idle");
  });

  test("clearing an override and a repo-file edit", async () => {
    expect((await post("/api/repos/tasks/def?id=app", { name: "panel", def: null, target: "canopy" })).status).toBe(200);
    expect((await task("panel")).withPanel).toBeUndefined();
    expect((await post("/api/repos/tasks/def?id=app", { name: "extra", def: { name: "extra", cmd: "echo extra", cwd: "." }, target: "repo" })).status).toBe(200);
    const file = JSON.parse(await readFile(join(repo, ".canopy/tasks.json"), "utf8")) as { name: string; cwd?: string }[];
    expect(file.map((t) => t.name)).toContain("extra");
    // the sheet sends "." for a blank folder; the checked-in file need not say it
    expect(file.find((t) => t.name === "extra")?.cwd).toBeUndefined();
    expect((await post("/api/repos/tasks/def?id=app", { name: "x", def: { name: "x", cmd: "a", cwd: "../out" }, target: "canopy" })).status).toBe(400);
    expect((await post("/api/repos/tasks/def?id=app", { name: "x", def: ["a"], target: "canopy" })).status).toBe(400);
    expect((await post("/api/repos/tasks/def?id=app", { name: "x", def: "a", target: "canopy" })).status).toBe(400);
  });

  test("after a restart, a keep task that was meant to run comes back", async () => {
    await def("steady", { keep: true });
    await post("/api/repos/tasks?id=app", { action: "start", name: "steady" });
    server.stop();
    await killServer(tmuxBase()!);
    server = await again();
    await until(async () => (await task("steady")).status === "running", "steady to come back");
  });

  test("a keep task found dead after a restart is started again", async () => {
    await def("clean", { cmd: "echo again; sleep 0.2; exit 4", keep: true });
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "clean" })).status).toBe(200);
    server.stop();
    await Bun.sleep(600);
    server = await again();
    await until(async () => (await task("clean")).restarts >= 1, "clean to be restarted");
  });

  test("canopy's layer keeps only what differs from the repo file", async () => {
    const stored = async () => {
      const cfg = JSON.parse(await readFile(join(scratch, "config/config.json"), "utf8")) as { tasks?: Record<string, { name: string; cmd?: string; cwd?: string }[]> };
      // keyed by the repo's real path, which a temp dir's symlink makes differ from `repo`
      return Object.values(cfg.tasks ?? {}).flat().filter((t) => t.name === "extra");
    };
    // what the sheet sends: the whole task, flags off and all
    const sheet = (cmd: string) => post("/api/repos/tasks/def?id=app", { name: "extra", def: { name: "extra", cmd, dev: false, keep: false, withPanel: false }, target: "canopy" });
    expect((await sheet("echo extra")).status).toBe(200);
    expect(await stored()).toEqual([]);
    expect((await sheet("echo other")).status).toBe(200);
    expect(await stored()).toEqual([{ name: "extra", cmd: "echo other" }]);
    // the repo file's later word on another field still shows through
    const file = join(repo, ".canopy/tasks.json");
    const list = JSON.parse(await readFile(file, "utf8")) as { name: string; dev?: boolean }[];
    await writeFile(file, JSON.stringify(list.map((t) => (t.name === "extra" ? { ...t, dev: true } : t))));
    const t = await task("extra");
    expect(t.cmd).toBe("echo other");
    expect(t.dev).toBe(true);
    // An explicit empty root folder clears the repo file's subfolder in the canopy layer.
    const withSubfolder = JSON.parse(await readFile(file, "utf8")) as { name: string; cwd?: string }[];
    await writeFile(file, JSON.stringify(withSubfolder.map((x) => (x.name === "extra" ? { ...x, cwd: "ui" } : x))));
    expect((await task("extra")).cwd).toBe("ui");
    expect((await def("extra", { cwd: "" })).status).toBe(200);
    expect((await task("extra")).cwd).toBe(".");
    expect(await stored()).toEqual([{ name: "extra", cwd: "." }]);
  });

  test("a keep task that exited 0 stays down after tmux and canopy restart", async () => {
    await def("clean", { cmd: "echo done; exit 0", keep: true });
    await post("/api/repos/tasks?id=app", { action: "stop", name: "clean" });
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "clean" })).status).toBe(200);
    await until(async () => (await task("clean")).status === "exited", "clean to finish");
    server.stop();
    await killServer(tmuxBase()!);
    server = await again();
    await Bun.sleep(600);
    const t = await task("clean");
    expect(t.status).toBe("exited");
    expect(t.live).toBe(false);
  });
});
