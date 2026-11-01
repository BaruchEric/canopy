/** The kept worktrees (FR-051) as the page shows them: a repo's trees out of
 *  every backend's list, the words for a row, the section's head and the
 *  card's chip. Pure; a row's words are `core/treewords.ts`'s, shared with
 *  the CLI. */

import { treeWords } from "../../src/core/treewords";
import type { BranchTree, BranchTreeRepo, BranchTreesInfo } from "../../src/core/types";

export function repoTrees(byBackend: Readonly<Record<string, BranchTreesInfo>>, repoId: string): BranchTreeRepo | undefined {
  for (const info of Object.values(byBackend)) {
    const repo = info.repos.find((r) => r.repoId === repoId);
    if (repo) return repo;
  }
  return undefined;
}

/** "3m", "2h", "4d"; "" when the tree's last commit time is unknown */
export function treeAge(at: number | undefined, now: number): string {
  if (!at) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

export type TreeTone = "" | "rust" | "lichen";

/** one row: the tree's words, its age, and a tone for a tree that failed
 *  (rust) or is still being prepared (lichen) */
export function treeRow(t: BranchTree, now: number): { words: string; age: string; tone: TreeTone } {
  return { words: treeWords(t), age: treeAge(t.at, now), tone: t.state === "failed" ? "rust" : t.state === "preparing" ? "lichen" : "" };
}

/** the fold header's words: how many, and how many are not ready */
export function treesHead(trees: readonly BranchTree[]): string {
  if (trees.length === 0) return "none kept";
  const parts = [`${trees.length} tree${trees.length === 1 ? "" : "s"}`];
  const preparing = trees.filter((t) => t.state === "preparing").length;
  const failed = trees.filter((t) => t.state === "failed").length;
  if (preparing > 0) parts.push(`${preparing} preparing`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(", ");
}

/** The card chip's words, or null when the repo keeps no tree: the count,
 *  each tree's branch and words in the title, rust while one failed. */
export function treesChip(trees: readonly BranchTree[] | undefined): { text: string; title: string; tone: "" | "rust" } | null {
  if (!trees || trees.length === 0) return null;
  return {
    text: `⑂ ${trees.length} tree${trees.length === 1 ? "" : "s"}`,
    title: trees.map((t) => `${t.branch}  ${treeWords(t)}`).join("\n"),
    tone: trees.some((t) => t.state === "failed") ? "rust" : "",
  };
}

/** the section's text for a copy */
export const treeLines = (trees: readonly BranchTree[]): string => trees.map((t) => `${t.branch}  ${treeWords(t)}  ${t.dir}`).join("\n");
