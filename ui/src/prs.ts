/** The PRs branch runs opened, as the page shows them (FR-011): every
 *  backend's list as one, a run's PR, the footer's line, the CI chip and
 *  what auto-merge waits on. Pure; the words for the checks and the merge
 *  conditions are `core/pr.ts`'s, shared with the CLI. */

import { checksWord, readyToMerge } from "../../src/core/pr";
import type { PrWatch, Run } from "../../src/core/types";

/** Every backend's PRs as one list, newest first; ids are already qualified. */
export function mergePrs(byBackend: Readonly<Record<string, readonly PrWatch[]>>): PrWatch[] {
  return Object.values(byBackend)
    .flat()
    .sort((a, b) => b.openedAt - a.openedAt);
}

/** The PR a run's branch opened, if any. */
export const prOfRun = (run: Pick<Run, "branch">, prs: readonly PrWatch[]): PrWatch | undefined =>
  run.branch ? prs.find((w) => w.id === run.branch?.origin) : undefined;

/** The footer's line: "#123 · +40 −12 · 3 files"; the number alone until read. */
export function prLine(w: PrWatch): string {
  const s = w.state;
  if (!s) return `#${w.number}`;
  return `#${w.number} · +${s.additions} −${s.deletions} · ${s.files} file${s.files === 1 ? "" : "s"}`;
}

/** Where the PR stands in a few words: "PR #12 open", "PR #12 merged". */
export function prWord(w: PrWatch): string {
  const s = w.state;
  if (!s) return `PR #${w.number}, not read yet`;
  if (s.status === "open" && s.draft) return `PR #${w.number}, a draft`;
  return `PR #${w.number} ${s.status}`;
}

/** The CI chip's words and tone, or null until the PR has been read. */
export function ciChip(w: PrWatch): { text: string; tone: "moss" | "sky" | "rust" | "lichen" } | null {
  const s = w.state;
  if (!s) return null;
  const text = checksWord(s);
  if (s.checks.length === 0) return { text, tone: "lichen" };
  if (s.checks.some((c) => c.state === "fail")) return { text, tone: "rust" };
  if (s.checks.some((c) => c.state === "pending")) return { text, tone: "sky" };
  return { text, tone: "moss" };
}

const TONE_RANK = { rust: 3, sky: 2, lichen: 1, moss: 0 } as const;

/** A repo card's chip for its open PRs, or null when it has none: one PR
 *  names itself and its checks, several say how many are red. Its tone and
 *  run are the worst PR's, so a click opens the one that needs a look. */
export function repoPrChip(prs: readonly PrWatch[], repoId: string): { text: string; tone: keyof typeof TONE_RANK; runId: string } | null {
  const open = prs.filter((w) => w.repoId === repoId && (!w.state || w.state.status === "open"));
  if (open.length === 0) return null;
  const toned = open.map((w) => ({ w, chip: ciChip(w) }));
  const tone = (c: (typeof toned)[number]) => c.chip?.tone ?? "lichen";
  const worst = toned.reduce((a, b) => (TONE_RANK[tone(b)] > TONE_RANK[tone(a)] ? b : a));
  if (open.length === 1) {
    const { w, chip } = worst;
    return { text: chip ? `PR #${w.number} · ${chip.text}` : `PR #${w.number}`, tone: tone(worst), runId: w.runId };
  }
  const red = toned.filter((c) => tone(c) === "rust").length;
  return { text: `${open.length} PRs${red ? ` · ${red} red` : ""}`, tone: tone(worst), runId: worst.w.runId };
}

/** What auto-merge waits on, while it is on and the PR is open. */
export function mergeWhy(w: PrWatch): string | null {
  const s = w.state;
  if (!w.autoMerge || !s || s.status !== "open") return null;
  const r = readyToMerge(s, w);
  return r.ok ? "auto-merge: merging on the next read" : `auto-merge waits: ${r.why}`;
}
