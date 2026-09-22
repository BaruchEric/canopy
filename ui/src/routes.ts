/** What the URL asked this window to show. `/?repo=<id>` pins that repo on
 *  load; add `view=solo` and the window shows only that repo's panel,
 *  `view=shell` and it shows only a shell at that repo, named by `term=`
 *  once it has one so a reload comes back to the same shell. */
export interface Route {
  repo: string | null;
  solo: boolean;
  shell: boolean;
  /** the shell window's shell, once it has named one */
  term: string | null;
}

const TERM_ID = /^[0-9a-f]{32}$/;

export function parseRoute(search: string): Route {
  const q = new URLSearchParams(search);
  const repo = q.get("repo");
  const view = repo ? q.get("view") : null;
  const term = q.get("term");
  return {
    repo: repo || null,
    solo: view === "solo",
    shell: view === "shell",
    term: view === "shell" && term && TERM_ID.test(term) ? term : null,
  };
}

/** Writes the shell's name into this window's URL, in place. */
export function nameShellHere(term: string) {
  const u = new URL(window.location.href);
  u.searchParams.set("term", term);
  window.history.replaceState(null, "", u.toString());
}

function viewUrl(id: string, view: "solo" | "shell"): string {
  const u = new URL(window.location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("repo", id);
  u.searchParams.set("view", view);
  return u.toString();
}

export const soloUrl = (id: string): string => viewUrl(id, "solo");
export const shellUrl = (id: string): string => viewUrl(id, "shell");

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
export function openElsewhere(id: string, target: "tab" | "window") {
  openNamed(`canopy:${id}`, soloUrl(id), target);
}

/** A shell at a repo in a tab or window of its own. Every click is a new
 *  shell, so the window is named after the moment rather than the repo. */
export function openShellElsewhere(id: string, target: "tab" | "window") {
  openNamed(`canopy:shell:${id}:${Date.now()}`, shellUrl(id), target);
}

function openNamed(name: string, url: string, target: "tab" | "window") {
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
