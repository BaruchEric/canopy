/** The landing queue as the page shows it: every backend's queue as one,
 *  a repo's part of it, a run's word and buttons, the card chip. Pure; the
 *  words for an entry's state are `core/landing.ts`'s, shared with the CLI. */

import { inQueue, landAllPick, landCounts, landWord, queueOf, reviewWord, sentBack, stoppedWhole } from "../../src/core/landing";
import type { LandEntry, LandingInfo, LandingOrphan, LandingRun, LandNotice, ReviewFile, Run, RunAction } from "../../src/core/types";

export const EMPTY_LANDING: LandingInfo = { runs: [], entries: [], orphans: [], notices: [] };

/** Every backend's queue as one; ids are already qualified per backend. */
export function mergeLanding(byBackend: Readonly<Record<string, LandingInfo>>): LandingInfo {
  const parts = Object.values(byBackend);
  if (parts.length === 1) return parts[0] ?? EMPTY_LANDING;
  return {
    runs: parts.flatMap((p) => p.runs),
    entries: parts.flatMap((p) => p.entries),
    orphans: parts.flatMap((p) => p.orphans),
    notices: parts.flatMap((p) => p.notices ?? []).sort((a, b) => b.at - a.at),
  };
}

/** A ready run's verdict in words; "sorting" until its sort is in. */
export const verdictWord = (r: Pick<LandingRun, "review">): string => (r.review ? reviewWord(r.review) : "sorting");

/** Whether a ready run's land goes through the approve sheet. */
export const needsApproval = (r: Pick<LandingRun, "review">): boolean => r.review?.verdict === "approve";

/** The verdict's tone in the list: moss lands on its own, rust needs a look. */
export const verdictTone = (r: Pick<LandingRun, "review">): "moss" | "lichen" | "rust" =>
  r.review?.verdict === "auto" ? "moss" : r.review?.verdict === "approve" ? "rust" : "lichen";

/** The ready runs "land all" would take in a repo, and the ones it leaves
 *  for an approval; the button shows with two or more ready. */
export const landAllOf = (info: LandingInfo, repoId: string) => landAllPick(info.runs, info.entries, repoId);

/** The title of a stopped run's land, in the list and its sheet. */
export const stoppedLandTitle = (target: string): string =>
  `A restart stopped this run with its work committed. Land it and its commits go through the gates like any other: rebase onto ${target}, the gates, then a fast-forward of ${target}; nothing is pushed`;

/** The files the approve sheet lists first: the sensitive ones, or every
 *  file when the rules are broken and none can be called safe. */
export function approveFiles(r: Pick<LandingRun, "review">): { look: ReviewFile[]; rest: ReviewFile[] } {
  const files = r.review?.files ?? [];
  const sensitive = files.filter((f) => f.sensitive);
  if (sensitive.length === 0) return { look: files, rest: [] };
  return { look: sensitive, rest: files.filter((f) => !f.sensitive) };
}

/** A notice in one line: "run/x landed on its own at abc1234". */
export function noticeLine(n: LandNotice): string {
  return n.kind === "landed" ? `${n.branch} landed on its own${n.head ? ` at ${n.head.slice(0, 7)}` : ""}` : `${n.branch} held back: ${n.why ?? "its sort changed"}`;
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
  /** a ready run's verdict in words, once sorted */
  verdict?: string;
  /** its land opens the approve sheet */
  approve?: boolean;
  /** a restart stopped it: its land says so */
  stopped?: boolean;
  /** why a run a restart stopped cannot land */
  why?: string;
}

const BRANCH_WORD: Record<NonNullable<Run["branch"]>["state"], string> = {
  working: "working",
  ready: "ready to land",
  uncommitted: "changes left uncommitted",
  nothing: "no commits",
  stopped: "stopped by a restart",
};

/** Where a branch run's work stands, for its sheet: the queue's word when
 *  it has an entry, else the branch's own. A run a restart stopped lands
 *  as a ready one does once the hub found its work whole. */
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
  const stopped = state === "stopped" && rec !== undefined && stoppedWhole(rec);
  // a page that missed the restart may still hold the run as working; the hub's stopped says it ended
  const canLand = stopped || (state === "ready" && run.status !== "working" && run.status !== "waiting" && run.status !== "idle");
  const sorted = canLand && rec?.review ? { verdict: verdictWord(rec), approve: needsApproval(rec) } : {};
  const whole = state === "stopped" && rec?.whole && !rec.whole.ok ? { why: rec.whole.why } : {};
  return { word: BRANCH_WORD[state], canLand, canFix: false, ...sorted, ...(canLand && stopped ? { stopped: true } : {}), ...whole };
}

/** Whether a new run starts on a branch unless the toggle says otherwise:
 *  propose does, every other action does not, and a workspace run never. */
export const branchByDefault = (action: RunAction, workspace?: string): boolean => action === "propose" && !workspace;

/** A sent-back entry's reason in one line, for a list. */
export function backLine(e: LandEntry): string {
  if (e.state === "red") return `${e.gate ?? "a gate"} failed`;
  return e.reason ?? e.state;
}

export { inQueue, landWord, sentBack, stoppedWhole };
