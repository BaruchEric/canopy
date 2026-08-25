import type { OpenTarget } from "./settings";

/** What the URL asked this window to show. `/?repo=<id>` pins that repo on
 *  load; add `view=solo` and the window shows only that repo's panel. */
export interface Route {
  repo: string | null;
  solo: boolean;
}

export function parseRoute(search: string): Route {
  const q = new URLSearchParams(search);
  const repo = q.get("repo");
  return { repo: repo || null, solo: Boolean(repo) && q.get("view") === "solo" };
}

export function soloUrl(id: string): string {
  const u = new URL(window.location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("repo", id);
  u.searchParams.set("view", "solo");
  return u.toString();
}

/** The whole grove, whatever this window is showing. */
export function groveUrl(): string {
  const u = new URL(window.location.href);
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * Opens a repo outside the dock. The window is named after the repo, so a
 * second click reuses it instead of stacking duplicates.
 */
export function openElsewhere(id: string, target: Exclude<OpenTarget, "dock">) {
  const name = `canopy:${id}`;
  const url = soloUrl(id);
  const win =
    target === "window"
      ? window.open(url, name, "popup=yes,width=620,height=940")
      : window.open(url, name);
  win?.focus();
}
