import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOSER_KEEP, type RunGroup } from "../core/group";
import type {
  LandingInfo,
  LandingRun,
  PrWatch,
  Run,
  ServerEvent,
} from "../core/types";
import { GroupHub, type GroupDeps } from "./groups";

const hubs: GroupHub[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.detach();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const deferred = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const runOf = (id: string, status: Run["status"] = "done"): Run => ({
  id,
  repoId: "repo",
  action: "compare",
  verb: "compare",
  progress: "comparing",
  expectsChange: false,
  chat: false,
  harness: "claude",
  note: "task",
  status,
  startedAt: 1,
  steps: [],
  prompt: null,
});
const recOf = (
  id: string,
  state: LandingRun["state"] = "ready",
): LandingRun => ({
  id,
  runId: id,
  repoId: "repo",
  repoPath: "/no-repo",
  branch: `run/${id}`,
  target: "main",
  base: "base",
  dir: "/no-tree",
  note: "task",
  verb: "build",
  harness: "claude",
  state,
  startedAt: 1,
  review: { verdict: "auto", files: [], base: "base", head: id, at: 1 },
});
const mergedPr = (id: string): PrWatch => ({
  ...recOf(id),
  slug: "owner/repo",
  remote: "origin",
  number: 1,
  url: "https://example.test/pr/1",
  autoFix: false,
  autoMerge: false,
  pushed: "head",
  attempts: {},
  seenComment: 0,
  openedAt: 1,
  updatedAt: 2,
  state: {
    number: 1,
    url: "https://example.test/pr/1",
    status: "merged",
    draft: false,
    additions: 1,
    deletions: 0,
    files: 1,
    head: "head",
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    review: "none",
    checks: [],
  },
});

async function world(overrides: Partial<GroupDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "canopy-groups-"));
  dirs.push(dir);
  const landing: LandingInfo = { runs: [], entries: [], orphans: [] };
  const runs = new Map<string, Run>();
  const events: ServerEvent[] = [];
  const dry: string[] = [];
  const reviewers: string[] = [];
  const dropped: string[] = [];
  const opened: string[] = [];
  const landed: string[] = [];
  let time = 100;
  let active: Run | undefined;
  const deps: GroupDeps = {
    dir,
    broadcast: (ev) => events.push(ev),
    publish: (ev) => events.push(ev),
    repo: () => undefined,
    run: (id) => runs.get(id),
    activeFor: () => active,
    landingInfo: () => landing,
    now: () => time,
    dryGates: async (origin) => {
      dry.push(origin);
      return {
        branch: `run/${origin}`,
        base: "base",
        head: origin,
        gates: { ok: true },
        minimum: 0.8,
      };
    },
    startReviewer: async (group) => {
      const run = runOf(`review-${reviewers.length}`, "working");
      reviewers.push(group.id);
      runs.set(run.id, run);
      return run;
    },
    dropMember: async (origin) => {
      dropped.push(origin);
      landing.runs = landing.runs.filter((r) => r.id !== origin);
    },
    openPr: async (origin) => {
      opened.push(origin);
    },
    land: async (origin) => {
      landed.push(origin);
    },
    ...overrides,
  };
  const hub = new GroupHub(deps);
  hubs.push(hub);
  await hub.adopt();
  async function create(
    ids = ["a", "b"],
    opts: Partial<Pick<RunGroup, "autoLand" | "pr">> = {},
  ) {
    const group = await hub.create({
      repoId: "repo",
      repoPath: "/no-repo",
      action: "propose",
      note: "task",
      autoLand: false,
      startedAt: 1,
      expectedMembers: ids.length,
      ...opts,
    });
    for (const id of ids) {
      landing.runs.push(recOf(id));
      await hub.addMember(group.id, { run: id, origin: id, profile: null });
    }
    await hub.idle();
    return group.id;
  }
  async function post(path: string, body: unknown) {
    const req = new Request(`http://local/api/groups/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const res = await hub.handle(req, new URL(req.url));
    if (!res) throw new Error("route absent");
    return res;
  }
  const current = (id: string) => {
    const group = hub.info().find((g) => g.id === id);
    if (!group) throw new Error("group absent");
    return group;
  };
  return {
    hub,
    dir,
    deps,
    landing,
    runs,
    events,
    dry,
    reviewers,
    dropped,
    opened,
    landed,
    create,
    post,
    current,
    setTime: (at: number) => {
      time = at;
    },
    setActive: (run?: Run) => {
      active = run;
    },
  };
}
async function finish(
  w: Awaited<ReturnType<typeof world>>,
  id: string,
  text: string,
) {
  const reviewId = w.current(id).review?.run;
  if (!reviewId) throw new Error("review absent");
  const run = { ...runOf(reviewId), result: { text, durationMs: 1, turns: 1 } };
  w.runs.set(run.id, run);
  w.hub.onRun(run);
  await w.hub.idle();
}
const comparison = (ranking = ["run/b", "run/a"]) =>
  `<<<compare\n${JSON.stringify({ ranking, why: Object.fromEntries(ranking.map((branch) => [branch, "This is sound."])) })}\n>>>\nMy closing words.`;

test("create is durable before fan-out and no member is scored before all are added", async () => {
  const w = await world();
  const group = await w.hub.create({
    repoId: "repo",
    repoPath: "/no-repo",
    action: "propose",
    note: "task",
    expectedMembers: 2,
    autoLand: false,
    startedAt: 1,
  });
  expect(
    JSON.parse(await readFile(join(w.dir, `${group.id}.json`), "utf8")),
  ).toMatchObject({ expectedMembers: 2, members: [], state: "working" });
  w.landing.runs.push(recOf("a"));
  await w.hub.addMember(group.id, { run: "a", origin: "a", profile: null });
  await w.hub.idle();
  expect(w.dry).toEqual([]);
  expect(w.reviewers).toEqual([]);
});

test("scores in member start order with one dry pass per repo and one reviewer", async () => {
  const gate = deferred();
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const w = await world({
    dryGates: async (origin) => {
      active++;
      peak = Math.max(peak, active);
      order.push(`start ${origin}`);
      if (origin === "a") await gate.promise;
      order.push(`end ${origin}`);
      active--;
      return {
        branch: `run/${origin}`,
        base: "base",
        head: origin,
        gates: { ok: true },
        minimum: origin === "a" ? 0.8 : 0.1,
      };
    },
  });
  const creating = w.create();
  await Bun.sleep(10);
  w.hub.onLanding(w.landing);
  w.hub.onLanding(w.landing);
  gate.release();
  const id = await creating;
  expect(peak).toBe(1);
  expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  expect(w.current(id).minimum).toBe(0.8);
  expect(w.reviewers).toEqual([id]);
  await finish(w, id, comparison());
  expect(w.current(id)).toMatchObject({
    state: "picked",
    winner: "b",
    pickedBy: "reviewer",
  });
  expect(w.landed).toEqual([]);
});

test("all non-ready members need help without dry passes", async () => {
  const w = await world();
  w.landing.runs.push(recOf("a", "nothing"), recOf("b", "uncommitted"));
  const group = await w.hub.create({
    repoId: "repo",
    repoPath: "/no-repo",
    action: "propose",
    note: "task",
    expectedMembers: 2,
    autoLand: false,
    startedAt: 1,
  });
  for (const origin of ["a", "b"])
    await w.hub.addMember(group.id, { run: origin, origin, profile: null });
  await w.hub.idle();
  expect(w.current(group.id)).toMatchObject({
    state: "needs-you",
    reason: "nothing to pick from",
  });
  expect(w.dry).toEqual([]);
});

test("one eligible member wins without a reviewer and only its current auto sort can land", async () => {
  const w = await world({
    dryGates: async (origin) => ({
      branch: `run/${origin}`,
      base: "base",
      head: origin,
      gates: { ok: origin === "b" },
      minimum: 0.8,
    }),
  });
  const id = await w.create(["a", "b"], { autoLand: true });
  expect(w.current(id)).toMatchObject({ state: "picked", winner: "b" });
  expect(w.reviewers).toEqual([]);
  expect(w.landed).toEqual(["b"]);
  const saved = JSON.parse(await readFile(join(w.dir, `${id}.json`), "utf8"));
  expect(saved.state).toBe("picked");
});

for (const verdict of ["land", "approve"] as const)
  test(`${verdict} sort waits for Eric with auto-land enabled`, async () => {
    const w = await world();
    w.landing.runs.push({
      ...recOf("a"),
      review: { verdict, files: [], base: "base", head: "a", at: 1 },
    });
    const g = await w.hub.create({
      repoId: "repo",
      repoPath: "/no-repo",
      action: "propose",
      note: "task",
      expectedMembers: 1,
      autoLand: true,
      startedAt: 1,
    });
    await w.hub.addMember(g.id, { origin: "a", run: "a", profile: null });
    await w.hub.idle();
    expect(w.current(g.id).winner).toBe("a");
    expect(w.landed).toEqual([]);
  });

test("scenario mean uses first minimum even when every individual scenario passed", async () => {
  const w = await world({
    dryGates: async (origin) => ({
      branch: `run/${origin}`,
      base: "base",
      head: origin,
      gates: { ok: true },
      minimum: origin === "a" ? 0.8 : 0.1,
      scenarios: { score: 0.6, passed: 2, total: 2 },
    }),
  });
  const id = await w.create();
  expect(w.current(id)).toMatchObject({
    state: "needs-you",
    reason: "no member passed the gates",
  });
  expect(w.reviewers).toEqual([]);
  expect((await w.post("pick", { group: id, run: "b" })).status).toBe(409);
});

for (const text of [
  "No block. Closing.",
  "<<<compare nope >>>\nClosing.",
  comparison(["run/a"]),
  comparison(["run/a", "run/stranger"]),
])
  test(`invalid compare needs Eric: ${text.slice(0, 25)}`, async () => {
    const w = await world();
    const id = await w.create();
    await finish(w, id, text);
    expect(w.current(id).state).toBe("needs-you");
    expect(w.current(id).reason).toContain(
      text.includes("My closing") ? "My closing words." : "Closing.",
    );
    expect(w.current(id).winner).toBeUndefined();
  });

test("pick is strict, PR winner opens once and merged snapshots remove losers once", async () => {
  const w = await world();
  const id = await w.create(["a", "b"], { pr: true, autoLand: true });
  expect((await w.post("pick", { group: id, run: "stranger" })).status).toBe(
    400,
  );
  expect((await w.post("pick", { group: id, run: "a" })).status).toBe(200);
  expect(w.opened).toEqual(["a"]);
  expect(w.landed).toEqual([]);
  w.hub.onPrs([mergedPr("a")]);
  await w.hub.idle();
  expect(w.current(id).state).toBe("landed");
  expect(w.dropped).toEqual(["b"]);
  const count = w.events.length;
  w.hub.onPrs([mergedPr("a")]);
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(w.dropped).toEqual(["b"]);
  expect(w.events.length).toBe(count);
});

test("landing sent-back reason survives repeated snapshots and publish reentry", async () => {
  const w = await world();
  const id = await w.create();
  await finish(w, id, comparison());
  const winner = recOf("b");
  w.landing.entries.push({
    ...winner,
    state: "red",
    reason: "tests broke after rebase",
    tries: 0,
    queuedAt: 1,
    updatedAt: 2,
  });
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(w.current(id)).toMatchObject({
    state: "needs-you",
    reason: "tests broke after rebase",
  });
  const count = w.events.length;
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(w.events.length).toBe(count);
  expect(w.dropped).toEqual([]);
});

test("drop keeps requested members for 24 hours, expiry is durable and does not repeat", async () => {
  const w = await world();
  const id = await w.create();
  expect((await w.post("drop", { group: id, keep: ["b"] })).status).toBe(200);
  expect(w.dropped).toEqual(["a"]);
  expect(w.current(id).keptUntil).toEqual({ b: 100 + LOSER_KEEP });
  w.setTime(100 + LOSER_KEEP);
  await w.hub.sweep();
  expect(w.dropped).toEqual(["a", "b"]);
  await w.hub.sweep();
  expect(w.dropped).toEqual(["a", "b"]);
  expect(w.current(id).keptUntil).toEqual({});
});

test("restart incomplete fanout needs help while a complete scoring restart reuses completed passes", async () => {
  const w = await world();
  const g = await w.hub.create({
    repoId: "repo",
    repoPath: "/no-repo",
    action: "propose",
    note: "task",
    expectedMembers: 2,
    autoLand: false,
    startedAt: 1,
  });
  w.landing.runs.push(recOf("a"), recOf("b"));
  await w.hub.addMember(g.id, { origin: "a", run: "a", profile: null });
  w.hub.detach();
  await w.hub.adopt();
  await w.hub.idle();
  expect(w.current(g.id)).toMatchObject({
    state: "needs-you",
    reason: "group start was cut off",
  });
  expect(w.dry).toEqual([]);
  const saved: RunGroup = {
    ...g,
    members: [
      { origin: "a", run: "a", profile: null },
      { origin: "b", run: "b", profile: null },
    ],
    state: "scoring",
    minimum: 0.8,
    scores: {
      a: { branch: "run/a", base: "base", state: "ready", gates: { ok: true } },
      b: { branch: "run/b", base: "base", state: "ready" },
    },
  };
  w.hub.detach();
  await writeFile(join(w.dir, `${g.id}.json`), JSON.stringify(saved));
  await w.hub.adopt();
  await w.hub.idle();
  expect(w.dry).toEqual(["b"]);
  expect(w.reviewers).toEqual([g.id]);
  w.hub.detach();
  await w.hub.adopt();
  await w.hub.idle();
  expect(w.reviewers).toEqual([g.id]);
});

test("detach fences a delayed dry result, remove and re-adopt cannot resurrect it", async () => {
  const gate = deferred();
  const w = await world({
    dryGates: async (origin) => {
      await gate.promise;
      return {
        branch: `run/${origin}`,
        base: "base",
        head: origin,
        gates: { ok: true },
        minimum: 1,
      };
    },
  });
  const creating = w.create();
  await Bun.sleep(10);
  w.hub.detach();
  gate.release();
  const id = await creating;
  expect(w.current(id).state).toBe("scoring");
  expect(w.reviewers).toEqual([]);
  await w.hub.adopt();
  await w.hub.idle();
  await w.hub.remove(id);
  w.hub.detach();
  await w.hub.adopt();
  expect(w.hub.info()).toEqual([]);
});

test("routes validate all surfaced bodies", async () => {
  const w = await world();
  const id = await w.create();
  for (const body of [
    null,
    [],
    {},
    { group: id, keep: "b" },
    { group: id, keep: [1] },
    { group: id, keep: ["other"] },
  ])
    expect((await w.post("drop", body)).status).toBe(400);
  expect((await w.post("review", { group: 1 })).status).toBe(400);
  expect((await w.post("pick", { group: id, run: 1 })).status).toBe(400);
  const req = new Request("http://local/api/groups");
  const result = await w.hub.handle(req, new URL(req.url));
  expect(await result?.json()).toEqual(w.hub.info());
});

test("separate groups in one repo share a serial dry-pass loop", async () => {
  const gate = deferred();
  const order: string[] = [];
  let first = true;
  const w = await world({
    dryGates: async (origin) => {
      order.push(`start ${origin}`);
      if (first) {
        first = false;
        await gate.promise;
      }
      order.push(`end ${origin}`);
      return {
        branch: `run/${origin}`,
        base: "base",
        head: origin,
        gates: { ok: false },
        minimum: 1,
      };
    },
  });
  for (const origin of ["a", "b"]) {
    const g = await w.hub.create({
      repoId: "repo",
      repoPath: "/no-repo",
      action: "propose",
      note: origin,
      expectedMembers: 1,
      autoLand: false,
      startedAt: 1,
    });
    w.landing.runs.push(recOf(origin));
    await w.hub.addMember(g.id, { run: origin, origin, profile: null });
  }
  await Bun.sleep(10);
  expect(order).toEqual(["start a"]);
  gate.release();
  await w.hub.idle();
  expect(order).toEqual(["start a", "end a", "start b", "end b"]);
});

test("a checkout run holds review; its end and duplicate review requests start one reviewer", async () => {
  const w = await world();
  w.setActive(runOf("checkout", "working"));
  const id = await w.create();
  expect(w.current(id).state).toBe("reviewing");
  expect(w.reviewers).toEqual([]);
  expect((await w.post("review", { group: id })).status).toBe(200);
  await w.hub.idle();
  expect(w.reviewers).toEqual([]);
  w.setActive();
  w.hub.onRun(runOf("checkout"));
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  await Promise.all([
    w.post("review", { group: id }),
    w.post("review", { group: id }),
  ]);
  await w.hub.idle();
  expect(w.reviewers).toEqual([id]);
});

test("missing reviewer restarts once after adoption and working members are reread", async () => {
  const w = await world();
  const id = await w.create();
  const original = w.current(id).review?.run;
  w.hub.detach();
  if (original) w.runs.delete(original);
  await w.hub.adopt();
  await w.hub.idle();
  expect(w.reviewers).toEqual([id, id]);
  const count = w.reviewers.length;
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(w.reviewers.length).toBe(count);
});

test("a delayed reviewer cannot resurrect a removed group", async () => {
  const gate = deferred();
  const w = await world({
    startReviewer: async () => {
      await gate.promise;
      return runOf("late", "working");
    },
  });
  const creating = w.create();
  await Bun.sleep(20);
  const id = w.hub.info()[0]?.id;
  if (!id) throw new Error("missing group");
  await w.hub.remove(id);
  gate.release();
  await creating;
  expect(w.hub.info()).toEqual([]);
  w.hub.detach();
  await w.hub.adopt();
  await w.hub.idle();
  expect(w.hub.info()).toEqual([]);
});

test("cleanup failure remains durable, retries after restart, then does not repeat", async () => {
  let fail = true;
  const removed: string[] = [];
  const w = await world({
    dropMember: async (origin) => {
      if (fail) throw new Error("busy worktree");
      removed.push(origin);
    },
  });
  const id = await w.create();
  await w.post("drop", { group: id, keep: ["b"] });
  expect(w.current(id).keptUntil?.a).toBe(100);
  expect(removed).toEqual([]);
  w.hub.detach();
  fail = false;
  await w.hub.adopt();
  await w.hub.idle();
  expect(removed).toEqual(["a"]);
  expect(w.current(id).keptUntil?.a).toBeUndefined();
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(removed).toEqual(["a"]);
});

test("landing a winner cleans losers and synchronous publish reentry reaches a fixed point", async () => {
  const w = await world();
  const id = await w.create();
  await finish(w, id, comparison());
  w.deps.publish = (ev) => {
    w.events.push(ev);
    if (ev.type === "landing") w.hub.onLanding(ev.landing);
  };
  w.landing.entries.push({
    ...recOf("b"),
    state: "landed",
    tries: 0,
    queuedAt: 1,
    updatedAt: 2,
  });
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(w.current(id).state).toBe("landed");
  expect(w.dropped).toEqual(["a"]);
  const count = w.events.length;
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(w.events.length).toBe(count);
});

test("dry failure needs help, detached owner refuses mutations, damaged disk cannot run", async () => {
  const w = await world({
    dryGates: async () => {
      throw new Error("dry unavailable");
    },
  });
  const id = await w.create();
  expect(w.current(id)).toMatchObject({
    state: "needs-you",
    reason: "dry unavailable",
  });
  w.hub.detach();
  expect((await w.post("drop", { group: id })).status).toBe(503);
  await writeFile(
    join(w.dir, `${id}.json`),
    JSON.stringify({
      ...w.current(id),
      members: [{ run: "x", origin: 42, profile: null }],
    }),
  );
  await w.hub.adopt();
  await w.hub.idle();
  expect(w.hub.info()).toEqual([]);
});

test("restart working group rereads every member and waits until the last settles", async () => {
  const w = await world();
  const g = await w.hub.create({
    repoId: "repo",
    repoPath: "/no-repo",
    action: "propose",
    note: "task",
    expectedMembers: 2,
    autoLand: false,
    startedAt: 1,
  });
  for (const origin of ["a", "b"]) {
    w.landing.runs.push(recOf(origin, "working"));
    await w.hub.addMember(g.id, { origin, run: origin, profile: null });
  }
  await w.hub.idle();
  w.hub.detach();
  w.landing.runs[0] = recOf("a");
  await w.hub.adopt();
  await w.hub.idle();
  expect(w.current(g.id).state).toBe("working");
  expect(w.dry).toEqual([]);
  w.landing.runs[1] = recOf("b");
  w.hub.onLanding(w.landing);
  await w.hub.idle();
  expect(w.dry).toEqual(["a", "b"]);
  expect(w.reviewers).toEqual([g.id]);
});

test("winner is durable before the automatic landing effect", async () => {
  const w = await world();
  const observed: string[] = [];
  w.deps.land = async (origin) => {
    const group = w.hub.info()[0];
    if (!group) throw new Error("missing group");
    const saved: unknown = JSON.parse(
      await readFile(join(w.dir, `${group.id}.json`), "utf8"),
    );
    expect(saved).toMatchObject({ state: "picked", winner: origin });
    observed.push(origin);
  };
  await w.create(["a"], { autoLand: true });
  expect(observed).toEqual(["a"]);
});

test("a member that starts fixing during a dry pass cannot win from its old ready score", async () => {
  const gate = deferred();
  const w = await world({
    dryGates: async (origin) => {
      await gate.promise;
      return {
        branch: `run/${origin}`,
        base: "base",
        head: origin,
        gates: { ok: true },
        minimum: 1,
      };
    },
  });
  const creating = w.create(["a"]);
  await Bun.sleep(10);
  const fix: Run = {
    ...runOf("fix-a", "working"),
    branch: {
      name: "run/a",
      target: "main",
      base: "base",
      dir: "/no-tree",
      state: "working",
      origin: "a",
    },
  };
  w.runs.set(fix.id, fix);
  w.hub.onRun(fix);
  gate.release();
  const id = await creating;
  expect(w.current(id).state).toBe("working");
  expect(w.current(id).winner).toBeUndefined();
});

test("fixing a member discards the old compare result and starts a fresh reviewer", async () => {
  const w = await world();
  const id = await w.create();
  await finish(w, id, "old broken review");
  const fix: Run = {
    ...runOf("fix-a", "working"),
    branch: {
      name: "run/a",
      target: "main",
      base: "base",
      dir: "/no-tree",
      state: "working",
      origin: "a",
    },
  };
  w.runs.set(fix.id, fix);
  w.hub.onRun(fix);
  await w.hub.idle();
  const ready: Run = {
    ...fix,
    status: "done",
    branch: {
      ...fix.branch,
      name: "run/a",
      target: "main",
      base: "base",
      dir: "/no-tree",
      state: "ready",
      origin: "a",
    },
  };
  w.runs.set(ready.id, ready);
  w.hub.onRun(ready);
  await w.hub.idle();
  expect(w.reviewers).toEqual([id, id]);
  expect(w.current(id).state).toBe("reviewing");
});

test("Eric can replace a completed reviewer pick and his own undispatched pick durably", async () => {
  const w = await world();
  const id = await w.create();
  await finish(w, id, comparison(["run/a", "run/b"]));
  expect(w.current(id).winner).toBe("a");
  expect((await w.post("pick", { group: id, run: "b" })).status).toBe(200);
  expect(w.current(id)).toMatchObject({
    state: "picked",
    winner: "b",
    pickedBy: "eric",
  });
  expect((await w.post("pick", { group: id, run: "a" })).status).toBe(200);
  expect(
    JSON.parse(await readFile(join(w.dir, `${id}.json`), "utf8")),
  ).toMatchObject({ winner: "a", pickedBy: "eric" });
  expect(w.opened).toEqual([]);
  expect(w.landed).toEqual([]);
});

test("Eric cannot replace a winner with real queue or PR work", async () => {
  const w = await world();
  const id = await w.create();
  await finish(w, id, comparison());
  w.landing.entries.push({
    ...recOf("b"),
    state: "queued",
    tries: 0,
    queuedAt: 1,
    updatedAt: 1,
  });
  expect((await w.post("pick", { group: id, run: "a" })).status).toBe(409);
  w.landing.entries = [];
  const winner = w.landing.runs.find((r) => r.id === "b");
  if (!winner) throw new Error("missing winner");
  winner.pr = 12;
  expect((await w.post("pick", { group: id, run: "a" })).status).toBe(409);
});

for (const kind of ["pr", "land"] as const) {
  test(`restart dispatches a durable picked ${kind} intent that never started`, async () => {
    const w = await world();
    let detached = false;
    w.deps.publish = (ev) => {
      w.events.push(ev);
      if (
        !detached &&
        ev.type === "landing" &&
        ev.landing.groups?.some((g) => g.state === "picked")
      ) {
        detached = true;
        w.hub.detach();
      }
    };
    const id = await w.create(
      ["a"],
      kind === "pr" ? { pr: true, autoLand: true } : { autoLand: true },
    );
    expect(w.opened).toEqual([]);
    expect(w.landed).toEqual([]);
    const restored = new GroupHub(w.deps);
    hubs.push(restored);
    await restored.adopt();
    await restored.idle();
    expect(restored.info().find((g) => g.id === id)?.winner).toBe("a");
    expect(kind === "pr" ? w.opened : w.landed).toEqual(["a"]);
    expect(kind === "pr" ? w.landed : w.opened).toEqual([]);
    restored.detach();
    await restored.adopt();
    await restored.idle();
    expect(kind === "pr" ? w.opened : w.landed).toEqual(["a"]);
  });
  test(`restart does not repeat ${kind} after the effect already exists`, async () => {
    const w = await world();
    const applied: string[] = [];
    const effect = async (origin: string) => {
      applied.push(origin);
      if (kind === "pr") {
        const rec = w.landing.runs.find((r) => r.id === origin);
        if (!rec) throw new Error("missing winner");
        rec.pr = 42;
      } else
        w.landing.entries.push({
          ...recOf(origin),
          state: "queued",
          tries: 0,
          queuedAt: 1,
          updatedAt: 1,
        });
      w.hub.detach();
    };
    if (kind === "pr") w.deps.openPr = effect;
    else w.deps.land = effect;
    await w.create(
      ["a"],
      kind === "pr" ? { pr: true, autoLand: true } : { autoLand: true },
    );
    expect(applied).toEqual(["a"]);
    const restored = new GroupHub(w.deps);
    hubs.push(restored);
    await restored.adopt();
    await restored.idle();
    expect(applied).toEqual(["a"]);
  });
}

test("a pending automatic landing intent respects the winner's current approval sort on adoption", async () => {
  const w = await world();
  let detached = false;
  w.deps.publish = (ev) => {
    if (
      !detached &&
      ev.type === "landing" &&
      ev.landing.groups?.some((g) => g.state === "picked")
    ) {
      detached = true;
      w.hub.detach();
    }
  };
  await w.create(["a"], { autoLand: true });
  const winner = w.landing.runs[0];
  if (!winner?.review) throw new Error("missing sort");
  winner.review.verdict = "approve";
  const restored = new GroupHub(w.deps);
  hubs.push(restored);
  await restored.adopt();
  await restored.idle();
  expect(w.landed).toEqual([]);
});

for (const operation of ["dry", "reviewer"] as const)
  test(`obsolete rejected ${operation} attempt cannot strand a fresh member fix`, async () => {
    const began = deferred();
    let reject = (_error: Error) => {};
    const obsolete = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    let first = true;
    const w = await world();
    if (operation === "dry")
      w.deps.dryGates = async (origin) => {
        if (first) {
          first = false;
          began.release();
          return obsolete;
        }
        return {
          branch: `run/${origin}`,
          base: "base",
          head: origin,
          gates: { ok: true },
          minimum: 1,
        };
      };
    else {
      const start = w.deps.startReviewer;
      w.deps.startReviewer = async (group, prompt) => {
        if (first) {
          first = false;
          began.release();
          return obsolete;
        }
        return start(group, prompt);
      };
    }
    const creating = w.create();
    await began.promise;
    const branch = {
      name: "run/a",
      target: "main",
      base: "base",
      dir: "/no-tree",
      origin: "a",
    };
    const fixing: Run = {
      ...runOf("fix-a", "working"),
      branch: { ...branch, state: "working" },
    };
    w.runs.set(fixing.id, fixing);
    w.hub.onRun(fixing);
    reject(new Error(`obsolete ${operation} failed`));
    const id = await creating;
    expect(w.current(id).state).toBe("working");
    expect(w.current(id).reason).toBeUndefined();
    const ready: Run = {
      ...fixing,
      status: "done",
      branch: { ...branch, state: "ready" },
    };
    w.runs.set(ready.id, ready);
    w.hub.onRun(ready);
    await w.hub.idle();
    expect(w.current(id).state).toBe("reviewing");
    expect(w.reviewers).toEqual([id]);
    await finish(w, id, comparison());
    expect(w.current(id).state).toBe("picked");
  });

test("a current reviewer-start rejection still needs Eric", async () => {
  const w = await world({
    startReviewer: async () => {
      throw new Error("review unavailable");
    },
  });
  const id = await w.create();
  expect(w.current(id)).toMatchObject({
    state: "needs-you",
    reason: "review unavailable",
  });
});

test("an in-flight winner dispatch refuses a replacement without duplicating the effect", async () => {
  const began = deferred();
  const release = deferred();
  const calls: string[] = [];
  const w = await world({
    land: async (origin) => {
      calls.push(origin);
      began.release();
      await release.promise;
    },
  });
  const id = await w.create(["a", "b"], { autoLand: true });
  const finishing = finish(w, id, comparison());
  await began.promise;
  expect((await w.post("pick", { group: id, run: "a" })).status).toBe(409);
  expect(w.current(id).winner).toBe("b");
  release.release();
  await finishing;
  expect(calls).toEqual(["b"]);
});

for (const supersede of ["pick", "remove", "drop", "detach"] as const)
  test(`obsolete rejected reviewer start is ignored after ${supersede}`, async () => {
    const began = deferred();
    let reject = (_error: Error) => {};
    const obsolete = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const w = await world({
      startReviewer: async () => {
        began.release();
        return obsolete;
      },
    });
    const creating = w.create();
    await began.promise;
    const id = w.hub.info()[0]?.id;
    if (!id) throw new Error("missing group");
    let dropping: Promise<Response> | undefined;
    if (supersede === "pick")
      expect((await w.post("pick", { group: id, run: "a" })).status).toBe(200);
    else if (supersede === "remove") await w.hub.remove(id);
    else if (supersede === "detach") w.hub.detach();
    else {
      const dropped = deferred();
      w.deps.publish = (ev) => {
        if (
          ev.type === "landing" &&
          ev.landing.groups?.some((g) => g.state === "dropped")
        )
          dropped.release();
      };
      dropping = w.post("drop", { group: id });
      await dropped.promise;
    }
    reject(new Error("obsolete reviewer failed"));
    await creating;
    if (dropping) expect((await dropping).status).toBe(200);
    if (supersede === "remove") expect(w.hub.info()).toEqual([]);
    else {
      expect(w.current(id).state).toBe(
        supersede === "pick"
          ? "picked"
          : supersede === "drop"
            ? "dropped"
            : "reviewing",
      );
      expect(w.current(id).reason).toBeUndefined();
    }
  });

test("confirming the same winner during dispatch preserves Eric's pick without replaying the effect", async () => {
  const began = deferred();
  const release = deferred();
  const confirmed = deferred();
  const calls: string[] = [];
  const w = await world({
    land: async (origin) => {
      calls.push(origin);
      began.release();
      await release.promise;
    },
  });
  const id = await w.create(["a", "b"], { autoLand: true });
  const finishing = finish(w, id, comparison());
  await began.promise;
  w.deps.publish = (ev) => {
    if (
      ev.type === "landing" &&
      ev.landing.groups?.some((g) => g.id === id && g.pickedBy === "eric")
    )
      confirmed.release();
  };
  const confirming = w.post("pick", { group: id, run: "b" });
  await confirmed.promise;
  release.release();
  await finishing;
  expect((await confirming).status).toBe(200);
  await w.hub.sweep();
  expect(w.current(id).pickedBy).toBe("eric");
  expect(calls).toEqual(["b"]);
});

test("GET, SSE, and every successful POST omit the private journal while disk retains it", async () => {
  const w = await world();
  const picked = await w.create(["a"], { pr: true });
  const picking = await w.post("pick", { group: picked, run: "a" });
  const dropping = await w.post("drop", { group: picked, keep: ["a"] });
  const reviewing = await w.create(["b", "c"]);
  const review = await w.post("review", { group: reviewing });
  for (const response of [picking, dropping, review]) {
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).not.toHaveProperty("_dispatch");
  }
  const request = new Request("http://local/api/groups");
  const getting = await w.hub.handle(request, new URL(request.url));
  expect(getting?.status).toBe(200);
  expect(await getting?.json()).toEqual(w.hub.info());
  for (const group of w.hub.info())
    expect(group).not.toHaveProperty("_dispatch");
  for (const event of w.events) {
    if (event.type === "landing") {
      for (const group of event.landing.groups ?? [])
        expect(group).not.toHaveProperty("_dispatch");
    }
  }
  const persisted: unknown = JSON.parse(
    await readFile(join(w.dir, `${picked}.json`), "utf8"),
  );
  expect(persisted).toMatchObject({
    state: "dropped",
    _dispatch: { winner: "a", kind: "pr", status: "done" },
  });
});
