import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, git, setSeedGit } from "./exec";
import { guardSeed, seedBusyFor, seedConfigRefusal, seedHeld, seedTopOf, setSeedBusy, setSeedRoots, underSeeds, SEED_AWAY, SEED_BUSY, SEED_GIT_FLAGS } from "./seedgit";

describe("seedConfigRefusal", () => {
  const ok: [string, string][] = [
    ["core.repositoryformatversion", "0"],
    ["core.filemode", "true"],
    ["core.bare", "false"],
    ["core.logallrefupdates", "true"],
    ["remote.upstream.url", "https://github.com/a/b.git"],
    ["remote.upstream.fetch", "+refs/heads/*:refs/remotes/upstream/*"],
    ["remote.mini.pushurl", "canopy-peer-no-push"],
    ["remote.mini.tagopt", "--no-tags"],
    ["branch.main.remote", "upstream"],
    ["branch.main.merge", "refs/heads/main"],
    ["branch.release-1.2.merge", "refs/heads/release-1.2"],
    ["branch.main.vscode-merge-base", "origin/main"],
    ["remote.mini.prune", "true"],
    ["user.name", "canopy"],
    ["user.email", "canopy@mini"],
    ["extensions.objectformat", "sha1"],
  ];
  test("what canopy and a plain commit write passes", () => {
    expect(seedConfigRefusal(ok)).toBe(null);
  });
  test.each([
    ["core.fsmonitor", "./x"],
    ["core.hookspath", "./hooks"],
    ["core.sshcommand", "sh -c x"],
    ["core.pager", "sh"],
    ["filter.lfs.clean", "sh -c x"],
    ["diff.x.textconv", "sh"],
    ["include.path", "/tmp/evil"],
    ["includeif.gitdir:/.path", "/tmp/evil"],
    ["remote.upstream.uploadpack", "sh"],
    ["url.ext::sh.insteadof", "https://"],
    ["extensions.worktreeconfig", "true"],
    ["alias.st", "!sh"],
  ])("%s refuses, named", (key, value) => {
    expect(seedConfigRefusal([...ok, [key, value]])).toContain(key);
  });
  test("a url that is a transport command or a flag refuses", () => {
    expect(seedConfigRefusal([["remote.x.url", "ext::sh -c id"]])).toContain("remote.x.url");
    expect(seedConfigRefusal([["remote.x.url", "-oProxyCommand=id"]])).toContain("remote.x.url");
    expect(seedConfigRefusal([["remote.x.pushurl", "fd::3"]])).toContain("remote.x.pushurl");
  });
  test("keys compare lowercased, as git stores them", () => {
    expect(seedConfigRefusal([["Core.FsMonitor", "x"]])).toContain("core.fsmonitor");
  });
  test("a refusal names the command that undoes it", () => {
    expect(seedConfigRefusal([["core.pager", "less"]])).toContain("git config --unset-all core.pager");
  });
  test("a dotted subsection cannot smuggle a key past the end anchor", () => {
    expect(seedConfigRefusal([["branch.a.b.uploadpack", "sh"]])).toContain("branch.a.b.uploadpack");
    expect(seedConfigRefusal([["remote.x.y.receivepack", "sh"]])).toContain("remote.x.y.receivepack");
  });
});

describe("underSeeds", () => {
  test("a path inside a seeds dir, not the dir itself or a lookalike", () => {
    expect(underSeeds("/w/_incubator/coin", ["/w/_incubator"])).toBe(true);
    expect(underSeeds("/w/_incubator/coin/sub", ["/w/_incubator"])).toBe(true);
    expect(underSeeds("/w/_incubator", ["/w/_incubator"])).toBe(false);
    expect(underSeeds("/w/_incubatorx/coin", ["/w/_incubator"])).toBe(false);
    expect(underSeeds("ssh://mini/w/_incubator/coin", ["/w/_incubator"])).toBe(false);
  });
});

describe("seedTopOf", () => {
  test("the seed a path sits in: the first folder under the seeds dir", () => {
    expect(seedTopOf("/w/_incubator/coin", ["/w/_incubator"])).toBe("/w/_incubator/coin");
    expect(seedTopOf("/w/_incubator/coin/src/lib", ["/w/_incubator"])).toBe("/w/_incubator/coin");
    expect(seedTopOf("/w/_incubator", ["/w/_incubator"])).toBe(null);
    expect(seedTopOf("/w/other/coin", ["/w/_incubator"])).toBe(null);
  });
});

describe("the guard on real seeds", () => {
  let root = "";
  let seeds = "";
  const marker = () => join(root, "ran");
  const ran = async (): Promise<boolean> => {
    const was = await Bun.file(marker()).exists();
    await rm(marker(), { force: true });
    return was;
  };
  const filter = () => `sh -c 'touch ${marker()}; cat'`;
  const commit = async (dir: string): Promise<void> => {
    expect((await exec(["git", "-c", "user.name=a", "-c", "user.email=a@b", "add", "."], { cwd: dir })).code).toBe(0);
    expect((await exec(["git", "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "s"], { cwd: dir })).code).toBe(0);
  };
  const seed = async (name: string): Promise<string> => {
    const dir = join(seeds, name);
    await mkdir(dir, { recursive: true });
    expect((await exec(["git", "init", "-q", "-b", "main"], { cwd: dir })).code).toBe(0);
    await writeFile(join(dir, "a.txt"), "a\n");
    return dir;
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "canopy-seedgit-"));
    seeds = join(root, "_incubator");
    await mkdir(seeds, { recursive: true });
    setSeedRoots([seeds]);
  });
  afterAll(async () => {
    setSeedRoots([]);
    await rm(root, { recursive: true, force: true });
  });

  test("a clean seed reads as before, with the hardening flags", async () => {
    const dir = await seed("clean");
    expect(await guardSeed(dir)).toBe(null);
    const r = await git(dir, ["status", "--porcelain=v2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("a.txt");
    expect(SEED_GIT_FLAGS).toEqual([
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "protocol.ext.allow=never",
      "-c", "diff.ignoreSubmodules=all",
      "-c", "submodule.recurse=false",
      "-c", "fetch.recurseSubmodules=false",
      "-c", "safe.bareRepository=explicit",
    ]);
  });

  test("an fsmonitor the agent wrote never runs, and the reason names it", async () => {
    const dir = await seed("fsmon");
    await writeFile(join(root, "mon.sh"), `#!/bin/sh\ntouch ${marker()}\n`, { mode: 0o755 });
    await appendFile(join(dir, ".git", "config"), `[core]\n\tfsmonitor = ${join(root, "mon.sh")}\n`);
    const r = await git(dir, ["status", "--porcelain=v2"]);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain("core.fsmonitor");
    expect(await ran()).toBe(false);
  });

  test("an include is refused without being followed", async () => {
    const dir = await seed("incl");
    await writeFile(join(root, "evil.cfg"), `[core]\n\tfsmonitor = ${join(root, "mon.sh")}\n`);
    await appendFile(join(dir, ".git", "config"), `[include]\n\tpath = ${join(root, "evil.cfg")}\n`);
    expect(await guardSeed(dir)).toContain("include.path");
  });

  test("a key added after a clean read is caught on the next call", async () => {
    const dir = await seed("later");
    expect(await guardSeed(dir)).toBe(null);
    await Bun.sleep(5);
    await appendFile(join(dir, ".git", "config"), `[filter "x"]\n\tclean = sh\n`);
    expect(await guardSeed(dir)).toContain("filter.x.clean");
  });

  test("a same-size swap with the old mtime put back is still caught", async () => {
    const dir = await seed("forged");
    const file = join(dir, ".git", "config");
    await appendFile(file, `[user]\n\tname = abcdefgh\n`);
    // a whole-second mtime, so putting it back is exact
    const when = new Date(2026, 0, 1);
    await utimes(file, when, when);
    expect(await guardSeed(dir)).toBe(null);
    const text = await Bun.file(file).text();
    // same length: "[user]\n\tname = abcdefgh\n" becomes "[alias]\n\tst = !sh -c x\n"
    const swapped = text.replace("[user]\n\tname = abcdefgh\n", "[alias]\n\tzz = !sh -c xy\n");
    expect(swapped.length).toBe(text.length);
    await Bun.sleep(20);
    await writeFile(file, swapped);
    await utimes(file, when, when);
    expect((await stat(file)).mtimeMs).toBe(when.getTime());
    expect(await guardSeed(dir)).toContain("alias.zz");
  });

  test("a gitfile .git refuses", async () => {
    const dir = join(seeds, "gitfile");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".git"), "gitdir: /tmp/elsewhere\n");
    expect(await guardSeed(dir)).toContain("gitfile");
  });

  test("a symlinked .git refuses", async () => {
    const real = await seed("linktarget-not-a-seed");
    const dir = join(seeds, "linked");
    await mkdir(dir, { recursive: true });
    await symlink(join(real, ".git"), join(dir, ".git"));
    expect(await guardSeed(dir)).toContain("symlink");
  });

  test("a commondir that points git at another config refuses, and its filter never runs", async () => {
    const dir = await seed("common");
    await writeFile(join(dir, ".gitattributes"), "* filter=x\n");
    await commit(dir);
    const evil = join(root, "evil-common");
    expect((await exec(["cp", "-R", join(dir, ".git"), evil])).code).toBe(0);
    await appendFile(join(evil, "config"), `[filter "x"]\n\tclean = ${filter()}\n`);
    await writeFile(join(dir, ".git", "commondir"), `${evil}\n`);
    await appendFile(join(dir, "a.txt"), "more\n");
    expect(await guardSeed(dir)).toContain("commondir");
    expect((await git(dir, ["status", "--porcelain=v2"])).code).toBe(128);
    expect(await ran()).toBe(false);
  });

  test("a config.worktree refuses", async () => {
    const dir = await seed("wtconfig");
    await writeFile(join(dir, ".git", "config.worktree"), `[core]\n\tpager = sh\n`);
    expect(await guardSeed(dir)).toContain("config.worktree");
  });

  test("a committed gitlink's own .git folder never runs its filter", async () => {
    const dir = await seed("gitlink");
    const sub = join(dir, "sub");
    await mkdir(sub);
    expect((await exec(["git", "init", "-q"], { cwd: sub })).code).toBe(0);
    await writeFile(join(sub, ".gitattributes"), "* filter=x\n");
    await writeFile(join(sub, "f"), "hi\n");
    await commit(sub);
    await commit(dir);
    expect((await exec(["git", "config", "filter.x.clean", filter()], { cwd: sub })).code).toBe(0);
    await appendFile(join(sub, "f"), "more\n");
    expect(await guardSeed(dir)).toBe(null);
    expect((await git(dir, ["status", "--porcelain=v2"])).code).toBe(0);
    expect(await ran()).toBe(false);
  });

  test("a folder under a seed is judged by its seed's .git", async () => {
    const dir = await seed("deep");
    await mkdir(join(dir, "src", "lib"), { recursive: true });
    await appendFile(join(dir, ".git", "config"), `[core]\n\tpager = sh\n`);
    expect(await guardSeed(join(dir, "src", "lib"))).toContain("core.pager");
  });

  test("git never walks up into a .git the agent wrote in the seeds dir", async () => {
    const outer = join(root, "walk");
    const inner = join(outer, "_incubator");
    await mkdir(join(inner, "coin"), { recursive: true });
    setSeedRoots([inner]);
    try {
      expect((await exec(["git", "init", "-q"], { cwd: inner })).code).toBe(0);
      await writeFile(join(inner, ".gitattributes"), "* filter=x\n");
      await writeFile(join(inner, "coin", "f"), "hi\n");
      await commit(inner);
      expect((await exec(["git", "config", "filter.x.clean", filter()], { cwd: inner })).code).toBe(0);
      await rm(marker(), { force: true });
      await appendFile(join(inner, "coin", "f"), "more\n");
      const r = await git(join(inner, "coin"), ["status", "--porcelain=v2"]);
      expect(r.code).not.toBe(0);
      expect(await ran()).toBe(false);
      // a new seed still inits under the ceiling
      await mkdir(join(inner, "fresh"));
      expect((await git(join(inner, "fresh"), ["init", "-q", "-b", "main"])).code).toBe(0);
      expect(await Bun.file(join(inner, "fresh", ".git", "HEAD")).exists()).toBe(true);
    } finally {
      setSeedRoots([seeds]);
    }
  });

  test("an empty .git never lets git take the seed folder as a bare repo", async () => {
    const dir = join(seeds, "bare");
    await mkdir(dir, { recursive: true });
    expect((await exec(["git", "init", "-q", "--bare", "."], { cwd: dir })).code).toBe(0);
    await mkdir(join(dir, ".git"));
    const cfg = join(dir, "config");
    for (const kv of [["core.bare", "false"], ["core.worktree", dir], ["filter.x.clean", filter()]]) {
      expect((await exec(["git", "config", "--file", cfg, kv[0]!, kv[1]!])).code).toBe(0);
    }
    await writeFile(join(dir, ".gitattributes"), "* filter=x\n");
    await writeFile(join(dir, "f"), "hi\n");
    // tracked, so a status after an edit runs the clean filter
    expect((await exec(["git", "-C", dir, "add", "f", ".gitattributes"], { env: { ...process.env, GIT_CEILING_DIRECTORIES: seeds } })).code).toBe(0);
    await rm(marker(), { force: true });
    await appendFile(join(dir, "f"), "more\n");
    await git(dir, ["status", "--porcelain=v2"]);
    expect(await ran()).toBe(false);
  });

  test("a seed folder laid out as a bare repo, with no .git, never runs its filter", async () => {
    const dir = join(seeds, "barefaced");
    await mkdir(dir, { recursive: true });
    expect((await exec(["git", "init", "-q", "--bare", "."], { cwd: dir })).code).toBe(0);
    const cfg = join(dir, "config");
    for (const kv of [["core.bare", "false"], ["core.worktree", dir], ["filter.x.clean", filter()]]) {
      expect((await exec(["git", "config", "--file", cfg, kv[0]!, kv[1]!])).code).toBe(0);
    }
    await writeFile(join(dir, ".gitattributes"), "* filter=x\n");
    await writeFile(join(dir, "f"), "hi\n");
    expect((await exec(["git", "-C", dir, "add", "f", ".gitattributes"], { env: { ...process.env, GIT_CEILING_DIRECTORIES: seeds } })).code).toBe(0);
    await rm(marker(), { force: true });
    await appendFile(join(dir, "f"), "more\n");
    await git(dir, ["status", "--porcelain=v2"]);
    expect(await ran()).toBe(false);
  });

  test("a .git that is not a whole repo refuses, so it cannot hide the seed's own", async () => {
    const dir = await seed("hollow");
    await appendFile(join(dir, ".git", "config"), `[core]\n\tpager = sh\n`);
    await mkdir(join(dir, "src", ".git"), { recursive: true });
    expect(await guardSeed(join(dir, "src"))).toContain("not a whole repository");
  });

  test("canopy runs no git in the seeds dir itself", async () => {
    const r = await git(seeds, ["status"]);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain("seeds folder");
  });

  test("while a stage process is alive in a seed, canopy runs no git there", async () => {
    const dir = await seed("busy");
    setSeedBusy((p) => p === dir);
    const r = await git(dir, ["status"]);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain("waits for the stage");
    setSeedBusy(() => false);
    expect((await git(dir, ["status"])).code).toBe(0);
  });

  test("with a seed git hook set, a seed's git goes to it and never runs here, and other repos ignore it", async () => {
    const dir = await seed("hooked");
    const plain = join(root, "plain-hooked");
    await mkdir(plain, { recursive: true });
    await exec(["git", "init", "-q"], { cwd: plain });
    const seen: { path: string; args: string[]; env: Record<string, string> }[] = [];
    setSeedGit({
      run: async (path, args, opts) => {
        seen.push({ path, args, env: opts.env });
        return { code: 0, stdout: "from the runner\n", stderr: "" };
      },
      toFile: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    try {
      const r = await git(dir, ["status", "--porcelain"], 30_000, { GIT_AUTHOR_NAME: "canopy" });
      expect(r.stdout).toBe("from the runner\n");
      expect(seen).toEqual([{ path: dir, args: ["status", "--porcelain"], env: { GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "canopy" } }]);
      // a name the runner would refuse is refused here, before anything is sent
      const off = await git(dir, ["add", "-A"], 30_000, { GIT_INDEX_FILE: join(root, "i") });
      expect(off.code).toBe(128);
      expect(off.stderr).toContain("GIT_INDEX_FILE");
      expect(seen).toHaveLength(1);
      // the guard still runs first
      await appendFile(join(dir, ".git", "config"), `[core]\n\tpager = sh\n`);
      expect((await git(dir, ["status"])).stderr).toContain("core.pager");
      expect(seen).toHaveLength(1);
      expect((await git(plain, ["status", "--porcelain"])).stdout).toBe("");
      expect(seen).toHaveLength(1);
    } finally {
      setSeedGit(null);
    }
  });

  test("a repo outside the seeds dir is not read by the guard", async () => {
    const dir = join(root, "plain");
    await mkdir(dir, { recursive: true });
    await exec(["git", "init", "-q"], { cwd: dir });
    await appendFile(join(dir, ".git", "config"), `[alias]\n\tst = status\n`);
    expect(await guardSeed(dir)).toBe(null);
    expect((await git(dir, ["status"])).code).toBe(0);
  });
});

describe("seedBusyFor", () => {
  const roots = ["/r/_incubator"];
  const world = (isolated: boolean, alive: string[], checks: string[] = []) => ({
    isolated,
    checks: new Map(checks.map((c) => [c, 1])),
    aliveIn: (seed: string) => alive.includes(seed),
    aliveAny: () => alive.length > 0,
  });
  test("isolated: a seed is busy only while its own stage or check is", () => {
    const w = world(true, ["/r/_incubator/beta"], ["/r/_incubator/gamma"]);
    expect(seedBusyFor("/r/_incubator/beta", roots, w)).toBe(true);
    expect(seedBusyFor("/r/_incubator/beta/src", roots, w)).toBe(true);
    expect(seedBusyFor("/r/_incubator/gamma", roots, w)).toBe(true);
    expect(seedBusyFor("/r/_incubator/alpha", roots, w)).toBe(false);
  });
  test("unisolated: any stage or check holds every seed", () => {
    expect(seedBusyFor("/r/_incubator/alpha", roots, world(false, ["/r/_incubator/beta"]))).toBe(true);
    expect(seedBusyFor("/r/_incubator/alpha", roots, world(false, [], ["/r/_incubator/gamma"]))).toBe(true);
    expect(seedBusyFor("/r/_incubator/alpha", roots, world(false, []))).toBe(false);
  });
  test("a path outside the seeds is never busy", () => {
    expect(seedBusyFor("/r/app", roots, world(false, ["/r/_incubator/beta"]))).toBe(false);
  });
  test("a held seed is busy or away, nothing else", () => {
    expect(seedHeld(SEED_BUSY)).toBe(true);
    expect(seedHeld(`${SEED_AWAY}: the stage runner is not answering`)).toBe(true);
    expect(seedHeld("fatal: not a git repository")).toBe(false);
    expect(seedHeld(undefined)).toBe(false);
  });
});
