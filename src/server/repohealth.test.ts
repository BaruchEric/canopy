import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../core/exec";
import { HEAL_MAX } from "../core/health";
import type { Repo, RepoCheckDef, TaskStatus } from "../core/types";
import { HealthHub } from "./health";
import { RepoHealth, composeRows, healFor, probeFor, type ProbeDeps, type Run } from "./repohealth";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repo = (over: Partial<Repo> = {}): Repo => ({ id: "app", name: "app", path: "/tmp/app", group: "", source: "root", status: null, ...over });

const noTasks: ProbeDeps = { taskStatus: async () => undefined, restartTask: async () => {} };
const ran = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr });

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

describe("probes", () => {
  test("http: a 2xx or 3xx passes with its time, anything else fails, expect narrows it", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => new Response("x", { status: new URL(req.url).pathname === "/bad" ? 500 : 200 }) });
    cleanups.push(() => server.stop(true));
    const base = `http://127.0.0.1:${server.port}`;
    const ok = await probeFor({ name: "a", kind: "http", url: `${base}/` }, repo(), noTasks)();
    expect(ok.state).toBe("ok");
    expect("detail" in ok && ok.detail).toMatch(/^200 in \d+ms$/);
    expect(await probeFor({ name: "a", kind: "http", url: `${base}/bad` }, repo(), noTasks)()).toMatchObject({ state: "down", why: "answered 500" });
    expect(await probeFor({ name: "a", kind: "http", url: `${base}/bad`, expect: 500 }, repo(), noTasks)()).toMatchObject({ state: "ok" });
    expect(await probeFor({ name: "a", kind: "http", url: `${base}/`, expect: 204 }, repo(), noTasks)()).toMatchObject({ state: "down", why: "answered 200, not 204" });
  });

  test("http and port: nothing listening is down", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = server.port;
    server.stop(true);
    expect(await probeFor({ name: "a", kind: "http", url: `http://127.0.0.1:${port}/` }, repo(), noTasks)()).toMatchObject({ state: "down", why: "nothing listening" });
    expect(await probeFor({ name: "a", kind: "port", port: port! }, repo(), noTasks)()).toMatchObject({ state: "down", why: "nothing listening" });
  });

  test("port: a listener passes", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    cleanups.push(() => server.stop(true));
    expect((await probeFor({ name: "a", kind: "port", port: server.port! }, repo(), noTasks)()).state).toBe("ok");
  });

  test("task: its status, as a state", async () => {
    const at = (status: TaskStatus) => probeFor({ name: "a", kind: "task", task: "dev" }, repo(), { ...noTasks, taskStatus: async () => ({ status, exitCode: 1 }) })();
    expect((await at("running")).state).toBe("ok");
    expect((await at("backoff")).state).toBe("healing");
    expect((await at("gave-up")).state).toBe("gave-up");
    expect(await at("exited")).toMatchObject({ state: "down", why: "exited 1" });
    expect(await at("stopped")).toMatchObject({ state: "off", why: "stopped by hand" });
    expect(await at("idle")).toMatchObject({ state: "off", why: "not started" });
    expect(await probeFor({ name: "a", kind: "task", task: "dev" }, repo(), noTasks)()).toMatchObject({ state: "down", why: "no task named dev" });
  });

  test("command: exit 0 passes with its last line, else its last line is why", async () => {
    const run: Run = async (argv) => (argv[2] === "good" ? ran(0, "a\nall fine\n") : ran(2, "", "boom\n"));
    expect(await probeFor({ name: "a", kind: "command", run: "good" }, repo(), { ...noTasks, run })()).toMatchObject({ state: "ok", detail: "all fine" });
    expect(await probeFor({ name: "a", kind: "command", run: "bad" }, repo(), { ...noTasks, run })()).toMatchObject({ state: "down", why: "boom" });
  });

  test("command runs in the repo through a login shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rh-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    expect(await probeFor({ name: "a", kind: "command", run: "basename $(pwd)" }, repo({ path: dir }), noTasks)()).toMatchObject({ state: "ok", detail: dir.split("/").at(-1) });
  });

  test("compose: running and healthy passes; anything else is down", async () => {
    const at = (out: string, code = 0) => probeFor({ name: "a", kind: "compose", service: "db" }, repo(), { ...noTasks, run: async () => ran(code, out) })();
    expect(await at('{"State":"running","Health":"","Status":"Up 3 minutes"}')).toMatchObject({ state: "ok", detail: "Up 3 minutes" });
    expect(await at('[{"State":"running","Health":"unhealthy"}]')).toMatchObject({ state: "down", why: "db running, unhealthy" });
    expect(await at("")).toMatchObject({ state: "down", why: "db is not running" });
    expect(await at("", 1)).toMatchObject({ state: "down" });
  });

  test("composeRows reads lines and arrays, skipping junk", () => {
    expect(composeRows('{"State":"running"}\n{"State":"exited"}\nnope')).toEqual([{ State: "running" }, { State: "exited" }]);
    expect(composeRows('[{"State":"running","Other":1}]')).toEqual([{ State: "running" }]);
  });
});

describe("heals", () => {
  test("a fix runs first; else a task restarts and a compose service restarts", async () => {
    const calls: string[] = [];
    const deps: ProbeDeps = { ...noTasks, restartTask: async (_r, n) => void calls.push(`task ${n}`), run: async (argv) => (calls.push(argv.join(" ")), ran(0)) };
    await healFor({ name: "a", kind: "task", task: "dev", fix: "make up" }, repo(), deps)?.();
    await healFor({ name: "a", kind: "task", task: "dev" }, repo(), deps)?.();
    await healFor({ name: "a", kind: "compose", service: "db", file: "c.yml" }, repo(), deps)?.();
    expect(calls).toEqual(["sh -lc make up", "task dev", "docker compose -f c.yml restart db"]);
    expect(healFor({ name: "a", kind: "port", port: 1 }, repo(), deps)).toBeUndefined();
  });

  test("a fix that fails throws its last line", async () => {
    const heal = healFor({ name: "a", kind: "port", port: 1, fix: "x" }, repo(), { ...noTasks, run: async () => ran(1, "", "no docker\n") });
    expect(heal?.()).rejects.toThrow("no docker");
  });
});

describe("RepoHealth", () => {
  function setup(files: Record<string, string>, canopy: Record<string, RepoCheckDef[]> = {}, repos: Repo[] = [repo()], own = true) {
    const hub = new HealthHub({ broadcast: () => {}, timings: { base: 5, cap: 20, resetAfter: 300_000, healMax: HEAL_MAX }, debounce: 5 });
    const cfg = { health: canopy };
    const rh = new RepoHealth({
      ...noTasks,
      hub,
      repos: () => repos,
      own: async () => own,
      seed: () => false,
      config: async () => cfg,
      readFile: async (r) => files[r.path] ?? null,
    });
    cleanups.push(() => {
      rh.stop();
      hub.stop();
    });
    return { hub, rh, cfg };
  }

  test("a repo's file becomes checks under repo:<id>:<name>, with its errors", async () => {
    const { hub, rh } = setup({ "/tmp/app": JSON.stringify({ checks: [{ name: "api", kind: "port", port: 1 }, { name: "x", kind: "nope" }] }) });
    await rh.sync();
    expect(hub.ids("repo:")).toEqual(["repo:app:api"]);
    expect(hub.get("repo:app:api")?.scope).toEqual({ kind: "repo", repoId: "app" });
    expect(rh.of("app").errors).toHaveLength(1);
  });

  test("a sync that changes nothing keeps the check's history; a removed check leaves", async () => {
    const files: Record<string, string> = { "/tmp/app": JSON.stringify({ checks: [{ name: "api", kind: "port", port: 1 }] }) };
    const { hub, rh } = setup(files);
    await rh.sync();
    await sleep(50);
    const before = hub.get("repo:app:api");
    expect(before?.state).toBe("down");
    await rh.sync();
    expect(hub.get("repo:app:api")?.since).toBe(before!.since);
    files["/tmp/app"] = JSON.stringify({ checks: [] });
    await rh.sync();
    expect(hub.ids("repo:")).toEqual([]);
    expect(rh.of("app").checks).toEqual([]);
  });

  test("a check canopy will not run is off, saying why", async () => {
    const { hub, rh } = setup({ "/tmp/app": JSON.stringify({ checks: [{ name: "smoke", kind: "command", run: "true" }] }) }, {}, [repo()], false);
    await rh.sync();
    expect(hub.get("repo:app:smoke")).toMatchObject({ state: "off", why: "not run: not your repo", heal: "none", button: false });
  });

  test("canopy's layer adds checks to a repo with no file", async () => {
    const { hub, rh } = setup({}, { "/tmp/app": [{ name: "site", kind: "port", port: 1 }] });
    await rh.sync();
    expect(hub.ids("repo:")).toEqual(["repo:app:site"]);
    expect(rh.of("app").checks[0]?.source).toBe("canopy");
  });

  test("an auto task check restarts its task until it runs", async () => {
    let status: TaskStatus = "exited";
    const restarts: string[] = [];
    const hub = new HealthHub({ broadcast: () => {}, timings: { base: 5, cap: 20, resetAfter: 300_000, healMax: HEAL_MAX }, debounce: 5 });
    const rh = new RepoHealth({
      hub,
      repos: () => [repo()],
      own: async () => true,
      seed: () => false,
      config: async () => ({ health: { "/tmp/app": [{ name: "dev", kind: "task", task: "dev", heal: "auto", every: 5 }] } }),
      readFile: async () => null,
      taskStatus: async () => ({ status }),
      restartTask: async (_r, n) => {
        restarts.push(n);
        status = "running";
      },
    });
    cleanups.push(() => {
      rh.stop();
      hub.stop();
    });
    await rh.sync();
    for (let i = 0; i < 50 && hub.get("repo:app:dev")?.state !== "ok"; i++) await sleep(20);
    expect(restarts).toEqual(["dev"]);
    expect(hub.get("repo:app:dev")?.state).toBe("ok");
  });
});
