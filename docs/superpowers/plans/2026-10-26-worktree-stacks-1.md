# Worktree stacks, plan 1: a warm worktree pool per repo (FR-039)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** planned 2026-10-26. Written on main at 1ac8fe7.

**Goal:** a repo whose gates file names `setup` can keep one or two prepared
worktrees under the config dir, cut from the default branch's tip with `setup`
already run, so a branch run starts in one of them in a moment instead of
waiting on `bun install`; the pool refills itself after a take, a land, a drop
or the default branch moving on; `canopy worktrees` lists and tunes it, and a
`canopy:worktrees` health check watches the disk and the refills.

**Architecture:** a pure model (`core/warm.ts`) decides which slot to cut next,
when a tree is stale and what the health check says; `core/worktree.ts` gains
the git moves (a detached cut, `git worktree move` plus `checkout -B` for a
take, `du` for a size) and leaves `warm-<n>` folders out of the orphan list; a
server hub (`server/warm.ts`, `WarmPool`) keeps `warm.json` per repo, runs one
refill at a time off a tick, hands a tree to `cutBranch` in `server/index.ts`,
serves `GET /api/worktrees` and the `worktrees` event. Tasks in worktrees, the
port allotment, the preview's name and the cleanup are plan 2; compose stacks
and the refusal for canopy's own stack are plan 3.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-worktree-stacks-design.md`, the
"Plans" list's item 1. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- `.canopy/gates.json` gains `warm`, a whole number from 0 to `WARM_MAX` (2), default 0. It is read from the main checkout like the rest of the file, never from a branch.
- What a machine keeps is the config's own layer (`warm` by repo path in `~/.config/canopy/config.json`), set by `canopy worktrees warm <repo> [N]`; the repo's file value is the default that command takes when `N` is omitted and never acts on its own.
- A warm tree is `<configDir>/worktrees/<repo key>/warm-<n>`, `n` from 1, a detached worktree at the default branch's tip with `setup` run; its record is `<configDir>/worktrees/<repo key>/warm.json`, `{trees: [{dir, base, lockfile, madeAt, size}], fails: [{dir, why, at, fails}]}`, written only by the server holding the flows lock, as the landing records are.
- A take moves the folder to `<run id>` with `git worktree move` and runs `git checkout -B run/<slug>-<id> <tip>` in it; `setup` runs again only when the lockfile's stamp (name, size and mtime; `LOCKFILES` from `core/gates.ts`) differs from the record's.
- The run's first note is `started in a warm worktree` or `no warm worktree; setup ran`, said only when the repo wants warm trees.
- A refill is re-cut when the tree is `WARM_BEHIND` (20) commits behind the default branch or `WARM_AGE` (24 h) old; one refill at a time per backend (`WARM_AT_ONCE` 1); none while the repo's queue is `rebasing` or `landing` or its main checkout is mid-rebase; none under `WORKTREE_DISK_MIN` (5 GB) free on the worktrees root; a failed refill is tried again after `WARM_RETRY` (10 min).
- `listRunTreeDirs` leaves `warm-<n>` out, so a warm tree is never an orphan; peer sync needs no change, since a detached tree has no branch to fetch.
- The health check is `canopy:worktrees`, scope canopy, `button`; its heal runs `prune`; down under the disk floor or when a slot has failed `WARM_FAILS` (3) times.
- Every file the UI imports from `src/core/` stays browser-safe: `core/warm.ts` has no `node:` import.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages).
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. Two branch runs starting at once on a repo with one warm tree: one gets it and the other cuts a fresh tree, never both the same folder (Task 4).
2. A warm tree the record names whose folder git no longer knows (deleted by hand, or `git worktree prune` ran): a take never hands it out; the slot is dropped and refilled (Task 4).
3. `warm` lowered on a machine (2 to 1, or to 0): the extra trees are removed on the next tick rather than left behind as orphans or stale slots (Task 1 for the choice, Task 4 for the removal).
4. After a restart, a record naming a tree that is gone and a `warm-<n>` folder the record lacks: adopt drops the first and removes the second, since a detached tree holds nothing (Task 1 for `reconcile`, Task 4 for adopt).
5. A refill whose `setup` fails, three times: the slot stays empty with the error, health says so, and the button's prune lets it try again at once (Task 1 for the probe, Task 4 for the retry and the prune).

---

## File structure

- Create `src/core/warm.ts` (pure): the constants, the record and its parser, `warmName`, `isWarmName`, `sameStamp`, `staleWhy`, `nextRefill`, `overWant`, `reconcile`, `worktreesProbe`.
- Create `src/core/warm.test.ts`.
- Modify `src/core/types.ts`: `LockfileStamp`, `WarmTreeInfo`, `WorktreeRepoInfo`, `WorktreesInfo`, the `worktrees` event, `CanopyConfig.warm`.
- Modify `src/core/gates.ts` and `src/core/gates.test.ts`: `warm` in the file.
- Modify `src/core/store.ts` and `src/core/store.test.ts`: `warmFor`, `setWarm`, the normalize.
- Modify `src/core/worktree.ts` and `src/core/worktree.test.ts`: `takeWarm`, `treeSize`, `midRebase`, `listWarmTreeDirs`, warm names out of `listRunTreeDirs`.
- Create `src/server/warm.ts`: `readLockfileStamp`, `freeBytes`, `WarmPool` with its routes and probe.
- Create `src/server/warm.test.ts`.
- Modify `src/server/landing.ts` and `src/server/landing.test.ts`: `LandingDeps.treeRemoved`.
- Modify `src/server/index.ts`: `state.warm`, `cutBranch` taking a tree, the check, adopt, the handle chain.
- Modify `src/core/callers.ts` and `src/core/callers.test.ts`: two rules.
- Modify `src/server/health-canopy.test.ts`: the check is registered.
- Create `src/cli/worktrees.ts` and `src/cli/worktrees.test.ts`; modify `src/cli/index.ts`, `src/core/help.ts`, `README.md`.
- Modify `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/feed.ts`, `ui/src/landing.ts`, `ui/src/landing.test.ts`, `ui/src/components/Landing.tsx`.
- Modify `docs/architecture.md`, `SPEC.md`, `README.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the model

**Files:**
- Create: `src/core/warm.ts`, `src/core/warm.test.ts`
- Modify: `src/core/types.ts:1530` (after `LandingInfo`), `:1583` (the `landing` event line)

**Interfaces:**
- Consumes: `ProbeResult` from `core/health.ts` (pure); `RunBranchState` from `core/types.ts`.
- Produces in `src/core/types.ts`:

```ts
/** a lockfile as a warm tree saw it; a change means setup runs again */
export interface LockfileStamp {
  name: string;
  size: number;
  mtime: number;
}
export interface WarmTreeInfo {
  dir: string;
  /** the slot: warm-1, warm-2 */
  name: string;
  /** the commit it was cut at */
  base: string;
  madeAt: number;
  /** bytes, from du at the refill */
  size: number;
  lockfile: LockfileStamp | null;
}
export interface WorktreeRepoInfo {
  repoId: string;
  repoPath: string;
  /** warm trees this machine keeps (the config's layer) */
  want: number;
  /** what the repo's gates file says, when it says */
  fileWarm?: number;
  /** the live run worktrees, from the landing records */
  runs: { dir: string; id: string; runId: string; branch: string; state: RunBranchState }[];
  warm: WarmTreeInfo[];
  /** the slot being cut now */
  refilling: string | null;
  /** slots whose last refill failed */
  fails: { name: string; why: string; at: number; fails: number }[];
  orphans: string[];
}
export interface WorktreesInfo {
  root: string;
  /** bytes free on the root's volume */
  free: number;
  repos: WorktreeRepoInfo[];
}
```

and `| { type: "worktrees"; worktrees: WorktreesInfo }` after the `landing` event.

- Produces in `src/core/warm.ts`:

```ts
export const WARM_MAX = 2;
export const WARM_BEHIND = 20;
export const WARM_AGE = 24 * 3_600_000;
export const WARM_AT_ONCE = 1;
export const WARM_RETRY = 10 * 60_000;
export const WARM_FAILS = 3;
export const WORKTREE_DISK_MIN = 5 * 1024 ** 3;
/** ms between the pool's ticks */
export const WARM_TICK = 60_000;
export const WARM_RECORD = "warm.json";

export interface WarmTree {
  dir: string;
  base: string;
  lockfile: LockfileStamp | null;
  madeAt: number;
  size: number;
}
export interface WarmFail {
  dir: string;
  why: string;
  at: number;
  fails: number;
}
export interface WarmRecord {
  trees: WarmTree[];
  fails: WarmFail[];
}
export const EMPTY_RECORD: WarmRecord;
/** warm.json's text; anything that is not the shape is the empty record */
export function parseWarmRecord(text: string): WarmRecord;
export const warmName = (n: number): string => `warm-${n}`;
/** `warm-1`, `warm-2`, ...; never `warm-0` */
export const isWarmName = (name: string): boolean;
export const sameStamp = (a: LockfileStamp | null, b: LockfileStamp | null): boolean;
/** why a tree is to be re-cut, or null: "20 commits behind", "24h old" */
export function staleWhy(t: Pick<WarmTree, "madeAt">, now: number, behind: number): string | null;

export interface RefillInput {
  want: number;
  record: WarmRecord;
  now: number;
  /** a refill is going on this backend */
  refilling: boolean;
  /** the repo's queue is rebasing or landing, or its checkout is mid-rebase */
  busy: boolean;
  free: number;
  stale: (t: WarmTree) => string | null;
  /** the slot's folder */
  dirOf: (n: number) => string;
}
/** The next slot to cut, lowest first: an empty slot, a slot whose failure
 *  is WARM_RETRY old, a stale tree; null when none, or while a refill is
 *  going, the repo is busy, or the disk is under the floor. */
export function nextRefill(p: RefillInput): { n: number; dir: string; why: string } | null;
/** trees in slots past `want`, to remove */
export function overWant(record: WarmRecord, want: number, dirOf: (n: number) => string): WarmTree[];
/** The record squared with the disk at adopt: a tree not on disk is
 *  dropped, and a warm folder the record lacks is to be removed. */
export function reconcile(record: WarmRecord, onDisk: readonly string[]): { record: WarmRecord; remove: string[] };
/** The canopy:worktrees check's answer from the listing. */
export function worktreesProbe(info: WorktreesInfo): ProbeResult;
```

`nextRefill`'s `why` is `empty`, `retry after a failure`, or the `stale` text. `worktreesProbe`: down with `` `${gb} free under ${root}; warm worktrees are not refilled under 5 GB` `` when `free < WORKTREE_DISK_MIN`; else down with `` `${repoId}'s warm worktree failed to refill ${fails} times: ${why}` `` for the first fail with `fails >= WARM_FAILS`; else ok. The detail in every case is `` `${runs} run, ${warm} warm, ${gb} free` `` with `gb` as `(bytes / 1024 ** 3).toFixed(1) + " GB"`, and `` `${k} refill failed` `` (`refills` past one) slipped in before the free part when `k` slots across the repos hold a failure, so a first failure shows while the check is still ok.

- [ ] **Step 1: Write the failing tests in `src/core/warm.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { WorktreeRepoInfo, WorktreesInfo } from "./types";
import { EMPTY_RECORD, WARM_AGE, WARM_BEHIND, WARM_FAILS, WARM_MAX, WARM_RETRY, WORKTREE_DISK_MIN, isWarmName, nextRefill, overWant, parseWarmRecord, reconcile, sameStamp, staleWhy, warmName, worktreesProbe, type RefillInput, type WarmTree } from "./warm";

const dirOf = (n: number) => `/w/k/warm-${n}`;
const tree = (n: number, over: Partial<WarmTree> = {}): WarmTree => ({ dir: dirOf(n), base: "b0", lockfile: { name: "bun.lock", size: 10, mtime: 1 }, madeAt: 1000, size: 2048, ...over });
const input = (over: Partial<RefillInput> = {}): RefillInput => ({ want: 1, record: EMPTY_RECORD, now: 1000, refilling: false, busy: false, free: WORKTREE_DISK_MIN, stale: () => null, dirOf, ...over });

test("names and limits", () => {
  expect(WARM_MAX).toBe(2);
  expect(warmName(1)).toBe("warm-1");
  expect([isWarmName("warm-1"), isWarmName("warm-12"), isWarmName("warm-0"), isWarmName("ab12cd34"), isWarmName("warm-")]).toEqual([true, true, false, false, false]);
});

test("sameStamp", () => {
  const a = { name: "bun.lock", size: 10, mtime: 1 };
  expect(sameStamp(a, { ...a })).toBe(true);
  expect(sameStamp(a, { ...a, mtime: 2 })).toBe(false);
  expect(sameStamp(null, null)).toBe(true);
  expect(sameStamp(a, null)).toBe(false);
});

test("staleWhy: by commits or by age, else null", () => {
  expect(staleWhy(tree(1), 1000, 0)).toBeNull();
  expect(staleWhy(tree(1), 1000 + WARM_AGE - 1, WARM_BEHIND - 1)).toBeNull();
  expect(staleWhy(tree(1), 1000, WARM_BEHIND)).toBe("20 commits behind");
  expect(staleWhy(tree(1), 1000 + WARM_AGE, 0)).toBe("24h old");
});

describe("nextRefill", () => {
  test("an empty slot first, lowest first, then a stale tree", () => {
    expect(nextRefill(input())).toEqual({ n: 1, dir: dirOf(1), why: "empty" });
    expect(nextRefill(input({ want: 2, record: { trees: [tree(2)], fails: [] } }))).toEqual({ n: 1, dir: dirOf(1), why: "empty" });
    expect(nextRefill(input({ want: 2, record: { trees: [tree(1), tree(2)], fails: [] }, stale: (t) => (t.dir === dirOf(2) ? "24h old" : null) }))).toEqual({ n: 2, dir: dirOf(2), why: "24h old" });
    expect(nextRefill(input({ record: { trees: [tree(1)], fails: [] } }))).toBeNull();
    expect(nextRefill(input({ want: 0 }))).toBeNull();
  });
  test("nothing while a refill is going, the repo is busy, or the disk is under the floor", () => {
    expect(nextRefill(input({ refilling: true }))).toBeNull();
    expect(nextRefill(input({ busy: true }))).toBeNull();
    expect(nextRefill(input({ free: WORKTREE_DISK_MIN - 1 }))).toBeNull();
  });
  test("a failed slot waits WARM_RETRY, then is tried again", () => {
    const fails = [{ dir: dirOf(1), why: "boom", at: 1000, fails: 1 }];
    expect(nextRefill(input({ record: { trees: [], fails }, now: 1000 + WARM_RETRY - 1 }))).toBeNull();
    expect(nextRefill(input({ record: { trees: [], fails }, now: 1000 + WARM_RETRY }))).toEqual({ n: 1, dir: dirOf(1), why: "retry after a failure" });
  });
});

test("overWant: the trees in slots past want", () => {
  expect(overWant({ trees: [tree(1), tree(2)], fails: [] }, 1, dirOf)).toEqual([tree(2)]);
  expect(overWant({ trees: [tree(1), tree(2)], fails: [] }, 0, dirOf)).toEqual([tree(1), tree(2)]);
  expect(overWant({ trees: [tree(1)], fails: [] }, 2, dirOf)).toEqual([]);
});

test("reconcile: a tree not on disk is dropped, a folder the record lacks is removed", () => {
  const r = reconcile({ trees: [tree(1), tree(2)], fails: [{ dir: dirOf(2), why: "x", at: 1, fails: 1 }] }, [dirOf(1), dirOf(3)]);
  expect(r.record).toEqual({ trees: [tree(1)], fails: [{ dir: dirOf(2), why: "x", at: 1, fails: 1 }] });
  expect(r.remove).toEqual([dirOf(3)]);
});

test("parseWarmRecord", () => {
  expect(parseWarmRecord(JSON.stringify({ trees: [tree(1)], fails: [] }))).toEqual({ trees: [tree(1)], fails: [] });
  expect(parseWarmRecord("{")).toEqual(EMPTY_RECORD);
  expect(parseWarmRecord("[]")).toEqual(EMPTY_RECORD);
  expect(parseWarmRecord(JSON.stringify({ trees: [{ dir: 1 }], fails: "no" }))).toEqual(EMPTY_RECORD);
});

test("worktreesProbe: the disk floor, a slot failed three times, else ok with the counts", () => {
  const GB = 1024 ** 3;
  const repo = (over: Partial<WorktreeRepoInfo> = {}): WorktreeRepoInfo => ({ repoId: "a", repoPath: "/r/a", want: 1, runs: [{ dir: "/w/a/x", id: "x", runId: "r", branch: "run/x", state: "working" }], warm: [], refilling: null, fails: [], orphans: [], ...over });
  const info = (over: Partial<WorktreesInfo> = {}): WorktreesInfo => ({ root: "/w", free: 50 * GB, repos: [], ...over });
  expect(worktreesProbe(info())).toEqual({ state: "ok", detail: "0 run, 0 warm, 50.0 GB free" });
  expect(worktreesProbe(info({ free: 4 * GB, repos: [repo()] }))).toEqual({ state: "down", why: "4.0 GB free under /w; warm worktrees are not refilled under 5 GB", detail: "1 run, 0 warm, 4.0 GB free" });
  const fail = { name: "warm-1", why: "bun install exited 1", at: 1, fails: WARM_FAILS };
  expect(worktreesProbe(info({ repos: [repo({ fails: [fail] })] }))).toEqual({ state: "down", why: "a's warm worktree failed to refill 3 times: bun install exited 1", detail: "1 run, 0 warm, 1 refill failed, 50.0 GB free" });
  expect(worktreesProbe(info({ repos: [repo({ fails: [{ ...fail, fails: 2 }], warm: [{ dir: "/w/a/warm-1", name: "warm-1", base: "b", madeAt: 1, size: 1, lockfile: null }] })] }))).toEqual({ state: "ok", detail: "1 run, 1 warm, 1 refill failed, 50.0 GB free" });
  expect(worktreesProbe(info({ repos: [repo({ fails: [{ ...fail, fails: 1 }] }), repo({ repoId: "b", fails: [{ ...fail, fails: 1 }] })] }))).toEqual({ state: "ok", detail: "2 run, 0 warm, 2 refills failed, 50.0 GB free" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/warm.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Add the types and write `src/core/warm.ts`**

Header comment: the warm pool's model, where the trees and `warm.json` live, and that the file is pure and browser-safe. `staleWhy`'s hours are `Math.floor((now - madeAt) / 3_600_000)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/warm.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/warm.ts src/core/warm.test.ts src/core/types.ts
git commit -m "feat(worktrees): the warm pool's model, record and health probe (FR-039)"
```

---

### Task 2: `warm` in the gates file and the machine's layer

**Files:**
- Modify: `src/core/gates.ts:18-25` (`Gates`), `:36-60` (`parseGatesFile`); `src/core/gates.test.ts:25-42`; `src/core/types.ts:637` (after `CanopyConfig.health`); `src/core/store.ts:64` (the defaults), `:183` (the normalize), after `:527` (beside the health layer); `src/core/store.test.ts` (the `config store` describe at `:45`, which points `CANOPY_CONFIG_DIR` at a scratch dir)

**Interfaces:**
- Consumes: `WARM_MAX` from `core/warm.ts`.
- Produces in `src/core/gates.ts`: `Gates.warm?: number` with the comment "prepared worktrees a machine may keep for this repo; the default `canopy worktrees warm` adopts", returned by `parseGatesFile` and `readGates` only when the file says it. A `warm` that is not a whole number from 0 to `WARM_MAX` is the error `".canopy/gates.json: warm must be a whole number from 0 to 2"`.
- Produces in `src/core/types.ts`: `CanopyConfig.warm: Record<string, number>` with the comment "per-machine warm worktree count by repo path (core/warm); the repo's gates file is the default, never acted on".
- Produces in `src/core/store.ts`:

```ts
export const warmFor = (cfg: Pick<CanopyConfig, "warm">, path: string): number;
/** Stores this machine's warm count for a repo; 0 or null removes it. Returns the count kept. */
export async function setWarm(path: string, n: number | null): Promise<number>;
```

The normalize keeps entries whose value is a whole number from 1 to `WARM_MAX` and drops the rest; the defaults hold `warm: {}`.

- [ ] **Step 1: Write the failing tests**

In `src/core/gates.test.ts`, in the `the gates file` describe:

```ts
test("warm: prepared worktrees to keep, a whole number from 0 to 2", () => {
  expect(parseGatesFile(JSON.stringify({ gates: [], warm: 1 }))).toEqual({ gates: [], warm: 1 });
  expect(parseGatesFile(JSON.stringify({ gates: [] }))).toEqual({ gates: [] });
  for (const bad of [3, -1, 1.5, "1"]) expect(parseGatesFile(JSON.stringify({ gates: [], warm: bad }))).toEqual({ error: ".canopy/gates.json: warm must be a whole number from 0 to 2" });
});
```

and in the `readGates` describe:

```ts
test("warm comes with the file", async () => {
  const dir = await folder("warm", { ".canopy/gates.json": JSON.stringify({ gates: [], setup: "bun install", warm: 2 }) });
  expect(await readGates(dir)).toEqual({ gates: [], setup: "bun install", warm: 2, source: "file" });
});
```

In `src/core/store.test.ts`, inside the `config store` describe:

```ts
test("warm: this machine's warm worktree count per repo", async () => {
  expect(warmFor({ warm: {} }, "/r")).toBe(0);
  expect(await setWarm("/r", 2)).toBe(2);
  expect(warmFor(await loadConfig(), "/r")).toBe(2);
  expect(await setWarm("/r", 0)).toBe(0);
  expect((await loadConfig()).warm).toEqual({});
  await setWarm("/r", 1);
  expect(await setWarm("/r", null)).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/gates.test.ts src/core/store.test.ts`
Expected: FAIL on the three new tests.

- [ ] **Step 3: Implement the field, the layer and the normalize**

`parseGatesFile` reads `warm` after `setup`; `readGates` spreads what `parseGatesFile` returned, so no change there beyond the type. In `store.ts`, `setWarm` goes through `withConfig` like `setHealthCheck`, and the normalize is a `normalizeWarm(v: unknown): Record<string, number>` beside `normalizeHealth`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/gates.test.ts src/core/store.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/gates.ts src/core/gates.test.ts src/core/types.ts src/core/store.ts src/core/store.test.ts
git commit -m "feat(worktrees): warm in the gates file and this machine's warm layer in the config"
```

---

### Task 3: the git moves

**Files:**
- Modify: `src/core/worktree.ts:1-7` (the header), `:82-94` (beside `detachedTree`), `:106-127` (`listRunTreeDirs`), `:216-220` (the mid-rebase check in `rebaseOnto`); `src/core/worktree.test.ts:84-156` (the `run worktrees` describe)

**Interfaces:**
- Consumes: `isWarmName` from `core/warm.ts`; `exec` from `core/exec.ts`; `detachedTree` as it is (a warm cut is `detachedTree(repo, dir, tip)`).
- Produces in `src/core/worktree.ts`:

```ts
/** Takes a detached warm tree for a run: the folder moved to the run's
 *  with `git worktree move`, so git's own record follows it, then put on
 *  the run's new branch at `base`; ignored files stay. Throws git's last line. */
export async function takeWarm(repo: string, from: string, to: string, branch: string, base: string): Promise<void>;
/** A folder's size in bytes, from `du -sk`; 0 when du cannot read it. */
export async function treeSize(dir: string): Promise<number>;
/** Whether a checkout is mid-rebase (a crash or a hand left it there). */
export async function midRebase(dir: string): Promise<boolean>;
/** A repo's warm slot folders on disk under the root, sorted. */
export async function listWarmTreeDirs(repoPath: string, root = worktreesRoot()): Promise<string[]>;
```

`listRunTreeDirs` skips an id that `isWarmName` matches, with its comment saying warm slots are the pool's. `rebaseOnto` calls `midRebase` for the check it does today. The header gains a line: a warm slot is `<configDir>/worktrees/<repo key>/warm-<n>`, detached, with `setup` run, for the next branch run.

- [ ] **Step 1: Write the failing tests in `src/core/worktree.test.ts`**

In the `run worktrees` describe, using the file's `repo`, `commit` and `sh` helpers:

```ts
test("a warm tree is taken by moving it onto the run's branch, ignored files kept", async () => {
  const r = await repo();
  await commit(r, ".gitignore", "node_modules/\n");
  const wts = join(root, "wts-warm");
  const warm = join(wts, repoKey(r), "warm-1");
  await detachedTree(r, warm, (await revOf(r, "main"))!);
  expect(await currentBranch(warm)).toBeNull();
  await mkdir(join(warm, "node_modules"));
  await writeFile(join(warm, "node_modules", "x"), "x");
  const tip = await commit(r, "c.txt", "c\n");
  const dir = runTreeDir(r, "run9", wts);
  await takeWarm(r, warm, dir, "run/x-run9", tip);
  expect(existsSync(warm)).toBe(false);
  expect(await currentBranch(dir)).toBe("run/x-run9");
  expect(await revOf(dir, "HEAD")).toBe(tip);
  expect(existsSync(join(dir, "node_modules", "x"))).toBe(true);
  expect(existsSync(join(dir, "c.txt"))).toBe(true);
  expect(await dirtyFiles(dir)).toEqual([]);
  expect(await sh(r, "worktree", "list", "--porcelain")).toContain(`worktree ${await realpath(dir)}`);
  expect(await treeSize(dir)).toBeGreaterThan(0);
  expect(await treeSize(join(root, "nowhere"))).toBe(0);
  expect(await midRebase(r)).toBe(false);
  await expect(takeWarm(r, join(wts, "none"), join(wts, "x"), "run/y", tip)).rejects.toThrow();
});

test("warm slots are the pool's, never orphans", async () => {
  const r = await repo();
  const wts = join(root, "wts-list");
  const run = runTreeDir(r, "run1", wts);
  await addRunTree(r, run, "run/x-run1", "main");
  const warm = join(wts, repoKey(r), "warm-1");
  await detachedTree(r, warm, (await revOf(r, "main"))!);
  await mkdir(join(wts, repoKey(r), "warm-2"));
  await writeFile(join(wts, repoKey(r), "warm.json"), "{}");
  expect(await listRunTreeDirs(wts)).toEqual([run]);
  expect(await listWarmTreeDirs(r, wts)).toEqual([warm, join(wts, repoKey(r), "warm-2")]);
  expect(await listWarmTreeDirs(join(root, "no-such-repo"), wts)).toEqual([]);
});
```

Add `detachedTree`, `listWarmTreeDirs`, `midRebase`, `takeWarm` and `treeSize` to the import, and `realpath` is imported already.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/worktree.test.ts`
Expected: FAIL, `takeWarm` is not exported.

- [ ] **Step 3: Implement the four functions and the two edits**

`takeWarm`: `git(repo, ["worktree", "move", from, to], 60_000)` then `git(to, ["checkout", "-q", "-B", branch, base], 120_000)`, each failure thrown through the file's `why`. `treeSize`: `exec(["du", "-sk", dir])`, the first field times 1024 (the flags are the same on BSD and GNU du). `listWarmTreeDirs` lists `<root>/<repo key>` and keeps directories whose name `isWarmName` matches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/worktree.test.ts src/server/landing.test.ts`
Expected: PASS (the landing tests cover `rebaseOnto` after the extraction).

- [ ] **Step 5: Commit**

```bash
git add src/core/worktree.ts src/core/worktree.test.ts
git commit -m "feat(worktrees): takeWarm, treeSize, midRebase and warm slots out of the orphan list"
```

---

### Task 4: the pool

**Files:**
- Create: `src/server/warm.ts`, `src/server/warm.test.ts`

**Interfaces:**
- Consumes: Task 1's model; Task 3's `takeWarm`, `treeSize`, `midRebase`, `listWarmTreeDirs`, with `detachedTree`, `removeRunTree`, `repoKey`, `revOf`, `defaultBranch`, `aheadOf`, `worktreesRoot` from `core/worktree.ts`; `readGates`, `LOCKFILES`, `Gates` from `core/gates.ts`; `CheckOutcome` from `./landing` (a `type` import); `LandingInfo`, `Repo`, `ServerEvent`, `WorktreesInfo` from `core/types.ts`.
- Produces in `src/server/warm.ts`:

```ts
/** the first of LOCKFILES at the tree's root, as a stamp; null with none */
export async function readLockfileStamp(dir: string): Promise<LockfileStamp | null>;
/** bytes free on the volume holding `dir`: statfs's bavail times bsize (Bun 1.4 answers it) */
export async function freeBytes(dir: string): Promise<number>;

export interface WarmDeps {
  root?: string;
  /** the repos on this backend's disk: no host, an absolute path */
  repos: () => Repo[];
  /** warm trees this machine keeps for a repo (`warmFor` over the config) */
  want: (repoPath: string) => Promise<number>;
  /** stores the machine's count; null removes it (`setWarm`) */
  setWant: (repoPath: string, n: number | null) => Promise<number>;
  /** the repo's gates as the main checkout holds them; `readGates` unless a test says */
  gates?: (repoPath: string) => Promise<Gates>;
  /** runs the setup line in a tree (`runGate`) */
  setup: (dir: string, line: string) => Promise<CheckOutcome>;
  /** the landing hub's info: run worktrees and orphans */
  landing: () => LandingInfo;
  /** whether the repo's queue is rebasing or landing now */
  landingBusy: (repoPath: string) => boolean;
  /** removes an orphan through the landing hub (`orphan(dir, "remove")`) */
  removeOrphan: (dir: string) => Promise<void>;
  freeBytes?: (dir: string) => Promise<number>;
  broadcast: (ev: ServerEvent) => void;
  now?: () => number;
  /** ms between ticks (WARM_TICK); no timer runs under bun test */
  every?: number;
}

export type Take = { took: true; setupAgain: boolean } | { took: false; wanted: boolean };

export class WarmPool {
  constructor(deps: WarmDeps);
  /** Reads every repo's warm.json and squares it with the disk, as the
   *  holder of the flows lock: `reconcile`, the extra folders removed.
   *  Writes from then on. */
  adopt(): Promise<void>;
  start(): void;
  stop(): void;
  /** One pass over the repos: slots past want removed, then at most one
   *  refill on this backend, then the event when anything changed. */
  tick(): Promise<void>;
  /** A tree for a run, moved to `dir` on `branch` at `base`. `setupAgain`
   *  says the lockfile's stamp changed since the tree was prepared. Takes
   *  are serialized per repo; a slot whose folder git no longer knows is
   *  dropped and not handed out. A take asks for a tick. */
  take(repoPath: string, dir: string, branch: string, base: string): Promise<Take>;
  /** a land, a drop or a take: tick soon */
  poke(repoPath: string): void;
  /** Removes the repo's (every repo's) orphans and stale warm trees and
   *  forgets its failures, so the next tick tries again; the health button. */
  prune(repoPath?: string): Promise<string[]>;
  info(): Promise<WorktreesInfo>;
  probe(): Promise<ProbeResult>;
  /** waits for the refill going now and any tick asked for, for tests */
  idle(): Promise<void>;
  /** null for a path outside /api/worktrees */
  handle(req: Request, url: URL): Promise<Response | null>;
}
```

The refill, in detail: `tick` runs `overWant` per repo first (`removeRunTree` with no branch, the tree dropped from the record), then `nextRefill` over the repos in `repos()` order with `busy` as `landingBusy(path) || await midRebase(path)`, `free` from `freeBytes(root)` once per tick, and `stale` as `staleWhy(t, now, await aheadOf(path, t.base))`. For the slot it picks: `removeRunTree(path, dir)` if the folder is there, `tip = revOf(path, \`refs/heads/${await defaultBranch(path)}\`)`, `detachedTree(path, dir, tip)`, then `setup` when the gates have one. A non-zero exit, or a throw from git, removes the folder and writes a fail: `{ dir, why, at: now, fails: previous + 1 }` with `why` as `` `${line} exited ${exit}: ${last line of output}` `` or the thrown message. A success writes the tree `{ dir, base: tip, lockfile: await readLockfileStamp(dir), madeAt: now, size: await treeSize(dir) }` and drops the slot's fail. The record is written to `<root>/<repo key>/warm.json` only after `adopt`; `refilling` holds the slot being cut for `info`.

`take`: the record's first tree for the repo whose folder has a `.git`; a tree without one is dropped from the record and the loop goes on; with none, `{ took: false, wanted: (await want(path)) > 0 }`. With one: the tree leaves the record first, then `takeWarm`, then `setupAgain` is `!sameStamp(tree.lockfile, await readLockfileStamp(dir))`. A `takeWarm` that throws removes the slot's folder and answers as none. Takes queue on a per-repo promise chain.

Routes, each answering JSON (a local `json` helper as `server/landing.ts:100` has), `repo` resolved by id through `repos()`:
- `GET /api/worktrees` → `WorktreesInfo`.
- `POST /api/worktrees/warm` body `{ repo, n? }` → `setWant` with `n`, or with the gates file's `warm` when `n` is absent (400 `"<name> has no warm in its gates file; say a number"` when it has none); `n` not a whole number from 0 to `WARM_MAX` → 400 `"warm must be a whole number from 0 to 2"`; 0 stores null. Answers `{ repo, want }` and pokes.
- `POST /api/worktrees/prune` body `{ repo? }` → `{ removed: string[] }`.
- Every route: `repo` unknown → 404 `"no repo by that id"`; a repo with a host → 400 `"warm worktrees are kept only for a repo on this backend"`.

- [ ] **Step 1: Write the failing tests in `src/server/warm.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import type { LandingInfo, Repo, ServerEvent, WorktreesInfo } from "../core/types";
import { EMPTY_RECORD, WARM_AGE, WARM_BEHIND, WARM_FAILS, WARM_RETRY, WORKTREE_DISK_MIN, parseWarmRecord } from "../core/warm";
import { currentBranch, repoKey, revOf, runTreeDir } from "../core/worktree";
import type { CheckOutcome } from "./landing";
import { freeBytes, readLockfileStamp, WarmPool, type WarmDeps } from "./warm";

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

interface World {
  wts: string;
  repo: Repo;
  want: Map<string, number>;
  busy: boolean;
  free: number;
  now: number;
  setups: string[];
  setupAnswer: CheckOutcome | (() => Promise<CheckOutcome>);
  landing: LandingInfo;
  events: ServerEvent[];
  pool: WarmPool;
}

async function world(over: Partial<WarmDeps> = {}): Promise<World> {
  const path = join(root, `r${++n}`);
  await exec(["git", "init", "-q", "-b", "main", path]);
  await sh(path, "config", "user.email", "t@t");
  await sh(path, "config", "user.name", "t");
  await commit(path, ".gitignore", "node_modules/\n");
  await commit(path, "bun.lock", "lock v1\n");
  await commit(path, ".canopy/gates.json", JSON.stringify({ gates: [], setup: "bun install --frozen-lockfile", warm: 1 }));
  const w: World = {
    wts: join(root, `wts${n}`),
    repo: { id: `r${n}`, name: `r${n}`, path, group: "", source: "root", status: null },
    want: new Map(),
    busy: false,
    free: WORKTREE_DISK_MIN,
    now: 1_000_000,
    setups: [],
    setupAnswer: { exit: 0, output: "" },
    landing: { runs: [], entries: [], orphans: [] },
    events: [],
    pool: undefined as unknown as WarmPool,
  };
  w.pool = new WarmPool({
    root: w.wts,
    repos: () => [w.repo],
    want: async (p) => w.want.get(p) ?? 0,
    setWant: async (p, k) => {
      if (k) w.want.set(p, k);
      else w.want.delete(p);
      return w.want.get(p) ?? 0;
    },
    setup: async (dir, line) => {
      w.setups.push(line);
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "node_modules", ".ok"), "ok");
      return typeof w.setupAnswer === "function" ? w.setupAnswer() : w.setupAnswer;
    },
    landing: () => w.landing,
    landingBusy: () => w.busy,
    removeOrphan: async (dir) => rm(dir, { recursive: true, force: true }),
    freeBytes: async () => w.free,
    broadcast: (ev) => w.events.push(ev),
    now: () => w.now,
    ...over,
  });
  await w.pool.adopt();
  return w;
}
const slot = (w: World, k: number) => join(w.wts, repoKey(w.repo.path), `warm-${k}`);
const record = async (w: World) => parseWarmRecord(await readFile(join(w.wts, repoKey(w.repo.path), "warm.json"), "utf8").catch(() => "{"));
const last = (w: World): WorktreesInfo => {
  const ev = w.events.filter((e) => e.type === "worktrees").pop();
  if (!ev || ev.type !== "worktrees") throw new Error("no worktrees event");
  return ev.worktrees;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-warm-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("readLockfileStamp and freeBytes", async () => {
  const dir = join(root, "stamp");
  await mkdir(dir);
  expect(await readLockfileStamp(dir)).toBeNull();
  await writeFile(join(dir, "bun.lock"), "lock");
  expect(await readLockfileStamp(dir)).toMatchObject({ name: "bun.lock", size: 4 });
  expect(await freeBytes(root)).toBeGreaterThan(0);
  await expect(freeBytes(join(root, "none"))).rejects.toThrow();
});

test("a tick cuts warm-1 detached at the tip with setup run, writes the record and sends the event", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const tip = (await revOf(w.repo.path, "main"))!;
  expect(existsSync(join(slot(w, 1), "node_modules", ".ok"))).toBe(true);
  expect(await currentBranch(slot(w, 1))).toBeNull();
  expect(await revOf(slot(w, 1), "HEAD")).toBe(tip);
  expect(w.setups).toEqual(["bun install --frozen-lockfile"]);
  const rec = await record(w);
  expect(rec.trees).toHaveLength(1);
  expect(rec.trees[0]).toMatchObject({ dir: slot(w, 1), base: tip, madeAt: w.now, lockfile: { name: "bun.lock" } });
  expect(rec.trees[0]!.size).toBeGreaterThan(0);
  const info = last(w);
  expect(info.repos[0]).toMatchObject({ repoId: w.repo.id, want: 1, fileWarm: 1, refilling: null, fails: [], orphans: [] });
  expect(info.repos[0]!.warm.map((t) => t.name)).toEqual(["warm-1"]);
  expect(info.free).toBe(WORKTREE_DISK_MIN);
});

test("a take moves the tree onto the run's branch, needs no setup, and the next tick refills", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const tip = (await revOf(w.repo.path, "main"))!;
  const dir = runTreeDir(w.repo.path, "run1", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run1", tip)).toEqual({ took: true, setupAgain: false });
  expect(await currentBranch(dir)).toBe("run/x-run1");
  expect(existsSync(join(dir, "node_modules", ".ok"))).toBe(true);
  expect(existsSync(slot(w, 1))).toBe(false);
  expect((await record(w)).trees).toEqual([]);
  await w.pool.idle();
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(true);
  expect(w.setups).toHaveLength(2);
});

test("a take after the lockfile moved on main says setup again", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  await Bun.sleep(20);
  const tip = await commit(w.repo.path, "bun.lock", "lock v2\n");
  const dir = runTreeDir(w.repo.path, "run2", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run2", tip)).toEqual({ took: true, setupAgain: true });
  expect(await readFile(join(dir, "bun.lock"), "utf8")).toBe("lock v2\n");
});

test("no tree: wanted says whether the repo keeps any", async () => {
  const w = await world();
  const dir = runTreeDir(w.repo.path, "run3", w.wts);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run3", "main")).toEqual({ took: false, wanted: false });
  w.want.set(w.repo.path, 1);
  expect(await w.pool.take(w.repo.path, dir, "run/x-run3", "main")).toEqual({ took: false, wanted: true });
  expect(existsSync(dir)).toBe(false);
});

test("two takes at once: one gets the tree", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  const tip = (await revOf(w.repo.path, "main"))!;
  const [a, b] = await Promise.all([w.pool.take(w.repo.path, runTreeDir(w.repo.path, "a", w.wts), "run/a", tip), w.pool.take(w.repo.path, runTreeDir(w.repo.path, "b", w.wts), "run/b", tip)]);
  expect([a.took, b.took].sort()).toEqual([false, true]);
});

test("a tree git no longer knows is not handed out; the slot is dropped and refilled", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  await rm(slot(w, 1), { recursive: true, force: true });
  expect(await w.pool.take(w.repo.path, runTreeDir(w.repo.path, "c", w.wts), "run/c", "main")).toEqual({ took: false, wanted: true });
  expect((await record(w)).trees).toEqual([]);
  await w.pool.idle();
  await w.pool.tick();
  expect(existsSync(join(slot(w, 1), "node_modules", ".ok"))).toBe(true);
});

test("nothing refills under the disk floor, while the queue is busy, or while another refill runs", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  w.free = WORKTREE_DISK_MIN - 1;
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect(await w.pool.probe()).toMatchObject({ state: "down", why: expect.stringContaining("not refilled under 5 GB") });
  w.free = WORKTREE_DISK_MIN;
  w.busy = true;
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  w.busy = false;
  let release: (() => void) | undefined;
  w.setupAnswer = () =>
    new Promise<CheckOutcome>((res) => {
      release = () => res({ exit: 0, output: "" });
    });
  w.want.set(w.repo.path, 2);
  const first = w.pool.tick();
  await Bun.sleep(50);
  await w.pool.tick();
  expect(w.setups).toHaveLength(1);
  release!();
  await first;
  expect((await record(w)).trees).toHaveLength(1);
  expect(await w.pool.probe()).toMatchObject({ state: "ok", detail: "0 run, 1 warm, 5.0 GB free" });
});

test("a failed setup leaves the slot empty with the error, tried again after WARM_RETRY; health turns at WARM_FAILS; prune forgets", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  w.setupAnswer = { exit: 1, output: "lots\nno lockfile" };
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect((await record(w)).fails).toEqual([{ dir: slot(w, 1), why: "bun install --frozen-lockfile exited 1: no lockfile", at: w.now, fails: 1 }]);
  await w.pool.tick();
  expect(w.setups).toHaveLength(1);
  for (let k = 2; k <= WARM_FAILS; k++) {
    w.now += WARM_RETRY;
    await w.pool.tick();
  }
  expect(w.setups).toHaveLength(WARM_FAILS);
  expect(await w.pool.probe()).toEqual({ state: "down", why: `${w.repo.id}'s warm worktree failed to refill 3 times: bun install --frozen-lockfile exited 1: no lockfile`, detail: "0 run, 0 warm, 1 refill failed, 5.0 GB free" });
  expect(last(w).repos[0]!.fails).toEqual([{ name: "warm-1", why: "bun install --frozen-lockfile exited 1: no lockfile", at: w.now, fails: 3 }]);
  expect(await w.pool.prune(w.repo.path)).toEqual([]);
  expect((await record(w)).fails).toEqual([]);
  w.setupAnswer = { exit: 0, output: "" };
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(true);
});

test("a stale tree is re-cut: 20 commits on main, or 24 hours", async () => {
  const w = await world();
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  for (let k = 0; k < WARM_BEHIND; k++) await commit(w.repo.path, `f${k}.txt`, `${k}\n`);
  await w.pool.tick();
  expect(w.setups).toHaveLength(2);
  expect((await record(w)).trees[0]!.base).toBe((await revOf(w.repo.path, "main"))!);
  w.now += WARM_AGE;
  await w.pool.tick();
  expect(w.setups).toHaveLength(3);
  expect((await record(w)).trees[0]!.madeAt).toBe(w.now);
});

test("want lowered removes the slots past it", async () => {
  const w = await world();
  w.want.set(w.repo.path, 2);
  await w.pool.tick();
  await w.pool.tick();
  expect([existsSync(slot(w, 1)), existsSync(slot(w, 2))]).toEqual([true, true]);
  w.want.set(w.repo.path, 1);
  await w.pool.tick();
  expect([existsSync(slot(w, 1)), existsSync(slot(w, 2))]).toEqual([true, false]);
  w.want.delete(w.repo.path);
  await w.pool.tick();
  expect(existsSync(slot(w, 1))).toBe(false);
  expect(await record(w)).toEqual(EMPTY_RECORD);
});

test("adopt squares the record with the disk", async () => {
  const w = await world();
  const key = join(w.wts, repoKey(w.repo.path));
  await mkdir(join(key, "warm-2"), { recursive: true });
  await writeFile(join(key, "warm.json"), JSON.stringify({ trees: [{ dir: slot(w, 1), base: "b", lockfile: null, madeAt: 1, size: 1 }], fails: [] }));
  await w.pool.adopt();
  expect(await record(w)).toEqual(EMPTY_RECORD);
  expect(existsSync(join(key, "warm-2"))).toBe(false);
});

test("the routes: the listing, warm from a number or the file, prune", async () => {
  const w = await world();
  const orphan = join(w.wts, repoKey(w.repo.path), "zz");
  await mkdir(orphan, { recursive: true });
  w.landing = { runs: [], entries: [], orphans: [{ dir: orphan, repoPath: w.repo.path, branch: null, queueable: false }] };
  const call = (method: string, path: string, body?: unknown) =>
    w.pool.handle(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), new URL(`http://x${path}`));
  const list = (await (await call("GET", "/api/worktrees"))!.json()) as WorktreesInfo;
  expect(list.repos[0]).toMatchObject({ repoId: w.repo.id, want: 0, fileWarm: 1, orphans: [orphan] });
  expect(await (await call("POST", "/api/worktrees/warm", { repo: w.repo.id }))!.json()).toEqual({ repo: w.repo.id, want: 1 });
  expect(await (await call("POST", "/api/worktrees/warm", { repo: w.repo.id, n: 2 }))!.json()).toEqual({ repo: w.repo.id, want: 2 });
  expect(w.want.get(w.repo.path)).toBe(2);
  expect((await call("POST", "/api/worktrees/warm", { repo: w.repo.id, n: 3 }))!.status).toBe(400);
  expect((await call("POST", "/api/worktrees/warm", { repo: "zzz" }))!.status).toBe(404);
  await w.pool.idle();
  expect(await (await call("POST", "/api/worktrees/prune", { repo: w.repo.id }))!.json()).toEqual({ removed: [orphan] });
  expect(existsSync(orphan)).toBe(false);
  expect(await call("GET", "/api/other")).toBeNull();
});

test("a repo on another host is refused", async () => {
  const w = await world({ repos: () => [{ id: "far", name: "far", path: "ssh://mini/home/eric/dev/x", group: "", source: "s", host: "mini", status: null }] });
  const res = (await w.pool.handle(new Request("http://x/api/worktrees/warm", { method: "POST", body: JSON.stringify({ repo: "far", n: 1 }), headers: { "content-type": "application/json" } }), new URL("http://x/api/worktrees/warm")))!;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "warm worktrees are kept only for a repo on this backend" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/server/warm.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/server/warm.ts`**

Header: "The warm worktree pool (FR-039, plan 1): prepared worktrees per repo under the config dir, their record, the refill off a tick, the take a branch run makes, the listing and the health probe. Bun-only; the model is core/warm.ts." The timer starts in `start()` only when `process.env["NODE_ENV"] !== "test"`, as `SweepHub` does; `poke` schedules a tick on the next turn when none is pending, folded into `idle`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/server/warm.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/warm.ts src/server/warm.test.ts
git commit -m "feat(worktrees): WarmPool keeps, refills and hands out prepared worktrees"
```

---

### Task 5: the wiring

**Files:**
- Modify: `src/server/landing.ts:54-81` (`LandingDeps`), `:670` (drop), `:683` (orphan remove), `:870` (land); `src/server/landing.test.ts` (the `World` and its hub deps); `src/server/index.ts:332` (`ServerState.landing`), `:1090` (`startBranchRun`), `:1188-1218` (`cutBranch`), `:1300` (the trigger flow's `cutBranch`), `:2451` (`addCanopyChecks`), `:3105` (the handle chain), `:5162-5178` (the `LandingHub` deps), `:5791` (`adoptFlows`), `:5911` and `:5958` (start and stop); `src/core/callers.ts:67` and `:81`; `src/core/callers.test.ts:147`; `src/server/health-canopy.test.ts`

**Interfaces:**
- Consumes: Task 4's `WarmPool`, `freeBytes`; Task 2's `warmFor`, `setWarm`; `runGate` from `core/check.ts`.
- Produces in `src/server/landing.ts`: `LandingDeps.treeRemoved?: (repoPath: string) => void` with the comment "a run worktree was removed: a land, a drop, an orphan's remove; the warm pool refills", called after each `removeRunTree`.
- Produces in `src/server/index.ts`: `ServerState.warm: WarmPool` after `landing`, built after the hub as

```ts
warm: new WarmPool({
  repos: () => state.result.repos.filter((r) => !r.host && r.path.startsWith("/")),
  want: async (path) => warmFor(await loadConfig(), path),
  setWant: (path, n) => setWarm(path, n),
  setup: (dir, line) => runGate(dir, line),
  landing: () => state.landing.info(),
  landingBusy: (path) => state.landing.info().entries.some((e) => e.repoPath === path && (e.state === "rebasing" || e.state === "landing")),
  removeOrphan: (dir) => state.landing.orphan(dir, "remove"),
  broadcast: (ev) => broadcast(state, ev),
}),
```

(use the file's late binding for `state`, as `landing`'s `repo` does); the hub's deps gain `treeRemoved: (path) => state.warm.poke(path)`. `cutBranch(repo, note, pr, pool: WarmPool)`: after `dir`, `name` and `base`, `const take = await pool.take(repo.path, dir, name, base)`; `addRunTree` runs only when `!take.took`. `prepare` says, first, `started in a warm worktree` when `take.took`, or `no warm worktree; setup ran` when `!take.took && take.wanted`; then the `gatesWhy` line as today; then `setup` runs when there is one and (`!take.took` or `take.setupAgain`). `addCanopyChecks` adds

```ts
state.health.add({ id: "canopy:worktrees", label: "worktrees", scope: canopy, heal: "button", every: 60_000, probe: () => state.warm.probe(), doHeal: async () => { await state.warm.prune(); } });
```

`adoptFlows` calls `await state.warm.adopt()` after the landing adopt; the handle chain gets `const worktreesRes = await state.warm.handle(req, url); if (worktreesRes) return worktreesRes;` after the landing line; `state.warm.start()` and `.stop()` beside the landing hub's. Rights in `core/callers.ts`: `worktrees/warm` joins the admin POST list at `:81` (it makes this machine run a repo's setup with nobody asked, as `keep` and `awake` change what runs here), and a new rule `{ methods: POST, paths: ["worktrees/prune"], right: "operate" }` after the `landing/*` rule, with the comment "prune removes what the landing section's remove already lets operate remove".

- [ ] **Step 1: Write the failing tests**

In `src/core/callers.test.ts`, after the sweep test:

```ts
test("worktree routes: the listing reads, warm is admin, prune operates", () => {
  expect(needs("GET", "/api/worktrees")).toBe("read");
  expect(needs("POST", "/api/worktrees/warm")).toBe("admin");
  expect(needs("POST", "/api/worktrees/prune")).toBe("operate");
  expect(allows("shell", needs("POST", "/api/worktrees/warm"))).toBe(false);
  expect(allows("shell", needs("POST", "/api/worktrees/prune"))).toBe(true);
  expect(allows("cli", needs("POST", "/api/worktrees/warm"))).toBe(true);
});
```

In `src/server/landing.test.ts`: `World` gains `treeRemoved: string[]`, the hub's deps `treeRemoved: (p) => w.treeRemoved.push(p)`, and, using the file's `world`, `readyRun` and `entryOf` helpers:

```ts
test("a land and a drop tell the pool which repo lost a worktree", async () => {
  const w = await world();
  await readyRun(w, "wt1", "b.txt", "b\n");
  await w.hub.land("wt1");
  await w.hub.idle();
  expect(entryOf(w, "wt1")?.state).toBe("landed");
  expect(w.treeRemoved).toEqual([w.repo.path]);
  await readyRun(w, "wt2", "c.txt", "c\n");
  await w.hub.drop("wt2");
  expect(w.treeRemoved).toEqual([w.repo.path, w.repo.path]);
});
```

In `src/server/health-canopy.test.ts`, beside the test that lists canopy's own checks, with the file's `one` and `until` helpers:

```ts
test("canopy:worktrees is kept, ok, with the counts and the free disk", async () => {
  const port = servers[0]!.port;
  await until(async () => (await one(port, "canopy:worktrees"))?.state === "ok", "the worktrees check");
  const c = (await one(port, "canopy:worktrees"))!;
  expect(c.heal).toBe("button");
  expect(c.detail).toMatch(/^0 run, 0 warm, \d+\.\d GB free$/);
});
```

(read the file's first test for how it starts a server and fills `servers`; copy that setup if this test runs first).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/callers.test.ts src/server/landing.test.ts src/server/health-canopy.test.ts`
Expected: FAIL on the three new tests.

- [ ] **Step 3: Implement the dep, the wiring, `cutBranch`'s take and the rules**

Update `cutBranch`'s and `startBranchRun`'s header comments: the run starts in a warm worktree when the pool has one. Add `treeRemoved` to no other hub in tests; it is optional.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/callers.test.ts src/server/landing.test.ts src/server/health-canopy.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/landing.ts src/server/landing.test.ts src/server/index.ts src/core/callers.ts src/core/callers.test.ts src/server/health-canopy.test.ts
git commit -m "feat(worktrees): a branch run starts in a warm worktree; the pool, its check and routes are wired in"
```

---

### Task 6: `canopy worktrees`

**Files:**
- Create: `src/cli/worktrees.ts`, `src/cli/worktrees.test.ts`
- Modify: `src/cli/index.ts:55` (the import), `:855` (a `case "worktrees"` beside `land`); `src/core/help.ts:87` (after the `canopy queue` line); `README.md:79` (after the `canopy queue` line)

**Interfaces:**
- Consumes: `ask`, `take`, `has`, `errText`, `Unreachable`, `Target` from `./health` as `src/cli/land.ts` does; `WorktreesInfo` from `core/types.ts`.
- Produces in `src/cli/worktrees.ts`:

```ts
export const WORKTREES_USAGE =
  "usage: canopy worktrees [repo] [--json] [--backend URL]\n       canopy worktrees warm <repo> [N] [--backend URL]\n       canopy worktrees prune [repo] [--backend URL]";
/** "2h", "3d", "5m", "now" */
export function ageWord(ms: number): string;
/** "312 MB", "1.2 GB" */
export function sizeWord(bytes: number): string;
/** The listing: a repo at a time (one with nothing is left out unless named), its runs, warm slots, failures and orphans, then the free disk. */
export function worktreeLines(info: WorktreesInfo, repo: string | null, now: number): string[];
export async function worktreesCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void>;
```

`worktreesCommand`: no subcommand reads `GET /api/worktrees` from the home backend and prints `worktreeLines` (or the JSON with `--json`); `warm <repo> [N]` posts `/api/worktrees/warm` and prints `<repo>: <want> warm`; `prune [repo]` posts `/api/worktrees/prune` and prints each removed path, or `nothing to prune`. `<repo>` is an id or a folder's name, as `canopy queue` takes it. The help and README lines:

```
canopy worktrees [repo] [--json]   # every run and warm worktree on the backend, the failed refills, the orphans and the free disk
canopy worktrees warm <repo> [N]   # keep N prepared worktrees for the repo on this machine; no N takes the gates file's warm
canopy worktrees prune [repo]      # remove orphans and stale warm trees and forget failed refills, so the pool tries again
```

- [ ] **Step 1: Write the failing tests in `src/cli/worktrees.test.ts`**

```ts
import { expect, test } from "bun:test";
import type { WorktreesInfo } from "../core/types";
import { ageWord, sizeWord, worktreeLines } from "./worktrees";

const H = 3_600_000;
const GB = 1024 ** 3;
const info: WorktreesInfo = {
  root: "/w",
  free: 42.1 * GB,
  repos: [
    {
      repoId: "dev-tools/canopy",
      repoPath: "/dev/dev-tools/canopy",
      want: 2,
      fileWarm: 1,
      runs: [{ dir: "/w/canopy-abc/ab12cd34", id: "ab12cd34", runId: "r1", branch: "run/fix-x-ab12cd34", state: "working" }],
      warm: [{ dir: "/w/canopy-abc/warm-1", name: "warm-1", base: "1ac8fe7deadbeef", madeAt: 1000 - 2 * H, size: 312 * 1048576, lockfile: null }],
      refilling: "warm-2",
      fails: [],
      orphans: ["/w/canopy-abc/zz"],
    },
    { repoId: "x", repoPath: "/dev/x", want: 1, runs: [], warm: [], refilling: null, fails: [{ name: "warm-1", why: "bun install exited 1", at: 5, fails: 2 }], orphans: [] },
    { repoId: "quiet", repoPath: "/dev/quiet", want: 0, runs: [], warm: [], refilling: null, fails: [], orphans: [] },
  ],
};

test("worktreeLines", () => {
  expect(worktreeLines(info, null, 1000)).toEqual([
    "dev-tools/canopy  2 warm wanted (the gates file says 1)",
    "  run     run/fix-x-ab12cd34  working  /w/canopy-abc/ab12cd34",
    "  warm    warm-1  1ac8fe7  2h  312 MB",
    "  warm    warm-2  refilling",
    "  orphan  /w/canopy-abc/zz",
    "x  1 warm wanted",
    "  warm    warm-1  failed 2x: bun install exited 1",
    "free 42.1 GB under /w",
  ]);
  expect(worktreeLines(info, "quiet", 1000)).toEqual(["quiet  nothing kept", "free 42.1 GB under /w"]);
  expect(worktreeLines(info, "canopy", 1000)[0]).toBe("dev-tools/canopy  2 warm wanted (the gates file says 1)");
});

test("ageWord and sizeWord", () => {
  expect([ageWord(10_000), ageWord(5 * 60_000), ageWord(2 * H), ageWord(72 * H)]).toEqual(["now", "5m", "2h", "3d"]);
  expect([sizeWord(312 * 1048576), sizeWord(1.2 * GB)]).toEqual(["312 MB", "1.2 GB"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/cli/worktrees.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/cli/worktrees.ts`, the `case`, the help and the README lines**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/cli/ ui/src/cli.test.ts && bun run typecheck && bun run lint`
Expected: PASS (the page's command line reads `HELP_TEXT`, so its test sees the new verb).

- [ ] **Step 5: Commit**

```bash
git add src/cli/worktrees.ts src/cli/worktrees.test.ts src/cli/index.ts src/core/help.ts README.md
git commit -m "feat(worktrees): canopy worktrees lists the pool, sets warm and prunes"
```

---

### Task 7: the landing section's warm line

**Files:**
- Modify: `ui/src/api.ts:816` (beside `landing`), `ui/src/store.ts:771` (the `landing` field), `:1159` (`loadLanding`'s type), `:2063` (the default), `:2499-2530` (a backend's removal), `:3034-3036` (the event), `:3460-3468` (`loadLanding`), `:1868`, `:2278`, `:2441` (where `loadLanding` is called); `ui/src/feed.ts:547` (the no-feed list); `ui/src/landing.ts:113-122` (beside `chipWords`), `ui/src/landing.test.ts`; `ui/src/components/Landing.tsx:80-112`

**Interfaces:**
- Consumes: `WorktreesInfo`, `WorktreeRepoInfo` from `src/core/types.ts`; Task 6's `ageWord` and `sizeWord` are the CLI's, so the page gets its own below.
- Produces in `ui/src/api.ts`: `worktrees: (b?: string) => Promise<WorktreesInfo>` reading `/api/worktrees`.
- Produces in `ui/src/store.ts`: `worktrees: Record<string, WorktreesInfo>` by backend, filled by the `worktrees` event and `loadWorktrees(backend?)`, called wherever `loadLanding` is and cleared with `landing` when a backend goes.
- Produces in `ui/src/landing.ts`:

```ts
/** the repo's pool entry across the shown backends, by its qualified id */
export function repoWorktrees(byBackend: Readonly<Record<string, WorktreesInfo>>, repoId: string): WorktreeRepoInfo | undefined;
/** the head's words: "1 warm", "1 of 2 warm, refilling", "0 of 1 warm, refill failed"; null when the repo keeps none */
export function warmWords(r: WorktreeRepoInfo | undefined): string | null;
/** one row per slot for the section: "warm-1 · 2h · 312 MB", "warm-2 · refilling", "warm-1 · refill failed: why" */
export function warmRows(r: WorktreeRepoInfo, now: number): { name: string; words: string; tone: "" | "rust" }[];
```

`repoWorktrees` qualifies each backend's `repoId` the way `landingAll` in the store qualifies the landing info (read it and copy the shape). In `Landing.tsx`, the section shows also when `warmWords` is not null; its head is `words` and the warm words joined by ` · `; the body ends with a `ul.landing-warm` of `warmRows`, each row `name` then `words` in `dim`, `rust` on a failure. No new CSS beyond reusing `.landing-list`'s row rules; read them first.

- [ ] **Step 1: Write the failing tests in `ui/src/landing.test.ts`**

```ts
describe("the warm pool in the section", () => {
  const r = (over: Partial<WorktreeRepoInfo> = {}): WorktreeRepoInfo => ({ repoId: "a", repoPath: "/r/a", want: 1, runs: [], warm: [], refilling: null, fails: [], orphans: [], ...over });
  const t = { dir: "/w/a/warm-1", name: "warm-1", base: "b", madeAt: 1000 - 2 * 3_600_000, size: 312 * 1048576, lockfile: null };
  test("warmWords", () => {
    expect(warmWords(undefined)).toBeNull();
    expect(warmWords(r({ want: 0 }))).toBeNull();
    expect(warmWords(r({ warm: [t] }))).toBe("1 warm");
    expect(warmWords(r({ want: 2, warm: [t], refilling: "warm-2" }))).toBe("1 of 2 warm, refilling");
    expect(warmWords(r({ fails: [{ name: "warm-1", why: "x", at: 1, fails: 1 }] }))).toBe("0 of 1 warm, refill failed");
  });
  test("warmRows", () => {
    expect(warmRows(r({ want: 2, warm: [t], refilling: "warm-2" }), 1000)).toEqual([
      { name: "warm-1", words: "2h · 312 MB", tone: "" },
      { name: "warm-2", words: "refilling", tone: "" },
    ]);
    expect(warmRows(r({ fails: [{ name: "warm-1", why: "bun install exited 1", at: 1, fails: 2 }] }), 1000)).toEqual([{ name: "warm-1", words: "refill failed: bun install exited 1", tone: "rust" }]);
  });
  test("repoWorktrees finds the repo by its qualified id", () => {
    const info: WorktreesInfo = { root: "/w", free: 1, repos: [r()] };
    expect(repoWorktrees({ home: info }, "a")?.repoPath).toBe("/r/a");
    expect(repoWorktrees({ home: info }, "zzz")).toBeUndefined();
  });
});
```

Qualify the id in the last test the way the file's landing tests do when the store prefixes ids.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/landing.test.ts`
Expected: FAIL on the new describe.

- [ ] **Step 3: Implement the helpers, the store, the api, the feed and the section**

- [ ] **Step 4: Run the tests, typecheck, lint and build**

Run: `bun test ui/src && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. Then look at it: a scratch server as the memory note "Scratch canopy server for UI checks" says, `canopy worktrees warm <repo> 1` against it, and the repo's landing section shows `1 warm` in its head and `warm-1 · 1m · 312 MB` as a row within a minute.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/store.ts ui/src/feed.ts ui/src/landing.ts ui/src/landing.test.ts ui/src/components/Landing.tsx
git commit -m "feat(worktrees): the landing section shows the repo's warm worktrees"
```

---

### Task 8: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:147` (the landing queue's first paragraph, where `startBranchRun` cuts the tree) and a new section before `## Triggers` at `:174`; `SPEC.md:57`; `README.md` (the landing queue's feature bullet, found with `grep -n "landing queue" README.md`); `FEATURES.md:40-43` and `:128`; `docs/superpowers/plans/README.md`; this plan's Status line

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 7, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

In the landing queue paragraph, after "hand the runner a `BranchStart`", one clause: `cutBranch` first asks the warm pool for a prepared tree (`WarmPool.take`), and the run's first note says which way it went. Then a new section `## Worktrees` before `## Triggers`, one paragraph starting "The warm pool (FR-039, plan 1).", saying: `warm` in `.canopy/gates.json` and the machine's own layer in the config (`warmFor`, `setWarm`), which alone acts; the slots `<configDir>/worktrees/<repo key>/warm-<n>` as detached worktrees at the default branch's tip with `setup` run, and `warm.json` beside them, written by the holder of the flows lock; `core/warm.ts` (the constants with their values, `nextRefill`, `staleWhy`, `overWant`, `reconcile`, `worktreesProbe`); `core/worktree.ts`'s `takeWarm` (`git worktree move` then `checkout -B`), `treeSize`, `midRebase`, and `listRunTreeDirs` leaving warm slots out; `server/warm.ts`'s `WarmPool` (the tick, one refill at a time, the holds for a busy queue and the disk floor, the fails and their retry, `take` with the lockfile stamp, `poke` from the landing hub's `treeRemoved`, `prune`, adopt's reconcile); the routes and their rights; the `worktrees` event; the `canopy:worktrees` check; the CLI; the section's line; and that the card's elsewhere list needs no change, since `elsewhereDetail` in `core/git.ts` already leaves every worktree under the worktrees root out. Say in one sentence that tasks, ports and compose stacks are plans 2 and 3.

- [ ] **Step 2: `SPEC.md`**

Line 57: extend the `worktrees/<repo key>/<id>/` entry to read `worktrees/<repo key>/<id>/` (branch runs' worktrees), `worktrees/<repo key>/warm-<n>/` (prepared worktrees the next branch run takes) and `worktrees/<repo key>/warm.json` (the pool's record, written only by the server holding the flows lock). Line 58: the `.canopy/gates.json` words gain "and warm count".

- [ ] **Step 3: `README.md`**

In the landing queue's feature bullet, one sentence: a repo with `setup` can keep prepared worktrees per machine (`canopy worktrees warm`), so a branch run starts without waiting on its install. The CLI lines were added in Task 6.

- [ ] **Step 4: `FEATURES.md` and the plans README**

Move the `### FR-039` block from `## Open` to the top of `## In Progress` and append to its Spec line: `Plan 1 shipped <date> (warm in gates.json, the machine's layer, WarmPool, the take in cutBranch, canopy worktrees, the canopy:worktrees check, the section's line); plans 2 (tasks and ports in worktrees) and 3 (compose stacks) open.` In `docs/superpowers/plans/README.md`, add the first row: `| [Worktree stacks, plan 1: a warm worktree pool per repo](2026-10-26-worktree-stacks-1.md) | shipped | <date> | [worktree stacks](../specs/2026-10-25-worktree-stacks-design.md) |` and set this plan's Status line to shipped with the merge commit.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "warmWords"` proves the served bundle is the new one.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md SPEC.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-worktree-stacks-1.md
git commit -m "docs(worktrees): architecture, SPEC, README and the feature list for plan 1"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) pointed at a throwaway repo that has a `bun.lock`, a `package.json` with a `test` script, and `.canopy/gates.json` as `{"gates": [], "setup": "bun install --frozen-lockfile", "warm": 1}` committed:

1. `canopy worktrees` lists the repo with `0 warm wanted (the gates file says 1)`; `canopy worktrees warm <repo>` prints `<repo>: 1 warm`.
2. Within a minute `canopy worktrees` shows `warm-1  <sha>  <age>  <size>`, and `ls ~/.config/<scratch>/worktrees/<repo key>/` shows `warm-1` and `warm.json`; `git -C <repo> worktree list` names it with no branch.
3. A propose branch run starts: its first note is `started in a warm worktree`, no `$ bun install --frozen-lockfile` line follows, `warm-1` is gone and is back within a minute; `canopy health` shows `canopy:worktrees` ok with `0 run, 1 warm, ... GB free` once the run lands.
4. Commit a changed `bun.lock` on main, start another branch run: the notes show `started in a warm worktree` then `$ bun install --frozen-lockfile`.
5. `canopy worktrees warm <repo> 0`: the slot is removed on the next tick, and the landing section's `1 warm` goes.
6. A shell token's `curl -X POST .../api/worktrees/warm` is a 403; `GET /api/worktrees` answers.

## Decisions this plan makes beyond the spec

- Only the machine's layer counts; the gates file's `warm` is the default `canopy worktrees warm <repo>` takes when `N` is omitted and is shown in the listing. The spec's call 3 says a clone's file must not make the mini run `setup` on its own; the ownership rule health uses would let it, since the mini's clones are Eric's, so the literal call wins.
- FR-036's governor is not shipped, so the refill's `low` lane has nowhere to go yet: refills run one at a time, never during `rebasing` or `landing`, and `tick` is where the governor's hold joins when its plan 1 lands.
- `LOCKFILES` is imported from `core/gates.ts`, where it lives; the spec names `core/review.ts`, which only imports it.
- A take uses `git worktree move` rather than a bare rename, so git's own record of the worktree follows the folder (P2, run on 2026-10-26: the branch moves, ignored files stay, `worktree list` names the new path). `freeBytes` is `statfs` from `node:fs/promises`, which Bun 1.4.4 answers (P5, same day), so no `df` is parsed.
- A failed refill is tried again every `WARM_RETRY` without end; health turns down at `WARM_FAILS` and the button's prune forgets the count, so the next tick tries at once.
- The run's note is said only when the repo wants warm trees, so every repo at the default prints nothing new.
- The sweep removes no worktrees today (its spec leaves stale worktrees to a later pass), so the refill's triggers are the landing hub's land, drop and orphan removal through `treeRemoved`, plus the take.
- Rights: the listing is `read`, `warm` is `admin` and `prune` is `operate`; the spec is silent on them.
- The landing section shows when the repo keeps warm trees even with nothing landing, so `1 warm` has somewhere to be, with one row per slot.
- The card's elsewhere list is left alone: `elsewhereDetail` already drops every worktree under `<configDir>/worktrees`, warm slots included, so the spec's line about it is true without a change.
