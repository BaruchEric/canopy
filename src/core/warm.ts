/** The warm worktree pool's pure model: slot names, persisted records,
 *  refill selection and the canopy:worktrees probe. The server owns disk and
 *  git operations; this file stays browser-safe. */

import type { ProbeResult } from "./health";
import type { LockfileStamp, WorktreesInfo } from "./types";

export const WARM_MAX = 2;
export const WARM_BEHIND = 20;
export const WARM_AGE = 24 * 3_600_000;
export const WARM_AT_ONCE = 1;
export const WARM_RETRY = 10 * 60_000;
export const WARM_FAILS = 3;
export const WORKTREE_DISK_MIN = 5 * 1024 ** 3;
/** milliseconds between the pool's ticks */
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

export const EMPTY_RECORD: WarmRecord = { trees: [], fails: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isByteCount = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === "number" && value >= 0;

/** `warm-1`, `warm-2`, ...; never `warm-0`. */
export const warmName = (n: number): string => `warm-${n}`;

/** Whether a final directory name is a warm slot. */
export const isWarmName = (name: string): boolean => /^warm-[1-9]\d*$/.test(name);

function slotNumber(dir: string): number | null {
  const name = dir.split(/[\\/]/).at(-1) ?? "";
  if (!isWarmName(name)) return null;
  const n = Number(name.slice("warm-".length));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isLockfileStamp(value: unknown): value is LockfileStamp {
  if (!isRecord(value)) return false;
  return isNonemptyString(value["name"]) && isByteCount(value["size"]) && isFiniteNumber(value["mtime"]);
}

function isWarmTree(value: unknown): value is WarmTree {
  if (!isRecord(value)) return false;
  return (
    typeof value["dir"] === "string" && slotNumber(value["dir"]) !== null &&
    isNonemptyString(value["base"]) &&
    (value["lockfile"] === null || isLockfileStamp(value["lockfile"])) &&
    isFiniteNumber(value["madeAt"]) && value["madeAt"] >= 0 &&
    isByteCount(value["size"])
  );
}

function isWarmFail(value: unknown): value is WarmFail {
  if (!isRecord(value)) return false;
  return (
    typeof value["dir"] === "string" && slotNumber(value["dir"]) !== null &&
    isNonemptyString(value["why"]) &&
    isFiniteNumber(value["at"]) && value["at"] >= 0 &&
    Number.isSafeInteger(value["fails"]) && typeof value["fails"] === "number" && value["fails"] > 0
  );
}

/** `warm.json` text; malformed or overlarge records are treated as empty. */
export function parseWarmRecord(text: string): WarmRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_RECORD;
  }
  if (!isRecord(raw) || !Array.isArray(raw["trees"]) || !Array.isArray(raw["fails"])) return EMPTY_RECORD;

  const treeValues: unknown[] = raw["trees"];
  const failValues: unknown[] = raw["fails"];
  if (treeValues.length > WARM_MAX || failValues.length > WARM_MAX) return EMPTY_RECORD;

  const trees: WarmTree[] = [];
  for (const value of treeValues) {
    if (!isWarmTree(value)) return EMPTY_RECORD;
    trees.push({
      dir: value.dir,
      base: value.base,
      lockfile: value.lockfile === null ? null : { name: value.lockfile.name, size: value.lockfile.size, mtime: value.lockfile.mtime },
      madeAt: value.madeAt,
      size: value.size,
    });
  }

  const fails: WarmFail[] = [];
  for (const value of failValues) {
    if (!isWarmFail(value)) return EMPTY_RECORD;
    fails.push({ dir: value.dir, why: value.why, at: value.at, fails: value.fails });
  }

  const dirs = [...trees.map((tree) => tree.dir), ...fails.map((failure) => failure.dir)];
  if (new Set(dirs).size !== dirs.length) return EMPTY_RECORD;
  return { trees, fails };
}

/** Compare the lockfile identity captured at refill with the current one. */
export function sameStamp(a: LockfileStamp | null, b: LockfileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.size === b.size && a.mtime === b.mtime;
}

/** Why a tree should be cut again, or null when it is current. */
export function staleWhy(t: Pick<WarmTree, "madeAt">, now: number, behind: number): string | null {
  if (Number.isFinite(behind) && behind >= WARM_BEHIND) return `${WARM_BEHIND} commits behind`;
  if (!Number.isFinite(now) || !Number.isFinite(t.madeAt)) return null;
  const hours = Math.floor((now - t.madeAt) / 3_600_000);
  return hours >= WARM_AGE / 3_600_000 ? `${hours}h old` : null;
}

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

interface RefillSlot {
  n: number;
  dir: string;
  tree: WarmTree | undefined;
  failure: WarmFail | undefined;
}

function isWarmCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= WARM_MAX;
}

/** The next slot to cut, preferring empty slots, then due retries, then stale trees. */
export function nextRefill(p: RefillInput): { n: number; dir: string; why: string } | null {
  if (!isWarmCount(p.want) || p.want === 0 || p.refilling || p.busy || !Number.isFinite(p.free) || p.free < WORKTREE_DISK_MIN) return null;

  const slots: RefillSlot[] = Array.from({ length: p.want }, (_, i) => {
    const n = i + 1;
    const dir = p.dirOf(n);
    return {
      n,
      dir,
      tree: p.record.trees.find((item) => item.dir === dir),
      failure: p.record.fails.find((item) => item.dir === dir),
    };
  });

  const empty = slots.find((slot) => !slot.tree && !slot.failure);
  if (empty) return { n: empty.n, dir: empty.dir, why: "empty" };

  const retry = slots.find((slot) => !slot.tree && slot.failure && p.now - slot.failure.at >= WARM_RETRY);
  if (retry) return { n: retry.n, dir: retry.dir, why: "retry after a failure" };

  for (const slot of slots) {
    if (!slot.tree) continue;
    const why = p.stale(slot.tree);
    if (why) return { n: slot.n, dir: slot.dir, why };
  }
  return null;
}

/** Trees in slots beyond the machine's current count. */
export function overWant(record: WarmRecord, want: number, dirOf: (n: number) => string): WarmTree[] {
  if (!isWarmCount(want)) return [];
  return record.trees.filter((tree) => {
    const n = slotNumber(tree.dir);
    return n !== null && n > want && dirOf(n) === tree.dir;
  });
}

/** Square the record with the on-disk warm folders at adopt. */
export function reconcile(record: WarmRecord, onDisk: readonly string[]): { record: WarmRecord; remove: string[] } {
  const diskDirs = [...new Set(onDisk.filter((dir) => slotNumber(dir) !== null))];
  const disk = new Set(diskDirs);
  const recordedTrees = record.trees.filter((tree) => slotNumber(tree.dir) !== null);
  const recorded = new Set(recordedTrees.map((tree) => tree.dir));
  return {
    record: { trees: recordedTrees.filter((tree) => disk.has(tree.dir)), fails: record.fails },
    remove: diskDirs.filter((dir) => !recorded.has(dir)),
  };
}

/** The canopy:worktrees check's answer from the listing. */
export function worktreesProbe(info: WorktreesInfo): ProbeResult {
  const runs = info.repos.reduce((count, repo) => count + repo.runs.length, 0);
  const warm = info.repos.reduce((count, repo) => count + repo.warm.length, 0);
  const failures = info.repos.reduce((count, repo) => count + repo.fails.length, 0);
  const gb = (info.free / 1024 ** 3).toFixed(1);
  const detail = `${runs} run, ${warm} warm${failures === 0 ? "" : `, ${failures} refill${failures === 1 ? "" : "s"} failed`}, ${gb} GB free`;

  if (info.free < WORKTREE_DISK_MIN) {
    return { state: "down", why: `${gb} GB free under ${info.root}; warm worktrees are not refilled under 5 GB`, detail };
  }
  for (const repo of info.repos) {
    const failure = repo.fails.find((item) => item.fails >= WARM_FAILS);
    if (failure) {
      return {
        state: "down",
        why: `${repo.repoId}'s warm worktree failed to refill ${failure.fails} times: ${failure.why}`,
        detail,
      };
    }
  }
  return { state: "ok", detail };
}
