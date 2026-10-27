/** Warm starts through real HTTP and Git. Only the paid driver is inert. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import * as store from "../core/store";
import { startServer } from "./index";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const git = async (cwd: string, ...args: string[]) => {
  const result = await exec(["git", ...args], { cwd });
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
};
async function until<T>(read: () => Promise<T | undefined> | T | undefined, why: string): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`waiting for ${why}`);
    await Bun.sleep(10);
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
};
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error("expected array"); return value; };
const string = (value: unknown): string => { if (typeof value !== "string") throw new Error("expected string"); return value; };
const runBody = (value: unknown) => {
  const run = object(value);
  const branch = run["branch"] ? object(run["branch"]) : null;
  return {
    id: string(run["id"]),
    steps: array(run["steps"]).map((step) => { const s = object(step); return { kind: s["kind"], text: typeof s["text"] === "string" ? s["text"] : undefined }; }),
    branch: branch ? { dir: string(branch["dir"]), work: branch["work"] } : null,
  };
};
const barrier = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
async function world(workflow = "two") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-warm-wiring-")));
  const config = join(dir, "config");
  const repo = join(dir, "root", "app");
  const env = ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_CALLERS"];
  const previous = env.map((key) => process.env[key]);
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_TMUX"] = "0";
  process.env["CANOPY_CALLERS"] = "off";
  await mkdir(join(repo, ".canopy", "workflows"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "test");
  await git(repo, "config", "user.email", "test@example.test");
  await writeFile(join(repo, "base.txt"), "base\n");
  await writeFile(join(repo, ".canopy", "gates.json"), JSON.stringify({ warm: 1, setup: "printf 'setup\\n' >> setup-count", gates: [] }));
  await writeFile(join(repo, ".gitignore"), "setup-count\n");
  await writeFile(join(repo, ".canopy", "workflows", "two.md"), "---\nblurb: Two steps\n---\n\n## First\nmode: manual\n\nRead the files.\n\n## Second\n\nRead again.\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  await mkdir(join(config, "workflows"), { recursive: true });
  await writeFile(join(config, "workflows", "two.md"), "---\nblurb: Two steps\n---\n\n## First\n\nRead the files.\n\n## Second\n\nRead again.\n");
  await writeFile(join(config, "workflows", "one.md"), "---\nblurb: One step\n---\n\n## First\n\nRead the files.\n");
  await writeFile(join(config, "triggers.json"), JSON.stringify({ rules: [{ name: "app", repo: "app", workflow, land: "queue", secretEnv: "CANOPY_TRIGGER_FIXTURE_SECRET" }] }));
  const starts: DriveCtx[] = [];
  class Driver implements RunDriver {
    harness = "claude" as const;
    label = "fixture";
    ctx?: DriveCtx;
    check() { return null; }
    start(ctx: DriveCtx) { this.ctx = ctx; starts.push(ctx); }
    say() {}
    stop() { this.ctx?.exited({ code: 0, stderr: "" }); }
  }
  const server = await startServer({ root: join(dir, "root"), port: 0, chan: null, harnesses: ["claude"], runner: { driver: () => new Driver() } });
  const others: typeof server[] = [];
  cleanups.push(async () => {
    for (const other of others) await other.stop();
    await server.stop();
    env.forEach((key, i) => { const old = previous[i]; if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    await rm(dir, { recursive: true, force: true });
  });
  const url = (path: string, port = server.port) => `http://127.0.0.1:${port}/api/${path}`;
  const post = (path: string, body: unknown, port?: number) => fetch(url(path, port), { method: "POST", body: JSON.stringify(body) });
  const info = async () => {
    const body = object(await (await fetch(url("worktrees"))).json());
    return { repos: array(body["repos"]).map((item) => { const r = object(item); return { want: r["want"], fileWarm: r["fileWarm"], warm: array(r["warm"]).map((item) => ({ dir: string(object(item)["dir"]) })) }; }) };
  };
  const runs = async () => array(await (await fetch(url("runs"))).json()).map(runBody);
  const branch = (times = 1, port?: number) => post("repos/run?id=app", { action: "ask", note: "task", branch: true, times }, port);
  return { dir, config, repo, server, others, starts, post, info, runs, branch, url };
}

test("repo defaults do not refill until machine opt-in; a taken tree skips setup and starts with its warm note", async () => {
  const w = await world();
  expect((await w.info()).repos[0]).toMatchObject({ want: 0, fileWarm: 1, warm: [] });
  expect((await w.branch()).status).toBe(201);
  await until(() => w.starts[0], "cold start");
  expect((await w.runs())[0]?.steps.filter((s) => s.kind === "note").some((s) => s.text?.includes("warm worktree"))).toBe(false);
  expect((await w.post("worktrees/warm", { repo: "app" })).status).toBe(200);
  const warm = await until(async () => (await w.info()).repos[0]?.warm[0], "refill");
  expect(await readFile(join(warm.dir, "setup-count"), "utf8")).toBe("setup\n");
  const response = await w.branch();
  expect(response.status).toBe(201);
  const run = runBody(await response.json());
  await until(() => w.starts[1], "warm start");
  const seen = (await w.runs()).find((r) => r.id === run.id);
  expect(seen?.steps.find((s) => s.kind === "note")?.text).toBe("started in a warm worktree");
  expect(await readFile(join(run.branch?.dir ?? "missing", "setup-count"), "utf8")).toBe("setup\n");
  expect(run.branch?.dir).not.toBe(warm.dir);
  expect(run.branch?.work).toBeTruthy();
});

test("a non-owning backend still starts a cold manual branch and refuses warm mutations", async () => {
  const w = await world();
  const second = await startServer({ root: join(w.dir, "root"), port: 0, chan: null, harnesses: ["claude"], runner: { driver: () => ({ harness: "claude", label: "inert", check: () => null, start() {}, say() {}, stop() {} }) } });
  w.others.push(second);
  expect((await w.post("worktrees/warm", { repo: "app", n: 1 }, second.port)).status).toBe(409);
  expect((await w.branch(1, second.port)).status).toBe(201);
});

for (const workflow of ["two", "one"]) test(`trigger ${workflow} rechecks capacity after a concurrent group reserves the remaining slots`, async () => {
  const w = await world(workflow);
  const entered = barrier();
  const release = barrier();
  const realLoad = store.loadConfig;
  const reader = spyOn(store, "loadConfig").mockImplementation(async (...args) => {
    // This scheduling barrier selects the trigger caller by its stack name.
    // The real config read completes before it pauses, and no Git operation is replaced.
    const trigger = new Error().stack?.includes("startTriggerRun");
    const config = await realLoad(...args);
    if (trigger) { entered.release(); await release.promise; }
    return config;
  });
  const firing = w.post("triggers/fire", { rule: "app", title: "flow task" });
  try {
    await Promise.race([entered.promise, firing.then(async (response) => { throw new Error(`trigger answered before config: ${await response.clone().text()}`); })]);
    expect((await w.branch(3)).status).toBe(201);
  } finally { release.release(); reader.mockRestore(); }
  const response = await firing;
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ kind: "queued", event: { status: "queued", reason: expect.stringContaining("3 branch runs") } });
  expect((await git(w.repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(4);
  expect(await (await fetch(w.url("flows"))).json()).toEqual([]);
  await until(() => w.starts.length === 3 ? true : undefined, "three group drivers");
  expect(w.starts).toHaveLength(3);
});

test("a cold opted-in start reports setup and a changed lockfile reruns setup after a warm take", async () => {
  const w = await world();
  // Set only this scratch machine layer. It schedules no refill until take pokes it.
  await store.setWarm(w.repo, 1);
  const cold = runBody(await (await w.branch()).json());
  await until(() => w.starts[0], "cold setup");
  expect((await w.runs()).find((run) => run.id === cold.id)?.steps.find((step) => step.kind === "note")?.text).toBe("no warm worktree; setup will run");
  const warm = await until(async () => (await w.info()).repos[0]?.warm[0], "refill after cold take");
  expect(await readFile(join(warm.dir, "setup-count"), "utf8")).toBe("setup\n");
  await writeFile(join(w.repo, "bun.lock"), "changed lock\n");
  await git(w.repo, "add", "bun.lock");
  await git(w.repo, "commit", "-qm", "lockfile");
  const taken = runBody(await (await w.branch()).json());
  await until(() => w.starts[1], "setup after lockfile change");
  expect(await readFile(join(taken.branch?.dir ?? "missing", "setup-count"), "utf8")).toBe("setup\nsetup\n");
  expect((await w.runs()).find((run) => run.id === taken.id)?.steps.map((step) => step.text)).toContain("started in a warm worktree");
});

test("a failed take with a moved destination fails the start and keeps that checkout", async () => {
  const w = await world();
  expect((await w.post("worktrees/warm", { repo: "app", n: 1 })).status).toBe(200);
  await until(async () => (await w.info()).repos[0]?.warm[0], "warm tree");
  const hook = join(w.repo, ".git", "hooks", "post-checkout");
  await writeFile(hook, '#!/bin/sh\nif git symbolic-ref -q HEAD | grep -q "refs/heads/run/"; then echo "fixture checkout refused" >&2; exit 1; fi\n');
  await chmod(hook, 0o755);
  const response = await w.branch();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("warm destination remains occupied") });
  const trees = await git(w.repo, "worktree", "list", "--porcelain");
  const destination = trees.split("\n").find((line) => line.startsWith("worktree ") && /\/[a-f0-9]{8}$/.test(line))?.slice(9);
  expect(destination).toBeDefined();
  expect(existsSync(destination ?? "missing")).toBe(true);
  expect(await readFile(join(destination ?? "missing", "setup-count"), "utf8")).toBe("setup\n");
  expect(await w.runs()).toEqual([]);
  expect(w.starts).toHaveLength(0);
  expect(await (await fetch(w.url("work"))).json()).toMatchObject({ items: [expect.objectContaining({ state: "dropped" })] });
});

test("group cuts consume warm trees and trigger flows retain work provenance", async () => {
  const w = await world();
  expect((await w.post("worktrees/warm", { repo: "app", n: 2 })).status).toBe(200);
  await until(async () => (await w.info()).repos[0]?.warm[0], "first warm tree");
  // Test servers do not run the periodic refill timer.
  expect((await w.post("worktrees/warm", { repo: "app", n: 2 })).status).toBe(200);
  await until(async () => (await w.info()).repos[0]?.warm.length === 2 ? true : undefined, "two warm trees");
  const response = await w.branch(2);
  expect(response.status).toBe(201);
  await until(() => w.starts.length === 2 ? true : undefined, "warm group");
  const groupRuns = await w.runs();
  expect(groupRuns).toHaveLength(2);
  for (const run of groupRuns) {
    expect(run.steps.find((step) => step.kind === "note")?.text).toBe("started in a warm worktree");
    expect(await readFile(join(run.branch?.dir ?? "missing", "setup-count"), "utf8")).toBe("setup\n");
    expect(run.branch?.work).toBeTruthy();
  }
  await until(async () => (await w.info()).repos[0]?.warm[0], "group refill");
  const fired = await w.post("triggers/fire", { rule: "app", title: "flow task" });
  expect(fired.status).toBe(201);
  const delivered = object(await fired.json());
  const event = object(delivered["event"]);
  expect(event["status"]).toBe("working");
  expect(typeof event["work"]).toBe("string");
  await until(() => w.starts.length === 3 ? true : undefined, "warm flow");
  const flowRun = (await w.runs()).find((run) => run.id === w.starts[2]?.env["CANOPY_RUN"]);
  expect(flowRun?.steps.find((step) => step.kind === "note")?.text).toBe("started in a warm worktree");
  expect(flowRun?.branch?.work).toBe(event["work"]);
  const ledger = object(await (await fetch(w.url("work"))).json());
  expect(array(ledger["items"]).find((item) => object(item)["id"] === event["work"])).toMatchObject({ from: { kind: "trigger", event: event["id"] } });
});

test("shutdown revokes warm writes and waits for an in-flight setup before releasing ownership", async () => {
  const w = await world();
  const reached = join(w.dir, "setup-entered");
  const release = join(w.dir, "setup-release");
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(join(w.repo, ".canopy", "gates.json"), JSON.stringify({ warm: 1, setup: `touch ${quote(reached)}; while ! test -f ${quote(release)}; do sleep 0.01; done; printf 'done\\n' >> setup-count`, gates: [] }));
  expect((await w.post("worktrees/warm", { repo: "app", n: 1 })).status).toBe(200);
  await until(() => existsSync(reached) ? true : undefined, "blocked setup");
  let stopped = false;
  const stopping = w.server.stop().then(() => { stopped = true; });
  try {
    // The HTTP server remains bound until pool.idle settles. A stopped pool
    // rejects this write even while its shell command is still in flight.
    expect((await w.post("worktrees/warm", { repo: "app", n: 2 })).status).toBe(409);
    expect(stopped).toBe(false);
  } finally {
    await writeFile(release, "go\n");
    await stopping;
  }
  expect(stopped).toBe(true);
  const config = object(JSON.parse(await readFile(join(w.config, "config.json"), "utf8")));
  expect(object(config["warm"])[w.repo]).toBe(1);
});

test("an opted-in cold start without setup states only that no warm worktree was available", async () => {
  const w = await world();
  await store.setWarm(w.repo, 1);
  await writeFile(join(w.repo, ".canopy", "gates.json"), JSON.stringify({ warm: 1, gates: [] }));
  const response = await w.branch();
  expect(response.status).toBe(201);
  const run = runBody(await response.json());
  await until(() => w.starts[0], "start without setup");
  const notes = (await w.runs()).find((r) => r.id === run.id)?.steps.filter((step) => step.kind === "note").map((step) => step.text);
  expect(notes?.[0]).toBe("no warm worktree");
  expect(notes?.some((text) => text?.includes("setup"))).toBe(false);
  expect(existsSync(join(run.branch?.dir ?? "missing", "setup-count"))).toBe(false);
});
