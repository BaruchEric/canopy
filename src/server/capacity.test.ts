import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CAPACITY, HIT_GRACE, type CapacitySettings } from "../core/capacity";
import type { CostEntry } from "../core/costs";
import { HARNESSES, type CapacityInfo, type Harness, type HeldStart, type Run, type ServerEvent } from "../core/types";
import { CapacityHub, type CapacityHubDeps } from "./capacity";

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
const THU_3PM = Date.UTC(2026, 9, 29, 15);
const row = (at: number, usd: number | null, service: CostEntry["service"] = "claude"): CostEntry => ({ at, service, provider: "anthropic", model: null, repo: null, repoName: null, run: null, label: null, session: null, usd, tokens: null, seconds: null });

function hub(opts: { file?: string; rows?: CostEntry[]; reader?: (harness: Harness) => Promise<unknown>; now?: number; settings?: Partial<CapacitySettings>; timings?: { every: number; idle: number }; extra?: Partial<CapacityHubDeps> } = {}) {
  const events: CapacityInfo[] = [];
  const now = opts.now ?? NOW;
  const instance = new CapacityHub({
    ...opts.extra,
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
    ...(opts.extra?.config ? { config: opts.extra.config } : {}),
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
  expect(h.list().map((capacity) => capacity.hit)).toEqual(HARNESSES.map(() => null));
  await writeFile(file, JSON.stringify({ hits: { gemini: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: "x" }, claude: { window: "fiveHour" } } }));
  const again = hub({ file });
  await again.h.start();
  expect(again.h.list().map((capacity) => capacity.hit)).toEqual(HARNESSES.map(() => null));
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
  expect(calls).toBe(HARNESSES.length);
  expect(h.get("claude")).toMatchObject({ fiveHour: { used: 0.32, resetsAt: Date.UTC(2026, 9, 26, 14, 10), readAt: NOW }, weekly: { used: 0.61 }, source: "endpoint" });
  await sleep(80);
  expect(calls).toBe(HARNESSES.length);
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
    capacity: HARNESSES.map((harness) => ({ harness })),
    held: [],
    settings: { lowHold: 0.6 },
  });
  const otherUrl = new URL("http://x/api/health");
  expect(await h.handle(new Request(otherUrl.toString()), otherUrl)).toBeNull();
});

const post = (h: CapacityHub, path: string, body?: unknown) =>
  h.handle(new Request(`http://x${path}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://x${path}`));

test("may: the governor on this harness's reading; interactive goes through a hit (plan 2)", async () => {
  const { h } = hub();
  await h.start();
  expect(h.may("claude", "low")).toBe("go");
  h.onRun(limited());
  expect(h.may("claude", "low")).toMatchObject({ hold: "hit", until: AT_3PM + HIT_GRACE });
  expect(h.may("claude", "normal")).toMatchObject({ hold: "hit" });
  expect(h.may("claude", "interactive")).toBe("go");
  expect(h.may("codex", "low")).toBe("go");
});

test("a limited mark with the CLI's exact reset holds until that reset, not the text's", async () => {
  const { h } = hub();
  await h.start();
  const exact = Date.UTC(2026, 9, 26, 13, 40);
  h.onRun(limited({ limited: { at: NOW, text: LIMIT, resetsAt: exact, window: "fiveHour" } }));
  expect(h.get("claude").hit).toEqual({ window: "fiveHour", at: NOW, resetsAt: exact, text: LIMIT });
});

test("the held starts come from their owners; a held-list change alone sends the event and never wakes the pumps", async () => {
  let held: HeldStart[] = [];
  let woke = 0;
  const { h, events } = hub({ extra: { held: () => held, wake: () => { woke += 1; } } });
  await h.start();
  await sleep(20);
  const wokeAtStart = woke;
  const sent = events.length;
  held = [{ id: "trigger:e1", what: "fix the crash", repoId: "a", priority: "low", why: "waiting for capacity: the 5-hour window is spent (resets 15:00)", since: NOW }];
  h.touch();
  await sleep(20);
  expect(events.length).toBe(sent + 1);
  expect(events.at(-1)?.held.map((x) => x.id)).toEqual(["trigger:e1"]);
  expect(woke).toBe(wokeAtStart);
  h.onRun(limited());
  await sleep(20);
  expect(woke).toBe(wokeAtStart + 1);
});

test("POST /api/capacity patches the settings through the config; a bad value is a 400", async () => {
  let saved: CapacitySettings = { ...DEFAULT_CAPACITY };
  const { h } = hub({ extra: { saveSettings: async (next) => { saved = next; }, config: async () => ({ capacity: saved }) } });
  await h.start();
  const res = await post(h, "/api/capacity", { lowHold: 0.5, observedFiveHourUsd: 40 });
  expect(res?.status).toBe(200);
  expect(((await res!.json()) as CapacityInfo).settings).toEqual({ ...DEFAULT_CAPACITY, lowHold: 0.5, observedFiveHourUsd: 40 });
  expect(saved.lowHold).toBe(0.5);
  const bad = await post(h, "/api/capacity", { normalHold: 3 });
  expect([bad?.status, ((await bad!.json()) as { error: string }).error]).toEqual([400, "normalHold must be above 0 and at most 1"]);
  expect(h.info().settings.normalHold).toBe(DEFAULT_CAPACITY.normalHold);
});

test("POST /api/capacity/read refreshes; release starts a held start and refuses one not held", async () => {
  let reads = 0;
  const released: string[] = [];
  const { h } = hub({
    reader: async () => { reads += 1; return {}; },
    extra: {
      held: () => [{ id: "flow:f1", what: "review", repoId: "a", priority: "normal", why: "waiting", since: NOW }],
      release: async (id) => { released.push(id); },
    },
  });
  await h.start();
  const before = reads;
  expect((await post(h, "/api/capacity/read"))?.status).toBe(200);
  expect(reads).toBe(before + HARNESSES.length);
  expect((await post(h, "/api/capacity/release", { id: "flow:f1" }))?.status).toBe(200);
  expect(released).toEqual(["flow:f1"]);
  expect((await post(h, "/api/capacity/release", { id: "flow:nope" }))?.status).toBe(404);
  expect((await post(h, "/api/capacity/release", {}))?.status).toBe(400);
});

test("a release the owner refuses answers 409 with its words", async () => {
  const { h } = hub({
    extra: {
      held: () => [{ id: "pr:b1", what: "fix PR #3", repoId: "a", priority: "normal", why: "waiting", since: NOW }],
      release: async () => { throw new Error("the PR is closed"); },
    },
  });
  await h.start();
  const res = await post(h, "/api/capacity/release", { id: "pr:b1" });
  expect([res?.status, ((await res!.json()) as { error: string }).error]).toEqual([409, "the PR is closed"]);
});

/* ---------- the harness's own count, heard on a run's stream ---------- */

test("a harness's count is the reading with no endpoint and no figure: the event goes out and the file keeps it", async () => {
  const file = join(dir, "heard.json");
  const { h, events } = hub({ file });
  await h.start();
  expect(h.list().map((c) => c.source)).toEqual(HARNESSES.map(() => "unknown"));
  const before = events.length;
  h.onHeard("claude", { weekly: { used: 0.56, resetsAt: THU_3PM } });
  h.onHeard("codex", { weekly: { used: 0.03, resetsAt: THU_3PM } });
  await sleep(30);
  expect(h.get("claude")).toEqual({ harness: "claude", fiveHour: null, weekly: { used: 0.56, resetsAt: THU_3PM, readAt: NOW }, source: "run", hit: null });
  expect(h.get("codex")).toMatchObject({ weekly: { used: 0.03 }, source: "run" });
  expect(events.length).toBe(before + 1);
  expect(events.at(-1)?.capacity.map((c) => c.source)).toEqual(["run", "run", "unknown"]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    hits: {},
    windows: {
      claude: { fiveHour: null, weekly: { used: 0.56, resetsAt: THU_3PM, readAt: NOW } },
      codex: { fiveHour: null, weekly: { used: 0.03, resetsAt: THU_3PM, readAt: NOW } },
    },
  });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("a restart keeps a run's reading until its reset, over the ledger's estimate; one after the reset drops it from the file", async () => {
  const file = join(dir, "heard-restart.json");
  const a = hub({ file });
  await a.h.start();
  a.h.onHeard("claude", { fiveHour: { used: 0.2, resetsAt: AT_3PM }, weekly: { used: 0.56, resetsAt: THU_3PM } });
  await sleep(10);
  a.h.stop();
  // a figure is set, and the count still leads
  const b = hub({ file, now: AT_3PM - 1, rows: [row(AT_3PM - H, 30)], settings: { observedFiveHourUsd: 40 } });
  await b.h.start();
  expect(b.h.get("claude")).toMatchObject({ fiveHour: { used: 0.2, readAt: NOW }, weekly: { used: 0.56 }, source: "run" });
  b.h.stop();
  // past the 5-hour reset the week's count stands alone
  const c = hub({ file, now: AT_3PM });
  await c.h.start();
  expect(c.h.get("claude")).toMatchObject({ fiveHour: null, weekly: { used: 0.56 }, source: "run" });
  expect(JSON.parse(await readFile(file, "utf8")).windows).toEqual({ claude: { fiveHour: null, weekly: { used: 0.56, resetsAt: THU_3PM, readAt: NOW } } });
  c.h.stop();
  // past the week's too there is no count, so the ledger's estimate is the reading again
  const d = hub({ file, now: THU_3PM, rows: [row(THU_3PM - H, 30)], settings: { observedFiveHourUsd: 40 } });
  await d.h.start();
  expect(d.h.get("claude")).toMatchObject({ fiveHour: { used: 0.75, resetsAt: null }, weekly: null, source: "observed" });
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hits: {} });
});

test("a hit and a run's reading live together, and both come back after a restart", async () => {
  const file = join(dir, "heard-hit.json");
  const a = hub({ file });
  await a.h.start();
  a.h.onHeard("claude", { fiveHour: { used: 1, resetsAt: AT_3PM } });
  a.h.onRun(limited());
  await sleep(10);
  expect(a.h.get("claude")).toMatchObject({ fiveHour: { used: 1 }, source: "run", hit: { text: LIMIT } });
  expect(a.h.may("claude", "normal")).toMatchObject({ hold: "hit" });
  a.h.stop();
  const b = hub({ file });
  await b.h.start();
  expect(b.h.get("claude")).toMatchObject({ fiveHour: { used: 1, resetsAt: AT_3PM }, source: "run", hit: { text: LIMIT } });
});

test("a run's window ends at its reset: the hub reads again then, the reading is gone and the pumps wake", async () => {
  let now = NOW;
  let woke = 0;
  const h = new CapacityHub({
    broadcast: () => {},
    ledger: async () => [],
    config: async () => ({ capacity: { ...DEFAULT_CAPACITY } }),
    file: join(dir, "heard-reset.json"),
    now: () => now,
    debounce: 5,
    timings: { every: 10_000, idle: 10_000 },
    wake: () => {
      woke += 1;
    },
  });
  hubs.push(h);
  await h.start();
  h.onHeard("claude", { fiveHour: { used: 0.95, resetsAt: NOW + 40 } });
  expect(h.may("claude", "normal")).toMatchObject({ hold: "window", until: NOW + 40 });
  expect(h.may("claude", "interactive")).toBe("go");
  await sleep(30);
  const before = woke;
  now = NOW + 41;
  // the governor needs no timer to see the reset
  expect(h.may("claude", "normal")).toBe("go");
  await sleep(400);
  expect(h.get("claude")).toMatchObject({ fiveHour: null, source: "unknown" });
  expect(woke).toBe(before + 1);
});

test("an endpoint reading is not replaced by a run's count, and a count that says nothing new sends no event", async () => {
  const reader = async () => ({ five_hour: { utilization: 32, resets_at: "2026-10-26T14:10:00Z" } });
  const wired = hub({ reader });
  await wired.h.start();
  wired.h.onHeard("claude", { fiveHour: { used: 0.9, resetsAt: AT_3PM } });
  expect(wired.h.get("claude")).toMatchObject({ fiveHour: { used: 0.32 }, source: "endpoint" });
  const { h, events } = hub();
  await h.start();
  h.onHeard("claude", {});
  h.onHeard("claude", { fiveHour: { used: 0.9, resetsAt: NOW - 1 } });
  await sleep(30);
  const sent = events.length;
  h.onHeard("claude", { fiveHour: { used: 0.4, resetsAt: AT_3PM } });
  await sleep(30);
  h.onHeard("claude", { fiveHour: { used: 0.4, resetsAt: AT_3PM } });
  await sleep(30);
  expect(events.length).toBe(sent + 1);
});

test("kept windows that are not windows are left out, and the rest of the file is still read", async () => {
  const file = join(dir, "heard-bad.json");
  await writeFile(file, JSON.stringify({
    hits: { claude: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: LIMIT } },
    windows: { claude: { fiveHour: { used: "lots", resetsAt: AT_3PM, readAt: NOW }, weekly: { used: 0.5, resetsAt: THU_3PM, readAt: NOW } }, codex: "nope", gemini: { weekly: { used: 0.5, resetsAt: THU_3PM, readAt: NOW } } },
  }));
  const { h } = hub({ file });
  await h.start();
  expect(h.get("claude")).toMatchObject({ fiveHour: null, weekly: { used: 0.5 }, source: "run", hit: { text: LIMIT } });
  expect(h.get("codex")).toMatchObject({ weekly: null, source: "unknown" });
});
