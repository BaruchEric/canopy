import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { commit, getStatus, stageFile } from "./git";
import { findRepoDirs, repoId, scan } from "./scan";

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
  });
});
