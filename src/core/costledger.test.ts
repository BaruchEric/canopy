import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CostEntry } from "./costs";
import { RunCosts, appendCost, hostOf, loadPrices, monthFile, readCosts, servedRows, sessionSeen, sinceDays } from "./costledger";
import type { Run } from "./types";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-costs-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (at: number, over: Partial<CostEntry> = {}): CostEntry => ({
  at,
  service: "voice",
  provider: "elevenlabs",
  model: null,
  repo: "/r/api",
  repoName: "api",
  run: null,
  label: "voice call",
  session: null,
  usd: null,
  tokens: null,
  seconds: 60,
  ...over,
});

// bun test runs in UTC, so these months are UTC's
const sep30 = Date.UTC(2026, 8, 30, 12);
const oct2 = Date.UTC(2026, 9, 2, 12);

test("rows go to their month's file and come back oldest first from the window", async () => {
  const ledger = join(dir, "ledger");
  await appendCost(entry(oct2), ledger);
  await appendCost(entry(sep30), ledger);
  expect(monthFile(sep30)).toBe("2026-09.jsonl");
  expect((await readCosts(sep30, ledger)).map((e) => e.at)).toEqual([sep30, oct2]);
  expect((await readCosts(Date.UTC(2026, 9, 1), ledger)).map((e) => e.at)).toEqual([oct2]);
  expect(await readCosts(0, join(dir, "none"))).toEqual([]);
});

test("a line that does not parse is skipped", async () => {
  const ledger = join(dir, "torn");
  await appendCost(entry(oct2), ledger);
  await writeFile(join(ledger, "2026-10.jsonl"), `${JSON.stringify(entry(oct2))}\n{"at": 1, "serv`, { flag: "a" });
  expect(await readCosts(0, ledger)).toHaveLength(2);
});

test("the price list: none is null, a broken one empty", async () => {
  expect(await loadPrices(join(dir, "missing.json"))).toBeNull();
  await writeFile(join(dir, "broken.json"), "{ nope");
  expect(await loadPrices(join(dir, "broken.json"))).toEqual({});
  await writeFile(join(dir, "prices.json"), JSON.stringify({ "elevenlabs/*": { perMinute: 0.1 } }));
  const prices = await loadPrices(join(dir, "prices.json"));
  const [row] = servedRows([entry(oct2)], prices, (p) => (p === "/r/api" ? "dev/api" : null));
  expect(row?.repoId).toBe("dev/api");
  expect(row?.estUsd).toBeCloseTo(0.1);
});

test("RunCosts writes one row per reply that spent something, with the repo's path", async () => {
  const rows: CostEntry[] = [];
  const costs = new RunCosts(
    (e) => rows.push(e),
    (id) => (id === "api" ? { path: "/r/api", name: "api" } : null),
  );
  const run = { id: "r1", repoId: "api", harness: "claude", verb: "chat", chat: true, session: "s1" } as Run;
  costs.onRun(run);
  costs.onRun({ ...run, result: { text: "", durationMs: 1, turns: 1, costUsd: 0.01, model: "claude-opus-5-5" } });
  costs.onRun({ ...run, result: { text: "", durationMs: 1, turns: 1, costUsd: 0.01 } });
  costs.onRun({ ...run, result: { text: "", durationMs: 1, turns: 2, costUsd: 0.03 } });
  await costs.settled();
  expect(rows.map((r) => [r.usd, r.repo, r.session, r.model])).toEqual([
    [0.01, "/r/api", "s1", "claude-opus-5-5"],
    [expect.closeTo(0.02), "/r/api", "s1", null],
  ]);
  expect(rows[0]).toMatchObject({ service: "claude", provider: "anthropic", run: "r1", label: "chat" });
});

test("accounting rows keep the resolved route and prefer reported Codex provider and model", async () => {
  const rows: CostEntry[] = [];
  const costs = new RunCosts((e) => rows.push(e), () => ({ path: "/r/api", name: "api" }));
  const selected = {
    id: "r-provider",
    repoId: "api",
    harness: "codex",
    verb: "review",
    action: "flow",
    flowStep: { workflow: "release", step: "review", source: "user" },
    agentSettings: { harness: "codex", model: "gpt-selected", effort: "high", provider: "team_selected" },
  } as Run;
  costs.onRun({
    ...selected,
    result: {
      text: "done",
      durationMs: 1,
      turns: 1,
      model: "gpt-reported",
      provider: "team_actual",
      tokens: { input: 100, cachedInput: 20, output: 10, reasoning: 2, total: 110 },
    },
  });
  const fallback = {
    ...selected,
    id: "r-fallback",
    agentSettings: { harness: "codex", model: "gpt-selected", effort: "medium", provider: "team_fallback" },
    result: { text: "done", durationMs: 1, turns: 1, tokens: { input: 10, cachedInput: 0, output: 1, reasoning: 0, total: 11 } },
  } as Run;
  costs.onRun(fallback);
  await costs.settled();
  expect(rows[0]).toMatchObject({
    service: "codex",
    provider: "team_actual",
    model: "gpt-reported",
    agentSettings: selected.agentSettings,
    action: "flow",
    flowStep: { workflow: "release", step: "review" },
    tokens: { total: 110 },
  });
  expect(rows[1]).toMatchObject({ service: "codex", provider: "team_fallback", model: "gpt-selected", tokens: { total: 11 } });
});

test("Claude rows retain both reported dollars and tokens", async () => {
  const rows: CostEntry[] = [];
  const costs = new RunCosts((e) => rows.push(e), () => null);
  const run = { id: "r-claude-usage", repoId: "api", harness: "claude", verb: "chat", chat: true, session: "s-usage" } as Run;
  costs.onRun({
    ...run,
    result: {
      text: "done",
      durationMs: 1,
      turns: 1,
      costUsd: 0.02,
      model: "claude-sonnet-5",
      provider: "anthropic",
      tokens: { input: 200, cachedInput: 100, output: 50, reasoning: 0, total: 250 },
    },
  });
  await costs.settled();
  expect(rows[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", usd: 0.02, tokens: { total: 250 } });
});

test("a resumed session starts from its spend so far: in memory, or from the ledger after a restart", async () => {
  const rows: CostEntry[] = [];
  const write = (e: CostEntry) => rows.push(e);
  const repoOf = () => null;
  const result = (costUsd: number) => ({ text: "", durationMs: 1, turns: 1, costUsd });
  const first = { id: "r1", repoId: "api", harness: "claude", verb: "chat", chat: true, session: "s9" } as Run;
  const costs = new RunCosts(write, repoOf);
  costs.onRun({ ...first, result: result(0.2) });
  // a later run resumes the session, and Claude counts on from 0.2
  costs.onRun({ ...first, id: "r2", result: result(0.5) });
  await costs.settled();
  expect(rows.map((r) => [r.run, r.usd])).toEqual([
    ["r1", 0.2],
    ["r2", expect.closeTo(0.3)],
  ]);
  // a fresh canopy knows the session only from the ledger
  const ledger = [...rows];
  const fresh = new RunCosts(write, repoOf, async (s) => sessionSeen(ledger, s));
  fresh.onRun({ ...first, id: "r3", result: result(0.9) });
  await fresh.settled();
  expect(rows.at(-1)).toMatchObject({ run: "r3", usd: expect.closeTo(0.4) });
  expect(sessionSeen(ledger, "nope")).toBeNull();
});

test("sinceDays is local midnight, and hostOf names a speech server", () => {
  expect(sinceDays(1, Date.UTC(2026, 9, 20, 15))).toBe(Date.UTC(2026, 9, 20));
  expect(sinceDays(7, Date.UTC(2026, 9, 20, 15))).toBe(Date.UTC(2026, 9, 14));
  expect(hostOf("http://100.68.139.95:4000")).toBe("100.68.139.95");
  expect(hostOf("not a url")).toBe("speech");
});
