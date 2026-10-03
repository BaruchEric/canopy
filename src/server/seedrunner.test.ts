/**
 * On an isolated backend canopy runs no git in a seed: every call goes to
 * the stage runner and runs there as the stage user. So a seed is busy only
 * while its own stage is. The live case (2026-10-03): one sprout's stage
 * was running, and the other's scout-to-build commit waited on it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { ExecResult } from "../core/exec";
import { git } from "../core/exec";
import type { Harness } from "../core/harness";
import { seedOps, writeSeed } from "../core/seed";
import { SEED_AWAY, seedBusy } from "../core/seedgit";
import { MIRRORS_DIR } from "../core/seedmirror";
import { StageClient } from "../core/stageclient";
import type { Run, ScanResult } from "../core/types";
import { startStageRunner } from "../stage/runner";
import { startServer } from "./index";

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

/** the runner's client, counting the git calls that reach it, by seed */
class CountingClient extends StageClient {
  readonly gits: string[] = [];
  override async git(seed: string, args: string[], opts: { timeoutMs: number; env?: Record<string, string> }): Promise<ExecResult & { away?: string }> {
    this.gits.push(seed);
    return super.git(seed, args, opts);
  }
}

let scratch = "";
let root = "";
let previous: string | undefined;
let server: { port: number; stop: () => void } | null = null;
let stopRunner: (() => Promise<void>) | null = null;
let client: CountingClient;
const url = (p: string) => `http://127.0.0.1:${server?.port ?? 0}${p}`;
const alpha = () => join(root, "_incubator", "alpha");
const beta = () => join(root, "_incubator", "beta");
const post = (path: string, body: unknown) =>
  fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function repoAt(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path} && git -C ${path} init -q -b main`.quiet();
  await Bun.write(join(path, "a.txt"), "a\n");
  await Bun.$`git -C ${path} add a.txt && git -C ${path} -c user.name=a -c user.email=a@b commit -qm one`.quiet();
}
const lastSubject = async (path: string): Promise<string> => (await Bun.$`git -C ${path} log -1 --format=%s`.quiet().text()).trim();
const within = <T>(p: Promise<T>, ms: number): Promise<T | "waiting"> => Promise.race([p, Bun.sleep(ms).then(() => "waiting" as const)]);
const dirtyFiles = async (id: string): Promise<number> =>
  ((await (await fetch(url("/api/tree"))).json()) as ScanResult).repos.find((r) => r.id === id)?.status?.files.length ?? -1;
async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-seedrunner-")));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await repoAt(alpha());
  await repoAt(beta());
  const socket = join(scratch, "s.sock");
  const runner = await startStageRunner({
    socket,
    root: join(root, "_incubator"),
    env: { PATH: process.env["PATH"], HOME: scratch, CANOPY_FENCE_PROBE: "http://probe.test/" },
    probe: async () => ({ result: "blocked" }),
    // the git on this Mac's PATH may sit in a folder its user owns
    writable: async () => false,
  });
  stopRunner = runner.stop;
  client = new CountingClient(socket);
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: client },
    runner: { driver: (h) => new HoldingDriver(h), quietWait: 200 },
  });
});

afterAll(async () => {
  server?.stop();
  await stopRunner?.();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("a stage alive in one seed, on an isolated backend", () => {
  test("holds that seed alone: the other's scout-to-build commit goes through at once, through the runner", async () => {
    const res = await post(`/api/repos/run?id=${encodeURIComponent("_incubator/beta")}`, { action: "ask", note: "hi" });
    expect(res.status).toBe(201);
    const run = (await res.json()) as Run;
    expect(seedBusy(beta())).toBe(true);
    expect(seedBusy(alpha())).toBe(false);

    // what Incubator.scouted() does once scout passes
    const seeds = seedOps("mini");
    await writeSeed(alpha(), ".canopy/pick.json", '{"kind":"new","host":"vercel","why":"x"}\n');
    client.gits.length = 0;
    expect(await within(seeds.commit(alpha(), [".canopy/pick.json"], "scout: alpha"), 3000)).toBeUndefined();
    expect(await lastSubject(alpha())).toBe("scout: alpha");
    // canopy ran none of it here
    expect(client.gits.length).toBeGreaterThan(0);
    expect(client.gits.every((s) => s === alpha())).toBe(true);

    // alpha's card reads at once
    await Bun.write(join(alpha(), "a.txt"), "moved\n");
    await until(async () => (await dirtyFiles("_incubator/alpha")) === 1, "alpha's fresh status");

    // beta's own commit still waits for beta's stage
    await writeSeed(beta(), ".canopy/pick.json", '{"kind":"new","host":"vercel","why":"y"}\n');
    const betaCommit = seeds.commit(beta(), [".canopy/pick.json"], "scout: beta");
    expect(await within(betaCommit, 600)).toBe("waiting");
    expect(await lastSubject(beta())).toBe("one");
    await post("/api/runs/stop", { id: run.id });
    await betaCommit;
    expect(await lastSubject(beta())).toBe("scout: beta");
  }, 20_000);

  test("a seed's mirror follows its run's outcome, made through the runner; a seed takes no peer action", async () => {
    const mirror = join(root, MIRRORS_DIR, "beta", ".git");
    const head = async (path: string): Promise<string> => (await Bun.$`git -C ${path} rev-parse HEAD`.quiet().text()).trim();
    await until(async () => (await Bun.$`git -C ${mirror} rev-parse HEAD`.quiet().nothrow().text()).trim() === (await head(beta())), "beta's mirror at beta's HEAD");
    expect(await lastSubject(mirror)).toBe("scout: beta");
    expect(client.gits).toContain(beta());
    const res = await post(`/api/repos/peer?id=${encodeURIComponent("_incubator/beta")}`, { action: "sync", peer: "mac" });
    expect(res.status).toBe(400);
  }, 20_000);

  test("a runner that cannot run git keeps the card's last status, and nothing runs here", async () => {
    const now = (await (await fetch(url("/api/tree"))).json()) as ScanResult;
    const was = now.repos.find((r) => r.id === "_incubator/alpha");
    expect(was?.status).toBeDefined();
    await stopRunner?.();
    stopRunner = null;
    const r = await git(alpha(), ["status", "--porcelain"]);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain(SEED_AWAY);
    expect((await fetch(url("/api/rescan"), { method: "POST" })).status).toBe(200);
    const after = ((await (await fetch(url("/api/tree"))).json()) as ScanResult).repos.find((x) => x.id === "_incubator/alpha");
    expect(after?.error).toBeUndefined();
    expect(after?.status?.branch).toBe("main");
  }, 20_000);
});
