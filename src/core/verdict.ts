/** The verdict gate: what a step's closing summary is asked, and what the
 *  answers mean. Pure and browser-safe; jev.ts is the evaluator. */

import type { EvidenceFile, JudgeAnswers, Judgment, Verdict, VerdictAnswers } from "./types";

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

/** What a judge gate asks: whether the work is right, not whether the step
 *  finished. A deploy touches the world outside the repo by design, which
 *  the verdict's off-scope question would park. */
export const JUDGE_QUESTIONS = {
  fit: {
    type: "choice",
    instructions: "Does the work meet the intent and the task it was judged against?",
    criteria: {
      meets: "The work does what the intent and the task ask, and nothing important is missing",
      partly: "Some of what was asked is there, and some is missing, wrong, or only planned",
      misses: "The work does not do what was asked, or the idea itself does not hold up",
    },
  },
  evidence: {
    type: "boolean",
    instructions: "Is what was read (the summary, the check output and the files) enough to trust that answer?",
  },
  rules: {
    type: "boolean",
    instructions:
      "Does anything break the rules: a host not on the allowed list, a license that forbids this use, spending money, a public repository, or a change to a domain or DNS?",
  },
} as const;

export const JUDGE_THRESHOLDS = {
  /** meets needs at least this much probability */
  meets: 0.7,
  /** enough evidence needs at least this much */
  evidence: 0.5,
  /** a broken rule at this much or more parks */
  rules: 0.3,
  /** misses at this much or more is a rejection */
  misses: 0.7,
} as const;

export function decideJudge(answers: JudgeAnswers): Judgment {
  const { fit, evidence, rules } = answers;
  const no = (reason: string, rejected = false): Judgment => ({ answers, go: false, rejected, reason });
  if (rules.probability >= JUDGE_THRESHOLDS.rules) return no("the judge thinks something breaks the rules");
  // a rejection is final in a later phase, so it must rest on evidence the judge trusts
  if (evidence.probability < JUDGE_THRESHOLDS.evidence) return no("the judge says there is not enough to go on");
  const p = fit.probabilities?.[fit.choice] ?? 1;
  if (fit.choice === "misses" && p >= JUDGE_THRESHOLDS.misses) return no("the judge says the work misses the intent", true);
  if (fit.choice === "misses") return no("the judge leans toward the work missing the intent");
  if (fit.choice === "partly") return no("the judge says it only partly meets the intent");
  if (p < JUDGE_THRESHOLDS.meets) return no("not sure the work meets the intent");
  return { answers, go: true, rejected: false, reason: null };
}

/** Clip sizes in characters (UTF-16 code units, as the strings are sliced),
 *  not bytes. At 6 KB each and 20 KB in all, an extend pick's evidence (a
 *  20 KB research, a 10 KB eval) lost its middle, and Jev put its trust in
 *  the evidence at 0.45 every time while saying the pick met the intent at
 *  0.7; at 12 KB and 40 KB the same files read 0.52 to 0.55 and 0.85 to 0.89. */
export const EVIDENCE_EACH = 12 * 1024;
export const EVIDENCE_TOTAL = 40 * 1024;

/** `cap` characters of `text`: its first half and its last, with the count
 *  cut between them. A research file ends in its pick and an eval in its
 *  verdict, so a head-only clip hid the conclusion and the judge said there
 *  was not enough to go on. */
function clipMiddle(text: string, cap: number): string {
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}\n[clipped: ${text.length - cap} characters]\n${text.slice(text.length - tail)}`;
}

/** The text the judge reads: the step's task as the criteria, its summary,
 *  the check's output, then each evidence file clipped to EVIDENCE_EACH
 *  characters, keeping its head and its end, and all of them to
 *  EVIDENCE_TOTAL. */
export function judgeState(input: { task: string; summary: string; check: string | null; files: EvidenceFile[] }): string {
  const parts = [
    `Task the work was judged against:\n${input.task.trim() || "(none)"}`,
    `Step summary:\n${input.summary.trim() || "(no summary)"}`,
  ];
  if (input.check !== null) parts.push(`Check output:\n${input.check.trim() || "(empty)"}`);
  let room = EVIDENCE_TOTAL;
  let left = 0;
  for (const f of input.files) {
    if (f.text === null) {
      parts.push(`File ${f.path}: (missing)`);
      continue;
    }
    if (room <= 0) {
      left += 1;
      continue;
    }
    const cap = Math.min(EVIDENCE_EACH, room);
    const body = f.text.length > cap ? clipMiddle(f.text, cap) : f.text;
    room -= Math.min(f.text.length, cap);
    parts.push(`File ${f.path}:\n${body}`);
  }
  if (left > 0) parts.push(`(${left} more file${left === 1 ? "" : "s"} left out for room)`);
  return parts.join("\n\n");
}
