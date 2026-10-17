import { expect, test } from "bun:test";
import type { PrState, PrWatch } from "../core/types";
import { prsLines } from "./pr";

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
  id: "b1",
  runId: "r1",
  repoId: "dev-tools/canopy",
  repoPath: "/dev/dev-tools/canopy",
  branch: "run/x-b1",
  target: "main",
  dir: "/w/b1",
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

test("each repo's PRs: number, where it stands, its checks, the toggles and what needs a look", () => {
  const prs = [
    watch({ state: state() }),
    watch({ id: "b2", number: 13, branch: "run/x-b2", autoFix: true, autoMerge: true, gaveUp: "test failed 3 times", state: state({ number: 13, checks: [{ name: "test", state: "fail" }] }) }),
    watch({ id: "b3", number: 14, branch: "run/x-b3", state: state({ number: 14, status: "merged" }) }),
    watch({ id: "b4", repoId: "web-apps/tally", repoPath: "/dev/web-apps/tally", number: 3, branch: "run/x-b4" }),
  ];
  expect(prsLines(prs, null)).toEqual([
    "dev-tools/canopy",
    "  #12  open     checks passed       run/x-b1  https://github.com/o/r/pull/12",
    "  #13  open     checks: 1 failed    run/x-b2  auto-fix, auto-merge  https://github.com/o/r/pull/12",
    "       auto-fix gave up: test failed 3 times",
    "  #14  merged   checks passed       run/x-b3  https://github.com/o/r/pull/12",
    "web-apps/tally",
    "  #3   not read                     run/x-b4  https://github.com/o/r/pull/12",
  ]);
  expect(prsLines(prs, "tally", "mini")[0]).toBe("web-apps/tally on mini");
  expect(prsLines(prs, "other")).toEqual([]);
});
