/** A side question on the page (FR-077): the models its select offers, the
 *  words its column heads with, and where the column sits. Pure; the
 *  components in SideQuestion.tsx draw from these. */

import { HARNESS } from "../../src/core/harness";
import { runTitle } from "../../src/core/runname";
import { sideQuestion, sideRefusal, type SideParent } from "../../src/core/sidequestion";
import type { Harness, Run } from "../../src/core/types";

/** Where a run's box sends its text: to the run, as any message goes;
 *  beside it, as a side question; or nowhere yet, held back as a side
 *  question with nothing asked or one the run takes none of now. `direct`
 *  is the user's "send it to the run instead" for this text. */
export function sideGoes(text: string, run: SideParent, direct: boolean): "run" | "held" | "side" {
  const question = sideQuestion(text);
  if (question === null || direct) return "run";
  return question === "" || sideRefusal(run) !== null ? "held" : "side";
}

/** The models a side question's select offers on a harness: the harness's
 *  own list, led by each of `current` that is a name outside it (a Codex
 *  model the repo's settings name), so the select can show what is set. */
export function sideModels(harness: Harness, ...current: string[]): string[] {
  const listed: readonly string[] = HARNESS[harness].models;
  const outside = current.filter((m, i) => !listed.includes(m) && current.indexOf(m) === i);
  return [...outside, ...listed];
}

/** A model as the select words it: "default" is the CLI's own choice. */
export const modelWord = (model: string): string => (model === "default" ? "the default model" : model);

/** The model a side question runs on now, as its record says. */
export const sideModel = (run: Pick<Run, "agentSettings">): string => run.agentSettings?.model ?? "default";

/** The question a side thread opened with: its first message, else the
 *  name it goes by (a record whose steps were trimmed). */
export function sideAsked(run: Pick<Run, "steps" | "name" | "note" | "verb">): string {
  const first = run.steps.find((s) => s.kind === "user")?.text?.trim();
  return first ? (first.split("\n", 1)[0] ?? first) : runTitle(run);
}

/** The narrowest sheet that shows a side question beside its run, each with
 *  half; a narrower one shows it over the run, with a way back. The same
 *  width a phone's layout turns at (`PHONE` in media.ts). */
export const SIDE_BESIDE_MIN = 761;

/** Whether a sheet `width` px wide has room for the two side by side. */
export const sideBeside = (width: number): boolean => width >= SIDE_BESIDE_MIN;
