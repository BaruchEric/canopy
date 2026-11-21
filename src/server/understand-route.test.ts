/**
 * `/api/repos/understand` on a real server with a stand-in agent (FR-072):
 * with the plugin's copy standing ready, the read says there is no graph, a
 * make starts a Claude run in the checkout with that copy loaded, the rules
 * to write .ua/ and the env that keeps the graph in this checkout, the read
 * then names the run, a second make is refused while it goes, and an open
 * with no graph, a bad act and a repo the backend cannot reach refuse.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { UnderstandInfo } from "../core/understand";
import type { Harness, Run } from "../core/types";
import { pluginDir } from "./understand";
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
const post = (body: unknown) => fetch(url("/api/repos/understand?id=app"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async () => (await (await fetch(url("/api/repos/understand?id=app"))).json()) as UnderstandInfo;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-understand-route-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  // the prepared copy, standing ready without an install
  mkdirSync(join(pluginDir(), "skills", "understand"), { recursive: true });
  writeFileSync(join(pluginDir(), "skills", "understand", "scan-project.mjs"), "");
  writeFileSync(join(pluginDir(), "skills", "understand", "merge-batch-graphs.py"), "");
  writeFileSync(join(pluginDir(), ".canopy-prepared"), "{}\n");
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

test("a make starts a graph run with the plugin loaded; the read names it; a second is refused; open and bad acts refuse", async () => {
  expect(await read()).toMatchObject({ state: "none", folder: ".ua", plugin: { state: "ready" }, server: null, run: null });

  expect((await post({ act: "draw" })).status).toBe(400);
  expect((await post({ act: "make", note: 3 })).status).toBe(400);
  const early = await post({ act: "open" });
  expect(early.status).toBe(400);
  expect(((await early.json()) as { error: string }).error).toContain("no graph here yet");
  expect(await (await post({ act: "prepare" })).json()).toEqual({ plugin: { state: "ready" } });

  const res = await post({ act: "make", note: "the payments code matters most" });
  expect(res.status).toBe(201);
  const run = (await res.json()) as Run;
  expect(run).toMatchObject({ action: "understand", verb: "understand" });
  const one = started.at(-1);
  if (!one) throw new Error("no run started");
  expect(one.ctx.cwd).toBe(app);
  expect(one.ctx.spec.pluginDirs).toEqual([pluginDir()]);
  expect(one.ctx.spec.allowedTools).toContain(`Edit(/${app}/.ua/**)`);
  expect(one.ctx.spec.allowedTools).toContain(`Bash(node ${pluginDir()}/skills/understand/scan-project.mjs:*)`);
  expect(one.ctx.spec.allowedTools).toContain(`Bash(python ${pluginDir()}/skills/understand/merge-batch-graphs.py:*)`);
  expect(one.ctx.env["UNDERSTAND_NO_WORKTREE_REDIRECT"]).toBe("1");
  expect(one.message).toContain("make a knowledge graph of this repository with the understand-anything:understand skill");
  expect(one.message).toContain(`Invoke the skill first with the arguments "${app}"`);
  expect(one.message).toContain("the payments code matters most");
  // the graph's folder keeps itself out of git before the run writes to it
  expect(existsSync(join(app, ".ua", ".gitignore"))).toBe(true);
  expect((await Bun.$`git -C ${app} status --porcelain`.quiet()).stdout.toString().trim()).toBe("");

  expect((await read()).run).toBe(run.id);
  expect((await post({ act: "make", full: true })).status).toBe(409);

  const stopped = await fetch(url("/api/runs/stop"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: run.id }) });
  expect(stopped.ok).toBe(true);
  for (let i = 0; i < 50 && (await read()).run !== null; i++) await Bun.sleep(50);
  expect((await read()).run).toBeNull();

  // a rebuild says so to the run
  const again = await post({ act: "make", full: true });
  expect(again.status).toBe(201);
  expect(started.at(-1)?.message).toContain(`"${app} --full"`);
  const second = (await again.json()) as Run;
  await fetch(url("/api/runs/stop"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: second.id }) });
}, 60_000);

test("a repo the backend does not scan is a 404", async () => {
  expect((await fetch(url("/api/repos/understand?id=nope"))).status).toBe(404);
});
