/**
 * The CLI's tree and its other listings as lines of toned segments, so the
 * terminal and the web UI's command line draw the same thing: render.ts
 * paints a segment's tone as an ANSI color, the page paints it with the
 * palette's token of the same name. Browser-safe and pure; tested in
 * treelines.test.ts.
 */

import type { Repo, SpecState } from "./types";
import { dirtyCount } from "./types";

/** the canopy palette's roles, as the CLI uses them */
export type Tone = "moss" | "lichen" | "rust" | "sky" | "dim" | "bold";

/** a run of text in one tone; `repo` makes it a link to that repo's panel */
export interface Seg {
  text: string;
  tone?: Tone;
  repo?: string;
}

export type Line = Seg[];

const seg = (text: string, tone?: Tone): Seg => (tone ? { text, tone } : { text });

/** a line's plain text, tones dropped */
export const lineText = (line: Line): string => line.map((s) => s.text).join("");

export function ago(unixSeconds: number | undefined, now: number = Date.now()): string {
  if (!unixSeconds) return "";
  const s = Math.max(0, now / 1000 - unixSeconds);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 86400 / 30)}mo`;
}

/** ✗ error, ◆ conflict, ● changes, ◐ unpushed, ○ clean */
export function glyphSeg(r: Repo): Seg {
  if (r.error) return seg("✗", "rust");
  if (r.status?.files.some((f) => f.conflicted)) return seg("◆", "rust");
  if (dirtyCount(r) > 0) return seg("●", "lichen");
  if ((r.status?.ahead ?? 0) > 0) return seg("◐", "sky");
  return seg("○", "moss");
}

/** what a repo holds, in words and marks, joined by single spaces */
export function summarySegs(r: Repo): Seg[] {
  if (r.error) return [seg("error", "rust")];
  const st = r.status;
  if (!st) return [];
  const parts: Seg[] = [];
  if (st.files.length > 0) parts.push(seg(`${st.files.length} changed`, "lichen"));
  if (st.ahead > 0) parts.push(seg(`↑${st.ahead}`, "sky"));
  if (st.behind > 0) parts.push(seg(`↓${st.behind}`, "rust"));
  if (st.tip && st.tip.ref !== st.upstream) parts.push(seg(`⇣${st.tip.ref}`, "sky"));
  if (parts.length === 0) parts.push(seg("clean", "dim"));
  // work held outside this tree: worktrees, unmerged branches, the stash
  const e = st.elsewhere;
  if (e?.worktrees.length) parts.push(seg(`⧉${e.worktrees.length}`, "lichen"));
  if (e?.branches.length) parts.push(seg(`⑂${e.branches.length}`, "sky"));
  if (e?.stash) parts.push(seg(`≡${e.stash.count}`, "dim"));
  return joined(parts);
}

/** segments with a plain space between each */
function joined(parts: Seg[]): Seg[] {
  return parts.flatMap((p, i) => (i === 0 ? [p] : [seg(" "), p]));
}

/** whether `canopy status` lists a repo: changes, unpushed work, or an error */
export const needsAttention = (r: Repo): boolean => dirtyCount(r) > 0 || (r.status?.ahead ?? 0) > 0 || !!r.error;

/** `canopy [dir]` and `canopy status`: the repos by group, as a tree */
export function treeLines(root: string, all: Repo[], opts: { dirtyOnly?: boolean; now?: number } = {}): Line[] {
  const repos = opts.dirtyOnly ? all.filter(needsAttention) : all;
  const lines: Line[] = [[seg(root, "bold")]];
  const groups = new Map<string, Repo[]>();
  for (const r of repos) {
    const g = r.group || ".";
    const arr = groups.get(g) ?? [];
    arr.push(r);
    groups.set(g, arr);
  }
  const nameW = Math.max(4, ...repos.map((r) => r.name.length));
  const branchW = Math.max(4, ...repos.map((r) => r.status?.branch.length ?? 0));

  const groupNames = [...groups.keys()].sort();
  groupNames.forEach((g, gi) => {
    const isLastGroup = gi === groupNames.length - 1;
    const members = groups.get(g) ?? [];
    const single = members.length === 1 && members[0]?.id === g;
    if (!single) lines.push([seg(`${isLastGroup ? "└─" : "├─"} `), seg(g, "bold")]);
    members.forEach((r, ri) => {
      const isLast = ri === members.length - 1;
      const stem = single ? (isLastGroup ? "└─" : "├─") : `${isLastGroup ? "   " : "│  "}${isLast ? "└─" : "├─"}`;
      const branch = r.status?.branch ?? "";
      lines.push([
        seg(`${stem} `),
        glyphSeg(r),
        seg(" "),
        { text: r.name.padEnd(nameW), repo: r.id },
        seg(" "),
        seg(branch.padEnd(branchW), "dim"),
        seg(" "),
        ...summarySegs(r),
        seg(" "),
        seg(ago(r.status?.lastCommit?.at, opts.now), "dim"),
      ]);
    });
  });
  if (repos.length === 0) {
    lines.push([seg(opts.dirtyOnly ? "everything is clean and pushed" : "no git repos under this directory", "dim")]);
  }
  return lines;
}

export const SPEC_WORDS: Record<SpecState, string> = {
  "in-sync": "spec text in sync",
  behind: "behind",
  drifted: "drifted",
  "not-adopted": "not adopted",
};

export const SPEC_TONE: Record<SpecState, Tone> = { "in-sync": "moss", behind: "lichen", drifted: "rust", "not-adopted": "dim" };

/** `canopy spec status`: one line per local checkout the scan read the spec of */
export function specLines(version: string | number | null, repos: Repo[]): Line[] {
  const lines: Line[] = version === null ? [] : [[seg(`shared repo spec v${version}`, "dim")]];
  for (const r of repos) {
    if (r.spec === undefined) continue;
    lines.push([seg(SPEC_WORDS[r.spec].padEnd(18), SPEC_TONE[r.spec]), seg(" "), { text: r.id, repo: r.id }]);
  }
  return lines;
}
