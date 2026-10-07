/* Words for a run in the UI, whichever agent does the work: its name in a
   heading, its word in a chip, and the footer's line, which says the
   tokens a run spent where the harness reports those (Codex) and what it
   cost where it reports a cost (Claude Code). Pure; tested in runs.test.ts. */

import { HARNESS } from "../../src/core/harness";
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

/** The console footer's line: turns and time, then the tokens where the
 *  harness reports those (Codex), else the cost where it reports one
 *  (Claude Code). A Codex result also carries a zero cost for pages older
 *  than harnesses, which the tokens win over. */
export function resultLine(r: RunResult): string {
  const parts = [`${r.turns} turn${r.turns === 1 ? "" : "s"}`, clock(r.durationMs)];
  if (r.tokens) parts.push(`${tokenCount(r.tokens.total)} tokens`);
  else if (r.costUsd !== undefined) parts.push(`$${r.costUsd.toFixed(2)}`);
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

/** A revise is a deny that carries a note. An empty one still says what it
 *  is, since a bare deny reads as the plan turned down. */
export const reviseAnswer = (note: string): RunAnswer => ({ kind: "deny", message: note.trim() || "Revise the plan." });
