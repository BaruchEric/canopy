import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import type { LandEntry, LandingRun, Repo, Run, RunBranchState, ServerEvent } from "../core/types";
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
    w.hub.land("aa11");
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
    expect(() => w.hub.land("bb22")).toThrow("only a ready run lands");
    w.hub.onRun(run);
    w.active.add(run.id);
    expect(() => w.hub.land("bb22")).toThrow("still going");
    expect(() => w.hub.land("nope")).toThrow("no branch run");
  });

  test("two runs on the same line: the first lands, the second comes back with the file", async () => {
    const w = await world();
    await readyRun(w, "cc01", "a.txt", "one\nTWO first\nthree\n");
    await readyRun(w, "cc02", "a.txt", "one\nTWO second\nthree\n");
    w.hub.land("cc01");
    w.hub.land("cc02");
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
    w.hub.land("dd01");
    w.hub.land("dd02");
    await w.hub.idle();
    const fix = await w.hub.fix("dd02");
    expect(w.fixes.map(([r, e]) => [r.id, r.session, e.state])).toEqual([["dd02", "sess-dd02", "conflict"]]);
    expect(entryOf(w, "dd02")?.fixing).toBe(fix.id);
    w.active.add(fix.id);
    await expect(w.hub.fix("dd02")).rejects.toThrow("a fix is going already");
    expect(() => w.hub.land("dd02")).toThrow("still going");
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
    w.hub.land("ee11");
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
    w.hub.land("ff11");
    await w.hub.idle();
    const e = entryOf(w, "ff11")!;
    expect([e.state, e.tries]).toEqual(["landed", 1]);
    expect(await sh(w.repo.path, "log", "--format=%s", "-3")).toBe("c b.txt\nc c.txt\nc package.json");
  });

  test("a busy main checkout holds the entry with the files, and a retry lands it once it clears", async () => {
    const w = await world();
    await readyRun(w, "gg11", "a.txt", "one\nchanged\nthree\n");
    await writeFile(join(w.repo.path, "a.txt"), "one\nlocal\nthree\n");
    w.hub.land("gg11");
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
    w.hub.land("hh11");
    await w.hub.idle();
    expect(entryOf(w, "hh11")).toMatchObject({ state: "waiting", reason: "checkout not on main" });
    expect(w.checks).toEqual([]);
  });

  test("a repo with no gates lands and the entry says so", async () => {
    const w = await world({ noPackage: true });
    await readyRun(w, "ii11", "b.txt", "b\n");
    w.hub.land("ii11");
    await w.hub.idle();
    expect(entryOf(w, "ii11")).toMatchObject({ state: "landed", noGates: true });
  });

  test("a broken gates file holds the queue with its reason", async () => {
    const w = await world();
    await mkdir(join(w.repo.path, ".canopy"), { recursive: true });
    await writeFile(join(w.repo.path, ".canopy", "gates.json"), "{");
    await readyRun(w, "jj11", "b.txt", "b\n");
    w.hub.land("jj11");
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
    w.hub.land("kk11");
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
    w.hub.land("mm11");
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

    const events: ServerEvent[] = [];
    const again = new LandingHub({
      broadcast: (ev) => events.push(ev),
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

  test("a hub that never adopted keeps nothing on disk", async () => {
    const w = await world();
    await readyRun(w, "nn11", "b.txt", "b\n");
    w.hub.land("nn11");
    await w.hub.idle();
    expect(existsSync(w.dir)).toBe(false);
  });

  test("drop gives up a sent-back branch with its worktree", async () => {
    const w = await world();
    await readyRun(w, "pp11", "b.txt", "b\n");
    w.answers.set("bun run lint", () => ({ exit: 1, output: "lint failed" }));
    w.hub.land("pp11");
    await w.hub.idle();
    expect(entryOf(w, "pp11")?.state).toBe("red");
    await w.hub.drop("pp11");
    expect(entryOf(w, "pp11")).toBeUndefined();
    expect(existsSync(runTreeDir(w.repo.path, "pp11", w.wts))).toBe(false);
    expect(await revOf(w.repo.path, "run/x-pp11")).toBeNull();
  });
});
