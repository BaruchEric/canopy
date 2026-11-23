/* Words for a run in the UI, whichever agent does the work: its name in a
   heading, its word in a chip, and the footer's line, which says the
   tokens a run spent where the harness reports those (Codex) and what it
   cost where it reports a cost (Claude Code). Pure; tested in runs.test.ts. */

import { HARNESS } from "../../src/core/harness";
import { runSubject } from "../../src/core/runname";
import { TODO_TOOLS } from "../../src/core/todos";
import type { Harness, ProposalState, Run, RunAnswer, RunResult, RunStep } from "../../src/core/types";

/** The harness a run is on. A run from a backend older than harnesses was
 *  Claude's, the only agent a run could be then. */
export const harnessOf = (run: { harness?: Harness }): Harness => run.harness ?? "claude";

/** The agent's name in a heading or a sentence. */
export const AGENT_NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** The agent's short word in a chip: "claude", "codex". */
export const agentWord = (h: Harness): string => HARNESS[h].label;

/** minutes and seconds, "3:07" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A token count at a glance: 950, 1.2k, 48k, 1.3M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The console footer's line: turns and time, then tokens and any reported
 *  dollars. Codex's compatibility zero is hidden when it also reports tokens. */
export function resultLine(r: RunResult): string {
  const parts = [`${r.turns} turn${r.turns === 1 ? "" : "s"}`, clock(r.durationMs)];
  if (r.tokens) parts.push(`${tokenCount(r.tokens.total)} tokens`);
  if (r.costUsd !== undefined && (!r.tokens || r.costUsd > 0)) parts.push(`$${r.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

/** A token breakdown for the footer's tooltip, or null without one. */
export function tokenTitle(r: RunResult): string | null {
  const t = r.tokens;
  if (!t) return null;
  return `${t.input} in (${t.cachedInput} cached), ${t.output} out (${t.reasoning} reasoning), ${t.total} in all`;
}

/* ---------- plan, then build ---------- */

export interface StepNode {
  step: RunStep;
  kids: RunStep[];
}

/** A subagent's steps under the Agent call that started it, so parallel
 *  subagents read as lanes rather than one interleaved list. */
export function nestSteps(steps: readonly RunStep[]): StepNode[] {
  const top: StepNode[] = [];
  const byId = new Map<string, StepNode>();
  for (const step of steps) {
    const home = step.parent ? byId.get(step.parent) : undefined;
    if (home) home.kids.push(step);
    else {
      const node: StepNode = { step, kids: [] };
      top.push(node);
      byId.set(step.id, node);
    }
  }
  return top;
}

/** The main thread's todo tool steps, gone when the checklist above says it
 *  better. A subagent's stay: its list never reaches the checklist. */
export const hideTodoSteps = (steps: readonly RunStep[], hasTodos: boolean): RunStep[] =>
  hasTodos ? steps.filter((x) => !(x.tool && !x.parent && TODO_TOOLS.has(x.tool.name))) : [...steps];

export type SettledProposal = Exclude<ProposalState, "waiting">;

/** How the latest proposal was settled, for the card above the timeline,
 *  or null: none yet, one still waiting (its form shows it), or a run from
 *  a backend that did not keep the state. */
export function settledProposal(run: Pick<Run, "proposal" | "proposalState" | "prompt">): SettledProposal | null {
  const state = run.proposalState;
  if (!run.proposal || !state || state === "waiting" || run.prompt?.kind === "proposal") return null;
  return state;
}

/** The chip's word for a working run: an approved proposal is building,
 *  whatever the action's own word ("planning") says. */
export const progressWord = (run: Pick<Run, "progress" | "proposalState">): string =>
  run.proposalState === "approved" || run.proposalState === "approved-auto" ? "building" : run.progress;

/** A commit or push that left git status exactly as it was: done, but not a
 *  done the card can show. */
export const ranUnchanged = (run: Pick<Run, "status" | "outcome" | "expectsChange">): boolean =>
  run.status === "done" && run.outcome === "unchanged" && run.expectsChange;

type Worded = Pick<Run, "status" | "outcome" | "expectsChange" | "verb" | "progress" | "proposalState"> & { harness?: Harness };

/** A run in a word, for its chip; `long` says the verb and the agent too,
 *  for the panel and for a list of runs. */
export function runWord(run: Worded, long = false): string {
  const verb = run.verb;
  if (ranUnchanged(run)) return long ? `${verb}: no change` : "no change";
  const who = agentWord(harnessOf(run));
  switch (run.status) {
    case "working":
      return long ? `${who} is ${progressWord(run)}` : `${progressWord(run)}…`;
    case "waiting":
      return long ? `${verb}: ${who} needs you` : "needs you";
    case "idle":
      return long ? "chat open, your turn" : "chat open";
    case "done":
      return long ? `${verb} done` : "done";
    case "limited":
      return long ? `${verb} waits for capacity` : "limited";
    case "failed":
      return long ? `${verb} failed` : "failed";
    default:
      return long ? `${verb} stopped` : "stopped";
  }
}

/** The live runs as the top bar's pill lists them: the ones waiting on an
 *  answer first, each lot in the order it came (newest first). */
export function pillRuns<R extends Pick<Run, "status">>(runs: readonly R[]): R[] {
  return [...runs.filter((r) => r.status === "waiting"), ...runs.filter((r) => r.status !== "waiting")];
}

/** The pill's own words: how many runs need an answer, else how many go.
 *  The agent is named while every run is on the same one; a mix is "runs". */
export function pillText(runs: readonly (Pick<Run, "status"> & { harness?: Harness })[]): string {
  const waiting = runs.filter((r) => r.status === "waiting").length;
  if (waiting > 0) return `${waiting} need${waiting === 1 ? "s" : ""} you`;
  const agents = new Set(runs.map(harnessOf));
  const [only] = agents;
  const who = agents.size === 1 && only ? `${agentWord(only)} ` : "";
  return `${runs.length} ${who}run${runs.length === 1 ? "" : "s"}`;
}

/** the most of a run's note a row of the pill's menu shows */
const NOTE_CUT = 72;

/** how long a run has gone: "just started", "12m", "3h 05m" */
function goneWord(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just started";
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** `text` cut to the most a row shows */
const cut = (text: string): string => (text.length > NOTE_CUT ? `${text.slice(0, NOTE_CUT - 1).trimEnd()}…` : text);

/** The line under a run's repo in the pill's menu, which is what tells two
 *  runs apart: its word, how long it has gone, and the name it goes by
 *  (FR-073), or the first line of what was asked of it while it has none. */
export function pillLine(run: Worded & Pick<Run, "startedAt" | "note" | "name">, now: number): string {
  // a backend older than notes sends none
  const asked = runSubject({ name: run.name, note: run.note ?? "" });
  const parts = [runWord(run, true), goneWord(now - run.startedAt)];
  if (asked) parts.push(cut(asked));
  return parts.join(" · ");
}

/* ---------- several runs on one repo (FR-073) ---------- */

/** a live run's dot wherever runs are listed, in the tones its chip has on
 *  a card: one that waits on an answer, a chat between turns; a run at work
 *  takes the list's own */
export const RUN_DOT: Partial<Record<Run["status"], string>> = { waiting: "dot lichen", idle: "dot moss" };

/** how much a live run wants a person: one waiting on an answer, then one
 *  at work, then a chat between turns */
const NEED: Partial<Record<Run["status"], number>> = { waiting: 2, working: 1 };

/** Whether `a` is the run a repo's one chip should show over `b`, both
 *  live: the one that needs a person more, the newer of two alike. */
export const needsMore = (a: Pick<Run, "status" | "startedAt">, b: Pick<Run, "status" | "startedAt">): boolean => {
  const na = NEED[a.status] ?? 0;
  const nb = NEED[b.status] ?? 0;
  return na !== nb ? na > nb : a.startedAt > b.startedAt;
};

type Live = Pick<Run, "id" | "status" | "chat" | "startedAt" | "branch">;

const newest = <R extends Live>(runs: readonly R[]): R | undefined => runs.reduce<R | undefined>((best, r) => (!best || r.startedAt > best.startedAt ? r : best), undefined);

/** The chat a message for a repo's agent goes into: the newest one between
 *  turns. None means a new chat starts with the message. */
export const chatToSay = <R extends Live>(live: readonly R[]): R | undefined => newest(live.filter((r) => r.chat && r.status === "idle"));

/** The chat a plain "chat" opens: the newest one going, whatever its turn. */
export const chatToShow = <R extends Live>(live: readonly R[]): R | undefined => newest(live.filter((r) => r.chat));

/** The runs at work in the repo's checkout, which a workflow started now
 *  would share it with. A chat between turns changes nothing until it is
 *  spoken to, and a run on a branch has a worktree of its own. */
export const runsAtWork = <R extends Live>(live: readonly R[]): R[] => live.filter((r) => !r.branch && r.status !== "idle");

/** What a workflow's plan sheet says of the runs at work in the checkout it
 *  is about to share (FR-073), by the names they go by; null for none. */
export function flowBesideRuns(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return names.length === 1
    ? `A run is at work in this checkout (${names[0]}). The workflow starts beside it, and its steps and checks see that run's changes, finished or not.`
    : `${names.length} runs are at work in this checkout (${names.join(", ")}). The workflow starts beside them, and its steps and checks see their changes, finished or not.`;
}

/** What a run's plan sheet says of the workflow going in the checkout it is
 *  about to share (FR-073). */
export const runBesideFlow = (verb: string, where = "this checkout"): string =>
  `The ${verb} workflow is going in ${where}. This run starts beside it, and the workflow's checks see what the run changes.`;

/** What a job's or a chat's pre-flight says when its branch box came ticked
 *  because the checkout is in use (FR-080). */
export const OWN_BRANCH_NOTE =
  "This checkout is in use, so the run starts in a worktree of its own, on a branch the landing queue lands on main once you say land. Untick the box to work in the checkout beside what is going there.";

/** What the pre-flight says of a chat on a branch with nothing typed yet:
 *  its branch and its work item are named from the first message. */
export const CHAT_BRANCH_HINT = "A chat on a branch of its own starts from its first message. Say what it is for.";

/** What a run's own panel or tab is called: the name it goes by, or its
 *  verb while it has none, and its repo. */
export const runPanelLabel = (run: Pick<Run, "verb" | "name">, repoName: string): string => `${run.name ?? run.verb} · ${repoName}`;

/** the most of a run's name a chip in a row of chips shows */
const CHIP_NAME_CUT = 32;

/** A run's name for a chip that says one: the name it goes by, or the
 *  first line of what was asked, cut short. "" for a run with neither. */
export function chipName(run: Pick<Run, "note" | "name">): string {
  const subject = runSubject({ name: run.name, note: run.note ?? "" });
  return subject.length > CHIP_NAME_CUT ? `${subject.slice(0, CHIP_NAME_CUT - 1).trimEnd()}…` : subject;
}

/** The tooltip's line for the runs a chip counts but does not show. */
export function moreTitle(more: readonly Pick<Run, "status" | "verb" | "note" | "name">[]): string {
  const rows = more.map((r) => {
    const row = menuRun(r);
    return row.fact === "show" ? row.text : `${row.text} (${row.fact})`;
  });
  return `also going here: ${rows.join("; ")}`;
}

/** A live run's row in its repo's menu: the name it goes by with its verb
 *  and state beside it, or the old words for a run with nothing to call it. */
export function menuRun(run: Pick<Run, "status" | "verb" | "note" | "name">): { text: string; fact: string } {
  const subject = runSubject({ name: run.name, note: run.note ?? "" });
  if (!subject) {
    const text = run.status === "waiting" ? `${run.verb} needs you` : run.status === "idle" ? "chat open, your turn" : `${run.verb} in progress`;
    return { text, fact: "show" };
  }
  const state = run.status === "waiting" ? "needs you" : run.status === "idle" ? "your turn" : "working";
  // short, since the fact shares the row with the name and the name is what tells runs apart
  return { text: cut(subject), fact: `${run.verb}, ${state}` };
}

/** A revise is a deny that carries a note. An empty one still says what it
 *  is, since a bare deny reads as the plan turned down. */
export const reviseAnswer = (note: string): RunAnswer => ({ kind: "deny", message: note.trim() || "Revise the plan." });
