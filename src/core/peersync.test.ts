import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exec } from "./exec";
import { NO_PUSH } from "./peers";
import {
  cloneMissing,
  decodeBase64Strict,
  fastForward,
  fetchPeer,
  gateCommand,
  initRepo,
  isBusy,
  peerWips,
  safeId,
  seedRepo,
  serveList,
  serveSeed,
  serveSeeds,
  snapshotWip,
  takeWip,
  trackBranch,
} from "./peersync";
import type { Peer } from "./types";

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

/** Two machines' clones of one repo, wired as peers by path. */
const pair = async (name: string) => {
  const mac = await repo(`${name}-mac`);
  const mini = join(root, `${name}-mini`);
  await exec(["git", "clone", "-q", mac, mini]);
  await sh(mini, "config", "user.email", "t@t");
  await sh(mini, "config", "user.name", "t");
  // Each names the other's parent folder as its peer root; the id is the folder name.
  const toMini: Peer = { name: "mini", alias: null, root, role: "git" };
  const toMac: Peer = { name: "mac", alias: null, root, role: "git" };
  const miniId = `${name}-mini`;
  const macId = `${name}-mac`;
  await initRepo(mac, miniId, [toMini], false);
  await initRepo(mini, macId, [toMac], false);
  return { mac, mini, toMini, toMac, miniId, macId };
};

describe("initRepo", () => {
  test("adds the remote with refspecs, no tags and a push url that fails", async () => {
    const { mac } = await pair("init");
    expect(await sh(mac, "config", "--get-all", "remote.mini.fetch")).toBe(
      "+refs/heads/*:refs/remotes/mini/*\n+refs/wip/*:refs/peer-wip/mini/*",
    );
    expect(await sh(mac, "config", "remote.mini.tagOpt")).toBe("--no-tags");
    expect(await sh(mac, "config", "remote.mini.pushurl")).toBe(NO_PUSH);
    expect((await exec(["git", "push", "mini", "main"], { cwd: mac })).code).not.toBe(0);
  });
  test("is safe to run twice", async () => {
    const mac = join(root, "init-mac");
    await initRepo(mac, "init-mini", [{ name: "mini", alias: null, root, role: "git" }], false);
    expect((await sh(mac, "config", "--get-all", "remote.mini.fetch")).split("\n")).toHaveLength(2);
  });
});

describe("fetch and fast-forward", () => {
  test("a clean branch behind its peer fast-forwards", async () => {
    const { mac, mini, toMini, miniId } = await pair("ff");
    const before = await sh(mac, "rev-parse", "HEAD");
    const tip = await commit(mini, "b.txt", "b\n");
    expect(await fetchPeer(mac, miniId, toMini, {})).toBe("ok");
    const r = await fastForward(mac, ["mini"], false);
    expect(r.moved).toEqual([{ branch: "main", from: before, to: tip, peer: "mini" }]);
    expect(await sh(mac, "rev-parse", "HEAD")).toBe(tip);
  });

  test("a dirty tree keeps its branch where it is", async () => {
    const { mac, mini, toMini, miniId } = await pair("dirty-ff");
    const before = await sh(mac, "rev-parse", "HEAD");
    await commit(mini, "b.txt", "b\n");
    await writeFile(join(mac, "a.txt"), "local edit\n");
    await fetchPeer(mac, miniId, toMini, {});
    expect((await fastForward(mac, ["mini"], false)).moved).toEqual([]);
    expect(await sh(mac, "rev-parse", "HEAD")).toBe(before);
  });

  test("mid-rebase nothing moves", async () => {
    const { mac, mini, toMini, miniId } = await pair("busy");
    await commit(mini, "b.txt", "b\n");
    await fetchPeer(mac, miniId, toMini, {});
    await writeFile(join(mac, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");
    expect((await fastForward(mac, ["mini"], false)).moved).toEqual([]);
    await rm(join(mac, ".git", "MERGE_HEAD"));
  });

  test("a real rebase stopped on a conflict blocks the move, even by compare-and-swap", async () => {
    const mac = await repo("realrebase-mac");
    await sh(mac, "checkout", "-q", "-b", "other");
    await commit(mac, "a.txt", "other-change\n");
    await sh(mac, "checkout", "-q", "main");
    const preRebase = await commit(mac, "a.txt", "main-change\n");

    const mini = join(root, "realrebase-mini");
    await exec(["git", "clone", "-q", mac, mini]);
    await sh(mini, "config", "user.email", "t@t");
    await sh(mini, "config", "user.name", "t");
    await commit(mini, "b.txt", "b\n"); // peer's main strictly ahead of mac's main: ff-eligible

    const toMini: Peer = { name: "mini", alias: null, root, role: "git" };
    await initRepo(mac, "realrebase-mini", [toMini], false);

    const rebaseResult = await exec(["git", "rebase", "other"], { cwd: mac });
    expect(rebaseResult.code).not.toBe(0); // stopped on the a.txt conflict
    expect((await exec(["git", "symbolic-ref", "-q", "--short", "HEAD"], { cwd: mac })).code).not.toBe(0); // detached
    expect(await isBusy(mac)).toBe(true); // .git/rebase-merge present
    expect(await sh(mac, "rev-parse", "main")).toBe(preRebase); // the branch ref itself hasn't moved yet

    await fetchPeer(mac, "realrebase-mini", toMini, {});
    const r = await fastForward(mac, ["mini"], false);
    expect(r.moved).toEqual([]);
    expect(await sh(mac, "rev-parse", "main")).toBe(preRebase);

    await exec(["git", "rebase", "--abort"], { cwd: mac });
  });

  test("diverged is reported and nothing moves", async () => {
    const { mac, mini, toMini, miniId } = await pair("div");
    await commit(mini, "b.txt", "b\n");
    const mine = await commit(mac, "c.txt", "c\n");
    await fetchPeer(mac, miniId, toMini, {});
    const r = await fastForward(mac, ["mini"], false);
    expect(r.moved).toEqual([]);
    expect(r.diverged).toEqual([{ branch: "main", peer: "mini", ahead: 1, behind: 1 }]);
    expect(await sh(mac, "rev-parse", "HEAD")).toBe(mine);
  });

  test("a branch that is not checked out moves by compare-and-swap, even with a dirty tree", async () => {
    const { mac, mini, toMini, miniId } = await pair("side");
    await sh(mac, "branch", "feat/x");
    await sh(mini, "fetch", "-q", "mac");
    await sh(mini, "checkout", "-q", "-b", "feat/x", "refs/remotes/mac/feat/x");
    const tip = await commit(mini, "x.txt", "x\n");
    await writeFile(join(mac, "a.txt"), "dirty\n");
    await fetchPeer(mac, miniId, toMini, {});
    const r = await fastForward(mac, ["mini"], false);
    expect(r.moved.map((m) => m.branch)).toEqual(["feat/x"]);
    expect(await sh(mac, "rev-parse", "feat/x")).toBe(tip);
  });

  test("a branch only the peer has is listed, not created", async () => {
    const { mac, mini, toMini, miniId } = await pair("only");
    await sh(mini, "checkout", "-q", "-b", "peer-only");
    await commit(mini, "p.txt", "p\n");
    await fetchPeer(mac, miniId, toMini, {});
    const r = await fastForward(mac, ["mini"], false);
    expect(r.peerOnly).toEqual([{ peer: "mini", branch: "peer-only" }]);
    expect((await exec(["git", "rev-parse", "-q", "--verify", "refs/heads/peer-only"], { cwd: mac })).code).not.toBe(0);
  });

  test("dry reports what would move and moves nothing", async () => {
    const { mac, mini, toMini, miniId } = await pair("dryff");
    const before = await sh(mac, "rev-parse", "HEAD");
    const tip = await commit(mini, "b.txt", "b\n");
    await fetchPeer(mac, miniId, toMini, {});
    const r = await fastForward(mac, ["mini"], true);
    expect(r.moved).toEqual([]);
    expect(r.would).toEqual([{ branch: "main", to: tip, peer: "mini" }]);
    expect(await sh(mac, "rev-parse", "HEAD")).toBe(before);
  });

  test("a peer without the repo is missing, not an error", async () => {
    const mac = await repo("lonely");
    const ghost: Peer = { name: "gpd", alias: null, root: join(root, "nowhere"), role: "git" };
    await initRepo(mac, "lonely", [ghost], false);
    expect(await fetchPeer(mac, "lonely", ghost, {})).toBe("missing");
  });

  test("a repo with no peer remote configured still fetches by URL, and adds no remote", async () => {
    const mac = await repo("nopeer-mac");
    const mini = join(root, "nopeer-mini");
    await exec(["git", "clone", "-q", mac, mini]);
    await sh(mini, "config", "user.email", "t@t");
    await sh(mini, "config", "user.name", "t");
    const tip = await commit(mini, "b.txt", "b\n");

    // initRepo deliberately skipped: dry mode never runs it, and fetchPeer
    // must still work with no remote configured at all.
    const before = await exec(["git", "config", "--get-regexp", "remote\\."], { cwd: mac });
    expect(before.code).not.toBe(0); // no matches: no remotes yet

    const toMini: Peer = { name: "mini", alias: null, root, role: "git" };
    expect(await fetchPeer(mac, "nopeer-mini", toMini, {})).toBe("ok");
    expect(await sh(mac, "rev-parse", "refs/remotes/mini/main")).toBe(tip);

    const after = await exec(["git", "config", "--get-regexp", "remote\\."], { cwd: mac });
    expect(after.code).not.toBe(0); // still no matches: fetchPeer added no remote
  });

  test("the peer's WIP arrives and is pruned once the peer is clean", async () => {
    const { mac, mini, toMini, miniId } = await pair("wipx");
    await writeFile(join(mini, "a.txt"), "half done\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    const w = await peerWips(mac, ["mini"]);
    expect(w).toMatchObject([{ peer: "mini", branch: "main", files: 1 }]);
    await sh(mini, "checkout", "--", "a.txt");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    expect(await peerWips(mac, ["mini"])).toEqual([]);
  });
});

describe("gateCommand", () => {
  const home = "/home/eric";
  const rootAbs = "/home/eric/dev";
  test("git-upload-pack under the root, home-relative or absolute", () => {
    expect(gateCommand("git-upload-pack 'dev/São Paulo'", rootAbs, home)).toEqual({ kind: "upload-pack", path: "/home/eric/dev/São Paulo" });
    expect(gateCommand("git-upload-pack '/home/eric/dev/a'", rootAbs, home)).toEqual({ kind: "upload-pack", path: "/home/eric/dev/a" });
  });
  test("refuses paths outside the root and other git commands", () => {
    expect(gateCommand("git-upload-pack 'dev/../.ssh'", rootAbs, home)).toHaveProperty("error");
    expect(gateCommand("git-upload-pack '/etc'", rootAbs, home)).toHaveProperty("error");
    expect(gateCommand("git-receive-pack 'dev/a'", rootAbs, home)).toHaveProperty("error");
    expect(gateCommand("sh -c id", rootAbs, home)).toHaveProperty("error");
    expect(gateCommand("git-upload-pack 'dev/a'; id", rootAbs, home)).toHaveProperty("error");
  });
  test("the three queries", () => {
    expect(gateCommand("'canopy-peer' 'list'", rootAbs, home)).toEqual({ kind: "list" });
    expect(gateCommand("'canopy-peer' 'seeds' 'a/b'", rootAbs, home)).toEqual({ kind: "seeds", id: "a/b" });
    expect(gateCommand("'canopy-peer' 'seed' 'a/b' '.env'", rootAbs, home)).toEqual({ kind: "seed", id: "a/b", file: ".env" });
    expect(gateCommand("'canopy-peer' 'seed' 'a/b'", rootAbs, home)).toHaveProperty("error");
  });
  test("a symlink under the root that points outside it is refused, even though it exists", async () => {
    const ws = join(root, "gate-escape-ws");
    await mkdir(ws, { recursive: true });
    const outside = join(root, "gate-escape-outside");
    await exec(["git", "init", "-q", outside]);
    const link = join(ws, "link");
    await symlink(outside, link);
    expect(gateCommand(`git-upload-pack '${link}'`, ws, home)).toHaveProperty("error");
  });
  test("a path that doesn't exist but whose .git-suffixed sibling is a symlink outside the root is refused (enter_repo's own suffix probing)", async () => {
    const ws = join(root, "gate-escape-ws2");
    await mkdir(ws, { recursive: true });
    const outside = join(root, "gate-escape-outside2");
    await exec(["git", "init", "-q", outside]);
    const path = join(ws, "x"); // never created
    await symlink(outside, `${path}.git`);
    expect(gateCommand(`git-upload-pack '${path}'`, ws, home)).toHaveProperty("error");
  });
  test("accepts a real repo directly under the root, checked by real path", async () => {
    const ws = join(root, "gate-accept-ws");
    const a = join(ws, "a");
    await exec(["git", "init", "-q", "-b", "main", a]);
    expect(gateCommand(`git-upload-pack '${a}'`, ws, home)).toEqual({ kind: "upload-pack", path: a });
  });
  test("a directory under the root whose .git is a gitfile pointing outside it is refused", async () => {
    const ws = join(root, "gate-gitfile-ws");
    const outsideGitDir = join(root, "gate-gitfile-outside", ".git");
    await mkdir(outsideGitDir, { recursive: true });
    const x = join(ws, "x");
    await mkdir(x, { recursive: true });
    await writeFile(join(x, ".git"), `gitdir: ${outsideGitDir}\n`);
    expect(gateCommand(`git-upload-pack '${x}'`, ws, home)).toHaveProperty("error");
  });
  test("a directory under the root whose gitfile points at a repo inside it is accepted", async () => {
    const ws = join(root, "gate-gitfile-ws2");
    const realGitDir = join(ws, "real", ".git");
    await mkdir(realGitDir, { recursive: true });
    const x = join(ws, "x");
    await mkdir(x, { recursive: true });
    await writeFile(join(x, ".git"), `gitdir: ${realGitDir}\n`);
    expect(gateCommand(`git-upload-pack '${x}'`, ws, home)).toEqual({ kind: "upload-pack", path: x });
  });
  test("a gitdir under the root whose commondir points outside it is refused", async () => {
    const ws = join(root, "gate-commondir-ws");
    const wtGitDir = join(ws, "main", ".git", "worktrees", "wt");
    await mkdir(wtGitDir, { recursive: true });
    const outside = join(root, "gate-commondir-outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(wtGitDir, "commondir"), `${outside}\n`);
    const checkout = join(ws, "checkout");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, ".git"), `gitdir: ${wtGitDir}\n`);
    expect(gateCommand(`git-upload-pack '${checkout}'`, ws, home)).toHaveProperty("error");
  });
  test("a real git worktree add under the root is accepted", async () => {
    const ws = join(root, "gate-worktree-ws");
    await mkdir(ws, { recursive: true });
    const main = join(ws, "main");
    await exec(["git", "init", "-q", "-b", "main", main]);
    await sh(main, "config", "user.email", "t@t");
    await sh(main, "config", "user.name", "t");
    await commit(main, "a.txt", "one\n");
    const wt = join(ws, "wt");
    const wr = await exec(["git", "worktree", "add", "-q", "-b", "feat", wt], { cwd: main });
    if (wr.code !== 0) throw new Error(wr.stderr);
    expect(gateCommand(`git-upload-pack '${wt}'`, ws, home)).toEqual({ kind: "upload-pack", path: wt });
  });
});

describe("serve", () => {
  test("list finds repos with their origin, not below a repo", async () => {
    const ws = join(root, "ws");
    await mkdir(join(ws, "group"), { recursive: true });
    const a = join(ws, "group", "a");
    await exec(["git", "init", "-q", "-b", "main", a]);
    await sh(a, "config", "user.email", "t@t");
    await sh(a, "config", "user.name", "t");
    await commit(a, "r.txt", "r\n"); // the gate test in Task 10 clones this repo
    await exec(["git", "remote", "add", "origin", "git@github.com:x/a.git"], { cwd: a });
    await exec(["git", "init", "-q", join(a, "vendor", "inner")]);
    await exec(["git", "init", "-q", join(ws, "b")]);
    expect(await serveList(ws)).toEqual([
      { id: "b", origin: null },
      { id: "group/a", origin: "git@github.com:x/a.git" },
    ]);
  });
  test("seeds lists only ignored, allowlisted files; seed refuses anything else", async () => {
    const ws = join(root, "ws");
    const a = join(ws, "group", "a");
    await writeFile(join(a, ".gitignore"), ".env\nsecret.key\n");
    await writeFile(join(a, ".env"), "A=1\n");
    await writeFile(join(a, "secret.key"), "k\n");
    await writeFile(join(a, "tracked.env"), "t\n");
    expect(await serveSeeds(ws, "group/a", [".env"])).toEqual([".env"]);
    expect(new TextDecoder().decode(await serveSeed(ws, "group/a", ".env", [".env"]))).toBe("A=1\n");
    await expect(serveSeed(ws, "group/a", "secret.key", [".env"])).rejects.toThrow();
    await expect(serveSeed(ws, "group/a", "../../../etc/passwd", [".env"])).rejects.toThrow();
    await expect(serveSeed(ws, "../..", ".env", [".env"])).rejects.toThrow();
  });
  test("a symlinked repo inside the root that points outside it is refused by safeId", async () => {
    const ws = join(root, "safeid-escape-ws");
    await mkdir(ws, { recursive: true });
    const outside = join(root, "safeid-escape-outside");
    await exec(["git", "init", "-q", outside]);
    await symlink(outside, join(ws, "link"));
    expect(safeId(ws, "link")).toBeNull();
    await expect(serveSeeds(ws, "link", [".env"])).rejects.toThrow();
  });
  test("a repo id whose .git is a gitfile pointing outside the root is refused by safeId", async () => {
    const ws = join(root, "safeid-gitfile-ws");
    const outsideGitDir = join(root, "safeid-gitfile-outside", ".git");
    await mkdir(outsideGitDir, { recursive: true });
    const x = join(ws, "x");
    await mkdir(x, { recursive: true });
    await writeFile(join(x, ".git"), `gitdir: ${outsideGitDir}\n`);
    expect(safeId(ws, "x")).toBeNull();
    await expect(serveSeeds(ws, "x", [".env"])).rejects.toThrow();
  });
});

describe("clone and seed", () => {
  test("a repo only the peer has is cloned, origin copied, other peers added, .env seeded once", async () => {
    const theirs = join(root, "theirs");
    const src = join(theirs, "proj");
    await mkdir(src, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", src]);
    await sh(src, "config", "user.email", "t@t");
    await sh(src, "config", "user.name", "t");
    await commit(src, ".gitignore", ".env\n");
    await sh(src, "remote", "add", "origin", "git@github.com:x/proj.git");
    await writeFile(join(src, ".env"), "TOKEN=1\n");
    const ours = join(root, "ours");
    await mkdir(ours, { recursive: true });
    const peer: Peer = { name: "mini", alias: null, root: theirs, role: "git" };
    const other: Peer = { name: "gpd", alias: null, root: join(root, "gpd-none"), role: "git" };
    const r = await cloneMissing(ours, [peer, other], [".env"], false, {});
    expect(r).toEqual({ cloned: ["proj"], failed: [] });
    const here = join(ours, "proj");
    expect(await sh(here, "remote", "get-url", "origin")).toBe("git@github.com:x/proj.git");
    expect(await sh(here, "config", "remote.gpd.pushurl")).toBe(NO_PUSH);
    expect(await readFile(join(here, ".env"), "utf8")).toBe("TOKEN=1\n");
    expect(((await lstat(join(here, ".env"))).mode & 0o777).toString(8)).toBe("600");
    // a later seed never overwrites
    await writeFile(join(here, ".env"), "MINE=1\n");
    expect(await seedRepo(here, "proj", [peer], [".env"], false)).toEqual([]);
    expect(await readFile(join(here, ".env"), "utf8")).toBe("MINE=1\n");
  });

  test("peer repos outside the peer's globs are not cloned; dry clones nothing", async () => {
    const theirs2 = join(root, "theirs2");
    const src2 = join(theirs2, "proj");
    await mkdir(src2, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", src2]);
    await sh(src2, "config", "user.email", "t@t");
    await sh(src2, "config", "user.name", "t");
    await commit(src2, "a.txt", "one\n");
    const ours = join(root, "ours2");
    await mkdir(ours, { recursive: true });
    const peer: Peer = { name: "mini", alias: null, root: theirs2, role: "git", repos: ["other/*"] };
    expect(await cloneMissing(ours, [peer], [".env"], false, {})).toEqual({ cloned: [], failed: [] });
    const all: Peer = { ...peer, repos: undefined };
    expect((await cloneMissing(ours, [all], [".env"], true, {})).cloned).toEqual(["proj"]);
    expect(existsSync(join(ours, "proj"))).toBe(false);
  });
});

describe("a peer's listing is untrusted", () => {
  test("a listed repo named like a flag is skipped, never reaching join(root, id)", async () => {
    const theirs = join(root, "theirs-flag");
    const ok = join(theirs, "ok");
    const evil = join(theirs, "-evil");
    for (const src of [ok, evil]) {
      await mkdir(src, { recursive: true });
      await exec(["git", "init", "-q", "-b", "main", src]);
      await sh(src, "config", "user.email", "t@t");
      await sh(src, "config", "user.name", "t");
      await commit(src, "a.txt", "one\n");
    }
    // "-evil" is a perfectly real directory name (git init took it with no
    // trouble, since it's an absolute path and never reaches a CLI parser
    // as a bare argument); serveList reports it as an id exactly like any
    // other. isSafeRel is what stops cloneMissing from ever handing that
    // id to join(root, id) or to a "git clone" positional argument.
    const ours = join(root, "ours-flag");
    await mkdir(ours, { recursive: true });
    const peer: Peer = { name: "mini", alias: null, root: theirs, role: "git" };
    const r = await cloneMissing(ours, [peer], [".env"], false, {});
    expect(r.failed).toEqual([]);
    expect(r.cloned).toEqual(["ok"]);
    expect(existsSync(join(ours, "-evil"))).toBe(false);
  });

  test("an origin url holding :: is not added as a remote, though the clone itself proceeds", async () => {
    const theirs = join(root, "theirs-danger");
    const dash = join(theirs, "dash");
    const ext = join(theirs, "ext");
    for (const src of [dash, ext]) {
      await mkdir(src, { recursive: true });
      await exec(["git", "init", "-q", "-b", "main", src]);
      await sh(src, "config", "user.email", "t@t");
      await sh(src, "config", "user.name", "t");
      await commit(src, "a.txt", "one\n");
    }
    // Written straight into .git/config: a value git's own CLI parsing
    // would refuse to store this way is exactly what a hand-rolled
    // listing from a compromised or non-conforming peer could still send.
    // The "dash" repo's origin (a bare leading-dash value) is here too, but
    // only as a regression check: git's own "remote add" option parsing
    // already refuses that value before cloneMissing's own filter ever
    // runs, so it does not by itself prove the filter's effect (see the
    // report's mutation-testing note). The "ext" repo's "::" value is what
    // actually discriminates: git accepts it as a remote-helper url just
    // fine, so only cloneMissing's own check keeps it out.
    await writeFile(join(dash, ".git", "config"), (await readFile(join(dash, ".git", "config"), "utf8")) + '[remote "origin"]\n\turl = --evil\n');
    await writeFile(join(ext, ".git", "config"), (await readFile(join(ext, ".git", "config"), "utf8")) + '[remote "origin"]\n\turl = ext::sh -c evil\n');
    const ours = join(root, "ours-danger");
    await mkdir(ours, { recursive: true });
    const peer: Peer = { name: "mini", alias: null, root: theirs, role: "git" };
    const r = await cloneMissing(ours, [peer], [".env"], false, {});
    expect(r.failed).toEqual([]);
    expect(r.cloned.sort()).toEqual(["dash", "ext"]);
    for (const id of ["dash", "ext"]) {
      const remotes = (await sh(join(ours, id), "remote")).split("\n").filter(Boolean);
      expect(remotes).toEqual(["mini"]);
    }
  });
});

describe("symlinks inside a repo or root are not followed", () => {
  test("a symlinked folder inside the repo is not followed when seeding", async () => {
    const theirsRoot = join(root, "theirs-symlink-seed");
    const theirs = join(theirsRoot, "proj");
    await mkdir(theirs, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", theirs]);
    await sh(theirs, "config", "user.email", "t@t");
    await sh(theirs, "config", "user.name", "t");
    // A tracked file keeps "config/" from being collapsed into one entry by
    // "git ls-files --directory"; only then does the ignored file inside it
    // get reported by name, the way a real seed candidate would be.
    await commit(theirs, "config/tracked.txt", "keep\n");
    await commit(theirs, ".gitignore", "config/.env\n");
    await mkdir(join(theirs, "config"), { recursive: true });
    await writeFile(join(theirs, "config", ".env"), "SECRET=1\n");

    const here = join(root, "ours-symlink-seed", "proj");
    await mkdir(here, { recursive: true });
    const outside = join(root, "outside-symlink-seed");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(here, "config")); // "config" inside the repo points outside it

    const peer: Peer = { name: "mini", alias: null, root: theirsRoot, role: "git" };
    expect(await seedRepo(here, "proj", [peer], [".env"], false)).toEqual([]);
    expect(existsSync(join(outside, ".env"))).toBe(false);
  });

  test("a clone whose id passes through a symlinked folder in root is skipped", async () => {
    const theirsRoot = join(root, "theirs-symlink-clone");
    const nested = join(theirsRoot, "a", "b", "x");
    await mkdir(nested, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", nested]);
    await sh(nested, "config", "user.email", "t@t");
    await sh(nested, "config", "user.name", "t");
    await commit(nested, "f.txt", "one\n");

    const ours = join(root, "ours-symlink-clone");
    await mkdir(join(ours, "a"), { recursive: true });
    const outside = join(root, "outside-symlink-clone");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(ours, "a", "b")); // "a/b" inside root points outside it

    const peer: Peer = { name: "mini", alias: null, root: theirsRoot, role: "git" };
    const r = await cloneMissing(ours, [peer], [".env"], false, {});
    expect(r).toEqual({ cloned: [], failed: [] });
    expect(existsSync(join(outside, "x"))).toBe(false);
  });
});

describe("the seed temp file", () => {
  test("wx refuses to write through a pre-existing path at the exact temp name", async () => {
    const p = join(root, "wx-exists", "already-here");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, "existing\n");
    await expect(writeFile(p, "new\n", { flag: "wx" })).rejects.toThrow();
    expect(await readFile(p, "utf8")).toBe("existing\n");
  });

  test("a dangling symlink at dest is left alone and not counted as written", async () => {
    const theirsRoot = join(root, "theirs-dangling");
    const theirs = join(theirsRoot, "proj");
    await mkdir(theirs, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", theirs]);
    await sh(theirs, "config", "user.email", "t@t");
    await sh(theirs, "config", "user.name", "t");
    await commit(theirs, ".gitignore", ".env\n");
    await writeFile(join(theirs, ".env"), "SECRET=1\n");

    const here = join(root, "ours-dangling", "proj");
    await mkdir(here, { recursive: true });
    // existsSync follows symlinks, so a dangling one reads as "doesn't
    // exist" — link() is what actually refuses it, since the directory
    // entry is there regardless of what it points to.
    await symlink(join(here, "does-not-exist"), join(here, ".env"));

    const peer: Peer = { name: "mini", alias: null, root: theirsRoot, role: "git" };
    expect(await seedRepo(here, "proj", [peer], [".env"], false)).toEqual([]);
    const st = await lstat(join(here, ".env"));
    expect(st.isSymbolicLink()).toBe(true);
  });

  test("a containment failure on one seed file does not stop the next", async () => {
    const theirsRoot = join(root, "theirs-multi-seed");
    const theirs = join(theirsRoot, "proj");
    await mkdir(theirs, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", theirs]);
    await sh(theirs, "config", "user.email", "t@t");
    await sh(theirs, "config", "user.name", "t");
    await commit(theirs, "config/tracked.txt", "keep\n");
    await commit(theirs, ".gitignore", "config/.env\n.env\n");
    await mkdir(join(theirs, "config"), { recursive: true });
    await writeFile(join(theirs, "config", ".env"), "BAD=1\n");
    await writeFile(join(theirs, ".env"), "GOOD=1\n");

    const here = join(root, "ours-multi-seed", "proj");
    await mkdir(here, { recursive: true });
    const outside = join(root, "outside-multi-seed");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(here, "config"));

    const peer: Peer = { name: "mini", alias: null, root: theirsRoot, role: "git" };
    const wrote = await seedRepo(here, "proj", [peer], [".env"], false);
    expect(wrote).toEqual([".env"]);
    expect(await readFile(join(here, ".env"), "utf8")).toBe("GOOD=1\n");
    expect(existsSync(join(outside, ".env"))).toBe(false);
  });
});

describe("cloneMissing keeps going after one repo fails", () => {
  test("a clone failure for one repo doesn't stop another from cloning", async () => {
    const theirsRoot = join(root, "theirs-mixed");
    const good = join(theirsRoot, "good");
    await mkdir(good, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", good]);
    await sh(good, "config", "user.email", "t@t");
    await sh(good, "config", "user.name", "t");
    await commit(good, "f.txt", "one\n");
    // Looks like a repo to serveList (it has a .git entry) but isn't one:
    // the clone from it will fail.
    const bad = join(theirsRoot, "bad");
    await mkdir(join(bad, ".git"), { recursive: true });

    const ours = join(root, "ours-mixed");
    await mkdir(ours, { recursive: true });
    const peer: Peer = { name: "mini", alias: null, root: theirsRoot, role: "git" };
    const r = await cloneMissing(ours, [peer], [".env"], false, {});
    expect(r.cloned).toEqual(["good"]);
    expect(r.failed.map((f) => f.id)).toEqual(["bad"]);
    const [failure] = r.failed;
    expect(failure?.error).toBeTruthy();
  });
});

describe("decodeBase64Strict", () => {
  test("round-trips real content and treats an empty string as an empty file", () => {
    const encoded = Buffer.from("SECRET=1\n").toString("base64");
    expect(decodeBase64Strict(encoded)?.toString("utf8")).toBe("SECRET=1\n");
    expect(decodeBase64Strict("")).toEqual(Buffer.alloc(0));
  });
  test("refuses anything that isn't valid base64, rather than Buffer.from's lenient decode", () => {
    // A peer's seed reply is untrusted text, over ssh; Buffer.from would
    // silently drop the bad characters here and return a truncated decode
    // instead of refusing it.
    expect(decodeBase64Strict("not base64!!")).toBeNull();
    expect(decodeBase64Strict("abc")).toBeNull(); // wrong length, no valid padding
    expect(decodeBase64Strict("ab==c")).toBeNull(); // padding in the middle
  });
});

describe("take and track", () => {
  test("clean tree on the WIP's parent: the files arrive uncommitted", async () => {
    const { mac, mini, toMini, miniId } = await pair("take");
    await writeFile(join(mini, "a.txt"), "from mini\n");
    await writeFile(join(mini, "n.txt"), "new\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "files" });
    expect(await readFile(join(mac, "a.txt"), "utf8")).toBe("from mini\n");
    expect(await readFile(join(mac, "n.txt"), "utf8")).toBe("new\n");
    expect(await sh(mac, "diff", "--cached", "--name-only")).toBe(""); // nothing staged
  });

  test("otherwise it becomes a branch", async () => {
    const { mac, mini, toMini, miniId } = await pair("take2");
    await writeFile(join(mini, "a.txt"), "from mini\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    await writeFile(join(mac, "a.txt"), "mine\n");
    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });
    expect(await readFile(join(mac, "a.txt"), "utf8")).toBe("mine\n");
    await sh(mac, "rev-parse", "wip/mini/main");
  });

  test("track makes a local branch at the peer's tip; unknown is an error", async () => {
    const { mac, mini, toMini, miniId } = await pair("track");
    await sh(mini, "checkout", "-q", "-b", "feat/y");
    const tip = await commit(mini, "y.txt", "y\n");
    await fetchPeer(mac, miniId, toMini, {});
    await trackBranch(mac, "mini", "feat/y");
    expect(await sh(mac, "rev-parse", "feat/y")).toBe(tip);
    await expect(trackBranch(mac, "mini", "nope")).rejects.toThrow();
    await expect(takeWip(mac, "mini", "nope")).rejects.toThrow();
  });

  test("a bad peer name is refused", async () => {
    const { mac } = await pair("badpeer");
    await expect(trackBranch(mac, "../x", "main")).rejects.toThrow(/not a peer name/);
    await expect(trackBranch(mac, "Origin", "main")).rejects.toThrow(/not a peer name/);
    await expect(takeWip(mac, "../x", "main")).rejects.toThrow(/not a peer name/);
    await expect(takeWip(mac, "Origin", "main")).rejects.toThrow(/not a peer name/);
  });

  test("a bad branch name is refused", async () => {
    const { mac } = await pair("badbranch");
    await expect(trackBranch(mac, "mini", "-D")).rejects.toThrow(/not a branch name/);
    await expect(trackBranch(mac, "mini", "a..b")).rejects.toThrow(/not a branch name/);
    await expect(takeWip(mac, "mini", "-D")).rejects.toThrow(/not a branch name/);
    await expect(takeWip(mac, "mini", "a..b")).rejects.toThrow(/not a branch name/);
  });
});
