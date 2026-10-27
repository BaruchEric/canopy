import { expect, test } from "bun:test";
import type { PrState, PrWatch } from "../core/types";
import type { ask, Target } from "./health";
import { PR_USAGE, prCommand, prsLines } from "./pr";

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

const lines: string[] = [];
/** runs `fn` with console.log captured */
const logging = async (fn: () => Promise<void>): Promise<string[]> => {
  lines.length = 0;
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return [...lines];
};
const fail = (msg: string): never => {
  throw new Error(msg);
};

test("canopy pr rebase posts the run and prints the branch, target and new head", async () => {
  const calls: [string, string, unknown][] = [];
  const askFake: typeof ask = async <T,>(_t: Target, method: string, path: string, body?: unknown): Promise<T> => {
    calls.push([method, path, body]);
    return watch({ pushed: "h2h2h2h2h2h2h2h2h2h2" }) as T;
  };
  expect(await logging(() => prCommand("pr", ["rebase", "b1"], { fail, ask: askFake }))).toEqual(["run/x-b1: rebased onto main and pushed (h2h2h2h)"]);
  expect(calls).toEqual([["POST", "/api/prs/rebase", { run: "b1" }]]);
  await expect(prCommand("pr", ["rebase"], { fail, ask: askFake })).rejects.toThrow(PR_USAGE);
  // the backend's refusal is the failure
  const refused: typeof ask = async <T,>(): Promise<T> => {
    throw new Error("the head moved since canopy pushed");
  };
  await expect(prCommand("pr", ["rebase", "b1"], { fail, ask: refused })).rejects.toThrow("the head moved since canopy pushed");
  // the step ran and stopped: what stopped it is the failure
  const stopped: typeof ask = async <T,>(): Promise<T> => watch({ gaveUp: "the branch moved on GitHub since canopy pushed; rebase it yourself" }) as T;
  await expect(prCommand("pr", ["rebase", "b1"], { fail, ask: stopped })).rejects.toThrow("run/x-b1: the branch moved on GitHub since canopy pushed; rebase it yourself");
  // a conflict started a fix run
  const conflict: typeof ask = async <T,>(): Promise<T> => watch({ fixing: { run: "f9", key: "rebase:abc" } }) as T;
  expect(await logging(() => prCommand("pr", ["rebase", "b1"], { fail, ask: conflict }))).toEqual(["run/x-b1: rebasing onto main stopped on conflicts; fix run f9 is on them"]);
});

test("the usage names rebase", () => {
  expect(PR_USAGE).toContain("canopy pr rebase <run> [--backend URL]");
});
