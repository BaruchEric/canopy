import { describe, expect, test } from "bun:test";
import type { TriggerEvent, TriggerRuleInfo, TriggersInfo } from "../../src/core/trigger";
import { eventActs, hookAddress, nextFireWord, outcomeLine, pollWords, ruleIntake, ruleWrites, scheduleWord, statusWord, STATUS_WORD, triggerSections, triggersBadge } from "./triggers";

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

describe("schedule card (FR-041)", () => {
  test("queue readiness and badge text identify the landing queue", () => {
    expect(statusWord(ev({ status: "ready", land: "queue" }))).toBe("in the landing queue");
    expect(statusWord(ev({ status: "ready" }))).toBe("committed, no PR");
    expect(statusWord(ev({ status: "working", land: "queue" }))).toBe("fixing");
    expect(triggersBadge({ home: info([ev({ status: "ready", land: "queue" })]) })?.title).toContain("in the landing queue");
  });
  test("schedule words name the targets and all filters", () => {
    expect(scheduleWord({ repo: "*", only: [] }, "")).toBe("every local repo");
    expect(scheduleWord({ repo: "*", only: ["spec-adopted"] }, "")).toBe("every local repo with a spec");
    expect(scheduleWord({ repo: "*", only: ["clean", "unpushed"] }, "")).toBe("every local repo with a clean tree, with unpushed commits");
    expect(scheduleWord({ repo: "web/shop", only: ["dirty"] }, "shop")).toBe("shop with changes");
  });
  test("next fire uses explicit dates and handles due or impossible schedules", () => {
    const now = Date.parse("2026-11-02T05:00:00Z");
    expect(nextFireWord(undefined, now)).toBe("never fires again");
    expect(nextFireWord(now - 1, now)).toBe("due now");
    expect(nextFireWord(now + 40 * 60_000, now)).toBe("next fire in 40 min");
    expect(nextFireWord(now + 2 * 3_600_000 + 1, now)).toBe("next fire in 2 h");
    expect(nextFireWord(now + 7 * 86_400_000, now)).toBe("next fire in 7 days");
  });
  test("schedule landing never describes an outside issue or a test fire", () => {
    expect(outcomeLine(ev({ service: "schedule", status: "merged", land: "queue" }))).toBe("landed on main through the queue");
    expect(outcomeLine(ev({ service: "schedule", source: "manual", status: "merged", land: "queue" }))).toBe("landed on main through the queue");
    expect(outcomeLine(ev({ service: "schedule", status: "merged", land: "pr", pr: { number: 1, url: "u" } }))).toBeNull();
    expect(outcomeLine(ev({ service: "schedule", status: "ready", land: "queue", reason: "needs your approval: 1 sensitive file" }))).toBe("needs your approval: 1 sensitive file");
  });
});

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

describe("needs you and the rebase states", () => {
  test("an event with needsYou is in Needs you whatever its status, and rebasing and conflict are Working", () => {
    const needy = ev({ id: "n", status: "review", needsYou: "auto-fix gave up: x", lastAt: 4 });
    const sections = triggerSections({ home: info([needy, ev({ id: "r", status: "rebasing", lastAt: 3 }), ev({ id: "c", status: "conflict", lastAt: 2 })]) }, ["home"]);
    expect(sections.map((s) => [s.key, s.rows.map((r) => r.event.id)])).toEqual([
      ["needs", ["n"]],
      ["working", ["r", "c"]],
    ]);
    expect(STATUS_WORD.rebasing).toBe("rebasing onto main");
    expect(STATUS_WORD.conflict).toBe("fixing a rebase conflict");
    expect(outcomeLine(needy)).toBe("auto-fix gave up: x");
    expect(outcomeLine(ev({ status: "review", needsYou: "y", linked: { error: "nope" } }))).toBe("y");
    expect(triggersBadge({ home: info([needy, ev({ id: "r", status: "rebasing" })]) })).toMatchObject({ text: "1", tone: "rust", title: "SHOP-1A: auto-fix gave up: x" });
    expect(triggersBadge({ home: info([ev({ id: "r", status: "rebasing" }), ev({ id: "c", status: "conflict" })]) })).toMatchObject({ text: "2", tone: "sky" });
  });
});

describe("outcomeLine", () => {
  test("a merge says whether Sentry heard", () => {
    expect(outcomeLine(ev({ status: "merged", resolved: { at: 3 } }))).toBe("Resolved in Sentry");
    expect(outcomeLine(ev({ status: "merged" }))).toContain("no token");
    expect(outcomeLine(ev({ status: "merged", resolved: { error: "Sentry answered 403" } }))).toContain("403");
    expect(outcomeLine(ev({ status: "merged", source: "manual" }))).toContain("test fire");
  });
  test("a Linear event names Linear, its move to done and a refused link", () => {
    const lin = (over: Partial<TriggerEvent>) => ev({ source: "linear", service: "linear", short: "ENG-7", ...over });
    expect(outcomeLine(lin({ status: "merged", resolved: { at: 3 } }))).toBe("Moved to done in Linear");
    expect(outcomeLine(lin({ status: "merged" }))).toBe("merged; the rule holds no token, so the issue stays open in Linear");
    expect(outcomeLine(lin({ status: "merged", resolved: { error: "Linear answered 401" } }))).toBe("merged, but Linear refused the move to done: Linear answered 401");
    expect(outcomeLine(lin({ status: "merged", source: "manual" }))).toBe("a test fire, so Linear was not told");
    expect(outcomeLine(lin({ status: "review", linked: { error: "Linear answered 401" } }))).toBe("Linear refused the PR's link: Linear answered 401");
    expect(outcomeLine(lin({ status: "review", linked: { at: 3 } }))).toBeNull();
  });
  test("a GitHub or Forgejo event names its service: the close, a refused close, a refused comment", () => {
    const gh = (over: Partial<TriggerEvent>) => ev({ source: "github", service: "github", short: "#12", ...over });
    expect(outcomeLine(gh({ status: "merged", resolved: { at: 3 } }))).toBe("Closed in GitHub");
    expect(outcomeLine(gh({ status: "merged", service: "forgejo", source: "forgejo", resolved: { at: 3 } }))).toBe("Closed in Forgejo");
    expect(outcomeLine(gh({ status: "merged" }))).toBe("merged; the rule does not write back, so the issue stays open in GitHub");
    expect(outcomeLine(gh({ status: "merged", resolved: { error: "HTTP 403: Forbidden" } }))).toBe("merged, but GitHub refused the close: HTTP 403: Forbidden");
    expect(outcomeLine(gh({ status: "review", linked: { error: "HTTP 403: Forbidden" } }))).toBe("GitHub refused the PR's link: HTTP 403: Forbidden");
    expect(outcomeLine(gh({ status: "merged", source: "manual" }))).toBe("a test fire, so GitHub was not told");
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

const rule = (over: Partial<TriggerRuleInfo>): TriggerRuleInfo => ({
  name: "tracker",
  land: "pr",
  only: [],
  source: "github",
  repo: "web/shop",
  workflow: "issue-fix",
  projects: [],
  levels: [],
  labels: ["canopy"],
  ignore: [],
  api: "https://api.github.com",
  hook: "/api/hooks/github/tracker",
  secretSet: false,
  tokenSet: false,
  agentSet: false,
  ...over,
});

describe("ruleIntake", () => {
  test("a rule with a hook secret shows the hook's address; one without says how often it polls", () => {
    expect(ruleIntake(rule({ secretEnv: "CANOPY_TRIGGER_GH_HOOK", secretSet: true }), "https://canopy.beric.ca/")).toEqual({ hook: "https://canopy.beric.ca/api/hooks/github/tracker", poll: null });
    expect(ruleIntake(rule({ poll: "*/15 * * * *" }), "https://canopy.beric.ca")).toEqual({ hook: null, poll: "polls every 15 min" });
    // a hook with a poll line as its safety net shows both
    expect(ruleIntake(rule({ secretEnv: "CANOPY_TRIGGER_GH_HOOK", poll: "0 9 * * 1-5" }), "http://mini:7850")).toEqual({ hook: "http://mini:7850/api/hooks/github/tracker", poll: "polls on 0 9 * * 1-5" });
  });

  test("pollWords reads the common lines", () => {
    expect(pollWords("*/5 * * * *")).toBe("polls every 5 min");
    expect(pollWords("* * * * *")).toBe("polls every minute");
    expect(pollWords("0 * * * *")).toBe("polls every hour");
    expect(pollWords("0 */2 * * *")).toBe("polls every 2 hours");
    expect(pollWords("30 6 * * *")).toBe("polls on 30 6 * * *");
  });
});

describe("ruleWrites", () => {
  test("a GitHub or Forgejo rule writes back unless write is false", () => {
    expect(ruleWrites(rule({ write: true }))).toEqual({ on: true, words: "writes back to GitHub", why: expect.stringContaining("closes it once the PR merges") });
    expect(ruleWrites(rule({ write: false }))).toMatchObject({ on: false, words: "leaves issues open in GitHub" });
    expect(ruleWrites(rule({ source: "forgejo", write: true }))).toMatchObject({ on: true, words: "writes back to Forgejo", why: expect.stringContaining("once its branch lands") });
  });

  test("a Sentry or Linear rule writes with its token or the app's", () => {
    expect(ruleWrites(rule({ source: "sentry" }))).toMatchObject({ on: false, words: "leaves issues open in Sentry" });
    expect(ruleWrites(rule({ source: "sentry", tokenSet: true }))).toMatchObject({ on: true, words: "resolves in Sentry" });
    expect(ruleWrites(rule({ source: "linear", agentSet: true }))).toMatchObject({ on: true, words: "writes back to Linear" });
  });
});
