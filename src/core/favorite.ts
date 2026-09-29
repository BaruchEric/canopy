import type { Repo } from "./types";

/** Every repo with `favorite` set when its path is among the ones given, or
 *  unset when it is not. A repo whose star did not move is the same object,
 *  and the array is the same one when nothing moved, so a scan that starred
 *  nothing is not a change. */
export function linkFavorites(repos: Repo[], paths: ReadonlySet<string>): Repo[] {
  let moved = false;
  const out = repos.map((r) => {
    const on = paths.has(r.path);
    if (on === (r.favorite === true)) return r;
    moved = true;
    if (on) return { ...r, favorite: true as const };
    const { favorite: _gone, ...rest } = r;
    return rest;
  });
  return moved ? out : repos;
}
