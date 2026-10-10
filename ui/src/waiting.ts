/**
 * "Waiting on you": everything that needs the user in one dock panel. The
 * inbox's items come from `inboxItems` as they are; this holds the panel's
 * id and the pure lists beside them: the chats and terminal agents whose
 * turn it is, the repos that need attention and the runs and tasks that
 * failed. Tested in waiting.test.ts.
 */

import type { AgentCard, Ask, Repo, Run, TaskInfo } from "../../src/core/types";
import { cardName, repoOfCard, whereWord } from "./agentcards";
import { stateOf } from "./util";
import { isCliPanel } from "./cli";

/** The panel's id in the dock. Every other panel id is a repo's: a path
 *  relative to its scan root (`<source>:` ahead of it under an extra
 *  source, `<backend>|` under another backend), so a leading slash never
 *  names one, and with no `|` it never reads as another backend's. */
export const WAITING_PANEL = "/waiting";

export const isWaitingPanel = (id: string): boolean => id === WAITING_PANEL;

/** a dock panel that is no repo's: "waiting on you" or the command line's
 *  transcript. No scan prunes one, and neither pops out or takes a bench. */
export const isReservedPanel = (id: string): boolean => isWaitingPanel(id) || isCliPanel(id);

/** its mark, on its head, its tab and the top bar's button */
export const WAITING_GLYPH = "⚑";

/** the panel's foldable groups, top to bottom, under the panel's id in
 *  `closedSections` like a repo panel's sections */
export const WAITING_GROUPS = ["turn", "inbox", "repos", "failed", "unpushed", "behind"] as const;
export type WaitingGroup = (typeof WAITING_GROUPS)[number];

/** folded until the user opens them: unpushed commits and commits to pull
 *  wait without blocking anything, and a machine full of clones has dozens */
export const WAITING_FOLDED: readonly WaitingGroup[] = ["unpushed", "behind"];

export const WAITING_WORD: Record<WaitingGroup, string> = {
  turn: "your turn",
  inbox: "asks and prompts",
  repos: "repos",
  failed: "failed",
  unpushed: "unpushed",
  behind: "behind",
};

/** the states that need you, the most pressing first */
export const ATTENTION = ["conflict", "error", "dirty", "ahead"] as const;
export type Attention = (typeof ATTENTION)[number];

export const ATTENTION_WORD: Record<Attention, string> = {
  conflict: "conflict",
  error: "cannot read",
  dirty: "changes",
  ahead: "unpushed",
};

const isAttention = (v: string): v is Attention => (ATTENTION as readonly string[]).includes(v);

/** one repo that needs you, and why */
export interface AttentionRow {
  repo: Repo;
  state: Attention;
  /** a few words on what is there: "3 files", "↑2", git's error */
  detail: string;
}

/** what a row says beside its state */
function detailOf(repo: Repo, state: Attention): string {
  const files = repo.status?.files ?? [];
  const ahead = repo.status?.ahead ?? 0;
  if (state === "error") return repo.error ?? "";
  if (state === "conflict") {
    const n = files.filter((f) => f.conflicted).length;
    return `${n} conflicted file${n === 1 ? "" : "s"}`;
  }
  const parts: string[] = [];
  if (files.length > 0) parts.push(`${files.length} file${files.length === 1 ? "" : "s"}`);
  if (ahead > 0) parts.push(`↑${ahead}`);
  return parts.join(" · ");
}

/** The repos that need you, ranked conflict, error, changes, unpushed, and
 *  by name inside each; a forge-only repo has no checkout to need you. */
export function attentionRepos(repos: readonly Repo[]): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const repo of repos) {
    const state = stateOf(repo);
    if (isAttention(state)) rows.push({ repo, state, detail: detailOf(repo, state) });
  }
  return rows.sort(
    (a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state) || a.repo.name.localeCompare(b.repo.name) || a.repo.id.localeCompare(b.repo.id),
  );
}

/** something that failed and is still there to look at */
export type FailedRow =
  | { kind: "run"; id: string; repoId: string; what: string; at: number }
  | { kind: "task"; id: string; repoId: string; what: string; at: number };

/** The runs that failed and are not dismissed, less a flow's own steps
 *  (the flow speaks for them), and the tasks that failed or gave up
 *  restarting, newest first. */
export function failedRows(runs: readonly Run[], flowRuns: Readonly<Record<string, string>>, tasks: readonly TaskInfo[]): FailedRow[] {
  const out: FailedRow[] = [];
  for (const r of runs) {
    if (r.status !== "failed" || flowRuns[r.id] !== undefined) continue;
    out.push({ kind: "run", id: r.id, repoId: r.repoId, what: r.action, at: r.endedAt ?? r.startedAt });
  }
  for (const t of tasks) {
    if (t.status !== "failed" && t.status !== "gave-up") continue;
    out.push({ kind: "task", id: `${t.repoId}\u0000${t.name}`, repoId: t.repoId, what: t.name, at: t.exitedAt ?? t.startedAt ?? 0 });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** a row that holds unpushed commits and nothing more pressing */
export const isUnpushed = (row: Pick<AttentionRow, "state">): boolean => row.state === "ahead";

/** a clean checkout its upstream has moved past */
export interface BehindRow {
  repo: Repo;
  behind: number;
}

/** The checkouts with nothing of their own to lose and commits to pull, by
 *  name: no changes, nothing unpushed, no error, behind their upstream. One
 *  with work of its own is already a row above, where a pull is a choice to
 *  make in its panel, not a click. */
export function behindRepos(repos: readonly Repo[]): BehindRow[] {
  const rows: BehindRow[] = [];
  for (const repo of repos) {
    const behind = repo.status?.behind ?? 0;
    if (behind > 0 && stateOf(repo) === "clean") rows.push({ repo, behind });
  }
  return rows.sort((a, b) => a.repo.name.localeCompare(b.repo.name) || a.repo.id.localeCompare(b.repo.id));
}

/** The last paragraph the agent wrote in a run, on one line and without
 *  markdown's emphasis: where a chat hands over, it usually says what it
 *  wants. A subagent's words are its parent's business. */
export function lastWords(r: Pick<Run, "steps">): string {
  for (let i = r.steps.length - 1; i >= 0; i--) {
    const st = r.steps[i];
    if (!st || st.kind !== "text" || st.parent || !st.text?.trim()) continue;
    const para = st.text.trim().split(/\n\s*\n/).at(-1) ?? "";
    return para.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return "";
}

/** a chat or a terminal agent sitting on its prompt for the user */
export type TurnRow =
  | { kind: "chat"; id: string; repoId: string; what: string; at: number }
  | { kind: "agent"; id: string; repoId: string | null; name: string; where: string; what: string; at: number };

/**
 * Whose turn it is, the longest waiting first: canopy's chats between turns
 * (status "idle", less a flow's own steps), and the hooked agents whose
 * harness said it waits on the user (tailchan's "waiting", Claude's idle
 * prompt). A card for a canopy run is the run's, already here or in the
 * inbox, and a card with an open ask is the inbox's.
 */
export function turnRows(
  runs: readonly Run[],
  flowRuns: Readonly<Record<string, string>>,
  cards: readonly AgentCard[],
  asks: readonly Ask[],
  repos: readonly Repo[],
): TurnRow[] {
  const out: TurnRow[] = [];
  for (const r of runs) {
    if (r.status !== "idle" || flowRuns[r.id] !== undefined) continue;
    out.push({ kind: "chat", id: r.id, repoId: r.repoId, what: lastWords(r) || r.action, at: r.steps.at(-1)?.at ?? r.startedAt });
  }
  const asking = new Set(asks.filter((a) => a.state === "open").map((a) => a.agent));
  for (const c of cards) {
    if (c.state !== "waiting" || c.origin === "canopy-run" || asking.has(c.id)) continue;
    out.push({
      kind: "agent",
      id: c.id,
      repoId: repoOfCard(c, repos)?.id ?? null,
      name: cardName(c),
      where: whereWord(c),
      what: c.waiting ?? "your turn",
      at: c.seenAt,
    });
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
