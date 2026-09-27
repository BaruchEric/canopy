import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exec } from "./exec";
import { NO_PUSH, peerUrl } from "./peers";
import {
  cloneMissing,
  decodeBase64Strict,
  fastForward,
  fetchPeer,
  gateCommand,
  gitSshCommand,
  initRepo,
  isBusy,
  isDirty,
  PassSeen,
  peerWips,
  safeId,
  seedRepo,
  serveList,
  serveSeed,
  serveSeeds,
  snapshotWip,
  syncAll,
  syncRepo,
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

// ssh's ControlPath (built from CANOPY_CONFIG_DIR by gitSshCommand, used by
// syncRepo/syncAll below) has to fit in a unix socket path (about 104 bytes
// on macOS). os.tmpdir() alone is already close to that once "/ssh-<40 hex
// chars>" is added, and other test files that run in the same process (e.g.
// launcher.test.ts) set CANOPY_CONFIG_DIR globally without restoring it, so
// a config dir under tmpdir() here would push some runs over the limit and
// turn ssh's "could not resolve" into a plain "ControlPath too long" that
// isn't recognized as unreachable. A short, fixed prefix under /tmp keeps
// every run well under the limit regardless of what else is running.
let prevConfigDir: string | undefined;
let configScratch = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-peers-"));
  prevConfigDir = process.env["CANOPY_CONFIG_DIR"];
  configScratch = await mkdtemp("/tmp/cpy-");
  process.env["CANOPY_CONFIG_DIR"] = configScratch;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  if (prevConfigDir === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = prevConfigDir;
  await rm(configScratch, { recursive: true, force: true });
});

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

describe("isDirty fails closed", () => {
  test("a path git can't read as a repo counts as dirty", async () => {
    expect(await isDirty(join(root, "does-not-exist-at-all"))).toBe(true);
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
  test("leaves a same-named remote alone when it is not the no-push marker: it is the user's own", async () => {
    const mac = await repo("init-userowned-mac");
    await sh(mac, "remote", "add", "mini", "https://example.invalid/mine.git");
    await initRepo(mac, "init-userowned-mini", [{ name: "mini", alias: null, root, role: "git" }], false);
    expect(await sh(mac, "remote", "get-url", "mini")).toBe("https://example.invalid/mine.git");
    // No no-push marker: initRepo never touched this remote's config at all,
    // so it keeps only the default fetch refspec "remote add" gave it, not
    // the wip refspec initRepo appends for a peer it owns.
    expect((await exec(["git", "config", "--get", "remote.mini.pushurl"], { cwd: mac })).code).not.toBe(0);
    expect(await sh(mac, "config", "--get-all", "remote.mini.fetch")).toBe("+refs/heads/*:refs/remotes/mini/*");
  });
  test("repairs a remote a crash left half-made: the url is canopy's, but nothing else was written yet", async () => {
    const mac = await repo("init-crash-mac");
    const peer: Peer = { name: "mini", alias: null, root, role: "git" };
    const id = "init-crash-mini";
    // simulates initRepo crashing right after `remote add`, before the
    // marker or the refspecs
    await sh(mac, "remote", "add", "mini", peerUrl(peer, id));
    expect((await exec(["git", "config", "--get", "remote.mini.pushurl"], { cwd: mac })).code).not.toBe(0);

    await initRepo(mac, id, [peer], false);

    expect(await sh(mac, "config", "remote.mini.pushurl")).toBe(NO_PUSH);
    expect(await sh(mac, "config", "--get-all", "remote.mini.fetch")).toBe(
      "+refs/heads/*:refs/remotes/mini/*\n+refs/wip/*:refs/peer-wip/mini/*",
    );
    expect(await sh(mac, "config", "remote.mini.tagOpt")).toBe("--no-tags");
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

  test("a branch checked out in a linked worktree stays put, and dry does not offer it either", async () => {
    const { mac, mini, toMini, miniId } = await pair("linked");
    await sh(mac, "branch", "feat/wt");
    await sh(mac, "worktree", "add", "-q", join(root, "linked-wt"), "feat/wt");
    const mine = await sh(mac, "rev-parse", "feat/wt");
    await sh(mini, "fetch", "-q", "mac");
    await sh(mini, "checkout", "-q", "-b", "feat/wt", "refs/remotes/mac/feat/wt");
    await commit(mini, "wt.txt", "wt\n");
    await fetchPeer(mac, miniId, toMini, {});
    const dry = await fastForward(mac, ["mini"], true);
    expect(dry.would).toEqual([]);
    const r = await fastForward(mac, ["mini"], false);
    expect(r.moved).toEqual([]);
    expect(r.diverged).toEqual([]);
    expect(await sh(mac, "rev-parse", "feat/wt")).toBe(mine);
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
    await writeFile(join(mini, "new.txt"), "untracked\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    const w = await peerWips(mac, ["mini"]);
    expect(w).toMatchObject([
      { peer: "mini", branch: "main", files: 2, paths: [{ status: "M", path: "a.txt" }, { status: "A", path: "new.txt" }] },
    ]);
    await sh(mini, "checkout", "--", "a.txt");
    await rm(join(mini, "new.txt"));
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

/** A repo under `theirs` with one commit and, when given, that origin. */
const listed = async (theirs: string, id: string, origin: string | null): Promise<void> => {
  const src = join(theirs, id);
  await mkdir(src, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", src]);
  await sh(src, "config", "user.email", "t@t");
  await sh(src, "config", "user.name", "t");
  await commit(src, "a.txt", "one\n");
  if (origin) await sh(src, "remote", "add", "origin", origin);
};

describe("a peer's origin is kept only when it names a network remote", () => {
  test("a local path, a bare alias:path or a file url clones with no origin; a forge url keeps it", async () => {
    const theirs = join(root, "theirs-origin");
    await listed(theirs, "local", "/Users/ericbaruch/.claude");
    await listed(theirs, "alias", "qnap:/share/x");
    await listed(theirs, "fileurl", "file:///srv/x.git");
    await listed(theirs, "filehost", "file://localhost/srv/x.git");
    await listed(theirs, "helper", "fancy://host/o/n.git");
    await listed(theirs, "gh", "git@github.com:x/gh.git");
    await listed(theirs, "https", "https://github.com/x/h.git");
    await listed(theirs, "ssh", "ssh://git@forge.lan:2222/o/n.git");
    const ours = join(root, "ours-origin");
    await mkdir(ours, { recursive: true });
    const peer: Peer = { name: "mini", alias: null, root: theirs, role: "git" };
    const r = await cloneMissing(ours, [peer], [".env"], false, {});
    expect(r.failed).toEqual([]);
    expect(r.cloned.sort()).toEqual(["alias", "filehost", "fileurl", "gh", "helper", "https", "local", "ssh"]);
    for (const id of ["local", "alias", "fileurl", "filehost", "helper"]) {
      expect((await sh(join(ours, id), "remote")).split("\n").filter(Boolean)).toEqual(["mini"]);
    }
    expect(await sh(join(ours, "gh"), "remote", "get-url", "origin")).toBe("git@github.com:x/gh.git");
    expect(await sh(join(ours, "https"), "remote", "get-url", "origin")).toBe("https://github.com/x/h.git");
    expect(await sh(join(ours, "ssh"), "remote", "get-url", "origin")).toBe("ssh://git@forge.lan:2222/o/n.git");
  });

  test("serveList strips the userinfo off an http(s) origin, and leaves an ssh user alone", async () => {
    const ws = join(root, "ws-userinfo");
    await listed(ws, "tok", "https://eric:ghp_secret@github.com/x/tok.git");
    await listed(ws, "bare", "https://ghp_secret@github.com/x/bare.git");
    await listed(ws, "upper", "HTTP://u:p@forge.lan/o/upper.git");
    await listed(ws, "ssh", "ssh://git@forge.lan/o/ssh.git");
    expect(await serveList(ws)).toEqual([
      { id: "bare", origin: "https://github.com/x/bare.git" },
      { id: "ssh", origin: "ssh://git@forge.lan/o/ssh.git" },
      { id: "tok", origin: "https://github.com/x/tok.git" },
      { id: "upper", origin: "HTTP://forge.lan/o/upper.git" },
    ]);
  });
});

describe("cloneMissing never clones inside a repo here", () => {
  test("a listed a/b is refused when a is a repo here, in dry and for real", async () => {
    const theirs = join(root, "theirs-nested");
    await mkdir(join(theirs, "a"), { recursive: true });
    await listed(theirs, "a/b", null);
    const ours = join(root, "ours-nested");
    await mkdir(ours, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", join(ours, "a")]);
    const peer: Peer = { name: "mini", alias: null, root: theirs, role: "git" };
    expect(await cloneMissing(ours, [peer], [".env"], true, {})).toEqual({ cloned: [], failed: [] });
    expect(await cloneMissing(ours, [peer], [".env"], false, {})).toEqual({ cloned: [], failed: [] });
    expect(existsSync(join(ours, "a", "b"))).toBe(false);
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

  test("an untouched earlier WIP branch is replaced by a later take", async () => {
    const { mac, mini, toMini, miniId } = await pair("replace");
    await writeFile(join(mini, "a.txt"), "from mini 1\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    await writeFile(join(mac, "a.txt"), "mine\n"); // keeps mac dirty so every take lands on a branch
    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });
    const first = await sh(mac, "rev-parse", "wip/mini/main");

    await writeFile(join(mini, "a.txt"), "from mini 2\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    const secondWip = await sh(mac, "rev-parse", "refs/peer-wip/mini/main");
    expect(secondWip).not.toBe(first);

    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });
    expect(await sh(mac, "rev-parse", "wip/mini/main")).toBe(secondWip);
  });

  test("the replace path never moves a scratch branch checked out somewhere else", async () => {
    const { mac, mini, toMini, miniId } = await pair("inuse");
    await writeFile(join(mini, "a.txt"), "from mini 1\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    await writeFile(join(mac, "a.txt"), "mine\n"); // keeps mac dirty so every take lands on a branch
    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });
    const first = await sh(mac, "rev-parse", "wip/mini/main");

    // The user checks the scratch branch out into a second worktree to
    // keep working on it there; update-ref, unlike checkout, would not
    // refuse to move it out from under that.
    await sh(mac, "worktree", "add", "-q", join(root, "inuse-wt"), "wip/mini/main");

    await writeFile(join(mini, "a.txt"), "from mini 2\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});

    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main-2" });
    expect(await sh(mac, "rev-parse", "wip/mini/main")).toBe(first); // untouched while checked out
  });

  test("a create failure other than the name already being taken throws instead of looping forever", async () => {
    const { mac, mini, toMini, miniId } = await pair("createfail");
    // "wip/mini/feat" as a leaf ref conflicts with every nested candidate
    // under it (wip/mini/feat/y, wip/mini/feat/y-2, ...), so a loop that
    // only checks "does this name already exist" before retrying would
    // never find a name git can create and never stop.
    await sh(mac, "branch", "wip/mini/feat");
    await sh(mini, "checkout", "-q", "-b", "feat/y");
    await writeFile(join(mini, "a.txt"), "from mini\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    await writeFile(join(mac, "a.txt"), "mine\n"); // keeps mac dirty so the take goes to a branch
    await expect(takeWip(mac, "mini", "feat/y")).rejects.toThrow();
  });

  test("a user commit on wip/mini/main survives a second take, which lands on the next free name", async () => {
    const { mac, mini, toMini, miniId } = await pair("usertouch");
    await writeFile(join(mini, "a.txt"), "from mini 1\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    await writeFile(join(mac, "a.txt"), "mine\n"); // keeps mac dirty so every take lands on a branch
    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });

    // The user builds on the scratch branch themselves, without touching
    // mac's own working tree (which is mid-edit and must stay that way).
    const branchTip = await sh(mac, "rev-parse", "wip/mini/main");
    const tree = await sh(mac, "rev-parse", `${branchTip}^{tree}`);
    const userCommit = await sh(mac, "commit-tree", tree, "-p", branchTip, "-m", "user edit");
    await sh(mac, "update-ref", "refs/heads/wip/mini/main", userCommit);

    await writeFile(join(mini, "a.txt"), "from mini 2\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});

    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main-2" });
    expect(await sh(mac, "rev-parse", "wip/mini/main")).toBe(userCommit); // untouched
  });

  test("two takes of the same WIP while the base is blocked reuse the same numbered name", async () => {
    const { mac, mini, toMini, miniId } = await pair("samewip");
    await sh(mac, "branch", "wip/mini/main"); // occupies the base with a branch that isn't canopy's
    await writeFile(join(mini, "a.txt"), "from mini\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});
    await writeFile(join(mac, "a.txt"), "mine\n"); // keeps mac dirty so every take lands on a branch

    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main-2" });
    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main-2" });
    expect(await sh(mac, "rev-parse", "wip/mini/main-2")).toBe(await sh(mac, "rev-parse", "refs/peer-wip/mini/main"));
  });

  test("an ignored file at a path the WIP adds sends the take to a branch and the ignored file is unchanged", async () => {
    const { mac, mini, toMini, miniId } = await pair("wipoccupied");
    await writeFile(join(mac, ".git", "info", "exclude"), "new.txt\n");
    await writeFile(join(mac, "new.txt"), "mac had this already\n");
    expect(await isDirty(mac)).toBe(false); // ignored, so the tree still reads clean

    await writeFile(join(mini, "new.txt"), "from mini\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});

    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });
    expect(await readFile(join(mac, "new.txt"), "utf8")).toBe("mac had this already\n");
    await sh(mac, "rev-parse", "wip/mini/main");
  });

  test("a directory the WIP needs, blocked by an ignored file of the same name, also sends the take to a branch", async () => {
    const { mac, mini, toMini, miniId } = await pair("wipoccupieddir");
    await writeFile(join(mac, ".git", "info", "exclude"), "sub\n");
    await writeFile(join(mac, "sub"), "mac had this already\n"); // a file, not the directory the WIP needs

    await mkdir(join(mini, "sub"), { recursive: true });
    await writeFile(join(mini, "sub", "file.txt"), "from mini\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});

    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });
    expect(await readFile(join(mac, "sub"), "utf8")).toBe("mac had this already\n");
  });

  test("a symlinked folder where the WIP needs a real one also sends the take to a branch, and leaves the symlink and its target alone", async () => {
    const { mac, mini, toMini, miniId } = await pair("wipoccupiedsymlink");
    const target = join(root, "wipoccupiedsymlink-target");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "existing.txt"), "target content\n");
    await writeFile(join(mac, ".git", "info", "exclude"), "sub\n");
    await symlink(target, join(mac, "sub")); // "sub" looks like a folder but is a symlink elsewhere

    await mkdir(join(mini, "sub"), { recursive: true });
    await writeFile(join(mini, "sub", "file.txt"), "from mini\n");
    await snapshotWip(mini, "mini", false);
    await fetchPeer(mac, miniId, toMini, {});

    // A leaf lstat alone would traverse through the symlink looking for
    // "file.txt" under its target, not find it (ENOENT), and read the path
    // as free — this is the case that has to be caught at "sub" itself.
    expect(await takeWip(mac, "mini", "main")).toEqual({ how: "branch", branch: "wip/mini/main" });
    const st = await lstat(join(mac, "sub"));
    expect(st.isSymbolicLink()).toBe(true);
    expect(await readFile(join(target, "existing.txt"), "utf8")).toBe("target content\n");
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

  test("a branch name containing @{ is refused even when check-ref-format would resolve it", async () => {
    const { mac } = await pair("atref");
    // With a previous checkout in the reflog, "git check-ref-format --branch
    // @{-1}" resolves to "other" rather than failing, so the refusal has to
    // be explicit rather than left to check-ref-format alone.
    await sh(mac, "checkout", "-q", "-b", "other");
    await sh(mac, "checkout", "-q", "main");
    await expect(trackBranch(mac, "mini", "@{-1}")).rejects.toThrow(/not a branch name/);
    await expect(takeWip(mac, "mini", "@{-1}")).rejects.toThrow(/not a branch name/);
  });
});

describe("syncRepo", () => {
  const layout = async (name: string) => {
    const wsMac = join(root, `${name}-wsmac`);
    const wsMini = join(root, `${name}-wsmini`);
    await mkdir(wsMac, { recursive: true });
    const mac = join(wsMac, "proj");
    await exec(["git", "init", "-q", "-b", "main", mac]);
    await sh(mac, "config", "user.email", "t@t");
    await sh(mac, "config", "user.name", "t");
    await commit(mac, "a.txt", "one\n");
    await mkdir(wsMini, { recursive: true });
    const mini = join(wsMini, "proj");
    await exec(["git", "clone", "-q", mac, mini]);
    await sh(mini, "config", "user.email", "t@t");
    await sh(mini, "config", "user.name", "t");
    const peersOfMac: Peer[] = [{ name: "mini", alias: null, root: wsMini, role: "git" }];
    await initRepo(mac, "proj", peersOfMac, false);
    return { wsMac, mac, mini, peersOfMac };
  };

  test("fast-forwards, lists WIP and says the peer was seen", async () => {
    const { wsMac, mac, mini, peersOfMac } = await layout("pass");
    const tip = await commit(mini, "b.txt", "b\n");
    await writeFile(join(mini, "a.txt"), "wip\n");
    await snapshotWip(mini, "mini", false);
    const seen = new PassSeen();
    const st = await syncRepo("proj", { self: "mac", peers: peersOfMac, seed: [".env"], dry: false, root: wsMac }, seen);
    expect(st.moved.map((m) => m.to)).toEqual([tip]);
    expect(st.wip.map((w) => w.branch)).toEqual(["main"]);
    expect(st.onlyHere).toBe(false);
    expect(seen.list()).toMatchObject([{ name: "mini", ok: true }]);
    expect(await sh(mac, "rev-parse", "HEAD")).toBe(tip);
  });

  test("an unreachable peer is skipped for the rest of the pass", async () => {
    const { wsMac, peersOfMac } = await layout("asleep");
    const seen = new PassSeen();
    seen.mark("mini", false, "timed out");
    const st = await syncRepo("proj", { self: "mac", peers: peersOfMac, seed: [], dry: false, root: wsMac }, seen);
    expect(st.moved).toEqual([]);
    expect(st.error).toBeUndefined();
  });

  test("a repo no peer has is only here", async () => {
    const { wsMac, peersOfMac } = await layout("solo");
    await rm(join(root, "solo-wsmini", "proj"), { recursive: true, force: true });
    const st = await syncRepo("proj", { self: "mac", peers: peersOfMac, seed: [], dry: false, root: wsMac }, new PassSeen());
    expect(st.onlyHere).toBe(true);
  });

  test("two calls at once share one run", async () => {
    const { wsMac, peersOfMac } = await layout("lock");
    const opts = { self: "mac", peers: peersOfMac, seed: [], dry: false, root: wsMac };
    const seen = new PassSeen();
    const [a, b] = [syncRepo("proj", opts, seen), syncRepo("proj", opts, seen)];
    expect(a).toBe(b);
    await a;
  });

  test("the first connection failure marks the peer offline", async () => {
    const { wsMac, mac } = await layout("dead");
    const dead: Peer = { name: "gone", alias: "canopy-peer-test-nowhere.invalid", root: "dev", role: "git" };
    await initRepo(mac, "proj", [dead], false);
    const seen = new PassSeen();
    await syncRepo("proj", { self: "mac", peers: [dead], seed: [], dry: false, root: wsMac }, seen);
    expect(seen.offline("gone")).toBe(true);
  });
});

describe("syncAll", () => {
  test("concurrency 0 still syncs every repo", async () => {
    const wsMac = join(root, "concurrency0-wsmac");
    const wsMini = join(root, "concurrency0-wsmini");
    await mkdir(wsMac, { recursive: true });
    const mac = join(wsMac, "proj");
    await exec(["git", "init", "-q", "-b", "main", mac]);
    await sh(mac, "config", "user.email", "t@t");
    await sh(mac, "config", "user.name", "t");
    await commit(mac, "a.txt", "one\n");
    await mkdir(wsMini, { recursive: true });
    const mini = join(wsMini, "proj");
    await exec(["git", "clone", "-q", mac, mini]);
    await sh(mini, "config", "user.email", "t@t");
    await sh(mini, "config", "user.name", "t");
    const peers: Peer[] = [{ name: "mini", alias: null, root: wsMini, role: "git" }];
    await initRepo(mac, "proj", peers, false);
    const tip = await commit(mini, "b.txt", "b\n");

    const r = await syncAll(["proj"], { self: "mac", peers, seed: [], dry: false, root: wsMac }, 0);
    expect(r.states.get("proj")?.moved.map((m) => m.to)).toEqual([tip]);
    expect(r.failed).toEqual([]);
  });

  test("two peers failing with a non-connection error are both reported in state.error", async () => {
    const wsMac = join(root, "joinerr-wsmac");
    await mkdir(wsMac, { recursive: true });
    const mac = join(wsMac, "proj");
    await exec(["git", "init", "-q", "-b", "main", mac]);
    await sh(mac, "config", "user.email", "t@t");
    await sh(mac, "config", "user.name", "t");
    await commit(mac, "a.txt", "one\n");

    // A peer with a commit mac hasn't seen yet, whose object is corrupted:
    // mac already has every object the two share (dest was cloned from mac),
    // so fetching would otherwise transfer nothing and never touch the
    // corrupt object — only a genuinely new commit forces pack-objects on
    // the peer's side to serve it, surfacing a generic protocol error
    // instead of "missing" or "unreachable" (the case the join-with-"; "
    // ruling is for). --no-hardlinks keeps the corruption from reaching back
    // into mac's own objects (a plain local clone hard-links its files).
    const corruptPeer = async (peerName: string): Promise<string> => {
      const ws = join(root, `joinerr-ws-${peerName}`);
      await mkdir(ws, { recursive: true });
      const dest = join(ws, "proj");
      await exec(["git", "clone", "-q", "--no-hardlinks", mac, dest]);
      await sh(dest, "config", "user.email", "t@t");
      await sh(dest, "config", "user.name", "t");
      await writeFile(join(dest, "b.txt"), "b\n");
      await sh(dest, "add", "-A");
      await sh(dest, "commit", "-q", "-m", "b");
      const newHash = await sh(dest, "rev-parse", "HEAD");
      const objPath = join(dest, ".git", "objects", newHash.slice(0, 2), newHash.slice(2));
      await chmod(objPath, 0o644);
      await writeFile(objPath, "garbage");
      return ws;
    };
    const wsA = await corruptPeer("a");
    const wsB = await corruptPeer("b");
    const peers: Peer[] = [
      { name: "a", alias: null, root: wsA, role: "git" },
      { name: "b", alias: null, root: wsB, role: "git" },
    ];
    await initRepo(mac, "proj", peers, false);
    const seen = new PassSeen();
    const st = await syncRepo("proj", { self: "mac", peers, seed: [], dry: false, root: wsMac }, seen);
    // Joined with "; " per the ruling, not concatenated or left to overwrite:
    // both peers' messages must survive as two "; "-separated segments.
    expect(st.error?.split("; ").map((s) => s.slice(0, 2))).toEqual(["a:", "b:"]);
  });

  test("dry mode never syncs a would-be clone: syncRepo does not run against a folder that was never made", async () => {
    const wsMac = join(root, "drynoclone-wsmac");
    const wsMini = join(root, "drynoclone-wsmini");
    await mkdir(wsMac, { recursive: true });
    await mkdir(wsMini, { recursive: true });
    const mini = join(wsMini, "proj");
    await exec(["git", "init", "-q", "-b", "main", mini]);
    await sh(mini, "config", "user.email", "t@t");
    await sh(mini, "config", "user.name", "t");
    await commit(mini, "a.txt", "one\n");
    const peers: Peer[] = [{ name: "mini", alias: null, root: wsMini, role: "git" }];

    const r = await syncAll([], { self: "mac", peers, seed: [], dry: true, root: wsMac }, 4);
    expect(r.cloned).toEqual(["proj"]);
    expect(r.states.has("proj")).toBe(false);
    expect(existsSync(join(wsMac, "proj"))).toBe(false);
  });

  test("two calls at once share one run", async () => {
    const wsMac = join(root, "synclock-wsmac");
    const wsMini = join(root, "synclock-wsmini");
    await mkdir(wsMac, { recursive: true });
    const mac = join(wsMac, "proj");
    await exec(["git", "init", "-q", "-b", "main", mac]);
    await sh(mac, "config", "user.email", "t@t");
    await sh(mac, "config", "user.name", "t");
    await commit(mac, "a.txt", "one\n");
    await mkdir(wsMini, { recursive: true });
    const mini = join(wsMini, "proj");
    await exec(["git", "clone", "-q", mac, mini]);
    await sh(mini, "config", "user.email", "t@t");
    await sh(mini, "config", "user.name", "t");
    const peers: Peer[] = [{ name: "mini", alias: null, root: wsMini, role: "git" }];
    await initRepo(mac, "proj", peers, false);
    const opts = { self: "mac", peers, seed: [], dry: false, root: wsMac };
    const [a, b] = [syncAll(["proj"], opts, 1), syncAll(["proj"], opts, 1)];
    expect(a).toBe(b);
    await a;
  });
});

describe("gitSshCommand", () => {
  test("quotes a ControlPath holding a space and a dollar sign as one shell word, keeping %C literal for ssh to expand", async () => {
    const cmd = gitSshCommand("/tmp/weird dir/$HOME");
    // Stand in for ssh with something that just echoes each word it was
    // handed, one per line, so a real /bin/sh's own word-splitting (not our
    // guess at it) is what proves the ControlPath survived as one argument
    // and "$HOME" was never expanded.
    const probe = cmd.replace(/^ssh /, "printf '%s\\n' ");
    const r = await exec(["sh", "-c", probe]);
    if (r.code !== 0) throw new Error(r.stderr);
    const words = r.stdout.split("\n").filter(Boolean);
    expect(words).toEqual([
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ControlMaster=auto",
      "-o", "ControlPath=/tmp/weird dir/$HOME/ssh-%C",
      "-o", "ControlPersist=120",
    ]);
  });
});

describe("canopy peers gate", () => {
  const bin = join(import.meta.dir, "..", "..", "bin", "canopy.ts");
  const gate = (cmd: string, rootDir: string) =>
    exec([process.execPath, bin, "peers", "gate", "--root", rootDir], { env: { SSH_ORIGINAL_COMMAND: cmd, HOME: root } });

  test("answers list and refuses a shell", async () => {
    const ws = join(root, "ws");
    const ok = await gate("'canopy-peer' 'list'", ws);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).map((r: { id: string }) => r.id)).toContain("group/a");
    const no = await gate("sh -c id", ws);
    expect(no.code).toBe(1);
    expect(no.stderr).toContain("canopy-peer: refused");
  });

  test("serves git-upload-pack so a clone works through it", async () => {
    const ws = join(root, "ws");
    // GIT_SSH_COMMAND pointing at a script that runs the gate stands in for sshd.
    const fake = join(root, "fake-ssh");
    await writeFile(fake, `#!/bin/sh\nshift\nSSH_ORIGINAL_COMMAND="$*" HOME=${root} exec ${process.execPath} ${bin} peers gate --root ${ws}\n`);
    await exec(["chmod", "+x", fake]);
    const dest = join(root, "via-gate");
    const r = await exec(["git", "clone", "-q", `peerhost:ws/group/a`, dest], { env: { GIT_SSH_COMMAND: fake, GIT_SSH_VARIANT: "simple" } });
    expect(r.code).toBe(0);
    const push = await exec(["git", "push", "origin", "HEAD:refs/heads/evil"], { cwd: dest, env: { GIT_SSH_COMMAND: fake, GIT_SSH_VARIANT: "simple" } });
    expect(push.code).not.toBe(0);
  });

  test("a seed query answers one unwrapped base64 line that decodes to the file's bytes", async () => {
    // group/a's .env ("A=1\n") is written by the "serve" describe above.
    const ws = join(root, "ws");
    const r = await gate("'canopy-peer' 'seed' 'group/a' '.env'", ws);
    expect(r.code).toBe(0);
    const line = r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
    expect(line.includes("\n")).toBe(false);
    expect(Buffer.from(line, "base64").toString("utf8")).toBe("A=1\n");
  });

  test("a path outside the root is refused: exit 1, canopy-peer: on stderr, nothing on stdout", async () => {
    const ws = join(root, "ws");
    const r = await gate("git-upload-pack '/etc'", ws);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("canopy-peer:");
  });

  test("git-upload-pack runs with an explicit, minimal env: GIT_CONFIG_PARAMETERS cannot run a hook", async () => {
    const ws = join(root, "ws");
    const marker = join(root, "hook-marker");
    // GIT_CONFIG_PARAMETERS is git's own env-config channel (what `git -c
    // k=v` sets for a child git process); a peer who can influence the
    // gate's environment could use it to set uploadpack.packObjectsHook and
    // have git-upload-pack itself run an arbitrary command. Passing the
    // whole environment through would let it; a spawn env limited to
    // PATH/HOME/GIT_PROTOCOL/LANG/LC_ALL never carries it.
    const fake = join(root, "fake-ssh-hook");
    await writeFile(
      fake,
      `#!/bin/sh\nshift\nSSH_ORIGINAL_COMMAND="$*" HOME=${root} GIT_CONFIG_PARAMETERS="'uploadpack.packObjectsHook=touch ${marker}'" exec ${process.execPath} ${bin} peers gate --root ${ws}\n`,
    );
    await exec(["chmod", "+x", fake]);
    const dest = join(root, "via-gate-hook");
    const r = await exec(["git", "clone", "-q", `peerhost:ws/group/a`, dest], { env: { GIT_SSH_COMMAND: fake, GIT_SSH_VARIANT: "simple" } });
    expect(r.code).toBe(0); // the clone itself still works
    expect(existsSync(marker)).toBe(false); // but the injected hook never ran
  });

  test("answers list even when peerSync is off: the gate is not this machine's sync mode", async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), "canopy-peers-gateoff-"));
    try {
      await writeFile(join(cfgDir, "config.json"), JSON.stringify({ peerSync: "off" }));
      const ws = join(root, "ws");
      const r = await exec([process.execPath, bin, "peers", "gate", "--root", ws], {
        env: { SSH_ORIGINAL_COMMAND: "'canopy-peer' 'list'", HOME: root, CANOPY_CONFIG_DIR: cfgDir },
      });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).map((x: { id: string }) => x.id)).toContain("group/a");
    } finally {
      await rm(cfgDir, { recursive: true, force: true });
    }
  });

  test("a config file that is present but unreadable refuses every query, quietly, and is left untouched", async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), "canopy-peers-badcfg-"));
    try {
      const cfgPath = join(cfgDir, "config.json");
      await writeFile(cfgPath, "{ not json");
      const before = await readFile(cfgPath, "utf8");
      const ws = join(root, "ws");
      const r = await exec([process.execPath, bin, "peers", "gate", "--root", ws], {
        env: { SSH_ORIGINAL_COMMAND: "'canopy-peer' 'list'", HOME: root, CANOPY_CONFIG_DIR: cfgDir },
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("canopy-peer: config unreadable");
      expect(await readFile(cfgPath, "utf8")).toBe(before); // never rewritten
      expect((await readdir(cfgDir)).sort()).toEqual(["config.json"]); // no .corrupt-* quarantine file
    } finally {
      await rm(cfgDir, { recursive: true, force: true });
    }
  });

  test("a refused command never reads the config at all: still refused with a broken one, and it stays untouched", async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), "canopy-peers-badcfg2-"));
    try {
      const cfgPath = join(cfgDir, "config.json");
      await writeFile(cfgPath, "{ not json");
      const before = await readFile(cfgPath, "utf8");
      const ws = join(root, "ws");
      const r = await exec([process.execPath, bin, "peers", "gate", "--root", ws], {
        env: { SSH_ORIGINAL_COMMAND: "sh -c id", HOME: root, CANOPY_CONFIG_DIR: cfgDir },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("canopy-peer: refused");
      expect(r.stderr).not.toContain("config unreadable"); // gateCommand refused before the config was ever read
      expect(await readFile(cfgPath, "utf8")).toBe(before);
    } finally {
      await rm(cfgDir, { recursive: true, force: true });
    }
  });

  test("a canopy-peer seeds query runs its in-process git calls with no GIT_ vars: GIT_CONFIG_PARAMETERS cannot set a hook", async () => {
    // serveSeeds runs git() in-process (ls-files), which — unlike the
    // upload-pack spawn — never went through an explicit env, so it
    // inherited whatever GIT_ vars this process had. core.fsmonitor is
    // git's own working-tree-status hook; ls-files consults it.
    const ws = join(root, "ws");
    const marker = join(root, "fsmonitor-marker");
    const r = await exec([process.execPath, bin, "peers", "gate", "--root", ws], {
      env: {
        SSH_ORIGINAL_COMMAND: "'canopy-peer' 'seeds' 'group/a'",
        HOME: root,
        GIT_CONFIG_PARAMETERS: `'core.fsmonitor=touch ${marker}'`,
      },
    });
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("a config that parses but is not a plain object (an array) is refused, like an unreadable one", async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), "canopy-peers-badcfg3-"));
    try {
      await writeFile(join(cfgDir, "config.json"), "[1]");
      const ws = join(root, "ws");
      const r = await exec([process.execPath, bin, "peers", "gate", "--root", ws], {
        env: { SSH_ORIGINAL_COMMAND: "'canopy-peer' 'list'", HOME: root, CANOPY_CONFIG_DIR: cfgDir },
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("canopy-peer: config unreadable");
    } finally {
      await rm(cfgDir, { recursive: true, force: true });
    }
  });
});

describe("peers CLI dry mode: init and seed write nothing", () => {
  test("initRepo under dry adds no remote", async () => {
    const mac = await repo("clidry-init-mac");
    const peer: Peer = { name: "mini", alias: null, root, role: "git" };
    await initRepo(mac, "clidry-init-mini", [peer], true);
    expect((await exec(["git", "config", "--get", "remote.mini.pushurl"], { cwd: mac })).code).not.toBe(0);
    expect((await exec(["git", "remote"], { cwd: mac })).stdout.trim()).toBe("");
  });

  test("seedRepo under dry reports what it would seed, and writes nothing", async () => {
    const theirsRoot = join(root, "clidry-seed-theirs");
    const theirs = join(theirsRoot, "proj");
    await mkdir(theirs, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", theirs]);
    await sh(theirs, "config", "user.email", "t@t");
    await sh(theirs, "config", "user.name", "t");
    await commit(theirs, ".gitignore", ".env\n");
    await writeFile(join(theirs, ".env"), "DRY=1\n");

    const here = join(root, "clidry-seed-here", "proj");
    await mkdir(here, { recursive: true });
    const peer: Peer = { name: "mini", alias: null, root: theirsRoot, role: "git" };
    const wrote = await seedRepo(here, "proj", [peer], [".env"], true);
    expect(wrote).toEqual([".env"]);
    expect(existsSync(join(here, ".env"))).toBe(false);
  });
});

describe("canopy peers CLI honours peerSync", () => {
  const bin = join(import.meta.dir, "..", "..", "bin", "canopy.ts");

  test("off refuses every subcommand but status and gate", async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), "canopy-peers-off-"));
    try {
      await writeFile(
        join(cfgDir, "config.json"),
        JSON.stringify({
          self: "mac",
          peers: [{ name: "mini", alias: "mini", root: "/tmp/nowhere", role: "git" }],
          peerSync: "off",
        }),
      );
      const sync = await exec([process.execPath, bin, "peers", "sync"], { env: { CANOPY_CONFIG_DIR: cfgDir } });
      expect(sync.code).toBe(1);
      expect(sync.stderr).toContain("canopy: peer sync is off");
      const status = await exec([process.execPath, bin, "peers", "status"], { env: { CANOPY_CONFIG_DIR: cfgDir } });
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("self: mac");
    } finally {
      await rm(cfgDir, { recursive: true, force: true });
    }
  });

  test("take with a detached HEAD and no branch argument refuses instead of guessing main", async () => {
    const mac = await repo("clidetached-mac");
    await sh(mac, "checkout", "-q", "--detach");
    // Stands in for a WIP that arrived from an earlier fetch, without
    // needing a live peer: takeWip only reads this ref and the peer name,
    // never cfg.peers itself.
    const wipHash = await sh(mac, "rev-parse", "HEAD");
    await sh(mac, "update-ref", "refs/peer-wip/mini/main", wipHash);

    const cfgDir = await mkdtemp(join(tmpdir(), "canopy-peers-detached-"));
    try {
      await writeFile(
        join(cfgDir, "config.json"),
        JSON.stringify({
          self: "mac",
          peers: [{ name: "mini", alias: "mini", root: "/tmp/nowhere", role: "git" }],
          peerSync: "on",
        }),
      );
      const r = await exec([process.execPath, bin, "peers", "take", "clidetached-mac", "mini"], {
        cwd: root,
        env: { CANOPY_CONFIG_DIR: cfgDir },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("HEAD is detached; name a branch");
    } finally {
      await rm(cfgDir, { recursive: true, force: true });
    }
  });
});
