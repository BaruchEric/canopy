import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, setSeedGit } from "./exec";
import { bundleHead, bundleSeed } from "./seedmirror";
import { SEED_AWAY, setSeedRoots } from "./seedgit";

let dir = "";
let seeds = "";
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
async function seed(name: string, commit = true): Promise<string> {
  const path = join(seeds, name);
  await mkdir(path, { recursive: true });
  await sh(path, "init", "-q", "-b", "main");
  if (commit) {
    await writeFile(join(path, "a.txt"), "a\n");
    await sh(path, "add", "a.txt");
    await sh(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one");
  }
  return path;
}

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-mirror-")));
  seeds = join(dir, "_incubator");
  setSeedRoots([seeds]);
});
afterAll(async () => {
  setSeedRoots([]);
  await rm(dir, { recursive: true, force: true });
});

describe("bundleHead", () => {
  test("reads HEAD's commit off a bundle's ref list, and nothing else", () => {
    const sha = "a".repeat(40);
    expect(bundleHead(`${"b".repeat(40)} refs/heads/main\n${sha} HEAD\n`)).toBe(sha);
    expect(bundleHead(`${sha} refs/heads/HEAD\n`)).toBe(null);
    expect(bundleHead("nothead HEAD\n")).toBe(null);
    expect(bundleHead("")).toBe(null);
  });
});

describe("bundleSeed", () => {
  test("a bundle of a seed clones to the seed's HEAD, every branch with it", async () => {
    const path = await seed("coin");
    await sh(path, "checkout", "-qb", "feat");
    await writeFile(join(path, "b.txt"), "b\n");
    await sh(path, "add", "b.txt");
    await sh(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "two");
    const file = join(dir, "coin.bundle");
    const { head } = await bundleSeed(path, file);
    expect(head).toBe(await sh(path, "rev-parse", "HEAD"));
    const clone = join(dir, "coin-clone");
    await sh(dir, "clone", "-q", "--no-checkout", "--", file, clone);
    await sh(clone, "checkout", "-q", "--detach", head);
    expect(await Bun.file(join(clone, "b.txt")).text()).toBe("b\n");
    expect(await sh(clone, "branch", "-r")).toContain("origin/main");
  });

  test("a seed with no commit has no bundle, and says so", async () => {
    const path = await seed("empty", false);
    await expect(bundleSeed(path, join(dir, "empty.bundle"))).rejects.toThrow("the seed has no commit yet");
  });

  test("on an isolated backend the bundle is made through the hook, never by git here", async () => {
    const path = await seed("routed");
    const asked: string[][] = [];
    const real = join(dir, "routed-real.bundle");
    await sh(path, "bundle", "create", real, "--all", "HEAD");
    setSeedGit({
      run: async () => ({ code: 128, stdout: "", stderr: "not this one" }),
      toFile: async (p, args, file) => {
        asked.push([p, ...args]);
        await Bun.write(file, Bun.file(real));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    try {
      const { head } = await bundleSeed(path, join(dir, "routed.bundle"));
      expect(head).toBe(await sh(path, "rev-parse", "HEAD"));
      expect(asked).toEqual([[path, "bundle", "create", "-", "--all", "HEAD"]]);
    } finally {
      setSeedGit(null);
    }
  });

  test("a seed held by its runner is waited out, not failed", async () => {
    const path = await seed("held");
    const real = join(dir, "held-real.bundle");
    await sh(path, "bundle", "create", real, "--all", "HEAD");
    let tries = 0;
    setSeedGit({
      run: async () => ({ code: 128, stdout: "", stderr: "not this one" }),
      toFile: async (_p, _args, file) => {
        if (++tries < 2) return { code: 128, stdout: "", stderr: `${SEED_AWAY}: the runner is restarting` };
        await Bun.write(file, Bun.file(real));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    try {
      await bundleSeed(path, join(dir, "held.bundle"));
      expect(tries).toBe(2);
    } finally {
      setSeedGit(null);
    }
  });

  test("a seed whose config canopy will not run is refused, naming the key", async () => {
    const path = await seed("hostile");
    const mark = join(dir, "ran");
    await sh(path, "config", "core.fsmonitor", `touch ${mark}`);
    await expect(bundleSeed(path, join(dir, "hostile.bundle"))).rejects.toThrow("core.fsmonitor");
    expect(await Bun.file(mark).exists()).toBe(false);
  });
});
