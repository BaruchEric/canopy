import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import {
  addRunTree,
  aheadOf,
  currentBranch,
  defaultBranch,
  dirtyFiles,
  ffMain,
  listRunTreeDirs,
  listWarmTreeDirs,
  overwrittenFiles,
  midRebase,
  pushBranch,
  pushRemote,
  rebaseOnto,
  removeRunTree,
  repoAtPath,
  repoKey,
  revOf,
  showAtHead,
  subjectsSince,
  takeWarm,
  runTreeDir,
  detachedTree,
  treeSize,
  treeRepo,
  treeState,
} from "./worktree";

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
/** A fresh repo with one commit on main, identity set. */
const repo = async (): Promise<string> => {
  const dir = join(root, `r${++n}`);
  await exec(["git", "init", "-q", "-b", "main", dir]);
  await sh(dir, "config", "user.email", "t@t");
  await sh(dir, "config", "user.name", "t");
  await commit(dir, "a.txt", "one\ntwo\nthree\n");
  return dir;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-wt-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("names", () => {
  test("a repo key keeps the folder name and hashes the path", () => {
    expect(repoKey("/a/b/canopy")).toMatch(/^canopy-[0-9a-f]{8}$/);
    expect(repoKey("/a/b/canopy")).not.toBe(repoKey("/c/canopy"));
    expect(runTreeDir("/a/b/canopy", "abc123", "/w")).toBe(`/w/${repoKey("/a/b/canopy")}/abc123`);
  });

  test("overwritten files are read off git's message", () => {
    const msg = "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tdocs/b.md\nPlease commit your changes or stash them before you merge.\nAborting\n";
    expect(overwrittenFiles(msg)).toEqual(["a.txt", "docs/b.md"]);
    expect(overwrittenFiles("fatal: Not possible to fast-forward, aborting.")).toEqual([]);
  });
});

describe("run worktrees", () => {
  test("add, settle states, list, and remove with the branch", async () => {
    const r = await repo();
    const base = (await revOf(r, "main"))!;
    expect(await defaultBranch(r)).toBe("main");
    const wts = join(root, "wts");
    const dir = runTreeDir(r, "run1", wts);
    await addRunTree(r, dir, "run/x-run1", base);
    expect(await currentBranch(dir)).toBe("run/x-run1");
    expect(await treeRepo(dir)).toBe(await sh(r, "rev-parse", "--show-toplevel"));
    expect(await treeState(dir, base)).toBe("nothing");
    await writeFile(join(dir, "b.txt"), "b\n");
    expect(await dirtyFiles(dir)).toEqual(["b.txt"]);
    expect(await treeState(dir, base)).toBe("uncommitted");
    await commit(dir, "b.txt", "b\n");
    expect(await aheadOf(dir, base)).toBe(1);
    expect(await treeState(dir, base)).toBe("ready");
    expect(await listRunTreeDirs(wts)).toEqual([dir]);
    await removeRunTree(r, dir, "run/x-run1");
    expect(existsSync(dir)).toBe(false);
    expect(await revOf(r, "run/x-run1")).toBeNull();
  });

  test("a clean rebase, then a fast-forward of main", async () => {
    const r = await repo();
    const dir = join(root, "wt-clean");
    await addRunTree(r, dir, "run/clean", "main");
    await commit(dir, "b.txt", "b\n");
    await commit(r, "c.txt", "c\n");
    const head = (await revOf(r, "HEAD"))!;
    expect(await rebaseOnto(dir, head)).toEqual({ ok: true });
    expect(await aheadOf(dir, head)).toBe(1);
    expect(await ffMain(r, "run/clean")).toEqual({ ok: true });
    expect(await revOf(r, "HEAD")).toBe((await revOf(dir, "HEAD"))!);
    expect(existsSync(join(r, "b.txt"))).toBe(true);
  });

  test("a conflict is aborted and names its files", async () => {
    const r = await repo();
    const dir = join(root, "wt-conflict");
    await addRunTree(r, dir, "run/conflict", "main");
    await commit(dir, "a.txt", "one\nTWO from the run\nthree\n");
    await commit(r, "a.txt", "one\nTWO from main\nthree\n");
    const before = (await revOf(dir, "HEAD"))!;
    expect(await rebaseOnto(dir, (await revOf(r, "HEAD"))!)).toEqual({ conflict: ["a.txt"] });
    expect(await revOf(dir, "HEAD")).toBe(before);
    expect(await dirtyFiles(dir)).toEqual([]);
  });

  test("rebase checks detect a linked worktree's interrupted rebase", async () => {
    const r = await repo();
    const base = await revOf(r, "main");
    if (!base) throw new Error("main should have a starting commit");
    const dir = join(root, "wt-interrupted");
    await addRunTree(r, dir, "run/interrupted", base);
    await commit(dir, "a.txt", "run version\n");
    await commit(r, "a.txt", "main version\n");

    const failed = await exec(["git", "rebase", "main"], { cwd: dir });
    expect(failed.code).not.toBe(0);
    expect(await midRebase(dir)).toBe(true);

    expect(await rebaseOnto(dir, base)).toEqual({ ok: true });
    expect(await midRebase(dir)).toBe(false);
    expect(await currentBranch(dir)).toBe("run/interrupted");
  });

  test("a warm tree moves onto a run branch and keeps ignored setup files", async () => {
    const r = await repo();
    await commit(r, ".gitignore", "node_modules/\n");
    const wts = join(root, "wts-warm");
    const warm = join(wts, repoKey(r), "warm-1");
    const base = await revOf(r, "main");
    if (!base) throw new Error("main should have a base commit");
    await detachedTree(r, warm, base);
    expect(await currentBranch(warm)).toBeNull();
    await mkdir(join(warm, "node_modules"));
    await writeFile(join(warm, "node_modules", "x"), "x");
    const tip = await commit(r, "c.txt", "c\n");
    const dir = runTreeDir(r, "run9", wts);

    await takeWarm(r, warm, dir, "run/x-run9", tip);

    expect(existsSync(warm)).toBe(false);
    expect(await currentBranch(dir)).toBe("run/x-run9");
    expect(await revOf(dir, "HEAD")).toBe(tip);
    expect(await readFile(join(dir, "node_modules", "x"), "utf8")).toBe("x");
    expect(existsSync(join(dir, "c.txt"))).toBe(true);
    expect(await dirtyFiles(dir)).toEqual([]);
    expect(await sh(r, "worktree", "list", "--porcelain")).toContain(`worktree ${await realpath(dir)}`);
    expect(await treeSize(dir)).toBeGreaterThan(0);
    expect(await treeSize(join(root, "nowhere"))).toBe(0);
    expect(await midRebase(dir)).toBe(false);
  });

  test("move failures keep source and destination ownership intact", async () => {
    const r = await repo();
    const wts = join(root, "wts-move-fail");
    const warm = join(wts, repoKey(r), "warm-1");
    const base = await revOf(r, "main");
    if (!base) throw new Error("main should have a base commit");
    await detachedTree(r, warm, base);

    const occupied = join(wts, repoKey(r), "run-occupied");
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "keep.txt"), "keep");
    await expect(takeWarm(r, warm, occupied, "run/occupied", base)).rejects.toThrow();
    expect(existsSync(warm)).toBe(true);
    expect(await readFile(join(occupied, "keep.txt"), "utf8")).toBe("keep");
    expect(await sh(r, "worktree", "list", "--porcelain")).toContain(`worktree ${await realpath(warm)}`);

    const moved = join(wts, repoKey(r), "run-bad-ref");
    await expect(takeWarm(r, warm, moved, "run/bad-ref", "missing-ref")).rejects.toThrow();
    expect(existsSync(warm)).toBe(false);
    expect(await currentBranch(moved)).toBeNull();
    expect(await revOf(moved, "HEAD")).toBe(base);
    expect(await sh(r, "worktree", "list", "--porcelain")).toContain(`worktree ${await realpath(moved)}`);
    await expect(takeWarm(r, join(wts, "missing"), join(wts, "never-made"), "run/missing", base)).rejects.toThrow();
    expect(existsSync(join(wts, "never-made"))).toBe(false);
  });

  test("a warm take refuses an existing run ref without moving its commit", async () => {
    const r = await repo();
    const wts = join(root, "wts-existing-ref");
    const warm = join(wts, repoKey(r), "warm-1");
    const base = await revOf(r, "main");
    if (!base) throw new Error("main should have a base commit");
    await detachedTree(r, warm, base);
    const other = await commit(r, "unrelated.txt", "other branch's work\n");
    await sh(r, "branch", "run/existing", other);
    const to = runTreeDir(r, "existing", wts);

    await expect(takeWarm(r, warm, to, "run/existing", base)).rejects.toThrow();

    expect(await revOf(r, "run/existing")).toBe(other);
    expect(existsSync(warm)).toBe(false);
    expect(await currentBranch(to)).toBeNull();
    expect(await revOf(to, "HEAD")).toBe(base);
    expect(await sh(r, "worktree", "list", "--porcelain")).toContain(`worktree ${await realpath(to)}`);
  });

  test("only valid warm slots are excluded from run orphans", async () => {
    const r = await repo();
    const wts = join(root, "wts-list");
    const run = runTreeDir(r, "run1", wts);
    await addRunTree(r, run, "run/x-run1", "main");
    const repoDir = join(wts, repoKey(r));
    const warm = join(repoDir, "warm-1");
    const base = await revOf(r, "main");
    if (!base) throw new Error("main should have a base commit");
    await detachedTree(r, warm, base);
    await mkdir(join(repoDir, "warm-2"));
    await mkdir(join(repoDir, "warm-0"));
    await writeFile(join(repoDir, "warm.json"), "{}");
    expect(await listRunTreeDirs(wts)).toEqual([run, join(repoDir, "warm-0")]);
    expect(await listWarmTreeDirs(r, wts)).toEqual([warm, join(repoDir, "warm-2")]);
    expect(await listWarmTreeDirs(join(root, "no-such-repo"), wts)).toEqual([]);
  });

  test("a dirty main checkout refuses the fast-forward and names the files", async () => {
    const r = await repo();
    const dir = join(root, "wt-busy");
    await addRunTree(r, dir, "run/busy", "main");
    await commit(dir, "a.txt", "one\nchanged\nthree\n");
    await writeFile(join(r, "a.txt"), "one\nlocal edit\nthree\n");
    expect(await ffMain(r, "run/busy")).toEqual({ busy: ["a.txt"] });
  });

  test("main moved past the branch: not a fast-forward", async () => {
    const r = await repo();
    const dir = join(root, "wt-moved");
    await addRunTree(r, dir, "run/moved", "main");
    await commit(dir, "b.txt", "b\n");
    await commit(r, "c.txt", "c\n");
    expect(await ffMain(r, "run/moved")).toEqual({ moved: true });
  });

  test("a checkout off its branch reads as detached", async () => {
    const r = await repo();
    await sh(r, "checkout", "-q", "--detach");
    expect(await currentBranch(r)).toBeNull();
  });
});

describe("repoAtPath", () => {
  test("a repo scanned through a symlink matches git's real path, and an exact path wins", async () => {
    const real = await realpath(await mkdtemp(join(tmpdir(), "canopy-wt-real-")));
    const link = join(root, "linked");
    await symlink(real, link);
    const viaLink = { id: "a", path: link };
    const remote = { id: "r", path: "ssh://box/x" };
    expect(repoAtPath([remote, viaLink], real)).toBe(viaLink);
    const exact = { id: "b", path: real };
    expect(repoAtPath([viaLink, exact], real)).toBe(exact);
    expect(repoAtPath([remote, viaLink], "/nowhere")).toBeUndefined();
    await rm(real, { recursive: true, force: true });
  });
});

describe("pushing a run's branch", () => {
  /** A repo with a bare remote named `name` it has pushed main to. */
  const withRemote = async (name = "origin"): Promise<{ r: string; bare: string }> => {
    const r = await repo();
    const bare = join(root, `bare${++n}.git`);
    await exec(["git", "init", "-q", "--bare", bare]);
    await sh(r, "remote", "add", name, bare);
    await sh(r, "push", "-q", name, "main");
    return { r, bare };
  };

  test("pushes the branch under its own name, and refuses a push that is not a fast-forward", async () => {
    const { r, bare } = await withRemote();
    const dir = runTreeDir(r, "p1", join(root, "wts-push"));
    await addRunTree(r, dir, "run/p-p1", "main");
    const head = await commit(dir, "b.txt", "b\n");
    expect(await pushBranch(dir, "origin", "run/p-p1")).toEqual({ ok: true });
    expect(await sh(bare, "rev-parse", "refs/heads/run/p-p1")).toBe(head);
    // someone else moved the branch on the remote: no force, so it is refused
    const other = join(root, `clone${++n}`);
    await exec(["git", "clone", "-q", "-b", "run/p-p1", bare, other]);
    await sh(other, "config", "user.email", "t@t");
    await sh(other, "config", "user.name", "t");
    await commit(other, "c.txt", "c\n");
    await sh(other, "push", "-q", "origin", "run/p-p1");
    await commit(dir, "d.txt", "d\n");
    const res = await pushBranch(dir, "origin", "run/p-p1");
    expect("rejected" in res).toBe(true);
  });

  test("pushRemote: the target's upstream remote, else origin, else the only one, else none", async () => {
    const { r } = await withRemote("up");
    expect(await pushRemote(r, "main")).toBe("up");
    await sh(r, "branch", "-q", "--set-upstream-to=up/main", "main");
    await sh(r, "remote", "add", "origin", join(root, "nowhere.git"));
    expect(await pushRemote(r, "main")).toBe("up");
    await sh(r, "branch", "-q", "--unset-upstream", "main");
    expect(await pushRemote(r, "main")).toBe("origin");
    expect(await pushRemote(await repo(), "main")).toBeNull();
  });

  test("showAtHead reads a file as HEAD holds it, not as the folder does", async () => {
    const r = await repo();
    await commit(r, ".canopy/prs.json", '{"autoMerge": true}');
    await writeFile(join(r, ".canopy/prs.json"), "{}");
    expect(await showAtHead(r, ".canopy/prs.json")).toBe('{"autoMerge": true}');
    expect(await showAtHead(r, ".canopy/none.json")).toBeNull();
  });

  test("subjectsSince lists the branch's commit subjects, oldest first", async () => {
    const r = await repo();
    await sh(r, "checkout", "-q", "-b", "topic");
    await commit(r, "x.txt", "x");
    await commit(r, "y.txt", "y");
    expect(await subjectsSince(r, "main")).toEqual(["c x.txt", "c y.txt"]);
  });
});
