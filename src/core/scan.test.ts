import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { commit, getStatus, stageFile } from "./git";
import {
  catCommand,
  findCommand,
  findRepoDirs,
  launchSource,
  parseGitmodules,
  parseModuleDump,
  pruneNested,
  repoId,
  repoRel,
  scan,
  scanSource,
  sourceGroup,
  sourceRepoId,
  withSubmodules,
} from "./scan";
import type { Source } from "./types";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-test-"));
  // repos at varying depths; a fake .git dir is enough for discovery
  for (const p of ["a/repo1", "a/repo2", "b/deep/repo3"]) {
    await mkdir(join(root, p, ".git"), { recursive: true });
  }
  // a repo inside node_modules must be ignored
  await mkdir(join(root, "a/node_modules/dep/.git"), { recursive: true });
  // nothing below a repo root should be scanned
  await mkdir(join(root, "a/repo1/sub/.git"), { recursive: true });
  // except its submodules: a checked-out one (with a .git), and one below
  // that, count; a listed one never checked out does not
  await mkdir(join(root, "b/deep/repo3/mods/one/.git"), { recursive: true });
  await mkdir(join(root, "b/deep/repo3/mods/one/inner/.git"), { recursive: true });
  await mkdir(join(root, "b/deep/repo3/mods/two"), { recursive: true });
  await writeFile(
    join(root, "b/deep/repo3/.gitmodules"),
    '[submodule "one"]\n\tpath = mods/one\n\turl = x\n[submodule "two"]\n\tpath = mods/two\n\turl = y\n',
  );
  await writeFile(
    join(root, "b/deep/repo3/mods/one/.gitmodules"),
    '[submodule "inner"]\n\tpath = inner\n\turl = z\n',
  );
  // plain folder, no repo
  await mkdir(join(root, "c/empty"), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findRepoDirs", () => {
  test("the seeds folder is never a repo, even with a .git an agent wrote; its seeds still are", async () => {
    const w = await mkdtemp(join(tmpdir(), "canopy-seeds-scan-"));
    await mkdir(join(w, "_incubator", ".git"), { recursive: true });
    await mkdir(join(w, "_incubator", "coin", ".git"), { recursive: true });
    await mkdir(join(w, "x", "_incubator", ".git"), { recursive: true });
    const dirs = await findRepoDirs(w);
    expect(dirs).toContain(join(w, "_incubator", "coin"));
    expect(dirs).not.toContain(join(w, "_incubator"));
    // only the root's own: a folder of that name deeper down is any other folder
    expect(dirs).toContain(join(w, "x", "_incubator"));
    await rm(w, { recursive: true, force: true });
  });
  test("the shared copies under the seeds folder never become cards, even with a .git in them", async () => {
    const w = await mkdtemp(join(tmpdir(), "canopy-shared-scan-"));
    await mkdir(join(w, "_incubator", "coin", ".git"), { recursive: true });
    await mkdir(join(w, "_incubator", ".shared", "workspace", "sp_1", ".git"), { recursive: true });
    const dirs = await findRepoDirs(w);
    expect(dirs).toEqual([join(w, "_incubator", "coin")]);
    await rm(w, { recursive: true, force: true });
  });
  test("finds repos, skips ignored dirs, stops at repo roots except for submodules", async () => {
    const dirs = await findRepoDirs(root);
    const rels = dirs.map((d) => repoId(root, d));
    expect(rels).toEqual([
      "a/repo1",
      "a/repo2",
      "b/deep/repo3",
      "b/deep/repo3/mods/one",
      "b/deep/repo3/mods/one/inner",
    ]);
  });

  test("respects maxDepth", async () => {
    const dirs = await findRepoDirs(root, { maxDepth: 2 });
    const rels = dirs.map((d) => repoId(root, d));
    expect(rels).toEqual(["a/repo1", "a/repo2"]);
  });
});

describe("submodules", () => {
  test("parseGitmodules reads the paths and drops any that leave the repo", () => {
    const text =
      '[submodule "a"]\n  path = services/a/\n  url = u\n[submodule "b"]\npath=b\n[submodule "x"]\n  path = ../out\n  path = .\n';
    expect(parseGitmodules(text)).toEqual(["services/a", "b"]);
  });

  test("withSubmodules keeps top repos and the submodules they list, down the chain", () => {
    const dirs = [
      "/d/homelab",
      "/d/homelab/services/gate",
      "/d/homelab/services/gate/inner",
      "/d/homelab/vendor/plain",
      "/d/other",
    ];
    const modules = new Map([
      ["/d/homelab", ["services/gate", "services/missing"]],
      ["/d/homelab/services/gate", ["inner"]],
    ]);
    expect(withSubmodules(dirs, modules)).toEqual([
      "/d/homelab",
      "/d/homelab/services/gate",
      "/d/homelab/services/gate/inner",
      "/d/other",
    ]);
  });

  test("the cat line's output parses back into repo dir to paths", () => {
    const cmd = catCommand(["/d/homelab/.gitmodules"]);
    expect(cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(cmd.slice(-1)).toEqual(["/d/homelab/.gitmodules"]);
    const dump = "/d/homelab/.gitmodules\0[submodule \"g\"]\n\tpath = services/gate\n\0/d/x/.gitmodules\0\0";
    const m = parseModuleDump(dump);
    expect(m.get("/d/homelab")).toEqual(["services/gate"]);
    expect(m.get("/d/x")).toEqual([]);
  });

  test("the cat line really prints path\\0contents\\0", async () => {
    const r = await exec(catCommand([join(root, "b/deep/repo3/mods/one/.gitmodules")]));
    expect(r.code).toBe(0);
    const m = parseModuleDump(r.stdout);
    expect(m.get(join(root, "b/deep/repo3/mods/one"))).toEqual(["inner"]);
  });
});

describe("remote find", () => {
  test("the find mirrors the walk: .git down to the depth, hidden and ignored pruned", () => {
    const cmd = findCommand("/home/me/dev", { maxDepth: 2, ignore: ["node_modules"] });
    expect(cmd.slice(0, 3)).toEqual(["find", "-L", "/home/me/dev"]);
    expect(cmd.slice(cmd.indexOf("-maxdepth"), cmd.indexOf("-maxdepth") + 2)).toEqual([
      "-maxdepth",
      "3",
    ]);
    expect(cmd).toContain("-print0");
    expect(cmd).toContain(".gitmodules");
    expect(cmd.slice(-10)).toEqual([
      "(",
      "(",
      "-name",
      ".*",
      "-o",
      "-name",
      "node_modules",
      ")",
      "-prune",
      ")",
    ]);
  });

  test("a repo inside a repo counts once, like the local walk", () => {
    expect(
      pruneNested(["/d/a/repo1/sub", "/d/a/repo1", "/d/b/repo2", "/d/a/repo1", "/d/a/repo10"]),
    ).toEqual(["/d/a/repo1", "/d/a/repo10", "/d/b/repo2"]);
  });
});

describe("source ids and groups", () => {
  const extra: Source = {
    id: "wsl-dev",
    kind: "ssh",
    host: "wsl",
    path: "/home/me/dev",
    label: "wsl:dev",
    launch: false,
  };
  const launch = launchSource("/Users/me/dev");

  test("launch root repos keep bare ids; extra sources prefix theirs", () => {
    expect(sourceRepoId(launch, "web-apps/ripe")).toBe("web-apps/ripe");
    expect(sourceRepoId(extra, "web-apps/ripe")).toBe("wsl-dev:web-apps/ripe");
    expect(sourceRepoId(extra, ".")).toBe("wsl-dev:.");
  });

  test("the relative path comes back out of the id", () => {
    expect(repoRel({ id: "web-apps/ripe", source: "launch" })).toBe("web-apps/ripe");
    expect(repoRel({ id: "wsl-dev:web-apps/ripe", source: "wsl-dev" })).toBe("web-apps/ripe");
    expect(repoRel({ id: "wsl-dev:.", source: "wsl-dev" })).toBe(".");
  });

  test("groups: the top folder here, the label then the folder elsewhere", () => {
    expect(sourceGroup(launch, "web-apps/ripe")).toBe("web-apps");
    expect(sourceGroup(launch, ".")).toBe("");
    expect(sourceGroup(extra, "web-apps/ripe")).toBe("wsl:dev/web-apps");
    expect(sourceGroup(extra, "ripe")).toBe("wsl:dev/ripe");
    expect(sourceGroup(extra, ".")).toBe("wsl:dev");
  });

  test("a local extra source scans like the launch root, with prefixed ids", async () => {
    const src: Source = { id: "extra", kind: "local", path: root, label: "extra", launch: false };
    const repos = await scanSource(src, { maxDepth: 2 });
    expect(repos.map((r) => r.id)).toEqual(["extra:a/repo1", "extra:a/repo2"]);
    expect(repos.every((r) => r.source === "extra" && r.host === undefined)).toBe(true);
    expect(repos[0]?.group).toBe("extra/a");
  });
});

describe("scan + real git round trip", () => {
  test("status, stage, commit against a real repo", async () => {
    const repo = join(root, "a/repo1");
    await exec(["git", "init", "-q", "-b", "main"], { cwd: repo });
    await exec(["git", "config", "user.email", "t@t"], { cwd: repo });
    await exec(["git", "config", "user.name", "t"], { cwd: repo });
    await writeFile(join(repo, "hello.txt"), "hi\n");

    let st = await getStatus(repo);
    expect(st.branch).toBe("main");
    expect(st.files).toHaveLength(1);
    expect(st.files[0]?.untracked).toBe(true);

    await stageFile(repo, "hello.txt", false);
    st = await getStatus(repo);
    expect(st.files[0]?.index).toBe("A");

    await commit(repo, "add hello");
    st = await getStatus(repo);
    expect(st.files).toHaveLength(0);
    expect(st.lastCommit?.subject).toBe("add hello");

    const result = await scan(root);
    const r1 = result.repos.find((r) => r.id === "a/repo1");
    expect(r1?.status?.lastCommit?.subject).toBe("add hello");
    expect(r1?.group).toBe("a");
    // fake .git dirs yield an error, not a crash
    const r2 = result.repos.find((r) => r.id === "a/repo2");
    expect(r2?.status).toBeNull();
    expect(r2?.error).toBeTruthy();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.launch).toBe(true);
    expect(result.sources[0]?.repos).toBe(result.repos.length);
    expect(result.repos.every((r) => r.source === "launch")).toBe(true);
  });
});
