import { describe, expect, test } from "bun:test";
import type { WorktreeRepoInfo, WorktreesInfo } from "./types";
import {
  EMPTY_RECORD,
  WARM_AGE,
  WARM_BEHIND,
  WARM_FAILS,
  WARM_MAX,
  WARM_RETRY,
  WORKTREE_DISK_MIN,
  isWarmName,
  nextRefill,
  overWant,
  parseWarmRecord,
  reconcile,
  sameStamp,
  staleWhy,
  warmName,
  worktreesProbe,
  type RefillInput,
  type WarmTree,
} from "./warm";

const dirOf = (n: number) => `/w/k/warm-${n}`;
const tree = (n: number, over: Partial<WarmTree> = {}): WarmTree => ({
  dir: dirOf(n),
  base: "b0",
  lockfile: { name: "bun.lock", size: 10, mtime: 1 },
  madeAt: 1000,
  size: 2048,
  ...over,
});
const input = (over: Partial<RefillInput> = {}): RefillInput => ({
  want: 1,
  record: EMPTY_RECORD,
  now: 1000,
  refilling: false,
  busy: false,
  free: WORKTREE_DISK_MIN,
  stale: () => null,
  dirOf,
  ...over,
});

test("slot names identify warm folders and stop at the configured count", () => {
  expect(WARM_MAX).toBe(2);
  expect(warmName(1)).toBe("warm-1");
  expect([isWarmName("warm-1"), isWarmName("warm-12"), isWarmName("warm-0"), isWarmName("ab12cd34"), isWarmName("warm-")]).toEqual([true, true, false, false, false]);
  expect(nextRefill(input({ want: WARM_MAX + 1 }))).toBeNull();
});

test("sameStamp compares lockfile identity and handles a missing lockfile", () => {
  const stamp = { name: "bun.lock", size: 10, mtime: 1 };
  expect(sameStamp(stamp, { ...stamp })).toBe(true);
  expect(sameStamp(stamp, { ...stamp, mtime: 2 })).toBe(false);
  expect(sameStamp(null, null)).toBe(true);
  expect(sameStamp(stamp, null)).toBe(false);
});

test("staleWhy uses the commit threshold before whole-hour age", () => {
  expect(staleWhy(tree(1), 1000, 0)).toBeNull();
  expect(staleWhy(tree(1), 1000 + WARM_AGE + 3_599_999, WARM_BEHIND - 1)).toBe("24h old");
  expect(staleWhy(tree(1), 1000, WARM_BEHIND)).toBe("20 commits behind");
  expect(staleWhy(tree(1), 1000 + WARM_AGE + 3_600_000, 0)).toBe("25h old");
});

describe("nextRefill", () => {
  test("fills the lowest empty slot before replacing stale trees", () => {
    expect(nextRefill(input())).toEqual({ n: 1, dir: dirOf(1), why: "empty" });
    expect(nextRefill(input({ want: 2, record: { trees: [tree(2)], fails: [] } }))).toEqual({ n: 1, dir: dirOf(1), why: "empty" });
    expect(nextRefill(input({ want: 2, record: { trees: [tree(1)], fails: [] }, stale: () => "24h old" }))).toEqual({ n: 2, dir: dirOf(2), why: "empty" });
  });

  test("replaces the lowest stale slot only after empty slots are filled", () => {
    expect(nextRefill(input({ want: 2, record: { trees: [tree(1), tree(2)], fails: [] }, stale: () => "24h old" }))).toEqual({ n: 1, dir: dirOf(1), why: "24h old" });
    expect(nextRefill(input({ record: { trees: [tree(1)], fails: [] } }))).toBeNull();
    expect(nextRefill(input({ want: 0 }))).toBeNull();
  });

  test("waits for one refill, queue availability and the disk floor; rejects invalid wants", () => {
    expect(nextRefill(input({ refilling: true }))).toBeNull();
    expect(nextRefill(input({ busy: true }))).toBeNull();
    expect(nextRefill(input({ free: WORKTREE_DISK_MIN - 1 }))).toBeNull();
    for (const want of [-1, 1.5, WARM_MAX + 1]) expect(nextRefill(input({ want }))).toBeNull();
  });

  test("retries an empty failed slot after WARM_RETRY", () => {
    const fails = [{ dir: dirOf(1), why: "boom", at: 1000, fails: 1 }];
    expect(nextRefill(input({ record: { trees: [], fails }, now: 1000 + WARM_RETRY - 1 }))).toBeNull();
    expect(nextRefill(input({ record: { trees: [], fails }, now: 1000 + WARM_RETRY }))).toEqual({ n: 1, dir: dirOf(1), why: "retry after a failure" });
  });
});

test("overWant selects extra slots by their warm name", () => {
  const trees = [tree(1), tree(2), tree(3)];
  expect(overWant({ trees, fails: [] }, 1, dirOf)).toEqual([tree(2), tree(3)]);
  expect(overWant({ trees, fails: [] }, 0, dirOf)).toEqual(trees);
  expect(overWant({ trees, fails: [] }, 2, dirOf)).toEqual([tree(3)]);
});

test("reconcile preserves the live record object and removes only unrecorded warm folders", () => {
  const live = tree(1);
  const missing = tree(2);
  const failure = { dir: dirOf(2), why: "x", at: 1, fails: 1 };
  const record = { trees: [live, missing], fails: [failure] };
  const result = reconcile(record, [dirOf(1), dirOf(3), "/w/k/ab12cd34"]);
  expect(result.record).toEqual({ trees: [live], fails: [failure] });
  expect(result.record.trees[0]).toBe(live);
  expect(result.record.fails[0]).toBe(failure);
  expect(result.remove).toEqual([dirOf(3)]);
});

test("parseWarmRecord accepts a valid record and rejects corrupt fields atomically", () => {
  const good = { trees: [tree(1)], fails: [] };
  expect(parseWarmRecord(JSON.stringify(good))).toEqual(good);
  for (const text of [
    "{",
    "[]",
    "{}",
    JSON.stringify({ trees: [{ ...tree(1), dir: "/w/k/run/x" }], fails: [] }),
    JSON.stringify({ trees: [{ ...tree(1), lockfile: { name: "", size: -1, mtime: 1 } }], fails: [] }),
    JSON.stringify({ trees: [tree(1), tree(2), tree(3)], fails: [] }),
    JSON.stringify({ trees: [tree(1)], fails: [{ dir: "/w/k/warm-1", why: "", at: 1, fails: 1 }] }),
    JSON.stringify({ trees: [tree(1)], fails: "no" }),
  ]) {
    expect(parseWarmRecord(text)).toEqual(EMPTY_RECORD);
  }
});

test("worktreesProbe reports disk and repeated refill failures with fleet counts", () => {
  const GB = 1024 ** 3;
  const repo = (over: Partial<WorktreeRepoInfo> = {}): WorktreeRepoInfo => ({
    repoId: "a",
    repoPath: "/r/a",
    want: 1,
    runs: [{ dir: "/w/a/x", id: "x", runId: "r", branch: "run/x", state: "working" }],
    warm: [],
    refilling: null,
    fails: [],
    orphans: [],
    ...over,
  });
  const info = (over: Partial<WorktreesInfo> = {}): WorktreesInfo => ({ root: "/w", free: 50 * GB, repos: [], ...over });
  expect(worktreesProbe(info())).toEqual({ state: "ok", detail: "0 run, 0 warm, 50.0 GB free" });
  expect(worktreesProbe(info({ free: 4 * GB, repos: [repo()] }))).toEqual({
    state: "down",
    why: "4.0 GB free under /w; warm worktrees are not refilled under 5 GB",
    detail: "1 run, 0 warm, 4.0 GB free",
  });
  const failed = { name: "warm-1", why: "bun install exited 1", at: 1, fails: WARM_FAILS };
  expect(worktreesProbe(info({ repos: [repo({ fails: [failed] })] }))).toEqual({
    state: "down",
    why: "a's warm worktree failed to refill 3 times: bun install exited 1",
    detail: "1 run, 0 warm, 1 refill failed, 50.0 GB free",
  });
  expect(worktreesProbe(info({ repos: [repo({ fails: [{ ...failed, fails: 1 }] }), repo({ repoId: "b", fails: [{ ...failed, fails: 1 }] })] }))).toEqual({
    state: "ok",
    detail: "2 run, 0 warm, 2 refills failed, 50.0 GB free",
  });
});
