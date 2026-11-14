import { describe, expect, test } from "bun:test";
import { runsInTrees } from "./treewords";
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
});
