import { describe, expect, test } from "bun:test";
import { localDays, localMidnightIso } from "./history";

describe("localDays", () => {
  test("ends today and walks back across a month boundary", () => {
    const days = localDays(5, new Date(2026, 8, 2, 15, 30));
    expect(days).toEqual([
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

describe("localMidnightIso", () => {
  test("is midnight on the local clock, so it round-trips through a Date", () => {
    const iso = localMidnightIso("2026-08-24");
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 7, 24, 0]);
  });
});
