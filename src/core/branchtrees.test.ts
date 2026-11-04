import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { repoKey } from "./worktree";
import {
  addBranchTree,
  branchExists,
  branchHash,
  copyArgs,
  copyIgnored,
  dressTreeCards,
  EMPTY_TREES,
  ignoredEntries,
  isBranchName,
  listTreeDirs,
  parseTreesRecord,
  removeBranchTree,
  removeRefusal,
  SLUG_MAX,
  squashMessage,
  treeDir,
  treePort,
  treePorts,
  treePortsFor,
  TREES_RECORD,
  treeSlug,
  treesSource,
  treeStatus,
  treeWords,
} from "./branchtrees";
import { cleanable } from "./treewords";

let root = "";
let n = 0;
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (cwd: string, name: string, body: string): Promise<string> => {
  await mkdir(join(cwd, name, ".."), { recursive: true });
  await writeFile(join(cwd, name), body);
  await sh(cwd, "add", "-A");
  await sh(cwd, "commit", "-q", "-m", `c ${name}`);
  return sh(cwd, "rev-parse", "HEAD");
};
/** a repo on main with one commit, identity set */
const repo = async (): Promise<string> => {
  const dir = join(root, `r${++n}`);
  await exec(["git", "init", "-q", "-b", "main", dir]);
  await sh(dir, "config", "user.email", "t@t");
  await sh(dir, "config", "user.name", "t");
  await commit(dir, "a.txt", "one\n");
  return dir;
};
const trees = (): string => join(root, `t${n}`);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-bt-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("names", () => {
  test("a slug is the branch made safe for a folder", () => {
    expect(treeSlug("feat/Login Page")).toBe("feat-login-page");
    expect(treeSlug("fix_1.2")).toBe("fix_1.2");
    expect(treeSlug("--lead--")).toBe("lead");
    expect(treeSlug("x".repeat(60))).toHaveLength(SLUG_MAX);
    expect(treeSlug("a".repeat(47) + "-b")).toBe("a".repeat(47));
  });
  test("a slug that would be the record, or empty, is refused", () => {
    expect(treeSlug(TREES_RECORD)).toBe("");
    expect(treeSlug("///")).toBe("");
    expect(treeSlug("a..b")).toBe("");
  });
  test("branch names follow git's rules", () => {
    for (const ok of ["feat/x", "fix-1", "a.b", "v1.2.3", "user/topic/deep"]) expect(isBranchName(ok)).toBe(true);
    for (const bad of ["", "-x", "a b", "a..b", "a/", ".a", "a.lock", "a~", "@", "a/.b", "a//b", "a@{1}", "a:b", "a?", "a*", "a[b", "a\\b", "a."]) {
      expect(isBranchName(bad)).toBe(false);
    }
  });
  test("a tree's folder is the slug under the repo key", () => {
    expect(treeDir("/x/canopy", "feat", "/t")).toMatch(/^\/t\/canopy-[0-9a-f]{8}\/feat$/);
  });
});

describe("ports", () => {
  test("the range comes from the spec, with the task range as the default", () => {
    expect(treePorts(undefined)).toEqual(Array.from({ length: 50 }, (_, i) => 7900 + i));
    expect(treePorts("8000-8002")).toEqual([8000, 8001, 8002]);
    expect(treePorts("off")).toEqual([]);
  });
  test("the hash is stable and spreads", () => {
    expect(branchHash("feat")).toBe(branchHash("feat"));
    expect(branchHash("feat")).not.toBe(branchHash("feat2"));
  });
  test("a branch lands on its hashed port and walks past taken ones", () => {
    const ports = [7900, 7901, 7902, 7903];
    const first = treePort("feat", ports, new Set());
    if (first === null) throw new Error("no port");
    const next = treePort("feat", ports, new Set([first]));
    expect(next).toBe(ports[(ports.indexOf(first) + 1) % ports.length] ?? null);
    expect(treePort("feat", ports, new Set(ports))).toBeNull();
    expect(treePort("feat", [], new Set())).toBeNull();
  });
  test("several ports for one key are all free and all different, or none", () => {
    const ports = [7900, 7901, 7902];
    const got = treePortsFor("feat", 2, ports, new Set([7901]));
    expect(got).toHaveLength(2);
    expect(new Set(got).size).toBe(2);
    expect(got).not.toContain(7901);
    expect(treePortsFor("feat", 3, ports, new Set([7901]))).toBeNull();
    expect(treePortsFor("feat", 0, ports, new Set())).toEqual([]);
  });
});

describe("the record", () => {
  test("junk reads as empty and bad entries are dropped", () => {
    expect(parseTreesRecord("not json")).toEqual(EMPTY_TREES);
    expect(parseTreesRecord("[]")).toEqual(EMPTY_TREES);
    expect(parseTreesRecord(JSON.stringify({ trees: [{ slug: "a" }, 3, { branch: "b" }] }))).toEqual(EMPTY_TREES);
  });
  test("an entry keeps its fields, defaults the rest, and why only when failed", () => {
    const rec = parseTreesRecord(
      JSON.stringify({
        trees: [
          { slug: "feat", branch: "feat", base: "main", port: 7912, madeAt: 5, caches: false, state: "failed", why: "bun install exited 1" },
          { slug: "x", branch: "x", why: "stale", state: "ready" },
          { slug: "y", branch: "y", state: "bogus", port: "no", sync: false },
        ],
      }),
    );
    expect(rec.trees).toEqual([
      { slug: "feat", branch: "feat", base: "main", port: 7912, madeAt: 5, caches: false, state: "failed", why: "bun install exited 1", sync: true },
      { slug: "x", branch: "x", base: "", port: null, madeAt: 0, caches: true, state: "ready", sync: true },
      { slug: "y", branch: "y", base: "", port: null, madeAt: 0, caches: true, state: "ready", sync: false },
    ]);
  });
});

describe("making and reading a tree", () => {
  test("a new branch is made at the base, an existing one is checked out", async () => {
    const r = await repo();
    const dir = treeDir(r, "feat", trees());
    expect(await addBranchTree(r, dir, "feat", "main")).toBe("new");
    expect(await branchExists(r, "feat")).toBe(true);
    expect(await sh(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
    await sh(r, "branch", "other");
    const dir2 = treeDir(r, "other", trees());
    expect(await addBranchTree(r, dir2, "other", "main")).toBe("existing");
    expect(await sh(dir2, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other");
    expect(await listTreeDirs(r, trees())).toEqual([dir, dir2]);
  });
  test("a branch checked out elsewhere is refused in git's words", async () => {
    const r = await repo();
    await expect(addBranchTree(r, treeDir(r, "main", trees()), "main", "main")).rejects.toThrow(/already (checked out|used by worktree)/);
  });
  test("status counts ahead, behind and changed files against the base", async () => {
    const r = await repo();
    const dir = treeDir(r, "feat", trees());
    await addBranchTree(r, dir, "feat", "main");
    const fresh = await treeStatus(dir, "main");
    expect(fresh).toMatchObject({ ahead: 0, behind: 0, files: 0 });
    expect(fresh.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(fresh.at).toBeGreaterThan(0);
    await commit(dir, "b.txt", "two\n");
    await commit(r, "c.txt", "three\n");
    await writeFile(join(dir, "d.txt"), "dirty\n");
    expect(await treeStatus(dir, "main")).toMatchObject({ ahead: 1, behind: 1, files: 1 });
    expect(await treeStatus(dir, "")).toMatchObject({ ahead: 0, behind: 0, files: 1 });
  });
  test("removal takes the folder, and the branch only when asked", async () => {
    const r = await repo();
    const dir = treeDir(r, "feat", trees());
    await addBranchTree(r, dir, "feat", "main");
    await removeBranchTree(r, dir, "feat", false);
    expect(existsSync(dir)).toBe(false);
    expect(await branchExists(r, "feat")).toBe(true);
    const dir2 = treeDir(r, "gone", trees());
    await addBranchTree(r, dir2, "gone", "main");
    await removeBranchTree(r, dir2, "gone", true);
    expect(await branchExists(r, "gone")).toBe(false);
    expect(await listTreeDirs(r, trees())).toEqual([]);
  });
});

describe("caches", () => {
  test("ignored entries are the main checkout's ignored folders and files, git's own aside", async () => {
    const r = await repo();
    await commit(r, ".gitignore", "node_modules/\n.env\ndist/\n");
    await mkdir(join(r, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(r, "node_modules", "pkg", "index.js"), "1");
    await mkdir(join(r, "ui", "node_modules"), { recursive: true });
    await writeFile(join(r, "ui", "node_modules", "x.js"), "2");
    await writeFile(join(r, ".env"), "SECRET=1\n");
    await writeFile(join(r, "ui", "kept.ts"), "tracked? no, untracked\n");
    expect((await ignoredEntries(r)).sort()).toEqual([".env", "node_modules", "ui/node_modules"]);
  });
  test("copy args clone where the platform can", () => {
    expect(copyArgs("darwin", "/a", "/b")).toEqual(["cp", "-R", "-c", "/a", "/b"]);
    expect(copyArgs("linux", "/a", "/b")).toEqual(["cp", "-R", "--reflink=auto", "/a", "/b"]);
    expect(copyArgs("win32", "/a", "/b")).toEqual(["cp", "-R", "/a", "/b"]);
  });
  test("the entries land at the same paths in the tree, and a second pass keeps what is there", async () => {
    const r = await repo();
    await commit(r, ".gitignore", "node_modules/\n.env\n");
    // a tracked file beside it, else git lists the whole of ui/ as one ignored folder
    await commit(r, "ui/app.ts", "export {};\n");
    await mkdir(join(r, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(r, "node_modules", "pkg", "index.js"), "1");
    await mkdir(join(r, "ui", "node_modules"), { recursive: true });
    await writeFile(join(r, "ui", "node_modules", "x.js"), "2");
    await writeFile(join(r, ".env"), "SECRET=1\n");
    const dir = treeDir(r, "feat", trees());
    await addBranchTree(r, dir, "feat", "main");
    const entries = await ignoredEntries(r);
    const first = await copyIgnored(r, dir, entries);
    expect(first.copied.sort()).toEqual([".env", "node_modules", "ui/node_modules"]);
    expect(first.failed).toEqual([]);
    expect(await readFile(join(dir, "node_modules", "pkg", "index.js"), "utf8")).toBe("1");
    expect(await readFile(join(dir, "ui", "node_modules", "x.js"), "utf8")).toBe("2");
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
    // the copies are the tree's own: git still sees them as ignored, not as changes
    expect((await treeStatus(dir, "main")).files).toBe(0);
    const again = await copyIgnored(r, dir, [...entries, "missing"]);
    expect(again).toEqual({ copied: [], kept: entries, failed: [] });
  });
});

describe("words", () => {
  test("removal is refused for what would be lost", () => {
    expect(removeRefusal({ files: 0, ahead: 0, shells: 0 })).toBeNull();
    expect(removeRefusal({ files: 2, ahead: 1, shells: 1 })).toBe("the tree holds 2 changed files, 1 commit its base lacks, 1 shell open in it; remove it with force to lose that");
  });
  test("a tree's words", () => {
    expect(treeWords({ ahead: 0, behind: 0, files: 0, port: 7912, state: "ready", shells: 0 })).toBe("clean :7912");
    expect(treeWords({ ahead: 2, behind: 1, files: 3, port: null, state: "ready", shells: 2 })).toBe("↑2 ↓1 ●3 2 shells");
    expect(treeWords({ ahead: 0, behind: 0, files: 0, port: 7900, state: "preparing", shells: 0 })).toBe("preparing :7900");
    expect(treeWords({ ahead: 0, behind: 0, files: 0, port: 7900, state: "failed", why: "a\nbun install exited 1", shells: 0 })).toBe("setup failed: bun install exited 1 :7900");
    expect(treeWords({ ahead: 1, behind: 0, files: 0, port: 7900, state: "merging", shells: 0 })).toBe("merging ↑1 :7900");
    expect(treeWords({ ahead: 1, behind: 0, files: 0, port: null, state: "ready", stopped: "merge stopped: gate test exited 1\nnope", shells: 0 })).toBe("merge stopped: gate test exited 1 ↑1");
    expect(treeWords({ ahead: 0, behind: 2, files: 0, port: null, state: "ready", stopped: "sync stopped: the rebase onto main stopped on a.txt and was aborted; rebase by hand in the tree", sync: false, shells: 0 })).toBe("sync stopped: the rebase onto main stopped on a.txt and was aborted; rebase by hand in the tree ↓2 sync off");
  });
  test("clean-up takes a ready tree its base holds whole, with nothing changed or open", () => {
    expect(cleanable({ state: "ready", files: 0, ahead: 0, shells: 0 })).toBe(true);
    expect(cleanable({ state: "ready", files: 0, ahead: 1, shells: 0 })).toBe(false);
    expect(cleanable({ state: "ready", files: 1, ahead: 0, shells: 0 })).toBe(false);
    expect(cleanable({ state: "ready", files: 0, ahead: 0, shells: 1 })).toBe(false);
    expect(cleanable({ state: "failed", files: 0, ahead: 0, shells: 0 })).toBe(false);
    expect(cleanable({ state: "merging", files: 0, ahead: 0, shells: 0 })).toBe(false);
  });
  test("the squash message is the first subject with the rest listed, or the branch", () => {
    expect(squashMessage([], "feat/x")).toBe("feat/x");
    expect(squashMessage(["add login"], "feat/x")).toBe("add login");
    expect(squashMessage(["add login", "fix typo", "tests"], "feat/x")).toBe("add login\n\n- fix typo\n- tests");
  });
});

test("dressTreeCards names a scanned tree after its checkout and branch and files it beside it", () => {
  const root = "/t";
  const main = { id: "dev-tools/canopy", name: "canopy", path: "/dev/dev-tools/canopy", group: "dev-tools", source: "launch", status: null };
  const key = repoKey(main.path);
  const scanned = (slug: string) => ({ id: `trees:${key}/${slug}`, name: slug, path: `/t/${key}/${slug}`, group: `worktrees/${key}`, source: "trees", status: null });
  const records = new Map([[main.path, { trees: [{ slug: "feat-x", branch: "feat/x", base: "main", port: 7912, madeAt: 0, caches: true, state: "ready" as const , sync: true }] }]]);
  const [known, stray] = dressTreeCards([scanned("feat-x"), scanned("stray")], [main], records, root);
  expect(known).toMatchObject({ name: "canopy ⑂ feat/x", group: "dev-tools", id: `trees:${key}/feat-x` });
  expect(stray).toMatchObject({ name: "stray", group: `worktrees/${key}` });
  // the checkout gone from the board: the tree still names it by its folder
  expect(dressTreeCards([scanned("feat-x")], [], records, root)[0]?.name).toBe("canopy ⑂ feat/x");
  expect(treesSource("/t")).toEqual({ id: "trees", kind: "local", path: "/t", label: "worktrees", launch: false });
});
