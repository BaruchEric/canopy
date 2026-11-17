import { describe, expect, test } from "bun:test";
import { isTreeCard, runsInTrees } from "./treewords";
import type { Run } from "./types";

const run = (over: Partial<Run>): Run => ({
  id: "c1",
  repoId: "trees:web/feat-x",
  action: "ask",
  verb: "ask",
  progress: "",
  expectsChange: false,
  chat: false,
  harness: "claude",
  note: "n",
  status: "working",
  startedAt: 1,
  steps: [],
  prompt: null,
  ...over,
});

describe("runsInTrees", () => {
  test("names each tree dir an active in-place run works in", () => {
    const dirs = ["/c/trees/web/feat-x"];
    const pathOf = (id: string): string | undefined => (id === "trees:web/feat-x" ? "/c/trees/web/feat-x" : id === "web" ? "/r/web" : undefined);
    const branch = { name: "run/b", target: "main", base: "abc", dir: "/tmp/w", state: "working" as const, origin: "ab12cd34" };
    const runs = [
      run({ id: "c1" }),
      run({ id: "c2", status: "done" }),
      run({ id: "c3", branch }),
      run({ id: "c4", repoId: "web" }),
    ];
    expect(runsInTrees(dirs, runs, pathOf)).toEqual(new Map([["/c/trees/web/feat-x", "run c1 (ask)"]]));
  });
  test("a coordinator started at a tree card works in no tree: it holds nothing there", () => {
    const dirs = ["/c/trees/web/feat-x"];
    const pathOf = (id: string): string | undefined => (id === "trees:web/feat-x" ? "/c/trees/web/feat-x" : undefined);
    expect(runsInTrees(dirs, [run({ id: "k1", action: "coordinate", verb: "coordinate" })], pathOf)).toEqual(new Map());
    // a run in place beside it still holds the tree
    expect(runsInTrees(dirs, [run({ id: "k1", action: "coordinate", verb: "coordinate" }), run({ id: "c1" })], pathOf)).toEqual(new Map([["/c/trees/web/feat-x", "run c1 (ask)"]]));
  });
});

describe("isTreeCard", () => {
  test("a tree's card reads as one under its backend's name too, as the page holds it", () => {
    expect(isTreeCard({ source: "trees" })).toBe(true);
    expect(isTreeCard({ source: "mini|trees" })).toBe(true);
    expect(isTreeCard({ source: "home" })).toBe(false);
    expect(isTreeCard({ source: "mini|home" })).toBe(false);
    expect(isTreeCard({ source: "mytrees" })).toBe(false);
    expect(isTreeCard({})).toBe(false);
  });
});
