import { describe, expect, test } from "bun:test";
import { estimate, parseCostLine, parsePrices, priceOf, runDelta, saneSeconds, type CostEntry } from "./costs";
import type { Run, RunResult } from "./types";

const run = (harness: "claude" | "codex", result?: Partial<RunResult>): Run =>
  ({ id: "r1", repoId: "api", harness, verb: "chat", chat: true, ...(result ? { result: { text: "", durationMs: 1, turns: 1, ...result } } : {}) }) as Run;

const tokens = (input: number, cachedInput: number, output: number) => ({ input, cachedInput, output, reasoning: 0, total: input + output });

const entry = (over: Partial<CostEntry> = {}): CostEntry => ({
  at: 1,
  service: "codex",
  provider: "openai",
  model: "gpt-6",
  repo: null,
  repoName: null,
  run: null,
  label: null,
  session: null,
  usd: null,
  tokens: null,
  seconds: null,
  ...over,
});

describe("runDelta", () => {
  test("a Claude chat's cost so far becomes each reply's difference", () => {
    const first = runDelta(run("claude", { costUsd: 0.0036 }), undefined);
    expect(first?.usd).toBeCloseTo(0.0036);
    const second = runDelta(run("claude", { costUsd: 0.0044 }), first?.now);
    expect(second?.usd).toBeCloseTo(0.0008);
    // the same result again spends nothing
    expect(runDelta(run("claude", { costUsd: 0.0044 }), second?.now)).toBeNull();
  });

  test("a figure that went down started counting again and counts whole", () => {
    expect(runDelta(run("claude", { costUsd: 0.002 }), { usd: 0.5, tokens: null })?.usd).toBeCloseTo(0.002);
  });

  test("Claude records both dollar and cumulative modelUsage deltas", () => {
    const first = runDelta(run("claude", { costUsd: 0.01, tokens: tokens(1000, 200, 50) }), undefined);
    expect(first).toMatchObject({ usd: 0.01, tokens: tokens(1000, 200, 50) });
    const second = runDelta(run("claude", { costUsd: 0.03, tokens: tokens(1500, 900, 80) }), first?.now);
    expect(second).toMatchObject({ usd: expect.closeTo(0.02), tokens: tokens(500, 700, 30) });
    expect(runDelta(run("claude", { costUsd: 0.03, tokens: tokens(1500, 900, 80) }), second?.now)).toBeNull();
  });

  test("tokens with no reported dollar delta can still be estimated", () => {
    expect(runDelta(run("claude", { tokens: tokens(100, 20, 10) }), undefined)).toMatchObject({ usd: null, tokens: tokens(100, 20, 10) });
  });

  test("an explicit Claude zero is known cost, while Codex's compatibility zero is not", () => {
    expect(runDelta(run("claude", { costUsd: 0, tokens: tokens(100, 20, 10) }), undefined)).toMatchObject({ usd: 0, tokens: tokens(100, 20, 10) });
    expect(runDelta(run("codex", { costUsd: 0, tokens: tokens(100, 20, 10) }), undefined)).toMatchObject({ usd: null, tokens: tokens(100, 20, 10) });
  });

  test("Codex's thread total becomes each reply's tokens, with no dollars", () => {
    const first = runDelta(run("codex", { costUsd: 0, tokens: tokens(1000, 200, 50) }), undefined);
    expect(first).toMatchObject({ usd: null, tokens: tokens(1000, 200, 50) });
    const second = runDelta(run("codex", { costUsd: 0, tokens: tokens(1500, 900, 80) }), first?.now);
    expect(second?.tokens).toEqual(tokens(500, 700, 30));
  });

  test("no result, or a result that spent nothing, is no row", () => {
    expect(runDelta(run("claude"), undefined)).toBeNull();
    expect(runDelta(run("claude", { costUsd: 0 }), undefined)).toBeNull();
    expect(runDelta(run("codex", { costUsd: 0 }), undefined)).toBeNull();
  });
});

describe("prices", () => {
  test("parsePrices keeps well-formed entries only", () => {
    expect(parsePrices({ "openai/*": { perMinute: 0.1, junk: 3 }, nokey: { perMinute: 1 }, "x/y": { perMinute: -1 }, "a/b": "no" })).toEqual({ "openai/*": { perMinute: 0.1 } });
    expect(parsePrices([])).toEqual({});
  });

  test("a model's own price wins over its provider's", () => {
    const list = { "openai/gpt-live-1": { perMinute: 0.2 }, "openai/*": { perMinute: 0.1 } };
    expect(priceOf(list, "openai", "gpt-live-1")).toEqual({ perMinute: 0.2 });
    expect(priceOf(list, "openai", "other")).toEqual({ perMinute: 0.1 });
    expect(priceOf(list, "elevenlabs", null)).toBeNull();
  });

  test("estimate prices minutes and tokens, cached input at its own rate", () => {
    const list = { "openai/*": { perMinute: 0.06, inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 10 } };
    expect(estimate(entry({ service: "voice", seconds: 90 }), list)).toBeCloseTo(0.09);
    // 800 fresh at $2, 200 cached at $0.50, 100 out at $10, per million
    expect(estimate(entry({ tokens: tokens(1000, 200, 100) }), list)).toBeCloseTo((800 * 2 + 200 * 0.5 + 100 * 10) / 1e6);
  });

  test("no estimate where the provider gave dollars or the list has nothing", () => {
    expect(estimate(entry({ usd: 1, seconds: 60 }), { "openai/*": { perMinute: 1 } })).toBeNull();
    expect(estimate(entry({ seconds: 60 }), {})).toBeNull();
    expect(estimate(entry({ seconds: 60 }), { "openai/*": { outputPerM: 1 } })).toBeNull();
  });
});

test("parseCostLine reads a row back and refuses what is not one", () => {
  const e = entry({ at: 5, run: "r1", tokens: tokens(1, 0, 1), seconds: 3 });
  expect(parseCostLine(JSON.stringify(e))).toEqual(e);
  const routed = entry({ at: 6, agentSettings: { harness: "codex", model: "gpt-x", effort: "high", provider: "team_1" }, action: "flow", flowStep: { workflow: "release", step: "review", source: "user" } });
  expect(parseCostLine(JSON.stringify(routed))).toEqual(routed);
  expect(parseCostLine("not json")).toBeNull();
  expect(parseCostLine(JSON.stringify({ ...e, service: "fax" }))).toBeNull();
  expect(parseCostLine(JSON.stringify({ ...e, at: "now" }))).toBeNull();
});

test("saneSeconds keeps a call's length and refuses nonsense", () => {
  expect(saneSeconds(95.04)).toBe(95);
  for (const v of [0, -1, Number.NaN, "5", 7 * 60 * 60]) expect(saneSeconds(v)).toBeNull();
});
