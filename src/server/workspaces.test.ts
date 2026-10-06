/**
 * A workspace's look and its runs over the API: PATCH sets or clears the
 * primary (by repo id) and the color without touching the members, and
 * POST /api/workspaces/run starts one run on the primary with the other
 * local members added as folders. Any local member with a run or a flow
 * going refuses the run, a member the run cannot open is left out in
 * words, and a Codex route is refused: workspace runs are Claude Code's.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, DriveSpec, RunDriver } from "../core/driver";
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
  for (const name of ["api", "analysis", "other"]) {
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
  await stopRun(run.id);
});

test("a busy member that is not the primary refuses the workspace run", async () => {
  const onApi = await call("POST", "/api/repos/run?id=api", { action: "ask", note: "busy" });
  expect(onApi.status).toBe(201);
  const r = await call("POST", "/api/workspaces/run", { name: "bike", action: "ask", note: "again" });
  expect(r.status).toBe(409);
  expect(await errorOf(r)).toMatch(/^api already has a .+ run going$/);
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
