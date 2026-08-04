import type { Repo } from "../../src/core/types";

export type RepoState = "error" | "conflict" | "dirty" | "ahead" | "clean";

export function stateOf(r: Repo): RepoState {
  if (r.error) return "error";
  if (r.status?.files.some((f) => f.conflicted)) return "conflict";
  if ((r.status?.files.length ?? 0) > 0) return "dirty";
  if ((r.status?.ahead ?? 0) > 0) return "ahead";
  return "clean";
}

export function ago(unixSeconds: number | undefined): string {
  if (!unixSeconds) return "—";
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 86400 / 30)}mo ago`;
}

export const GLYPH: Record<RepoState, string> = {
  error: "✗",
  conflict: "◆",
  dirty: "●",
  ahead: "◐",
  clean: "○",
};
