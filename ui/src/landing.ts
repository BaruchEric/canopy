/** The landing queue as the page shows it: every backend's queue as one,
 *  a repo's part of it, a run's word and buttons, the card chip. Pure; the
 *  words for an entry's state are `core/landing.ts`'s, shared with the CLI. */

import { inQueue, landCounts, landWord, queueOf, sentBack } from "../../src/core/landing";
import type { LandEntry, LandingInfo, LandingOrphan, LandingRun, Run, RunAction } from "../../src/core/types";

export const EMPTY_LANDING: LandingInfo = { runs: [], entries: [], orphans: [] };

/** Every backend's queue as one; ids are already qualified per backend. */
export function mergeLanding(byBackend: Readonly<Record<string, LandingInfo>>): LandingInfo {
  const parts = Object.values(byBackend);
  if (parts.length === 1) return parts[0] ?? EMPTY_LANDING;
  return {
    runs: parts.flatMap((p) => p.runs),
    entries: parts.flatMap((p) => p.entries),
    orphans: parts.flatMap((p) => p.orphans),
  };
}

export interface RepoLanding {
  /** in the queue, in order */
  queue: LandEntry[];
  /** sent back, waiting for "fix it" */
  back: LandEntry[];
  /** landed lately, newest first */
  landed: LandEntry[];
  /** ready branch runs not in the queue yet: "land" applies */
  ready: LandingRun[];
  /** branch runs that are neither ready nor queued: working, uncommitted, stopped, nothing */
  other: LandingRun[];
}

/** One repo's part of the queue, for its landing section. */
export function repoLanding(info: LandingInfo, repoId: string): RepoLanding {
  const mine = info.entries.filter((e) => e.repoId === repoId);
  const has = new Set(mine.map((e) => e.id));
  const runs = info.runs.filter((r) => r.repoId === repoId && !has.has(r.id));
  return {
    queue: queueOf(info.entries, repoId),
    back: mine.filter(sentBack).sort((a, b) => a.updatedAt - b.updatedAt),
    landed: mine.filter((e) => e.state === "landed").sort((a, b) => (b.landedAt ?? 0) - (a.landedAt ?? 0)),
    ready: runs.filter((r) => r.state === "ready"),
    other: runs.filter((r) => r.state !== "ready").sort((a, b) => b.startedAt - a.startedAt),
  };
}

/** Whether a repo has anything for its landing section to show. */
export const hasLanding = (l: RepoLanding): boolean =>
  l.queue.length + l.back.length + l.landed.length + l.ready.length + l.other.length > 0;

/** The orphaned worktrees of one repo, by its main checkout's path. */
export const repoOrphans = (info: LandingInfo, repoPath: string): LandingOrphan[] => info.orphans.filter((o) => o.repoPath === repoPath);

/** The card chip's words, or null when the repo has nothing queued or sent back. */
export function chipWords(info: LandingInfo, repoId: string): { text: string; title: string; tone: "queued" | "back" } | null {
  const { queued, back } = landCounts(info.entries, repoId);
  if (queued + back === 0) return null;
  const parts = [queued ? `${queued} queued` : "", back ? `${back} sent back` : ""].filter(Boolean);
  return {
    text: parts.join(" · "),
    title: back ? "Branch runs the landing queue sent back; open the landing section to fix them" : "Branch runs waiting their turn to land on main",
    tone: back ? "back" : "queued",
  };
}

export interface RunLanding {
  /** the state in a few words: "ready", "queued 2nd", "gate: test", "landed" */
  word: string;
  /** the run's work can join the queue now */
  canLand: boolean;
  /** sent back: "fix it" applies */
  canFix: boolean;
  entry?: LandEntry;
}

const BRANCH_WORD: Record<NonNullable<Run["branch"]>["state"], string> = {
  working: "working",
  ready: "ready to land",
  uncommitted: "changes left uncommitted",
  nothing: "no commits",
  stopped: "stopped by a restart",
};

/** Where a branch run's work stands, for its sheet: the queue's word when
 *  it has an entry, else the branch's own. */
export function runLanding(run: Run, info: LandingInfo): RunLanding | null {
  const b = run.branch;
  if (!b) return null;
  const entry = info.entries.find((e) => e.id === b.origin);
  if (entry) {
    const fixing = entry.fixing !== undefined && entry.fixing !== run.id;
    return {
      word: fixing && sentBack(entry) ? `${landWord(entry, info.entries)}, a fix is going` : landWord(entry, info.entries),
      canLand: false,
      canFix: sentBack(entry) && entry.fixing === undefined,
      entry,
    };
  }
  const rec = info.runs.find((r) => r.id === b.origin);
  const state = rec && rec.runId === run.id ? rec.state : b.state;
  return { word: BRANCH_WORD[state], canLand: state === "ready" && run.status !== "working" && run.status !== "waiting" && run.status !== "idle", canFix: false };
}

/** Whether a new run starts on a branch unless the toggle says otherwise:
 *  propose does, every other action does not, and a workspace run never. */
export const branchByDefault = (action: RunAction, workspace?: string): boolean => action === "propose" && !workspace;

/** A sent-back entry's reason in one line, for a list. */
export function backLine(e: LandEntry): string {
  if (e.state === "red") return `${e.gate ?? "a gate"} failed`;
  return e.reason ?? e.state;
}

export { inQueue, landWord, sentBack };
