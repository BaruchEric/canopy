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
  const g: Gh = { calls: [], auth: true, checks: [], head: null, state: "OPEN", review: "", mergeable: "MERGEABLE", comments: [], perms: {}, mergeFails: false, mergeQueued: false, permDown: false };
  const records = new Map([[id, rec]]);
  const recDir = join(root, `prs${n}`);
  const w = { path, bare, dir, rec, records, gh: g, events: [], fixes: [], active: new Set<string>(), failed: new Set<string>(), forgot: [], held: null, recDir } as unknown as World;
  const fake = async (args: string[]): Promise<ExecResult> => {
    g.calls.push(args);
    const [a, b] = args;
    if (a === "auth") return g.auth ? ok("Logged in") : no("not logged in");
    if (a === "pr" && b === "create") return ok(`https://github.com/o/r/pull/7\n`);
    if (a === "pr" && b === "view") return ok(JSON.stringify(view(g)));
    if (a === "pr" && b === "merge") {
      if (g.mergeFails) return no("Head branch was modified");
      if (!g.mergeQueued) g.state = "MERGED";
      return ok("");
    }
    if (a === "pr" && b === "close") return ok("");
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
    const pr = await pollNow(w);
    expect(pr.state?.status).toBe("closed");
    expect(w.records.get(w.rec.id)?.pr).toBeUndefined();
    expect(existsSync(w.dir)).toBe(true);
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
