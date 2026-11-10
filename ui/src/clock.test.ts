import { expect, test } from "bun:test";
import type { QuickNote } from "../../src/core/notes";
import { parseRules, type TriggerRuleInfo, type TriggersInfo } from "../../src/core/trigger";
import { DEFAULT_SWEEP } from "../../src/core/sweep";
import type { RangerInfo, RangerWake, SweepInfo } from "../../src/core/types";
import {
  atWords,
  axisTicks,
  clockBadge,
  clockJobs,
  clockRows,
  clockWindow,
  clockWords,
  comingFires,
  firesIn,
  fullTime,
  kindWords,
  laneMarks,
  lineFires,
  lineOf,
  nextOf,
  nextUp,
  nights,
  readWhen,
  titleOf,
  untilWords,
  whenWords,
  zoneShift,
  type ClockInput,
  type Job,
} from "./clock";

// bun pins a test's clock to UTC, so "local" below is UTC
const at = (iso: string): number => new Date(`${iso}:00Z`).getTime();
const NOW = at("2026-11-10T12:00");
const HOUR = 3_600_000;

const wake = (over: Partial<RangerWake>): RangerWake => ({ id: "aaaa0001", by: "eric", prompt: "Look at the queue. Then report.", created: at("2026-11-01T00:00"), ...over });

const ranger = (over: Partial<RangerInfo> = {}): RangerInfo => ({
  on: true,
  state: "running",
  term: "t",
  handle: "ranger",
  backend: "mac",
  root: "/dev",
  home: "/config/ranger/home",
  session: null,
  transcript: null,
  fails: 0,
  restarts: 0,
  telegram: "off",
  settings: { on: true, profile: null, handle: null, telegram: false, fresh: { daily: null, maxMb: null }, home: "own" },
  wakes: [],
  viewers: [],
  broker: true,
  ...over,
});

function rule(json: Record<string, unknown>, over: Partial<TriggerRuleInfo> = {}): TriggerRuleInfo {
  const parsed = parseRules(JSON.stringify({ rules: [json] })).rules[0];
  if (!parsed) throw new Error("the fixture rule does not parse");
  return { ...parsed, secretSet: true, tokenSet: false, agentSet: false, ...over };
}

const triggers = (rules: TriggerRuleInfo[], keeping = true): TriggersInfo => ({ rules, problems: [], events: [], keeping });

const sweep = (on: boolean, cron = "0 4 * * *"): SweepInfo => ({ items: [], settings: { ...DEFAULT_SWEEP, on, cron }, lastRun: null, swept: { shells: [], chats: [] }, ask: null });

const note = (over: Partial<QuickNote>): QuickNote => ({ id: "mac|n-aaaaaaaa", text: "Call the bank: ask about the wire", createdAt: NOW - HOUR, ...over });

const input = (over: Partial<ClockInput> = {}): ClockInput => ({ rangers: {}, triggers: {}, sweep: null, notes: {}, home: "mac", order: ["mac", "mini"], ...over });

/** a job of the plainest kind, with the parts every kind has open to change */
const job = (over: Partial<Pick<Job, "when" | "standing" | "next" | "last">> = {}): Job => ({ key: "mac|sweep|sweep", backend: "mac", kind: "sweep", id: "sweep", title: "Sweep", when: { kind: "cron", line: "0 9 * * *" }, standing: { state: "armed" }, ...over });

test("a title is a prompt's first words: up to a full stop, a colon or a bracket", () => {
  expect(titleOf("Daily health sweep (Eric approved 2026-11-10). Run canopy_health.")).toBe("Daily health sweep");
  expect(titleOf("Look at the landing queue. If a branch has waited a day, say so.")).toBe("Look at the landing queue");
  expect(titleOf("Call the bank: ask about the wire")).toBe("Call the bank");
  expect(titleOf("  first line\nsecond line")).toBe("first line");
  expect(titleOf("Look at the deploy.")).toBe("Look at the deploy");
  // a cut that would leave almost nothing is not taken
  expect(titleOf("Re: the NAS")).toBe("Re: the NAS");
  expect(titleOf("x".repeat(80))).toBe(`${"x".repeat(63)}…`);
  expect(titleOf("  ")).toBe("No words");
});

test("a ranger's wakes are jobs: on a line, once, or on a run's end, each with who set it", () => {
  const jobs = clockJobs(
    input({
      rangers: {
        mac: ranger({
          wakes: [
            wake({ id: "c1", cron: "0 9 * * *", next: at("2026-11-11T09:00"), by: "ranger" }),
            wake({ id: "o1", at: at("2026-11-10T14:32"), next: at("2026-11-10T14:32") }),
            wake({ id: "r1", run: "run-7", by: "run", from: "run-3" }),
          ],
        }),
      },
    }),
  );
  expect(jobs.map((j) => [j.key, j.when])).toEqual([
    ["mac|wake|c1", { kind: "cron", line: "0 9 * * *" }],
    ["mac|wake|o1", { kind: "once", at: at("2026-11-10T14:32") }],
    ["mac|wake|r1", { kind: "run", run: "run-7" }],
  ]);
  expect(jobs.every((j) => j.standing.state === "armed")).toBe(true);
  expect(jobs.map(kindWords)).toEqual(["the ranger's own wake", "your wake", "a run's wake"]);
  expect(jobs.map(whenWords)).toEqual(["Every day at 09:00", "Once", "When run run-7 ends"]);
  expect(jobs.map(lineOf)).toEqual(["0 9 * * *", null, null]);
});

test("wakes are held, not lost, while nothing can deliver them, and the row says why", () => {
  const wakes = [wake({ cron: "0 9 * * *" })];
  const why = (r: RangerInfo) => {
    const s = clockJobs(input({ rangers: { mac: r } }))[0]?.standing;
    return s && s.state !== "armed" ? `${s.state}: ${s.why}` : s?.state;
  };
  expect(why(ranger({ wakes }))).toBe("armed");
  expect(why(ranger({ wakes, on: false, state: "off" }))).toBe("held: The ranger is off on mac, so its wakes wait until it is turned on.");
  expect(why(ranger({ wakes, state: "backoff" }))).toBe("held: The ranger on mac is not running (restarting), so its wakes wait.");
  expect(why(ranger({ wakes, broker: false }))).toBe("held: mac knows no broker, which is what delivers a wake.");
});

test("the ranger's daily fresh start is a job while the ranger is on", () => {
  const settings = { ...ranger().settings, fresh: { daily: "04:30", maxMb: null } };
  const jobs = clockJobs(input({ rangers: { mac: ranger({ settings }) } }));
  expect(jobs.map((j) => [j.kind, lineOf(j)])).toEqual([["fresh", "30 4 * * *"]]);
  expect(clockJobs(input({ rangers: { mac: ranger({ settings, on: false }) } }))).toEqual([]);
});

test("a schedule rule and a rule's poll are jobs, with the backend's next and last fire", () => {
  const weekly = rule({ name: "spec-weekly", source: "schedule", cron: "0 5 * * 1", repo: "*" }, { next: at("2026-11-16T05:00"), lastFire: at("2026-11-09T05:00") });
  const tracker = rule({ name: "tracker", source: "github", repo: "web/shop", labels: ["canopy"] }, { nextFire: at("2026-11-10T12:15") });
  const hooked = rule({ name: "hooked", source: "github", repo: "web/shop", labels: ["canopy"], secretEnv: "CANOPY_TRIGGER_HOOK" });
  const jobs = clockJobs(input({ triggers: { mini: triggers([weekly, tracker, hooked]) } }));
  expect(jobs.map((j) => [j.key, lineOf(j), j.next, j.last])).toEqual([
    ["mini|rule|spec-weekly", "0 5 * * 1", at("2026-11-16T05:00"), at("2026-11-09T05:00")],
    ["mini|poll|tracker", "*/15 * * * *", at("2026-11-10T12:15"), undefined],
  ]);
  expect(jobs.map(kindWords)).toEqual(["schedule rule", "issue poll"]);
});

test("a rule with a problem is broken, and one on a backend without the flows lock is held", () => {
  const broken = rule({ name: "weekly", source: "schedule", cron: "0 5 * * 1", repo: "gone" }, { problem: "no repo gone in the tree" });
  const fine = rule({ name: "nightly", source: "schedule", cron: "0 2 * * *", repo: "*" });
  expect(clockJobs(input({ triggers: { mini: triggers([broken, fine]) } })).map((j) => j.standing)).toEqual([{ state: "broken", why: "no repo gone in the tree" }, { state: "armed" }]);
  expect(clockJobs(input({ triggers: { mini: triggers([fine], false) } }))[0]?.standing).toEqual({ state: "held", why: "mini does not hold the flows lock, so its rules start nothing." });
  expect(clockBadge({ mini: triggers([broken, fine]) })).toEqual({ text: "1", tone: "rust", title: "weekly: no repo gone in the tree" });
  expect(clockBadge({ mini: triggers([fine]) })).toBeNull();
});

test("the sweep is the home backend's job, off when its schedule is", () => {
  expect(clockJobs(input({ sweep: sweep(true, "30 3 * * *") })).map((j) => [j.key, lineOf(j), j.standing.state])).toEqual([["mac|sweep|sweep", "30 3 * * *", "armed"]]);
  expect(clockJobs(input({ sweep: sweep(false) }))[0]?.standing.state).toBe("off");
  expect(clockJobs(input({ sweep: sweep(true), home: "elsewhere" }))).toEqual([]);
});

test("a reminder is a job until it is delivered or done", () => {
  const notes = { mac: [note({ due: NOW + HOUR }), note({ id: "mac|n-b", due: NOW + HOUR, doneAt: NOW }), note({ id: "mac|n-c", due: NOW - HOUR, remindedAt: NOW }), note({ id: "mac|n-d" })] };
  const jobs = clockJobs(input({ notes }));
  expect(jobs.map((j) => [j.kind, j.title, j.when])).toEqual([["reminder", "Call the bank", { kind: "once", at: NOW + HOUR }]]);
});

test("two clocks that agree are no shift apart", () => {
  expect(zoneShift([{ cron: "0 9 * * *", next: at("2026-11-11T09:00") }], NOW)).toBe(0);
  expect(zoneShift([], NOW)).toBe(0);
});

test("a backend eight hours behind this page is found from when it says a line fires", () => {
  // its 09:00 is this page's 17:00
  expect(zoneShift([{ cron: "0 9 * * *", next: at("2026-11-10T17:00") }], NOW)).toBe(-8 * HOUR);
  // and one five and a half hours ahead: its 09:00 is 03:30 here
  expect(zoneShift([{ cron: "0 9 * * *", next: at("2026-11-11T03:30") }], NOW)).toBe(5.5 * HOUR);
});

test("a line that fits any shift does not pick one, and the line that pins it down wins", () => {
  expect(zoneShift([{ cron: "*/15 * * * *", next: at("2026-11-10T12:15") }], NOW)).toBe(0);
  expect(
    zoneShift(
      [
        { cron: "*/15 * * * *", next: at("2026-11-10T12:15") },
        { cron: "0 9 * * *", next: at("2026-11-10T17:00") },
      ],
      NOW,
    ),
  ).toBe(-8 * HOUR);
});

test("a next fire already passed, a line that does not read and a time nothing fits say nothing about the shift", () => {
  expect(zoneShift([{ cron: "0 9 * * *", next: NOW - HOUR }], NOW)).toBe(0);
  expect(zoneShift([{ cron: "not a line", next: NOW + HOUR }], NOW)).toBe(0);
  expect(zoneShift([{ cron: "0 9 * * *", next: at("2026-11-10T17:07") }], NOW)).toBe(0);
});

test("a job's next fire: the backend's word, a time worked out on its clock, or none", () => {
  const due = clockJobs(input({ rangers: { mac: ranger({ wakes: [wake({ cron: "0 9 * * *", next: NOW - 60_000 })] }) } }))[0];
  if (!due) throw new Error("no job");
  // a wake past its time is due and waiting, so its time stands
  expect(nextOf(due, NOW, 0)).toBe(NOW - 60_000);
  // a rule's passed time is only an old read: worked out again
  const stale = clockJobs(input({ triggers: { mini: triggers([rule({ name: "r", source: "schedule", cron: "0 9 * * *", repo: "*" }, { next: NOW - 60_000 })]) } }))[0];
  if (!stale) throw new Error("no job");
  expect(nextOf(stale, NOW, 0)).toBe(at("2026-11-11T09:00"));
  expect(nextOf(job({ next: at("2026-11-11T09:00") }), NOW, 0)).toBe(at("2026-11-11T09:00"));
  expect(nextOf(job(), NOW, -8 * HOUR)).toBe(at("2026-11-10T17:00"));
  expect(nextOf(job({ when: { kind: "once", at: NOW + 5 } }), NOW, 0)).toBe(NOW + 5);
  expect(nextOf(job({ when: { kind: "run", run: "x" } }), NOW, 0)).toBeNull();
  expect(nextOf(job({ standing: { state: "off", why: "off" } }), NOW, 0)).toBeNull();
  expect(nextOf(job({ standing: { state: "broken", why: "no repo" } }), NOW, 0)).toBeNull();
  // held is still due at its time
  expect(nextOf(job({ standing: { state: "held", why: "the ranger is off" } }), NOW, 0)).toBe(at("2026-11-11T09:00"));
});

test("the fires inside a window, on the backend's clock", () => {
  const w = clockWindow(NOW, "day");
  expect(w).toEqual({ from: at("2026-11-10T10:00"), to: at("2026-11-11T12:00") });
  expect(firesIn(job(), w.from, w.to, 0)).toEqual([at("2026-11-11T09:00")]);
  expect(firesIn(job(), w.from, w.to, -8 * HOUR)).toEqual([at("2026-11-10T17:00")]);
  expect(firesIn(job({ when: { kind: "cron", line: "0 */6 * * *" } }), w.from, w.to, 0)).toEqual(["2026-11-10T12:00", "2026-11-10T18:00", "2026-11-11T00:00", "2026-11-11T06:00"].map(at));
  // the window's first minute counts and its last does not
  expect(firesIn(job({ when: { kind: "cron", line: "0 10,12 * * *" } }), w.from, w.to, 0)).toEqual(["2026-11-10T10:00", "2026-11-10T12:00", "2026-11-11T10:00"].map(at));
  expect(firesIn(job({ when: { kind: "once", at: NOW + HOUR } }), w.from, w.to, 0)).toEqual([NOW + HOUR]);
  expect(firesIn(job({ when: { kind: "once", at: w.to } }), w.from, w.to, 0)).toEqual([]);
  expect(firesIn(job({ when: { kind: "run", run: "x" } }), w.from, w.to, 0)).toEqual([]);
  expect(firesIn(job({ when: { kind: "cron", line: "nope" } }), w.from, w.to, 0)).toEqual([]);
});

test("a wake fires from when it was made, and a line being typed is worked out alone", () => {
  const made = clockJobs(input({ rangers: { mac: ranger({ wakes: [wake({ cron: "0 * * * *", created: at("2026-11-10T11:30") })] }) } }))[0];
  if (!made) throw new Error("no job");
  const w = { from: at("2026-11-10T10:00"), to: at("2026-11-10T14:00") };
  expect(firesIn(made, w.from, w.to, 0)).toEqual(["2026-11-10T12:00", "2026-11-10T13:00"].map(at));
  expect(lineFires("30 * * * *", w.from, w.to, 0)).toEqual(["2026-11-10T10:30", "2026-11-10T11:30", "2026-11-10T12:30", "2026-11-10T13:30"].map(at));
  expect(lineFires("30 * * *", w.from, w.to, 0)).toEqual([]);
});

test("the next few fires of a line, on the backend's clock", () => {
  expect(comingFires("0 9 * * 1-5", NOW, 0, 3)).toEqual(["2026-11-11T09:00", "2026-11-12T09:00", "2026-11-13T09:00"].map(at));
  expect(comingFires("0 9 * * *", NOW, -8 * HOUR, 2)).toEqual(["2026-11-10T17:00", "2026-11-11T17:00"].map(at));
  expect(comingFires("nope", NOW, 0, 3)).toEqual([]);
});

test("a line that fires every minute is worked out for a whole week", () => {
  const w = clockWindow(NOW, "week");
  expect(firesIn(job({ when: { kind: "cron", line: "* * * * *" } }), w.from, w.to, 0)).toHaveLength((w.to - w.from) / 60_000);
});

test("fires that would touch are drawn as one band, the rest as ticks", () => {
  const from = 0;
  const to = 1000;
  const marks = laneMarks([100, 400, 410, 420, 430, 700, 705, 900], from, to, 10);
  expect(marks.ticks).toEqual([
    { t: 100, x: 0.1 },
    { t: 700, x: 0.7 },
    { t: 705, x: 0.705 },
    { t: 900, x: 0.9 },
  ]);
  expect(marks.bands).toEqual([{ from: 400, to: 430, x0: 0.4, x1: 0.43, count: 4 }]);
  expect(laneMarks([], from, to, 10)).toEqual({ ticks: [], bands: [] });
});

test("the axis names every third hour of a day, and midnight by its date", () => {
  const w = clockWindow(NOW, "day");
  const ticks = axisTicks(w.from, w.to, "day");
  expect(ticks.map((t) => t.label)).toEqual(["12:00", "15:00", "18:00", "21:00", "Wed 11", "03:00", "06:00", "09:00"]);
  expect(ticks.filter((t) => t.day).map((t) => t.label)).toEqual(["Wed 11"]);
  expect(ticks[0]?.x).toBeCloseTo(2 / 26);
  // a narrow lane has room for every sixth hour, and for a week's days without their dates
  expect(axisTicks(w.from, w.to, "day", true).map((t) => t.label)).toEqual(["12:00", "18:00", "Wed 11", "06:00"]);
  const week = clockWindow(NOW, "week");
  expect(axisTicks(week.from, week.to, "week", true).map((t) => t.label)).toEqual(["Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
});

test("over a week the axis names each day at its midnight", () => {
  const w = clockWindow(NOW, "week");
  // noon now: the window opens at the midnight before, twelve hours back
  expect(axisTicks(w.from, w.to, "week").map((t) => t.label)).toEqual(["Tue 10", "Wed 11", "Thu 12", "Fri 13", "Sat 14", "Sun 15", "Mon 16", "Tue 17"]);
});

test("the nights inside a window, cut at its ends", () => {
  const w = clockWindow(NOW, "day");
  const got = nights(w.from, w.to);
  expect(got).toHaveLength(1);
  expect(got[0]?.x0).toBeCloseTo(12 / 26);
  expect(got[0]?.x1).toBeCloseTo(20 / 26);
  // a window that opens at night starts inside one
  const late = nights(at("2026-11-10T23:00"), at("2026-11-11T23:00"));
  expect(late.map((n) => [Number(n.x0.toFixed(3)), Number(n.x1.toFixed(3))])).toEqual([
    [0, 0.292],
    [0.958, 1],
  ]);
});

test("how long until a time", () => {
  expect(untilWords(0)).toBe("due now");
  expect(untilWords(-5)).toBe("due now");
  expect(untilWords(20_000)).toBe("in under a minute");
  expect(untilWords(42 * 60_000)).toBe("in 42 min");
  expect(untilWords(2 * HOUR)).toBe("in 2 h");
  expect(untilWords(2 * HOUR + 14 * 60_000)).toBe("in 2 h 14 min");
  expect(untilWords(30 * HOUR)).toBe("in 30 h");
  expect(untilWords(72 * HOUR)).toBe("in 3 days");
});

test("a time against today", () => {
  expect(clockWords(at("2026-11-10T14:32"), NOW)).toBe("14:32");
  expect(clockWords(at("2026-11-11T09:00"), NOW)).toBe("tomorrow 09:00");
  expect(clockWords(at("2026-11-09T04:00"), NOW)).toBe("yesterday 04:00");
  expect(clockWords(at("2026-11-16T05:00"), NOW)).toBe("Mon 05:00");
  expect(clockWords(at("2026-11-17T09:00"), NOW)).toBe("17 Nov 09:00");
  expect(clockWords(at("2026-11-03T09:00"), NOW)).toBe("3 Nov 09:00");
  expect(fullTime(at("2026-11-11T09:00"))).toBe("Wed 11 Nov, 09:00");
});

test("the same time inside a sentence takes an at, and an on before a named day", () => {
  expect(atWords(at("2026-11-10T14:32"), NOW)).toBe("at 14:32");
  expect(atWords(at("2026-11-11T09:00"), NOW)).toBe("tomorrow at 09:00");
  expect(atWords(at("2026-11-09T04:00"), NOW)).toBe("yesterday at 04:00");
  expect(atWords(at("2026-11-16T05:00"), NOW)).toBe("on Mon at 05:00");
  expect(atWords(at("2026-11-03T09:00"), NOW)).toBe("on 3 Nov at 09:00");
});

test("rows come soonest first, the ones with no time last, and the page leads with the soonest that will be delivered", () => {
  const rows = clockRows(
    clockJobs(
      input({
        rangers: { mac: ranger({ on: false, state: "off", wakes: [wake({ id: "h1", at: NOW + 60_000, next: NOW + 60_000 })] }) },
        triggers: { mini: triggers([rule({ name: "nightly", source: "schedule", cron: "0 2 * * *", repo: "*" }, { next: at("2026-11-11T02:00") }), rule({ name: "bad", source: "schedule", cron: "0 1 * * *", repo: "gone" }, { problem: "no repo gone in the tree" })]) },
        sweep: sweep(true, "0 20 * * *"),
      }),
    ),
    NOW,
  );
  expect(rows.map((r) => [r.job.id, r.next])).toEqual([
    ["h1", NOW + 60_000],
    ["sweep", at("2026-11-10T20:00")],
    ["nightly", at("2026-11-11T02:00")],
    ["bad", null],
  ]);
  // the held wake is soonest, but nothing will deliver it
  expect(nextUp(rows)?.job.id).toBe("sweep");
  expect(nextUp([])).toBeNull();
});

test("a poll leads the page only where nothing else is due", () => {
  const poll = rule({ name: "tracker", source: "github", repo: "web/shop", labels: ["canopy"] }, { nextFire: NOW + 60_000 });
  const both = clockRows(clockJobs(input({ triggers: { mini: triggers([poll]) }, sweep: sweep(true, "0 20 * * *") })), NOW);
  expect(both[0]?.job.id).toBe("tracker");
  expect(nextUp(both)?.job.id).toBe("sweep");
  const alone = clockRows(clockJobs(input({ triggers: { mini: triggers([poll]) } })), NOW);
  expect(nextUp(alone)?.job.id).toBe("tracker");
});

test("each row carries its backend's shift, so a line with no next from the backend lands on that backend's clock", () => {
  const rows = clockRows(
    clockJobs(
      input({
        rangers: { mac: ranger({ wakes: [wake({ cron: "0 9 * * *", next: at("2026-11-10T17:00") })] }) },
        sweep: sweep(true, "0 4 * * *"),
      }),
    ),
    NOW,
  );
  expect(rows.map((r) => [r.job.kind, r.shift, r.next])).toEqual([
    ["wake", -8 * HOUR, at("2026-11-10T17:00")],
    ["sweep", -8 * HOUR, at("2026-11-11T12:00")],
  ]);
});

test("a one-time wake as typed is read on the backend's clock", () => {
  expect(readWhen("in 30m", NOW, 0)).toBe(NOW + 30 * 60_000);
  expect(readWhen("14:00", NOW, 0)).toBe(at("2026-11-10T14:00"));
  // the backend is eight hours behind: its 14:00 is 22:00 here
  expect(readWhen("14:00", NOW, -8 * HOUR)).toBe(at("2026-11-10T22:00"));
  expect(readWhen("in 30m", NOW, -8 * HOUR)).toBe(NOW + 30 * 60_000);
  expect(readWhen("soon", NOW, 0)).toEqual({ error: '"soon" is not a time: try "in 30m", "14:00" or an ISO date and time' });
});
