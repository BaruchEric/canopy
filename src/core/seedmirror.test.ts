import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, setSeedGit } from "./exec";
import { bundleHead, bundleSeed, MIRRORS_DIR, mirrorPath, mirrorRefusal, SeedMirrors } from "./seedmirror";
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

describe("SeedMirrors", () => {
  /** a hook that runs the seed's git here, counting the bundles it makes */
  const counting = () => {
    const bundles: string[] = [];
    setSeedGit({
      run: (p, args, opts) => exec(["git", "-C", p, ...args], { timeoutMs: opts.timeoutMs, env: opts.env }),
      toFile: async (p, args, file, opts) => {
        bundles.push(p);
        return exec(["git", "-C", p, ...args.map((a) => (a === "-" ? file : a))], { timeoutMs: opts.timeoutMs, env: opts.env });
      },
    });
    return bundles;
  };
  const mirrorRefs = (m: string) => sh(m, "for-each-ref", "--format=%(objectname) %(refname)");

  test("a mirror holds the seed's refs and its HEAD, detached, and is made again when gone", async () => {
    const path = await seed("mirrored");
    await sh(path, "branch", "side");
    const mirrors = new SeedMirrors(dir);
    const bundles = counting();
    try {
      expect(await mirrors.sync(path)).toBe("synced");
      const m = mirrorPath(dir, "mirrored");
      expect(m).toBe(join(dir, MIRRORS_DIR, "mirrored", ".git"));
      expect(await mirrorRefs(m)).toBe(await sh(path, "for-each-ref", "--format=%(objectname) %(refname)"));
      expect(await sh(m, "rev-parse", "HEAD")).toBe(await sh(path, "rev-parse", "HEAD"));
      expect((await exec(["git", "-C", m, "symbolic-ref", "-q", "HEAD"])).code).not.toBe(0);
      expect(await mirrorRefusal(dir, "mirrored")).toBe(null);
      // nothing new: no bundle
      expect(await mirrors.sync(path)).toBe("same");
      expect(bundles).toHaveLength(1);
      // a new commit and a dropped branch reach the mirror
      await sh(path, "branch", "-D", "side");
      await sh(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
      expect(await mirrors.sync(path)).toBe("synced");
      expect(await mirrorRefs(m)).toBe(await sh(path, "for-each-ref", "--format=%(objectname) %(refname)"));
      expect(await sh(m, "rev-parse", "HEAD")).toBe(await sh(path, "rev-parse", "HEAD"));
      // a mirror that is gone comes back, though the seed did not move
      await rm(join(dir, MIRRORS_DIR, "mirrored"), { recursive: true, force: true });
      expect(await mirrorRefusal(dir, "mirrored")).toBe("canopy has no mirror of this seed yet");
      expect(await mirrors.sync(path)).toBe("synced");
      expect(await sh(m, "rev-parse", "HEAD")).toBe(await sh(path, "rev-parse", "HEAD"));
      expect(bundles).toHaveLength(3);
    } finally {
      setSeedGit(null);
    }
  });

  test("a seed held now, or with no commit, leaves the mirror as it was", async () => {
    const empty = await seed("bare-seed", false);
    const mirrors = new SeedMirrors(dir);
    expect(await mirrors.sync(empty)).toBe("empty");
    expect(await mirrorRefusal(dir, "bare-seed")).toBe("canopy has no mirror of this seed yet");
    const path = await seed("held-mirror");
    setSeedGit({
      run: async () => ({ code: 128, stdout: "", stderr: `${SEED_AWAY}: away` }),
      toFile: async () => ({ code: 128, stdout: "", stderr: `${SEED_AWAY}: away` }),
    });
    try {
      expect(await mirrors.sync(path)).toBe("held");
      expect(await mirrorRefusal(dir, "held-mirror")).toBe("canopy has no mirror of this seed yet");
    } finally {
      setSeedGit(null);
    }
  });

  test("syncs of one seed run one at a time", async () => {
    const path = await seed("queued");
    let inFlight = 0;
    let most = 0;
    setSeedGit({
      run: async (p, args, opts) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await Bun.sleep(30);
        inFlight--;
        return exec(["git", "-C", p, ...args], { timeoutMs: opts.timeoutMs, env: opts.env });
      },
      toFile: (p, args, file, opts) => exec(["git", "-C", p, ...args.map((a) => (a === "-" ? file : a))], { timeoutMs: opts.timeoutMs, env: opts.env }),
    });
    try {
      const mirrors = new SeedMirrors(dir);
      expect(await Promise.all([mirrors.sync(path), mirrors.sync(path), mirrors.sync(path)])).toEqual(["synced", "same", "same"]);
      expect(most).toBe(1);
    } finally {
      setSeedGit(null);
    }
  });

  test("the gate's mirror check refuses a link in place of the mirror", async () => {
    const path = await seed("linked");
    await new SeedMirrors(join(dir, "elsewhere")).sync(path);
    await mkdir(join(dir, MIRRORS_DIR), { recursive: true });
    await symlink(join(dir, "elsewhere", MIRRORS_DIR, "linked"), join(dir, MIRRORS_DIR, "linked"));
    expect(await mirrorRefusal(dir, "linked")).toBe("canopy's mirror of this seed is not where canopy keeps it");
  });
});
