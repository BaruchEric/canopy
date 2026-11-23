/**
 * The capacity reading over the API, from a run through the fake Claude
 * CLI: the windows its rate_limit_event counted are what `GET
 * /api/capacity` answers, with no endpoint and no dollar figure, and
 * `capacity.json` keeps them. That a start reads the file back is
 * capacity.test.ts's: a test server never starts the hub's clock.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "../core/claudedrive";
import type { CapacityInfo, Run } from "../core/types";
import { capacityFile } from "./capacity";
import { startServer } from "./index";

const FAKE = join(import.meta.dir, "..", "core", "testdata", "fake-claude.ts");
const HOUR = 60 * 60_000;

let scratch: string;
let previousConfig: string | undefined;
let previousMode: string | undefined;
let server: { port: number; stop: () => void };

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const capacity = async (): Promise<CapacityInfo> => (await (await fetch(url("/api/capacity"))).json()) as CapacityInfo;
const claude = async () => (await capacity()).capacity.find((c) => c.harness === "claude");

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(30);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-heard-"));
  previousConfig = process.env["CANOPY_CONFIG_DIR"];
  previousMode = process.env["FAKE_CLAUDE_MODE"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["FAKE_CLAUDE_MODE"] = "counted";
  const root = join(scratch, "root");
  await mkdir(join(root, "proj"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: join(root, "proj") });
  server = await startServer({ root, port: 0, chan: null, harnesses: ["claude"], runner: { driver: () => new ClaudeDriver({ command: [process.execPath, FAKE] }) } });
});

afterAll(async () => {
  server.stop();
  if (previousConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previousConfig;
  if (previousMode === undefined) delete process.env["FAKE_CLAUDE_MODE"];
  else process.env["FAKE_CLAUDE_MODE"] = previousMode;
  await rm(scratch, { recursive: true, force: true });
});

test("a run's rate_limit_event is the backend's reading, and capacity.json keeps it", async () => {
  expect(await claude()).toMatchObject({ fiveHour: null, weekly: null, source: "unknown" });
  const started = Date.now();
  const start = await fetch(url("/api/repos/run?id=proj"), { method: "POST", body: JSON.stringify({ action: "ask", note: "how much is left" }) });
  expect(start.status).toBe(201);
  const { id } = (await start.json()) as Run;
  await until(async () => ((await (await fetch(url("/api/runs"))).json()) as Run[]).find((r) => r.id === id && r.status === "done"), "the run to end");
  const read = await until(async () => {
    const c = await claude();
    return c?.source === "run" ? c : null;
  }, "the reading");
  expect(read).toMatchObject({ fiveHour: { used: 0.62 }, weekly: { used: 0.4 }, hit: null });
  expect(read.fiveHour?.resetsAt).toBeGreaterThan(started + HOUR - 5_000);
  expect(read.fiveHour?.resetsAt).toBeLessThan(Date.now() + HOUR + 5_000);
  expect(read.weekly?.resetsAt).toBeGreaterThan(started + 71 * HOUR);
  const kept = await until(async () => {
    const file = JSON.parse(await readFile(capacityFile(), "utf8").catch(() => "{}")) as { windows?: { claude?: unknown } };
    return file.windows?.claude ?? null;
  }, "the kept count");
  expect(kept).toEqual({ fiveHour: read.fiveHour, weekly: read.weekly });
});
