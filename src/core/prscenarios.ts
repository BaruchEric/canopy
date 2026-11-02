/** The PR watch's pre-merge scenario pass (FR-032 plan 3), the pure half:
 *  what a pass over a PR's head says to auto-merge, and the watch once a
 *  pass ends. The pass itself runs in `server/prscenarios.ts`. Pure and
 *  browser-safe. A hold names a scenario and its kind of failure, never a
 *  scenario's text: the words reach the inbox and the trigger events, which
 *  agents read. */

import { scoreGate } from "./landing";
import type { PrWatch, ScenarioRun } from "./types";

/** what a watch says when a pass threw: fixed words, since a thrown error
 *  can name the set's folder or a scenario's line */
export const PASS_FAILED = "its scenarios could not run";

/** Why a pass holds the head for Eric, or null when it may merge: the first
 *  red command scenario (a file that does not parse is one, by its file
 *  name), else the first judge that could not answer, else a score under
 *  `minimum` with the judge scenarios that were not satisfied. */
export function scenarioHold(run: Pick<ScenarioRun, "results" | "score">, minimum: number): string | null {
  const red = run.results.find((r) => r.kind === "command" && !r.ok);
  if (red) return `scenario ${red.name} failed`;
  const unjudged = run.results.find((r) => r.unjudged !== undefined);
  if (unjudged) return `scenario ${unjudged.name} needs a judge: ${unjudged.unjudged}`;
  if (run.score < minimum) {
    const low = run.results.filter((r) => r.kind === "judge" && !r.ok).map((r) => r.name);
    return `${scoreGate(run.score, minimum)}${low.length > 0 ? `, from ${low.join(", ")}` : ""}`;
  }
  return null;
}

/** The watch with what a pass over `head` says, `why` or null for "may
 *  go", as its hold. A hold the review rules set (files for Eric's
 *  approval) stands whatever the pass says, on this head or on the one the
 *  PR moved to while the pass ran: it is not the pass's to lift or replace.
 *  Otherwise the pass's own hold replaces the scenarios' last one, and a
 *  green pass lifts it. A pass on a head the PR has moved past holds
 *  nothing that matters, since `approve` counts only on its own head. */
export function holdPass(w: PrWatch, head: string, why: string | null): PrWatch {
  const { approve, ...rest } = w;
  const files = approve && approve.by !== "scenarios" ? approve : undefined;
  const hold = files ?? (why === null ? undefined : { head, why, by: "scenarios" as const });
  return hold ? { ...rest, approve: hold } : rest;
}

/** The watch once a pass over `head` ended: the pass kept on it, the
 *  running mark gone, and the head held as `holdPass` says. */
export function settlePass(w: PrWatch, head: string, run: ScenarioRun, minimum: number): PrWatch {
  const { checking: _c, ...rest } = w;
  return holdPass({ ...rest, scenarios: run }, head, scenarioHold(run, minimum));
}

/** The watch once a pass over `head` could not run: held for Eric with
 *  `why` as `holdPass` says, the running mark gone and the last pass kept. */
export function failPass(w: PrWatch, head: string, why: string = PASS_FAILED): PrWatch {
  const { checking: _c, ...rest } = w;
  return holdPass(rest, head, why);
}
