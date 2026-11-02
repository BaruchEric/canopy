/** The words for a kept worktree (FR-051), shared by the CLI and the page:
 *  pure, so the browser may import it (core/branchtrees.ts needs Bun). */

import type { BranchTreeState } from "./types";

/** Why a tree should not go without `force`: what it holds that would be
 *  lost or cut off. Null when nothing. */
export function removeRefusal(t: { files: number; ahead: number; shells: number }): string | null {
  const parts: string[] = [];
  if (t.files > 0) parts.push(`${t.files} changed file${t.files === 1 ? "" : "s"}`);
  if (t.ahead > 0) parts.push(`${t.ahead} commit${t.ahead === 1 ? "" : "s"} its base lacks`);
  if (t.shells > 0) parts.push(`${t.shells} shell${t.shells === 1 ? "" : "s"} open in it`);
  return parts.length === 0 ? null : `the tree holds ${parts.join(", ")}; remove it with force to lose that`;
}

/** The tree's row in words: its standing against the base, its changed
 *  files, its port, its state and its shells. */
export function treeWords(t: { ahead: number; behind: number; files: number; port: number | null; state: BranchTreeState; why?: string; shells: number }): string {
  const parts: string[] = [];
  if (t.state === "preparing") parts.push("preparing");
  if (t.state === "failed") parts.push(`setup failed${t.why ? `: ${t.why.split("\n").filter(Boolean).pop() ?? ""}` : ""}`);
  if (t.ahead > 0) parts.push(`↑${t.ahead}`);
  if (t.behind > 0) parts.push(`↓${t.behind}`);
  if (t.files > 0) parts.push(`●${t.files}`);
  if (t.ahead === 0 && t.behind === 0 && t.files === 0 && t.state === "ready") parts.push("clean");
  if (t.port !== null) parts.push(`:${t.port}`);
  if (t.shells > 0) parts.push(`${t.shells} shell${t.shells === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** The source id of canopy's own worktrees folder: every kept tree is
 *  scanned there as a card of its own, named `<repo> ⑂ <branch>` and filed
 *  under its repo's group, so it has the whole panel: changes, files,
 *  tasks, preview, shells. */
export const TREES_SOURCE = "trees";

/** a card that is a kept worktree, not a checkout of its own */
export const isTreeCard = (r: { source?: string }): boolean => r.source === TREES_SOURCE;
