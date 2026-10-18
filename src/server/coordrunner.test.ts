/**
 * The server's side of the coordinator's runner (FR-010): /api/about's flag,
 * a coordinate run's own folder under the runner's seeds and its start
 * there, the origin gate on the address a coordinator calls canopy at, the
 * refusal outside enforce, and the coordinator's lane.
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
import { CallerBook } from "./callers";
import { startServer } from "./index";

const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_BIND", "CANOPY_CALLERS", "CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT", "CANOPY_COORD_NET"];
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

type Up = { port: number; stop: () => Promise<void>; made: Recorder[]; seeds: string; page: string };

/** A server with its own config dir, in enforce unless `env` says otherwise,
 *  with a page token minted into its book before it starts. */
async function up(name: string, client: StageClient | null, env: Record<string, string> = {}): Promise<Up> {
  const config = join(scratch, name);
  process.env["CANOPY_CONFIG_DIR"] = config;
  const book = new CallerBook({ file: join(config, "callers.json") });
  const page = book.mint("page", { label: "a page" }).token;
  await book.flush();
  const seeds = join(scratch, `${name}-seeds`);
  await mkdir(seeds);
  for (const k of ["CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT", "CANOPY_COORD_NET"]) delete process.env[k];
  Object.assign(process.env, { CANOPY_CALLERS: "enforce", CANOPY_COORD_ROOT: seeds, ...env });
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
  return { ...s, made, seeds, page };
}

const about = async (s: Up, host?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${s.port}/api/about`, host ? { headers: { host } } : {});

const call = (s: Up, path: string, token?: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (token) headers.set("x-canopy-token", token);
  return fetch(`http://127.0.0.1:${s.port}${path}`, { ...init, headers });
};

const postAs = (s: Up, path: string, body: unknown, token?: string): Promise<Response> =>
  call(s, path, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const API = "http://10.250.14.1:7850";
const COORD_ENV = { CANOPY_COORD_SOCKET: "/run/canopy-coord/runner.sock", CANOPY_COORD_API: API };

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

describe("with a coordinator's runner, outside enforce", () => {
  for (const mode of ["log", "off"]) {
    test(`${mode}: /api/about says no coordinator, and a coordinate run is refused saying why`, async () => {
      const s = await up(`unsafe-${mode}`, fakeRunner({ answers: true, fenced: true }), { ...COORD_ENV, CANOPY_CALLERS: mode });
      try {
        expect(((await (await about(s)).json()) as About).coordinator).toBe(false);
        const res = await postAs(s, "/api/repos/run?id=app", { action: "coordinate", note: "ship it" }, s.page);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain("CANOPY_CALLERS=enforce");
        expect(await readdir(s.seeds)).toEqual([]);
      } finally {
        await s.stop();
      }
    });
  }

  test("a CANOPY_COORD_NET that is no network keeps coordinators off too", async () => {
    const s = await up("badnet", fakeRunner({ answers: true, fenced: true }), { ...COORD_ENV, CANOPY_COORD_NET: "10.250.14.0/99" });
    try {
      expect(((await (await about(s)).json()) as About).coordinator).toBe(false);
      const res = await postAs(s, "/api/repos/run?id=app", { action: "coordinate", note: "ship it" }, s.page);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("CANOPY_COORD_NET");
    } finally {
      await s.stop();
    }
  });
});

describe("with a coordinator's runner", () => {
  const state = { answers: true, fenced: true };
  let s: Up;
  beforeAll(async () => {
    s = await up("coord", fakeRunner(state), COORD_ENV);
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
    const res = await postAs(s, "/api/repos/run?id=app", { action: "coordinate", note: "ship it" }, s.page);
    expect(res.status).toBe(201);
    const run = (await res.json()) as Run;
    const ctx = s.made.at(-1)?.ctx;
    const dir = join(s.seeds, run.id);
    expect(ctx?.cwd).toBe(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(ctx?.pass?.["CANOPY_API"]).toBe(API);
    const token = ctx?.pass?.["CANOPY_TOKEN"] ?? "";
    expect(token).toMatch(/\S/);
    // the token keeps to the lane from any address: the brief's reads and its plan
    expect((await call(s, "/api/runs", token)).status).toBe(200);
    expect((await call(s, "/api/tree", token)).status).toBe(200);
    expect((await call(s, "/api/repos/diff?id=app&untracked=1&file=.env", token)).status).toBe(403);
    expect((await call(s, "/api/flows", token)).status).toBe(403);
    const plan = await postAs(s, "/api/coordinator/plan", { tasks: [{ title: "t", repo: "app", note: "n", action: "ask" }] }, token);
    expect(plan.status).toBe(200);
    expect((await postAs(s, "/api/coordinator/start", { run: run.id }, token)).status).toBe(403);
    const stopped = await postAs(s, "/api/runs/stop", { id: run.id }, s.page);
    expect(((await stopped.json()) as Run).status).not.toBe("working");
  });

  test("a runner whose fence is not confirmed holds the run in its words, and leaves no folder", async () => {
    state.fenced = false;
    const before = await readdir(s.seeds);
    try {
      const res = await postAs(s, "/api/repos/run?id=app", { action: "coordinate", note: "again" }, s.page);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain("the fence is unchecked");
      expect(await readdir(s.seeds)).toEqual(before);
    } finally {
      state.fenced = true;
    }
  });
});

describe("the coordinator's lane", () => {
  let s: Up;
  beforeAll(async () => {
    // every local call is from the coordinator's network here
    s = await up("lane", fakeRunner({ answers: true, fenced: true }), { ...COORD_ENV, CANOPY_COORD_NET: "127.0.0.0/8" });
  });
  afterAll(() => s.stop());

  test("a call from its network without a coordinator's token is refused, a page's token or none, on any path", async () => {
    for (const path of ["/api/about", "/api/runs", "/api/repos/diff?id=app&untracked=1&file=.env", "/api/events", "/library", "/"]) {
      for (const token of [undefined, s.page]) {
        const res = await call(s, path, token);
        expect([path, token ? "page" : "none", res.status]).toEqual([path, token ? "page" : "none", 403]);
      }
    }
    expect((await postAs(s, "/api/repos/run?id=app", { action: "ask", note: "x" }, s.page)).status).toBe(403);
  });

  test("a shell socket from its network does not open", async () => {
    const q = new URLSearchParams({ id: "app", term: "fedcba9876543210fedcba9876543210", place: "strip", cols: "80", rows: "24" });
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/term?${q}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });
    if (opened) ws.close();
    expect(opened).toBe(false);
  });
});
