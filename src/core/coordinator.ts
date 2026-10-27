/** The coordinator's pure half (FR-010): checking a plan it proposes, which
 *  queued cards start now, and the note a settled child sends back into its
 *  chat. Browser-safe: the hub in `server/coordinator.ts` keeps the state
 *  and calls these, and the UI may name a card's outcome with them. */

import { inQueue, landWord, sentBack } from "./landing";
import { isRunActive, type CoordTask, type LandEntry, type ReviewVerdict, type Run, type RunBranchState } from "./types";

/** tasks one plan call may add */
export const MAX_PLAN = 8;
/** tasks one coordinator may hold in all */
export const MAX_TASKS = 20;
/** children working at once per coordinator: the fleet's cap (FLEET_CONCURRENCY) */
export const COORD_AT_ONCE = 3;
export const MAX_TITLE = 120;
export const MAX_NOTE = 4000;
/** the characters of a child's result line a settle note keeps */
export const RESULT_CHARS = 600;

/** A card as the coordinator proposes it, before canopy numbers it. */
export type PlannedTask = Omit<CoordTask, "id" | "state">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One text field of a task, trimmed, or why it cannot be. */
function text(t: Record<string, unknown>, at: string, field: "title" | "note", max: number): string | { error: string } {
  const v = t[field];
  if (typeof v !== "string") return { error: `${at}.${field} must be text` };
  const s = v.trim();
  if (!s) return { error: `${at}.${field} is empty` };
  if (s.length > max) return { error: `${at}.${field} is over ${max} characters` };
  return s;
}

/** A plan's tasks off the wire, checked against the limits: at most 8 in a
 *  call and 20 in all (`have` is how many the coordinator holds already), a
 *  title of at most 120 characters, a note of at most 4000, `propose` or
 *  `ask`, and a repo this backend knows on this machine. An error names the
 *  task's index and the field, so the coordinator can fix its plan. */
export function validatePlan(
  input: unknown,
  ctx: { known: (repo: string) => "local" | "remote" | null; have: number },
): { tasks: PlannedTask[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "tasks must be a list" };
  if (input.length === 0) return { error: "a plan needs at least one task" };
  if (input.length > MAX_PLAN) return { error: `at most ${MAX_PLAN} tasks per plan; this one has ${input.length}` };
  if (ctx.have + input.length > MAX_TASKS) {
    return { error: `a coordinator holds at most ${MAX_TASKS} tasks; it has ${ctx.have} and this plan adds ${input.length}` };
  }
  const tasks: PlannedTask[] = [];
  for (const [i, t] of input.entries()) {
    const at = `tasks[${i}]`;
    if (!isRecord(t)) return { error: `${at} must be an object` };
    const title = text(t, at, "title", MAX_TITLE);
    if (typeof title !== "string") return title;
    const note = text(t, at, "note", MAX_NOTE);
    if (typeof note !== "string") return note;
    const repo = t["repo"];
    if (typeof repo !== "string" || !repo) return { error: `${at}.repo must be a repo id` };
    const where = ctx.known(repo);
    if (where === null) return { error: `${at}.repo: no repo ${repo} on this backend` };
    if (where === "remote") return { error: `${at}.repo: ${repo} is on another host; a task runs in a local repo` };
    const action = t["action"];
    if (action !== "propose" && action !== "ask") return { error: `${at}.action must be propose or ask` };
    tasks.push({ title, repo, note, action });
  }
  return { tasks };
}

/** The queued cards to start now, in order, without passing 3 working. A
 *  card whose repo has no branch slot free waits for this pass, and a later
 *  card in another repo may go ahead of it. `repoFull` is read once per
 *  card, so two cards in a repo with one slot left both come back: the
 *  caller starts them one at a time and leaves a card queued when its start
 *  finds the repo full after all. */
export function nextToStart(tasks: readonly CoordTask[], ctx: { working: number; repoFull: (repo: string) => boolean }): CoordTask[] {
  const out: CoordTask[] = [];
  for (const t of tasks) {
    if (ctx.working + out.length >= COORD_AT_ONCE) break;
    if (t.state === "queued" && !ctx.repoFull(t.repo)) out.push(t);
  }
  return out;
}

/** What the landing queue and the PR watch know of a child's branch, read
 *  by the hub when the child settles. */
export interface ChildLanding {
  /** the branch's queue entry, once it has one */
  entry?: LandEntry;
  /** every entry, for the entry's place in its queue ("queued 2nd") */
  entries?: readonly LandEntry[];
  /** the PR the branch opened, by its address */
  prUrl?: string;
}

/** How a child settled, in the words a card and its note use. */
export type ChildOutcomeWord = "landed" | "ready" | "PR opened" | "sent back" | "failed" | "stopped" | "uncommitted" | "plan turned down" | "no change" | "waiting for capacity";

/** A settled child as its card's state and outcome word. Null while the
 *  child is going, or ended with its branch still being read (its first
 *  change after the end still says `working`; the next one has the state).
 *  The queue's word beats the branch's once the branch has an entry: landed
 *  is done, sent back failed, and a ready branch with a PR open is done. A
 *  branch with nothing on it is done, since an ask may only answer, unless
 *  Eric turned its plan down; one left uncommitted failed. A limited run
 *  settles as waiting for capacity before its branch can read as success. */
export function childOutcome(run: Run, landing: ChildLanding = {}): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  if (isRunActive(run)) return null;
  if (run.status === "failed") return { state: "failed", outcome: "failed" };
  if (run.status === "stopped") return { state: "failed", outcome: "stopped" };
  if (run.status === "limited") return { state: "failed", outcome: "waiting for capacity" };
  const b = run.branch?.state ?? "nothing";
  if (b === "working") return null;
  const e = landing.entry;
  if (e?.state === "landed") return { state: "done", outcome: "landed" };
  if (e && sentBack(e)) return { state: "failed", outcome: "sent back" };
  if (b === "ready" && landing.prUrl) return { state: "done", outcome: "PR opened" };
  if (b === "ready") return { state: "done", outcome: "ready" };
  if (b === "uncommitted") return { state: "failed", outcome: "uncommitted" };
  if (b === "stopped") return { state: "failed", outcome: "stopped" };
  if (run.proposalState === "turned down") return { state: "failed", outcome: "plan turned down" };
  return { state: "done", outcome: "no change" };
}

/** What the hub reads of a child's branch: the queue's entry and the PR as
 *  `ChildLanding` has them, the sort's verdict once the landing queue has
 *  sorted the branch, and whether the branch opens a PR in place of the
 *  queue. */
export interface ChildBranch extends ChildLanding {
  verdict?: ReviewVerdict;
  openPr?: boolean;
}

/** Whether a child has settled for its card and its note, and how. A child
 *  that failed, stopped, or left its branch uncommitted or empty settles
 *  the moment its branch is read. A ready branch is handed to the landing
 *  queue, so its card waits for the queue's last word: landed, sent back,
 *  or a PR open. It also settles as `ready` once the sort leaves it to
 *  Eric (a `land` or `approve` verdict, so nothing lands it on its own),
 *  or once `overdue` (the sort failed or the PR never opened). An `auto`
 *  verdict with no entry yet waits, since the queue takes it next, and an
 *  entry still in the queue waits however long it takes. Null while it
 *  should wait. */
export function childSettled(run: Run, b: ChildBranch, overdue: boolean): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  const out = childOutcome(run, b);
  if (!out || out.outcome !== "ready") return out;
  if (b.entry && inQueue(b.entry)) return null;
  if (overdue) return out;
  if (b.openPr || b.verdict === undefined || b.verdict === "auto") return null;
  return out;
}

/** The note a card that could not start sends into the chat. */
export function startNote(task: CoordTask, error: string): string {
  return [
    "canopy: a task you started could not start",
    `task ${task.id}: ${task.title} (repo ${task.repo})`,
    "outcome: failed",
    `result: ${oneLine(error) || "(none)"}`,
  ].join("\n");
}

/** a branch's own state in words, as the run sheet says it */
const BRANCH_WORD: Record<RunBranchState, string> = {
  working: "working",
  ready: "ready to land",
  uncommitted: "changes left uncommitted",
  nothing: "no commits",
  stopped: "stopped by a restart",
};

/** a result on one line, cut to `RESULT_CHARS` with an ellipsis */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > RESULT_CHARS ? `${flat.slice(0, RESULT_CHARS - 1)}…` : flat;
}

/** The user message a settled child sends into its coordinator's chat: the
 *  card, how it went, the child's result line (its error when it has none),
 *  and where its work is: the PR's address, or the branch and its landing
 *  state. */
export function settleNote(task: CoordTask, run: Run, landing: ChildLanding = {}): string {
  const how = childOutcome(run, landing);
  const result = run.status === "limited"
    ? run.limited?.text?.trim() || run.error?.trim() || run.result?.text?.trim() || ""
    : run.result?.text?.trim() || run.error?.trim() || "";
  const lines = [
    "canopy: a task you started has settled",
    `task ${task.id}: ${task.title} (repo ${task.repo})`,
    `outcome: ${how?.outcome ?? run.status}`,
    `result: ${result ? oneLine(result) : "(none)"}`,
  ];
  if (landing.prUrl) lines.push(`PR: ${landing.prUrl}`);
  else if (run.branch) {
    const e = landing.entry;
    lines.push(`branch: ${run.branch.name}, ${e ? landWord(e, landing.entries ?? [e]) : BRANCH_WORD[run.branch.state]}`);
  }
  return lines.join("\n");
}
