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

/** A solo window sized to the screen it opens on: wide enough for a diff, as
 *  tall as the screen allows, centred. availHeight already excludes the menu
 *  bar and the dock. Clamped at both ends so a laptop does not get a window
 *  wider than its screen and a 5K display does not get one the width of a
 *  wall. */
export function popupFeatures(avail: { width: number; height: number }): string {
  const w = Math.round(Math.min(1200, Math.max(720, avail.width * 0.55)));
  const h = Math.min(1500, avail.height);
  const width = Math.min(w, avail.width);
  const height = Math.min(h, avail.height);
  const left = Math.round(Math.max(0, (avail.width - width) / 2));
  const top = Math.round(Math.max(0, (avail.height - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/**
 * Opens a repo outside the dock. The window is named after the repo, so a
 * second click reuses it instead of stacking duplicates.
 */
export function openElsewhere(id: string, target: Exclude<OpenTarget, "dock">) {
  const name = `canopy:${id}`;
  const url = soloUrl(id);
  const avail = {
    width: window.screen?.availWidth || 1440,
    height: window.screen?.availHeight || 900,
  };
  const win =
    target === "window"
      ? window.open(url, name, popupFeatures(avail))
      : window.open(url, name);
  win?.focus();
}
