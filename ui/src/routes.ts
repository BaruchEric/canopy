import { FOCUS_PANE } from "./panes";
import { isSproutId } from "../../src/core/sprout";
import { isPopupName, type ItemKind, type PopupName } from "./sectiontabs";
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
  /** `popped=1`: a window the dock popped a panel out to (a repo's, a
   *  chat's, an agent's or a popup's), the only kind that tells the dock it
   *  has the panel */
  popped: boolean;
  /** `?view=agent`: one agent's screen in a window of its own, the agents
   *  board's focus popped out; `card` names it, `follow=1` makes it show
   *  whichever agent the board focuses */
  agent: { card: string | null; follow: boolean } | null;
  /** `?view=run&run=<id>`: one chat in a window of its own, the dock's
   *  run panel popped out (FR-047) */
  run: string | null;
  /** `?view=popup&popup=<name>`: one of the top bar's popups in a window
   *  of its own (FR-084) */
  popup: PopupName | null;
}

/** a registry card's id: a harness and a session, or a scan's */
const CARD_ID = /^[A-Za-z0-9][\w:.@|-]{0,199}$/;

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
  const run = runOf(q);
  const agent = agentOf(q);
  const popup = popupOf(q);
  // an agent's window is a dock panel's only on one agent, never the
  // board's focus pane, which speaks the channel under its own name
  const panel = view === "solo" || run !== null || popup !== null || (agent !== null && agent.card !== null && !agent.follow);
  return {
    repo: repo || null,
    solo: view === "solo",
    shell: view === "shell",
    term: view === "shell" && term && TERM_ID.test(term) ? term : null,
    section: view === "section" && isSectionKey(section) ? section : null,
    task: view === "shell" && task && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(task) ? task : null,
    ask: askOf(q),
    popped: panel && q.get("popped") === "1",
    agent,
    run,
    popup,
  };
}

/** Whether a route makes a window of one thing (a repo's panel, one of its
 *  sections, a shell, a chat, an agent or a popup) and not the whole page. */
export const isOwnWindow = (r: Route): boolean =>
  r.run !== null || r.agent !== null || r.popup !== null || (r.repo !== null && (r.solo || r.shell || r.section !== null));

/** a run's id: the backend's short id, after another backend's name for
 *  one of its runs */
const RUN_ID = /^[A-Za-z0-9][\w:.|-]{0,99}$/;

function runOf(q: URLSearchParams): string | null {
  if (q.get("view") !== "run" || q.get("repo")) return null;
  const run = q.get("run");
  return run && RUN_ID.test(run) ? run : null;
}

function popupOf(q: URLSearchParams): PopupName | null {
  if (q.get("view") !== "popup" || q.get("repo")) return null;
  const name = q.get("popup");
  return isPopupName(name) ? name : null;
}

function agentOf(q: URLSearchParams): Route["agent"] {
  if (q.get("view") !== "agent" || q.get("repo")) return null;
  const card = q.get("card");
  return { card: card && CARD_ID.test(card) ? card : null, follow: q.get("follow") === "1" };
}

/** The agents board's focus popped out (`FOCUS_PANE` in panes.ts): a
 *  window that shows the agent the board focuses (`follow=1`), starting
 *  from `card`. Named like a popped panel's, so a second press brings the
 *  same window forward. */
export function popOutFocus(card: string | null): Window | null {
  const q = new URLSearchParams({ view: "agent", follow: "1" });
  if (card) q.set("card", card);
  return openNamed(`canopy:pop:${FOCUS_PANE}`, `${window.location.pathname}?${q}`, "window");
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

/** `?view=manager&sprout=<id>`: the manager's overview with that project's
 *  sheet open. `canopy new` prints the incubator's old address,
 *  `?view=incubator&sprout=<id>`, which the page takes as this one. */
export function sproutHere(search: string): string | null {
  const q = new URLSearchParams(search);
  const id = q.get("sprout");
  const view = q.get("view");
  return (view === "manager" || view === "incubator") && id && isSproutId(id) ? id : null;
}

/** The views that live inside another now: the incubator's projects are in
 *  the manager's overview, beside the goals. An old link, a voice command
 *  or a CLI word that names one lands on the view that holds it. */
export const viewOf = (view: string): string => (view === "incubator" ? "manager" : view);

/** Takes `sprout=` off this window's URL once the sheet has it. */
export function dropSproutHere() {
  const u = new URL(window.location.href);
  if (!u.searchParams.has("sprout")) return;
  u.searchParams.delete("sprout");
  window.history.replaceState(null, "", u.toString());
}

/** `?view=manager&run=<id>`: the manager's top view of that coordinator's
 *  goal (ManagerView.tsx), the id decoded (`mini|ed71ddfb`) */
export function managerHere(search: string): string | null {
  const q = new URLSearchParams(search);
  const id = q.get("run");
  return q.get("view") === "manager" && id && RUN_ID.test(id) ? id : null;
}

/** What the new box starts: a goal across repos, or a project through the incubator. */
export type NewKind = "goal" | "project";

/** What opening the overview asks for: the new box focused, on a kind. */
export interface ManagerOpen {
  new?: true;
  kind?: NewKind;
}

/** `?view=manager&new=1`: the goals and projects to pick from with the new
 *  box focused, the top bar's "+ new" and `n` */
export function managerNew(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.get("view") === "manager" && q.get("new") === "1";
}

/** `&kind=project` or `&kind=goal` beside `new=1`: the kind the box starts
 *  on; null leaves it on the one last used */
export function newKindHere(search: string): NewKind | null {
  const q = new URLSearchParams(search);
  const kind = q.get("kind");
  return managerNew(search) && (kind === "goal" || kind === "project") ? kind : null;
}

/** The top view's address on this page: a coordinator's goal, or with no
 *  id the goals and projects to pick from, `new` with the new box focused. */
export function managerUrl(runId: string | null, opts?: ManagerOpen): string {
  const tail = runId ? `&run=${encodeURIComponent(runId)}` : opts?.new ? `&new=1${opts.kind ? `&kind=${opts.kind}` : ""}` : "";
  return `${location.pathname}?view=manager${tail}`;
}

/** Opens the top view of a coordinator's goal, or the goals and projects to
 *  pick from. The whole page changes in place and hears it as it hears
 *  back and forward (App and ManagerView follow popstate); a window of one
 *  thing shows only what its address named when it opened, so it loads anew. */
export function openManager(runId: string | null, opts?: ManagerOpen): void {
  const url = managerUrl(runId, opts);
  if (isOwnWindow(parseRoute(location.search))) {
    location.assign(url);
    return;
  }
  history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
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
 *  wall. `slim` is a list's window (a popup's): a column wide, like the
 *  popover it came from. */
export function popupFeatures(avail: { width: number; height: number }, slim = false): string {
  const w = slim ? Math.round(Math.min(640, Math.max(440, avail.width * 0.28))) : Math.round(Math.min(1200, Math.max(720, avail.width * 0.55)));
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

/** this page's address with nothing asked of it but `params` */
function bareUrl(params: Record<string, string>, popped?: boolean): string {
  const u = new URL(window.location.href);
  u.search = "";
  u.hash = "";
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (popped) u.searchParams.set("popped", "1");
  return u.toString();
}

/** one chat in a window of its own (RunSolo.tsx) */
export const runUrl = (runId: string, opts?: { popped?: boolean }): string => bareUrl({ view: "run", run: runId }, opts?.popped);

/** one agent's screen in a window of its own, on that agent and not the
 *  board's focus (AgentSolo.tsx) */
export const agentUrl = (card: string, opts?: { popped?: boolean }): string => bareUrl({ view: "agent", card }, opts?.popped);

/** one of the top bar's popups in a window of its own (PopupSolo.tsx) */
export const popupUrl = (name: PopupName, opts?: { popped?: boolean }): string => bareUrl({ view: "popup", popup: name }, opts?.popped);

/** the whole page on one view; the git view is the page with no view named */
export const pageUrl = (view: string): string => bareUrl(view === "git" ? {} : { view });

/** What a popup, a sheet, a tab or a dock panel shows as an item (a chat,
 *  an agent's screen, a popup; sectiontabs.ts). */
export interface ItemRef {
  kind: ItemKind;
  ref: string;
}

/** An item's window (FR-084): its address, and the name the browser keeps
 *  the window under, so a second ask brings the same one forward. A panel
 *  popped out of the dock is named apart from a plain window, as a repo's
 *  is, and says `popped=1`. Null for a popup by a name it has not. */
export function itemWindow(item: ItemRef, popped = false): { name: string; url: string; slim: boolean } | null {
  const name = `canopy:${popped ? "pop:" : ""}${item.kind}:${item.ref}`;
  switch (item.kind) {
    case "run":
      return { name, url: runUrl(item.ref, { popped }), slim: false };
    case "agent":
      return { name, url: agentUrl(item.ref, { popped }), slim: false };
    case "popup":
      return isPopupName(item.ref) ? { name, url: popupUrl(item.ref, { popped }), slim: true } : null;
  }
}

/** A chat, an agent's screen or a popup in a window of its own, which takes
 *  nothing from where it was showing. The window, or null when the browser
 *  blocked it. */
export function openItemWindow(item: ItemRef): Window | null {
  const w = itemWindow(item);
  return w ? openNamed(w.name, w.url, "window", w.slim) : null;
}

/** An item's panel popped out of the dock (FR-047, FR-084): its window
 *  joins the panes protocol under the panel's id as a repo's does. The
 *  window, or null when the browser blocked it. */
export function popOutItem(item: ItemRef): Window | null {
  const w = itemWindow(item, true);
  return w ? openNamed(w.name, w.url, "window", w.slim) : null;
}

/** A chat's panel popped out of the dock (FR-047). */
export const popOutRun = (runId: string): Window | null => popOutItem({ kind: "run", ref: runId });

/** One view of the whole page in a window of its own, reused on a second
 *  ask for the same view. */
export function openViewWindow(view: string): Window | null {
  return openNamed(`canopy:view:${view}`, pageUrl(view), "window");
}

/** The whole page on a view, from a window of one thing, which shows no
 *  view of its own: one tab, taken again on the next ask. */
export function openPage(view: string): Window | null {
  return openNamed("canopy:page", pageUrl(view), "tab");
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
 *  window joins it rather than starting another. A task's shell says which
 *  task, so its window only ever joins. */
export function popShell(id: string, term: string, target: "tab" | "window", task?: string) {
  openNamed(`canopy:shell:${term}`, task ? taskShellUrl(id, term, task) : heldShellUrl(id, term), target);
}

function openNamed(name: string, url: string, target: "tab" | "window", slim = false): Window | null {
  const avail = {
    width: window.screen?.availWidth || 1440,
    height: window.screen?.availHeight || 900,
  };
  const win =
    target === "window"
      ? window.open(url, name, popupFeatures(avail, slim))
      : window.open(url, name);
  win?.focus();
  return win;
}
