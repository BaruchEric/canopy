import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuickNote } from "../../../src/core/notes";
import { DEFAULT_SWEEP } from "../../../src/core/sweep";
import { parseRules, type TriggerRuleInfo } from "../../../src/core/trigger";
import type { RangerInfo, RangerWake, SweepInfo } from "../../../src/core/types";
import { registry, setRegistry } from "../registry";
import { useStore, type CanopyState } from "../store";
import { ClockView } from "./Clock";

// bun pins a test's clock to UTC, so "local" below is UTC: a Tuesday at noon
const at = (iso: string): number => new Date(`${iso}:00Z`).getTime();
const NOW = at("2026-11-10T12:00");

const pristine = useStore.getState();
const originalRegistry = registry();

beforeEach(() => {
  setSystemTime(new Date(NOW));
});
afterEach(() => {
  setSystemTime();
  useStore.setState(pristine);
  setRegistry(originalRegistry.home, [...originalRegistry.names]);
});

const wake = (over: Partial<RangerWake>): RangerWake => ({ id: "aaaa0001", by: "eric", prompt: "Morning brief. Read the inbox, then say what needs me first.", created: at("2026-11-01T00:00"), ...over });

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

const sweep = (on: boolean): SweepInfo => ({ items: [], settings: { ...DEFAULT_SWEEP, on, cron: "0 4 * * *" }, lastRun: null, swept: { shells: [], chats: [] }, ask: null });

const note = (over: Partial<QuickNote>): QuickNote => ({ id: "mac|n-aaaaaaaa", text: "Call the bank: ask about the wire", createdAt: NOW - 3_600_000, ...over });

function render(state: Partial<CanopyState>): string {
  setRegistry("mac", ["mac"]);
  useStore.setState({ home: "mac", backendOrder: ["mac"], rangers: {}, triggers: {}, sweep: null, quickNotes: {}, ...state });
  const initial = useStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, useStore.getState());
  try {
    return renderToStaticMarkup(<ClockView />);
  } finally {
    Object.assign(initial, previous);
  }
}

/** the rows as the page lists them: each one's words, with the tags out */
const rowsOf = (html: string): string[] => [...html.matchAll(/<li class="clock-row[^"]*">(.*?)<\/li>/g)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

test("every kind of job is a row, soonest first, and the page leads with the next one that does something", () => {
  const html = render({
    rangers: {
      mac: ranger({
        settings: { on: true, profile: null, handle: null, telegram: false, fresh: { daily: "05:30", maxMb: null }, home: "own" },
        wakes: [wake({ cron: "0 9 * * 1-5", next: at("2026-11-11T09:00") }), wake({ id: "aaaa0002", by: "run", from: "r-1", prompt: "Look at the deploy.", at: NOW + 47 * 60_000, next: NOW + 47 * 60_000 })],
      }),
    },
    triggers: {
      mac: {
        rules: [rule({ name: "bump-deps", source: "schedule", cron: "0 3 * * 1", repo: "*" }, { next: at("2026-11-16T03:00") }), rule({ name: "tracker", source: "github", repo: "web/shop", labels: ["canopy"] }, { nextFire: NOW + 6 * 60_000 })],
        events: [],
        problems: [],
        keeping: true,
      },
    },
    sweep: sweep(true),
    quickNotes: { mac: [note({ due: NOW + 3 * 3_600_000 })] },
  });
  expect(rowsOf(html)).toEqual([
    "tracker Every 15 minutes issue poll in 6 min 12:06",
    "Look at the deploy Once a run&#x27;s wake in 47 min 12:47",
    "Call the bank Once reminder in 3 h 15:00",
    "Sweep what went idle Every day at 04:00 sweep in 16 h tomorrow 04:00",
    "A fresh conversation for the ranger Every day at 05:30 ranger in 17 h 30 min tomorrow 05:30",
    "Morning brief Weekdays at 09:00 your wake in 21 h tomorrow 09:00",
    "bump-deps Mondays at 03:00 schedule rule in 6 days Mon 03:00",
  ]);
  // a poll that runs every few minutes is always soonest, and says nothing: the wake leads
  expect(html).toContain("Look at the deploy is next, in 47 min.");
  expect(html).toContain('<span class="clock-axis-now"');
  expect(html).not.toContain("held until it can be delivered");
});

test("a lane draws a bar where a line fires, a diamond for a one-time job, and a hatch where the fires run together", () => {
  const html = render({
    rangers: { mac: ranger({ wakes: [wake({ cron: "0 9 * * *", next: at("2026-11-11T09:00") }), wake({ id: "aaaa0002", prompt: "Once.", at: NOW + 3_600_000, next: NOW + 3_600_000 }), wake({ id: "aaaa0003", prompt: "Often.", cron: "*/2 * * * *", next: NOW + 120_000 })] }) },
  });
  const lanes = [...html.matchAll(/<div class="clock-lane"[^>]*>(.*?)<\/div>/g)].map((m) => m[1] ?? "");
  expect(lanes).toHaveLength(3);
  const [often, once, daily] = lanes;
  expect(often).toContain('class="clock-band"');
  // the next fire stands at the head of the band it falls in
  expect(often).toContain('class="clock-tick coming"');
  expect(once).toContain('class="clock-tick once coming"');
  expect(daily?.match(/class="clock-tick coming"/g)).toHaveLength(1);
  expect(daily).not.toContain("once");
});

test("a wake whose ranger is not running is held, and a rule that cannot fire says so", () => {
  const html = render({
    rangers: { mac: ranger({ state: "backoff", wakes: [wake({ cron: "0 9 * * 1-5", next: at("2026-11-11T09:00") })] }) },
    triggers: { mac: { rules: [rule({ name: "audit", source: "schedule", cron: "40 1 * * *", repo: "gone" }, { problem: "no repo gone in the tree" })], events: [], problems: [], keeping: true } },
  });
  expect(html).toContain('<li class="clock-row held">');
  expect(html).toContain('<li class="clock-row broken">');
  expect(rowsOf(html)).toEqual(["Morning brief Weekdays at 09:00 your wake in 21 h held", "audit Every day at 01:40 schedule rule cannot fire"]);
  expect(html).toContain("Nothing here will fire as things stand.");
  expect(html).toContain("held until it can be delivered");
});

test("with nothing on the clock the page says what goes there, and a wake needs a ranger", () => {
  const none = render({});
  expect(none).toContain("Nothing is on the clock.");
  expect(none).toContain("A wake is a prompt a ranger is sent");
  expect(none).not.toContain("clock-board");
  expect(none.match(/<button[^>]*>new wake<\/button>/)?.[0]).toContain("disabled");
  const withRanger = render({ rangers: { mac: ranger() } });
  expect(withRanger.match(/<button[^>]*>new wake<\/button>/)?.[0]).not.toContain("disabled");
});
