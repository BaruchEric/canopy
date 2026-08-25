import { describe, expect, test } from "bun:test";
import type { RepoHistory } from "../../src/core/types";
import { RING_FLOOR, recentOf, ringLevel } from "./rings";
import { toolLine, when } from "./util";

describe("ringLevel", () => {
  test("a quiet day is 0, the heaviest day is 1", () => {
    expect(ringLevel(0, 50)).toBe(0);
    expect(ringLevel(50, 50)).toBe(1);
    expect(ringLevel(80, 50)).toBe(1);
  });
  test("any spend clears the floor and the ramp keeps order", () => {
    const a = ringLevel(0.05, 50);
    const b = ringLevel(2, 50);
    const c = ringLevel(20, 50);
    expect(a).toBeGreaterThanOrEqual(RING_FLOOR);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThan(1);
  });
  test("with no scale yet, spend is simply on", () => {
    expect(ringLevel(3, 0)).toBe(1);
  });
});

describe("recentOf", () => {
  const h: RepoHistory = {
    project: "keel",
    sessions: 40,
    costUsd: 900,
    tokens: 1,
    commits: 0,
    first: null,
    last: null,
    days: [0, 1.5, 0, 4],
    daySessions: [0, 2, 0, 1],
  };
  test("sums the window and remembers the last active day", () => {
    expect(recentOf(h)).toEqual({ sessions: 3, cost: 5.5, lastDay: 3 });
  });
  test("an empty window has no last day", () => {
    expect(recentOf({ ...h, days: [0, 0], daySessions: [0, 0] }).lastDay).toBe(-1);
  });
});

describe("when", () => {
  const now = new Date(2026, 7, 25, 12, 0);
  test("this year keeps the time, earlier years keep the year", () => {
    const thisYear = when(new Date(2026, 7, 24, 19, 50).toISOString(), now);
    const lastYear = when(new Date(2025, 10, 3, 9, 5).toISOString(), now);
    expect(thisYear).toBe("Aug 24 19:50");
    expect(lastYear).toBe("Nov 03, 2025");
    expect(thisYear.length).toBe(lastYear.length);
  });
  test("missing or unreadable dates render a dash", () => {
    expect(when(null)).toBe("—");
    expect(when("yesterday")).toBe("—");
  });
});

describe("toolLine", () => {
  test("names the thing the tool touched", () => {
    expect(toolLine("Bash", JSON.stringify({ command: "bun  test\n", description: "x" }))).toBe("bun test");
    expect(toolLine("Read", JSON.stringify({ file_path: "/a/b.ts" }))).toBe("/a/b.ts");
    expect(toolLine("Skill", JSON.stringify({ skill: "ship" }))).toBe("ship");
    expect(toolLine("Mystery", JSON.stringify({ n: 1 }))).toBe("");
    expect(toolLine("Mystery", "not json")).toBe("not json");
  });
});
