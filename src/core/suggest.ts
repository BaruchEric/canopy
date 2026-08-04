import { exec, git } from "./exec";
import type { RepoFile } from "./types";

const PROMPT = `Write a git commit message for the changes below.
Output ONLY the commit message: an imperative subject line under 65 characters,
optionally followed by a blank line and up to 3 short "- " body lines.
No backticks, no quotes around the message, no commentary.`;

/** Heuristic fallback: summarize by top-level area. */
export function heuristicMessage(files: RepoFile[]): string {
  if (files.length === 0) return "update";
  const areas = new Map<string, number>();
  for (const f of files) {
    const seg = f.path.includes("/") ? (f.path.split("/")[0] ?? "") : "root";
    areas.set(seg, (areas.get(seg) ?? 0) + 1);
  }
  const top = [...areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const parts = top.map(([area, n]) => `${area} (${n})`);
  const verb = files.every((f) => f.untracked) ? "add" : "update";
  return `${verb} ${parts.join(", ")}`;
}

async function diffContext(repoPath: string): Promise<string> {
  const [short, staged, unstaged, stagedDiff, unstagedDiff] = await Promise.all(
    [
      git(repoPath, ["status", "--short"]),
      git(repoPath, ["diff", "--cached", "--stat"]),
      git(repoPath, ["diff", "--stat"]),
      git(repoPath, ["diff", "--cached"]),
      git(repoPath, ["diff"]),
    ],
  );
  const hasStaged = staged.stdout.trim().length > 0;
  const body = (hasStaged ? stagedDiff : unstagedDiff).stdout.slice(0, 12_000);
  return [
    "## git status --short",
    short.stdout,
    "## diffstat",
    hasStaged ? staged.stdout : unstaged.stdout,
    "## diff (truncated)",
    body,
  ].join("\n");
}

/** Suggest a commit message via the claude CLI; falls back to a heuristic. */
export async function suggestMessage(
  repoPath: string,
  files: RepoFile[],
): Promise<{ message: string; source: "ai" | "heuristic" }> {
  const claude = Bun.which("claude");
  if (claude) {
    const context = await diffContext(repoPath);
    const r = await exec(
      [claude, "-p", `${PROMPT}\n\n${context}`, "--output-format", "text"],
      { timeoutMs: 90_000 },
    );
    const message = r.stdout.trim();
    if (r.code === 0 && message) return { message, source: "ai" };
  }
  return { message: heuristicMessage(files), source: "heuristic" };
}
