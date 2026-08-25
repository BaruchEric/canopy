import type { Repo } from "../../src/core/types";
import { identities, needsAttention, userKey, type Identity } from "./util";

/** The status facets a repo can be filtered on. Each is one question about
 *  the repo; lit facets add up, so a repo shows when it answers yes to any. */
export const REPO_FILTERS = [
  "changes",
  "unpushed",
  "behind",
  "conflicts",
  "off-main",
  "no-upstream",
  "unreadable",
] as const;
export type RepoFilter = (typeof REPO_FILTERS)[number];

export const FILTER_INFO: Record<RepoFilter, { label: string; title: string }> = {
  changes: {
    label: "changes",
    title: "Something in the working tree, staged or not",
  },
  unpushed: {
    label: "unpushed",
    title: "Commits the upstream does not have yet",
  },
  behind: {
    label: "behind",
    title: "The upstream has commits this checkout does not",
  },
  conflicts: {
    label: "conflicts",
    title: "A merge or rebase stopped on conflicts",
  },
  "off-main": {
    label: "off main",
    title: "Checked out somewhere other than main or master",
  },
  "no-upstream": {
    label: "no upstream",
    title: "The branch tracks nothing, so a push has nowhere to go yet",
  },
  unreadable: {
    label: "unreadable",
    title: "git could not read the repo",
  },
};

const DEFAULT_BRANCHES = new Set(["main", "master"]);

export function matchesFilter(r: Repo, f: RepoFilter): boolean {
  const st = r.status;
  switch (f) {
    case "changes":
      return (st?.files.length ?? 0) > 0;
    case "unpushed":
      return (st?.ahead ?? 0) > 0;
    case "behind":
      return (st?.behind ?? 0) > 0;
    case "conflicts":
      return st?.files.some((x) => x.conflicted) ?? false;
    case "off-main":
      return st !== null && !DEFAULT_BRANCHES.has(st.branch);
    case "no-upstream":
      return st !== null && st.upstream === null;
    case "unreadable":
      return Boolean(r.error);
  }
}

/** The user key that stands for "no identity" in a query's `users` list. No
 *  real identity can produce it: a set user always has a name or an email. */
export const NOBODY = "";

export interface RepoQuery {
  /** status facets; a repo passes when it matches any of them */
  filters: readonly RepoFilter[];
  /** identity keys (see userKey); a repo passes when it commits as any */
  users: readonly string[];
  /** the "needs attention" toggle */
  attention: boolean;
  /** substring of the repo id, case-insensitive */
  text: string;
}

/** Filters within one dimension add up; the dimensions all have to agree. */
export function applyQuery(repos: Repo[], q: RepoQuery): Repo[] {
  const text = q.text.trim().toLowerCase();
  return repos.filter(
    (r) =>
      (!q.attention || needsAttention(r)) &&
      (q.filters.length === 0 || q.filters.some((f) => matchesFilter(r, f))) &&
      (q.users.length === 0 || q.users.includes(userKey(r) ?? NOBODY)) &&
      (!text || r.id.toLowerCase().includes(text)),
  );
}

export interface UserFacet extends Identity {
  count: number;
}

export interface Facets {
  /** how many repos each status filter would keep on its own */
  filters: Record<RepoFilter, number>;
  /** every identity with its repo count, busiest first; includes a NOBODY
   *  entry when some repos commit as no one, so those can be picked too */
  users: UserFacet[];
}

/** Counts for the filter menu. Computed on the workspace scope, before any
 *  filter, so a chip says what it would show rather than what is left. */
export function countFacets(repos: Repo[]): Facets {
  const filters = Object.fromEntries(
    REPO_FILTERS.map((f) => [f, repos.filter((r) => matchesFilter(r, f)).length]),
  ) as Record<RepoFilter, number>;
  const counts = new Map<string, number>();
  for (const r of repos) {
    const key = userKey(r) ?? NOBODY;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const users: UserFacet[] = identities(repos).map((u) => ({
    ...u,
    count: counts.get(u.key) ?? 0,
  }));
  const nobody = counts.get(NOBODY);
  if (nobody) {
    users.push({ key: NOBODY, label: "no identity", email: "", count: nobody });
  }
  users.sort(
    (a, b) =>
      // "no identity" is a catch-all, and reads best after the real people
      Number(a.key === NOBODY) - Number(b.key === NOBODY) ||
      b.count - a.count ||
      a.label.localeCompare(b.label),
  );
  return { filters, users };
}
