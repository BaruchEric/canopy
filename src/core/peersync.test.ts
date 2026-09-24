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
/** Loose objects in the repo's real store (git count-objects, not packs). */
const looseObjects = async (cwd: string): Promise<number> => {
  const out = await sh(cwd, "count-objects");
  return Number(out.split(" ")[0]);
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

  test("the same tree again writes no new commit, and reports the snapshot's own time", async () => {
    const r = join(root, "dirty");
    const first = await sh(r, "rev-parse", "refs/wip/main");
    const committedAt = Number(await sh(r, "log", "-1", "--format=%ct", "refs/wip/main")) * 1000;
    const w = await snapshotWip(r, "mac", false);
    expect(w).toMatchObject({ wrote: false, at: committedAt });
    expect(await sh(r, "rev-parse", "refs/wip/main")).toBe(first);
  });

  test("HEAD moving past the snapshot's parent forces a new one, even with the same tree", async () => {
    // The trick: "unrelated.txt" starts as part of the dirty overlay, so the
    // first snapshot's tree already contains it. Committing just that file
    // moves HEAD forward by exactly what the overlay already had, so the
    // total tree (HEAD content plus what's still dirty) comes out identical.
    // The only thing that changed is which commit the ref's parent is.
    const r = await repo("headmove");
    await writeFile(join(r, "a.txt"), "changed\n");
    await writeFile(join(r, "new.txt"), "untracked\n");
    await writeFile(join(r, "unrelated.txt"), "keep\n");
    expect((await snapshotWip(r, "mac", false))?.wrote).toBe(true);
    const staleWip = await sh(r, "rev-parse", "refs/wip/main");
    const oldHead = await sh(r, "rev-parse", "HEAD");

    await sh(r, "add", "unrelated.txt");
    clock += 60;
    const cr = await exec(["git", "commit", "-q", "-m", "c unrelated"], {
      cwd: r, env: { GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
    });
    if (cr.code !== 0) throw new Error(cr.stderr);
    const newHead = await sh(r, "rev-parse", "HEAD");
    expect(newHead).not.toBe(oldHead);

    const w = await snapshotWip(r, "mac", false);
    expect(w?.wrote).toBe(true);
    expect(await sh(r, "rev-parse", "refs/wip/main")).not.toBe(staleWip);
    expect(await sh(r, "rev-parse", "refs/wip/main^")).toBe(newHead);
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

  test("dry writes nothing, not even loose objects in the real store", async () => {
    const r = await repo("dry");
    await writeFile(join(r, "a.txt"), "dry\n");
    const before = await looseObjects(r);
    expect((await snapshotWip(r, "mac", true))?.wrote).toBe(true);
    expect((await exec(["git", "rev-parse", "-q", "--verify", "refs/wip/main"], { cwd: r })).code).not.toBe(0);
    expect(await looseObjects(r)).toBe(before);
  });

  test("a ref namespace collision returns null instead of a false wrote", async () => {
    const r = await repo("collision");
    // A plain ref at refs/wip/feat, unrelated to any branch (a branch named
    // "feat" would itself collide with "feat/x" at refs/heads/, which is a
    // different conflict than the one under test).
    await sh(r, "update-ref", "refs/wip/feat", await sh(r, "rev-parse", "HEAD"));
    await sh(r, "checkout", "-q", "-b", "feat/x");
    await writeFile(join(r, "a.txt"), "feat/x change\n");
    // refs/wip/feat/x can't be created while refs/wip/feat exists as a
    // plain ref (a git ref D/F conflict).
    expect(await snapshotWip(r, "mac", false)).toBeNull();
  });

  test("commit-tree gets an identity even without any git config", async () => {
    const r = await repo("noidentity");
    await sh(r, "config", "--unset", "user.email");
    await sh(r, "config", "--unset", "user.name");
    await writeFile(join(r, "a.txt"), "no identity\n");

    const home = await mkdtemp(join(tmpdir(), "canopy-nohome-"));
    const globalConfig = join(home, "gitconfig-empty");
    await writeFile(globalConfig, "");
    const prevHome = process.env["HOME"];
    const prevGlobal = process.env["GIT_CONFIG_GLOBAL"];
    process.env["HOME"] = home;
    process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
    let w: Awaited<ReturnType<typeof snapshotWip>>;
    try {
      w = await snapshotWip(r, "mac", false);
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = prevHome;
      if (prevGlobal === undefined) delete process.env["GIT_CONFIG_GLOBAL"]; else process.env["GIT_CONFIG_GLOBAL"] = prevGlobal;
      await rm(home, { recursive: true, force: true });
    }
    expect(w?.wrote).toBe(true);
    expect(await sh(r, "log", "-1", "--format=%an <%ae>", "refs/wip/main")).toBe("canopy <canopy@mac>");
  });
});
