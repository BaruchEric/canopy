import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, type ExecResult } from "../core/exec";
import type { LandingRun, PrWatch, Run, ServerEvent } from "../core/types";
import { addRunTree, revOf, runTreeDir } from "../core/worktree";
import { PrHub } from "./prs";

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
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

/** What the fake `gh` answers: the PR as `gh pr view` reads it, its review
 *  comments, each login's permission, and every call it got. */
interface Gh {
  calls: string[][];
  auth: boolean;
  checks: unknown[];
  head: string | null;
  state: string;
  review: string;
  mergeable: string;
  comments: unknown[];
  perms: Record<string, string>;
  mergeFails: boolean;
  /** the repo has a merge queue: a merge only queues it */
  mergeQueued: boolean;
  /** the permission endpoint answers 502 */
  permDown: boolean;
  /** what gh says when a close fails */
  closeFails: string | null;
  /** the PR's newest conversation comments as the close query has them,
   *  or gh's error */
  prComments: unknown[] | string;
  /** when GitHub says the PR closed */
  closedAt: string | null;
  /** the gh login */
  viewer: string;
  /** fields over the state query's answer */
  now: Record<string, unknown>;
}

let n = 0;
interface World {
  path: string;
  bare: string;
  dir: string;
  rec: LandingRun;
  records: Map<string, LandingRun>;
  hub: PrHub;
  gh: Gh;
  events: ServerEvent[];
  fixes: { id: string; prompt: string; label: string }[];
  active: Set<string>;
  /** runs that ended stopped or failed */
  failed: Set<string>;
  forgot: string[];
  held: string | null;
  recDir: string;
  /** the hub's clock when set, else the real one */
  clock: number | null;
  /** a new hub on the same records, as after a restart */
  restart: () => Promise<PrHub>;
}

const view = (g: Gh, number = 7) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: g.state,
  isDraft: false,
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  headRefOid: g.head,
  mergeable: g.mergeable,
  mergeStateStatus: "CLEAN",
  reviewDecision: g.review,
  latestReviews: [],
  statusCheckRollup: g.checks,
});
const checkRun = (name: string, status: string, conclusion = "") => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/55/job/1` });

/** A repo with a bare origin, a run worktree with one commit, its landing
 *  record, a fake gh and a hub. */
async function world(opts: { repoDefault?: string } = {}): Promise<World> {
  const path = join(root, `repo${++n}`);
  await exec(["git", "init", "-q", "-b", "main", path]);
  await sh(path, "config", "user.email", "t@t");
  await sh(path, "config", "user.name", "t");
  await commit(path, "a.txt", "one\n");
  if (opts.repoDefault) await commit(path, ".canopy/prs.json", opts.repoDefault);
  const bare = join(root, `bare${n}.git`);
  await exec(["git", "init", "-q", "--bare", bare]);
  await sh(path, "remote", "add", "origin", bare);
  await sh(path, "push", "-q", "origin", "main");
  const id = `b${n}`;
  const branch = `run/thing-${id}`;
  const dir = runTreeDir(path, id, join(root, `wts${n}`));
  await addRunTree(path, dir, branch, "main");
  await commit(dir, "b.txt", "two\n");
  const rec: LandingRun = { id, runId: id, repoId: `repo${n}`, repoPath: path, branch, target: "main", base: "", dir, note: "make the thing", verb: "propose", harness: "claude", state: "ready", startedAt: 1 };
  const g: Gh = { calls: [], auth: true, checks: [], head: null, state: "OPEN", review: "", mergeable: "MERGEABLE", comments: [], perms: {}, mergeFails: false, mergeQueued: false, permDown: false, closeFails: null, prComments: [], closedAt: null, viewer: "eric", now: {} };
  const records = new Map([[id, rec]]);
  const recDir = join(root, `prs${n}`);
  const w = { path, bare, dir, rec, records, gh: g, events: [], fixes: [], active: new Set<string>(), failed: new Set<string>(), forgot: [], held: null, recDir, clock: null } as unknown as World;
  const fake = async (args: string[]): Promise<ExecResult> => {
    g.calls.push(args);
    const [a, b] = args;
    if (a === "auth") return g.auth ? ok("Logged in") : no("not logged in");
    if (a === "pr" && b === "create") return ok(`https://github.com/o/r/pull/7\n`);
    if (a === "api" && b === "graphql" && args.some((x) => x.includes("mergeQueueEntry"))) {
      return ok(JSON.stringify({ data: { repository: { pullRequest: { state: g.state, updatedAt: "2026-10-01T12:00:00Z", isDraft: false, autoMergeRequest: null, mergeQueueEntry: null, ...g.now } } } }));
    }
    if (a === "api" && b === "graphql") {
      if (typeof g.prComments === "string") return no(`some noise\n${g.prComments}\n`);
      return ok(JSON.stringify({ data: { viewer: { login: g.viewer }, repository: { pullRequest: { closedAt: g.closedAt, comments: { nodes: g.prComments } } } } }));
    }
    if (a === "pr" && b === "view") return ok(JSON.stringify({ ...view(g), updatedAt: "2026-10-01T12:00:00Z" }));
    if (a === "pr" && b === "merge") {
      if (g.mergeFails) return no("Head branch was modified");
      if (!g.mergeQueued) g.state = "MERGED";
      return ok("");
    }
    if (a === "pr" && b === "close") return g.closeFails ? no(`some noise\n${g.closeFails}\n`) : ok("");
    if (a === "run" && b === "view") return ok("lots of log\nError: expected 2, got 3\n");
    if (a === "repo" && b === "view") return ok(JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false }));
    if (a === "api" && b?.endsWith("/permission")) {
      if (g.permDown) return no("gh: Bad Gateway (HTTP 502)");
      const login = decodeURIComponent(b.split("/collaborators/")[1]!.split("/")[0]!);
      return ok(JSON.stringify({ permission: g.perms[login] ?? "read" }));
    }
    if (a === "api" && b?.includes("/comments")) return ok(JSON.stringify(g.comments));
    return no(`fake gh: no answer for ${args.join(" ")}`);
  };
  let fixN = 0;
  const make = () =>
    new PrHub({
      broadcast: (ev) => w.events.push(ev),
      gh: fake,
      slugOf: async () => "o/r",
      record: (x) => records.get(x) ?? [...records.values()].find((r) => r.runId === x),
      queueHold: () => w.held,
      markPr: (x, pr) => {
        const r = records.get(x);
        if (!r) return;
        const { pr: _p, ...rest } = r;
        records.set(x, pr === null ? rest : { ...rest, pr });
      },
      forget: async (x) => {
        w.forgot.push(x);
        records.delete(x);
      },
      startFix: async (r, prompt, label) => {
        const runId = `fix${++fixN}`;
        w.fixes.push({ id: runId, prompt, label });
        w.active.add(runId);
        const cur = records.get(r.id);
        if (cur) records.set(r.id, { ...cur, runId });
        return { id: runId, repoId: r.repoId, branch: { name: r.branch, target: r.target, base: r.base, dir: r.dir, state: "working", origin: r.id } } as unknown as Run;
      },
      runActive: (x) => w.active.has(x),
      runOk: (x) => !w.active.has(x) && !w.failed.has(x),
      dir: recDir,
      tickEvery: 60_000,
      now: () => w.clock ?? Date.now(),
    });
  w.hub = make();
  await w.hub.adopt();
  w.restart = async () => {
    const h = make();
    await h.adopt();
    return h;
  };
  return w;
}

/** Reads every PR now, however long since the last read. */
const pollNow = async (w: World, hub = w.hub): Promise<PrWatch> => {
  // only what is due at all: a merged or closed PR has no next read
  const due = (hub as unknown as { due: Map<string, number> }).due;
  for (const id of due.keys()) due.set(id, 0);
  await hub.tick();
  await hub.idle();
  return hub.info()[0]!;
};

/** A fix run ends, with or without a commit of its own; `stopped` is Eric's
 *  stop or a failure rather than the agent finishing. */
const endFix = async (w: World, runId: string, change?: string, stopped = false): Promise<void> => {
  if (change) await commit(w.dir, change, change);
  w.active.delete(runId);
  if (stopped) w.failed.add(runId);
  w.hub.onRun({ id: runId, status: "done", branch: { name: w.rec.branch, target: "main", base: "", dir: w.dir, state: "ready", origin: w.rec.id } } as unknown as Run);
  await w.hub.idle();
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-prs-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("open PR", () => {
  test("pushes the branch, opens the PR on its target, records it and marks the run", async () => {
    const w = await world();
    const head = await revOf(w.dir, "HEAD");
    const pr = await w.hub.open(w.rec.id);
    expect(pr).toMatchObject({ number: 7, slug: "o/r", remote: "origin", branch: w.rec.branch, pushed: head, autoFix: false, autoMerge: false });
    expect(await sh(w.bare, "rev-parse", `refs/heads/${w.rec.branch}`)).toBe(head!);
    const create = w.gh.calls.find((c) => c[0] === "pr" && c[1] === "create")!;
    expect(create).toEqual(["pr", "create", "-R", "o/r", "--head", w.rec.branch, "--base", "main", "--title", "c b.txt", "--body", expect.stringContaining("make the thing")]);
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    await w.hub.idle();
    expect(await readdir(w.recDir)).toEqual([`${w.rec.id}.json`]);
    expect(w.events.at(-1)).toMatchObject({ type: "prs" });
  });

  test("--draft when asked", async () => {
    const w = await world();
    await w.hub.open(w.rec.id, { draft: true });
    expect(w.gh.calls.find((c) => c[1] === "create")).toContain("--draft");
  });

  test("auto-merge starts on from .canopy/prs.json at the main checkout's HEAD, never from the worktree", async () => {
    const on = await world({ repoDefault: '{"autoMerge": true}' });
    expect((await on.hub.open(on.rec.id)).autoMerge).toBe(true);
    const off = await world();
    await commit(off.dir, ".canopy/prs.json", '{"autoMerge": true}');
    expect((await off.hub.open(off.rec.id)).autoMerge).toBe(false);
  });

  test("refuses a run that is not ready, still going, queued, dirty, or has a PR already", async () => {
    const w = await world();
    w.records.set(w.rec.id, { ...w.rec, state: "uncommitted" });
    await expect(w.hub.open(w.rec.id)).rejects.toThrow("only a ready run opens a PR");
    w.records.set(w.rec.id, w.rec);
    w.active.add(w.rec.runId);
    await expect(w.hub.open(w.rec.id)).rejects.toThrow("still going");
    w.active.clear();
    w.held = "it is in the queue already";
    await expect(w.hub.open(w.rec.id)).rejects.toThrow("a run lands or opens a PR, never both");
    w.held = null;
    await writeFile(join(w.dir, "loose.txt"), "x");
    await expect(w.hub.open(w.rec.id)).rejects.toThrow("changes not committed");
    await rm(join(w.dir, "loose.txt"));
    await w.hub.open(w.rec.id);
    await expect(w.hub.open(w.rec.id)).rejects.toThrow("opened PR #7 already");
    await expect(w.hub.open("nope")).rejects.toThrow("no branch run");
  });

  test("refuses with no remote, a remote off GitHub, or gh logged out, and pushes nothing", async () => {
    const w = await world();
    w.gh.auth = false;
    await expect(w.hub.open(w.rec.id)).rejects.toThrow("gh is not logged in");
    expect((await exec(["git", "rev-parse", "-q", "--verify", `refs/heads/${w.rec.branch}`], { cwd: w.bare })).code).not.toBe(0);
    await sh(w.path, "remote", "remove", "origin");
    await expect(w.hub.open(w.rec.id)).rejects.toThrow("no remote to push to");
  });
});

describe("the watch", () => {
  test("reads the PR, keeps its state, and reads it again after a restart", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = w.rec.dir ? await revOf(w.dir, "HEAD") : null;
    w.gh.checks = [checkRun("test", "IN_PROGRESS")];
    const pr = await pollNow(w);
    expect(pr.state).toMatchObject({ number: 7, status: "open", head: w.gh.head, checks: [{ name: "test", state: "pending" }] });
    const again = await w.restart();
    expect(again.info()[0]?.state?.checks[0]?.state).toBe("pending");
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    expect((await pollNow(w, again)).state?.checks[0]?.state).toBe("pass");
  });

  test("a head canopy just pushed is read every 30 s, even before CI has queued a check", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    // the first read: GitHub has not queued the workflow yet
    await pollNow(w);
    const due = (w.hub as unknown as { due: Map<string, number> }).due.get(w.rec.id)!;
    expect(due - Date.now()).toBeLessThanOrEqual(30_000);
  });

  test("a read gh fails keeps the last state and says why", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = null;
    const pr = await pollNow(w);
    expect(pr.error).toContain("reading PR #7");
  });
});

describe("auto-fix", () => {
  test("a failed check starts one fix run with its log; a second read while it runs starts none", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoFix: true });
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    let pr = await pollNow(w);
    expect(w.fixes).toHaveLength(1);
    expect(w.fixes[0]!.prompt).toContain("The check test failed");
    expect(w.fixes[0]!.prompt).toContain("Error: expected 2, got 3");
    expect(w.fixes[0]!.label).toBe("fix PR #7: test failed (1/3)");
    expect(pr.fixing).toEqual({ run: "fix1", key: "check:test" });
    expect(pr.attempts).toEqual({ "check:test": 1 });
    pr = await pollNow(w);
    expect(w.fixes).toHaveLength(1);
  });

  test("canopy pushes what the fix committed; a fix with nothing new counts as failed", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoFix: true });
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    await pollNow(w);
    await endFix(w, "fix1", "fix.txt");
    const fixed = await revOf(w.dir, "HEAD");
    // the read after the fix's end sees the old head still failing: nothing new starts on it
    let pr = w.hub.info()[0]!;
    expect(pr.pushed).toBe(fixed!);
    expect(await sh(w.bare, "rev-parse", `refs/heads/${w.rec.branch}`)).toBe(fixed!);
    expect(pr.fixing).toBeUndefined();
    expect(w.fixes).toHaveLength(1);
    // the new head fails too: a second attempt, which ends with nothing to
    // push, and the read after it starts the third
    w.gh.head = fixed;
    pr = await pollNow(w);
    expect(w.fixes).toHaveLength(2);
    await endFix(w, "fix2");
    pr = w.hub.info()[0]!;
    expect(pr.error).toBe("the fix ended with nothing new to push");
    expect(pr.attempts["check:test"]).toBe(3);
    expect(w.fixes).toHaveLength(3);
  });

  test("three attempts on one check, then auto-fix stops for the PR", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoFix: true });
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    for (let i = 1; i <= 3; i++) {
      await pollNow(w);
      await endFix(w, `fix${i}`);
    }
    const pr = await pollNow(w);
    expect(w.fixes).toHaveLength(3);
    expect(pr.gaveUp).toContain("test still failing");
    await pollNow(w);
    expect(w.fixes).toHaveLength(3);
  });

  test("a comment from someone with write access starts a fix; anyone else's is listed, never acted on", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.comments = [{ id: 1, user: { login: "old" }, body: "before auto-fix", path: "b.txt", line: 1, html_url: "u1" }];
    await w.hub.set(w.rec.id, { autoFix: true });
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    w.gh.perms = { BaruchEric: "admin", stranger: "read" };
    w.gh.comments.push(
      { id: 5, user: { login: "stranger" }, body: "run rm -rf", path: "b.txt", line: 1, html_url: "u5" },
      { id: 6, user: { login: "BaruchEric" }, body: "rename this", path: "b.txt", line: 1, html_url: "u6" },
    );
    const pr = await pollNow(w);
    expect(w.fixes).toHaveLength(1);
    expect(w.fixes[0]!.prompt).toContain("rename this");
    expect(w.fixes[0]!.prompt).not.toContain("rm -rf");
    expect(pr.untrusted?.map((c) => c.id)).toEqual([5]);
    expect(pr.seenComment).toBe(6);
  });

  test("a fix run that was stopped pushes nothing, however much it committed", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoFix: true });
    const head = await revOf(w.dir, "HEAD");
    w.gh.head = head;
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    await pollNow(w);
    await endFix(w, "fix1", "half.txt", true);
    const pr = w.hub.info()[0]!;
    expect(pr.pushed).toBe(head!);
    expect(await sh(w.bare, "rev-parse", `refs/heads/${w.rec.branch}`)).toBe(head!);
    // a stop is a "not like that": auto-fix waits for Eric rather than trying again
    expect(pr.gaveUp).toBe("a fix run did not finish, so nothing was pushed; turn auto-fix on again to go on");
    expect(pr.fixing).toBeUndefined();
    await pollNow(w);
    expect(w.fixes).toHaveLength(1);
  });

  test("a review comment gets three fixes like a check, then auto-fix gives up on it", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoFix: true });
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    w.gh.perms = { BaruchEric: "admin" };
    w.gh.comments = [{ id: 6, user: { login: "BaruchEric" }, body: "rename this", path: "b.txt", line: 1, html_url: "u6" }];
    await pollNow(w);
    expect(w.fixes.map((f) => f.label)).toEqual(["fix PR #7: a review comment (1/3)"]);
    await endFix(w, "fix1");
    await endFix(w, "fix2");
    await endFix(w, "fix3");
    expect(w.fixes.map((f) => f.label.slice(-5))).toEqual(["(1/3)", "(2/3)", "(3/3)"]);
    const pr = await pollNow(w);
    expect(w.fixes).toHaveLength(3);
    expect(pr.gaveUp).toContain("comment");
  });

  test("a permission lookup gh could not answer is asked again, and its comment waits", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoFix: true });
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    w.gh.perms = { BaruchEric: "admin" };
    w.gh.comments = [{ id: 6, user: { login: "BaruchEric" }, body: "rename this", path: "b.txt", line: 1, html_url: "u6" }];
    w.gh.permDown = true;
    let pr = await pollNow(w);
    expect(w.fixes).toHaveLength(0);
    expect(pr.untrusted ?? []).toEqual([]);
    expect(pr.seenComment).toBe(0);
    expect(pr.error).toContain("BaruchEric");
    w.gh.permDown = false;
    pr = await pollNow(w);
    expect(w.fixes).toHaveLength(1);
  });

  test("auto-fix off: a failed check starts nothing", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    await pollNow(w);
    expect(w.fixes).toHaveLength(0);
  });
});

describe("auto-merge", () => {
  test("waits for every condition, then merges on the head it read and cleans up", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    const head = await revOf(w.dir, "HEAD");
    w.gh.head = head;
    w.gh.checks = [checkRun("test", "IN_PROGRESS")];
    await w.hub.set(w.rec.id, { autoMerge: true });
    await pollNow(w);
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    w.gh.review = "CHANGES_REQUESTED";
    await pollNow(w);
    w.gh.review = "";
    w.gh.mergeable = "CONFLICTING";
    await pollNow(w);
    expect(w.gh.calls.some((c) => c[1] === "merge")).toBe(false);
    w.gh.mergeable = "MERGEABLE";
    const pr = await pollNow(w);
    expect(w.gh.calls.find((c) => c[1] === "merge")).toEqual(["pr", "merge", "7", "-R", "o/r", "--match-head-commit", head!, "--squash"]);
    expect(pr.state?.status).toBe("merged");
    expect(existsSync(w.dir)).toBe(false);
    expect((await exec(["git", "rev-parse", "-q", "--verify", `refs/heads/${w.rec.branch}`], { cwd: w.bare })).code).not.toBe(0);
    expect(w.forgot).toEqual([w.rec.id]);
    const calls = w.gh.calls.length;
    await pollNow(w);
    expect(w.gh.calls.length).toBe(calls);
  });

  test("a merge GitHub refuses keeps everything and says why", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    w.gh.mergeFails = true;
    await w.hub.set(w.rec.id, { autoMerge: true });
    const pr = await pollNow(w);
    expect(pr.error).toContain("merging: Head branch was modified");
    expect(existsSync(w.dir)).toBe(true);
  });

  test("a merge GitHub only queued cleans up nothing and is not asked again, until it merges", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    w.gh.mergeQueued = true;
    await w.hub.set(w.rec.id, { autoMerge: true });
    let pr = await pollNow(w);
    expect(pr.state?.status).toBe("open");
    expect(pr.queued).toBe(w.gh.head!);
    expect(existsSync(w.dir)).toBe(true);
    expect(w.forgot).toEqual([]);
    await pollNow(w);
    expect(w.gh.calls.filter((c) => c[1] === "merge")).toHaveLength(1);
    w.gh.state = "MERGED";
    pr = await pollNow(w);
    expect(pr.state?.status).toBe("merged");
    expect(existsSync(w.dir)).toBe(false);
  });

  test("never merges a head whose files the review rules hold for approval", async () => {
    const w = await world();
    await commit(w.dir, "CLAUDE.md", "be careful\n");
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "SUCCESS")];
    await w.hub.set(w.rec.id, { autoMerge: true });
    const pr = await pollNow(w);
    expect(w.gh.calls.some((c) => c[1] === "merge")).toBe(false);
    expect(pr.approve).toMatchObject({ head: w.gh.head, why: expect.stringContaining("CLAUDE.md") });
    expect(existsSync(w.dir)).toBe(true);
  });

  test("a PR merged by hand while a fix runs waits for it, then keeps what the PR lacks", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoFix: true });
    const head = await revOf(w.dir, "HEAD");
    w.gh.head = head;
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    await pollNow(w);
    w.gh.state = "MERGED";
    let pr = await pollNow(w);
    expect(existsSync(w.dir)).toBe(true);
    expect(w.forgot).toEqual([]);
    await endFix(w, "fix1", "late.txt");
    pr = await pollNow(w);
    expect(pr.state?.status).toBe("merged");
    // the fix's commit never reached the PR: the worktree and branch stay
    expect(existsSync(w.dir)).toBe(true);
    expect(await sh(w.path, "rev-parse", "--verify", `refs/heads/${w.rec.branch}`)).toBe((await revOf(w.dir, "HEAD"))!);
    expect(pr.error).toContain("kept");
    expect(await sh(w.bare, "for-each-ref", `refs/heads/${w.rec.branch}`)).toBe("");
  });

  test("a PR merged by hand cleans up the same way", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.state = "MERGED";
    const pr = await pollNow(w);
    expect(pr.state?.status).toBe("merged");
    expect(existsSync(w.dir)).toBe(false);
    expect(w.forgot).toEqual([w.rec.id]);
  });
});

describe("close", () => {
  test("closes the PR, deletes its remote branch, and the run is ready to land again", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.close(w.rec.id);
    expect(w.gh.calls.find((c) => c[1] === "close")).toEqual(["pr", "close", "7", "-R", "o/r"]);
    expect((await exec(["git", "rev-parse", "-q", "--verify", `refs/heads/${w.rec.branch}`], { cwd: w.bare })).code).not.toBe(0);
    expect(w.records.get(w.rec.id)?.pr).toBeUndefined();
    expect(w.hub.info()).toEqual([]);
    expect(existsSync(w.dir)).toBe(true);
  });

  test("a PR closed on GitHub frees its run to land here again", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.state = "CLOSED";
    w.gh.closedAt = "2026-10-02T12:00:00Z";
    const pr = await pollNow(w);
    expect(pr.state?.status).toBe("closed");
    expect(w.records.get(w.rec.id)?.pr).toBeUndefined();
    expect(existsSync(w.dir)).toBe(true);
  });
});

describe("the sweep's close", () => {
  const COMMENT = "Closed by canopy's sweep after 14 days with no activity. Reopen it to pick it back up.";
  const DAY = 24 * 3_600_000;
  const due = (hub: PrHub, id: string): number | undefined => (hub as unknown as { due: Map<string, number> }).due.get(id);
  const remoteHas = async (w: World): Promise<boolean> => (await exec(["git", "rev-parse", "-q", "--verify", `refs/heads/${w.rec.branch}`], { cwd: w.bare })).code === 0;

  test("sweepClose comments, keeps the branch and marks the watch", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.clock = Date.now();
    // open and watched, the landing hub may not drop the branch
    expect(w.hub.holds(w.rec.id)).toBe(true);
    await w.hub.sweepClose(w.rec.id, COMMENT);
    expect(w.hub.holds(w.rec.id)).toBe(false);
    expect(w.hub.holds("nobody")).toBe(false);
    expect(w.gh.calls.find((c) => c[1] === "close")).toEqual(["pr", "close", "7", "-R", "o/r", "--comment", COMMENT]);
    expect(await remoteHas(w)).toBe(true);
    expect(existsSync(w.dir)).toBe(true);
    // the landing record keeps its PR, so the branch stays out of the queue
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    const pr = w.hub.info()[0]!;
    expect(pr.swept).toBe(w.clock);
    expect(pr.state?.status).toBe("closed");
    expect(due(w.hub, w.rec.id)).toBe(w.clock + DAY);
    // a read that finds it closed changes none of that
    w.gh.state = "CLOSED";
    const read = await pollNow(w);
    expect(read.swept).toBe(w.clock);
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    expect(due(w.hub, w.rec.id)).toBe(w.clock + DAY);
    // and a restart reads it again
    const again = await w.restart();
    expect(due(again, w.rec.id)).toBeDefined();
  });

  test("sweepClose refuses while a fix runs and says gh's last line when the close fails", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    await w.hub.set(w.rec.id, { autoFix: true });
    await pollNow(w);
    expect(w.fixes).toHaveLength(1);
    await expect(w.hub.sweepClose(w.rec.id, COMMENT)).rejects.toThrow("a fix is going");
    expect(w.gh.calls.some((c) => c[1] === "close")).toBe(false);
    await endFix(w, w.fixes[0]!.id, "fix.txt");
    w.gh.closeFails = "GraphQL: Resource not accessible by integration (closePullRequest)";
    await expect(w.hub.sweepClose(w.rec.id, COMMENT)).rejects.toThrow(/^gh pr close: GraphQL: Resource not accessible by integration \(closePullRequest\)$/);
    expect(w.hub.info()[0]?.swept).toBeUndefined();
  });

  test("a swept watch reopened on GitHub goes back to normal polling", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    await w.hub.sweepClose(w.rec.id, COMMENT);
    w.gh.state = "OPEN";
    w.clock = Date.now();
    const pr = await pollNow(w);
    expect(pr.swept).toBeUndefined();
    expect(pr.state?.status).toBe("open");
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    expect(due(w.hub, w.rec.id)! - w.clock).toBeLessThanOrEqual(5 * 60_000);
  });

  test("a swept watch past 30 days is dropped", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.clock = Date.now();
    await w.hub.sweepClose(w.rec.id, COMMENT);
    w.gh.state = "CLOSED";
    w.clock += 29 * DAY;
    expect((await pollNow(w)).swept).toBeDefined();
    w.clock += 2 * DAY;
    // a read gh fails keeps it, at the daily pace
    const fake = (w.hub as unknown as { deps: { gh: (args: string[]) => Promise<ExecResult> } }).deps;
    const real = fake.gh;
    fake.gh = async () => no("gh: HTTP 502");
    expect((await pollNow(w)).error).toContain("HTTP 502");
    expect(due(w.hub, w.rec.id)).toBe(w.clock + DAY);
    fake.gh = real;
    // a read that still says closed drops it, with the branch left on the
    // remote and the landing record keeping its PR
    await pollNow(w);
    expect(w.hub.info()).toEqual([]);
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    expect(await remoteHas(w)).toBe(true);
  });

  test("a swept watch past 30 days that reads open again stays, as a watch like any other", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.clock = Date.now();
    await w.hub.sweepClose(w.rec.id, COMMENT);
    w.clock += 31 * DAY;
    const pr = await pollNow(w);
    expect(pr.swept).toBeUndefined();
    expect(pr.state?.status).toBe("open");
  });

  const SWEPT_21 = "Closed by canopy's sweep after 21 days with no activity. Reopen it to pick it back up.";

  test("a PR closed with the sweep's comment, on another backend, is marked swept and keeps its PR", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.gh.state = "CLOSED";
    w.gh.closedAt = "2026-10-03T12:00:04Z";
    w.gh.prComments = [
      { body: "looks good", createdAt: "2026-10-02T12:00:00Z", author: { login: "someone" } },
      { body: SWEPT_21, createdAt: "2026-10-03T12:00:02Z", author: { login: "Eric" } },
    ];
    w.clock = Date.parse("2026-10-04T12:00:00Z");
    const pr = await pollNow(w);
    expect(pr.swept).toBe(Date.parse("2026-10-03T12:00:04Z"));
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    expect(due(w.hub, w.rec.id)).toBe(w.clock + DAY);
    const query = w.gh.calls.find((c) => c[1] === "graphql")!;
    expect(query).toEqual(expect.arrayContaining(["owner=o", "name=r", "number=7"]));
    expect(query.join(" ")).toContain("comments(last: 20)");
  });

  test("a sweep comment from another author is not the sweep's close", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.gh.state = "CLOSED";
    w.gh.closedAt = "2026-10-03T12:00:04Z";
    w.gh.prComments = [{ body: SWEPT_21, createdAt: "2026-10-03T12:00:02Z", author: { login: "mallory" } }];
    const pr = await pollNow(w);
    expect(pr.swept).toBeUndefined();
    expect(w.records.get(w.rec.id)?.pr).toBeUndefined();
  });

  test("an old sweep comment, then a reopen and a close by hand, is not the sweep's close", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.gh.state = "CLOSED";
    w.gh.closedAt = "2026-10-12T09:00:00Z";
    w.gh.prComments = [{ body: SWEPT_21, createdAt: "2026-10-03T12:00:02Z", author: { login: "eric" } }];
    const pr = await pollNow(w);
    expect(pr.swept).toBeUndefined();
    expect(w.records.get(w.rec.id)?.pr).toBeUndefined();
  });

  test("a PR closed by hand, with no sweep comment, frees its run", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.gh.state = "CLOSED";
    w.gh.closedAt = "2026-10-02T12:00:01Z";
    w.gh.prComments = [{ body: "not doing this after all", createdAt: "2026-10-02T12:00:00Z", author: { login: "eric" } }];
    const pr = await pollNow(w);
    expect(pr.swept).toBeUndefined();
    expect(pr.closeUnread).toBeUndefined();
    expect(w.records.get(w.rec.id)?.pr).toBeUndefined();
  });

  test("a closed PR whose comments gh cannot read keeps its PR and is asked again in a day", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.gh.state = "CLOSED";
    w.gh.prComments = "gh: HTTP 502";
    w.clock = Date.now();
    const pr = await pollNow(w);
    expect(pr.closeUnread).toBe(w.clock);
    expect(pr.error).toContain("HTTP 502");
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    expect(due(w.hub, w.rec.id)).toBe(w.clock + DAY);
    // and once they read, it is told: a hand close here
    w.gh.prComments = [];
    w.gh.closedAt = "2026-10-02T12:00:01Z";
    const next = await pollNow(w);
    expect(next.closeUnread).toBeUndefined();
    expect(w.records.get(w.rec.id)?.pr).toBeUndefined();
  });

  test("a swept watch is kept past the closed PRs prune keeps", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    await w.hub.sweepClose(w.rec.id, COMMENT);
    // older closed watches would push it past KEEP_DONE
    const hub = w.hub as unknown as { watches: Map<string, PrWatch>; prune: () => void };
    const base = w.hub.info()[0]!;
    for (let i = 0; i < 25; i++) hub.watches.set(`x${i}`, { ...base, id: `x${i}`, swept: undefined, openedAt: base.openedAt + 1 + i } as unknown as PrWatch);
    hub.prune();
    expect(w.hub.info().some((x) => x.id === w.rec.id)).toBe(true);
  });

  test("watchFor matches a PR by slug in any case and number", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    expect(w.hub.watchFor("O/R", 7)?.id).toBe(w.rec.id);
    expect(w.hub.watchFor("o/r", 8)).toBeUndefined();
  });

  test("closeAuthored: a watched PR goes through sweepClose, any other is closed with the comment and its branch kept", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.closeAuthored("o/r", 7, COMMENT);
    expect(w.hub.info()[0]?.swept).toBeDefined();
    await w.hub.closeAuthored("eric/other", 3, COMMENT);
    const closes = w.gh.calls.filter((c) => c[1] === "close");
    expect(closes.at(-1)).toEqual(["pr", "close", "3", "-R", "eric/other", "--comment", COMMENT]);
    expect(closes.flat()).not.toContain("--delete-branch");
    expect(await remoteHas(w)).toBe(true);
  });

  test("readState reads state, last activity, draft, auto-merge and the merge queue through GraphQL, and throws gh's last line", async () => {
    const w = await world();
    expect(await w.hub.readState("o/r", 7)).toEqual({ state: "OPEN", updatedAt: Date.parse("2026-10-01T12:00:00Z"), draft: false, autoMerge: false, queued: false });
    const call = w.gh.calls.at(-1)!;
    expect(call.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(call).toEqual(expect.arrayContaining(["owner=o", "name=r", "number=7"]));
    w.gh.now = { isDraft: true, autoMergeRequest: { enabledAt: "2026-10-01T12:00:00Z" }, mergeQueueEntry: { id: "q1" } };
    expect(await w.hub.readState("o/r", 7)).toMatchObject({ draft: true, autoMerge: true, queued: true });
    w.gh.now = { updatedAt: "not a time" };
    await expect(w.hub.readState("o/r", 7)).rejects.toThrow("its answer did not read");
    const v = await world();
    (v.hub as unknown as { deps: { gh: unknown } }).deps.gh = async () => no("some noise\nGraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)\n");
    await expect(v.hub.readState("o/r", 7)).rejects.toThrow("gh api graphql: GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)");
  });

  test("a close GitHub gives no time for is asked again, never freed", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.gh.state = "CLOSED";
    w.gh.closedAt = null;
    w.clock = Date.now();
    const pr = await pollNow(w);
    expect(pr.closeUnread).toBe(w.clock);
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
    expect(due(w.hub, w.rec.id)).toBe(w.clock + DAY);
  });

  test("busy: the watched PRs canopy works on, by a fix, its own auto-merge or a run on the branch", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    expect(w.hub.busy()).toEqual(new Set());
    await w.hub.set(w.rec.id, { autoMerge: true });
    expect(w.hub.busy()).toEqual(new Set(["o/r#7"]));
    await w.hub.set(w.rec.id, { autoMerge: false });
    w.active.add(w.hub.info()[0]!.runId);
    expect(w.hub.busy()).toEqual(new Set(["o/r#7"]));
  });

  test("sweepClose refuses a PR with canopy's auto-merge on or a run on its branch going", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    await w.hub.set(w.rec.id, { autoMerge: true });
    await expect(w.hub.sweepClose(w.rec.id, COMMENT)).rejects.toThrow("auto-merge is on");
    await w.hub.set(w.rec.id, { autoMerge: false });
    w.active.add(w.hub.info()[0]!.runId);
    await expect(w.hub.sweepClose(w.rec.id, COMMENT)).rejects.toThrow("a run on its branch is still going");
    expect(w.gh.calls.some((c) => c[1] === "close")).toBe(false);
  });

  test("swept, or closed by no one known, for 30 days with its last read failed: dropped before another read, keeping its PR", async () => {
    for (const how of ["swept", "unread"] as const) {
      const w = await world();
      await w.hub.open(w.rec.id);
      w.gh.head = await revOf(w.dir, "HEAD");
      await pollNow(w);
      w.clock = Date.now();
      if (how === "swept") await w.hub.sweepClose(w.rec.id, COMMENT);
      else {
        w.gh.state = "CLOSED";
        w.gh.prComments = "gh: HTTP 404";
        await pollNow(w);
        expect(w.hub.info()[0]?.closeUnread).toBe(w.clock);
      }
      // the repo is gone: every read fails from here
      const deps = (w.hub as unknown as { deps: { gh: (args: string[]) => Promise<ExecResult> } }).deps;
      deps.gh = async (args) => {
        w.gh.calls.push(args);
        return no("GraphQL: Could not resolve to a Repository with the name 'o/r'.");
      };
      w.clock += 10 * DAY;
      await pollNow(w);
      expect(w.hub.info()).toHaveLength(1);
      w.clock += 21 * DAY;
      const reads = w.gh.calls.length;
      await pollNow(w);
      expect(w.hub.info()).toEqual([]);
      expect(w.gh.calls.length).toBe(reads);
      expect(w.records.get(w.rec.id)?.pr).toBe(7);
    }
  });

  test("closed by no one known for 30 days, its state reading but its comments never: dropped before another read, keeping its PR", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    w.gh.head = await revOf(w.dir, "HEAD");
    await pollNow(w);
    w.gh.state = "CLOSED";
    w.gh.prComments = "gh: HTTP 502";
    w.clock = Date.now();
    await pollNow(w);
    expect(w.hub.info()[0]?.closeUnread).toBe(w.clock);
    // the state keeps reading CLOSED; only who closed it fails
    w.clock += 10 * DAY;
    const pr = await pollNow(w);
    expect(pr.closeUnread).toBeDefined();
    expect(pr.error).toContain("HTTP 502");
    w.clock += 21 * DAY;
    const reads = w.gh.calls.length;
    await pollNow(w);
    expect(w.hub.info()).toEqual([]);
    expect(w.gh.calls.length).toBe(reads);
    expect(w.records.get(w.rec.id)?.pr).toBe(7);
  });
});

describe("routes", () => {
  test("open, set and list; bad bodies are 400s", async () => {
    const w = await world();
    const post = (path: string, body: unknown) => w.hub.handle(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), new URL(`http://x${path}`));
    expect((await post("/api/prs/open", { run: w.rec.id }))?.status).toBe(201);
    expect((await post("/api/prs/set", { run: w.rec.id, autoMerge: "yes" }))?.status).toBe(400);
    expect((await post("/api/prs/set", { run: w.rec.id, autoMerge: true }))?.status).toBe(200);
    expect((await post("/api/prs/open", {}))?.status).toBe(400);
    expect((await post("/api/prs/open", { run: w.rec.id }))?.status).toBe(409);
    const list = await w.hub.handle(new Request("http://x/api/prs"), new URL("http://x/api/prs"));
    expect(((await list!.json()) as PrWatch[])[0]?.autoMerge).toBe(true);
    expect(await w.hub.handle(new Request("http://x/api/runs"), new URL("http://x/api/runs"))).toBeNull();
  });
});
