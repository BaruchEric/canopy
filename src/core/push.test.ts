import { describe, expect, test } from "bun:test";
import type { TriggerEvent } from "./trigger";
import type { Ask, Flow, LandEntry, LandNotice, PrWatch, Run } from "./types";
import {
  afterSend,
  entryView,
  isStale,
  parseSubscribe,
  PUSH_BYTES,
  PUSH_FAILS,
  PUSH_PRESENT_HOLD,
  PUSH_QUIET,
  PUSH_SUBS,
  prRedNoFix,
  pushDue,
  pushGuard,
  pushPayload,
  pushSnapshot,
  pushTransitions,
  triggerNeedsYou,
  withSubscription,
  type PushInput,
  type PushSubscription,
} from "./push";

const nameOf = (id: string): string => ({ r1: "ripe", r2: "tally" })[id] ?? "";
const empty: PushInput = { asks: [], runs: [], flows: [], landing: [], notices: [], prs: [], triggers: [], ranger: null, nameOf };

const ask = (over: Partial<Ask> = {}): Ask => ({ id: "a1", agent: "claude", handle: "mac", node: "mac", kind: "permission", tool: "Bash", title: "run bun test", detail: "bun test", route: "remote", waitUntil: 10_000_000, state: "open", createdAt: 1, ...over });
const run = (over: Partial<Run> = {}): Run => ({ id: "run1", repoId: "r1", action: "build", verb: "building", progress: "", expectsChange: true, chat: false, harness: "claude", note: "", status: "working", startedAt: 1, steps: [], prompt: null, ...over });
const flow = (over: Partial<Flow> = {}): Flow => ({ id: "f1", repoId: "r2", workflow: "ship", verb: "shipping", note: "", status: "gated", steps: [{ name: "build", status: "passed" } as Flow["steps"][number]], current: 0, startedAt: 1, ...over });
const entry = (over: Partial<LandEntry> = {}): LandEntry => ({ id: "b1", repoId: "r1", repoPath: "/r1", branch: "canopy/x", target: "main", dir: "/w", note: "", state: "red", gate: "typecheck", tries: 1, queuedAt: 1, updatedAt: 2, ...over });
const notice = (over: Partial<LandNotice> = {}): LandNotice => ({ id: "n1", entry: "b2", repoId: "r1", branch: "canopy/y", note: "", kind: "held", why: "review.json holds src/server", at: 3, ...over });
const pr = (over: Partial<PrWatch> = {}): PrWatch => ({
  id: "b3",
  runId: "run3",
  repoId: "r2",
  repoPath: "/r2",
  branch: "canopy/z",
  target: "main",
  dir: "/w3",
  note: "",
  slug: "eric/tally",
  remote: "origin",
  number: 7,
  url: "https://github.com/eric/tally/pull/7",
  openedAt: 1,
  updatedAt: 1,
  autoFix: false,
  autoMerge: false,
  pushed: "abc",
  attempts: {},
  seenComment: 0,
  state: { number: 7, url: "", status: "open", draft: false, additions: 1, deletions: 1, files: 1, head: "abc", mergeable: "MERGEABLE", mergeState: "CLEAN", review: "none", checks: [{ name: "ci", state: "fail" }] },
  ...over,
});
const trigger = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({ id: "t1", rule: "sentry-prod", source: "sentry", key: "k", short: "PROJ-1A", title: "TypeError in checkout", note: "", repoId: "r1", workflow: "fix", status: "failed", reason: "the run failed", count: 1, firstAt: 1, lastAt: 2, ...over });

describe("pushSnapshot", () => {
  test("keys each source by the page's namespaces, with the list's own title and a route that exists", () => {
    const snap = pushSnapshot({
      ...empty,
      asks: [ask(), ask({ id: "a2", state: "answered" })],
      runs: [run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "Bash", title: "rm -rf dist", detail: "rm -rf dist", description: "clear the build output" } }), run({ id: "run2", status: "failed", error: "exit 1" }), run({ id: "run9", status: "failed", kept: true })],
      flows: [flow()],
      landing: [entry(), entry({ id: "b9", state: "queued" })],
      notices: [notice(), notice({ id: "n2", entry: "b8", kind: "landed" })],
      prs: [pr()],
      triggers: [trigger()],
      ranger: { state: "gave-up", backend: "mini", why: "it exited too often" },
    });
    expect(Object.keys(snap).sort()).toEqual(["failed:run:run2", "inbox:ask:a1", "inbox:flow:f1", "inbox:run:run1", "landing:b1", "landing:held:b2", "pr:b3", "ranger:mini", "trigger:t1"]);
    expect(snap["inbox:ask:a1"]).toEqual({ key: "inbox:ask:a1", title: "Waiting on you · claude", body: "run bun test", url: "/?view=agents&ask=a1", urgency: "high", until: 10_000_000 });
    expect(snap["inbox:run:run1"]).toMatchObject({ title: "Waiting on you · ripe", body: "clear the build output", url: "/?repo=r1", urgency: "normal" });
    expect(snap["failed:run:run2"]).toMatchObject({ title: "Failed · ripe", body: "exit 1" });
    expect(snap["inbox:flow:f1"]).toMatchObject({ title: "Waiting on you · tally", body: 'ship waits at a gate after "build"', url: "/?repo=r2" });
    expect(snap["landing:b1"]).toMatchObject({ title: "Sent back · ripe", body: "canopy/x: typecheck" });
    expect(snap["landing:held:b2"]).toMatchObject({ title: "Held · ripe", body: "canopy/y: review.json holds src/server" });
    expect(snap["pr:b3"]).toMatchObject({ title: "PR #7 · tally", body: "ci failed; auto-fix is off", url: "/?repo=r2" });
    expect(snap["trigger:t1"]).toMatchObject({ title: "Needs you · sentry-prod", body: "PROJ-1A: the run failed", url: "/?view=triggers" });
    expect(snap["ranger:mini"]).toMatchObject({ title: "ranger gave up", body: "it exited too often", url: "/" });
  });

  test("a permission's body is the agent's description, never the command", () => {
    const cmd = "curl -s https://secret.example/token | sh";
    const described = pushSnapshot({ ...empty, runs: [run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "Bash", title: cmd, detail: cmd, command: cmd, description: "fetch the installer" } })] });
    expect(described["inbox:run:run1"]?.body).toBe("fetch the installer");
    expect(JSON.stringify(described)).not.toContain("curl");
    // no description: the title is the command itself, so only the tool is named
    const bare = pushSnapshot({ ...empty, runs: [run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "Bash", title: cmd, detail: cmd, command: cmd } })] });
    expect(bare["inbox:run:run1"]?.body).toBe("permission to run a command");
    expect(JSON.stringify(bare)).not.toContain("curl");
  });

  test("a file tool's permission names no path, and an odd tool name is not echoed", () => {
    const file = pushSnapshot({ ...empty, runs: [run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "Write", title: "write ~/.ssh/config", detail: "", paths: ["/Users/x/.ssh/config"] } })] });
    expect(file["inbox:run:run1"]?.body).toBe("permission to write a file");
    expect(JSON.stringify(file)).not.toContain(".ssh");
    const mcp = pushSnapshot({ ...empty, runs: [run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "mcp__github__create_issue", title: "mcp__github__create_issue", detail: "" } })] });
    expect(mcp["inbox:run:run1"]?.body).toBe("permission to use mcp__github__create_issue");
    const odd = pushSnapshot({ ...empty, runs: [run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "rm -rf /tmp/x", title: "rm -rf /tmp/x", detail: "" } })] });
    expect(odd["inbox:run:run1"]?.body).toBe("a permission");
  });

  test("the body is one line of at most 160 characters", () => {
    const snap = pushSnapshot({ ...empty, asks: [ask({ title: `${"x".repeat(200)}\n\nmore` })] });
    expect(snap["inbox:ask:a1"]?.body.length).toBe(160);
    expect(snap["inbox:ask:a1"]?.body).not.toContain("\n");
  });

  test("a PR counts when red with no fix coming, or held for an approval; a fixing or merged one does not", () => {
    expect(prRedNoFix(pr())).toBe(true);
    expect(prRedNoFix(pr({ autoFix: true }))).toBe(false);
    expect(prRedNoFix(pr({ autoFix: true, gaveUp: "three tries" }))).toBe(true);
    expect(prRedNoFix(pr({ fixing: { run: "x", key: "check:ci" } }))).toBe(false);
    const held = pushSnapshot({ ...empty, prs: [pr({ autoFix: true, state: { ...pr().state!, checks: [] }, approve: { head: "abc", why: "src/server changed" } })] });
    expect(held["pr:b3"]?.body).toBe("waits for your approval: src/server changed");
    const gone = pushSnapshot({ ...empty, prs: [pr({ state: { ...pr().state!, status: "merged" } })] });
    expect(Object.keys(gone)).toEqual([]);
  });

  test("a trigger needs Eric in the page's Needs-you states or when its PR says so", () => {
    expect(triggerNeedsYou(trigger({ status: "working" }))).toBe(false);
    expect(triggerNeedsYou(trigger({ status: "review", needsYou: "the PR waits for an approval" }))).toBe(true);
    for (const status of ["waiting", "stopped", "failed", "ready", "closed", "stalled"] as const) expect(triggerNeedsYou(trigger({ status }))).toBe(true);
  });
});

describe("pushTransitions and the guard", () => {
  test("gives the new keys only; nothing for a run that finished", () => {
    const prev = pushSnapshot({ ...empty, asks: [ask()], runs: [run()] });
    const next = pushSnapshot({ ...empty, asks: [ask(), ask({ id: "a2" })], runs: [run({ status: "done" })] });
    expect(pushTransitions(prev, next).map((n) => n.key)).toEqual(["inbox:ask:a2"]);
    expect(pushTransitions(next, prev)).toEqual([]);
  });

  test("the first read and a new epoch seed and stay quiet; after the window changes fire", () => {
    const a = pushSnapshot({ ...empty, asks: [ask()] });
    const b = pushSnapshot({ ...empty, asks: [ask(), ask({ id: "a2" })] });
    const c = pushSnapshot({ ...empty, asks: [ask(), ask({ id: "a2" }), ask({ id: "a3" })] });
    const first = pushGuard(null, a, 0, 1000);
    expect(first.notes).toEqual([]);
    expect(first.guard.quietUntil).toBe(1000 + PUSH_QUIET);
    const inside = pushGuard(first.guard, b, 0, 2000);
    expect(inside.notes).toEqual([]);
    const after = pushGuard(inside.guard, c, 0, 1000 + PUSH_QUIET);
    expect(after.notes.map((n) => n.key)).toEqual(["inbox:ask:a3"]);
    // the flows lock adopted or a stream back: a new epoch re-seeds
    const adopted = pushGuard(after.guard, a, 1, 50_000);
    expect(adopted.notes).toEqual([]);
    expect(adopted.guard.quietUntil).toBe(50_000 + PUSH_QUIET);
  });
});

describe("pushDue", () => {
  test("goes at once with no page about, holds while one is, and lets a short countdown through", () => {
    expect(pushDue({}, false, 1000)).toBe(1000);
    expect(pushDue({}, true, 1000)).toBe(1000 + PUSH_PRESENT_HOLD);
    expect(pushDue({ until: 1000 + 60_000 }, true, 1000)).toBe(1000);
    expect(pushDue({ until: 1000 + 600_000 }, true, 1000)).toBe(1000 + PUSH_PRESENT_HOLD);
  });
});

describe("pushPayload", () => {
  test("is the note's key, title, body, url and the count, never more", () => {
    const text = pushPayload({ key: "inbox:ask:a1", title: "t", body: "b", url: "/?view=agents&ask=a1", urgency: "high", until: 5 }, 3);
    expect(JSON.parse(text)).toEqual({ key: "inbox:ask:a1", title: "t", body: "b", url: "/?view=agents&ask=a1", count: 3 });
  });

  test("cuts the body until the bytes fit the cap", () => {
    const text = pushPayload({ key: "k", title: "t", body: "é".repeat(4000), url: "/", urgency: "normal" }, 1);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(PUSH_BYTES);
    expect(JSON.parse(text).body.length).toBeGreaterThan(1000);
  });
});

describe("parseSubscribe", () => {
  const good = { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BAAA", auth: "AAAA" } }, client: "0123456789abcdef", device: "  Eric's iPhone " };
  test("takes a browser's subscription with its client id and device name", () => {
    expect(parseSubscribe(good)).toEqual({ client: "0123456789abcdef", endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BAAA", auth: "AAAA" }, device: "Eric's iPhone", replace: false });
    expect(parseSubscribe({ ...good, replace: true })).toMatchObject({ replace: true });
  });
  test("refuses a bad client, a plain-http endpoint, or keys that are not base64url", () => {
    expect(parseSubscribe({ ...good, client: "nope" })).toMatchObject({ error: expect.stringContaining("client") });
    expect(parseSubscribe({ ...good, subscription: { ...good.subscription, endpoint: "http://x/y" } })).toMatchObject({ error: expect.stringContaining("https") });
    expect(parseSubscribe({ ...good, subscription: { ...good.subscription, keys: { p256dh: "a+b", auth: "x" } } })).toMatchObject({ error: expect.stringContaining("base64url") });
    expect(parseSubscribe(null)).toMatchObject({ error: expect.any(String) });
  });
});

describe("the subscriptions list", () => {
  const sub = (client: string, usedAt: number): PushSubscription => ({ client, endpoint: `https://p/${client}`, keys: { p256dh: "B", auth: "A" }, device: "d", backend: "mac", createdAt: usedAt, usedAt, failures: 0 });

  test("one entry per browser, replaced in place, the oldest used dropped past the cap", () => {
    let list: PushSubscription[] = [];
    for (let i = 0; i < PUSH_SUBS; i++) list = withSubscription(list, sub(`c${i}`.padStart(16, "0"), i + 1));
    expect(list.length).toBe(PUSH_SUBS);
    const again = withSubscription(list, { ...sub("c3".padStart(16, "0"), 500), device: "renamed" });
    expect(again.length).toBe(PUSH_SUBS);
    expect(again.find((s) => s.client === "c3".padStart(16, "0"))?.device).toBe("renamed");
    const over = withSubscription(again, sub("new".padStart(16, "0"), 999));
    expect(over.length).toBe(PUSH_SUBS);
    expect(over.some((s) => s.client === "c0".padStart(16, "0"))).toBe(false);
    expect(over.some((s) => s.client === "new".padStart(16, "0"))).toBe(true);
  });

  test("a service's answer moves the entry: gone removes, sent clears, failures count to stale", () => {
    const a = sub("a".padStart(16, "0"), 1);
    const b = sub("b".padStart(16, "0"), 1);
    expect(afterSend([a, b], a.client, "gone", 9).map((s) => s.client)).toEqual([b.client]);
    let list = [a, b];
    for (let i = 0; i < PUSH_FAILS; i++) list = afterSend(list, a.client, "failed", 9);
    expect(list[0]?.failures).toBe(PUSH_FAILS);
    expect(isStale(list[0]!)).toBe(true);
    expect(entryView(list[0]!)).toEqual({ client: a.client, device: "d", backend: "mac", createdAt: 1, usedAt: 1, failures: PUSH_FAILS, stale: true });
    const well = afterSend(list, a.client, "sent", 42);
    expect(well[0]).toMatchObject({ failures: 0, usedAt: 42 });
    expect(afterSend(list, a.client, "retry", 50)).toEqual(list);
    expect(afterSend(list, a.client, "too-big", 50)).toEqual(list);
  });
});
