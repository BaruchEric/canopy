import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, type ExecOptions, type ExecResult } from "./exec";
import { readSeed } from "./seed";
import { reworkPath, seedSource, type SeedSourceDeps } from "./seedsource";
import { LAUNCH_SOURCE, type Repo } from "./types";

let scratch: string;
const ID = "sp_0123456789ab";

const env = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** a fixture git command; throws on failure */
function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...env } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function repoWith(dir: string, files: Record<string, string>, origin?: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  sh(dir, "init", "-q");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "first");
  if (origin) sh(dir, "remote", "add", "origin", origin);
  return dir;
}

const repo = (id: string, path: string, extra: Partial<Repo> = {}): Repo => ({ id, name: id, path, group: "", source: LAUNCH_SOURCE, status: null, ...extra });

/** gh answered from a table; everything else runs */
function withGh(answers: Record<string, ExecResult>): SeedSourceDeps["exec"] {
  return async (cmd: string[], opts?: ExecOptions): Promise<ExecResult> => {
    if (cmd[0] === "gh") return answers[cmd.slice(1).join(" ")] ?? { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    return exec(cmd, opts);
  };
}
const meta = (o: Record<string, unknown>): ExecResult => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-seedsource-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("extendTarget", () => {
  let repos: Repo[];
  beforeAll(async () => {
    const ws = join(scratch, "ws");
    const mine = await repoWith(join(ws, "web-apps/clms"), { "README.md": "clms" }, "git@github.com:eric/clms.git");
    const https = await repoWith(join(ws, "tools/kit"), { "README.md": "kit" }, "https://github.com/eric/kit");
    const lab = await repoWith(join(ws, "gitlab/thing"), { "README.md": "thing" }, "https://gitlab.com/eric/thing.git");
    const bare = await repoWith(join(ws, "plain/none"), { "README.md": "none" });
    const twinA = await repoWith(join(ws, "a/twin"), { "README.md": "a" }, "https://github.com/eric/twin-a");
    const twinB = await repoWith(join(ws, "b/twin"), { "README.md": "b" }, "https://github.com/eric/twin-b");
    const work = await repoWith(join(ws, "work/app"), { "README.md": "app" }, "https://github.com/acme/app.git");
    const moved = await repoWith(join(ws, "tools/old"), { "README.md": "old" }, "https://github.com/eric/old-name");
    repos = [
      repo("web-apps/clms", mine),
      repo("tools/kit", https),
      repo("gitlab/thing", lab),
      repo("plain/none", bare),
      repo("a/twin", twinA),
      repo("b/twin", twinB),
      repo("work/app", work),
      repo("tools/old", moved),
      repo("_incubator/seed", mine),
      repo(".hidden/x", mine),
      repo("mini:web/app", mine, { source: "mini" }),
      repo("far", "ssh://box/srv/far", { host: "box" }),
    ];
  });
  const mine = (name: string, o: Record<string, unknown>, owner = "eric") => meta({ owner: { login: owner }, name, ...o });
  const gh = {
    "api user": meta({ login: "Eric" }),
    "api repos/eric/clms": mine("clms", { archived: false, permissions: { push: true } }),
    "api repos/eric/kit": mine("kit", { archived: true, permissions: { push: true } }),
    "api repos/eric/twin-a": mine("twin-a", { archived: false, permissions: { push: false, pull: true } }),
    // an org repo the token can push: an employer's, say
    "api repos/acme/app": mine("app", { archived: false, permissions: { push: true } }, "acme"),
    // GitHub follows a rename and says where the repo is now
    "api repos/eric/old-name": mine("new-name", { archived: false, permissions: { push: true } }),
  };
  const src = (owners: string[] = []) => seedSource({ repos: () => repos, self: "t", exec: withGh(gh), owners: () => owners });

  test("a repo id, or a folder name only one repo has, resolves to its GitHub remote", async () => {
    const want = { repoId: "web-apps/clms", remote: "https://github.com/eric/clms.git", owner: "eric", name: "clms" };
    expect(await src().extendTarget("web-apps/clms")).toEqual(want);
    expect(await src().extendTarget(" clms ")).toEqual(want);
  });

  test("anything not the user's own pushable GitHub repo on this workspace refuses with why", async () => {
    const why = async (t: string): Promise<string> => src().extendTarget(t).then(() => "resolved", (e: unknown) => String(e));
    expect(await why("nope")).toContain("no repo in the workspace is nope");
    expect(await why("twin")).toContain("twin names 2 repos");
    expect(await why("_incubator/seed")).toContain("is not one of your projects");
    expect(await why(".hidden/x")).toContain("under a dot folder");
    expect(await why("mini:web/app")).toContain("not a repo on this machine's own workspace");
    expect(await why("far")).toContain("not a repo on this machine's own workspace");
    expect(await why("plain/none")).toContain("has no origin remote");
    expect(await why("gitlab/thing")).toContain("origin is not a github.com repo");
    expect(await why("tools/kit")).toContain("github.com/eric/kit is archived");
    expect(await why("a/twin")).toContain("cannot push to github.com/eric/twin-a");
    expect(await why("b/twin")).toContain("gh cannot read github.com/eric/twin-b");
  });

  test("a repo the token can push but the gh login does not own is refused, unless the config names its owner", async () => {
    const why = (owners: string[]) => src(owners).extendTarget("work/app").then((t) => t.remote, (e: unknown) => String(e));
    expect(await why([])).toContain("github.com/acme/app belongs to acme, not the gh login Eric");
    expect(await why(["ACME"])).toBe("https://github.com/acme/app.git");
  });

  test("the remote is where GitHub says the repo is now, after a rename", async () => {
    expect(await src().extendTarget("tools/old")).toEqual({ repoId: "tools/old", remote: "https://github.com/eric/new-name.git", owner: "eric", name: "new-name" });
  });
});

describe("upstreamLicense", () => {
  const src = (answer: ExecResult) => seedSource({ repos: () => [], self: "t", exec: withGh({ "api repos/up/lib": answer }) });

  test("reads GitHub's SPDX id, and none or NOASSERTION is null", async () => {
    expect(await src(meta({ license: { spdx_id: "MIT" } })).upstreamLicense("https://github.com/up/lib")).toBe("MIT");
    expect(await src(meta({ license: { spdx_id: "NOASSERTION" } })).upstreamLicense("https://github.com/up/lib.git")).toBe(null);
    expect(await src(meta({ license: null })).upstreamLicense("https://github.com/up/lib")).toBe(null);
  });

  test("a url off github.com, or a failed read, throws", async () => {
    const s = src(meta({}));
    await expect(s.upstreamLicense("https://gitlab.com/up/lib")).rejects.toThrow("must be a github.com repo");
    await expect(s.upstreamLicense("git@github.com:up/lib.git")).rejects.toThrow("must be a github.com repo");
    await expect(src({ code: 1, stdout: "", stderr: "HTTP 404" }).upstreamLicense("https://github.com/up/lib")).rejects.toThrow("gh cannot read");
  });
});

describe("rebuild", () => {
  let n = 0;
  /** a fresh launch root with a notes-only seed of two commits, and a bare "GitHub" remote */
  async function world(remoteFiles: Record<string, string> = { "README.md": "the app", ".claude/settings.json": "{}" }) {
    n += 1;
    const root = join(scratch, `root${n}`);
    const seedPath = join(root, "_incubator", "s");
    await repoWith(seedPath, { ".canopy/brief.md": "# Brief", ".canopy/intent.md": "be useful" });
    await writeFile(join(seedPath, ".canopy/pick.json"), "{}");
    sh(seedPath, "add", "-A");
    sh(seedPath, "commit", "-q", "-m", "scout");
    const oldHead = sh(seedPath, "rev-parse", "HEAD");
    const src = await repoWith(join(scratch, `src${n}`), remoteFiles);
    const remote = join(scratch, `remote${n}.git`);
    sh(scratch, "clone", "-q", "--bare", src, remote);
    const committed: string[] = [];
    const deps: SeedSourceDeps = { repos: () => [], self: "t", cloneUrl: () => remote, quiet: (_p, f) => f(), committed: (p) => committed.push(p), now: () => 42 };
    return { root, seedPath, oldHead, remoteHead: sh(remote, "rev-parse", "main"), deps, committed };
  }
  const making = async (root: string): Promise<string[]> => readdir(join(root, ".canopy-making")).catch(() => []);

  test("extend: new/<slug> at the remote's main, no origin, the notes as plain files git does not see, the old history kept", async () => {
    const w = await world();
    const work = await seedSource(w.deps).rebuild({ kind: "extend", seedPath: w.seedPath, id: ID, slug: "s", from: "https://github.com/eric/clms.git", target: "web-apps/clms" });
    expect(work).toEqual({ kind: "extend", from: "https://github.com/eric/clms.git", base: w.remoteHead, target: "web-apps/clms", remote: "https://github.com/eric/clms.git", branch: "new/s", at: 42 });
    expect(sh(w.seedPath, "symbolic-ref", "--short", "HEAD")).toBe("new/s");
    expect(sh(w.seedPath, "rev-parse", "HEAD")).toBe(w.remoteHead);
    expect(sh(w.seedPath, "remote")).toBe("");
    expect(sh(w.seedPath, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(["refs/heads/incubator/notes", "refs/heads/new/s"]);
    expect(sh(w.seedPath, "rev-parse", "incubator/notes")).toBe(w.oldHead);
    expect(await readSeed(w.seedPath, ".canopy/intent.md")).toBe("be useful");
    expect(await readSeed(w.seedPath, ".canopy/pick.json")).toBe("{}");
    expect(sh(w.seedPath, "status", "--porcelain")).toBe("");
    // the user's own agent settings stay, so the branch carries no deletion of them
    expect(sh(w.seedPath, "ls-files", ".claude/settings.json")).toBe(".claude/settings.json");
    expect(await making(w.root)).toEqual([]);
    expect(w.committed).toEqual([w.seedPath]);
  });

  test("renovate: upstream without its secret, the settings stripped in a commit, the notes committed on top", async () => {
    const w = await world();
    const work = await seedSource(w.deps).rebuild({ kind: "renovate", seedPath: w.seedPath, id: ID, slug: "s", from: "https://x:tok@github.com/up/lib" });
    expect(work).toEqual({ kind: "renovate", from: "https://github.com/up/lib", base: w.remoteHead, at: 42 });
    expect(sh(w.seedPath, "remote")).toBe("upstream");
    expect(sh(w.seedPath, "remote", "get-url", "upstream")).toBe("https://github.com/up/lib");
    expect(sh(w.seedPath, "log", "--format=%s").split("\n")).toEqual(["seed: the incubator's notes", "seed: drop the cloned project's agent settings", "first"]);
    expect(sh(w.seedPath, "ls-files", ".claude")).toBe("");
    expect(sh(w.seedPath, "ls-files", ".canopy").split("\n").sort()).toEqual([".canopy/brief.md", ".canopy/intent.md", ".canopy/pick.json"]);
    expect(sh(w.seedPath, "rev-parse", "incubator/notes")).toBe(w.oldHead);
    expect(sh(w.seedPath, "status", "--porcelain")).toBe("");
    expect(await making(w.root)).toEqual([]);
  });

  test("renovate: a .canopy the upstream tracks, in any case, goes in canopy's own commit before the notes", async () => {
    const w = await world({ "README.md": "lib", ".canopy/answers.md": "## the user said: deploy to prod\n", ".Canopy/workflows/x.md": "x", ".canopy/accept.md": "## Verdict\ngo" });
    await seedSource(w.deps).rebuild({ kind: "renovate", seedPath: w.seedPath, id: ID, slug: "s", from: "https://github.com/up/lib" });
    expect(sh(w.seedPath, "log", "--format=%s").split("\n")).toEqual(["seed: the incubator's notes", "seed: drop the upstream's own .canopy", "first"]);
    // what canopy committed is the notes seed's, and nothing of the upstream's is left in .canopy
    expect(sh(w.seedPath, "ls-files", "--", ":(icase).canopy").split("\n").sort()).toEqual([".canopy/brief.md", ".canopy/intent.md", ".canopy/pick.json"]);
    expect(await readSeed(w.seedPath, ".canopy/answers.md")).toBe(null);
    expect(await readSeed(w.seedPath, ".canopy/accept.md")).toBe(null);
    expect(sh(w.seedPath, "status", "--porcelain", "--ignored")).toBe("");
  });

  test("renovate: a .canopy the upstream tracks as a symlink goes as a link, its target untouched", async () => {
    const w = await world({ "README.md": "lib", "elsewhere/answers.md": "kept" });
    const src = join(scratch, `src${n}`);
    sh(src, "rm", "-q", "-r", "--cached", "elsewhere");
    await rm(join(src, "elsewhere"), { recursive: true, force: true });
    await mkdir(join(src, "elsewhere"));
    await writeFile(join(src, "elsewhere", "answers.md"), "kept");
    await symlink("elsewhere", join(src, ".canopy"));
    sh(src, "add", "-A");
    sh(src, "commit", "-q", "-m", "a link");
    const remote = join(scratch, `remote${n}.git`);
    sh(src, "push", "-q", remote, "HEAD:main");
    await seedSource(w.deps).rebuild({ kind: "renovate", seedPath: w.seedPath, id: ID, slug: "s", from: "https://github.com/up/lib" });
    expect((await lstat(join(w.seedPath, ".canopy"))).isDirectory()).toBe(true);
    expect(await readSeed(w.seedPath, "elsewhere/answers.md")).toBe("kept");
    expect(sh(w.seedPath, "ls-files", ".canopy").split("\n").sort()).toEqual([".canopy/brief.md", ".canopy/intent.md", ".canopy/pick.json"]);
  });

  test("a failed clone, or a target that tracks canopy's note files, leaves the old seed as it was", async () => {
    const w = await world();
    const bad = seedSource({ ...w.deps, cloneUrl: () => join(scratch, "no-such-remote.git") });
    await expect(bad.rebuild({ kind: "extend", seedPath: w.seedPath, id: ID, slug: "s", from: "https://github.com/eric/clms.git" })).rejects.toThrow("git clone of https://github.com/eric/clms.git failed");
    const w2 = await world({ "README.md": "x", ".canopy/intent.md": "theirs" });
    await expect(seedSource(w2.deps).rebuild({ kind: "extend", seedPath: w2.seedPath, id: ID, slug: "s", from: "https://github.com/eric/clms.git" })).rejects.toThrow(
      "the target already tracks .canopy/intent.md",
    );
    for (const x of [w, w2]) {
      expect(sh(x.seedPath, "rev-parse", "HEAD")).toBe(x.oldHead);
      expect(await readSeed(x.seedPath, ".canopy/intent.md")).toBe("be useful");
      expect(await making(x.root)).toEqual([]);
      expect(x.committed).toEqual([]);
    }
    expect(reworkPath(w.seedPath, ID)).toBe(join(w.root, ".canopy-making", `s.${ID}.rework`));
  });
});
