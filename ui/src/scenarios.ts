/** A repo's holdout scenarios as the page shows them (FR-032): the landing
 *  section's chip and its list, and a pass's words where its head is not
 *  the one shown. Pure. The page only ever holds names and kinds
 *  (`ScenarioNames`); a scenario's text stays on the backend, so nothing an
 *  agent reads off the page (a pick, a copy, the voice tools) can carry it. */

import type { ScenarioNames, ScenarioRun } from "../../src/core/types";

/** The chip's words: "scenarios 3", "scenarios 3 · 1 broken"; null for a
 *  repo with no set, or one not read yet. */
export function setChip(set: ScenarioNames | undefined): { text: string; tone: "lichen" | "rust" } | null {
  if (!set || (set.names.length === 0 && set.errors.length === 0)) return null;
  const broken = set.errors.length > 0 ? ` · ${set.errors.length} broken` : "";
  return { text: `scenarios ${set.names.length}${broken}`, tone: broken ? "rust" : "lichen" };
}

export interface SetRow {
  key: string;
  name: string;
  word: string;
  tone: "" | "rust";
}

/** The list's rows: each scenario by name and kind, then each file that
 *  does not read by its file name, since a broken file is a red scenario
 *  in every pass until it is fixed. */
export function setRows(set: ScenarioNames): SetRow[] {
  return [
    ...set.names.map((n): SetRow => ({ key: `s:${n.name}`, name: n.name, word: n.kind, tone: "" })),
    ...set.errors.map((e): SetRow => ({ key: `e:${e.file}`, name: e.file, word: "does not read, so every pass is red", tone: "rust" })),
  ];
}

/** "on 1a2b3c4, an older head" when a pass ran on a head other than the
 *  one shown now, else null. */
export function staleWord(pass: Pick<ScenarioRun, "head">, head: string | undefined): string | null {
  if (!head || !pass.head || pass.head === head) return null;
  return `on ${pass.head.slice(0, 7)}, an older head`;
}
