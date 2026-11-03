import { describe, expect, test } from "bun:test";
import type { TriggerEvent } from "../../src/core/trigger";
import type { LandEntry, LandingInfo, LandingRun } from "../../src/core/types";
import type { WorkItem } from "../../src/core/work";
import { CLOSED_DAYS, lastNotes, needsOf, onRepo, reposOf, searchWork, workBadge, workRows, workSections, type WorkFacts } from "./work";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 12, 0);
const qual = (backend: string, id: string): string => (backend === "mac" ? id : `${backend}:${id}`);

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "w-testaaaa",
  title: "Add a test",
  repos: ["dev-tools/canopy"],
  state: "open",
  from: { kind: "note" },
  runs: ["r1"],
  branches: ["b1"],
  prs: [],
  events: [],
  notes: [{ at: NOW - DAY, by: "canopy", text: "branch ready" }],
  createdAt: NOW - 2 * DAY,
  updatedAt: NOW - DAY,
  ...over,
});

const rec = (over: Partial<LandingRun> = {}): LandingRun => ({
  id: "b1",
  work: "w-testaaaa",
  runId: "r1",
  repoId: "dev-tools/canopy",
  repoPath: "/w/canopy",
  branch: "run/w-testaaaa-add-a-test",
  target: "main",
  base: "abc",
  dir: "/w/x",
  note: "add a test",
  verb: "Ask",
  harness: "claude",
  state: "ready",
  startedAt: 1,
  ...over,
});

const entry = (over: Partial<LandEntry> = {}): LandEntry => ({
  id: "b1",
  repoId: "dev-tools/canopy",
  repoPath: "/w/canopy",
  branch: "run/w-testaaaa-add-a-test",
  target: "main",
  dir: "/w/x",
  note: "add a test",
  state: "conflict",
  tries: 1,
  queuedAt: 1,
  updatedAt: 2,
  ...over,
});

const landing = (over: Partial<LandingInfo> = {}): LandingInfo => ({ runs: [], entries: [], orphans: [], ...over });

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  id: "e1",
  rule: "sentry-fix",
  source: "hook",
  key: "k",
  title: "t",
  repoId: "dev-tools/canopy",
  status: "review",
  note: "n",
  firstAt: 1,
  lastAt: 2,
  count: 1,
  ...over,
} as TriggerEvent);

const facts = (over: Partial<WorkFacts> = {}): WorkFacts => ({ landing: {}, triggers: {}, qual, ...over });

describe("needsOf", () => {
  test("a branch sent back with no fix going", () => {
    const f = facts({ landing: { mac: landing({ entries: [entry({ reason: "conflict in 2 files" })] }) } });
    expect(needsOf("mac", item(), f)).toBe("sent back: conflict in 2 files");
    expect(needsOf("mac", item(), facts({ landing: { mac: landing({ entries: [entry({ fixing: "fix1" })] }) } }))).toBeNull();
    expect(needsOf("mac", item(), facts({ landing: { mac: landing({ entries: [entry({ state: "queued" })] }) } }))).toBeNull();
  });
  test("a ready branch whose sort says approve, unless it is queued or went to a PR", () => {
    const sorted = rec({ review: { verdict: "approve", files: [], base: "abc", head: "def", at: 3 } });
    expect(needsOf("mac", item(), facts({ landing: { mac: landing({ runs: [sorted] }) } }))).toBe("its sort says approve: look and land");
    expect(needsOf("mac", item(), facts({ landing: { mac: landing({ runs: [{ ...sorted, pr: 7 }] }) } }))).toBeNull();
    expect(needsOf("mac", item(), facts({ landing: { mac: landing({ runs: [sorted], entries: [entry({ state: "queued" })] }) } }))).toBeNull();
    expect(needsOf("mac", item(), facts({ landing: { mac: landing({ runs: [rec()] }) } }))).toBeNull();
  });
  test("a trigger event that says what it needs, matched under the page's ids on another backend", () => {
    const f = facts({ triggers: { mini: { events: [event({ id: "mini:e1", needsYou: "the PR waits for a review" })] } } });
    expect(needsOf("mini", item({ events: ["e1"] }), f)).toBe("the PR waits for a review");
    expect(needsOf("mini", item({ events: ["e2"] }), f)).toBeNull();
    expect(needsOf("mac", item({ events: ["e1"] }), f)).toBeNull();
  });
  test("a closed item never needs anyone", () => {
    const f = facts({ landing: { mac: landing({ entries: [entry()] }) } });
    expect(needsOf("mac", item({ state: "dropped", closedAt: NOW }), f)).toBeNull();
  });
});

describe("workRows and workSections", () => {
  const work = {
    mac: { items: [item(), item({ id: "w-testbbbb", title: "Working one", state: "working" as const, branches: ["b2"], updatedAt: NOW }), item({ id: "w-testcccc", title: "Old", state: "landed" as const, branches: ["b3"], closedAt: NOW - (CLOSED_DAYS + 1) * DAY })], archived: 0 },
    mini: { items: [item({ id: "w-testdddd", title: "Reviewed", state: "review" as const, repos: ["apps/orchard"], updatedAt: NOW - 2 * DAY }), item({ id: "w-testeeee", title: "Landed", state: "landed" as const, closedAt: NOW - DAY })], archived: 0 },
  };
  const f = facts({ landing: { mac: landing({ entries: [entry({ reason: "gate red" })] }) } });
  test("rows across backends, newest first, with what each needs", () => {
    const rows = workRows(work, ["mac", "mini"], f);
    expect(rows.map((r) => [r.backend, r.item.id, r.needs])).toEqual([
      ["mac", "w-testbbbb", null],
      ["mac", "w-testaaaa", "sent back: gate red"],
      ["mac", "w-testcccc", null],
      ["mini", "w-testeeee", null],
      ["mini", "w-testdddd", null],
    ]);
    expect(workRows(work, ["mini"], f)).toHaveLength(2);
  });
  test("sections: needs you first, then working, review, open, and the closed of the last 30 days folded", () => {
    const sections = workSections(workRows(work, ["mac", "mini"], f), NOW);
    expect(sections.map((s) => [s.key, s.rows.map((r) => r.item.id), s.folded ?? false])).toEqual([
      ["needs", ["w-testaaaa"], false],
      ["working", ["w-testbbbb"], false],
      ["review", ["w-testdddd"], false],
      ["closed", ["w-testeeee"], true],
    ]);
    const open = workSections(workRows(work, ["mac"], facts()), NOW);
    expect(open.map((s) => s.key)).toEqual(["working", "open"]);
  });
  test("the repo filter and the repo list use the page's ids", () => {
    const rows = workRows(work, ["mac", "mini"], f);
    expect(reposOf(rows, qual)).toEqual(["dev-tools/canopy", "mini:dev-tools/canopy", "mini:apps/orchard"]);
    expect(onRepo(rows, "mini:apps/orchard", qual).map((r) => r.item.id)).toEqual(["w-testdddd"]);
    expect(onRepo(rows, null, qual)).toHaveLength(5);
  });
  test("the search is over titles, ids, repos and notes, every word", () => {
    const rows = workRows(work, ["mac", "mini"], f);
    expect(searchWork(rows, "working").map((r) => r.item.id)).toEqual(["w-testbbbb"]);
    expect(searchWork(rows, "branch ready orchard").map((r) => r.item.id)).toEqual(["w-testdddd"]);
    expect(searchWork(rows, "w-testcccc").map((r) => r.item.id)).toEqual(["w-testcccc"]);
    expect(searchWork(rows, "  ")).toHaveLength(5);
    expect(searchWork(rows, "nothing like this")).toEqual([]);
  });
  test("the badge counts what needs Eric, else what is working", () => {
    const rows = workRows(work, ["mac", "mini"], f);
    expect(workBadge(rows)).toEqual({ text: "1", tone: "rust", title: "Add a test: sent back: gate red" });
    expect(workBadge(workRows(work, ["mac"], facts()))).toEqual({ text: "1", tone: "sky", title: "Working one" });
    expect(workBadge(workRows(work, ["mini"], facts()))).toBeNull();
  });
});

test("lastNotes keeps the newest, newest last", () => {
  const notes = [1, 2, 3].map((i) => ({ at: i, by: "canopy", text: `n${i}` }));
  expect(lastNotes({ notes }).map((n) => n.text)).toEqual(["n2", "n3"]);
  expect(lastNotes({ notes: [] })).toEqual([]);
});
