/**
 * Canopy's own health checks on a real server: the pieces it registers at
 * start, and the flows lock that a second server takes over by the button
 * once the first one is gone.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "../core/tmux";
import type { HealthCheck, RepoHealthInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let root: string;
const servers: { port: number; stop: () => void }[] = [];

const checks = async (port: number): Promise<HealthCheck[]> => ((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { checks: HealthCheck[] }).checks;
const one = async (port: number, id: string) => (await checks(port)).find((c) => c.id === id);

async function until(pred: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-health-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  await mkdir(join(scratch, "root"));
  root = await realpath(join(scratch, "root"));
  await mkdir(join(root, "app"));
  await Bun.$`git -C ${join(root, "app")} init -q`.quiet();
});

afterAll(async () => {
  for (const s of servers) s.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a server lists its own pieces, and takes the flows over once their keeper is gone", async () => {
  const first = await startServer({ root, port: 0, harnesses: ["claude"], chan: null });
  servers.push(first);
  const ids = (await checks(first.port)).map((c) => c.id);
  for (const id of ["canopy:tailchan", "canopy:registry", "canopy:asks", "canopy:ranger", "canopy:tmux", "canopy:stages", "canopy:flows"]) expect(ids).toContain(id);
  expect(ids.some((id) => id.startsWith("canopy:watch:"))).toBe(true);
  expect((await one(first.port, "canopy:tailchan"))?.state).toBe("off");
  expect((await one(first.port, "canopy:stages"))?.state).toBe("off");
  await until(async () => (await one(first.port, "canopy:flows"))?.state === "ok", "the first server's flows check");
  await until(async () => (await checks(first.port)).filter((c) => c.id.startsWith("canopy:watch:")).every((c) => c.state === "ok"), "the watcher check");

  const log = spyOn(console, "error").mockImplementation(() => {});
  let second: { port: number; stop: () => void };
  try {
    second = await startServer({ root, port: 0, harnesses: ["claude"], chan: null });
  } finally {
    log.mockRestore();
  }
  servers.push(second);
  await until(async () => (await one(second.port, "canopy:flows"))?.state === "down", "the second server's flows check");
  expect((await one(second.port, "canopy:flows"))?.why).toContain(`pid ${process.pid}`);

  // still held: the button says so and stays down
  const held = await fetch(`http://127.0.0.1:${second.port}/api/health/heal?id=canopy:flows`, { method: "POST" });
  expect(((await held.json()) as HealthCheck).state).toBe("down");

  first.stop();
  await Bun.sleep(100);
  const taken = await fetch(`http://127.0.0.1:${second.port}/api/health/heal?id=canopy:flows`, { method: "POST" });
  expect(((await taken.json()) as HealthCheck).state).toBe("ok");

  const tmux = await fetch(`http://127.0.0.1:${second.port}/api/health/heal?id=canopy:tmux`, { method: "POST" });
  expect(tmux.status).toBe(409);
  second.stop();
});

test("a repo's file and canopy's layer become the repo's checks", async () => {
  const target = Bun.serve({ port: 0, fetch: () => new Response("up") });
  await mkdir(join(root, "app", ".canopy"), { recursive: true });
  await Bun.write(join(root, "app", ".canopy", "health.json"), JSON.stringify({ checks: [{ name: "site", kind: "http", url: `http://127.0.0.1:${target.port}/` }, { name: "smoke", kind: "command", run: "true" }] }));
  const s = await startServer({ root, port: 0, harnesses: ["claude"], chan: null });
  servers.push(s);
  try {
    const api = (q: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}/api/repos/health?${q}`, init);
    await until(async () => (await one(s.port, "repo:app:site"))?.state === "ok", "the repo's http check");
    // no remote, so not the user's: the file's command does not run here
    expect(await one(s.port, "repo:app:smoke")).toMatchObject({ state: "off", why: "not run: not your repo" });

    const added = await api("id=app", { method: "POST", body: JSON.stringify({ name: "api", kind: "port", port: target.port }) });
    expect(((await added.json()) as RepoHealthInfo).checks.map((c) => `${c.name}:${c.source}`)).toEqual(["site:repo", "smoke:repo", "api:canopy"]);
    await until(async () => (await one(s.port, "repo:app:api"))?.state === "ok", "canopy's port check");

    expect((await api("id=app", { method: "POST", body: JSON.stringify({ name: "x", kind: "port" }) })).status).toBe(400);
    expect((await api("id=nope")).status).toBe(404);

    const removed = await api("id=app&name=api", { method: "DELETE" });
    expect(((await removed.json()) as RepoHealthInfo).checks.map((c) => c.name)).toEqual(["site", "smoke"]);
    expect(await one(s.port, "repo:app:api")).toBeUndefined();
  } finally {
    target.stop(true);
  }
});

test("a saved health file reaches the checks without a rescan", async () => {
  const s = await startServer({ root, port: 0, harnesses: ["claude"], chan: null });
  servers.push(s);
  await until(async () => (await one(s.port, "repo:app:site")) !== undefined, "the first sync");
  await Bun.write(join(root, "app", ".canopy", "health.json"), JSON.stringify({ checks: [{ name: "late", kind: "port", port: 1 }] }));
  await until(async () => (await one(s.port, "repo:app:late")) !== undefined && (await one(s.port, "repo:app:site")) === undefined, "the saved file's checks");
  s.stop();
});
