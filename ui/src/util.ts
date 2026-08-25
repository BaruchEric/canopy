import { isDirty, type GitUser, type Repo } from "../../src/core/types";

export type RepoState = "error" | "conflict" | "dirty" | "ahead" | "clean";

export function stateOf(r: Repo): RepoState {
  if (r.error) return "error";
  if (r.status?.files.some((f) => f.conflicted)) return "conflict";
  if ((r.status?.files.length ?? 0) > 0) return "dirty";
  if ((r.status?.ahead ?? 0) > 0) return "ahead";
  return "clean";
}

/** The "needs attention" filter: local changes, unpushed commits, or a repo
 *  git cannot read. Behind-only repos stay out; nothing of yours is at risk. */
export const needsAttention = (r: Repo): boolean =>
  isDirty(r) || Boolean(r.error);

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

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** One key per identity for grouping and filtering: the email, lower-cased,
 *  or the name when there is no email. Null when the repo has neither. */
export function userKey(r: Repo): string | null {
  const u = r.status?.user;
  return u ? (u.email || u.name).toLowerCase() : null;
}

export interface Identity {
  key: string;
  /** the name, or the email when there is no name */
  label: string;
  email: string;
}

/** Every identity across the given repos, in first-seen order. Two identities
 *  that share a name get the email appended, the way git writes authors, so
 *  the two headings cannot be told apart only by their counts. */
export function identities(repos: Repo[]): Identity[] {
  const seen = new Map<string, GitUser>();
  for (const r of repos) {
    const key = userKey(r);
    const u = r.status?.user;
    if (key !== null && u && !seen.has(key)) seen.set(key, u);
  }
  const byName = new Map<string, number>();
  for (const u of seen.values()) {
    const n = u.name || u.email;
    byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  return [...seen.entries()].map(([key, u]) => {
    const name = u.name || u.email;
    const shared = (byName.get(name) ?? 0) > 1 && u.name && u.email;
    return { key, label: shared ? `${u.name} <${u.email}>` : name, email: u.email };
  });
}
