import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { commit, getStatus, stageFile } from "./git";
import {
  findCommand,
  findRepoDirs,
  launchSource,
  pruneNested,
  repoId,
  repoRel,
  scan,
  scanSource,
  sourceGroup,
  sourceRepoId,
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
  // plain folder, no repo
  await mkdir(join(root, "c/empty"), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findRepoDirs", () => {
  test("finds repos, skips ignored dirs, stops at repo roots", async () => {
    const dirs = await findRepoDirs(root);
    const rels = dirs.map((d) => repoId(root, d));
    expect(rels).toEqual(["a/repo1", "a/repo2", "b/deep/repo3"]);
  });

  test("respects maxDepth", async () => {
    const dirs = await findRepoDirs(root, { maxDepth: 2 });
    const rels = dirs.map((d) => repoId(root, d));
    expect(rels).toEqual(["a/repo1", "a/repo2"]);
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
