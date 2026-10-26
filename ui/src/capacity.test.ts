import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPACITY, emptyCapacity, limitHit, type Capacity } from "../../src/core/capacity";
import type { CapacityInfo } from "../../src/core/types";
import { ageWord, capacityLine, capacityRows, capacityTone, capacityWord, rowsTone, windowWord } from "./capacity";

const NOW = Date.UTC(2026, 9, 26, 12);
const THU_3PM = Date.UTC(2026, 9, 29, 15);
const min = (n: number) => n * 60_000;
const win = (used: number, resetsAt: number | null = NOW + min(130)) => ({ used, resetsAt, readAt: NOW });
const cap = (over: Partial<Capacity> = {}): Capacity => ({ ...emptyCapacity("claude"), ...over });
const info = (capacity: Capacity[]): CapacityInfo => ({ capacity, held: [], settings: DEFAULT_CAPACITY });

test("windowWord: time left today, else the weekday", () => {
  expect(windowWord(NOW + min(130), NOW)).toBe("2h10");
  expect(windowWord(NOW + min(120), NOW)).toBe("2h00");
  expect(windowWord(NOW + min(35), NOW)).toBe("35m");
  expect(windowWord(NOW - 1, NOW)).toBe("now");
  expect(windowWord(THU_3PM, NOW)).toBe("Thu");
  expect(windowWord(null, NOW)).toBe("");
});

test("capacityLine and ageWord", () => {
  expect(capacityLine(win(0.32), "fiveHour", NOW)).toBe("5h 32% · 2h10");
  expect(capacityLine(win(0.61, THU_3PM), "weekly", NOW)).toBe("week 61% · Thu");
  expect(capacityLine(win(0.4, null), "fiveHour", NOW)).toBe("5h 40%");
  expect(capacityLine(null, "weekly", NOW)).toBe("week no reading");
  expect([ageWord(0), ageWord(min(3)), ageWord(min(125))]).toEqual(["just now", "3m ago", "2h ago"]);
});

describe("capacityTone", () => {
  const S = DEFAULT_CAPACITY;
  test("moss under the low hold, lichen between the holds, rust at the normal hold or on a hit", () => {
    expect(capacityTone(cap({ fiveHour: win(0.69), source: "endpoint" }), S, NOW)).toBe("moss");
    expect(capacityTone(cap({ fiveHour: win(0.7), source: "endpoint" }), S, NOW)).toBe("lichen");
    expect(capacityTone(cap({ weekly: win(0.85, THU_3PM), source: "endpoint" }), S, NOW)).toBe("lichen");
    expect(capacityTone(cap({ fiveHour: win(0.9), source: "endpoint" }), S, NOW)).toBe("rust");
    expect(capacityTone(cap({ hit: limitHit("You've hit your limit · resets 3pm", NOW), source: "observed" }), S, NOW)).toBe("rust");
    expect(capacityTone(cap(), S, NOW)).toBe("moss");
  });
});

test("capacityRows: every backend that answered, in order, one row per harness; the word and the tone over them", () => {
  const mac = info([cap({ fiveHour: win(0.32), weekly: win(0.61, THU_3PM), source: "endpoint" }), emptyCapacity("codex")]);
  const mini = info([cap({ fiveHour: win(0.75, null), source: "observed" }), emptyCapacity("codex")]);
  const rows = capacityRows({ mac, mini }, ["mini", "mac", "old"], NOW);
  expect(rows.map((r) => [r.backend, r.cap.harness, r.tone, r.lines])).toEqual([
    ["mini", "claude", "lichen", ["5h 75%"]],
    ["mini", "codex", "moss", []],
    ["mac", "claude", "moss", ["5h 32% · 2h10", "week 61% · Thu"]],
    ["mac", "codex", "moss", []],
  ]);
  expect(rows.map((r) => r.source)).toEqual(["observed from the ledger", "no reading", "endpoint, read just now", "no reading"]);
  expect(capacityWord(rows)).toBe("5h 75%");
  expect(rowsTone(rows)).toBe("lichen");
  expect(capacityRows({}, ["mac"], NOW)).toEqual([]);
  expect(capacityWord([])).toBe("no reading");
  const hit = capacityRows({ mac: info([cap({ hit: limitHit("usage limit reached", NOW), source: "observed" })]) }, ["mac"], NOW);
  expect([capacityWord(hit), rowsTone(hit)]).toEqual(["limit", "rust"]);
  const expiredHit = capacityRows({ mac: info([cap({ hit: limitHit("usage limit reached", NOW), source: "observed" })]) }, ["mac"], NOW + min(62));
  expect(capacityWord(expiredHit)).toBe("no reading");
});
