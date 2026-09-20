import { create } from "zustand";
import { api, subscribe } from "./api";
import { applyQuery, type RepoFilter } from "./filters";
import { openElsewhere, openShellElsewhere, parseRoute } from "./routes";
import { loadSettings, saveSettings, shellPlace, type Settings, type ShellPlace } from "./settings";
import { clamp, needsAttention } from "./util";
import { ownRun, pickable, selectable } from "./flows";
import { boardOrder, invertPick, pickWhere, rangeIds, setPick, togglePick } from "./select";
import { appendFeed, describeEvent, type FeedEntry } from "./feed";
import {
  DEFAULT_AGENT,
  DEFAULT_LAUNCH,
  isFlowActive,
  isRunActive,
  type AgentSettings,
  type Fleet,
  type Flow,
  type FlowChoice,
  type HistoryOverview,
  type Job,
  type LaunchSettings,
  type OpenerId,
  type Repo,
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
/** the solo view's centered panel; the window caps it before max does */
export const SOLO = { min: 420, max: 2400, initial: 980 };
/** the terminal strip along the bottom, in px of height */
export const TERM = { min: 120, max: 1200, initial: 300 };
/** a shell living in a repo's panel: the bounds and default of its height */
export const PANEL_TERM = { min: 120, max: 900, initial: 320 };
/** the event feed along the bottom, in px of height */
export const FEED = { min: 100, max: 900, initial: 220 };
/** sections that start folded, matching how the panel read before they could fold */
const DEFAULT_CLOSED = ["search", "history", "claude", "launch"];
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

const LAYOUT_KEY = "canopy.layout";

/** tab ids for the shells, unique for the page's life */
let termSeq = 0;

/** how often a window re-reads the archive overview on its own */
const HISTORY_REFRESH = 10 * 60_000;

interface Layout {
  sidebarWidth: number;
  panelWidths: Record<string, number>;
  /** px width of the panel in the solo view, shared by every solo tab */
  soloWidth: number;
  /** whether the repo tree is showing at all */
  sidebarOpen: boolean;
  /** folded tree groups, as group-key strings */
  collapsed: string[];
  /** folded panel sections (changes, shell, history, claude), as keys */
  closedSections: string[];
  /** the default-folded sections this layout has decided about, so a
   *  section added later starts folded instead of open everywhere */
  knownSections: string[];
  /** px height of the terminal strip */
  termHeight: number;
  /** px height of a shell living in a repo's panel */
  panelTermHeight: number;
  /** whether the event feed is showing along the bottom */
  feedOpen: boolean;
  /** px height of the event feed */
  feedHeight: number;
}

function loadLayout(): Layout {
  const fallback: Layout = {
    sidebarWidth: SIDEBAR.initial,
    panelWidths: {},
    soloWidth: SOLO.initial,
    sidebarOpen: true,
    collapsed: [],
    closedSections: [...DEFAULT_CLOSED],
    knownSections: [...DEFAULT_CLOSED],
    termHeight: TERM.initial,
    panelTermHeight: PANEL_TERM.initial,
    feedOpen: false,
    feedHeight: FEED.initial,
  };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as {
      sidebarWidth?: unknown;
      panelWidths?: Record<string, unknown>;
      soloWidth?: unknown;
      sidebarOpen?: unknown;
      collapsed?: unknown;
      closedSections?: unknown;
      knownSections?: unknown;
      termHeight?: unknown;
      panelTermHeight?: unknown;
      feedOpen?: unknown;
      feedHeight?: unknown;
    };
    const panelWidths: Record<string, number> = {};
    for (const [id, w] of Object.entries(saved.panelWidths ?? {})) {
      // Anything hand-edited or written by an older build gets clamped rather
      // than trusted — a bad number here would render an unusable panel.
      if (typeof w === "number" && Number.isFinite(w)) {
        panelWidths[id] = clamp(w, PANEL.min, PANEL.max);
      }
    }
    const sw = saved.sidebarWidth;
    const solo = saved.soloWidth;
    const th = saved.termHeight;
    const pth = saved.panelTermHeight;
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
      sidebarOpen: saved.sidebarOpen !== false,
      collapsed: Array.isArray(saved.collapsed)
        ? saved.collapsed.filter((k): k is string => typeof k === "string")
        : [],
      closedSections: Array.isArray(saved.closedSections)
        ? closedSectionsOf(
            saved.closedSections.filter((k): k is string => typeof k === "string"),
            Array.isArray(saved.knownSections)
              ? saved.knownSections.filter((k): k is string => typeof k === "string")
              : OLD_KNOWN,
          )
        : [...DEFAULT_CLOSED],
      knownSections: [...DEFAULT_CLOSED],
      termHeight:
        typeof th === "number" && Number.isFinite(th)
          ? clamp(th, TERM.min, TERM.max)
          : TERM.initial,
      panelTermHeight:
        typeof pth === "number" && Number.isFinite(pth)
          ? clamp(pth, PANEL_TERM.min, PANEL_TERM.max)
          : PANEL_TERM.initial,
      feedOpen: saved.feedOpen === true,
      feedHeight:
        typeof fh === "number" && Number.isFinite(fh)
          ? clamp(fh, FEED.min, FEED.max)
          : FEED.initial,
    };
  } catch {
    return fallback;
  }
}

function saveLayout(layout: Layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // storage can be disabled outright; the layout just won't survive a reload
  }
}

const layoutOf = (s: CanopyState): Layout => ({
  sidebarWidth: s.sidebarWidth,
  panelWidths: s.panelWidths,
  soloWidth: s.soloWidth,
  sidebarOpen: s.sidebarOpen,
  collapsed: s.collapsed,
  closedSections: s.closedSections,
  knownSections: [...DEFAULT_CLOSED],
  termHeight: s.termHeight,
  panelTermHeight: s.panelTermHeight,
  feedOpen: s.feedOpen,
  feedHeight: s.feedHeight,
});

/** drops stored widths for repos that no longer exist in the scan */
function pruneWidths(
  widths: Record<string, number>,
  repos: Repo[],
): Record<string, number> {
  const ids = new Set(repos.map((r) => r.id));
  const kept = Object.entries(widths).filter(([id]) => ids.has(id));
  if (kept.length === Object.keys(widths).length) return widths;
  return Object.fromEntries(kept);
}

interface CanopyState {
  root: string;
  /** every scanned folder, the launch root first */
  sources: SourceState[];
  repos: Repo[];
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
  /** repo id → last SSE update, for the update pulse */
  updatedAt: Record<string, number>;
  /** px width of the repo tree, dragged by the sidebar resizer */
  sidebarWidth: number;
  sidebarOpen: boolean;
  /** folded sections in the tree and the grid, as sectionKey strings */
  collapsed: string[];
  /** folded panel sections (changes, shell, history, claude), as keys */
  closedSections: string[];
  /** repo id → px width of its dock panel; missing means PANEL.initial */
  panelWidths: Record<string, number>;
  /** px width of the solo view's panel, dragged by its edge handles */
  soloWidth: number;
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
  /** px height of the strip, dragged by its top edge */
  termHeight: number;
  /** px height of a shell in a repo's panel, dragged by its top edge */
  panelTermHeight: number;
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
  openPanel: (id: string) => void;
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
  /** folds or unfolds one panel section (changes, shell, history, claude) */
  toggleSection: (key: string) => void;
  setPanelWidth: (id: string, px: number) => void;
  setSoloWidth: (px: number) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** opens a new shell at a repo where the settings say: its panel, the
   *  strip, or a tab or window of its own; `place` overrides the setting */
  openTerm: (repoId: string, place?: ShellPlace) => void;
  closeTerm: (id: string) => void;
  showTerm: (id: string) => void;
  /** marks a shell whose process has ended; its tab stays until closed */
  endTerm: (id: string, code: number | null) => void;
  setTermHeight: (px: number) => void;
  setPanelTermHeight: (px: number) => void;

  /** opens the pre-flight dialog for an action on a repo */
  plan: (repoId: string, action: RunAction) => void;
  /** opens a chat with Claude in a repo: the repo's live run if it has one,
   *  else a new idle chat whose first message starts Claude */
  openChat: (repoId: string) => Promise<void>;
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

/** one shell in the bottom strip */
export interface TermTab {
  id: string;
  repoId: string;
  /** the repo's name, what the tab says */
  name: string;
  /** the repo's locator; the socket lands there */
  path: string;
  /** the repo's panel, or the strip along the bottom */
  place: ShellPlace;
  /** set once the shell has exited, with its code */
  exit?: number | null;
}

export interface ClickModifiers {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

const layout = loadLayout();

/** The state a fresh tree implies: the repos and sources themselves, and
 *  the panels and widths that still have a repo to belong to. */
function treeState(
  s: CanopyState,
  tree: ScanResult,
): Pick<CanopyState, "root" | "sources" | "repos" | "panels" | "panelWidths"> {
  const panelWidths = pruneWidths(s.panelWidths, tree.repos);
  if (panelWidths !== s.panelWidths) {
    saveLayout({ ...layoutOf(s), panelWidths });
  }
  return {
    root: tree.root,
    sources: tree.sources,
    repos: tree.repos,
    // drop panels whose repo no longer exists — a panel with no repo
    // renders nothing, including its own close button
    panels: s.panels.filter((id) => tree.repos.some((r) => r.id === id)),
    panelWidths,
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

export const useStore = create<CanopyState>((set, get) => ({
  root: "",
  sources: [],
  repos: [],
  workspaces: [],
  loaded: false,
  loadError: null,
  filter: "",
  dirtyOnly: false,
  filters: [],
  users: [],
  activeWs: null,
  panels: [],
  updatedAt: {},
  sidebarWidth: layout.sidebarWidth,
  panelWidths: layout.panelWidths,
  soloWidth: layout.soloWidth,
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
  termHeight: layout.termHeight,
  panelTermHeight: layout.panelTermHeight,
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

  toggleFeed: () =>
    set((s) => {
      const feedOpen = !s.feedOpen;
      saveLayout({ ...layoutOf(s), feedOpen });
      return { feedOpen };
    }),
  clearFeed: () => set({ feed: [] }),
  setFeedHeight: (px) =>
    set((s) => {
      const feedHeight = clamp(px, FEED.min, FEED.max);
      saveLayout({ ...layoutOf(s), feedHeight });
      return { feedHeight };
    }),
  setFeedSource: (feedSource) => set({ feedSource }),
  setFeedQuiet: (feedQuiet) => set({ feedQuiet }),

  init: async () => {
    try {
      const [tree, workspaces, runs, agents, flows, fleets, verdict, launchers, jobs] = await Promise.all([
        api.tree(),
        api.workspaces(),
        api.runs(),
        api.agents(),
        api.flows(),
        api.fleets(),
        api.verdict(),
        api.launchers(),
        api.jobs(),
      ]);
      set({
        root: tree.root,
        sources: tree.sources,
        repos: tree.repos,
        workspaces,
        runs: Object.fromEntries(runs.map((r) => [r.id, r])),
        agents,
        launchers,
        jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
        flows: Object.fromEntries(flows.map((f) => [f.id, f])),
        fleets: Object.fromEntries(fleets.map((f) => [f.id, f])),
        flowRuns: flowRunsOf(flows),
        verdictReady: verdict.ready,
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
    const refresh = setInterval(() => void get().loadHistory(), HISTORY_REFRESH);
    // Handed back so the caller can close the stream — StrictMode mounts
    // effects twice, and an unclosed EventSource leaks a live connection.
    const unsubscribe = subscribe(
      (ev) => get().applyEvent(ev),
      () => {
        // the server may still be coming back up — a failed resync just
        // leaves the current tree in place until the next event
        void get().rescan().catch(() => {});
      },
    );
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
    set((s) => ({
      panels: s.panels.includes(id) ? s.panels : [...s.panels, id],
    })),
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
    if (target === "dock") get().openPanel(id);
    else openElsewhere(id, target);
  },
  openApp: async (id, app) => {
    await api.open(id, app, get().settings.terminal === "tab");
  },
  closePanel: (id) =>
    set((s) => ({
      panels: s.panels.filter((p) => p !== id),
      // A shell lived in the panel, so it ends with it: dropping the tab
      // unmounts its view, which closes the socket and hangs up the pty.
      // A shell you want to keep outliving a panel belongs in the strip.
      terms: s.terms.filter((t) => !(t.repoId === id && t.place === "panel")),
    })),

  applyEvent: (ev) => {
    // The feed says what changed, so the lines come from the event against
    // the state before it is applied.
    const lines = describeEvent(ev, get(), Date.now(), get().agents);
    if (lines.length) {
      set((s) => {
        const { feed, seq } = appendFeed(s.feed, lines, s.feedSeq);
        return { feed, feedSeq: seq };
      });
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
    }
  },

  setWorkspaces: (workspaces) => set({ workspaces }),

  setSidebarWidth: (px) =>
    set((s) => {
      const sidebarWidth = clamp(px, SIDEBAR.min, SIDEBAR.max);
      saveLayout({ ...layoutOf(s), sidebarWidth });
      return { sidebarWidth };
    }),
  toggleSidebar: () =>
    set((s) => {
      const sidebarOpen = !s.sidebarOpen;
      saveLayout({ ...layoutOf(s), sidebarOpen });
      return { sidebarOpen };
    }),
  toggleGroup: (key) =>
    set((s) => {
      const collapsed = s.collapsed.includes(key)
        ? s.collapsed.filter((k) => k !== key)
        : [...s.collapsed, key];
      saveLayout({ ...layoutOf(s), collapsed });
      return { collapsed };
    }),
  toggleSection: (key) =>
    set((s) => {
      const closedSections = s.closedSections.includes(key)
        ? s.closedSections.filter((k) => k !== key)
        : [...s.closedSections, key];
      saveLayout({ ...layoutOf(s), closedSections });
      return { closedSections };
    }),
  setPanelWidth: (id, px) =>
    set((s) => {
      const panelWidths = {
        ...s.panelWidths,
        [id]: clamp(px, PANEL.min, PANEL.max),
      };
      saveLayout({ ...layoutOf(s), panelWidths });
      return { panelWidths };
    }),
  setSoloWidth: (px) =>
    set((s) => {
      const soloWidth = clamp(px, SOLO.min, SOLO.max);
      saveLayout({ ...layoutOf(s), soloWidth });
      return { soloWidth };
    }),
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
        solo: parseRoute(window.location.search).solo,
      });
    if (where === "tab" || where === "window") {
      openShellElsewhere(repoId, where);
      return;
    }
    termSeq += 1;
    const tab: TermTab = { id: `t${termSeq}`, repoId, name: repo.name, path: repo.path, place: where };
    // A panel shell shows only inside its repo's panel and only while that
    // section is unfolded, so open both. Otherwise the click does nothing you
    // can see.
    const openPanel = where === "panel" && !s.panels.includes(repoId);
    const closedSections =
      where === "panel" ? s.closedSections.filter((k) => k !== "shell") : s.closedSections;
    if (closedSections !== s.closedSections) saveLayout({ ...layoutOf(s), closedSections });
    set({
      terms: [...s.terms, tab],
      activeTerm: where === "strip" ? tab.id : s.activeTerm,
      panels: openPanel ? [...s.panels, repoId] : s.panels,
      closedSections,
    });
  },
  closeTerm: (id) =>
    set((s) => {
      const i = s.terms.findIndex((t) => t.id === id);
      if (i === -1) return {};
      const terms = s.terms.filter((t) => t.id !== id);
      // the neighbour in the strip takes over, the way a browser's tab strip does
      const strip = terms.filter((t) => t.place === "strip");
      const j = s.terms.slice(0, i).filter((t) => t.place === "strip").length;
      const activeTerm =
        s.activeTerm !== id ? s.activeTerm : (strip[j] ?? strip[j - 1])?.id ?? null;
      return { terms, activeTerm };
    }),
  showTerm: (id) => set((s) => (s.terms.some((t) => t.id === id) ? { activeTerm: id } : {})),
  endTerm: (id, code) =>
    set((s) => ({ terms: s.terms.map((t) => (t.id === id ? { ...t, exit: code } : t)) })),
  setTermHeight: (px) =>
    set((s) => {
      const termHeight = clamp(px, TERM.min, TERM.max);
      saveLayout({ ...layoutOf(s), termHeight });
      return { termHeight };
    }),
  setPanelTermHeight: (px) =>
    set((s) => {
      const panelTermHeight = clamp(px, PANEL_TERM.min, PANEL_TERM.max);
      saveLayout({ ...layoutOf(s), panelTermHeight });
      return { panelTermHeight };
    }),

  plan: (repoId, action) => {
    // A repo with a run going shows that run instead of starting a second.
    const active = activeRunFor(get(), repoId);
    set({ sheet: active ? { kind: "run", runId: active.id } : { kind: "plan", repoId, action } });
  },
  openChat: async (repoId) => {
    const active = activeRunFor(get(), repoId);
    if (active) {
      set({ sheet: { kind: "run", runId: active.id } });
      return;
    }
    await get().startRun(repoId, "chat", "");
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
    set((s) => {
      const closedSections = s.closedSections.filter((k) => k !== "launch");
      if (closedSections.length !== s.closedSections.length) {
        saveLayout({ ...layoutOf(s), closedSections });
      }
      return {
        panels: s.panels.includes(repoId) ? s.panels : [...s.panels, repoId],
        closedSections,
      };
    }),
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
  showRun: (runId) => set({ sheet: { kind: "run", runId } }),
  closeSheet: () => set({ sheet: null }),
  openSearch: () => set({ sheet: { kind: "search" } }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  searchIn: (repoId, q) =>
    set((s) => {
      const closedSections = s.closedSections.filter((k) => k !== "search");
      if (closedSections.length !== s.closedSections.length) {
        saveLayout({ ...layoutOf(s), closedSections });
      }
      return {
        sheet: null,
        pendingSearch: { repoId, q },
        panels: s.panels.includes(repoId) ? s.panels : [...s.panels, repoId],
        closedSections,
      };
    }),
  takePendingSearch: () => set({ pendingSearch: null }),
  startRun: async (repoId, action, note) => {
    const run = await api.run(repoId, action, note);
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
