/**
 * A workspace's look and its runs over the API: PATCH sets or clears the
 * primary (by repo id) and the color without touching the members, and
 * POST /api/workspaces/run starts one run on the primary with the other
 * local members added as folders. Any local member with a run or a flow
 * going refuses the run, a member the run cannot open (an incubator seed
 * among them) is left out in words, and a Codex route, a seed primary and a
 * forge primary are refused. A member on another host cannot be made the
 * primary.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, DriveSpec, RunDriver } from "../core/driver";
import { SEED_AGENT_REFUSAL } from "../core/sprout";
import { upsertWorkspace } from "../core/store";
import { isRunActive, type Harness, type Repo, type Run, type Workspace } from "../core/types";
import { startServer } from "./index";

/** every spec a run started with, in order */
const specs: DriveSpec[] = [];

/** holds the run open, doing nothing, until it is stopped */
class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
    specs.push(ctx.spec);
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
/** the members' paths as the server holds them (realpath'd) */
let api = "";
let analysis = "";
let seed = "";

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const call = (method: string, p: string, body: unknown) => fetch(url(p), { method, body: JSON.stringify(body) });
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const lastSpec = (): DriveSpec | undefined => specs[specs.length - 1];

async function until(pred: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(30);
  }
}

/** stops a run and waits until the runner has let its repo go */
async function stopRun(id: string): Promise<void> {
  expect((await call("POST", "/api/runs/stop", { id })).status).toBe(200);
  await until(async () => {
    const run = ((await (await fetch(url("/api/runs"))).json()) as Run[]).find((r) => r.id === id);
    return !run || !isRunActive(run);
  }, `run ${id} to end`);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-ws-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  for (const name of ["api", "analysis", "other", "_incubator/sprout"]) {
    await Bun.$`mkdir -p ${join(root, name)} && git -C ${join(root, name)} init -q`.quiet();
  }
  server = await startServer({ root, port: 0, chan: null, harnesses: ["claude"], runner: { driver: (h) => new HoldingDriver(h) } });
  const tree = (await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] };
  const pathOf = (id: string): string => {
    const found = tree.repos.find((r) => r.id === id);
    if (!found) throw new Error(`no ${id} in the scan`);
    return found.path;
  };
  api = pathOf("api");
  analysis = pathOf("analysis");
  seed = pathOf("_incubator/sprout");
  expect((await call("POST", "/api/workspaces", { name: "bike", repos: ["api", "analysis"] })).status).toBe(200);
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("PATCH sets the primary by repo id and the color, and refuses a non-member, a bad color and a bad body", async () => {
  let r = await call("PATCH", "/api/workspaces", { name: "bike", primary: "analysis", color: "moss" });
  expect(r.status).toBe(200);
  expect(((await r.json()) as Workspace[])[0]).toEqual({ name: "bike", repos: [api, analysis], primary: analysis, color: "moss" });
  r = await call("PATCH", "/api/workspaces", { name: "bike", primary: "other" });
  expect(r.status).toBe(400);
  expect(await errorOf(r)).toBe("not a member of bike");
  expect((await call("PATCH", "/api/workspaces", { name: "bike", color: "#fff" })).status).toBe(400);
  expect((await call("PATCH", "/api/workspaces", { name: "bike", primary: 3 })).status).toBe(400);
  expect((await call("PATCH", "/api/workspaces", { name: "nope", color: "sky" })).status).toBe(404);
  expect((await call("PATCH", "/api/workspaces", null)).status).toBe(400);
  expect((await call("PATCH", "/api/workspaces", [])).status).toBe(400);
  // null clears one field and leaves the other; the members never move
  r = await call("PATCH", "/api/workspaces", { name: "bike", color: null });
  expect(((await r.json()) as Workspace[])[0]).toEqual({ name: "bike", repos: [api, analysis], primary: analysis });
});

test("a workspace run starts on the primary with the others added", async () => {
  const r = await call("POST", "/api/workspaces/run", { name: "bike", action: "ask", note: "look around" });
  expect(r.status).toBe(201);
  const run = (await r.json()) as Run;
  expect(run.repoId).toBe("analysis");
  expect(run.workspace).toBe("bike");
  expect(lastSpec()?.addDirs).toEqual([api]);
  // the primary is busy now, so a second run is refused
  const again = await call("POST", "/api/workspaces/run", { name: "bike", action: "ask", note: "again" });
  expect(again.status).toBe(409);
  expect(await errorOf(again)).toContain("analysis");
  // only the primary is held while it runs: the other member takes a run of its own
  const onApi = await call("POST", "/api/repos/run?id=api", { action: "ask", note: "meanwhile" });
  expect(onApi.status).toBe(201);
  await stopRun(((await onApi.json()) as Run).id);
  await stopRun(run.id);
});

test("a busy member that is not the primary refuses the workspace run", async () => {
  const onApi = await call("POST", "/api/repos/run?id=api", { action: "ask", note: "busy" });
  expect(onApi.status).toBe(201);
  const r = await call("POST", "/api/workspaces/run", { name: "bike", action: "ask", note: "again" });
  expect(r.status).toBe(409);
  expect(await errorOf(r)).toMatch(/^api already has a run going \(.+\)$/);
  const runs = (await (await fetch(url("/api/runs"))).json()) as Run[];
  for (const run of runs.filter(isRunActive)) await stopRun(run.id);
});

test("a member the run cannot open is named in the first note and not added", async () => {
  await upsertWorkspace("far", [analysis, api, "/nowhere"]);
  const r = await call("POST", "/api/workspaces/run", { name: "far", action: "ask", note: "x" });
  expect(r.status).toBe(201);
  const run = (await r.json()) as Run;
  expect(run.repoId).toBe("analysis");
  expect(run.steps.filter((s) => s.kind === "note").map((s) => s.text)).toEqual(["left out of this run: /nowhere (not found by the last scan)"]);
  expect(lastSpec()?.addDirs).toEqual([api]);
  await stopRun(run.id);
});

test("a primary missing from the scan, an empty workspace and an unknown one are refused plainly", async () => {
  await upsertWorkspace("ghost", ["/nowhere", api]);
  const ghost = await call("POST", "/api/workspaces/run", { name: "ghost", action: "ask", note: "x" });
  expect(ghost.status).toBe(404);
  expect(await errorOf(ghost)).toContain("/nowhere");
  await call("POST", "/api/workspaces", { name: "empty", repos: [] });
  const empty = await call("POST", "/api/workspaces/run", { name: "empty", action: "ask", note: "x" });
  expect(empty.status).toBe(400);
  expect(await errorOf(empty)).toBe("the workspace has no repos");
  expect((await call("POST", "/api/workspaces/run", { name: "nope", action: "ask", note: "x" })).status).toBe(404);
  expect((await call("POST", "/api/workspaces/run", { name: "bike", action: "fly", note: "x" })).status).toBe(400);
  expect((await call("POST", "/api/workspaces/run", null)).status).toBe(400);
});

test("a workspace run on a Codex route is refused", async () => {
  const codex = { harness: "codex", model: "gpt-5.5", effort: "high", yolo: false, extra: "" };
  expect((await call("POST", "/api/agents/role", { role: "job", pick: codex })).status).toBe(200);
  try {
    const r = await call("POST", "/api/workspaces/run", { name: "bike", action: "ask", note: "x" });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toBe("workspace runs need Claude Code");
  } finally {
    expect((await call("POST", "/api/agents/role", { role: "job", pick: null })).status).toBe(200);
  }
});

test("a workspace propose run starts in plan mode on the primary with the others added", async () => {
  const r = await call("POST", "/api/workspaces/run", { name: "bike", action: "propose", note: "plan it" });
  expect(r.status).toBe(201);
  const run = (await r.json()) as Run;
  expect(run.action).toBe("propose");
  expect(run.repoId).toBe("analysis");
  expect(run.workspace).toBe("bike");
  expect(lastSpec()?.permissionMode).toBe("plan");
  expect(lastSpec()?.addDirs).toEqual([api]);
  await stopRun(run.id);
});

test("a propose run on a Codex route is refused, in a repo and in a workspace", async () => {
  const codex = { harness: "codex", model: "gpt-5.5", effort: "high", yolo: false, extra: "" };
  expect((await call("POST", "/api/agents/role", { role: "job", pick: codex })).status).toBe(200);
  try {
    const repo = await call("POST", "/api/repos/run?id=api", { action: "propose", note: "x" });
    expect(repo.status).toBe(400);
    expect(await errorOf(repo)).toBe("plan, then build needs Claude Code");
    // the action is checked before the workspace, so a workspace propose hears the same words
    const ws = await call("POST", "/api/workspaces/run", { name: "bike", action: "propose", note: "x" });
    expect(ws.status).toBe(400);
    expect(await errorOf(ws)).toBe("plan, then build needs Claude Code");
  } finally {
    expect((await call("POST", "/api/agents/role", { role: "job", pick: null })).status).toBe(200);
  }
});

test("an incubator seed among the members is left out in words, not added as a folder", async () => {
  await upsertWorkspace("seeded", [analysis, seed, api]);
  const before = specs.length;
  const r = await call("POST", "/api/workspaces/run", { name: "seeded", action: "ask", note: "x" });
  expect(r.status).toBe(201);
  const run = (await r.json()) as Run;
  expect(specs.length).toBe(before + 1);
  expect(lastSpec()?.addDirs).toEqual([api]);
  expect(run.steps.filter((s) => s.kind === "note").map((s) => s.text)).toEqual([`left out of this run: ${seed} (an incubator seed)`]);
  await stopRun(run.id);
});

test("a seed as the primary refuses the workspace run before anything starts", async () => {
  await upsertWorkspace("sprouting", [seed, api]);
  const before = specs.length;
  const r = await call("POST", "/api/workspaces/run", { name: "sprouting", action: "ask", note: "x" });
  expect(r.status).toBe(400);
  expect(await errorOf(r)).toBe(SEED_AGENT_REFUSAL);
  expect(specs.length).toBe(before);
  const runs = (await (await fetch(url("/api/runs"))).json()) as Run[];
  for (const run of runs.filter(isRunActive)) await stopRun(run.id);
});

test("a forge repo as the primary, from a hand-edited config, refuses the run", async () => {
  const forge = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json([{ name: "lamp", full_name: "eric/lamp", html_url: "https://forge.test/eric/lamp", clone_url: "https://forge.test/eric/lamp.git", default_branch: "main" }]),
  });
  try {
    const added = await call("POST", "/api/sources", { kind: "forgejo", url: `http://127.0.0.1:${forge.port}` });
    expect(added.status).toBe(201);
    const tree = (await added.json()) as { repos: Repo[] };
    const lamp = tree.repos.find((r) => r.forge && r.name === "lamp");
    if (!lamp) throw new Error("no forge repo in the scan");
    await upsertWorkspace("forged", [lamp.path, api]);
    const before = specs.length;
    const r = await call("POST", "/api/workspaces/run", { name: "forged", action: "ask", note: "x" });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toBe("lamp is on the forge; an agent runs in a folder on this machine");
    expect(specs.length).toBe(before);
    expect((await call("DELETE", `/api/sources?id=${encodeURIComponent(lamp.source)}`, null)).status).toBe(200);
  } finally {
    const runs = (await (await fetch(url("/api/runs"))).json()) as Run[];
    for (const run of runs.filter(isRunActive)) await stopRun(run.id);
    forge.stop(true);
  }
});

test("a member on another host cannot be made the primary", async () => {
  // a stand-in ssh that runs the remote command here, so a folder of this
  // machine scans as one on the host "far"
  const bin = join(scratch, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ssh"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nexec /bin/sh -c "$1"\n`);
  await chmod(join(bin, "ssh"), 0o755);
  const far = join(scratch, "far");
  await Bun.$`mkdir -p ${join(far, "lamp")} && git -C ${join(far, "lamp")} init -q`.quiet();
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  try {
    const added = await call("POST", "/api/sources", { kind: "ssh", host: "far", path: far });
    expect(added.status).toBe(201);
    const tree = (await added.json()) as { repos: Repo[] };
    const lamp = tree.repos.find((r) => r.host === "far" && r.name === "lamp");
    if (!lamp) throw new Error("no remote repo in the scan");
    expect((await call("POST", "/api/workspaces", { name: "wide", repos: ["api", lamp.id] })).status).toBe(200);
    const r = await call("PATCH", "/api/workspaces", { name: "wide", primary: lamp.id });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toBe("lamp is on far; a workspace run starts in a primary on this machine");
    const ws = ((await (await fetch(url("/api/workspaces"))).json()) as Workspace[]).find((w) => w.name === "wide");
    expect(ws?.primary).toBeUndefined();
    expect((await call("DELETE", `/api/sources?id=${encodeURIComponent(lamp.source)}`, null)).status).toBe(200);
  } finally {
    if (path === undefined) delete process.env["PATH"];
    else process.env["PATH"] = path;
  }
});
