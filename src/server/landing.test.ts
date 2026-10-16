import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import type { LandEntry, LandingInfo, LandingRun, Repo, Run, RunBranchState, ServerEvent } from "../core/types";
import { addRunTree, revOf, runTreeDir } from "../core/worktree";
import { LandingHub, type CheckOutcome } from "./landing";

let root = "";
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (cwd: string, name: string, body: string): Promise<string> => {
  await mkdir(join(cwd, name, ".."), { recursive: true });
  await writeFile(join(cwd, name), body);
  await sh(cwd, "add", "-A");
  await sh(cwd, "commit", "-q", "-m", `c ${name}`);
  return sh(cwd, "rev-parse", "HEAD");
};

let n = 0;
interface World {
  repo: Repo;
  hub: LandingHub;
  events: ServerEvent[];
  checks: [string, string][];
  fixes: [LandingRun, LandEntry][];
  wts: string;
  dir: string;
  /** gate line → what it answers; a function may act first (move main) */
  answers: Map<string, (cwd: string) => Promise<CheckOutcome> | CheckOutcome>;
  active: Set<string>;
}

/** A repo with one commit on main, gates from package.json, and a hub. */
async function world(opts: { gates?: string[]; noPackage?: boolean } = {}): Promise<World> {
  const path = join(root, `repo${++n}`);
  await exec(["git", "init", "-q", "-b", "main", path]);
  await sh(path, "config", "user.email", "t@t");
  await sh(path, "config", "user.name", "t");
  await commit(path, "a.txt", "one\ntwo\nthree\n");
  if (!opts.noPackage) {
    const scripts = Object.fromEntries((opts.gates ?? ["lint", "test"]).map((g) => [g, `echo ${g}`]));
    await commit(path, "package.json", JSON.stringify({ scripts }));
  }
  const repo: Repo = { id: `repo${n}`, name: `repo${n}`, path, group: "", source: "root", status: null };
  const w: World = {
    repo,
    events: [],
    checks: [],
    fixes: [],
    wts: join(root, `wts${n}`),
    dir: join(root, `landing${n}`),
    answers: new Map(),
    active: new Set(),
    hub: null as unknown as LandingHub,
  };
  let fixN = 0;
  w.hub = new LandingHub({
    broadcast: (ev) => w.events.push(ev),
    repo: (id) => (id === repo.id ? repo : undefined),
    repoByPath: (p) => (p === repo.path ? repo : undefined),
    check: async (cwd, line) => {
      w.checks.push([cwd, line]);
      const a = w.answers.get(line);
      return a ? a(cwd) : { exit: 0, output: "" };
    },
    startFix: (rec, entry) => {
      w.fixes.push([rec, entry]);
      const run = { ...fakeRun(rec.repoId, { name: rec.branch, target: rec.target, base: rec.base, dir: rec.dir, origin: rec.id }, "working"), id: `fix${++fixN}` };
      // the runner reports a run the moment it starts
      w.hub.onRun(run);
      return run;
    },
    runActive: (id) => w.active.has(id),
    dir: w.dir,
    worktrees: w.wts,
  });
  return w;
}

const fakeRun = (repoId: string, b: { name: string; target: string; base: string; dir: string; origin: string }, state: RunBranchState): Run => ({
  id: b.origin,
  repoId,
  action: "propose",
  verb: "Plan, then build",
  progress: "building",
  expectsChange: true,
  chat: false,
  harness: "claude",
  session: `sess-${b.origin}`,
  note: `work ${b.origin}`,
  status: state === "working" ? "working" : "done",
  startedAt: 1,
  ...(state === "working" ? {} : { endedAt: 2 }),
  steps: [],
  prompt: null,
  branch: { ...b, state },
});

/** A finished branch run whose worktree holds one commit writing `file`. */
async function readyRun(w: World, id: string, file: string, body: string): Promise<Run> {
  const dir = runTreeDir(w.repo.path, id, w.wts);
  const base = (await revOf(w.repo.path, "main"))!;
  const name = `run/x-${id}`;
  await addRunTree(w.repo.path, dir, name, base);
  await commit(dir, file, body);
  const run = fakeRun(w.repo.id, { name, target: "main", base, dir, origin: id }, "ready");
  w.hub.onRun(run);
  return run;
}

const entryOf = (w: World, id: string): LandEntry | undefined => w.hub.info().entries.find((e) => e.id === id);

/** A second hub on the same records and worktrees, as after a restart. */
const rehub = (w: World): LandingHub =>
  new LandingHub({
    broadcast: () => {},
    repo: (id) => (id === w.repo.id ? w.repo : undefined),
    repoByPath: (p) => (p === w.repo.path ? w.repo : undefined),
    check: async () => ({ exit: 0, output: "" }),
    startFix: () => {
      throw new Error("no fix here");
    },
    runActive: () => false,
    dir: w.dir,
    worktrees: w.wts,
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-land-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("landing", () => {
  test("a ready run lands: gates in its worktree in order, main fast-forwards, branch and worktree go", async () => {
    const w = await world();
    const run = await readyRun(w, "aa11", "b.txt", "b\n");
    const tip = await revOf(run.branch!.dir, "HEAD");
    await w.hub.land("aa11");
    await w.hub.idle();
    const e = entryOf(w, "aa11")!;
    expect(e.state).toBe("landed");
    expect(e.head).toBe(tip!);
    expect(await revOf(w.repo.path, "HEAD")).toBe(tip);
    expect(w.checks).toEqual([
      [run.branch!.dir, "bun run lint"],
      [run.branch!.dir, "bun run test"],
    ]);
    expect(existsSync(run.branch!.dir)).toBe(false);
    expect(await revOf(w.repo.path, "run/x-aa11")).toBeNull();
    expect(w.hub.info().runs).toEqual([]);
    // the events carried each state on the way
    const states = w.events.flatMap((ev) => (ev.type === "landing" ? ev.landing.entries.filter((x) => x.id === "aa11").map((x) => x.state + (x.gate ? `:${x.gate}` : "")) : []));
    expect([...new Set(states)]).toEqual(["queued", "rebasing", "gate:lint", "gate:test", "landing", "landed"]);
  });

  test("only a ready run lands, and not while it runs", async () => {
    const w = await world();
    const run = await readyRun(w, "bb22", "b.txt", "b\n");
    w.hub.onRun({ ...run, branch: { ...run.branch!, state: "uncommitted" } });
    await expect(w.hub.land("bb22")).rejects.toThrow("only a ready run lands");
    w.hub.onRun(run);
    w.active.add(run.id);
    await expect(w.hub.land("bb22")).rejects.toThrow("still going");
    await expect(w.hub.land("nope")).rejects.toThrow("no branch run");
  });

  test("two runs on the same line: the first lands, the second comes back with the file", async () => {
    const w = await world();
    await readyRun(w, "cc01", "a.txt", "one\nTWO first\nthree\n");
    await readyRun(w, "cc02", "a.txt", "one\nTWO second\nthree\n");
    await w.hub.land("cc01");
    await w.hub.land("cc02");
    await w.hub.idle();
    expect(entryOf(w, "cc01")?.state).toBe("landed");
    const back = entryOf(w, "cc02")!;
    expect([back.state, back.files]).toEqual(["conflict", ["a.txt"]]);
    expect(back.reason).toBe("conflicts with main in a.txt");
    // nothing of the second reached main, and its worktree stays for the fix
    expect(await sh(w.repo.path, "show", "HEAD:a.txt")).toBe("one\nTWO first\nthree");
    expect(existsSync(runTreeDir(w.repo.path, "cc02", w.wts))).toBe(true);
  });

  test("fix it resumes on the branch, and a ready fix rejoins the queue at the end", async () => {
    const w = await world();
    await readyRun(w, "dd01", "a.txt", "one\nTWO first\nthree\n");
    const second = await readyRun(w, "dd02", "a.txt", "one\nTWO second\nthree\n");
    await w.hub.land("dd01");
    await w.hub.land("dd02");
    await w.hub.idle();
    const fix = await w.hub.fix("dd02");
    expect(w.fixes.map(([r, e]) => [r.id, r.session, e.state])).toEqual([["dd02", "sess-dd02", "conflict"]]);
    expect(entryOf(w, "dd02")?.fixing).toBe(fix.id);
    w.active.add(fix.id);
    await expect(w.hub.fix("dd02")).rejects.toThrow("a fix is going already");
    await expect(w.hub.land("dd02")).rejects.toThrow("still going");
    w.active.delete(fix.id);
    // the fix rebases and resolves in the worktree, then settles ready
    const dir = second.branch!.dir;
    await sh(dir, "reset", "-q", "--hard", "main");
    await commit(dir, "a.txt", "one\nTWO both\nthree\n");
    w.hub.onRun({ ...fix, status: "done", endedAt: 5, branch: { ...fix.branch!, state: "ready" } });
    await w.hub.idle();
    expect(entryOf(w, "dd02")?.state).toBe("landed");
    expect(await sh(w.repo.path, "show", "HEAD:a.txt")).toBe("one\nTWO both\nthree");
  });

  test("a red gate comes back with the end of its output", async () => {
    const w = await world();
    await readyRun(w, "ee11", "b.txt", "b\n");
    w.answers.set("bun run test", () => ({ exit: 1, output: "x".repeat(5000) + "\n1 fail" }));
    await w.hub.land("ee11");
    await w.hub.idle();
    const e = entryOf(w, "ee11")!;
    expect([e.state, e.gate]).toEqual(["red", "test"]);
    expect(e.reason?.endsWith("1 fail")).toBe(true);
    expect(e.reason?.length).toBe(4000);
    expect(await revOf(w.repo.path, "HEAD")).not.toBe(await revOf(runTreeDir(w.repo.path, "ee11", w.wts), "HEAD"));
  });

  test("main moving while the gates run sends it round again, then it lands on the new main", async () => {
    const w = await world();
    await readyRun(w, "ff11", "b.txt", "b\n");
    let once = false;
    w.answers.set("bun run test", async () => {
      if (!once) {
        once = true;
        await commit(w.repo.path, "c.txt", "c\n");
      }
      return { exit: 0, output: "" };
    });
    await w.hub.land("ff11");
    await w.hub.idle();
    const e = entryOf(w, "ff11")!;
    expect([e.state, e.tries]).toEqual(["landed", 1]);
    expect(await sh(w.repo.path, "log", "--format=%s", "-3")).toBe("c b.txt\nc c.txt\nc package.json");
  });

  test("a busy main checkout holds the entry with the files, and a retry lands it once it clears", async () => {
    const w = await world();
    await readyRun(w, "gg11", "a.txt", "one\nchanged\nthree\n");
    await writeFile(join(w.repo.path, "a.txt"), "one\nlocal\nthree\n");
    await w.hub.land("gg11");
    await w.hub.idle();
    const e = entryOf(w, "gg11")!;
    expect([e.state, e.reason]).toEqual(["waiting", "main checkout busy: a.txt"]);
    await sh(w.repo.path, "checkout", "--", "a.txt");
    w.hub.retry();
    await w.hub.idle();
    expect(entryOf(w, "gg11")?.state).toBe("landed");
  });

  test("a checkout off the target branch holds the whole queue", async () => {
    const w = await world();
    await readyRun(w, "hh11", "b.txt", "b\n");
    await sh(w.repo.path, "checkout", "-q", "-b", "elsewhere");
    await w.hub.land("hh11");
    await w.hub.idle();
    expect(entryOf(w, "hh11")).toMatchObject({ state: "waiting", reason: "checkout not on main" });
    expect(w.checks).toEqual([]);
  });

  test("a repo with no gates lands and the entry says so", async () => {
    const w = await world({ noPackage: true });
    await readyRun(w, "ii11", "b.txt", "b\n");
    await w.hub.land("ii11");
    await w.hub.idle();
    expect(entryOf(w, "ii11")).toMatchObject({ state: "landed", noGates: true });
  });

  test("a broken gates file holds the queue with its reason", async () => {
    const w = await world();
    await mkdir(join(w.repo.path, ".canopy"), { recursive: true });
    await writeFile(join(w.repo.path, ".canopy", "gates.json"), "{");
    await readyRun(w, "jj11", "b.txt", "b\n");
    await w.hub.land("jj11");
    await w.hub.idle();
    expect(entryOf(w, "jj11")?.state).toBe("waiting");
    expect(entryOf(w, "jj11")?.reason).toContain("not JSON");
  });

  test("setup runs again after a rebase that brought in a lockfile change", async () => {
    const w = await world();
    await mkdir(join(w.repo.path, ".canopy"), { recursive: true });
    await commit(w.repo.path, ".canopy/gates.json", JSON.stringify({ setup: "bun install", gates: [{ name: "test", run: "bun test" }] }));
    await readyRun(w, "kk11", "b.txt", "b\n");
    await commit(w.repo.path, "bun.lock", "lock\n");
    await w.hub.land("kk11");
    await w.hub.idle();
    expect(w.checks.map(([, l]) => l)).toEqual(["bun install", "bun test"]);
    expect(entryOf(w, "kk11")?.state).toBe("landed");
  });

  test("the routes", async () => {
    const w = await world();
    await readyRun(w, "ll11", "b.txt", "b\n");
    const post = (path: string, body: unknown) => w.hub.handle(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), new URL(`http://x${path}`));
    const got = await w.hub.handle(new Request("http://x/api/landing"), new URL("http://x/api/landing"));
    expect(((await got!.json()) as { runs: LandingRun[] }).runs.map((r) => r.id)).toEqual(["ll11"]);
    expect((await post("/api/landing/land", {}))!.status).toBe(400);
    expect((await post("/api/landing/land", { run: "zz" }))!.status).toBe(404);
    expect((await post("/api/landing/fix", { id: "ll11" }))!.status).toBe(404);
    expect((await post("/api/landing/land", { run: "ll11" }))!.status).toBe(200);
    expect((await post("/api/landing/land", { run: "ll11" }))!.status).toBe(409);
    await w.hub.idle();
    expect(await w.hub.handle(new Request("http://x/api/other"), new URL("http://x/api/other"))).toBeNull();
  });
});

/** `.canopy/review.json` committed on main. */
const rulesOn = async (w: World, rules: unknown): Promise<void> => {
  await mkdir(join(w.repo.path, ".canopy"), { recursive: true });
  await commit(w.repo.path, ".canopy/review.json", JSON.stringify(rules));
};
/** A branch run still working when canopy stopped, its worktree left as
 *  `leave` makes it, and the hub that took the records back after. */
async function stoppedRun(w: World, id: string, leave: (dir: string) => Promise<unknown>): Promise<{ hub: LandingHub; dir: string }> {
  await w.hub.adopt();
  w.hub.stop();
  const dir = runTreeDir(w.repo.path, id, w.wts);
  const base = (await revOf(w.repo.path, "main"))!;
  await addRunTree(w.repo.path, dir, `run/x-${id}`, base);
  w.hub.onRun(fakeRun(w.repo.id, { name: `run/x-${id}`, target: "main", base, dir, origin: id }, "working"));
  await leave(dir);
  await w.hub.flushed();
  const hub = rehub(w);
  await hub.adopt();
  await hub.idle();
  return { hub, dir };
}

const recOf = (w: World, id: string): LandingRun | undefined => w.hub.info().runs.find((r) => r.id === id);
const RULES = { autoLand: ["docs", "comments", "format"], approve: ["secret/**"] };

describe("review rules", () => {
  test("a docs run joins on its own, lands, and leaves a notice", async () => {
    const w = await world();
    await rulesOn(w, RULES);
    await readyRun(w, "ra11", "notes.md", "words\n");
    await w.hub.idle();
    const e = entryOf(w, "ra11")!;
    expect([e.state, e.auto]).toEqual(["landed", true]);
    expect(w.hub.info().notices).toEqual([expect.objectContaining({ kind: "landed", entry: "ra11", branch: "run/x-ra11", head: e.head })]);
    expect(await sh(w.repo.path, "show", "HEAD:notes.md")).toBe("words");
  });

  test("a logic run waits for land, and Eric's land queues it with no flags", async () => {
    const w = await world();
    await rulesOn(w, RULES);
    await readyRun(w, "rb11", "b.ts", "export const b = 1;\n");
    await w.hub.idle();
    expect(entryOf(w, "rb11")).toBeUndefined();
    expect(recOf(w, "rb11")?.review).toMatchObject({ verdict: "land", files: [{ path: "b.ts", cls: "logic" }] });
    const e = await w.hub.land("rb11");
    expect([e.auto, e.approved]).toEqual([undefined, undefined]);
    await w.hub.idle();
    expect(entryOf(w, "rb11")?.state).toBe("landed");
    expect(w.hub.info().notices).toEqual([]);
  });

  test("a sensitive run lands only with the id it was sorted at, and the approval survives a rebase", async () => {
    const w = await world();
    await rulesOn(w, RULES);
    await readyRun(w, "rc11", "secret/k.txt", "k\n");
    await w.hub.idle();
    const review = recOf(w, "rc11")!.review!;
    expect([review.verdict, review.files[0]?.sensitive]).toEqual(["approve", "matches secret/** in .canopy/review.json"]);
    await expect(w.hub.land("rc11")).rejects.toThrow("it needs your approval: 1 sensitive file; look at the files and approve");
    await expect(w.hub.land("rc11", "stale")).rejects.toThrow("the branch changed since you looked");
    // main moves before its turn: the rebase leaves the sensitive diff alone
    w.hub.stop();
    const e = await w.hub.land("rc11", review.sensitiveId);
    expect(e.approved).toBe(review.sensitiveId!);
    await commit(w.repo.path, "other.txt", "o\n");
    w.hub.start();
    w.hub.kick(w.repo.id);
    await w.hub.idle();
    w.hub.stop();
    expect(entryOf(w, "rc11")?.state).toBe("landed");
    expect(await sh(w.repo.path, "show", "HEAD:secret/k.txt")).toBe("k");
  });

  test("land all queues the runs that need no approval and names the one that does", async () => {
    const w = await world();
    await rulesOn(w, RULES);
    await readyRun(w, "rd01", "b.ts", "export const b = 1;\n");
    await readyRun(w, "rd02", "c.ts", "export const c = 1;\n");
    await readyRun(w, "rd03", "secret/k.txt", "k\n");
    await w.hub.idle();
    w.hub.stop();
    const got = await w.hub.landAll(w.repo.id);
    expect(got).toEqual({ queued: ["rd01", "rd02"], skipped: [{ id: "rd03", branch: "run/x-rd03", why: "needs your approval: 1 sensitive file" }] });
    expect(w.hub.info().entries.map((e) => [e.id, e.state])).toEqual([
      ["rd01", "queued"],
      ["rd02", "queued"],
    ]);
  });

  test("rules narrowed on main while an auto entry waits hold it back with a notice", async () => {
    const w = await world();
    await rulesOn(w, RULES);
    w.hub.stop();
    await readyRun(w, "re11", "notes.md", "words\n");
    await w.hub.idle();
    expect(entryOf(w, "re11")).toMatchObject({ state: "queued", auto: true });
    await rulesOn(w, { autoLand: [], approve: [] });
    w.hub.start();
    w.hub.kick(w.repo.id);
    await w.hub.idle();
    w.hub.stop();
    expect(entryOf(w, "re11")).toBeUndefined();
    expect(recOf(w, "re11")).toMatchObject({ state: "ready", review: { verdict: "land" } });
    expect(w.hub.info().notices).toEqual([expect.objectContaining({ kind: "held", entry: "re11", why: "after the rebase it needs your land" })]);
    expect(await sh(w.repo.path, "log", "--format=%s", "-1")).toBe("c .canopy/review.json");
  });

  test("a fix that changes an approved sensitive file waits for a new approval", async () => {
    const w = await world();
    await rulesOn(w, RULES);
    const run = await readyRun(w, "rf11", "secret/k.txt", "k\n");
    await w.hub.idle();
    w.answers.set("bun run test", () => ({ exit: 1, output: "1 fail" }));
    await w.hub.land("rf11", recOf(w, "rf11")!.review!.sensitiveId);
    await w.hub.idle();
    expect(entryOf(w, "rf11")?.state).toBe("red");
    w.answers.delete("bun run test");
    const fix = await w.hub.fix("rf11");
    await commit(run.branch!.dir, "secret/k.txt", "k2\n");
    w.hub.onRun({ ...fix, status: "done", endedAt: 5, branch: { ...fix.branch!, state: "ready" } });
    await w.hub.idle();
    expect(entryOf(w, "rf11")).toBeUndefined();
    expect(recOf(w, "rf11")?.state).toBe("ready");
    expect(w.hub.info().notices?.[0]).toMatchObject({ kind: "held", entry: "rf11", why: "the fix changed the sensitive files you approved; look again" });
  });

  test("the routes: land with an id, land all, the diff of a listed file only, seen", async () => {
    const w = await world();
    await rulesOn(w, RULES);
    await readyRun(w, "rg11", "secret/k.txt", "k\n");
    await w.hub.idle();
    w.hub.stop();
    const call = (method: string, path: string, body?: unknown) =>
      w.hub.handle(new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://x${path}`));
    const diff = await call("GET", "/api/landing/diff?id=rg11&path=secret/k.txt");
    expect(diff!.status).toBe(200);
    expect(((await diff!.json()) as { diff: string }).diff).toContain("+k");
    expect((await call("GET", "/api/landing/diff?id=rg11&path=a.txt"))!.status).toBe(404);
    expect((await call("GET", "/api/landing/diff?id=rg11&path=../../etc/passwd"))!.status).toBe(404);
    expect((await call("GET", "/api/landing/diff?id=rg11"))!.status).toBe(400);
    expect((await call("POST", "/api/landing/land", { run: "rg11" }))!.status).toBe(409);
    expect((await call("POST", "/api/landing/land", { run: "rg11", approve: 3 }))!.status).toBe(400);
    expect((await call("POST", "/api/landing/land", { run: "rg11", approve: recOf(w, "rg11")!.review!.sensitiveId }))!.status).toBe(200);
    expect((await call("POST", "/api/landing/land-all", {}))!.status).toBe(400);
    expect(await (await call("POST", "/api/landing/land-all", { repo: w.repo.id }))!.json()).toEqual({ queued: [], skipped: [] });
    expect((await call("POST", "/api/landing/seen", { ids: "x" }))!.status).toBe(400);
    expect((await call("POST", "/api/landing/seen", { ids: ["x"] }))!.status).toBe(200);
  });

  test("notices and sorts read back after a restart, and a plan 1 record is sorted at adopt", async () => {
    const w = await world();
    await w.hub.adopt();
    await rulesOn(w, RULES);
    await readyRun(w, "rh01", "notes.md", "words\n");
    await readyRun(w, "rh02", "b.ts", "export const b = 1;\n");
    await w.hub.idle();
    w.hub.stop();
    await w.hub.flushed();
    // a record from plan 1 has no sort
    const file = join(w.dir, "runs", "rh02.json");
    const { review: _r, ...plain } = JSON.parse(await Bun.file(file).text()) as LandingRun;
    await writeFile(file, JSON.stringify(plain));
    const again = rehub(w);
    await again.adopt();
    await again.idle();
    again.stop();
    expect(again.info().notices).toEqual([expect.objectContaining({ kind: "landed", entry: "rh01" })]);
    expect(again.info().runs.find((r) => r.id === "rh02")?.review?.verdict).toBe("land");
    again.seen([again.info().notices![0]!.id]);
    await again.flushed();
    expect(existsSync(join(w.dir, "notices.json"))).toBe(false);
  });
});

describe("restarts", () => {
  test("records come back: a working run reads stopped, a mid-turn entry starts again and lands, an unknown worktree is an orphan", async () => {
    const w = await world();
    await w.hub.adopt();
    w.hub.stop();
    await readyRun(w, "mm11", "b.txt", "b\n");
    // a run still working when canopy stopped
    const dir2 = runTreeDir(w.repo.path, "mm22", w.wts);
    await addRunTree(w.repo.path, dir2, "run/x-mm22", "main");
    w.hub.onRun(fakeRun(w.repo.id, { name: "run/x-mm22", target: "main", base: "main", dir: dir2, origin: "mm22" }, "working"));
    // the first entry was mid-gate when the server died: the stopped hub
    // takes it into its queue without working it, and the file says gate
    await w.hub.land("mm11");
    await w.hub.flushed();
    const queueFile = join(w.dir, "queue", (await readdir(join(w.dir, "queue")))[0]!);
    const entries = JSON.parse(await Bun.file(queueFile).text()) as LandEntry[];
    expect(entries.map((e) => [e.id, e.state])).toEqual([["mm11", "queued"]]);
    await writeFile(queueFile, JSON.stringify(entries.map((e) => ({ ...e, state: "gate", gate: "test" }))));
    expect(existsSync(join(w.dir, "runs", "mm22.json"))).toBe(true);
    // an orphan: a worktree on disk that no record names
    const orphanDir = runTreeDir(w.repo.path, "oo11", w.wts);
    await addRunTree(w.repo.path, orphanDir, "run/x-oo11", "main");
    await commit(orphanDir, "o.txt", "o\n");

    const again = rehub(w);
    await again.adopt();
    await again.idle();
    const info = again.info();
    expect(info.runs.find((r) => r.id === "mm22")?.state).toBe("stopped");
    expect(info.entries.find((e) => e.id === "mm11")?.state).toBe("landed");
    expect(info.orphans).toEqual([{ dir: orphanDir, repoPath: await sh(w.repo.path, "rev-parse", "--show-toplevel"), branch: "run/x-oo11", queueable: true }]);
    await again.orphan(orphanDir, "queue");
    await again.idle();
    expect(again.info().entries.find((e) => e.id === "oo11")?.state).toBe("landed");
    expect(again.info().orphans).toEqual([]);
  });

  test("a run a restart stopped lands when its work is whole: committed, with only ignored files left", async () => {
    const w = await world();
    const { hub, dir } = await stoppedRun(w, "sa11", async (d) => {
      await commit(d, ".gitignore", "*.log\n");
      await commit(d, "b.txt", "b\n");
      await writeFile(join(d, "out.log"), "noise\n");
    });
    const rec = hub.info().runs.find((r) => r.id === "sa11");
    expect(rec).toMatchObject({ state: "stopped", whole: { ok: true }, review: { verdict: "land" } });
    // looked at, not saved
    expect(JSON.parse(await Bun.file(join(w.dir, "runs", "sa11.json")).text())).not.toHaveProperty("whole");
    const tip = await revOf(dir, "HEAD");
    await hub.land("sa11");
    await hub.idle();
    hub.stop();
    expect(hub.info().entries.find((e) => e.id === "sa11")).toMatchObject({ state: "landed", head: tip });
    expect(await sh(w.repo.path, "show", "HEAD:b.txt")).toBe("b");
    expect(existsSync(dir)).toBe(false);
    expect(hub.info().runs).toEqual([]);
  });

  test("a stopped run with changes left uncommitted is refused with the reason, and lands once they are committed", async () => {
    const w = await world();
    const { hub, dir } = await stoppedRun(w, "sb11", async (d) => {
      await commit(d, "b.txt", "b\n");
      await writeFile(join(d, "half.txt"), "half\n");
    });
    expect(hub.info().runs.find((r) => r.id === "sb11")?.whole).toEqual({ ok: false, why: "changes left uncommitted" });
    await expect(hub.land("sb11")).rejects.toThrow("a restart stopped it and it cannot land: changes left uncommitted");
    expect(hub.info().entries).toEqual([]);
    // the worktree is looked at when land asks, not once at adopt
    await sh(dir, "add", "-A");
    await sh(dir, "commit", "-q", "-m", "the rest");
    await hub.land("sb11");
    await hub.idle();
    hub.stop();
    expect(hub.info().entries.find((e) => e.id === "sb11")?.state).toBe("landed");
    expect(await sh(w.repo.path, "show", "HEAD:half.txt")).toBe("half");
  });

  test("a stopped run with no commits is refused, and the info says so until it has one", async () => {
    const w = await world();
    const { hub, dir } = await stoppedRun(w, "sc11", async () => {});
    await expect(hub.land("sc11")).rejects.toThrow("a restart stopped it and it cannot land: no commits main lacks");
    expect(hub.info().entries).toEqual([]);
    const get = async () => ((await (await hub.handle(new Request("http://x/api/landing"), new URL("http://x/api/landing")))!.json()) as LandingInfo).runs.find((r) => r.id === "sc11");
    expect((await get())?.whole).toEqual({ ok: false, why: "no commits main lacks" });
    await commit(dir, "b.txt", "b\n");
    expect((await get())?.whole).toEqual({ ok: true });
    await hub.idle();
    hub.stop();
  });

  test("a hub that never adopted keeps nothing on disk", async () => {
    const w = await world();
    await readyRun(w, "nn11", "b.txt", "b\n");
    await w.hub.land("nn11");
    await w.hub.idle();
    expect(existsSync(w.dir)).toBe(false);
  });

  test("drop gives up a sent-back branch with its worktree", async () => {
    const w = await world();
    await readyRun(w, "pp11", "b.txt", "b\n");
    w.answers.set("bun run lint", () => ({ exit: 1, output: "lint failed" }));
    await w.hub.land("pp11");
    await w.hub.idle();
    expect(entryOf(w, "pp11")?.state).toBe("red");
    await w.hub.drop("pp11");
    expect(entryOf(w, "pp11")).toBeUndefined();
    expect(existsSync(runTreeDir(w.repo.path, "pp11", w.wts))).toBe(false);
    expect(await revOf(w.repo.path, "run/x-pp11")).toBeNull();
  });
});
