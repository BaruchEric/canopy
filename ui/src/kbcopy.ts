/**
 * The copy keys (FR-025): y then b, p or r copies the branch, the PR's link
 * or the run's id of what the keyboard is on, the run sheet's run or the
 * ringed card or row (kbfocus.ts), as Linear's copy actions do for an
 * issue. What each kind of item has to copy is worked out here, pure and
 * tested (kbcopy.test.ts); `kbCopy` in components/KbFocus.tsx finds the
 * item in the store and writes the clipboard.
 */
import type { LandEntry, PrWatch, Repo, Run } from "../../src/core/types";
import { prOfRun } from "./prs";
import type { CopyKey } from "./shortcuts";

/** What an item has to copy, each null where it has none. A run's id is as
 *  the page holds it, with its backend's name in front; the page half
 *  copies the id its backend knows. */
export interface Copyable {
  branch: string | null;
  pr: string | null;
  run: string | null;
}

/** a PR watch still open, as the card's chip counts them: one not read yet counts */
const isOpen = (w: PrWatch): boolean => !w.state || w.state.status === "open";

/**
 * A repo card's: the checkout's branch (a forge repo's default); the open
 * PR canopy watches on that branch, else the card's run's, else the one
 * open PR it watches on the repo, else the repo's open pull requests page
 * on GitHub when it has any; and the card's run (`runFor`'s: live first,
 * else the newest finished one the server still holds).
 */
export function copyableOfRepo(repo: Pick<Repo, "id" | "status" | "forge" | "pulls">, run: Pick<Run, "id" | "branch"> | undefined, prs: readonly PrWatch[]): Copyable {
  const branch = repo.status?.branch ?? repo.forge?.branch ?? null;
  const open = prs.filter((w) => w.repoId === repo.id && isOpen(w));
  const pr = open.find((w) => w.branch === branch) ?? (run && open.find((w) => w.id === run.branch?.origin)) ?? (open.length === 1 ? open[0] : undefined);
  return {
    branch,
    pr: pr?.url ?? (repo.pulls && repo.pulls.open > 0 ? repo.pulls.url : null),
    run: run?.id ?? null,
  };
}

/** A run's: its own branch, else the checkout's it ran in; the PR its
 *  branch opened, open or not; its id. */
export function copyableOfRun(run: Pick<Run, "id" | "branch">, prs: readonly PrWatch[], checkout: string | null = null): Copyable {
  return { branch: run.branch?.name ?? checkout, pr: prOfRun(run, prs)?.url ?? null, run: run.id };
}

/**
 * A branch's, by its id (`RunBranch.origin`, which its PR watch, its
 * landing record and every run on it carry): the branch's name from
 * whichever has it, the watch's link, and the latest run on the branch,
 * the watch's word for it first, else the newest run that names it.
 */
export function copyableOfOrigin(
  origin: string,
  prs: readonly PrWatch[],
  entries: readonly Pick<LandEntry, "id" | "branch">[],
  runs: readonly Pick<Run, "id" | "branch" | "startedAt">[],
): Copyable {
  const w = prs.find((p) => p.id === origin);
  const e = entries.find((x) => x.id === origin);
  let run: Pick<Run, "id" | "branch" | "startedAt"> | undefined;
  for (const r of runs) if (r.branch?.origin === origin && (!run || r.startedAt > run.startedAt)) run = r;
  return {
    branch: w?.branch ?? e?.branch ?? run?.branch?.name ?? null,
    pr: w?.url ?? null,
    run: w?.runId ?? run?.id ?? null,
  };
}

/** each key's part in words, for the quiet line */
export const COPY_NAMES: Readonly<Record<CopyKey, string>> = { b: "branch", p: "PR link", r: "run id" };

/** What a key takes off an item: the part's name, and its text or null
 *  where the item has none. */
export function copyOf(c: Copyable, key: CopyKey): { name: string; text: string | null } {
  return { name: COPY_NAMES[key], text: key === "b" ? c.branch : key === "p" ? c.pr : c.run };
}
