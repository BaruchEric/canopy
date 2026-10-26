import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CAPACITY, HIT_GRACE, type CapacitySettings } from "../core/capacity";
import type { CostEntry } from "../core/costs";
import type { CapacityInfo, Harness, Run, ServerEvent } from "../core/types";
import { CapacityHub } from "./capacity";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-capacity-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let hubs: CapacityHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  hubs = [];
});

const NOW = Date.UTC(2026, 9, 26, 12);
const AT_3PM = Date.UTC(2026, 9, 26, 15);
const LIMIT = "You've hit your limit · resets 3pm";
const H = 60 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const limited = (over: Partial<Run> = {}): Run => ({ id: "r1", repoId: "a", action: "ask", verb: "ask", progress: "", expectsChange: false, chat: false, harness: "claude", note: "", status: "limited", startedAt: NOW, steps: [], prompt: null, error: LIMIT, limited: { at: NOW, text: LIMIT }, ...over });
const row = (at: number, usd: number | null, service: CostEntry["service"] = "claude"): CostEntry => ({ at, service, provider: "anthropic", model: null, repo: null, repoName: null, run: null, label: null, session: null, usd, tokens: null, seconds: null });

function hub(opts: { file?: string; rows?: CostEntry[]; reader?: (harness: Harness) => Promise<unknown>; now?: number; settings?: Partial<CapacitySettings>; timings?: { every: number; idle: number } } = {}) {
  const events: CapacityInfo[] = [];
  const now = opts.now ?? NOW;
  const instance = new CapacityHub({
    broadcast: (event: ServerEvent) => {
      if (event.type === "capacity") events.push(event.capacity);
    },
    ledger: async () => opts.rows ?? [],
    config: async () => ({ capacity: { ...DEFAULT_CAPACITY, ...opts.settings } }),
    file: opts.file ?? join(dir, `${crypto.randomUUID()}.json`),
    reader: opts.reader ?? null,
    now: () => now,
    debounce: 5,
    timings: opts.timings ?? { every: 20, idle: 10_000 },
  });
  hubs.push(instance);
  return { h: instance, events };
}

test("a limited run becomes its harness's hit, the event goes out once, and the file keeps it at 0600", async () => {
  const file = join(dir, "hit.json");
  const { h, events } = hub({ file });
  await h.start();
  const before = events.length;
  h.onRun(limited());
  h.onRun(limited());
  await sleep(30);
  expect(h.get("claude")).toMatchObject({ source: "observed", hit: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: LIMIT } });
  expect(h.get("codex").hit).toBeNull();
  expect(events.length).toBe(before + 1);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hits: { claude: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: LIMIT } } });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("a restart inside the window keeps the hit; one after the reset plus the grace drops it and rewrites the file", async () => {
  const file = join(dir, "restart.json");
  const a = hub({ file });
  await a.h.start();
  a.h.onRun(limited());
  await sleep(10);
  const b = hub({ file, now: AT_3PM });
  await b.h.start();
  expect(b.h.get("claude").hit?.text).toBe(LIMIT);
  const c = hub({ file, now: AT_3PM + HIT_GRACE });
  await c.h.start();
  expect(c.h.get("claude").hit).toBeNull();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hits: {} });
});

test("a persisted Codex hit keeps its observed source after restart", async () => {
  const file = join(dir, "codex-restart.json");
  const first = hub({ file });
  await first.h.start();
  first.h.onRun(limited({ id: "codex-run", harness: "codex" }));
  await sleep(10);
  first.h.stop();

  const restarted = hub({ file });
  await restarted.h.start();
  expect(restarted.h.get("codex")).toMatchObject({ source: "observed", hit: { text: LIMIT } });
});

test("a file that cannot be read, or names a harness canopy lacks, starts clean and is replaced by the next hit", async () => {
  const file = join(dir, "bad.json");
  await writeFile(file, "{nope");
  const { h } = hub({ file });
  await h.start();
  expect(h.list().map((capacity) => capacity.hit)).toEqual([null, null]);
  await writeFile(file, JSON.stringify({ hits: { gemini: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: "x" }, claude: { window: "fiveHour" } } }));
  const again = hub({ file });
  await again.h.start();
  expect(again.h.list().map((capacity) => capacity.hit)).toEqual([null, null]);
  again.h.onRun(limited());
  await sleep(10);
  expect(JSON.parse(await readFile(file, "utf8")).hits.claude.text).toBe(LIMIT);
});

test("the ledger: Claude dollars over the last five hours against the figure; no figure is no reading", async () => {
  const rows = [row(NOW - H, 2), row(NOW - 4 * H, 1), row(NOW - 2 * H, null), row(NOW - 6 * H, 5), row(NOW - H, 7, "codex")];
  const { h } = hub({ rows, settings: { observedFiveHourUsd: 10 } });
  await h.start();
  expect(h.get("claude")).toMatchObject({ fiveHour: { used: 0.3, resetsAt: null, readAt: NOW }, weekly: null, source: "observed" });
  expect(h.get("codex")).toMatchObject({ fiveHour: null, source: "unknown" });
  const none = hub({ rows });
  await none.h.start();
  expect(none.h.get("claude")).toMatchObject({ fiveHour: null, source: "unknown" });
});

test("a reader is asked at start, at every while a hit stands, at idle otherwise; the event only on change", async () => {
  let calls = 0;
  const reader = async () => {
    calls += 1;
    return { five_hour: { utilization: 32, resets_at: "2026-10-26T14:10:00Z" }, seven_day: { utilization: 61, resets_at: "2026-10-29T15:00:00Z" } };
  };
  const { h, events } = hub({ reader, timings: { every: 20, idle: 10_000 } });
  await h.start();
  expect(calls).toBe(2);
  expect(h.get("claude")).toMatchObject({ fiveHour: { used: 0.32, resetsAt: Date.UTC(2026, 9, 26, 14, 10), readAt: NOW }, weekly: { used: 0.61 }, source: "endpoint" });
  await sleep(80);
  expect(calls).toBe(2);
  const sent = events.length;
  h.onRun(limited());
  await sleep(120);
  expect(calls).toBeGreaterThanOrEqual(6);
  expect(h.get("claude").source).toBe("endpoint");
  expect(events.length).toBe(sent + 1);
});

test("GET /api/capacity answers the info with no held starts; other paths are not its", async () => {
  const { h } = hub({ settings: { lowHold: 0.6 } });
  await h.start();
  const url = new URL("http://x/api/capacity");
  const response = await h.handle(new Request(url.toString()), url);
  if (response === null) throw new Error("capacity route did not handle its path");
  expect(response.status).toBe(200);
  const info: unknown = await response.json();
  expect(info).toMatchObject({
    capacity: [{ harness: "claude" }, { harness: "codex" }],
    held: [],
    settings: { lowHold: 0.6 },
  });
  const otherUrl = new URL("http://x/api/health");
  expect(await h.handle(new Request(otherUrl.toString()), otherUrl)).toBeNull();
});
