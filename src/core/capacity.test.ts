import { describe, expect, test } from "bun:test";
import type { CostEntry } from "./costs";
import { DEFAULT_CAPACITY, HIT_GRACE, HIT_HOLD, READ_EVERY, decide, emptyCapacity, hitStands, isLimitText, limitHit, normalizeCapacity, observe, readUsage, resetWord, stale, type Capacity } from "./capacity";

// These are synthetic fixtures for the documented response/text shapes, not
// captured output from a live endpoint or credential.
const NOW = Date.UTC(2026, 9, 26, 12); // a Monday, noon (bun tests use UTC)
const AT_3PM = Date.UTC(2026, 9, 26, 15);
const THU_3PM = Date.UTC(2026, 9, 29, 15);
const SPENT = "You've hit your limit · resets 3pm";
const OLDER = "Claude AI usage limit reached|1793026800";
const CODEX = "usage limit reached\ntry later";
const WEEKLY = "You've hit your weekly limit · resets Thu 3pm";

const row = (at: number, usd: number | null, service: CostEntry["service"] = "claude"): CostEntry => ({ at, service, provider: "anthropic", model: null, repo: null, repoName: null, run: null, label: null, session: null, usd, tokens: null, seconds: null });
const cap = (over: Partial<Capacity> = {}): Capacity => ({ ...emptyCapacity("claude"), ...over });
const win = (used: number, resetsAt: number | null = AT_3PM, readAt = NOW) => ({ used, resetsAt, readAt });

describe("readUsage", () => {
  test("synthetic P2 shape: a percentage or a fraction, an ISO time or unix seconds", () => {
    expect(readUsage({ five_hour: { utilization: 32, resets_at: "2026-10-26T14:10:00Z" }, seven_day: { utilization: 0.61, resets_at: 1793026800 } }, NOW)).toEqual({
      fiveHour: { used: 0.32, resetsAt: Date.UTC(2026, 9, 26, 14, 10), readAt: NOW },
      weekly: { used: 0.61, resetsAt: AT_3PM, readAt: NOW },
    });
  });
  test("a window it does not recognise is null; garbage is two nulls", () => {
    expect(readUsage({ five_hour: { utilization: "lots" }, seven_day: { utilization: 5, resets_at: null } }, NOW)).toEqual({ fiveHour: null, weekly: { used: 0.05, resetsAt: null, readAt: NOW } });
    expect(readUsage("nope", NOW)).toEqual({ fiveHour: null, weekly: null });
    expect(readUsage(null, NOW)).toEqual({ fiveHour: null, weekly: null });
  });
  test("an impossible ISO reset leaves the window readable without a reset", () => {
    expect(readUsage({ five_hour: { utilization: 32, resets_at: "2026-02-30T14:10:00Z" } }, NOW)).toEqual({
      fiveHour: { used: 0.32, resetsAt: null, readAt: NOW },
      weekly: null,
    });
    expect(readUsage({ five_hour: { utilization: 32, resets_at: "2026-10-26T25:10:00Z" } }, NOW).fiveHour?.resetsAt).toBeNull();
  });
  test("ISO offsets convert to the same instant; unix seconds remain supported", () => {
    expect(readUsage({ five_hour: { utilization: 32, resets_at: "2026-10-26T16:10:00+02:00" } }, NOW).fiveHour?.resetsAt).toBe(Date.UTC(2026, 9, 26, 14, 10));
    expect(readUsage({ five_hour: { utilization: 32, resets_at: 1793026800 } }, NOW).fiveHour?.resetsAt).toBe(AT_3PM);
  });
});

describe("isLimitText and limitHit", () => {
  test("the texts the probes expect are limits; a rate limit and a summary are not", () => {
    for (const t of [SPENT, OLDER, CODEX, WEEKLY, "You've hit your limit"]) expect(isLimitText(t)).toBe(true);
    for (const t of ["", "rate limit exceeded, retrying", "I checked the rate limit handling", "stopped after 3 turns without finishing"]) expect(isLimitText(t)).toBe(false);
    expect(limitHit("stopped at the spending limit", NOW)).toBeNull();
  });
  test("a reset time is read in the backend's clock, as the next such time", () => {
    expect(limitHit(SPENT, NOW)).toEqual({ window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: SPENT });
    expect(limitHit(SPENT, Date.UTC(2026, 9, 26, 16))?.resetsAt).toBe(Date.UTC(2026, 9, 27, 15));
    expect(limitHit("You've hit your limit · resets 3:30pm", NOW)?.resetsAt).toBe(Date.UTC(2026, 9, 26, 15, 30));
    expect(limitHit(OLDER, NOW)?.resetsAt).toBe(AT_3PM);
  });
  test("the weekly window, by its word, with a weekday", () => {
    expect(limitHit(WEEKLY, NOW)).toEqual({ window: "weekly", at: NOW, resetsAt: THU_3PM, text: WEEKLY });
  });
  test("no reset named: an hour from now", () => {
    expect(limitHit(CODEX, NOW)).toEqual({ window: "fiveHour", at: NOW, resetsAt: NOW + HIT_HOLD, text: CODEX });
  });
  test("a hit stands until its reset plus the grace", () => {
    const hit = limitHit(SPENT, NOW);
    expect(hitStands(hit, AT_3PM + HIT_GRACE - 1)).toBe(true);
    expect(hitStands(hit, AT_3PM + HIT_GRACE)).toBe(false);
    expect(hitStands(null, NOW)).toBe(false);
  });
});

describe("observe", () => {
  const H = 60 * 60_000;
  const rows = [row(NOW - H, 2), row(NOW - 4 * H, 1), row(NOW - 2 * H, null), row(NOW - 5 * H, 100), row(NOW - 6 * H, 5), row(NOW - H, 7, "codex"), row(NOW - H, 3, "voice")];
  test("Claude dollars over the last five hours against the figure; the edge and null dollars count nothing", () => {
    expect(observe(cap(), rows, { observedFiveHourUsd: 10 }, NOW)).toEqual(cap({ fiveHour: { used: 0.3, resetsAt: null, readAt: NOW }, source: "observed" }));
  });
  test("no figure: no window, and unknown unless a hit stands", () => {
    expect(observe(cap(), rows, DEFAULT_CAPACITY, NOW)).toEqual(cap());
    const hit = limitHit(SPENT, NOW);
    expect(observe(cap({ hit }), rows, DEFAULT_CAPACITY, NOW)).toEqual(cap({ hit, source: "observed" }));
  });
  test("a Codex harness and an endpoint reading are left as they are", () => {
    const codex = { ...emptyCapacity("codex") };
    expect(observe(codex, rows, { observedFiveHourUsd: 10 }, NOW)).toBe(codex);
    const read = cap({ fiveHour: win(0.5), source: "endpoint" });
    expect(observe(read, rows, { observedFiveHourUsd: 10 }, NOW)).toBe(read);
  });
});

test("stale: past READ_EVERY, or never read", () => {
  expect(stale(win(0.1, null, NOW - READ_EVERY), NOW)).toBe(false);
  expect(stale(win(0.1, null, NOW - READ_EVERY - 1), NOW)).toBe(true);
  expect(stale(null, NOW)).toBe(true);
});

test("resetWord: a time today, else a weekday", () => {
  expect(resetWord(AT_3PM, NOW)).toBe("15:00");
  expect(resetWord(THU_3PM, NOW)).toBe("Thu");
});

describe("decide", () => {
  const S = DEFAULT_CAPACITY;
  test("interactive always goes; unknown holds nothing", () => {
    const hit = limitHit(SPENT, NOW);
    expect(decide(cap({ hit, fiveHour: win(1) }), "interactive", S, NOW)).toBe("go");
    expect(decide(cap(), "low", S, NOW)).toBe("go");
    expect(decide(cap({ hit }), "low", S, NOW)).toBe("go");
  });
  test("the thresholds, per priority", () => {
    expect(decide(cap({ fiveHour: win(0.69), source: "endpoint" }), "low", S, NOW)).toBe("go");
    expect(decide(cap({ fiveHour: win(0.7), source: "endpoint" }), "low", S, NOW)).toEqual({ hold: "window", until: AT_3PM, why: "the 5-hour window is at 70% (resets 15:00)" });
    expect(decide(cap({ fiveHour: win(0.89), source: "endpoint" }), "normal", S, NOW)).toBe("go");
    expect(decide(cap({ fiveHour: win(0.9), source: "endpoint" }), "normal", S, NOW)).toEqual({ hold: "window", until: AT_3PM, why: "the 5-hour window is at 90% (resets 15:00)" });
    expect(decide(cap({ weekly: win(0.85, THU_3PM), source: "endpoint" }), "low", S, NOW)).toEqual({ hold: "window", until: THU_3PM, why: "the weekly window is at 85% (resets Thu)" });
    expect(decide(cap({ weekly: win(0.85, THU_3PM), source: "endpoint" }), "normal", S, NOW)).toBe("go");
    expect(decide(cap({ fiveHour: win(0.92, null), source: "observed" }), "normal", S, NOW)).toEqual({ hold: "window", until: null, why: "the 5-hour window is at 92%" });
  });
  test("the settings move the thresholds", () => {
    expect(decide(cap({ fiveHour: win(0.5), source: "endpoint" }), "low", { ...S, lowHold: 0.5 }, NOW)).toMatchObject({ hold: "window" });
  });
  test("a hit holds normal and low until its reset plus the grace, then is forgotten", () => {
    const hit = limitHit(SPENT, NOW);
    const c = cap({ hit, source: "observed" });
    expect(decide(c, "normal", S, NOW)).toEqual({ hold: "hit", until: AT_3PM + HIT_GRACE, why: "the 5-hour window is spent (resets 15:00)" });
    expect(decide(c, "low", S, AT_3PM + HIT_GRACE - 1)).toMatchObject({ hold: "hit" });
    expect(decide(c, "low", S, AT_3PM + HIT_GRACE)).toBe("go");
  });
  test("a stale endpoint window is no reading", () => {
    expect(decide(cap({ fiveHour: win(0.95, AT_3PM, NOW - READ_EVERY - 1), source: "endpoint" }), "low", S, NOW)).toBe("go");
  });
});

test("normalizeCapacity", () => {
  expect(normalizeCapacity(undefined)).toEqual(DEFAULT_CAPACITY);
  expect(normalizeCapacity({ lowHold: 0.5, normalHold: 2, weeklyLowHold: 0, observedFiveHourUsd: 40 })).toEqual({ lowHold: 0.5, normalHold: 0.9, weeklyLowHold: 0.85, observedFiveHourUsd: 40 });
  expect(normalizeCapacity({ observedFiveHourUsd: -1 }).observedFiveHourUsd).toBeNull();
  expect(normalizeCapacity({ observedFiveHourUsd: "40" }).observedFiveHourUsd).toBeNull();
});
