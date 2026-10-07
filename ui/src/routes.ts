import { isSproutId } from "../../src/core/sprout";
import { isSectionKey, type SectionKey } from "./surface";

/** What the URL asked this window to show. `/?repo=<id>` pins that repo on
 *  load; add `view=solo` and the window shows only that repo's panel,
 *  `view=shell` and it shows only a shell at that repo, named by `term=`
 *  once it has one so a reload comes back to the same shell, and
 *  `view=section&section=<key>` one section of that repo's panel. */
export interface Route {
  repo: string | null;
  solo: boolean;
  shell: boolean;
  /** the shell window's shell, once it has named one */
  term: string | null;
  /** the one section a section window shows */
  section: SectionKey | null;
  /** the task a shell window shows, which it only ever joins */
  task: string | null;
  /** `?view=agents&ask=<id>`: the inbox opened on that ask, the link the
   *  broker's away DM carries */
  ask: string | null;
  /** `popped=1`: a solo window the dock popped its panel out to, the only
   *  kind that tells the dock it has the panel */
  popped: boolean;
}

/** a shell's name: 32 hex digits, after another backend's name for one of
 *  its shells */
const TERM_ID = /^(?:[a-z0-9-]+\|)?[0-9a-f]{32}$/;

export function parseRoute(search: string): Route {
  const q = new URLSearchParams(search);
  const repo = q.get("repo");
  const view = repo ? q.get("view") : null;
  const term = q.get("term");
  const section = q.get("section");
  const task = q.get("task");
  return {
    repo: repo || null,
    solo: view === "solo",
    shell: view === "shell",
    term: view === "shell" && term && TERM_ID.test(term) ? term : null,
    section: view === "section" && isSectionKey(section) ? section : null,
    task: view === "shell" && task && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(task) ? task : null,
    ask: askOf(q),
    popped: view === "solo" && q.get("popped") === "1",
  };
}

/** an ask's id off `?view=agents&ask=`, the broker's id shape, or null */
function askOf(q: URLSearchParams): string | null {
  const ask = q.get("ask");
  return q.get("view") === "agents" && ask && /^[A-Za-z0-9-]{1,64}$/.test(ask) ? ask : null;
}

/** Takes `ask=` off this window's URL once the inbox has it, so a reload
 *  does not open the popover on an ask long answered. */
export function dropAskHere() {
  const u = new URL(window.location.href);
  if (!u.searchParams.has("ask")) return;
  u.searchParams.delete("ask");
  window.history.replaceState(null, "", u.toString());
}

/** `?view=incubator&sprout=<id>`: the incubator with that project open, the
 *  link `canopy new` prints */
export function sproutHere(search: string): string | null {
  const q = new URLSearchParams(search);
  const id = q.get("sprout");
  return q.get("view") === "incubator" && id && isSproutId(id) ? id : null;
}

/** Takes `sprout=` off this window's URL once the sheet has it. */
export function dropSproutHere() {
  const u = new URL(window.location.href);
  if (!u.searchParams.has("sprout")) return;
  u.searchParams.delete("sprout");
  window.history.replaceState(null, "", u.toString());
}

/** Writes the shell's name into this window's URL, in place. */
export function nameShellHere(term: string) {
  const u = new URL(window.location.href);
  u.searchParams.set("term", term);
  window.history.replaceState(null, "", u.toString());
}

function viewUrl(id: string, view: "solo" | "shell" | "section"): string {
  const u = new URL(window.location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("repo", id);
  u.searchParams.set("view", view);
  return u.toString();
}

export function soloUrl(id: string, opts?: { popped?: boolean }): string {
  const u = new URL(viewUrl(id, "solo"));
  if (opts?.popped) u.searchParams.set("popped", "1");
  return u.toString();
}
export const shellUrl = (id: string): string => viewUrl(id, "shell");

/** one section of a repo's panel, in a window of its own */
export function sectionUrl(id: string, section: SectionKey): string {
  const u = new URL(viewUrl(id, "section"));
  u.searchParams.set("section", section);
  return u.toString();
}

/** an existing shell, joined from a window of its own */
export function heldShellUrl(id: string, term: string): string {
  const u = new URL(shellUrl(id));
  u.searchParams.set("term", term);
  return u.toString();
}

/** a task's terminal in a window of its own */
export function taskShellUrl(id: string, term: string, task: string): string {
  const u = new URL(heldShellUrl(id, term));
  u.searchParams.set("task", task);
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
export function openElsewhere(id: string, target: "tab" | "window") {
  openNamed(`canopy:${id}`, soloUrl(id), target);
}

/** A panel popped out of the dock, in a window of its own named apart from
 *  the plain solo window's, so a later "open in a new tab" of the same repo
 *  does not land in it. The window, or null when the browser blocked it. */
export function popOutWindow(id: string): Window | null {
  return openNamed(`canopy:pop:${id}`, soloUrl(id, { popped: true }), "window");
}

/** A shell at a repo in a tab or window of its own. Every click is a new
 *  shell, so the window is named after the moment rather than the repo. */
export function openShellElsewhere(id: string, target: "tab" | "window") {
  openNamed(`canopy:shell:${id}:${Date.now()}`, shellUrl(id), target);
}

/** One section of a repo's panel in a tab or window of its own, reused on
 *  a second click like a solo panel's. */
export function openSectionElsewhere(id: string, section: SectionKey, target: "tab" | "window") {
  openNamed(`canopy:${id}:${section}`, sectionUrl(id, section), target);
}

/** A shell that is already running, in a tab or window of its own: the new
 *  window joins it rather than starting another. */
export function popShell(id: string, term: string, target: "tab" | "window") {
  openNamed(`canopy:shell:${term}`, heldShellUrl(id, term), target);
}

function openNamed(name: string, url: string, target: "tab" | "window"): Window | null {
  const avail = {
    width: window.screen?.availWidth || 1440,
    height: window.screen?.availHeight || 900,
  };
  const win =
    target === "window"
      ? window.open(url, name, popupFeatures(avail))
      : window.open(url, name);
  win?.focus();
  return win;
}
