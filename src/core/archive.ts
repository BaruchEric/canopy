import type { Repo } from "./types";

/** Who archived a repo: canopy when its path is among the ones given,
 *  else GitHub when the last pull request pass said so, else nobody. */
export const archivedBy = (r: Repo, paths: ReadonlySet<string>): Repo["archived"] =>
  paths.has(r.path) ? "canopy" : r.pulls?.archived ? "github" : undefined;

/** Every repo with `archived` set through `archivedBy`, so it runs after
 *  `linkPulls`. A repo whose flag did not move is the same object, and the
 *  array is the same one when nothing moved, so a scan that archived nothing
 *  is not a change. */
export function linkArchived(repos: Repo[], paths: ReadonlySet<string>): Repo[] {
  let moved = false;
  const out = repos.map((r) => {
    const by = archivedBy(r, paths);
    if (by === r.archived) return r;
    moved = true;
    if (by) return { ...r, archived: by };
    const { archived: _gone, ...rest } = r;
    return rest;
  });
  return moved ? out : repos;
}
