import type { Repo } from "../../src/core/types";
import type { SortMode } from "./settings";
import { identities, stateOf, userKey } from "./util";

export interface RepoGroup {
  key: string;
  /** section heading, in the same voice as the rest of the UI */
  label: string;
  /** tooltip on the heading, when the label leaves something out */
  hint?: string;
  repos: Repo[];
}

const DAY = 86_400;

/** When the repo last committed, in unix seconds. A forge repo has no local
 *  commit to read, so its last push to the forge stands in. */
export const commitAt = (r: Repo): number =>
  r.status?.lastCommit?.at ?? (r.forge?.updated ? r.forge.updated / 1000 : 0);
/** The newest changed file in the working tree, or null with no changes
 *  (or no mtimes, when the stat on a remote repo did not work). */
export function newestEdit(r: Repo): { path: string; at: number } | null {
  let best: { path: string; at: number } | null = null;
  for (const f of r.status?.files ?? []) {
    if (f.mtime !== undefined && (best === null || f.mtime > best.at)) best = { path: f.path, at: f.mtime };
  }
  return best;
}
/** When the repo last changed at all, in unix seconds: the newer of the
 *  last commit and the newest edit. What the card's time and the "recent"
 *  grouping go by. */
export const changedAt = (r: Repo): number => Math.max(commitAt(r), newestEdit(r)?.at ?? 0);
const byName = (a: Repo, b: Repo): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const byChange = (a: Repo, b: Repo): number =>
  changedAt(b) - changedAt(a) || byName(a, b);

interface Bucket {
  key: string;
  label: string;
  hint?: string;
}

/** Places each repo in the bucket `keyOf` names, keeps the buckets in the
 *  given order, drops the empty ones, and sorts each bucket with `cmp`. */
function bucket(
  repos: Repo[],
  order: readonly Bucket[],
  keyOf: (r: Repo) => string,
  cmp: (a: Repo, b: Repo) => number,
): RepoGroup[] {
  const members = new Map<string, Repo[]>();
  for (const r of repos) {
    const key = keyOf(r);
    const list = members.get(key);
    if (list) list.push(r);
    else members.set(key, [r]);
  }
  const groups: RepoGroup[] = [];
  for (const b of order) {
    const list = members.get(b.key);
    if (list) groups.push({ ...b, repos: list.sort(cmp) });
  }
  return groups;
}

const ACTIVITY: readonly Bucket[] = [
  { key: "attention", label: "needs attention" },
  { key: "ahead", label: "unpushed" },
  { key: "behind", label: "behind upstream" },
  { key: "quiet", label: "quiet" },
  { key: "forge", label: "on the forge only" },
  { key: "error", label: "unreadable" },
];

function activityKey(r: Repo): string {
  switch (stateOf(r)) {
    case "error":
      return "error";
    case "conflict":
    case "dirty":
      return "attention";
    case "ahead":
      return "ahead";
    case "clean":
      return (r.status?.behind ?? 0) > 0 ? "behind" : "quiet";
    case "forge":
      return "forge";
  }
}

/** Age buckets for the last change, commit or edit; the last one holds what
 *  has neither. */
const RECENT: readonly (Bucket & { within?: number })[] = [
  { key: "today", label: "today", within: DAY },
  { key: "week", label: "this week", within: 7 * DAY },
  { key: "month", label: "this month", within: 30 * DAY },
  { key: "season", label: "this season", within: 90 * DAY },
  { key: "dormant", label: "dormant" },
  { key: "none", label: "untouched" },
];

/** The age bucket a moment falls in, or `none` for no moment at all. */
function ageKey(at: number, now: number): string {
  if (!at) return "none";
  const age = Math.max(0, now - at);
  for (const b of RECENT) {
    if (b.within !== undefined && age < b.within) return b.key;
  }
  return "dormant";
}

/** The key a folded section is remembered under. Modes keep their own, so
 *  folding "dormant" leaves the folder view alone. */
export const sectionKey = (mode: SortMode, key: string): string =>
  `${mode}:${key}`;

/**
 * Groups already-filtered repos for the tree and the grid. Both views call
 * this with the same mode, so a heading in one is the same heading in the
 * other. `now` is unix seconds; it only matters for "recent".
 */
export function groupRepos(
  repos: Repo[],
  mode: SortMode,
  now: number = Date.now() / 1000,
): RepoGroup[] {
  switch (mode) {
    case "folder": {
      const folders = [...new Set(repos.map((r) => r.group || "."))]
        .sort((a, b) => a.localeCompare(b))
        .map((f) => ({ key: f, label: f }));
      return bucket(repos, folders, (r) => r.group || ".", byName);
    }
    case "activity":
      // each group newest change first: what was touched last is what the
      // hand is most likely still in
      return bucket(repos, ACTIVITY, activityKey, byChange);
    case "recent":
      return bucket(repos, RECENT, (r) => ageKey(changedAt(r), now), byChange);
    case "name":
      return bucket(
        repos,
        [{ key: "all", label: "a to z" }],
        () => "all",
        byName,
      );
    case "user": {
      // one bucket per identity, named after the person; repos that commit
      // as nobody and repos git cannot read bring up the rear
      const people = identities(repos)
        .map((u) => ({ key: u.key, label: u.label, hint: u.email || undefined }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return bucket(
        repos,
        [
          ...people,
          { key: "none", label: "no identity" },
          { key: "error", label: "unreadable" },
        ],
        (r) => (r.error ? "error" : (userKey(r) ?? "none")),
        byName,
      );
    }
  }
}
