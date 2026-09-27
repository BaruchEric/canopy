import { create } from "zustand";
import { api, subscribe } from "./api";
import { applyQuery, type RepoFilter } from "./filters";
import { focusPanel, nextActive } from "./dock";
import { heldShellUrl, openElsewhere, openShellElsewhere, parseRoute } from "./routes";
import { loadSettings, saveSettings, shellPlace, type Settings, type ShellPlace } from "./settings";
import { PANEL_TERM_ROWS, adoptTerms, keepFront, loadFocusSize, loadTermTabs, nextStripTab, pruneHidden, reconcileTerms, rowsPx, shellSet, termId, type FocusSize, type TermTab } from "./term";
import { clientId, identity } from "./client";
export type { TermTab } from "./term";
import { clamp, needsAttention } from "./util";
import { ownRun, pickable, selectable } from "./flows";
import { boardOrder, invertPick, pickWhere, rangeIds, setPick, togglePick } from "./select";
import { appendFeed, describeEvent, type FeedEntry } from "./feed";
import { mergeAction } from "./peers";
import { convOf, isUnread, mergeMessages } from "./chan";
import type { ChanMessage, TailchanInfo } from "../../src/core/types";
import { clientCaps } from "../../src/core/client";
import {
  DEFAULT_AGENT,
  DEFAULT_LAUNCH,
  isFlowActive,
  isRunActive,
  type AgentSettings,
  type Backend,
  type ClientCaps,
  type ClientInfo,
  type Device,
  type HelperInfo,
  type Fleet,
  type Flow,
  type FlowChoice,
  type HistoryOverview,
  type Job,
  type KeptShell,
  type LaunchSettings,
  type OpenerId,
  type PeerSeen,
  type PeerSync,
  type Repo,
  type TermInfo,
  type Run,
  type RunAction,
  type RunAnswer,
  type ScanResult,
  type ServerEvent,
  type SourceInput,
  type SourceState,
  type WorkflowEntry,
  type Workspace,
} from "../../src/core/types";

/** drag limits for the two resizable panes, in px */
export const SIDEBAR = { min: 180, max: 560, initial: 264 };
export const PANEL = { min: 300, max: 900, initial: 440 };
/** the dock when it is one tabbed panel: wider than a row's panel may be,
 *  since it is the only one */
export const DOCK = { min: 300, max: 1400, initial: 440 };
/** the solo view's centered panel; the window caps it before max does */
export const SOLO = { min: 420, max: 2400, initial: 980 };
/** the terminal strip along the bottom, in px of height */
export const TERM = { min: 120, max: 1200, initial: 300 };
/** a shell living in a repo's panel: the bounds of its body's height, and the
 *  default, which is PANEL_TERM_ROWS lines of the terminal's font */
export const PANEL_TERM = { min: 60, max: 900, initial: rowsPx(PANEL_TERM_ROWS) };
/** the event feed along the bottom, in px of height */
export const FEED = { min: 100, max: 900, initial: 220 };
/** sections that start folded, matching how the panel read before they could fold */
const DEFAULT_CLOSED = ["search", "history", "claude", "launch", "peers", "preview"];
/** the folded-by-default set a layout saved before `knownSections` existed
 *  had decided about; anything added to DEFAULT_CLOSED since folds for it */
const OLD_KNOWN = ["search", "history", "claude"];

/** The folded sections a saved layout means: what it stored, plus any section
 *  that folds by default and did not exist when it was saved. Keeping the
 *  stored list alone would open every new section in every panel. */
export function closedSectionsOf(saved: string[], known: string[]): string[] {
  const extra = DEFAULT_CLOSED.filter((k) => !known.includes(k) && !saved.includes(k));
  return extra.length ? [...saved, ...extra] : saved;
}

/** folded sections by repo id; a repo with no entry folds DEFAULT_CLOSED */
export type ClosedSections = Record<string, string[]>;

/** the height of the shell in one repo's panel: its own, else the default */
export function panelTermHeightFor(s: { panelTermHeights: Record<string, number> }, repoId: string): number {
  return s.panelTermHeights[repoId] ?? PANEL_TERM.initial;
}

/** the folded sections of one repo's panel */
export function sectionsFor(closed: ClosedSections, repoId: string): string[] {
  return closed[repoId] ?? DEFAULT_CLOSED;
}

/** whether `key` is folded in one repo's panel; a boolean, so a selector
 *  built on it is stable where the array behind it is not */
export function closedIn(s: { closedSections: ClosedSections }, repoId: string, key: string): boolean {
  return sectionsFor(s.closedSections, repoId).includes(key);
}

/** `closed` with `key` folded or unfolded in one repo's panel, the others untouched */
export function toggleIn(closed: ClosedSections, repoId: string, key: string): ClosedSections {
  const mine = sectionsFor(closed, repoId);
  return {
    ...closed,
    [repoId]: mine.includes(key) ? mine.filter((k) => k !== key) : [...mine, key],
  };
}

/** `closed` with `key` unfolded in one repo's panel; the same object when it already is */
export function unfoldIn(closed: ClosedSections, repoId: string, key: string): ClosedSections {
  const mine = sectionsFor(closed, repoId);
  return mine.includes(key) ? { ...closed, [repoId]: mine.filter((k) => k !== key) } : closed;
}

/** the fields of `next` that are not the same value as in `before` */
export function changed<T extends object>(next: T, before: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (next[k] !== before[k]) out[k] = next[k];
  }
  return out;
}

const LAYOUT_KEY = "canopy.layout";

/** how often a window re-reads the archive overview on its own */
const HISTORY_REFRESH = 10 * 60_000;

interface Layout {
  sidebarWidth: number;
  panelWidths: Record<string, number>;
  /** px width of the panel in the solo view, shared by every solo tab */
  soloWidth: number;
  /** px width of the dock when it is tabbed, whichever tab shows */
  dockWidth: number;
  /** whether the repo tree is showing at all */
  sidebarOpen: boolean;
  /** folded tree groups, as group-key strings */
  collapsed: string[];
  /** folded panel sections (changes, shell, history, claude…) by repo id */
  closedSections: ClosedSections;
  /** the shell tabs, each named for its shell on the server, and the one
   *  showing in the strip: a reload comes back to the shells still there */
  terms: TermTab[];
  activeTerm: string | null;
  /** the running shells this browser put down without ending, which it
   *  does not take up as tabs again until picked from the shells list */
  hiddenTerms: string[];
  /** the default-folded sections this layout has decided about, so a
   *  section added later starts folded instead of open everywhere */
  knownSections: string[];
  /** px height of the terminal strip */
  termHeight: number;
  /** px height of the shell in each repo's panel, by repo id; a repo with
   *  no entry gets the default */
  panelTermHeights: Record<string, number>;
  /** px size of a shell brought to the front; null follows the window */
  focusSize: FocusSize | null;
  /** whether the event feed is showing along the bottom */
  feedOpen: boolean;
  /** px height of the event feed */
  feedHeight: number;
  /** the repos open in the dock, in order, so a reload shows the same ones */
  panels: string[];
  /** the dock's showing tab */
  activePanel: string | null;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];

function loadLayout(): Layout {
  const fallback: Layout = {
    sidebarWidth: SIDEBAR.initial,
    panelWidths: {},
    soloWidth: SOLO.initial,
    dockWidth: DOCK.initial,
    sidebarOpen: true,
    collapsed: [],
    closedSections: {},
    knownSections: [...DEFAULT_CLOSED],
    termHeight: TERM.initial,
    panelTermHeights: {},
    focusSize: null,
    feedOpen: false,
    feedHeight: FEED.initial,
    panels: [],
    activePanel: null,
    terms: [],
    activeTerm: null,
    hiddenTerms: [],
  };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as {
      sidebarWidth?: unknown;
      panelWidths?: Record<string, unknown>;
      soloWidth?: unknown;
      dockWidth?: unknown;
      sidebarOpen?: unknown;
      collapsed?: unknown;
      closedSections?: unknown;
      knownSections?: unknown;
      termHeight?: unknown;
      panelTermHeights?: Record<string, unknown>;
      focusSize?: unknown;
      feedOpen?: unknown;
      feedHeight?: unknown;
      panels?: unknown;
      activePanel?: unknown;
      terms?: unknown;
      activeTerm?: unknown;
      hiddenTerms?: unknown;
    };
    // Anything hand-edited or written by an older build gets clamped rather
    // than trusted — a bad number here would render an unusable panel.
    const sizes = (saved: Record<string, unknown> | undefined, bounds: { min: number; max: number }) => {
      const out: Record<string, number> = {};
      for (const [id, px] of Object.entries(saved ?? {})) {
        if (typeof px === "number" && Number.isFinite(px)) out[id] = clamp(px, bounds.min, bounds.max);
      }
      return out;
    };
    const panelWidths = sizes(saved.panelWidths, PANEL);
    // one shell height per panel; the one global height a layout kept before
    // this is left behind, so every panel starts at the default
    const panelTermHeights = sizes(saved.panelTermHeights, PANEL_TERM);
    // Folds are by repo. A layout from when they were one list for every
    // panel (an array here) starts every panel at the defaults instead.
    const known = Array.isArray(saved.knownSections) ? strings(saved.knownSections) : OLD_KNOWN;
    const closedSections: ClosedSections = {};
    if (saved.closedSections && typeof saved.closedSections === "object" && !Array.isArray(saved.closedSections)) {
      for (const [id, keys] of Object.entries(saved.closedSections)) {
        if (Array.isArray(keys)) closedSections[id] = closedSectionsOf(strings(keys), known);
      }
    }
    const sw = saved.sidebarWidth;
    const solo = saved.soloWidth;
    const dw = saved.dockWidth;
    const th = saved.termHeight;
    const fh = saved.feedHeight;
    return {
      sidebarWidth:
        typeof sw === "number" && Number.isFinite(sw)
          ? clamp(sw, SIDEBAR.min, SIDEBAR.max)
          : SIDEBAR.initial,
      panelWidths,
      soloWidth:
        typeof solo === "number" && Number.isFinite(solo)
          ? clamp(solo, SOLO.min, SOLO.max)
          : SOLO.initial,
      dockWidth:
        typeof dw === "number" && Number.isFinite(dw)
          ? clamp(dw, DOCK.min, DOCK.max)
          : DOCK.initial,
      sidebarOpen: saved.sidebarOpen !== false,
      collapsed: strings(saved.collapsed),
      closedSections,
      knownSections: [...DEFAULT_CLOSED],
      termHeight:
        typeof th === "number" && Number.isFinite(th)
          ? clamp(th, TERM.min, TERM.max)
          : TERM.initial,
      panelTermHeights,
      focusSize: loadFocusSize(saved.focusSize),
      feedOpen: saved.feedOpen === true,
      feedHeight:
        typeof fh === "number" && Number.isFinite(fh)
          ? clamp(fh, FEED.min, FEED.max)
          : FEED.initial,
      panels: strings(saved.panels),
      activePanel: typeof saved.activePanel === "string" ? saved.activePanel : null,
      terms: loadTermTabs(saved.terms),
      activeTerm: typeof saved.activeTerm === "string" ? saved.activeTerm : null,
      hiddenTerms: strings(saved.hiddenTerms),
    };
  } catch {
    return fallback;
  }
}

/** Writes the fields in `patch` over what is stored, leaving the rest as the
 *  last window to save them left it. Two windows share the key (the grove
 *  and a solo panel, say); one writing its whole copy would put back the
 *  other's dock as it stood when this one loaded. */
function saveLayout(patch: Partial<Layout>) {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : {};
    const base = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ ...base, ...patch, knownSections: DEFAULT_CLOSED }),
    );
  } catch {
    // storage can be disabled outright; the layout just won't survive a reload
  }
}

/** the persisted part of the state, minus `knownSections`, which is a constant */
const layoutOf = (s: CanopyState): Omit<Layout, "knownSections"> => ({
  sidebarWidth: s.sidebarWidth,
  panelWidths: s.panelWidths,
  soloWidth: s.soloWidth,
  dockWidth: s.dockWidth,
  sidebarOpen: s.sidebarOpen,
  collapsed: s.collapsed,
  closedSections: s.closedSections,
  termHeight: s.termHeight,
  panelTermHeights: s.panelTermHeights,
  focusSize: s.focusSize,
  feedOpen: s.feedOpen,
  feedHeight: s.feedHeight,
  panels: s.panels,
  activePanel: s.activePanel,
  terms: s.terms,
  activeTerm: s.activeTerm,
  hiddenTerms: s.hiddenTerms,
});

/** drops entries for repos that no longer exist in the scan; the same
 *  object when every one still does */
export function pruneByRepo<T>(map: Record<string, T>, repos: Repo[]): Record<string, T> {
  const ids = new Set(repos.map((r) => r.id));
  const kept = Object.entries(map).filter(([id]) => ids.has(id));
  if (kept.length === Object.keys(map).length) return map;
  return Object.fromEntries(kept);
}

interface CanopyState {
  root: string;
  /** every scanned folder, the launch root first */
  sources: SourceState[];
  repos: Repo[];
  /** what this backend can do for its clients (desktop openers, ssh alias) */
  backend: Backend;
  /** what the backend knows of this browser: its address, and whether it is
   *  on the backend's own Mac */
  client: ClientInfo;
  /** the `canopy helper`s dialled in to the backend, by name */
  helpers: HelperInfo[];
  /** the browsers on the backend's event stream now, this one among them */
  devices: Device[];
  /** who was last seen reachable in the peer pass, mac/mini/… by name */
  peerSeen: PeerSeen[];
  /** whether the backend pulls from peers at all, and whether it writes */
  peerSync: PeerSync;
  /** every shell the server holds, with who is looking at each; the tabs
   *  here are the ones of those this window shows */
  shells: TermInfo[];
  /** the shells a machine going down left behind, offered to restore */
  kept: KeptShell[];
  /** whether the backend is writing shell history out at all */
  keeping: boolean;
  /** tailchan as the backend sees it: null until asked, `ready: false`
   *  with why when the backend knows no broker */
  chan: TailchanInfo | null;
  /** the handle the UI speaks tailchan as, "" until known; the feed reads
   *  it to call the UI's own posts "you" */
  chanAs: string;
  /** messages by conversation (channel name, `dm.a+b` for a DM) */
  chanMsgs: Record<string, ChanMessage[]>;
  /** messages heard since the popover was last looked at */
  chanUnread: number;
  /** whether the tailchan popover is up, and which conversation it shows */
  chanOpen: boolean;
  chanConv: string | null;
  workspaces: Workspace[];
  loaded: boolean;
  /** why the initial load failed, if it did */
  loadError: string | null;
  filter: string;
  dirtyOnly: boolean;
  /** lit status facets; a repo shows when it matches any of them */
  filters: RepoFilter[];
  /** lit git identities, as userKey strings (NOBODY for repos with none) */
  users: string[];
  /** active workspace tab; null = all */
  activeWs: string | null;
  /** repo ids pinned open in the dock, left to right */
  panels: string[];
  /** the panel showing when the dock is tabbed (`openIn: "tabs"`); kept
   *  in every mode so switching the setting keeps the place */
  activePanel: string | null;
  /** repo id → last SSE update, for the update pulse */
  updatedAt: Record<string, number>;
  /** px width of the repo tree, dragged by the sidebar resizer */
  sidebarWidth: number;
  sidebarOpen: boolean;
  /** folded sections in the tree and the grid, as sectionKey strings */
  collapsed: string[];
  /** folded panel sections (changes, shell, history, claude…) by repo id */
  closedSections: ClosedSections;
  /** repo id → px width of its dock panel; missing means PANEL.initial */
  panelWidths: Record<string, number>;
  /** px width of the solo view's panel, dragged by its edge handles */
  soloWidth: number;
  /** px width of the tabbed dock, dragged by its left edge */
  dockWidth: number;
  /** per-browser preferences, persisted in localStorage */
  settings: Settings;
  /** Claude Code runs by id, live and recently finished */
  runs: Record<string, Run>;
  /** the modal in front of the grove: a pre-flight for an action, or a run */
  sheet: Sheet | null;
  /** the last term searched across repos; the sheet reopens on it */
  searchQuery: string;
  /** a term carried from the search sheet into one repo's search section,
   *  taken by that section when it mounts or sees it */
  pendingSearch: { repoId: string; q: string } | null;
  /** the claude-history archive, per repo; null until the first fetch lands */
  history: HistoryOverview | null;
  /** how Claude starts per repo, keyed by repo path; absent means defaults */
  agents: Record<string, AgentSettings>;
  /** how a repo's builds are made and run, keyed by repo path */
  launchers: Record<string, LaunchSettings>;
  /** downloads and builds by id, live and recently finished */
  jobs: Record<string, Job>;
  /** repo id → bumped whenever its builds changed, so the launch section re-reads */
  buildsAt: Record<string, number>;
  /** every shell open in this window, in the order opened */
  terms: TermTab[];
  /** the shell showing in the strip; null when the strip is empty */
  activeTerm: string | null;
  /** running shells this browser hid rather than ended, by name */
  hiddenTerms: string[];
  /** px height of the strip, dragged by its top edge */
  termHeight: number;
  /** px height of the shell in each repo's panel, by repo id, dragged by its
   *  top edge; `panelTermHeightFor` reads one */
  panelTermHeights: Record<string, number>;
  /** px size of a shell brought to the front, dragged by its corner; null
   *  is the default, which follows the window */
  focusSize: FocusSize | null;
  /** the set of shells brought to the front (`shellSet`: the strip or a
   *  repo's panel), null when none is; one at a time, for this page only */
  frontShells: string | null;
  /** the shell the front set should show, asked for from another set's
   *  list; its set picks it up */
  frontPick: string | null;
  /** flows by id, live and recently finished */
  flows: Record<string, Flow>;
  /** fleets by id, live and recently finished */
  fleets: Record<string, Fleet>;
  /** workflows the menu last fetched, by repo id */
  workflows: Record<string, WorkflowEntry[]>;
  /** run id to flow id, for every run a flow owns; those runs stay off the cards */
  flowRuns: Record<string, string>;
  /** select mode on the board */
  selecting: boolean;
  /** repo ids picked for a fleet; read through `pickedIds`, which drops the ones the view no longer shows */
  selected: string[];
  /** the last repo clicked in select mode, where a shift-click's range starts */
  selectAnchor: string | null;
  /** whether the server has a gateway key, so verdict gates can judge */
  verdictReady: boolean;
  /** every server event since the page loaded, as lines, newest last */
  feed: FeedEntry[];
  /** the next feed entry's id */
  feedSeq: number;
  /** whether the feed is showing along the bottom */
  feedOpen: boolean;
  /** px height of the feed, dragged by its top edge */
  feedHeight: number;
  /** the source the feed is narrowed to; null is every source */
  feedSource: string | null;
  /** whether the feed shows lines that only say nothing changed */
  feedQuiet: boolean;

  toggleFeed: () => void;
  clearFeed: () => void;
  setFeedHeight: (px: number) => void;
  setFeedSource: (id: string | null) => void;
  setFeedQuiet: (on: boolean) => void;

  /** loads the tree and opens the SSE stream; returns its unsubscribe */
  init: () => Promise<() => void>;
  rescan: () => Promise<void>;
  /** adds a folder on this machine or over ssh; resolves once it is scanned */
  addSource: (input: SourceInput) => Promise<void>;
  removeSource: (id: string) => Promise<void>;
  rescanSource: (id: string) => Promise<void>;
  /** refetches the archive overview; a failure becomes an unavailable one */
  loadHistory: (refresh?: boolean) => Promise<void>;
  setFilter: (f: string) => void;
  setDirtyOnly: (v: boolean) => void;
  toggleFilter: (f: RepoFilter) => void;
  toggleUser: (key: string) => void;
  /** turns every facet and identity chip off; the text and the attention
   *  toggle have their own ways back */
  clearFilters: () => void;
  setActiveWs: (name: string | null) => void;
  /** opens a repo's panel in the dock, or brings its tab forward */
  openPanel: (id: string) => void;
  /** brings an open panel's tab forward without opening anything */
  showPanel: (id: string) => void;
  /** opens a repo where the settings say to; modifier keys override that
   *  the way they do for links (cmd/ctrl → tab, shift → window) */
  openRepo: (id: string, mods?: ClickModifiers) => void;
  /** opens a repo in an app through the server, as a tab when the settings
   *  say so; rejects with the server's reason */
  openApp: (id: string, app: OpenerId) => Promise<void>;
  closePanel: (id: string) => void;
  applyEvent: (ev: ServerEvent) => void;
  setWorkspaces: (ws: Workspace[]) => void;
  setSidebarWidth: (px: number) => void;
  toggleSidebar: () => void;
  /** folds or unfolds one section; the tree and the grid fold together */
  toggleGroup: (key: string) => void;
  /** folds or unfolds one section (changes, shell, history, claude…) of one repo's panel */
  toggleSection: (repoId: string, key: string) => void;
  setPanelWidth: (id: string, px: number) => void;
  setSoloWidth: (px: number) => void;
  setDockWidth: (px: number) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** opens a new shell at a repo where the settings say: its panel, the
   *  strip, or a tab or window of its own; `place` overrides the setting */
  openTerm: (repoId: string, place?: ShellPlace) => void;
  closeTerm: (id: string) => void;
  /** puts a shell's tab down here and leaves the shell running for the
   *  other devices, and for picking back up from the shells list */
  hideTerm: (id: string) => void;
  /** shows a running shell here, whichever device started it: its tab
   *  when this window has one, else a new tab onto it */
  joinTerm: (id: string) => void;
  /** a new shell at the repo with a Claude Code conversation from it
   *  picked back up in it */
  resumeClaude: (repoId: string, session: string) => Promise<void>;
  showTerm: (id: string) => void;
  /** starts a kept shell again where it was, with what it had; `resume`
   *  also runs the line that picks its agent's conversation back up */
  restoreShell: (id: string, resume?: boolean) => Promise<void>;
  /** drops a kept shell's record and history without restoring it */
  forgetShell: (id: string) => Promise<void>;
  /** turns the backend's shell recording on or off */
  setKeeping: (on: boolean) => Promise<void>;
  /** reads the broker's view (who, channels, the notify switch) */
  loadChan: () => Promise<void>;
  /** opens the popover, on a conversation or target ("#x", "@h") when given */
  openChan: (target?: string) => void;
  closeChan: () => void;
  /** shows a conversation and reads its history */
  showConv: (conv: string) => Promise<void>;
  sendChan: (target: string, body: string, kind?: "text" | "clip") => Promise<void>;
  putChan: (target: string, file: File, note?: string) => Promise<void>;
  setChanNotify: (on: boolean) => Promise<void>;
  /** marks a shell whose process has ended; its tab stays until closed */
  endTerm: (id: string, code: number | null) => void;
  setTermHeight: (px: number) => void;
  setPanelTermHeight: (repoId: string, px: number) => void;
  setFocusSize: (size: FocusSize | null) => void;
  /** brings a set of shells to the front, or none with null */
  setFrontShells: (set: string | null) => void;
  /** brings a running shell to the front in its own set instead of the
   *  one there now: its tab here, or a new tab onto it */
  bringTerm: (id: string) => void;

  /** opens the pre-flight dialog for an action on a repo */
  plan: (repoId: string, action: RunAction) => void;
  /** opens a chat with Claude in a repo: the repo's live run if it has one,
   *  else a new idle chat whose first message starts Claude (the peers
   *  panel's "merge with claude" passes one; the menu's plain chat does not) */
  openChat: (repoId: string, note?: string) => Promise<void>;
  /** opens the repo's agent settings */
  editAgent: (repoId: string) => void;
  setAgent: (repoId: string, settings: AgentSettings) => Promise<void>;
  /** opens the repo's launch settings */
  editLaunch: (repoId: string) => void;
  setLaunch: (repoId: string, settings: LaunchSettings) => Promise<void>;
  /** opens the repo's panel with its launch section unfolded */
  showLaunch: (repoId: string) => void;
  stopJob: (jobId: string) => Promise<void>;
  dismissJob: (jobId: string) => Promise<void>;
  /** takes a peer's WIP as a new local branch (or the given one) */
  takeWip: (repoId: string, peer: string, branch: string) => Promise<void>;
  /** tracks a branch that exists only on a peer, as a local branch here */
  trackBranch: (repoId: string, peer: string, branch: string) => Promise<void>;
  /** seeds the allow-listed files (.env and the like) from a peer that has them */
  seedRepo: (repoId: string) => Promise<void>;
  /** runs the peer pass for just this repo, instead of waiting for the timer */
  syncPeers: (repoId: string) => Promise<void>;
  /** shows a run's console */
  showRun: (runId: string) => void;
  closeSheet: () => void;
  /** opens the search across every repo in view */
  openSearch: () => void;
  setSearchQuery: (q: string) => void;
  /** closes the search sheet, opens the repo's panel with its search section
   *  unfolded, and hands that section the term */
  searchIn: (repoId: string, q: string) => void;
  /** the section took its term */
  takePendingSearch: () => void;
  startRun: (repoId: string, action: RunAction, note: string) => Promise<void>;
  answerRun: (runId: string, promptId: string, answer: RunAnswer) => Promise<void>;
  /** the next message in a chat */
  sayRun: (runId: string, text: string) => Promise<void>;
  stopRun: (runId: string) => Promise<void>;
  dismissRun: (runId: string) => Promise<void>;

  /** loads (or reloads) the workflows a repo can run, for the menu */
  loadWorkflows: (repoId: string) => Promise<void>;
  /** opens the pre-flight for a workflow on a repo, or its live flow/run */
  planFlow: (repoId: string, workflow: string) => void;
  startFlow: (repoId: string, workflow: string, note: string) => Promise<void>;
  resumeFlow: (flowId: string, choice: FlowChoice) => Promise<void>;
  stopFlow: (flowId: string) => Promise<void>;
  dismissFlow: (flowId: string) => Promise<void>;
  showFlow: (flowId: string) => void;
  /** turns select mode on the board on or off; it starts with nothing picked */
  setSelecting: (on: boolean) => void;
  /** flips one repo; with `extend`, sets every repo from the anchor to it to the anchor's state instead */
  toggleSelected: (repoId: string, extend?: boolean) => void;
  setSelected: (ids: string[]) => void;
  /** every pickable repo in view, none of them, or the other ones */
  pickAll: () => void;
  pickNone: () => void;
  pickInvert: () => void;
  /** a group's tick: fills the group unless it is full already, then clears it */
  pickGroup: (ids: string[]) => void;
  /** just the repos in view in one state */
  pickFacet: (facet: RepoFilter) => void;
  /** opens the pre-flight for a fleet workflow over the selected repos */
  planFleet: (workflow: string) => void;
  startFleet: (workflow: string, note: string) => Promise<void>;
  stopFleet: (fleetId: string) => Promise<void>;
  dismissFleet: (fleetId: string) => Promise<void>;
  showFleet: (fleetId: string) => void;
}

export type Sheet =
  | { kind: "plan"; repoId: string; action: RunAction }
  | { kind: "run"; runId: string }
  | { kind: "agent"; repoId: string }
  | { kind: "launch"; repoId: string }
  | { kind: "search" }
  | { kind: "flow-plan"; repoId: string; workflow: string }
  | { kind: "flow"; flowId: string }
  | { kind: "fleet-plan"; workflow: string }
  | { kind: "fleet"; fleetId: string };

export interface ClickModifiers {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

const layout = loadLayout();

/** The shells this window hung up, for the page's life: the tab's socket
 *  closing tells the server before the end request may, and the list it
 *  sends back still has the shell in it, which `adoptTerms` must not turn
 *  back into a tab. Names are random and a shell ended here cannot be
 *  restored, so none of them comes back legitimately. */
const endedShells = new Set<string>();

/** the shells `adoptTerms` passes over: the ones this window ended and the
 *  ones this browser hid */
const skipped = (hidden: string[]): ReadonlySet<string> => new Set([...endedShells, ...hidden]);

/** a shell window's url onto one named shell */
const shellUrlFor = heldShellUrl;

/** The state a fresh tree implies: the repos and sources themselves, and
 *  the panels, widths and folds that still have a repo to belong to. */
function treeState(
  s: CanopyState,
  tree: ScanResult,
): Pick<
  CanopyState,
  | "root"
  | "sources"
  | "repos"
  | "backend"
  | "panels"
  | "activePanel"
  | "panelWidths"
  | "panelTermHeights"
  | "closedSections"
> {
  // drop panels whose repo no longer exists — a panel with no repo
  // renders nothing, including its own close button. The same array when
  // none goes, so a scan that changes nothing does not count as a change.
  const kept = s.panels.filter((id) => tree.repos.some((r) => r.id === id));
  const panels = kept.length === s.panels.length ? s.panels : kept;
  return {
    root: tree.root,
    sources: tree.sources,
    repos: tree.repos,
    backend: tree.backend,
    panels,
    // the showing tab may be among the dropped; then its neighbour shows
    activePanel:
      s.activePanel !== null && panels.includes(s.activePanel)
        ? s.activePanel
        : (panels[0] ?? null),
    panelWidths: pruneByRepo(s.panelWidths, tree.repos),
    panelTermHeights: pruneByRepo(s.panelTermHeights, tree.repos),
    closedSections: pruneByRepo(s.closedSections, tree.repos),
  };
}

/** run id to flow id, for every run a flow owns. */
function flowRunsOf(flows: Flow[]): Record<string, string> {
  const flowRuns: Record<string, string> = {};
  for (const f of flows) {
    for (const st of f.steps) if (st.runId) flowRuns[st.runId] = f.id;
  }
  return flowRuns;
}

/** A peer action answers the repo, with a `take` field only "take" fills
 *  in; that field is not part of Repo and does not belong in state. Routed
 *  through applyEvent the way rescan/addSource/removeSource apply a fresh
 *  scan, so this window's own action reaches the feed and the update pulse
 *  too, and the SSE broadcast that follows finds nothing new to say. */
function applyPeerRepo(get: () => CanopyState, result: Repo & { take?: { how: string; branch?: string } }): void {
  const { take: _take, ...repo } = result;
  get().applyEvent({ type: "repo", repo });
}

/** Which /api/peers read is the newest: two quick peers events can bring
 *  their answers back in either order, and only the last one asked lands. */
let peersRead = 0;

/** Reads the peer mode and who was seen off the server into the store. The
 *  mode lives in the config, so this is how the page follows a change to it. */
function readPeers(set: (p: Pick<CanopyState, "peerSeen" | "peerSync">) => void): void {
  const mine = ++peersRead;
  void api
    .peers()
    .then((p) => {
      if (mine === peersRead) set({ peerSeen: p.seen, peerSync: p.sync });
    })
    .catch(() => {});
}

export const useStore = create<CanopyState>((set, get) => ({
  root: "",
  sources: [],
  repos: [],
  backend: { openers: true, sshHost: null },
  client: { address: "", local: false, shared: false },
  helpers: [],
  devices: [],
  peerSeen: [],
  peerSync: "off",
  shells: [],
  kept: [],
  keeping: false,
  chan: null,
  chanAs: "",
  chanMsgs: {},
  chanUnread: 0,
  chanOpen: false,
  chanConv: null,
  workspaces: [],
  loaded: false,
  loadError: null,
  filter: "",
  dirtyOnly: false,
  filters: [],
  users: [],
  activeWs: null,
  panels: layout.panels,
  activePanel: layout.activePanel,
  updatedAt: {},
  sidebarWidth: layout.sidebarWidth,
  panelWidths: layout.panelWidths,
  soloWidth: layout.soloWidth,
  dockWidth: layout.dockWidth,
  sidebarOpen: layout.sidebarOpen,
  collapsed: layout.collapsed,
  closedSections: layout.closedSections,
  settings: loadSettings(),
  runs: {},
  sheet: null,
  searchQuery: "",
  pendingSearch: null,
  history: null,
  agents: {},
  launchers: {},
  jobs: {},
  buildsAt: {},
  terms: [],
  activeTerm: null,
  hiddenTerms: layout.hiddenTerms,
  termHeight: layout.termHeight,
  panelTermHeights: layout.panelTermHeights,
  focusSize: layout.focusSize,
  frontShells: null,
  frontPick: null,
  flows: {},
  fleets: {},
  workflows: {},
  flowRuns: {},
  selecting: false,
  selected: [],
  selectAnchor: null,
  verdictReady: false,
  feed: [],
  feedSeq: 1,
  feedOpen: layout.feedOpen,
  feedHeight: layout.feedHeight,
  feedSource: null,
  feedQuiet: false,

  toggleFeed: () => set((s) => ({ feedOpen: !s.feedOpen })),
  clearFeed: () => set({ feed: [] }),
  setFeedHeight: (px) => set({ feedHeight: clamp(px, FEED.min, FEED.max) }),
  setFeedSource: (feedSource) => set({ feedSource }),
  setFeedQuiet: (feedQuiet) => set({ feedQuiet }),

  init: async () => {
    try {
      const [tree, workspaces, runs, agents, flows, fleets, verdict, launchers, jobs, held, client, helpers, devices, kept] = await Promise.all([
        api.tree(),
        api.workspaces(),
        api.runs(),
        api.agents(),
        api.flows(),
        api.fleets(),
        api.verdict(),
        api.launchers(),
        api.jobs(),
        // a server from before shells were held has no list; the grove
        // should still load, just with no shells to come back to
        api.terms().catch((): TermInfo[] => []),
        api.client(),
        api.helpers(),
        api.devices().catch((): Device[] => []),
        // a backend from before shells were kept has no list
        api.kept().catch(() => ({ keeping: false, kept: [] as KeptShell[] })),
      ]);
      // The shells come back only now, against what the server still holds:
      // a tab shown sooner would open its socket and start a shell of its
      // own under the old name. A solo or shell window keeps none: what it
      // saved is the grove's, and the grove is what shows them.
      const hiddenTerms = pruneHidden(get().hiddenTerms, held);
      const terms = dockless() ? [] : reconcileTerms(layout.terms, held, tree.repos, new Set(hiddenTerms));
      const strip = terms.filter((t) => t.place === "strip");
      // A panel shell shows only inside its repo's panel, and a shell adopted
      // from another window may have none here: open it, shell unfolded, the
      // way openTerm does, so the shell is somewhere you can see.
      const s = get();
      let panels = s.panels;
      let closedSections = s.closedSections;
      for (const t of terms) {
        if (t.place !== "panel" || panels.includes(t.repoId)) continue;
        panels = [...panels, t.repoId];
        closedSections = unfoldIn(closedSections, t.repoId, "shell");
      }
      set({
        root: tree.root,
        sources: tree.sources,
        repos: tree.repos,
        backend: tree.backend,
        client,
        helpers,
        devices,
        shells: held,
        hiddenTerms,
        kept: kept.kept,
        keeping: kept.keeping,
        workspaces,
        runs: Object.fromEntries(runs.map((r) => [r.id, r])),
        agents,
        launchers,
        jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
        flows: Object.fromEntries(flows.map((f) => [f.id, f])),
        fleets: Object.fromEntries(fleets.map((f) => [f.id, f])),
        flowRuns: flowRunsOf(flows),
        verdictReady: verdict.ready,
        terms,
        activeTerm: strip.some((t) => t.id === layout.activeTerm) ? layout.activeTerm : (strip.at(-1)?.id ?? null),
        panels,
        activePanel: s.activePanel ?? panels[0] ?? null,
        closedSections,
        loaded: true,
        loadError: null,
      });
    } catch (err) {
      // Without this the app sits on the loading screen forever with no
      // message and no way back.
      set({ loadError: String(err instanceof Error ? err.message : err) });
      return () => {};
    }
    // The archive is not in the way of first paint: it lands when it lands,
    // and claude-history only syncs hourly, so a slow refresh is plenty.
    void get().loadHistory();
    // Likewise peers: a backend with peer sync off just answers "off" and
    // an empty seen list, so this never blocks a grove with none set up.
    readPeers(set);
    // tailchan too: a backend without a broker answers ready: false
    void get().loadChan();
    const refresh = setInterval(() => void get().loadHistory(), HISTORY_REFRESH);
    // Handed back so the caller can close the stream — StrictMode mounts
    // effects twice, and an unclosed EventSource leaks a live connection.
    const unsubscribe = subscribe(
      (ev) => get().applyEvent(ev),
      () => {
        // the server may still be coming back up — a failed resync just
        // leaves the current tree in place until the next event
        void get().rescan().catch(() => {});
        // What a restarted server says only when it changes: the shells it
        // holds, the ones a reboot left to restore (worked out before it
        // listened, so never broadcast to this stream), and the helpers
        // that dialled back in before this stream did.
        void Promise.all([api.terms(), api.kept(), api.helpers()])
          .then(([terms, kept, helpers]) => {
            get().applyEvent({ type: "terms", terms });
            set({ kept: kept.kept, keeping: kept.keeping, helpers });
          })
          .catch(() => {});
      },
      identity(get().settings.device),
    );
    // A helper attaching between the first read and the stream opening
    // sent a `helpers` event no one heard; one more read closes that gap.
    void api.helpers().then((helpers) => set({ helpers })).catch(() => {});
    return () => {
      clearInterval(refresh);
      unsubscribe();
    };
  },

  loadHistory: async (refresh = false) => {
    try {
      set({ history: await api.history(refresh) });
    } catch (err) {
      set({
        history: {
          available: false,
          reason: String(err instanceof Error ? err.message : err),
          fetchedAt: Date.now(),
        },
      });
    }
  },

  rescan: async () => {
    const [tree, runs, flows, fleets, jobs] = await Promise.all([
      api.rescan(),
      api.runs(),
      api.flows(),
      api.fleets(),
      api.jobs(),
    ]);
    // a rescan can bring new repos; the server rebuilds the repo→project map
    void get().loadHistory(true);
    // Through applyEvent so the feed sees the scan even when this window
    // asked for it: the broadcast that follows finds nothing new to say.
    get().applyEvent({ type: "scan", result: tree });
    set({
      // runs are server state too: a stream gap may have hidden a finish
      runs: Object.fromEntries(runs.map((r) => [r.id, r])),
      flows: Object.fromEntries(flows.map((f) => [f.id, f])),
      fleets: Object.fromEntries(fleets.map((f) => [f.id, f])),
      flowRuns: flowRunsOf(flows),
      jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
    });
  },

  addSource: async (input) => {
    const tree = await api.addSource(input);
    void get().loadHistory(true);
    get().applyEvent({ type: "scan", result: tree });
  },
  removeSource: async (id) => {
    const tree = await api.removeSource(id);
    void get().loadHistory(true);
    get().applyEvent({ type: "scan", result: tree });
  },
  rescanSource: async (id) => {
    const tree = await api.rescanSource(id);
    void get().loadHistory(true);
    get().applyEvent({ type: "scan", result: tree });
  },

  setFilter: (filter) => set({ filter }),
  setDirtyOnly: (dirtyOnly) => set({ dirtyOnly }),
  toggleFilter: (f) =>
    set((s) => ({
      filters: s.filters.includes(f)
        ? s.filters.filter((x) => x !== f)
        : [...s.filters, f],
    })),
  toggleUser: (key) =>
    set((s) => ({
      users: s.users.includes(key)
        ? s.users.filter((x) => x !== key)
        : [...s.users, key],
    })),
  clearFilters: () => set({ filters: [], users: [] }),
  setActiveWs: (activeWs) => set({ activeWs }),

  openPanel: (id) =>
    set((s) => {
      const next = focusPanel(s.panels, id);
      // a panel shell another device opened here waits for its panel
      return { ...next, terms: dockless() ? s.terms : adoptTerms(s.terms, s.shells, s.repos, next.panels, skipped(s.hiddenTerms)) };
    }),
  showPanel: (id) =>
    set((s) => (s.panels.includes(id) ? { activePanel: id } : {})),
  openRepo: (id, mods) => {
    // A forge repo has no panel worth opening: there is no working tree, no
    // log to read here, nothing to run. Its page is the whole of it.
    const repo = get().repos.find((r) => r.id === id);
    if (repo?.forge) {
      window.open(repo.path, "_blank", "noopener,noreferrer");
      return;
    }
    const target = mods?.shiftKey
      ? "window"
      : mods?.metaKey || mods?.ctrlKey
        ? "tab"
        : get().settings.openIn;
    if (target === "dock" || target === "tabs") get().openPanel(id);
    else openElsewhere(id, target);
  },
  openApp: async (id, app) => {
    await api.open(id, app, get().settings.terminal === "tab", helperFor(get()));
  },
  closePanel: (id) => {
    const s = get();
    // A panel's shells outlive it: closing only drops the tabs, and the
    // shells stay held on the backend, in the shells picker, until their
    // own × or "end". Reopening the panel adopts them back as tabs.
    const mine = (t: TermTab) => t.repoId === id && t.place === "panel";
    const terms = s.terms.filter((t) => !mine(t));
    set({
      panels: s.panels.filter((p) => p !== id),
      activePanel: nextActive(s.panels, id, s.activePanel),
      terms,
      frontShells: keepFront(s.frontShells, terms),
    });
  },

  applyEvent: (ev) => {
    // The feed says what changed, so the lines come from the event against
    // the state before it is applied.
    // a message already held (a reconnect's replay, a post heard twice) is
    // neither a feed line nor unread
    if (ev.type === "chan" && get().chanMsgs[ev.message.channel]?.some((m) => m.id === ev.message.id)) return;
    const lines = describeEvent(ev, get(), Date.now(), get().agents);
    if (lines.length) {
      set((s) => {
        const { feed, seq } = appendFeed(s.feed, lines, s.feedSeq);
        return { feed, feedSeq: seq };
      });
    }
    if (ev.type === "chan") {
      const m = ev.message;
      set((s) => {
        const looking = s.chanOpen && s.chanConv === m.channel && document.visibilityState === "visible";
        return {
          chanMsgs: { ...s.chanMsgs, [m.channel]: mergeMessages(s.chanMsgs[m.channel], [m]) },
          chanUnread: !looking && isUnread(m, s.chanAs) ? s.chanUnread + 1 : s.chanUnread,
        };
      });
      return;
    }
    if (ev.type === "repo") {
      set((s) => ({
        repos: s.repos.map((r) => (r.id === ev.repo.id ? ev.repo : r)),
        updatedAt: { ...s.updatedAt, [ev.repo.id]: Date.now() },
      }));
    } else if (ev.type === "scan") {
      set((s) => treeState(s, ev.result));
    } else if (ev.type === "workspaces") {
      set({ workspaces: ev.workspaces });
    } else if (ev.type === "agents") {
      set({ agents: ev.agents });
    } else if (ev.type === "run") {
      set((s) => ({ runs: { ...s.runs, [ev.run.id]: ev.run } }));
    } else if (ev.type === "run-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...runs } = s.runs;
        const sheet =
          s.sheet?.kind === "run" && s.sheet.runId === ev.id ? null : s.sheet;
        return { runs, sheet };
      });
    } else if (ev.type === "flow") {
      set((s) => {
        const flowRuns = { ...s.flowRuns };
        for (const st of ev.flow.steps) if (st.runId) flowRuns[st.runId] = ev.flow.id;
        return { flows: { ...s.flows, [ev.flow.id]: ev.flow }, flowRuns };
      });
    } else if (ev.type === "flow-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...flows } = s.flows;
        const flowRuns = Object.fromEntries(Object.entries(s.flowRuns).filter(([, f]) => f !== ev.id));
        const sheet = s.sheet?.kind === "flow" && s.sheet.flowId === ev.id ? null : s.sheet;
        return { flows, flowRuns, sheet };
      });
    } else if (ev.type === "fleet") {
      set((s) => ({ fleets: { ...s.fleets, [ev.fleet.id]: ev.fleet } }));
    } else if (ev.type === "fleet-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...fleets } = s.fleets;
        const sheet = s.sheet?.kind === "fleet" && s.sheet.fleetId === ev.id ? null : s.sheet;
        return { fleets, sheet };
      });
    } else if (ev.type === "job") {
      set((s) => ({ jobs: { ...s.jobs, [ev.job.id]: ev.job } }));
    } else if (ev.type === "job-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...jobs } = s.jobs;
        return { jobs };
      });
    } else if (ev.type === "builds") {
      set((s) => ({ buildsAt: { ...s.buildsAt, [ev.repoId]: Date.now() } }));
    } else if (ev.type === "launchers") {
      set({ launchers: ev.launchers });
    } else if (ev.type === "helpers") {
      set({ helpers: ev.helpers });
    } else if (ev.type === "devices") {
      set({ devices: ev.devices });
    } else if (ev.type === "kept") {
      set({ kept: ev.kept });
    } else if (ev.type === "peers") {
      set({ peerSeen: ev.seen });
      readPeers(set);
    } else if (ev.type === "terms") {
      // a shell opened on another device shows up here too; a dockless
      // window (solo, shell) keeps no tabs of its own
      set((s) => {
        const hiddenTerms = pruneHidden(s.hiddenTerms, ev.terms);
        return {
          shells: ev.terms,
          hiddenTerms,
          terms: dockless() ? s.terms : adoptTerms(s.terms, ev.terms, s.repos, s.panels, skipped(hiddenTerms)),
        };
      });
    }
  },

  setWorkspaces: (workspaces) => set({ workspaces }),

  setSidebarWidth: (px) => set({ sidebarWidth: clamp(px, SIDEBAR.min, SIDEBAR.max) }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleGroup: (key) =>
    set((s) => ({
      collapsed: s.collapsed.includes(key)
        ? s.collapsed.filter((k) => k !== key)
        : [...s.collapsed, key],
    })),
  toggleSection: (repoId, key) =>
    set((s) => ({ closedSections: toggleIn(s.closedSections, repoId, key) })),
  setPanelWidth: (id, px) =>
    set((s) => ({ panelWidths: { ...s.panelWidths, [id]: clamp(px, PANEL.min, PANEL.max) } })),
  setSoloWidth: (px) => set({ soloWidth: clamp(px, SOLO.min, SOLO.max) }),
  setDockWidth: (px) => set({ dockWidth: clamp(px, DOCK.min, DOCK.max) }),
  setSetting: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value };
      saveSettings(settings);
      return { settings };
    }),
  openTerm: (repoId, place) => {
    const s = get();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo || repo.forge) return;
    const where =
      place ??
      shellPlace(s.settings.shell, {
        panelOpen: s.panels.includes(repoId),
        solo: loneWindow(),
      });
    if (where === "tab" || where === "window") {
      openShellElsewhere(repoId, where);
      return;
    }
    const tab: TermTab = { id: termId(), repoId, name: repo.name, path: repo.path, place: where };
    // A panel shell shows only inside its repo's panel and only while that
    // section is unfolded, so open both. Otherwise the click does nothing you
    // can see.
    set({
      terms: [...s.terms, tab],
      activeTerm: where === "strip" ? tab.id : s.activeTerm,
      ...(where === "panel"
        ? { ...focusPanel(s.panels, repoId), closedSections: unfoldIn(s.closedSections, repoId, "shell") }
        : {}),
    });
  },
  restoreShell: async (id, resume = false) => {
    const s = get();
    const rec = s.kept.find((k) => k.id === id);
    if (!rec) return;
    const repo = s.repos.find((r) => r.id === rec.repoId);
    if (!repo) return;
    await api.restoreShell(id, resume);
    // the same tab the lost shell had, since it comes back under its name;
    // a tab still showing the shell that went (its socket was told the
    // shell exited) is replaced, with a new generation so its view starts
    // over instead of staying ended
    const tab: TermTab = { id, repoId: repo.id, name: repo.name, path: repo.path, place: rec.place };
    endedShells.delete(id);
    set((now) => ({
      kept: now.kept.filter((k) => k.id !== id),
      terms: now.terms.some((t) => t.id === id)
        ? now.terms.map((t) => (t.id === id ? { ...tab, gen: (t.gen ?? 0) + 1 } : t))
        : [...now.terms, tab],
      activeTerm: rec.place === "strip" ? id : now.activeTerm,
      ...(rec.place === "panel"
        ? { ...focusPanel(now.panels, repo.id), closedSections: unfoldIn(now.closedSections, repo.id, "shell") }
        : {}),
    }));
  },
  forgetShell: async (id) => {
    await api.forgetShell(id);
    set((s) => ({ kept: s.kept.filter((k) => k.id !== id) }));
  },
  setKeeping: async (on) => {
    const { keeping } = await api.setKeeping(on);
    set({ keeping });
  },
  loadChan: async () => {
    const chan = await api.tailchan().catch((e: unknown): TailchanInfo => ({ ready: false, reason: String(e instanceof Error ? e.message : e) }));
    set({ chan, chanAs: chan.ready ? chan.as : get().chanAs });
  },
  openChan: (target) => {
    const s = get();
    const conv = target ? convOf(target, s.chanAs) : s.chanConv;
    set({ chanOpen: true, chanUnread: 0, chanConv: conv });
    void get().loadChan();
    if (conv) void get().showConv(conv);
    // the latest clips, for "copy the latest", whether or not this handle
    // follows the clipboard channel
    void api
      .chanRead("#clipboard", 5)
      .then((msgs) => set((st) => ({ chanMsgs: { ...st.chanMsgs, clipboard: mergeMessages(st.chanMsgs["clipboard"], msgs) } })))
      .catch(() => {});
  },
  closeChan: () => set({ chanOpen: false }),
  showConv: async (conv) => {
    set({ chanConv: conv });
    const msgs = await api.chanRead(conv, 50).catch((): ChanMessage[] => []);
    set((s) => ({ chanMsgs: { ...s.chanMsgs, [conv]: mergeMessages(s.chanMsgs[conv], msgs) } }));
  },
  // what is sent comes back as a chan event, which is what files it
  sendChan: async (target, body, kind = "text") => {
    await api.chanSend(target, body, kind);
  },
  putChan: async (target, file, note = "") => {
    await api.chanPut(target, file, note);
  },
  setChanNotify: async (on) => {
    const { notify } = await api.chanNotify(on);
    set((s) => ({ chan: s.chan?.ready ? { ...s.chan, notify } : s.chan }));
  },
  closeTerm: (id) => {
    const s = get();
    const tab = s.terms.find((t) => t.id === id);
    if (!tab) return;
    endShells([tab]);
    const terms = s.terms.filter((t) => t.id !== id);
    set({ terms, activeTerm: nextStripTab(s.terms, id, s.activeTerm), frontShells: keepFront(s.frontShells, terms) });
  },
  hideTerm: (id) => {
    const s = get();
    if (!s.terms.some((t) => t.id === id)) return;
    const terms = s.terms.filter((t) => t.id !== id);
    set({
      terms,
      activeTerm: nextStripTab(s.terms, id, s.activeTerm),
      frontShells: keepFront(s.frontShells, terms),
      hiddenTerms: s.hiddenTerms.includes(id) ? s.hiddenTerms : [...s.hiddenTerms, id],
    });
  },
  joinTerm: (id) => {
    const s = get();
    const info = s.shells.find((t) => t.id === id);
    const repo = info && s.repos.find((r) => r.id === info.repoId);
    if (!info || !repo) return;
    // a solo or shell window has no strip or dock of its own to put a tab
    // in: it becomes the shell's own window instead
    if (dockless()) {
      window.location.assign(shellUrlFor(repo.id, id));
      return;
    }
    const tab: TermTab = s.terms.find((t) => t.id === id) ?? {
      id,
      repoId: repo.id,
      name: repo.name,
      path: repo.path,
      place: info.place,
    };
    set({
      terms: s.terms.some((t) => t.id === id) ? s.terms : [...s.terms, tab],
      hiddenTerms: s.hiddenTerms.filter((h) => h !== id),
      activeTerm: tab.place === "strip" ? id : s.activeTerm,
      ...(tab.place === "panel"
        ? { ...focusPanel(s.panels, repo.id), closedSections: unfoldIn(s.closedSections, repo.id, "shell") }
        : {}),
    });
  },
  resumeClaude: async (repoId, session) => {
    const s = get();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo || repo.forge) return;
    // the shell setting picks panel or strip; a tab or window of its own is
    // the strip here, since the shell is started before any window opens
    const where = shellPlace(s.settings.shell, {
      panelOpen: s.panels.includes(repoId),
      solo: loneWindow(),
    });
    const place = where === "panel" ? "panel" : "strip";
    const id = termId();
    await api.resumeClaude(repoId, id, place, session);
    if (dockless()) {
      window.location.assign(shellUrlFor(repoId, id));
      return;
    }
    const tab: TermTab = { id, repoId, name: repo.name, path: repo.path, place };
    set((now) => ({
      terms: now.terms.some((t) => t.id === id) ? now.terms : [...now.terms, tab],
      activeTerm: place === "strip" ? id : now.activeTerm,
      ...(place === "panel"
        ? { ...focusPanel(now.panels, repoId), closedSections: unfoldIn(now.closedSections, repoId, "shell") }
        : {}),
    }));
  },
  showTerm: (id) => set((s) => (s.terms.some((t) => t.id === id) ? { activeTerm: id } : {})),
  endTerm: (id, code) =>
    set((s) => ({ terms: s.terms.map((t) => (t.id === id ? { ...t, exit: code } : t)) })),
  setTermHeight: (px) => set({ termHeight: clamp(px, TERM.min, TERM.max) }),
  setFocusSize: (size) => set({ focusSize: size }),
  setFrontShells: (front) => set({ frontShells: front, frontPick: null }),
  bringTerm: (id) => {
    // joining gives a shell with no tab here one, and opens and unfolds a
    // panel shell's panel; a tab already here keeps its place
    get().joinTerm(id);
    const s = get();
    const tab = s.terms.find((t) => t.id === id);
    if (!tab) return;
    set({
      frontShells: shellSet(tab),
      frontPick: id,
      ...(tab.place === "strip"
        ? { activeTerm: id }
        : { ...focusPanel(s.panels, tab.repoId), closedSections: unfoldIn(s.closedSections, tab.repoId, "shell") }),
    });
  },
  setPanelTermHeight: (repoId, px) =>
    set((s) => ({
      panelTermHeights: { ...s.panelTermHeights, [repoId]: clamp(px, PANEL_TERM.min, PANEL_TERM.max) },
    })),

  plan: (repoId, action) => {
    // A repo with a run going shows that run instead of starting a second.
    const active = activeRunFor(get(), repoId);
    set({ sheet: active ? { kind: "run", runId: active.id } : { kind: "plan", repoId, action } });
  },
  openChat: async (repoId, note = "") => {
    const active = activeRunFor(get(), repoId);
    const trimmed = note.trim();
    // The plain "chat" menu item passes no note: show whatever is already
    // going, or start a fresh idle chat with nothing to say yet. Unaffected
    // by mergeAction, which is about a caller with something to send.
    if (!trimmed) {
      if (active) {
        set({ sheet: { kind: "run", runId: active.id } });
        return;
      }
      await get().startRun(repoId, "chat", "");
      return;
    }
    if (!active) {
      await get().startRun(repoId, "chat", note);
      return;
    }
    if (mergeAction(active) === "busy") {
      throw new Error("a run is already going on this repo");
    }
    // An idle chat: the note is the next turn, not a fresh start.
    await get().sayRun(active.id, trimmed);
    set({ sheet: { kind: "run", runId: active.id } });
  },
  editAgent: (repoId) => set({ sheet: { kind: "agent", repoId } }),
  setAgent: async (repoId, settings) => {
    const agents = await api.setAgent(repoId, settings);
    set({ agents });
  },
  editLaunch: (repoId) => set({ sheet: { kind: "launch", repoId } }),
  setLaunch: async (repoId, settings) => {
    const launchers = await api.setLaunch(repoId, settings);
    set({ launchers });
  },
  showLaunch: (repoId) =>
    set((s) => ({
      ...focusPanel(s.panels, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "launch"),
    })),
  stopJob: async (jobId) => {
    const job = await api.stopJob(jobId);
    set((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
  },
  dismissJob: async (jobId) => {
    await api.dismissJob(jobId);
    set((s) => {
      const { [jobId]: _gone, ...jobs } = s.jobs;
      return { jobs };
    });
  },
  takeWip: async (repoId, peer, branch) => {
    applyPeerRepo(get, await api.peerAction(repoId, { action: "take", peer, branch }));
  },
  trackBranch: async (repoId, peer, branch) => {
    applyPeerRepo(get, await api.peerAction(repoId, { action: "track", peer, branch }));
  },
  seedRepo: async (repoId) => {
    applyPeerRepo(get, await api.peerAction(repoId, { action: "seed" }));
  },
  syncPeers: async (repoId) => {
    applyPeerRepo(get, await api.peerAction(repoId, { action: "sync" }));
  },
  showRun: (runId) => set({ sheet: { kind: "run", runId } }),
  closeSheet: () => set({ sheet: null }),
  openSearch: () => set({ sheet: { kind: "search" } }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  searchIn: (repoId, q) =>
    set((s) => ({
      sheet: null,
      pendingSearch: { repoId, q },
      ...focusPanel(s.panels, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "search"),
    })),
  takePendingSearch: () => set({ pendingSearch: null }),
  startRun: async (repoId, action, note) => {
    const run = await api.run(repoId, action, note, clientId());
    set((s) => ({
      runs: { ...s.runs, [run.id]: run },
      sheet: { kind: "run", runId: run.id },
    }));
  },
  answerRun: async (runId, promptId, answer) => {
    const run = await api.answerRun(runId, promptId, answer);
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
  },
  sayRun: async (runId, text) => {
    const run = await api.say(runId, text);
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
  },
  stopRun: async (runId) => {
    const run = await api.stopRun(runId);
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
  },
  dismissRun: async (runId) => {
    await api.dismissRun(runId);
    set((s) => {
      const { [runId]: _gone, ...runs } = s.runs;
      const sheet =
        s.sheet?.kind === "run" && s.sheet.runId === runId ? null : s.sheet;
      return { runs, sheet };
    });
  },

  loadWorkflows: async (repoId) => {
    const list = await api.workflows(repoId);
    set((s) => ({ workflows: { ...s.workflows, [repoId]: list } }));
  },
  planFlow: (repoId, workflow) => {
    const active = activeFlowFor(get(), repoId) ?? undefined;
    if (active) {
      set({ sheet: { kind: "flow", flowId: active.id } });
      return;
    }
    const run = activeRunFor(get(), repoId);
    set({ sheet: run ? { kind: "run", runId: run.id } : { kind: "flow-plan", repoId, workflow } });
  },
  startFlow: async (repoId, workflow, note) => {
    const flow = await api.startFlow(repoId, workflow, note);
    set((s) => ({
      flows: { ...s.flows, [flow.id]: flow },
      flowRuns: { ...s.flowRuns, ...flowRunsOf([flow]) },
      sheet: { kind: "flow", flowId: flow.id },
    }));
  },
  resumeFlow: async (flowId, choice) => {
    const flow = await api.resumeFlow(flowId, choice);
    set((s) => ({ flows: { ...s.flows, [flow.id]: flow }, flowRuns: { ...s.flowRuns, ...flowRunsOf([flow]) } }));
  },
  stopFlow: async (flowId) => {
    const flow = await api.stopFlow(flowId);
    set((s) => ({ flows: { ...s.flows, [flow.id]: flow }, flowRuns: { ...s.flowRuns, ...flowRunsOf([flow]) } }));
  },
  dismissFlow: async (flowId) => {
    await api.dismissFlow(flowId);
    set((s) => {
      const { [flowId]: _gone, ...flows } = s.flows;
      const sheet = s.sheet?.kind === "flow" && s.sheet.flowId === flowId ? null : s.sheet;
      return { flows, sheet };
    });
  },
  showFlow: (flowId) => set({ sheet: { kind: "flow", flowId } }),
  setSelecting: (on) => set({ selecting: on, selected: [], selectAnchor: null }),
  toggleSelected: (repoId, extend = false) =>
    set((s) => {
      const repo = s.repos.find((r) => r.id === repoId);
      if (!repo || !pickable(repo)) return {};
      if (extend && s.selectAnchor && s.selectAnchor !== repoId) {
        // the range takes the anchor's state, so a shift-click after an
        // unpick clears the stretch and one after a pick fills it
        const ids = rangeIds(boardOrder(visibleRepos(s), s.settings.sort, s.collapsed), s.selectAnchor, repoId);
        return { selected: setPick(s.selected, ids, s.selected.includes(s.selectAnchor)) };
      }
      return { selected: togglePick(s.selected, [repoId]), selectAnchor: repoId };
    }),
  setSelected: (ids) => set({ selected: ids }),
  pickAll: () => set((s) => ({ selected: pickableIds(s) })),
  pickNone: () => set({ selected: [] }),
  pickInvert: () => set((s) => ({ selected: invertPick(pickedIds(s), pickableIds(s)) })),
  pickGroup: (ids) => set((s) => ({ selected: togglePick(s.selected, ids) })),
  pickFacet: (facet) => set((s) => ({ selected: pickWhere(visibleRepos(s), facet) })),
  planFleet: (workflow) => set({ sheet: { kind: "fleet-plan", workflow } }),
  startFleet: async (workflow, note) => {
    const fleet = await api.startFleet(workflow, pickedIds(get()), note);
    set((s) => ({
      fleets: { ...s.fleets, [fleet.id]: fleet },
      sheet: { kind: "fleet", fleetId: fleet.id },
      selecting: false,
      selected: [],
      selectAnchor: null,
    }));
  },
  stopFleet: async (fleetId) => {
    const fleet = await api.stopFleet(fleetId);
    set((s) => ({ fleets: { ...s.fleets, [fleet.id]: fleet } }));
  },
  dismissFleet: async (fleetId) => {
    await api.dismissFleet(fleetId);
    set((s) => {
      const { [fleetId]: _gone, ...fleets } = s.fleets;
      const sheet = s.sheet?.kind === "fleet" && s.sheet.fleetId === fleetId ? null : s.sheet;
      return { fleets, sheet };
    });
  },
  showFleet: (fleetId) => set({ sheet: { kind: "fleet", fleetId } }),
}));

/** Ends the shells behind some tabs on the server. Closing a socket only
 *  detaches, so this is the one way a tab's × hangs a shell up. One that
 *  already exited needs nothing. */
function endShells(tabs: TermTab[]) {
  for (const t of tabs) {
    if (t.exit !== undefined) continue;
    endedShells.add(t.id);
    void api.endTerm(t.id).catch(() => {});
  }
}

/** whether this window is a solo panel or a lone shell rather than the grove:
 *  it has no dock, so what it holds in `panels` is a copy of the grove's
 *  (plus any panel a shell opened here) and must not be written back */
/** a window that shows one panel or one section, which has no shells strip */
function loneWindow(): boolean {
  const route = parseRoute(window.location.search);
  return route.solo || route.section !== null;
}

function dockless(): boolean {
  if (typeof window === "undefined") return false;
  const route = parseRoute(window.location.search);
  return route.solo || route.shell || route.section !== null;
}

// Whatever part of the layout a change touched is written as it happens, so
// no action has to remember to. Only the changed fields go: see saveLayout.
useStore.subscribe((s, prev) => {
  const patch = changed(layoutOf(s), layoutOf(prev));
  if (dockless()) {
    delete patch.panels;
    delete patch.activePanel;
    delete patch.terms;
    delete patch.activeTerm;
  }
  if (Object.keys(patch).length > 0) saveLayout(patch);
});

/** The run a repo's card should talk about: a live one first, else the most
 *  recent finished one still on the server. */
export function runFor(s: CanopyState, repoId: string): Run | undefined {
  let best: Run | undefined;
  for (const r of Object.values(s.runs)) {
    if (!ownRun(s.flowRuns, r)) continue;
    if (r.repoId !== repoId) continue;
    if (!best) {
      best = r;
      continue;
    }
    const a = isRunActive(r);
    const b = isRunActive(best);
    if (a !== b ? a : r.startedAt > best.startedAt) best = r;
  }
  return best;
}

export function activeRunFor(s: CanopyState, repoId: string): Run | undefined {
  const r = runFor(s, repoId);
  return r && isRunActive(r) ? r : undefined;
}

/** A repo's newest flow, active first. */
export function flowFor(s: CanopyState, repoId: string): Flow | undefined {
  let best: Flow | undefined;
  for (const f of Object.values(s.flows)) {
    if (f.repoId !== repoId) continue;
    if (!best || (isFlowActive(f) && !isFlowActive(best)) || (isFlowActive(f) === isFlowActive(best) && f.startedAt > best.startedAt)) best = f;
  }
  return best;
}

export function activeFlowFor(s: CanopyState, repoId: string): Flow | undefined {
  const f = flowFor(s, repoId);
  return f && isFlowActive(f) ? f : undefined;
}

/** All runs, newest first. */
export function allRuns(s: CanopyState): Run[] {
  return Object.values(s.runs).sort((a, b) => b.startedAt - a.startedAt);
}

/** What this browser can open and through what: its chosen helper, the one
 *  at its address, the backend's own Mac, or nothing. */
export const capsFor = (s: CanopyState): ClientCaps => clientCaps(s.client, s.helpers, s.settings.helper);

/** The helper name an open request carries: the one `capsFor` settled on,
 *  or none when the backend's own desktop (or nothing) is what opens. */
export const helperFor = (s: CanopyState): string | undefined => capsFor(s).helper?.name;

/** The repo's agent settings, the defaults when it has none. */
export const agentFor = (s: CanopyState, repo: Repo): AgentSettings =>
  s.agents[repo.path] ?? DEFAULT_AGENT;

/** The repo's launch settings, the defaults when it has none. */
export const launchFor = (s: CanopyState, repo: Repo): LaunchSettings =>
  s.launchers[repo.path] ?? DEFAULT_LAUNCH;

/** The repo's jobs, newest first. Callers select through useShallow. */
export function jobsFor(s: CanopyState, repoId: string): Job[] {
  return Object.values(s.jobs)
    .filter((j) => j.repoId === repoId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** repos in the active workspace, before any filter. A forge repo that is
 *  already cloned here is the same repo as the card next to it, so unless
 *  the setting says otherwise only the ones missing locally get one. */
export function scopedRepos(s: CanopyState): Repo[] {
  const all =
    s.settings.forge === "all"
      ? s.repos
      : s.repos.filter((r) => r.forge?.clonedAs === undefined);
  if (!s.activeWs) return all;
  const ws = s.workspaces.find((w) => w.name === s.activeWs);
  return ws ? all.filter((r) => ws.repos.includes(r.path)) : all;
}

/** how many repos the "needs attention" toggle would keep */
export function attentionCount(s: CanopyState): number {
  return scopedRepos(s).filter(needsAttention).length;
}

/** how many chips the filter menu has lit */
export function activeFilterCount(s: CanopyState): number {
  return s.filters.length + s.users.length;
}

export function visibleRepos(s: CanopyState): Repo[] {
  return applyQuery(scopedRepos(s), {
    filters: s.filters,
    users: s.users,
    attention: s.dirtyOnly,
    text: s.filter,
  });
}

/** The ids a fleet could be pointed at right now: pickable and in view.
 *  Callers select through useShallow. */
export function pickableIds(s: CanopyState): string[] {
  return selectable(visibleRepos(s)).map((r) => r.id);
}

/** The picked repos the view still shows. A pick survives a filter that
 *  hides it and comes back when the filter goes, but never rides along on a
 *  fleet or the count unseen. Callers select through useShallow. */
export function pickedIds(s: CanopyState): string[] {
  const have = new Set(s.selected);
  return pickableIds(s).filter((id) => have.has(id));
}
