import { describe, expect, test } from "bun:test";
import type { CostEntry } from "./costs";
import { CapacityHeldError, DEFAULT_CAPACITY, HIT_GRACE, HIT_HOLD, READ_EVERY, decide, emptyCapacity, fade, hear, hitOfLimited, hitStands, holdWords, isCapacityWords, isLimitText, laterPriority, limitHit, limitedWords, normalizeCapacity, observe, parsePriority, patchCapacity, readAntigravityUsage, readCodexLimits, readRateLimit, readUsage, resetWord, stale, type Capacity } from "./capacity";

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
  test("observed CLI wording: a session or 5-hour limit, with the zone the CLI names", () => {
    // Claude Code 2.1.296 wrote this on a real spent window, 2026-10-10.
    const SESSION = "You've hit your session limit · resets 1:40pm (UTC)";
    expect(limitHit(SESSION, NOW)).toEqual({ window: "fiveHour", at: NOW, resetsAt: Date.UTC(2026, 9, 26, 13, 40), text: SESSION });
    // 2.1.316 names the window "5-hour limit" and may add "progress saved".
    const FIVE = "You've hit your 5-hour limit · resets 1:40pm (UTC) · progress saved";
    expect(isLimitText(FIVE)).toBe(true);
    expect(limitHit(FIVE, NOW)?.window).toBe("fiveHour");
    expect(limitHit(FIVE, NOW)?.resetsAt).toBe(Date.UTC(2026, 9, 26, 13, 40));
    // Two words before "limit" stay out: a monthly spend cap is not the plan's window.
    expect(isLimitText("You've hit your monthly spend limit.")).toBe(false);
  });
  test("a named zone is read in that zone, not the backend's clock", () => {
    // noon UTC is 5am in Los Angeles, so 8am there is 15:00 UTC today
    expect(limitHit("You've hit your 5-hour limit · resets 8am (America/Los_Angeles)", NOW)?.resetsAt).toBe(AT_3PM);
    // 4am there has passed, so it is tomorrow's
    expect(limitHit("You've hit your 5-hour limit · resets 4am (America/Los_Angeles)", NOW)?.resetsAt).toBe(Date.UTC(2026, 9, 27, 11));
    // a zone the runtime does not know falls back to the backend's clock
    expect(limitHit("You've hit your 5-hour limit · resets 3pm (Mars/Base)", NOW)?.resetsAt).toBe(AT_3PM);
  });
  test("past a day out the CLI prints a date, with the year only when it differs", () => {
    expect(limitHit("You've hit your weekly limit · resets Oct 29, 3pm (UTC)", NOW)).toEqual({
      window: "weekly",
      at: NOW,
      resetsAt: THU_3PM,
      text: "You've hit your weekly limit · resets Oct 29, 3pm (UTC)",
    });
    expect(limitHit("You've hit your weekly limit · resets Oct 29, 8:30am (America/Los_Angeles)", NOW)?.resetsAt).toBe(Date.UTC(2026, 9, 29, 15, 30));
    expect(limitHit("You've hit your weekly limit · resets Jan 2, 2027, 3pm (UTC)", NOW)?.resetsAt).toBe(Date.UTC(2027, 0, 2, 15));
    expect(limitHit("You've hit your weekly limit · resets Oct 29, 3pm", NOW)?.resetsAt).toBe(THU_3PM);
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

describe("plan 2: priorities, holds and the CLI's own reset", () => {
  test("parsePriority and laterPriority", () => {
    expect(["interactive", "normal", "low", "high", 3, undefined].map(parsePriority)).toEqual(["interactive", "normal", "low", null, null, null]);
    expect((["interactive", "normal", "low"] as const).map(laterPriority)).toEqual(["normal", "normal", "low"]);
  });
  test("a hold's words, and the error a held start throws", () => {
    const hold = decide(cap({ hit: limitHit(SPENT, NOW), source: "observed" }), "low", DEFAULT_CAPACITY, NOW);
    if (hold === "go") throw new Error("expected a hold");
    expect(holdWords(hold)).toBe("waiting for capacity: the 5-hour window is spent (resets 15:00)");
    const err = new CapacityHeldError(hold);
    expect([err.name, err.message, err.until]).toEqual(["CapacityHeldError", holdWords(hold), AT_3PM + HIT_GRACE]);
    expect([isCapacityWords(err.message), isCapacityWords("waiting for capacity (resets 15:00)"), isCapacityWords("busy"), isCapacityWords(undefined)]).toEqual([true, true, false, false]);
  });
  test("readRateLimit reads the CLI's rate_limit_event and nothing else", () => {
    expect(readRateLimit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: AT_3PM / 1000, rateLimitType: "five_hour" } })).toEqual({ status: "rejected", resetsAt: AT_3PM, window: "fiveHour" });
    expect(readRateLimit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day_opus" } })).toEqual({ status: "allowed", resetsAt: null, window: "weekly" });
    expect(readRateLimit({ type: "rate_limit_event", rate_limit_info: { resetsAt: 5 } })).toBeNull();
    expect(readRateLimit({ type: "result" })).toBeNull();
    expect(readRateLimit("nope")).toBeNull();
  });
  test("hitOfLimited takes the event's exact reset and window over the text's", () => {
    const at = NOW;
    expect(hitOfLimited({ at, text: SPENT })).toEqual(limitHit(SPENT, at));
    expect(hitOfLimited({ at, text: SPENT, resetsAt: THU_3PM, window: "weekly" })).toEqual({ window: "weekly", at, resetsAt: THU_3PM, text: SPENT });
    // a reset in the past is the event's stale word, not the reset
    expect(hitOfLimited({ at, text: SPENT, resetsAt: at - 1 })?.resetsAt).toBe(AT_3PM);
    expect(hitOfLimited({ at, text: "the run failed" })).toBeNull();
    expect(limitedWords({ at, text: SPENT }, NOW)).toBe("waiting for capacity (resets 15:00)");
    expect(limitedWords({ at, text: "no limit here" }, NOW)).toBe("waiting for capacity");
    expect(limitedWords(undefined, NOW)).toBe("waiting for capacity");
  });
  test("patchCapacity keeps what the patch leaves out and refuses a bad value", () => {
    expect(patchCapacity(DEFAULT_CAPACITY, { lowHold: 0.6, observedFiveHourUsd: 40 })).toEqual({ ...DEFAULT_CAPACITY, lowHold: 0.6, observedFiveHourUsd: 40 });
    expect(patchCapacity({ ...DEFAULT_CAPACITY, observedFiveHourUsd: 40 }, { observedFiveHourUsd: null })).toEqual(DEFAULT_CAPACITY);
    expect(patchCapacity(DEFAULT_CAPACITY, { normalHold: 2 })).toBe("normalHold must be above 0 and at most 1");
    expect(patchCapacity(DEFAULT_CAPACITY, { observedFiveHourUsd: -3 })).toBe("observedFiveHourUsd must be a dollar figure above 0, or null");
    expect(patchCapacity(DEFAULT_CAPACITY, [])).toBe("the settings must be an object");
  });
});

describe("the harness's own count, heard on a run's stream", () => {
  // the event Claude Code 2.1.330 sent on a Max plan, with other numbers
  const EVENT = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: THU_3PM / 1000,
      rateLimitType: "seven_day",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        seven_day: { utilization: 0.56, resetsAt: THU_3PM / 1000, status: "allowed" },
        seven_day_overage_included: { utilization: 0.37, resetsAt: THU_3PM / 1000, status: "allowed" },
      },
    },
  };
  const event = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info });

  test("readRateLimit reads each window the event names; one it cannot read is left out", () => {
    expect(readRateLimit(EVENT)).toEqual({ status: "allowed", resetsAt: THU_3PM, window: "weekly", windows: { weekly: { used: 0.56, resetsAt: THU_3PM } } });
    const both = event({ status: "allowed_warning", unifiedWindows: { five_hour: { utilization: 0.82, resetsAt: AT_3PM / 1000 }, seven_day: { utilization: "lots", resetsAt: THU_3PM / 1000 } } });
    expect(readRateLimit(both)?.windows).toEqual({ fiveHour: { used: 0.82, resetsAt: AT_3PM } });
    // a share may pass 1, and a window with no reset is no reading
    expect(readRateLimit(event({ status: "rejected", unifiedWindows: { five_hour: { utilization: 1.04, resetsAt: AT_3PM / 1000 } } }))?.windows).toEqual({ fiveHour: { used: 1.04, resetsAt: AT_3PM } });
    expect(readRateLimit(event({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1 } } }))).toEqual({ status: "allowed", resetsAt: null, window: null });
  });

  test("a CLI that names only the limiting window gives that one; a model's own week is not the plan's", () => {
    expect(readRateLimit(event({ status: "allowed_warning", resetsAt: AT_3PM / 1000, rateLimitType: "five_hour", utilization: 0.91 }))?.windows).toEqual({ fiveHour: { used: 0.91, resetsAt: AT_3PM } });
    expect(readRateLimit(event({ status: "allowed", resetsAt: THU_3PM / 1000, rateLimitType: "seven_day", utilization: 0.4 }))?.windows).toEqual({ weekly: { used: 0.4, resetsAt: THU_3PM } });
    expect(readRateLimit(event({ status: "allowed", resetsAt: THU_3PM / 1000, rateLimitType: "seven_day_opus", utilization: 0.4 }))?.windows).toBeUndefined();
    expect(readRateLimit(event({ status: "allowed", resetsAt: AT_3PM / 1000, rateLimitType: "five_hour" }))?.windows).toBeUndefined();
  });

  test("readCodexLimits: a window by its length, the share out of 100", () => {
    // `account/rateLimits/updated` as Codex's app-server sent it, with other numbers
    const params = { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: THU_3PM / 1000 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "prolite", rateLimitReachedType: null } };
    expect(readCodexLimits(params)).toEqual({ weekly: { used: 0.03, resetsAt: THU_3PM } });
    expect(readCodexLimits({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: AT_3PM / 1000 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: THU_3PM / 1000 } } })).toEqual({
      fiveHour: { used: 0.4, resetsAt: AT_3PM },
      weekly: { used: 0.12, resetsAt: THU_3PM },
    });
    // a length canopy has no name for, a window with no reset, and garbage
    expect(readCodexLimits({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 60, resetsAt: AT_3PM / 1000 } } })).toBeNull();
    expect(readCodexLimits({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } } })).toBeNull();
    expect(readCodexLimits({})).toBeNull();
    expect(readCodexLimits("nope")).toBeNull();
  });

  test("hear: the count becomes the reading, a window it leaves out stays, and a ledger estimate gives way", () => {
    const first = hear(cap(), { weekly: { used: 0.56, resetsAt: THU_3PM } }, NOW);
    expect(first).toEqual(cap({ weekly: { used: 0.56, resetsAt: THU_3PM, readAt: NOW }, source: "run" }));
    const later = NOW + 60_000;
    expect(hear(first, { fiveHour: { used: 0.2, resetsAt: AT_3PM } }, later)).toEqual(cap({
      fiveHour: { used: 0.2, resetsAt: AT_3PM, readAt: later },
      weekly: { used: 0.56, resetsAt: THU_3PM, readAt: NOW },
      source: "run",
    }));
    // the ledger's rolling guess is not the harness's count
    expect(hear(cap({ fiveHour: win(0.75, null), source: "observed" }), { weekly: { used: 0.56, resetsAt: THU_3PM } }, NOW)).toEqual(cap({ weekly: { used: 0.56, resetsAt: THU_3PM, readAt: NOW }, source: "run" }));
    // a hit stays through it
    const hit = limitHit(SPENT, NOW);
    expect(hear(cap({ hit, source: "observed" }), { fiveHour: { used: 1, resetsAt: AT_3PM } }, NOW)).toMatchObject({ hit, source: "run" });
  });

  test("hear: an endpoint reading is left alone, and a window already past its reset is no reading", () => {
    const endpoint = cap({ fiveHour: win(0.3), source: "endpoint" });
    expect(hear(endpoint, { fiveHour: { used: 0.9, resetsAt: AT_3PM } }, NOW)).toBe(endpoint);
    expect(hear(cap(), { fiveHour: { used: 0.9, resetsAt: NOW - 1 } }, NOW)).toEqual(cap());
    expect(hear(cap(), {}, NOW)).toEqual(cap());
  });

  test("fade: a window past its reset is dropped, and with none left the reading is unknown again", () => {
    const both = cap({ fiveHour: win(0.9, AT_3PM), weekly: win(0.5, THU_3PM), source: "run" });
    expect(fade(both, AT_3PM - 1)).toBe(both);
    expect(fade(both, AT_3PM)).toEqual(cap({ weekly: win(0.5, THU_3PM), source: "run" }));
    expect(fade(both, THU_3PM)).toEqual(cap());
    // a standing hit keeps the harness observed, and other sources are not a run's
    const hit = limitHit(SPENT, NOW);
    expect(fade(cap({ fiveHour: win(1, NOW + 1), source: "run", hit }), NOW + 1)).toEqual(cap({ source: "observed", hit }));
    const ledger = cap({ fiveHour: win(0.4, null), source: "observed" });
    expect(fade(ledger, THU_3PM)).toBe(ledger);
  });

  test("decide: a run's reading holds until its reset, however old, and nothing after it", () => {
    const S = DEFAULT_CAPACITY;
    const old = NOW - 2 * 60 * 60_000;
    const five = cap({ fiveHour: win(0.95, AT_3PM, old), source: "run" });
    expect(decide(five, "normal", S, NOW)).toEqual({ hold: "window", until: AT_3PM, why: "the 5-hour window is at 95% (resets 15:00)" });
    expect(decide(five, "interactive", S, NOW)).toBe("go");
    expect(decide(five, "normal", S, AT_3PM)).toBe("go");
    const week = cap({ weekly: win(0.86, THU_3PM, old), source: "run" });
    expect(decide(week, "low", S, NOW)).toEqual({ hold: "window", until: THU_3PM, why: "the weekly window is at 86% (resets Thu)" });
    expect(decide(week, "normal", S, NOW)).toBe("go");
    expect(decide(week, "low", S, THU_3PM)).toBe("go");
  });

  test("observe leaves a run's reading as it is, figure or no figure", () => {
    const heard = cap({ weekly: win(0.56, THU_3PM), source: "run" });
    expect(observe(heard, [row(NOW - 1, 20)], { observedFiveHourUsd: 40 }, NOW)).toBe(heard);
    expect(observe(heard, [], { observedFiveHourUsd: null }, NOW)).toBe(heard);
  });
});

describe("readAntigravityUsage and cli source", () => {
  const agyJson = (groups: unknown[], status = "SUCCESS") => ({
    conversation_id: "",
    status,
    response: "",
    duration_seconds: 0,
    num_turns: 0,
    command: { name: "usage", data: { groups } },
  });

  test("reads agy /usage JSON: converts remaining_fraction, drops epoch-0 resets, picks tightest group", () => {
    const sample = agyJson([
      {
        name: "Gemini Models",
        buckets: [
          { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.98, reset_time: "2026-10-29T15:00:00Z" },
          { id: "gemini-5h", window: "5h", remaining_fraction: 0.95, reset_time: "2026-10-26T15:00:00Z" },
        ],
      },
      {
        name: "Claude and GPT models",
        buckets: [
          { id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
          { id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
        ],
      },
    ]);
    const got = readAntigravityUsage(sample, NOW);
    expect(got?.fiveHour?.resetsAt).toBe(AT_3PM);
    expect(got?.fiveHour?.readAt).toBe(NOW);
    expect(got?.fiveHour?.used).toBeCloseTo(0.05, 6);
    expect(got?.weekly?.resetsAt).toBe(THU_3PM);
    expect(got?.weekly?.used).toBeCloseTo(0.02, 6);

    // 3p group tighter than Gemini wins
    const tighter3p = agyJson([
      { name: "Gemini Models", buckets: [{ window: "5h", remaining_fraction: 0.9, reset_time: "2026-10-26T15:00:00Z" }] },
      { name: "Claude and GPT models", buckets: [{ window: "5h", remaining_fraction: 0.2, reset_time: "2026-10-26T14:00:00Z" }] },
    ]);
    const got3p = readAntigravityUsage(tighter3p, NOW);
    expect(got3p?.fiveHour?.used).toBeCloseTo(0.8, 6);
    expect(got3p?.fiveHour?.resetsAt).toBe(Date.UTC(2026, 9, 26, 14));
    expect(got3p?.weekly).toBeNull();

    // both unused (epoch-0 reset) produce used: 0, resetsAt: null
    const unused = agyJson([
      {
        name: "Gemini Models",
        buckets: [
          { window: "weekly", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
          { window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
        ],
      },
    ]);
    expect(readAntigravityUsage(unused, NOW)).toEqual({
      fiveHour: { used: 0, resetsAt: null, readAt: NOW },
      weekly: { used: 0, resetsAt: null, readAt: NOW },
    });

    // error, wrong command, empty or garbage
    expect(readAntigravityUsage(agyJson([], "ERROR"), NOW)).toBeNull();
    expect(readAntigravityUsage({ status: "SUCCESS", command: { name: "models", data: { groups: [] } } }, NOW)).toBeNull();
    expect(readAntigravityUsage(agyJson([]), NOW)).toBeNull();
    expect(readAntigravityUsage("nope", NOW)).toBeNull();
  });

  test("cli source: fade drops expired resets while keeping unused windows, and decide holds until reset", () => {
    const agy = (over: Partial<Capacity>): Capacity => ({ ...emptyCapacity("antigravity"), source: "cli", ...over });
    const both = agy({ fiveHour: win(0.95, AT_3PM), weekly: win(0.2, THU_3PM) });
    expect(fade(both, AT_3PM - 1)).toBe(both);
    expect(fade(both, AT_3PM)).toEqual(agy({ fiveHour: null, weekly: win(0.2, THU_3PM) }));
    expect(fade(both, THU_3PM)).toEqual(emptyCapacity("antigravity"));
    // unused bucket with resetsAt: null is kept by fade
    const idle = agy({ fiveHour: win(0, null), weekly: win(0, null) });
    expect(fade(idle, THU_3PM)).toBe(idle);
    // decide holds past thresholds until reset, even past READ_EVERY
    const old = NOW - 2 * 60 * 60_000;
    const high = agy({ fiveHour: win(0.95, AT_3PM, old) });
    expect(decide(high, "normal", DEFAULT_CAPACITY, NOW)).toEqual({ hold: "window", until: AT_3PM, why: "the 5-hour window is at 95% (resets 15:00)" });
    expect(decide(high, "normal", DEFAULT_CAPACITY, AT_3PM)).toBe("go");
  });
});
