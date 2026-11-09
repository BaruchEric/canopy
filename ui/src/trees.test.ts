import { expect, test } from "bun:test";
import type { BranchTree } from "../../src/core/types";
import { repoTrees, treeAge, treeLines, treeRow, treesChip, treesHead } from "./trees";

const H = 3_600_000;
const tree = (over: Partial<BranchTree> = {}): BranchTree => ({
  slug: "feat",
  dir: "/t/canopy-abc/feat",
  branch: "feat",
  base: "main",
  port: 7912,
  madeAt: 0,
  caches: true,
  state: "ready",
  sync: true,
  head: "abc1234",
  ahead: 0,
  behind: 0,
  files: 0,
  at: 1000 - 2 * H,
  shells: 0,
  ...over,
});

test("a repo's trees come out of whichever backend lists it", () => {
  const info = { root: "/t", ports: "7900-7949", repos: [{ repoId: "b|x", repoPath: "/x", trees: [tree()] }] };
  expect(repoTrees({ a: { root: "/t", ports: "", repos: [] }, b: info }, "b|x")?.trees).toHaveLength(1);
  expect(repoTrees({ b: info }, "b|y")).toBeUndefined();
});

test("age words", () => {
  expect(treeAge(undefined, 1000)).toBe("");
  expect(treeAge(1000 - 5 * 60_000, 1000)).toBe("5m");
  expect(treeAge(1000 - 3 * H, 1000)).toBe("3h");
  expect(treeAge(1000 - 50 * H, 1000)).toBe("2d");
});

test("a row's words, age and tone", () => {
  expect(treeRow(tree(), 1000)).toEqual({ words: "clean :7912", age: "2h", tone: "" });
  expect(treeRow(tree({ ahead: 2, files: 1, shells: 1, state: "preparing" }), 1000)).toEqual({ words: "preparing ↑2 ●1 :7912 1 shell", age: "2h", tone: "lichen" });
  expect(treeRow(tree({ state: "failed", why: "bun install exited 1", at: undefined }), 1000)).toEqual({ words: "setup failed: bun install exited 1 :7912", age: "", tone: "rust" });
  // held, not broken: a tree whose following waits on what runs in it
  expect(treeRow(tree({ behind: 1, waiting: "bun test" }), 1000)).toEqual({ words: "sync waits on bun test ↓1 :7912", age: "2h", tone: "lichen" });
});

test("the head counts the trees and the ones not ready", () => {
  expect(treesHead([])).toBe("none kept");
  expect(treesHead([tree()])).toBe("1 tree");
  expect(treesHead([tree(), tree({ slug: "b", state: "preparing" }), tree({ slug: "c", state: "failed" })])).toBe("3 trees, 1 preparing, 1 failed");
  expect(treesHead([tree({ stopped: "merge stopped: gate x exited 1" }), tree({ slug: "b", stopped: "sync stopped: the rebase onto main stopped on a.txt and was aborted" })])).toBe("2 trees, 1 merge stopped, 1 sync stopped");
});

test("the chip names each tree and turns rust on a failure", () => {
  expect(treesChip(undefined)).toBeNull();
  expect(treesChip([])).toBeNull();
  expect(treesChip([tree(), tree({ slug: "fix", branch: "fix/x", files: 3, port: null })])).toEqual({
    text: "⑂ 2 trees",
    title: "feat  clean :7912\nfix/x  ●3",
    tone: "",
  });
  expect(treesChip([tree({ state: "failed" })])?.tone).toBe("rust");
  expect(treesChip([tree()])?.text).toBe("⑂ 1 tree");
});

test("the copy text has a line per tree with its folder", () => {
  expect(treeLines([tree()])).toBe("feat  clean :7912  /t/canopy-abc/feat");
});
