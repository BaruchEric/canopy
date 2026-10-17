import { describe, expect, test } from "bun:test";
import type { TriggerEvent, TriggersInfo } from "../../src/core/trigger";
import { eventActs, hookAddress, outcomeLine, triggerSections, triggersBadge } from "./triggers";

const ev = (over: Partial<TriggerEvent>): TriggerEvent => ({
  id: "e1",
  rule: "shop",
  source: "sentry",
  key: "4242",
  short: "SHOP-1A",
  title: "TypeError: boom",
  note: "",
  repoId: "web/shop",
  workflow: "sentry-fix",
  status: "working",
  count: 1,
  firstAt: 1,
  lastAt: 1,
  ...over,
});

const info = (events: TriggerEvent[]): TriggersInfo => ({ rules: [], problems: [], events, keeping: true });

describe("triggerSections", () => {
  test("needs-you first, newest first inside, empty sections left out", () => {
    const sections = triggerSections(
      {
        home: info([ev({ id: "a", status: "merged", lastAt: 5 }), ev({ id: "b", status: "failed", lastAt: 2 }), ev({ id: "c", status: "stopped", lastAt: 9 })]),
        mini: info([ev({ id: "d", status: "working", lastAt: 3 })]),
      },
      ["home", "mini"],
    );
    expect(sections.map((s) => s.key)).toEqual(["needs", "working", "fixed"]);
    expect(sections[0]?.rows.map((r) => r.event.id)).toEqual(["c", "b"]);
    expect(sections[1]?.rows[0]?.backend).toBe("mini");
  });

  test("a hidden backend's events are not shown", () => {
    expect(triggerSections({ mini: info([ev({})]) }, ["home"])).toEqual([]);
  });
});

describe("outcomeLine", () => {
  test("a merge says whether Sentry heard", () => {
    expect(outcomeLine(ev({ status: "merged", resolved: { at: 3 } }))).toBe("Resolved in Sentry");
    expect(outcomeLine(ev({ status: "merged" }))).toContain("no token");
    expect(outcomeLine(ev({ status: "merged", resolved: { error: "Sentry answered 403" } }))).toContain("403");
    expect(outcomeLine(ev({ status: "merged", source: "manual" }))).toContain("test fire");
  });
  test("otherwise the reason, or nothing", () => {
    expect(outcomeLine(ev({ status: "stopped", reason: "a restart cut the run short" }))).toBe("a restart cut the run short");
    expect(outcomeLine(ev({ status: "working" }))).toBeNull();
  });
});

describe("eventActs", () => {
  test("by state", () => {
    expect(eventActs(ev({ status: "working" }))).toEqual(["stop"]);
    expect(eventActs(ev({ status: "queued" }))).toEqual(["stop"]);
    expect(eventActs(ev({ status: "stopped", branch: "br" }))).toEqual(["resume", "dismiss"]);
    expect(eventActs(ev({ status: "stopped" }))).toEqual(["retry", "dismiss"]);
    expect(eventActs(ev({ status: "failed" }))).toEqual(["retry", "dismiss"]);
    expect(eventActs(ev({ status: "merged" }))).toEqual(["dismiss"]);
  });
});

describe("triggersBadge", () => {
  test("counts what needs Eric, else what is going", () => {
    expect(triggersBadge({ home: info([ev({ status: "failed" }), ev({ status: "working" })]) })).toMatchObject({ text: "1", tone: "rust" });
    expect(triggersBadge({ home: info([ev({ status: "working" }), ev({ status: "queued" })]) })).toMatchObject({ text: "2", tone: "sky" });
    expect(triggersBadge({ home: info([ev({ status: "merged" })]) })).toBeNull();
  });
});

test("hookAddress joins the origin and the hook's path", () => {
  expect(hookAddress("https://canopy.beric.ca/", "/api/hooks/sentry/shop")).toBe("https://canopy.beric.ca/api/hooks/sentry/shop");
});
