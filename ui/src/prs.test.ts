import { describe, expect, test } from "bun:test";
import type { PrState, PrWatch, Run } from "../../src/core/types";
import { ciChip, mergePrs, mergeWhy, prLine, prOfRun, prWord, repoPrChip } from "./prs";

const state = (over: Partial<PrState> = {}): PrState => ({
  number: 12,
  url: "https://github.com/o/r/pull/12",
  status: "open",
  draft: false,
  additions: 40,
  deletions: 12,
  files: 3,
  head: "h1",
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  review: "none",
  checks: [{ name: "test", state: "pass" }],
  ...over,
});

const watch = (over: Partial<PrWatch> = {}): PrWatch => ({
  id: "mini:b1",
  runId: "mini:b1",
  repoId: "mini:r",
  repoPath: "/r",
  branch: "run/x-b1",
  target: "main",
  dir: "/w",
  note: "n",
  slug: "o/r",
  remote: "origin",
  number: 12,
  url: "https://github.com/o/r/pull/12",
  autoFix: false,
  autoMerge: false,
  pushed: "h1",
  attempts: {},
  seenComment: 0,
  openedAt: 1,
  updatedAt: 1,
  ...over,
});

describe("prs", () => {
  test("mergePrs flattens every backend's list, newest first", () => {
    expect(mergePrs({ a: [watch({ id: "a:1", openedAt: 1 })], b: [watch({ id: "b:2", openedAt: 5 })] }).map((w) => w.id)).toEqual(["b:2", "a:1"]);
  });

  test("prOfRun finds the PR by the run's branch", () => {
    const run = { branch: { origin: "mini:b1" } } as unknown as Run;
    expect(prOfRun(run, [watch()])?.number).toBe(12);
    expect(prOfRun({} as Run, [watch()])).toBeUndefined();
  });

  test("prLine and prWord", () => {
    expect(prLine(watch({ state: state() }))).toBe("#12 · +40 −12 · 3 files");
    expect(prLine(watch({ state: state({ files: 1 }) }))).toBe("#12 · +40 −12 · 1 file");
    expect(prLine(watch())).toBe("#12");
    expect(prWord(watch())).toBe("PR #12, not read yet");
    expect(prWord(watch({ state: state() }))).toBe("PR #12 open");
    expect(prWord(watch({ state: state({ draft: true }) }))).toBe("PR #12, a draft");
    expect(prWord(watch({ state: state({ status: "merged" }) }))).toBe("PR #12 merged");
  });

  test("ciChip: the words and a tone", () => {
    expect(ciChip(watch())).toBeNull();
    expect(ciChip(watch({ state: state() }))).toEqual({ text: "checks passed", tone: "moss" });
    expect(ciChip(watch({ state: state({ checks: [{ name: "a", state: "pending" }] }) }))).toEqual({ text: "checks: 1 running", tone: "sky" });
    expect(ciChip(watch({ state: state({ checks: [{ name: "a", state: "fail" }] }) }))).toEqual({ text: "checks: 1 failed", tone: "rust" });
    expect(ciChip(watch({ state: state({ checks: [] }) }))).toEqual({ text: "no checks", tone: "lichen" });
  });

  test("mergeWhy says what auto-merge waits on, only while it is on", () => {
    expect(mergeWhy(watch({ state: state() }))).toBeNull();
    expect(mergeWhy(watch({ autoMerge: true, state: state({ checks: [{ name: "e2e", state: "pending" }] }) }))).toBe("auto-merge waits: waiting on e2e");
    expect(mergeWhy(watch({ autoMerge: true, state: state() }))).toBe("auto-merge: merging on the next read");
    expect(mergeWhy(watch({ autoMerge: true, state: state({ status: "merged" }) }))).toBeNull();
  });
});

describe("the card chip", () => {
  test("nothing without an open PR; one PR says its checks, several say how many are red", () => {
    expect(repoPrChip([watch({ state: state({ status: "merged" }) })], "mini:r")).toBeNull();
    expect(repoPrChip([watch()], "other")).toBeNull();
    expect(repoPrChip([watch({ state: state() })], "mini:r")).toMatchObject({ text: "PR #12 · checks passed", tone: "moss", runId: "mini:b1" });
    const red = watch({ id: "mini:b2", runId: "mini:r2", number: 13, state: state({ number: 13, checks: [{ name: "test", state: "fail" }] }) });
    expect(repoPrChip([watch({ state: state() }), red], "mini:r")).toMatchObject({ text: "2 PRs · 1 red", tone: "rust", runId: "mini:r2" });
  });

  test("a PR not read yet still counts as open", () => {
    expect(repoPrChip([watch()], "mini:r")).toMatchObject({ text: "PR #12", tone: "lichen" });
  });
});
