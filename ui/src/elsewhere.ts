/** What a repo holds outside this checkout (RepoStatus.elsewhere), as card
 *  chips, panel rows and feed lines. Pure and browser-safe. */

import { BRANCH_WIP_CAP, type BranchWip, type Elsewhere, type WorktreeWip } from "../../src/core/types";
import { ago } from "./util";

export interface ElsewhereChip {
  kind: "worktree" | "branch" | "stash";
  text: string;
  title: string;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** the last path segment, which for Claude's agent worktrees is the name */
export const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? p;

export function worktreeText(w: WorktreeWip, here: string): string {
  const parts: string[] = [];
  if (w.files > 0) parts.push(`${plural(w.files, "change")}`);
  if (w.unmerged > 0) parts.push(`${plural(w.unmerged, "commit")} not on ${here}`);
  return `${w.branch ?? "detached"} at ${w.path}: ${parts.join(", ")}`;
}

export function pushText(b: BranchWip): string {
  switch (b.push.kind) {
    case "local":
      return "never pushed";
    case "gone":
      return `${b.push.ref} is gone`;
    case "upstream":
      return b.push.unpushed > 0 ? `${b.push.unpushed} not pushed to ${b.push.ref}` : `pushed to ${b.push.ref}`;
  }
}

export function branchText(b: BranchWip, here: string): string {
  const ahead = b.unmerged === undefined ? "" : `${plural(b.unmerged, "commit")} not on ${here}, `;
  return `${b.name}: ${ahead}${pushText(b)}, ${ago(b.at)}: ${b.subject}`;
}

/** One chip per kind: the name when there is one of it, a count when more.
 *  `here` is the checkout's own branch, what "not on" is measured against. */
export function elsewhereChips(e: Elsewhere | undefined, here: string): ElsewhereChip[] {
  if (!e) return [];
  const out: ElsewhereChip[] = [];
  const [w] = e.worktrees;
  if (w) {
    out.push({
      kind: "worktree",
      text: e.worktrees.length === 1 ? `⧉ ${w.branch ?? baseName(w.path)}` : `⧉ ${plural(e.worktrees.length, "worktree")}`,
      title: e.worktrees.map((x) => worktreeText(x, here)).join("\n"),
    });
  }
  const [b] = e.branches;
  if (b) {
    const n = e.branches.length;
    out.push({
      kind: "branch",
      text: n === 1 ? `⑂ ${b.name}${b.unmerged ? ` +${b.unmerged}` : ""}` : `⑂ ${n}${n >= BRANCH_WIP_CAP ? "+" : ""} branches`,
      title: e.branches.map((x) => branchText(x, here)).join("\n"),
    });
  }
  if (e.stash) {
    out.push({
      kind: "stash",
      text: `≡ ${e.stash.count} stashed`,
      title: `newest ${ago(e.stash.at)}: ${e.stash.subject}`,
    });
  }
  return out;
}

/** What changed between two readings, for the feed: a worktree's tree or
 *  commits moving, a branch gaining commits, the stash growing or shrinking.
 *  A worktree or branch that drops out is not reported; its work landed
 *  here or was thrown away, and the main checkout's own lines say which. */
export function elsewhereLines(before: Elsewhere | undefined, after: Elsewhere | undefined): string[] {
  const out: string[] = [];
  const wasW = new Map((before?.worktrees ?? []).map((w) => [w.path, w]));
  for (const w of after?.worktrees ?? []) {
    const old = wasW.get(w.path);
    const name = w.branch ?? baseName(w.path);
    if (!old || old.files !== w.files) out.push(`worktree ${name}: ${plural(w.files, "change")}`);
    if (old && w.unmerged > old.unmerged) out.push(`worktree ${name}: committed, ${w.unmerged} unmerged`);
  }
  const wasB = new Map((before?.branches ?? []).map((b) => [b.name, b]));
  for (const b of after?.branches ?? []) {
    const old = wasB.get(b.name);
    if (!old) out.push(`branch ${b.name}: ${b.subject}`);
    else if (b.at !== old.at) out.push(`branch ${b.name} moved: ${b.subject}`);
  }
  const was = before?.stash?.count ?? 0;
  const now = after?.stash?.count ?? 0;
  if (now > was && after?.stash) out.push(`stashed: ${after.stash.subject}`);
  else if (now < was) out.push(now === 0 ? "stash empty" : `stash down to ${now}`);
  return out;
}
