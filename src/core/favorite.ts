import type { Repo } from "./types";

/** The star and the harness mark: both canopy's own, kept as path lists in
 *  config and linked onto the scan's repos. */
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

/** Every repo with `harness` set when its path is among the ones given, or
 *  unset when it is not. A repo whose mark did not move is the same object,
 *  and the array is the same one when nothing moved. */
export function linkHarness(repos: Repo[], paths: ReadonlySet<string>): Repo[] {
  let moved = false;
  const out = repos.map((r) => {
    const on = paths.has(r.path);
    if (on === (r.harness === true)) return r;
    moved = true;
    if (on) return { ...r, harness: true as const };
    const { harness: _gone, ...rest } = r;
    return rest;
  });
  return moved ? out : repos;
}
