/**
 * The server's side of the coordinator's runner (FR-010): /api/about's flag,
 * a coordinate run's own folder under the runner's seeds and its start
 * there, and the origin gate on the address a coordinator calls canopy at.
 * The runner is a stand-in client and the harness a driver that runs
 * nothing, so nothing here needs docker or a claude login.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { StageClient } from "../core/stageclient";
import type { About, Harness, Run } from "../core/types";
import { startServer } from "./index";

const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_BIND", "CANOPY_CALLERS", "CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT"];
const saved: Record<string, string | undefined> = {};
let scratch = "";

/** a driver that only records what it was started with */
class Recorder implements RunDriver {
  readonly label = "Claude Code";
  ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: 0, stderr: "" });
  }
}

/** the coordinator's runner as the server reads it: answering or not, fenced or not */
function fakeRunner(state: { answers: boolean; fenced: boolean }): StageClient {
  const client = {
    harnessesNow: () => (state.answers ? ["claude"] : null),
    fenceNow: () => (state.answers ? { fenced: state.fenced ? true : "unchecked", reason: state.fenced ? null : "the fence is unchecked: set CANOPY_FENCE_PROBE" } : null),
    watch: () => () => {},
    hello: async () => (state.answers ? ["claude"] : null),
    busy: async () => false,
    fenceRefusal: () => null,
    spawn: () => {
      throw new Error("the recorder never spawns");
    },
  };
  return client as unknown as StageClient;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-coordrunner-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env["CANOPY_TMUX"] = "0";
  process.env["CANOPY_CALLERS"] = "off";
  delete process.env["CANOPY_BIND"];
  const repo = join(scratch, "root", "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

type Up = { port: number; stop: () => Promise<void>; made: Recorder[]; seeds: string };

async function up(name: string, client: StageClient | null, env: Record<string, string> = {}): Promise<Up> {
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, name);
  const seeds = join(scratch, `${name}-seeds`);
  await mkdir(seeds);
  for (const k of ["CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT"]) delete process.env[k];
  Object.assign(process.env, { CANOPY_COORD_ROOT: seeds, ...env });
  const made: Recorder[] = [];
  const s = await startServer({
    root: join(scratch, "root"),
    port: 0,
    coordinator: { client },
    runner: {
      driver: (h) => {
        const d = new Recorder(h);
        made.push(d);
        return d;
      },
    },
  });
  return { ...s, made, seeds };
}

const about = async (s: Up, host?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${s.port}/api/about`, host ? { headers: { host } } : {});

describe("without a coordinator's runner", () => {
  let s: Up;
  beforeAll(async () => {
    s = await up("none", null);
  });
  afterAll(() => s.stop());

  test("/api/about says no coordinator", async () => {
    expect(((await (await about(s)).json()) as About).coordinator).toBe(false);
  });
});

describe("with a coordinator's runner", () => {
  const state = { answers: true, fenced: true };
  const API = "http://10.250.14.1:7850";
  let s: Up;
  beforeAll(async () => {
    s = await up("coord", fakeRunner(state), { CANOPY_COORD_SOCKET: "/run/canopy-coord/runner.sock", CANOPY_COORD_API: API });
  });
  afterAll(() => s.stop());

  test("/api/about says so while the runner answers, and not while it does not", async () => {
    expect(((await (await about(s)).json()) as About).coordinator).toBe(true);
    state.answers = false;
    try {
      expect(((await (await about(s)).json()) as About).coordinator).toBe(false);
    } finally {
      state.answers = true;
    }
  });

  test("the coordinator's own address passes the origin gate, and a neighbour of it does not", async () => {
    const ok = await about(s, "10.250.14.1:7850");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as About).coordinator).toBe(true);
    expect((await about(s, "10.250.14.2:7850")).status).toBe(403);
    expect((await about(s, "10.250.14.1:7851")).status).toBe(403);
  });

  test("a coordinate run starts in a folder of its own under the seeds, 0700, with the address and a token", async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/repos/run?id=app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "coordinate", note: "ship it" }),
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as Run;
    const ctx = s.made.at(-1)?.ctx;
    const dir = join(s.seeds, run.id);
    expect(ctx?.cwd).toBe(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(ctx?.pass?.["CANOPY_API"]).toBe(API);
    expect(ctx?.pass?.["CANOPY_TOKEN"]).toMatch(/\S/);
    const stopped = await fetch(`http://127.0.0.1:${s.port}/api/runs/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: run.id }),
    });
    expect(((await stopped.json()) as Run).status).not.toBe("working");
  });

  test("a runner whose fence is not confirmed holds the run in its words, and leaves no folder", async () => {
    state.fenced = false;
    const before = await readdir(s.seeds);
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/repos/run?id=app`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "coordinate", note: "again" }),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain("the fence is unchecked");
      expect(await readdir(s.seeds)).toEqual(before);
    } finally {
      state.fenced = true;
    }
  });
});
