import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import {
  addRunTree,
  aheadOf,
  branchSlug,
  currentBranch,
  defaultBranch,
  dirtyFiles,
  ffMain,
  listRunTreeDirs,
  overwrittenFiles,
  rebaseOnto,
  removeRunTree,
  repoKey,
  revOf,
  runBranchName,
  runTreeDir,
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

  test("a branch slug is lower case words from the note", () => {
    expect(branchSlug("Fix the README's typo!")).toBe("fix-the-readme-s-typo");
    expect(branchSlug("   ")).toBe("run");
    expect(branchSlug("a".repeat(50))).toHaveLength(32);
    expect(runBranchName("add a test", "ab12cd34")).toBe("run/add-a-test-ab12cd34");
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
