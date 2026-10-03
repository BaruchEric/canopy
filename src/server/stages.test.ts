/**
 * The server and the stage runner: a stage starts only through the runner,
 * or here under the unisolated switch, and the incubator says which. A
 * queued sprout waits while the runner is away and starts on its own once
 * it answers. A stage process still alive in a seed after its run ended
 * keeps canopy's git out of the seed, and a flow's end waits for it before
 * it reads the seed's status.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { ExecResult } from "../core/exec";
import { git } from "../core/exec";
import type { Harness } from "../core/harness";
import { SEED_BUSY, seedBusy } from "../core/seedgit";
import { StageClient } from "../core/stageclient";
import type { Flow, IncubatorStages, Run, ScanResult, ServerEvent, Sprout } from "../core/types";
import { startStageRunner } from "../stage/runner";
import { startServer } from "./index";

const NO_RUNNER = "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1";

/** a harness that never finishes on its own; a stop ends it */
class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

/** the process each tracking run left running, released by the test */
const held: ((code: number | null) => void)[] = [];

/** a harness whose result comes at once while its process stays alive */
class TrackingDriver implements RunDriver {
  readonly label = "Claude Code";
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    let release: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((r) => (release = r));
    held.push(release);
    const proc = ctx.track?.({ stdin: { write: () => true, end: () => undefined }, stdout: new ReadableStream(), exited, kill: () => release(null) });
    void proc?.exited.then((code) => ctx.exited({ code, stderr: "" }));
    ctx.result({ text: "done", durationMs: 1, turns: 1 }, null);
  }
  say(): void {}
  stop(): void {
    for (const r of held) r(null);
  }
}

let scratch = "";
let root = "";
let previous: string | undefined;
let server: { port: number; stop: () => void } | null = null;
const url = (p: string) => `http://127.0.0.1:${server?.port ?? 0}${p}`;
const stages = async () => (await (await fetch(url("/api/incubator/stages"))).json()) as IncubatorStages;
const sprouts = async () => (await (await fetch(url("/api/incubator"))).json()) as Sprout[];
const postJson = (path: string, body: unknown) =>
  fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const intake = (text: string) => {
  const f = new FormData();
  f.append("text", text);
  return fetch(url("/api/incubator"), { method: "POST", body: f });
};

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** every event the server sends until `stop` is called */
function listen(): { events: ServerEvent[]; stop: () => void; ready: Promise<void> } {
  const events: ServerEvent[] = [];
  const ctl = new AbortController();
  const ready = (async () => {
    const res = await fetch(url("/api/events"), { signal: ctl.signal });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no stream");
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value);
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const chunk of parts) {
            const data = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)) as ServerEvent);
          }
        }
      } catch {
        // aborted
      }
    })();
  })();
  return { events, stop: () => ctl.abort(), ready };
}

/** a fresh config folder and launch root for one server */
async function fresh(): Promise<void> {
  // the realpath, since a Mac's tmpdir sits behind /var -> /private/var; short, for the socket
  scratch = await realpath(await mkdtemp(join(tmpdir(), "cst-")));
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  await mkdir(join(scratch, "config"), { recursive: true });
  root = join(scratch, "root");
  await mkdir(join(root, "_incubator"), { recursive: true });
}

async function done(): Promise<void> {
  server?.stop();
  server = null;
  await rm(scratch, { recursive: true, force: true });
}

beforeAll(() => {
  previous = process.env["CANOPY_CONFIG_DIR"];
});
afterAll(() => {
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
});

describe("with no stage runner and no unisolated switch", () => {
  beforeAll(async () => {
    await fresh();
    await mkdir(join(scratch, "config", "workflows"), { recursive: true });
    await writeFile(join(scratch, "config", "workflows", "held.md"), "---\nname: held\nblurb: b\n---\n\n## Do\n\nDo it.\n");
    await writeFile(join(scratch, "config", "workflows", "checkonly.md"), "---\nname: checkonly\nblurb: b\n---\n\n## Test\ncheck: true\n");
    server = await startServer({
      root,
      port: 0,
      chan: null,
      harnesses: ["claude"],
      incubator: { autostart: true, transcribe: null, notes: null, ship: null, stage: null, unisolated: false },
      runner: { driver: (h) => new HoldingDriver(h) },
    });
  });
  afterAll(done);

  test("stages are not isolated, a new idea stays queued, and the reason is in the API", async () => {
    expect(await stages()).toMatchObject({ isolated: false, mode: "off" });
    const res = await intake("a coin counter");
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    await until(async () => (await stages()).waiting === NO_RUNNER, "the reason");
    const now = (await sprouts()).find((x) => x.id === s.id);
    expect(now?.status).toBe("queued");
    expect(now?.flows).toEqual([]);
    expect((await (await fetch(url("/api/flows"))).json()) as Flow[]).toEqual([]);
  });

  test("a run started on a seed by hand is refused rather than run here", async () => {
    await until(async () => (await sprouts()).some((s) => s.prepared), "the seed");
    const s = (await sprouts())[0];
    const res = await postJson(`/api/repos/run?id=${encodeURIComponent(s?.repoId ?? "")}`, { action: "ask", note: "hi" });
    expect(res.status).toBe(503);
    // no runner is set up here, so the answer names the env, not a runner to wait for
    expect(((await res.json()) as { error: string }).error).toBe(NO_RUNNER);
  });

  test("a flow on a seed parks with the env words, at a step's start and at a check alike", async () => {
    const s = (await sprouts())[0];
    const id = encodeURIComponent(s?.repoId ?? "");
    const flowOf = async (fid: string) => ((await (await fetch(url("/api/flows"))).json()) as Flow[]).find((f) => f.id === fid);
    for (const workflow of ["checkonly", "held"]) {
      const res = await postJson(`/api/repos/flow?id=${id}`, { workflow, note: "" });
      expect(res.status).toBe(201);
      const flow = (await res.json()) as Flow;
      await until(async () => (await flowOf(flow.id))?.parkedFor === "stage", `${workflow} to park`);
      expect((await flowOf(flow.id))?.steps[0]?.reason).toBe(NO_RUNNER);
      await postJson("/api/flows/stop", { id: flow.id });
      await until(async () => (await flowOf(flow.id))?.status === "stopped", `${workflow} to stop`);
    }
  });
});

describe("through a stage runner that comes and goes", () => {
  let sock = "";
  let stopRunner: (() => Promise<void>) | null = null;
  const startRunner = async () => {
    const { stop } = await startStageRunner({
      socket: sock,
      root: join(root, "_incubator"),
      env: { PATH: process.env["PATH"], HOME: scratch },
      programs: { claude: "/usr/bin/true", codex: "/nonexistent/codex" },
    });
    stopRunner = stop;
  };
  beforeAll(async () => {
    await fresh();
    sock = join(scratch, "s.sock");
    server = await startServer({
      root,
      port: 0,
      chan: null,
      harnesses: ["claude"],
      incubator: { autostart: true, transcribe: null, notes: null, ship: null, stage: new StageClient(sock), stageEvery: 50 },
      runner: { driver: (h) => new HoldingDriver(h) },
    });
  });
  afterAll(async () => {
    await stopRunner?.();
    await done();
  });

  test("a queued idea waits while the runner is away and starts on its own when it answers", async () => {
    expect(await stages()).toEqual({ isolated: false, mode: "runner", waiting: null });
    const res = await intake("a tip jar");
    const s = (await res.json()) as Sprout;
    await until(async () => (await stages()).waiting === "the stage runner is not answering", "the runner's absence");
    expect((await sprouts()).find((x) => x.id === s.id)?.status).toBe("queued");
    const heard = listen();
    await heard.ready;
    await startRunner();
    await until(async () => (await sprouts()).find((x) => x.id === s.id)?.status === "clarifying", "clarify to start");
    expect(await stages()).toEqual({ isolated: true, mode: "runner", waiting: null });
    await until(() => heard.events.some((e) => e.type === "stages" && e.stages.isolated && e.stages.waiting === null), "the stages event");
    // the runner going away is said too, with nothing queued behind it
    await stopRunner?.();
    stopRunner = null;
    await until(() => heard.events.some((e) => e.type === "stages" && !e.stages.isolated), "the runner's going");
    heard.stop();
    expect((await stages()).isolated).toBe(false);
  }, 30_000);
});

describe("a runner that blinks between two beats", () => {
  let sock = "";
  let client: StageClient;
  let stopRunner: (() => Promise<void>) | null = null;
  const startRunner = async () => {
    const { stop } = await startStageRunner({
      socket: sock,
      root: join(root, "_incubator"),
      env: { PATH: process.env["PATH"], HOME: scratch },
      programs: { claude: "/usr/bin/true", codex: "/nonexistent/codex" },
    });
    stopRunner = stop;
  };
  beforeAll(async () => {
    await fresh();
    sock = join(scratch, "s.sock");
    // a seed of its own, for a flow started by hand
    const coin = join(root, "_incubator", "coin");
    await Bun.$`mkdir -p ${coin} && git -C ${coin} init -q -b main`.quiet();
    await Bun.write(join(coin, "a.txt"), "a\n");
    await Bun.$`git -C ${coin} add a.txt && git -C ${coin} -c user.name=a -c user.email=a@b commit -qm one`.quiet();
    await mkdir(join(scratch, "config", "workflows"), { recursive: true });
    await writeFile(join(scratch, "config", "workflows", "held.md"), "---\nname: held\nblurb: b\n---\n\n## Do\n\nDo it.\n");
    await startRunner();
    client = new StageClient(sock);
    server = await startServer({
      root,
      port: 0,
      chan: null,
      harnesses: ["claude"],
      // beats far apart, so the outage falls between two of them
      incubator: { autostart: true, transcribe: null, notes: null, ship: null, stage: client, stageEvery: 4000 },
      runner: { driver: (h) => new HoldingDriver(h) },
    });
  });
  afterAll(async () => {
    await stopRunner?.();
    await done();
  });

  test("a hello a run made while the runner was away holds the queue, and the next beat that finds it back starts it", async () => {
    await until(async () => (await stages()).isolated, "the runner");
    await stopRunner?.();
    stopRunner = null;
    // a run's or a check's hello finds it gone, between two beats
    expect(await client.hello()).toBe(null);
    const s = (await (await intake("a tally")).json()) as Sprout;
    await until(async () => (await stages()).waiting === "the stage runner is not answering", "the hold");
    expect((await sprouts()).find((x) => x.id === s.id)?.status).toBe("queued");
    await startRunner();
    await until(async () => (await sprouts()).find((x) => x.id === s.id)?.status === "clarifying", "clarify to start", 8000);
    expect((await stages()).waiting).toBe(null);
  }, 30_000);

  test("a flow parked for the runner runs its step again on the next good hello, on its own", async () => {
    await stopRunner?.();
    stopRunner = null;
    expect(await client.hello()).toBe(null);
    const res = await postJson(`/api/repos/flow?id=${encodeURIComponent("_incubator/coin")}`, { workflow: "held", note: "" });
    expect(res.status).toBe(201);
    const flow = (await res.json()) as Flow;
    const now = async () => ((await (await fetch(url("/api/flows"))).json()) as Flow[]).find((f) => f.id === flow.id);
    await until(async () => (await now())?.parkedFor === "stage", "the park");
    expect((await now())?.status).toBe("gated");
    await startRunner();
    await until(async () => (await now())?.steps[0]?.status === "running", "the step to run again", 8000);
    expect((await now())?.parkedFor).toBeUndefined();
  }, 30_000);
});

describe("a stage process alive after its run ended", () => {
  const seed = () => join(root, "_incubator", "coin");
  beforeAll(async () => {
    await fresh();
    await Bun.$`mkdir -p ${seed()} && git -C ${seed()} init -q -b main`.quiet();
    await Bun.write(join(seed(), "a.txt"), "a\n");
    await Bun.$`git -C ${seed()} add a.txt && git -C ${seed()} -c user.name=a -c user.email=a@b commit -qm one`.quiet();
    await mkdir(join(scratch, "config", "workflows"), { recursive: true });
    await writeFile(join(scratch, "config", "workflows", "held.md"), "---\nname: held\nblurb: b\nexpects-change: true\n---\n\n## Do\n\nDo it.\n");
    server = await startServer({
      root,
      port: 0,
      chan: null,
      harnesses: ["claude"],
      incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null, unisolated: true },
      runner: { driver: (h) => new TrackingDriver(h) },
    });
  });
  afterAll(done);

  test("the stages say they run here, unisolated", async () => {
    expect(await stages()).toEqual({ isolated: false, mode: "unisolated", waiting: null });
  });

  test("keeps the seed busy once the run is done, until the process is gone", async () => {
    const res = await postJson(`/api/repos/run?id=${encodeURIComponent("_incubator/coin")}`, { action: "ask", note: "hi" });
    expect(res.status).toBe(201);
    const run = (await res.json()) as Run;
    await until(async () => ((await (await fetch(url("/api/runs"))).json()) as Run[]).some((r) => r.id === run.id && r.status === "done"), "the run's end");
    expect(seedBusy(seed())).toBe(true);
    for (const r of held.splice(0)) r(0);
    await until(() => !seedBusy(seed()), "the seed to be quiet");
    await fetch(url(`/api/runs?id=${run.id}`), { method: "DELETE" });
  });

  test("a flow's end reads the seed's status only once the process is gone", async () => {
    const res = await postJson(`/api/repos/flow?id=${encodeURIComponent("_incubator/coin")}`, { workflow: "held", note: "" });
    expect(res.status).toBe(201);
    const flow = (await res.json()) as Flow;
    const now = async () => ((await (await fetch(url("/api/flows"))).json()) as Flow[]).find((f) => f.id === flow.id);
    await until(async () => (await now())?.status === "done", "the flow's end");
    await Bun.sleep(300);
    expect((await now())?.outcome).toBeUndefined();
    for (const r of held.splice(0)) r(0);
    await until(async () => (await now())?.outcome !== undefined, "the outcome once quiet");
    expect((await now())?.outcome).toBe("unchanged");
  });
});

/** a committed repo at `path` with one clean file */
async function repoAt(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path} && git -C ${path} init -q -b main`.quiet();
  await Bun.write(join(path, "a.txt"), "a\n");
  await Bun.$`git -C ${path} add a.txt && git -C ${path} -c user.name=a -c user.email=a@b commit -qm one`.quiet();
}
const dirtyFiles = async (id: string): Promise<number> =>
  ((await (await fetch(url("/api/tree"))).json()) as ScanResult).repos.find((r) => r.id === id)?.status?.files.length ?? -1;

describe("a stage alive in one seed", () => {
  const alpha = () => join(root, "_incubator", "alpha");
  beforeAll(async () => {
    await fresh();
    await repoAt(alpha());
    await repoAt(join(root, "_incubator", "beta"));
    server = await startServer({
      root,
      port: 0,
      chan: null,
      harnesses: ["claude"],
      incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null, unisolated: true },
      runner: { driver: (h) => new HoldingDriver(h) },
    });
  });
  afterAll(done);

  test("holds every seed busy: another seed's status read waits for it, and comes once it ends", async () => {
    expect(await dirtyFiles("_incubator/alpha")).toBe(0);
    const res = await postJson(`/api/repos/run?id=${encodeURIComponent("_incubator/beta")}`, { action: "ask", note: "hi" });
    expect(res.status).toBe(201);
    const run = (await res.json()) as Run;
    // a stage can write every seed, so canopy runs git in none of them
    expect(seedBusy(alpha())).toBe(true);
    expect((await git(alpha(), ["status", "--porcelain"])).stderr).toBe(SEED_BUSY);
    await appendFile(join(alpha(), "a.txt"), "moved\n");
    // past the watcher's debounce and a retry: nothing was read in alpha
    await Bun.sleep(1500);
    expect(await dirtyFiles("_incubator/alpha")).toBe(0);
    await postJson("/api/runs/stop", { id: run.id });
    await until(async () => (await dirtyFiles("_incubator/alpha")) === 1, "alpha's read once beta's run is over");
    expect(seedBusy(alpha())).toBe(false);
  }, 20_000);
});

/** a stage runner that answers at once and calls a seed busy until told */
class LingeringClient extends StageClient {
  lingering = true;
  asked = 0;
  constructor() {
    super("/nonexistent/stage.sock");
  }
  override async hello(): Promise<string[] | null> {
    return ["claude"];
  }
  override harnessesNow(): string[] | null {
    return ["claude"];
  }
  override async exec(): Promise<ExecResult> {
    return { code: 0, stdout: "ok", stderr: "" };
  }
  override async busy(): Promise<boolean | null> {
    this.asked += 1;
    return this.lingering;
  }
}

describe("a check through the stage runner", () => {
  const seed = () => join(root, "_incubator", "coin");
  const client = new LingeringClient();
  beforeAll(async () => {
    await fresh();
    await repoAt(seed());
    await mkdir(join(scratch, "config", "workflows"), { recursive: true });
    await writeFile(join(scratch, "config", "workflows", "checkonly.md"), "---\nname: checkonly\nblurb: b\n---\n\n## Test\ncheck: true\n");
    server = await startServer({
      root,
      port: 0,
      chan: null,
      harnesses: ["claude"],
      incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: client },
      runner: { driver: (h) => new HoldingDriver(h), quietWait: 200 },
    });
  });
  afterAll(done);

  test("is over only once the runner calls the seed quiet: the seeds stay busy until it does", async () => {
    const res = await postJson(`/api/repos/flow?id=${encodeURIComponent("_incubator/coin")}`, { workflow: "checkonly", note: "" });
    expect(res.status).toBe(201);
    const flow = (await res.json()) as Flow;
    const now = async () => ((await (await fetch(url("/api/flows"))).json()) as Flow[]).find((f) => f.id === flow.id);
    await until(async () => (await now())?.status === "done", "the check to pass");
    // the runner still says something runs there
    expect(client.asked).toBeGreaterThan(0);
    expect(seedBusy(seed())).toBe(true);
    await Bun.sleep(500);
    expect(seedBusy(seed())).toBe(true);
    client.lingering = false;
    await until(() => !seedBusy(seed()), "the seed to go quiet");
  }, 20_000);
});
