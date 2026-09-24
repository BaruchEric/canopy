import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { snapshotWip } from "./peersync";

let root = "";
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
let clock = 1_790_000_000;
const commit = async (cwd: string, name: string, body: string): Promise<string> => {
  await mkdir(join(cwd, name, ".."), { recursive: true });
  await writeFile(join(cwd, name), body);
  await sh(cwd, "add", "-A");
  clock += 60;
  const r = await exec(["git", "commit", "-q", "-m", `c ${name}`], {
    cwd, env: { GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
  });
  if (r.code !== 0) throw new Error(r.stderr);
  return sh(cwd, "rev-parse", "HEAD");
};
/** A fresh repo with one commit on main, identity set. */
const repo = async (name: string): Promise<string> => {
  const dir = join(root, name);
  await exec(["git", "init", "-q", "-b", "main", dir]);
  await sh(dir, "config", "user.email", "t@t");
  await sh(dir, "config", "user.name", "t");
  await commit(dir, "a.txt", "one\n");
  return dir;
};

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "canopy-peers-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("snapshotWip", () => {
  test("a clean tree writes nothing", async () => {
    const r = await repo("clean");
    expect(await snapshotWip(r, "mac", false)).toBeNull();
    expect((await exec(["git", "rev-parse", "-q", "--verify", "refs/wip/main"], { cwd: r })).code).not.toBe(0);
  });

  test("a dirty tree becomes refs/wip/<branch> and the real index is untouched", async () => {
    const r = await repo("dirty");
    await writeFile(join(r, "a.txt"), "two\n");
    await writeFile(join(r, "new.txt"), "untracked\n");
    await sh(r, "add", "a.txt"); // something staged, so the index is not just HEAD
    const before = await readFile(join(r, ".git", "index"));
    const w = await snapshotWip(r, "mac", false);
    expect(w).toMatchObject({ branch: "main", wrote: true });
    expect(await readFile(join(r, ".git", "index"))).toEqual(before);
    expect(await sh(r, "show", "refs/wip/main:new.txt")).toBe("untracked");
    expect(await sh(r, "rev-parse", "refs/wip/main^")).toBe(await sh(r, "rev-parse", "HEAD"));
    expect(await sh(r, "log", "-1", "--format=%s", "refs/wip/main")).toMatch(/^wip mac /);
  });

  test("the same tree again writes no new commit", async () => {
    const r = join(root, "dirty");
    const first = await sh(r, "rev-parse", "refs/wip/main");
    expect((await snapshotWip(r, "mac", false))?.wrote).toBe(false);
    expect(await sh(r, "rev-parse", "refs/wip/main")).toBe(first);
  });

  test("ignored files stay out", async () => {
    const r = await repo("ignored");
    await commit(r, ".gitignore", ".env\n");
    await writeFile(join(r, ".env"), "SECRET=1\n");
    await writeFile(join(r, "b.txt"), "b\n");
    await snapshotWip(r, "mac", false);
    expect((await exec(["git", "cat-file", "-e", "refs/wip/main:.env"], { cwd: r })).code).not.toBe(0);
  });

  test("clean again deletes the ref", async () => {
    const r = join(root, "dirty");
    await sh(r, "reset", "-q", "--hard");
    await rm(join(r, "new.txt"));
    expect(await snapshotWip(r, "mac", false)).toBeNull();
    expect((await exec(["git", "rev-parse", "-q", "--verify", "refs/wip/main"], { cwd: r })).code).not.toBe(0);
  });

  test("a slashed branch keeps its slashes", async () => {
    const r = await repo("slashed");
    await sh(r, "checkout", "-q", "-b", "feat/x");
    await writeFile(join(r, "a.txt"), "changed\n");
    expect((await snapshotWip(r, "mac", false))?.branch).toBe("feat/x");
    await sh(r, "rev-parse", "refs/wip/feat/x");
  });

  test("detached HEAD and an unborn repo are skipped", async () => {
    const r = await repo("detached");
    await sh(r, "checkout", "-q", "--detach");
    await writeFile(join(r, "a.txt"), "x\n");
    expect(await snapshotWip(r, "mac", false)).toBeNull();
    const empty = join(root, "unborn");
    await exec(["git", "init", "-q", "-b", "main", empty]);
    await writeFile(join(empty, "f"), "x");
    expect(await snapshotWip(empty, "mac", false)).toBeNull();
  });

  test("dry writes nothing", async () => {
    const r = await repo("dry");
    await writeFile(join(r, "a.txt"), "dry\n");
    expect((await snapshotWip(r, "mac", true))?.wrote).toBe(true);
    expect((await exec(["git", "rev-parse", "-q", "--verify", "refs/wip/main"], { cwd: r })).code).not.toBe(0);
  });
});
