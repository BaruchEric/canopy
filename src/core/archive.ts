import type { Repo } from "./types";

/** Every repo with `archived` set from the paths given, or unset when its
 *  path is not among them. A repo whose flag did not move is the same object,
 *  and the array is the same one when nothing moved, so a scan that archived
 *  nothing is not a change. */
export function linkArchived(repos: Repo[], paths: ReadonlySet<string>): Repo[] {
  let moved = false;
  const out = repos.map((r) => {
    const on = paths.has(r.path);
    if (on === (r.archived === true)) return r;
    moved = true;
    if (on) return { ...r, archived: true as const };
    const { archived: _gone, ...rest } = r;
    return rest;
  });
  return moved ? out : repos;
}
