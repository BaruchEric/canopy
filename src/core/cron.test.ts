import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

  test("a day field starting with * is unrestricted, as in Vixie cron", () => {
    // */2 day of month with Monday: only Mondays that fall on an odd day
    const c = cron("0 9 */2 * 1");
    expect(c.anyDay).toBe(true);
    // 2026-10-12 is a Monday on an even day; the next odd-day Monday is 2026-10-19
    expect(iso(nextFire(c, at("2026-10-10T12:00")))).toBe("2026-10-19T09:00");
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

// Vixie cron's rules for a clock change: a line at fixed times runs a time
// the clock skips as soon as it jumps, and a time it repeats once; a line
// with * in its minute or hour field runs on the clock, skipped minutes and
// the repeated hour included. Times carry their offset, so the two 01:30s
// on the day the clock goes back read apart.
describe("across a clock change, in Los Angeles", () => {
  const was = process.env["TZ"] ?? "Etc/UTC";
  beforeAll(() => {
    process.env["TZ"] = "America/Los_Angeles";
  });
  afterAll(() => {
    process.env["TZ"] = was;
  });
  const t = (stamp: string): number => new Date(stamp).getTime();
  const local = (ms: number | null): string | null => {
    if (ms === null) return null;
    const off = -new Date(ms).getTimezoneOffset();
    const hours = String(Math.abs(off) / 60).padStart(2, "0");
    return `${new Date(ms + off * 60_000).toISOString().slice(0, 16)}${off < 0 ? "-" : "+"}${hours}:00`;
  };
  const next = (line: string, after: string): string | null => local(nextFire(cron(line), t(after)));

  // 2026-03-08: 01:59 PST, then 03:00 PDT
  test("a fixed time the clock skips runs as it jumps, once", () => {
    expect(next("30 2 * * *", "2026-03-08T00:00-08:00")).toBe("2026-03-08T03:00-07:00");
    expect(next("30 2 * * *", "2026-03-08T03:00-07:00")).toBe("2026-03-09T02:30-07:00");
    expect(next("0,30 2 * * *", "2026-03-08T00:00-08:00")).toBe("2026-03-08T03:00-07:00");
    expect(next("0,30 2 * * *", "2026-03-08T03:00-07:00")).toBe("2026-03-09T02:00-07:00");
    // not on a day the line does not run
    expect(next("30 2 * * 1", "2026-03-08T00:00-08:00")).toBe("2026-03-09T02:30-07:00");
  });

  test("a line on the clock goes on from 03:00, the skipped minutes gone", () => {
    expect(next("0 * * * *", "2026-03-08T01:30-08:00")).toBe("2026-03-08T03:00-07:00");
    expect(next("5 * * * *", "2026-03-08T01:05-08:00")).toBe("2026-03-08T03:05-07:00");
    expect(next("*/15 * * * *", "2026-03-08T01:45-08:00")).toBe("2026-03-08T03:00-07:00");
    expect(next("*/15 2 * * *", "2026-03-08T00:00-08:00")).toBe("2026-03-09T02:00-07:00");
  });

  // 2026-11-01: 01:59 PDT, then 01:00 PST
  test("a fixed time the clock repeats runs the first time only", () => {
    expect(next("30 1 * * *", "2026-11-01T00:00-07:00")).toBe("2026-11-01T01:30-07:00");
    expect(next("30 1 * * *", "2026-11-01T01:30-07:00")).toBe("2026-11-02T01:30-08:00");
    expect(next("45 1 * * *", "2026-11-01T01:10-08:00")).toBe("2026-11-02T01:45-08:00");
    expect(next("15 2 * * *", "2026-11-01T01:10-08:00")).toBe("2026-11-01T02:15-08:00");
  });

  test("a line on the clock runs through the repeated hour", () => {
    expect(next("0 * * * *", "2026-11-01T01:00-07:00")).toBe("2026-11-01T01:00-08:00");
    expect(next("0 * * * *", "2026-11-01T01:00-08:00")).toBe("2026-11-01T02:00-08:00");
    expect(next("*/15 * * * *", "2026-11-01T01:45-07:00")).toBe("2026-11-01T01:00-08:00");
  });

  test("the next fire is after the given time, in the repeated hour too", () => {
    expect(next("* * * * *", "2026-11-01T01:10:30-08:00")).toBe("2026-11-01T01:11-08:00");
    expect(next("*/15 * * * *", "2026-11-01T01:10-08:00")).toBe("2026-11-01T01:15-08:00");
  });
});
