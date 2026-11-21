/**
 * `/api/repos/floorplan` on a real server with a stand-in agent (FR-070):
 * the read says there is no map, a make starts a Claude run in the checkout
 * with canopy's copy of Floorplan loaded and the rules to write floorplan/,
 * the read then names the run, a second make waits on the first, and an
 * open with no map, a bad act and a repo the backend cannot reach refuse.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { FloorplanInfo } from "../core/floorplan";
import type { Harness, Run } from "../core/types";
import { FLOORPLAN_PLUGIN } from "./floorplan";
import { startServer } from "./index";

/** what each run's driver was started with */
const started: { ctx: DriveCtx; message: string }[] = [];

/** a harness that never finishes on its own; a stop ends it */
class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    started.push({ ctx, message });
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

let scratch: string;
let previous: string | undefined;
let app = "";
let server: { port: number; stop: () => void };
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (body: unknown) => fetch(url("/api/repos/floorplan?id=app"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async () => (await (await fetch(url("/api/repos/floorplan?id=app"))).json()) as FloorplanInfo;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-floorplan-route-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  app = join(root, "app");
  await mkdir(app, { recursive: true });
  await Bun.$`git -C ${app} init -q && git -C ${app} -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init`.quiet();
  app = await realpath(app);
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null },
    runner: { driver: (h) => new HoldingDriver(h) },
  });
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a make starts a map run with Floorplan loaded; the read names it; a second waits; open and bad acts refuse", async () => {
  expect(await read()).toMatchObject({ state: "none", server: null, run: null });

  expect((await post({ act: "draw" })).status).toBe(400);
  const early = await post({ act: "open" });
  expect(early.status).toBe(400);
  expect(((await early.json()) as { error: string }).error).toContain("no map here yet");

  const res = await post({ act: "make", note: "the server matters most", developers: true });
  expect(res.status).toBe(201);
  const run = (await res.json()) as Run;
  expect(run).toMatchObject({ action: "floorplan", verb: "map" });
  const one = started.at(-1);
  if (!one) throw new Error("no run started");
  expect(one.ctx.cwd).toBe(app);
  expect(one.ctx.spec.pluginDirs).toEqual([FLOORPLAN_PLUGIN]);
  expect(one.ctx.spec.allowedTools).toContain(`Edit(/${app}/floorplan/**)`);
  expect(one.ctx.env["FLOORPLAN_AGENT"]).toBe("claude");
  expect(one.ctx.env["PATH"]?.split(":").length).toBeGreaterThan(0);
  expect(one.message).toContain("make a floorplan of this repository with the floorplan:floorplan skill");
  expect(one.message).toContain(`"audience": "developers"`);
  expect(one.message).toContain("the server matters most");

  expect((await read()).run).toBe(run.id);
  expect((await post({ act: "make" })).status).toBe(409);

  const stopped = await fetch(url("/api/runs/stop"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: run.id }) });
  expect(stopped.ok).toBe(true);
  for (let i = 0; i < 50 && (await read()).run !== null; i++) await Bun.sleep(50);
  expect((await read()).run).toBeNull();
}, 60_000);

test("a repo the backend does not scan is a 404", async () => {
  expect((await fetch(url("/api/repos/floorplan?id=nope"))).status).toBe(404);
});
