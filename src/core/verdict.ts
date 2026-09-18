/** The verdict gate: what a step's closing summary is asked, and what the
 *  answers mean. Pure and browser-safe; jev.ts is the evaluator. */

import type { Verdict, VerdictAnswers } from "./types";

export const VERDICT_QUESTIONS = {
  outcome: {
    type: "choice",
    instructions: "Did the step finish its task?",
    criteria: {
      done: "The task is complete and the summary reports what was done",
      partial: "Some of the task was done and the rest was left, deferred, or explained away",
      blocked: "Nothing or almost nothing was done because of an error, a conflict, or a missing decision",
    },
  },
  needsYou: {
    type: "boolean",
    instructions: "Does the summary ask the user to decide, confirm, or check something before going on?",
  },
  offScope: {
    type: "boolean",
    instructions: "Did the step touch anything outside the repository, or do something beyond what the task asked?",
  },
} as const;

export const THRESHOLDS = {
  /** the done choice needs at least this much probability */
  done: 0.7,
  needsYou: 0.5,
  offScope: 0.5,
} as const;

/** The gate's decision. Continue only when done is confident and nothing
 *  points back at the user. */
export function decide(answers: VerdictAnswers): Verdict {
  const { outcome, needsYou, offScope } = answers;
  const park = (reason: string): Verdict => ({ answers, go: false, reason });
  if (offScope.probability >= THRESHOLDS.offScope) {
    return park("the step seems to have gone outside its task or the repository");
  }
  if (needsYou.probability >= THRESHOLDS.needsYou) {
    return park("the summary asks you something");
  }
  if (outcome.choice === "partial") return park("the step got only partly done");
  if (outcome.choice === "blocked") return park("the step was blocked");
  const p = outcome.probabilities?.[outcome.choice] ?? 1;
  if (p < THRESHOLDS.done) return park("not sure the step is really done");
  return { answers, go: true, reason: null };
}

/** The text the classifier reads: the summary, the check's output when a
 *  check ran, and whether git status moved when that is known. */
export function verdictState(input: {
  summary: string;
  check: string | null;
  changed: boolean | null;
}): string {
  const parts = [`Step summary:\n${input.summary.trim() || "(no summary)"}`];
  if (input.check !== null) parts.push(`Check output:\n${input.check.trim() || "(empty)"}`);
  if (input.changed !== null) parts.push(`git status changed during the step: ${input.changed ? "yes" : "no"}`);
  return parts.join("\n\n");
}
