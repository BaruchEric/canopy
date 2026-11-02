import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPACITY, emptyCapacity, limitHit } from "../core/capacity";
import type { CapacityInfo } from "../core/types";
import { capacityLines, holdArg, parseSetArgs, windowLine } from "./capacity";

// bun tests run in UTC, so the backend's clock is UTC here
const NOW = Date.UTC(2026, 9, 26, 12);
const AT_3PM = Date.UTC(2026, 9, 26, 15);
const THU_3PM = Date.UTC(2026, 9, 29, 15);
// strip the colours the lines carry
// eslint-disable-next-line no-control-regex
const plain = (lines: string[]): string[] => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

describe("canopy capacity's lines", () => {
  test("windowLine: the share and its reset, or no reading", () => {
    expect(windowLine("5h", { used: 0.32, resetsAt: AT_3PM, readAt: NOW }, NOW)).toBe("5h 32% · resets 15:00");
    expect(windowLine("week", { used: 0.61, resetsAt: THU_3PM, readAt: NOW }, NOW)).toBe("week 61% · resets Thu");
    expect(windowLine("5h", { used: 0.4, resetsAt: null, readAt: NOW }, NOW)).toBe("5h 40%");
    expect(windowLine("week", null, NOW)).toBe("week no reading");
  });

  test("a backend: each harness, a standing hit, the held starts and the thresholds", () => {
    const info: CapacityInfo = {
      capacity: [
        { ...emptyCapacity("claude"), fiveHour: { used: 0.3, resetsAt: null, readAt: NOW }, source: "observed", hit: limitHit("You've hit your limit · resets 3pm", NOW) },
        emptyCapacity("codex"),
      ],
      held: [{ id: "trigger:e1", what: "SHOP-1: the crash", repoId: "web/shop", priority: "low", why: "waiting for capacity: the 5-hour window is spent (resets 15:00)", since: NOW }],
      settings: { ...DEFAULT_CAPACITY, observedFiveHourUsd: 40 },
    };
    expect(plain(capacityLines("mini", info, NOW))).toEqual([
      "mini",
      "  claude  5h 30%   week no reading  (observed from the ledger)",
      "          limit hit, resets 15:00: You've hit your limit · resets 3pm",
      "  codex   no reading  (no reading)",
      "  held for capacity: 1",
      "    trigger:e1  low    SHOP-1: the crash (web/shop): waiting for capacity: the 5-hour window is spent (resets 15:00)",
      "  holds: low past 70%, normal past 90%, low past 85% of the week; $40 a 5-hour window",
    ]);
  });

  test("the tone follows the holds", () => {
    const tones: string[] = [];
    const info = (used: number): CapacityInfo => ({ capacity: [{ ...emptyCapacity("claude"), fiveHour: { used, resetsAt: null, readAt: NOW }, source: "observed" }], held: [], settings: DEFAULT_CAPACITY });
    for (const used of [0.5, 0.75, 0.95]) capacityLines("m", info(used), NOW, (tone, text) => { tones.push(tone); return text; });
    expect(tones).toEqual(["moss", "lichen", "rust"]);
  });
});

describe("canopy capacity set", () => {
  test("holdArg reads a fraction or a percentage", () => {
    expect([holdArg("0.7"), holdArg("70%"), holdArg("1"), holdArg("0"), holdArg("120%"), holdArg("x")]).toEqual([0.7, 0.7, 1, null, null, null]);
  });
  test("parseSetArgs turns the flags into a patch, or says what is wrong", () => {
    expect(parseSetArgs(["--low", "60%", "--usd", "40"])).toEqual({ lowHold: 0.6, observedFiveHourUsd: 40 });
    expect(parseSetArgs(["--usd", "none"])).toEqual({ observedFiveHourUsd: null });
    expect(parseSetArgs(["--normal", "2"])).toBe("--normal needs a hold above 0 and at most 1 (0.7 or 70%)");
    expect(parseSetArgs(["--usd", "-1"])).toBe("--usd needs a dollar figure above 0, or none");
    expect(parseSetArgs([])).toBe("name one of --low, --normal, --weekly or --usd");
    expect(parseSetArgs(["--low", "0.5", "extra"])).toBe("unknown words: extra");
  });
});
