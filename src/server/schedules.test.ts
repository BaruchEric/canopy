import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRules, scheduleEvent, type TriggerEvent } from "../core/trigger";
import type { Repo, Run } from "../core/types";
import { repoKey } from "../core/worktree";
import { TriggerHub, type TriggerDeps } from "./triggers";

const MONDAY = Date.parse("2026-11-02T05:00:00Z");
const HOUR = 3_600_000;
const WEEK = 7 * 86_400_000;
const SHOP: Repo = { id: "web/shop", name: "shop", path: "/dev/web/shop", group: "web", source: "root", status: null };
const BLOG: Repo = { ...SHOP, id: "web/blog", name: "blog", path: "/dev/web/blog" };

let dir: string;
let now: number;
let started: TriggerEvent[];
let runs: Run[];
let hubs: TriggerHub[];

function runFor(event: TriggerEvent): Run {
  return {
    id: `r${runs.length + 1}`, repoId: event.repoId, action: "ask", verb: "fix", progress: "fixing",
    expectsChange: true, chat: false, harness: "claude", note: event.note, status: "working",
    startedAt: now, steps: [], prompt: null,
    branch: { name: `run/${event.id}`, target: "main", base: "base", dir: `/tmp/${event.id}`, state: "working", origin: `br-${event.id}`, work: "w-test2345" },
  };
}

function hub(over: Partial<TriggerDeps> = {}): TriggerHub {
  const h = new TriggerHub({
    broadcast: () => {},
    repo: (ref) => [SHOP, BLOG].find((r) => r.id === ref || r.path === ref),
    repos: () => [SHOP, BLOG],
    workflowProblem: async () => null,
    start: async (event) => {
      started.push(event);
      const run = runFor(event);
      runs.push(run);
      return { run };
    },
    resume: async (event) => ({ run: runFor(event) }),
    stopRun: () => {},
    runKnown: (id) => runs.some((r) => r.id === id),
    env: () => undefined,
    listIssues: async () => [],
    readIssue: async (_rule, _repo, incoming) => incoming,
    reportPoll: () => {},
    writeIssue: async () => {},
    missingFrom: async () => null,
    file: join(dir, "triggers.json"), dir: join(dir, "triggers"), now: () => now,
    ...over,
  });
  hubs.push(h);
  return h;
}

function rules(extra: Record<string, unknown> = {}): Promise<void> {
  return writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [
    { name: "spec-weekly", source: "schedule", cron: "0 5 * * 1", repo: "*", workflow: "spec-converge", ...extra },
  ] }));
}

function endedEvents(at: number): TriggerEvent[] {
  const rule = parseRules(JSON.stringify({ rules: [{ name: "spec-weekly", source: "schedule", cron: "0 5 * * 1", repo: "*", workflow: "spec-converge" }] })).rules[0];
  if (!rule) throw new Error("schedule fixture did not parse");
  return [SHOP, BLOG].map((repo) => ({ ...scheduleEvent(rule, repo, repoKey(repo.path), at, at + 20_000, "schedule"), status: "merged", endedAt: at + 30_000 }));
}

async function save(events: TriggerEvent[]): Promise<void> {
  await mkdir(join(dir, "triggers"), { recursive: true });
  await writeFile(join(dir, "triggers", "events.json"), JSON.stringify({ events }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-schedules-"));
  now = MONDAY - 86_400_000;
  started = [];
  runs = [];
  hubs = [];
  await rules();
});

afterEach(async () => {
  for (const h of hubs) {
    await h.idle();
    h.detach();
    h.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

describe("schedule admission (FR-041)", () => {
  test("first observation waits for the next slot, then persists one event per repo with the scheduled minute", async () => {
    const h = hub();
    await h.adopt();
    await h.idle();
    expect(h.list()).toEqual([]);
    now = MONDAY + 20_000;
    await h.pump();
    expect(h.list().map((e) => [e.repoId, e.key.split("@")[1], e.status, e.source, e.service, e.land]).sort()).toEqual([
      ["web/blog", "2026-11-02T05:00:00.000Z", "working", "schedule", "schedule", "queue"],
      ["web/shop", "2026-11-02T05:00:00.000Z", "working", "schedule", "schedule", "queue"],
    ]);
    now += 70_000;
    await h.pump();
    expect(started).toHaveLength(2);
    expect((await h.info()).rules[0]).toMatchObject({ next: MONDAY + WEEK, lastFire: MONDAY + 20_000, skips: [], secretSet: true });
    expect((await h.info()).rules[0]?.hook).toBeUndefined();
    await h.idle();
    const disk: unknown = JSON.parse(await readFile(join(dir, "triggers", "events.json"), "utf8"));
    expect(disk).toMatchObject({ events: [expect.objectContaining({ service: "schedule" }), expect.objectContaining({ service: "schedule" })] });
  });

  test("a late tick uses the missed minute, rather than shifting the weekly clock", async () => {
    const h = hub();
    await h.adopt();
    await h.idle();
    now = MONDAY + 11 * 60_000;
    await h.pump();
    expect(h.list().map((e) => e.key.split("@")[1])).toEqual(["2026-11-02T05:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
    expect((await h.info()).rules[0]?.next).toBe(MONDAY + WEEK);
  });

  test("restart catches up one missed slot once, and another restart does not repeat it", async () => {
    await save(endedEvents(MONDAY));
    now = MONDAY + WEEK + 2 * HOUR;
    const h = hub();
    await h.adopt();
    await h.idle();
    expect(h.list().filter((e) => e.firstAt === now).map((e) => e.key.split("@")[1])).toEqual(["2026-11-09T07:00:00.000Z", "2026-11-09T07:00:00.000Z"]);
    expect(h.list()).toHaveLength(4);
    h.detach();
    const next = hub();
    await next.adopt();
    await next.idle();
    expect(next.list()).toHaveLength(4);
    expect(started).toHaveLength(2);
  });

  test("restart forgives a missed hourly slot when the next one is under an hour away", async () => {
    await rules({ cron: "0 * * * *" });
    await save(endedEvents(MONDAY - HOUR));
    now = MONDAY + 50 * 60_000;
    const h = hub();
    await h.adopt();
    await h.idle();
    expect(h.list()).toHaveLength(2);
    expect((await h.info()).rules[0]?.next).toBe(MONDAY + HOUR);
    now = MONDAY + HOUR + 5_000;
    await h.pump();
    expect(h.list().filter((e) => e.firstAt === now)).toHaveLength(2);
  });

  test("a bad workflow in one wildcard repo skips only that repo and consumes the slot", async () => {
    const h = hub({ workflowProblem: async (_workflow, repo) => repo.id === SHOP.id ? "shop requires manual mode" : null });
    await h.adopt();
    await h.idle();
    now = MONDAY + 20_000;
    await h.pump();
    expect(h.list().map((e) => e.repoId)).toEqual([BLOG.id]);
    expect((await h.info()).rules[0]?.skips).toEqual([{ repo: "shop", why: "shop requires manual mode", at: MONDAY }]);
    now += 70_000;
    await h.pump();
    expect((await h.info()).rules[0]?.skips).toHaveLength(1);
  });

  test("an all-invalid fire consumes its slot without events or repeated skips", async () => {
    const h = hub({ workflowProblem: async () => "unknown workflow: spec-converge" });
    await h.adopt();
    await h.idle();
    now = MONDAY + 20_000;
    await h.pump();
    expect(h.list()).toEqual([]);
    expect((await h.info()).rules[0]?.skips).toHaveLength(2);
    now += 70_000;
    await h.pump();
    expect((await h.info()).rules[0]?.skips).toHaveLength(2);
    expect((await h.info()).rules[0]?.next).toBe(MONDAY + WEEK);
  });

  test("slot-cap refusal queues events and a later pass admits them without duplication", async () => {
    let full = true;
    const h = hub({ start: async (event) => {
      if (full) return { busy: "three branch runs going" };
      started.push(event);
      const run = runFor(event);
      runs.push(run);
      return { run };
    } });
    await h.adopt();
    await h.idle();
    now = MONDAY + 20_000;
    await h.pump();
    expect(h.list().map((e) => [e.status, e.reason])).toEqual([["queued", "three branch runs going"], ["queued", "three branch runs going"]]);
    full = false;
    await h.pump();
    expect(h.list().map((e) => e.status)).toEqual(["working", "working"]);
    expect(started).toHaveLength(2);
  });

  test("a rule skips its own live repo on the next slot and does not repeat that skip every tick", async () => {
    const h = hub({ repos: () => [SHOP] });
    await h.adopt();
    await h.idle();
    now = MONDAY + 20_000;
    await h.pump();
    now = MONDAY + WEEK + 20_000;
    await h.pump();
    expect(h.list()).toHaveLength(1);
    expect((await h.info()).rules[0]?.skips).toEqual([{ repo: "shop", why: "last run still going", at: MONDAY + WEEK }]);
    now += 60_000;
    await h.pump();
    expect((await h.info()).rules[0]?.skips).toHaveLength(1);
  });

  test("the card keeps only the newest twenty manual skip reasons", async () => {
    const h = hub({ workflowProblem: async () => "manual workflow cannot run unattended" });
    await h.adopt();
    await h.idle();
    for (let i = 0; i < 23; i++) {
      now = MONDAY + i * 60_000;
      await h.fire("spec-weekly", "", SHOP.id);
    }
    const skips = (await h.info()).rules[0]?.skips;
    expect(skips).toHaveLength(20);
    expect(skips?.[0]?.at).toBe(MONDAY + 3 * 60_000);
    expect(skips?.[19]?.at).toBe(MONDAY + 22 * 60_000);
    expect(h.list()).toEqual([]);
  });

  test("manual fire supports named repos, ignores wildcard filters for that repo and dedupes the minute after completion", async () => {
    await rules({ only: ["spec-adopted"] });
    const h = hub();
    await h.adopt();
    await h.idle();
    now = MONDAY + 3 * HOUR + 15_000;
    const one = await h.fire("spec-weekly", "", SHOP.id);
    expect(one).toMatchObject({ kind: "fired", events: [expect.objectContaining({ repoId: SHOP.id, source: "manual", service: "schedule", status: "working" })], skipped: [] });
    const run = runs[0];
    if (!run) throw new Error("manual fire did not start");
    h.onRun({ ...run, status: "failed", error: "fixture ended" });
    await h.pump();
    const repeat = await h.fire("spec-weekly", "", SHOP.path);
    expect(repeat).toMatchObject({ kind: "fired", events: [], skipped: [expect.objectContaining({ repo: "shop" })] });
    expect(started).toHaveLength(1);
    const all = await h.fire("spec-weekly", "");
    expect(all).toMatchObject({ kind: "fired", events: [], skipped: [] });
    await expect(h.fire("spec-weekly", "", "unknown")).rejects.toThrow("no repo unknown in the tree");
  });

  test("manual API passes repo and a schedule hook never accepts a delivery", async () => {
    const h = hub();
    await h.adopt();
    await h.idle();
    const fire = new Request("http://x/api/triggers/fire", { method: "POST", body: JSON.stringify({ rule: "spec-weekly", repo: BLOG.id }) });
    const res = await h.handle(fire, new URL(fire.url));
    expect(res?.status).toBe(201);
    expect(await res?.json()).toMatchObject({ kind: "fired", events: [expect.objectContaining({ repoId: BLOG.id })] });
    const hook = new Request("http://x/api/hooks/schedule/spec-weekly", { method: "POST", body: "{}" });
    expect((await h.handle(hook, new URL(hook.url)))?.status).toBe(404);
  });

  test("servers without the flows lock compute nothing and refuse manual firing", async () => {
    const h = hub();
    now = MONDAY + 20_000;
    await h.pump();
    expect(h.list()).toEqual([]);
    await expect(h.fire("spec-weekly", "")).rejects.toThrow("does not hold the flows lock");
  });

  test("detaching during workflow validation prevents the event and all later repo starts", async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delay = false;
    const h = hub({ workflowProblem: async () => {
      if (delay) { reached.resolve(); await release.promise; }
      return null;
    } });
    await h.adopt();
    await h.idle();
    now = MONDAY + 20_000;
    delay = true;
    const pass = h.pump();
    await reached.promise;
    h.detach();
    release.resolve();
    await pass;
    expect(started).toEqual([]);
    expect(h.list()).toEqual([]);
  });

  test("concurrent pumps share the running pass and the start guard becomes false after detach", async () => {
    const reached = Promise.withResolvers<() => boolean>();
    const release = Promise.withResolvers<void>();
    const h = hub({ start: async (event, _repo, valid) => {
      reached.resolve(valid);
      await release.promise;
      if (valid()) started.push(event);
      return { busy: "fixture held" };
    } });
    await h.adopt();
    await h.idle();
    now = MONDAY + 20_000;
    const pass = h.pump();
    const valid = await reached.promise;
    expect(h.pump()).toBe(pass);
    expect(valid()).toBe(true);
    h.detach();
    expect(valid()).toBe(false);
    release.resolve();
    await pass;
    expect(started).toEqual([]);
    expect(h.list().map((event) => event.status)).toEqual(["queued", "queued"]);
  });

  test("an admitted run keeps its setup guard until the attempt ends or ownership changes", async () => {
    let valid: (() => boolean) | undefined;
    const h = hub({ start: async (event, _repo, current) => {
      valid = current;
      const run = runFor(event);
      runs.push(run);
      return { run };
    } });
    await h.adopt();
    await h.idle();
    await h.fire("spec-weekly", "", SHOP.id);
    expect(valid?.()).toBe(true);
    h.detach();
    expect(valid?.()).toBe(false);
  });

  test("schedule events never resolve an outside issue even with tokenEnv configured", async () => {
    await rules({ tokenEnv: "CANOPY_TRIGGER_TEST_TOKEN" });
    let resolved = false;
    const h = hub({ env: () => "synthetic-token", resolve: async () => { resolved = true; } });
    await h.adopt();
    await h.idle();
    now = MONDAY + 20_000;
    await h.pump();
    const event = h.list()[0];
    if (!event?.branch) throw new Error("schedule event has no branch");
    const run = runs.find((run) => run.id === event.runId);
    if (!run?.branch) throw new Error("schedule run has no branch");
    h.onRun({ ...run, status: "done", branch: { ...run.branch, state: "ready" } });
    h.onLanding([{ id: "notice", entry: event.branch, kind: "landed", at: now + 1, repoId: event.repoId, branch: "run/fixture", note: "landed" }]);
    await h.idle();
    expect(h.get(event.id)?.status).toBe("merged");
    expect(resolved).toBe(false);
  });
});
