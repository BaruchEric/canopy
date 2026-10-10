import { describe, expect, test } from "bun:test";
import { isCron, lastClock, nextFire, parseCron, parseWhen, type Cron } from "./cron";

// Bun pins JS Dates to UTC under test, so local time here is UTC
const at = (iso: string): number => new Date(`${iso}Z`).getTime();
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString().slice(0, 16));
const cron = (line: string): Cron => {
  const c = parseCron(line);
  if ("error" in c) throw new Error(c.error);
  return c;
};

describe("parseCron", () => {
  test("reads stars, lists, ranges and steps", () => {
    const c = cron("*/15 9-17 * * 1-5");
    expect([...c.minutes]).toEqual([0, 15, 30, 45]);
    expect([...c.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(c.anyDay).toBe(true);
    expect(c.anyWeekday).toBe(false);
    expect([...cron("5,10 0 1 1,7 *").months]).toEqual([1, 7]);
    // a step from a single value runs to the top of the field
    expect([...cron("50/5 * * * *").minutes]).toEqual([50, 55]);
  });

  test("a 7 is Sunday, and the macros expand", () => {
    expect([...cron("0 0 * * 7").weekdays]).toEqual([0]);
    expect(iso(nextFire(cron("@daily"), at("2026-10-10T08:30")))).toBe("2026-10-11T00:00");
    expect(iso(nextFire(cron("@hourly"), at("2026-10-10T08:30")))).toBe("2026-10-10T09:00");
  });

  test("refuses what is not a cron line", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "a * * * *", "*/0 * * * *", "5-1 * * * *", "* * * * * *"]) {
      expect("error" in parseCron(bad)).toBe(true);
      expect(isCron(bad)).toBe(false);
    }
    expect(isCron("0 8 * * *")).toBe(true);
    expect(isCron(42)).toBe(false);
  });
});

describe("nextFire", () => {
  test("the next minute strictly after the given time", () => {
    const c = cron("0 8 * * *");
    expect(iso(nextFire(c, at("2026-10-10T07:59")))).toBe("2026-10-10T08:00");
    expect(iso(nextFire(c, at("2026-10-10T08:00")))).toBe("2026-10-11T08:00");
    expect(iso(nextFire(cron("* * * * *"), at("2026-10-10T08:00:30")))).toBe("2026-10-10T08:01");
  });

  test("weekdays, months and the end of a year", () => {
    // 2026-10-10 is a Saturday
    expect(iso(nextFire(cron("0 9 * * 1"), at("2026-10-10T12:00")))).toBe("2026-10-12T09:00");
    expect(iso(nextFire(cron("30 6 1 1 *"), at("2026-10-10T12:00")))).toBe("2027-01-01T06:30");
  });

  test("both day fields restricted: either one matches", () => {
    // the 15th, or any Monday
    expect(iso(nextFire(cron("0 0 15 * 1"), at("2026-10-10T12:00")))).toBe("2026-10-12T00:00");
    expect(iso(nextFire(cron("0 0 13 * 0"), at("2026-10-10T12:00")))).toBe("2026-10-11T00:00");
  });

  test("a day that comes rarely, and one that never does", () => {
    expect(iso(nextFire(cron("0 0 29 2 *"), at("2026-10-10T12:00")))).toBe("2028-02-29T00:00");
    expect(nextFire(cron("0 0 31 2 *"), at("2026-10-10T12:00"))).toBeNull();
  });
});

describe("parseWhen", () => {
  const now = at("2026-10-10T08:30");
  test("in so long", () => {
    expect(parseWhen("in 30m", now)).toBe(now + 30 * 60_000);
    expect(parseWhen("in 2h", now)).toBe(now + 2 * 3_600_000);
    expect(parseWhen("in 1 day", now)).toBe(now + 86_400_000);
    expect("error" in (parseWhen("in 0m", now) as object)).toBe(true);
  });

  test("a clock time is the next one, today or tomorrow", () => {
    expect(iso(parseWhen("14:00", now) as number)).toBe("2026-10-10T14:00");
    expect(iso(parseWhen("at 8:15", now) as number)).toBe("2026-10-11T08:15");
  });

  test("an ISO time, never one already gone", () => {
    expect(parseWhen("2026-10-11T09:00", now)).toBe(new Date("2026-10-11T09:00").getTime());
    expect("error" in (parseWhen("2026-10-09 09:00", now) as object)).toBe(true);
    expect("error" in (parseWhen("tomorrow", now) as object)).toBe(true);
  });
});

describe("lastClock", () => {
  test("today's when it has passed, else yesterday's", () => {
    expect(iso(lastClock("04:00", at("2026-10-10T08:30")))).toBe("2026-10-10T04:00");
    expect(iso(lastClock("09:00", at("2026-10-10T08:30")))).toBe("2026-10-09T09:00");
    expect(lastClock("4:00", at("2026-10-10T08:30"))).toBeNull();
  });
});
