import { create } from "zustand";
import { api, subscribe } from "./api";
import { applyQuery, type RepoFilter } from "./filters";
import { openElsewhere } from "./routes";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { clamp, needsAttention } from "./util";
import {
  DEFAULT_AGENT,
  isRunActive,
  type AgentSettings,
  type HistoryOverview,
  type Repo,
  type Run,
  type RunAction,
  type RunAnswer,
  type ScanResult,
  type ServerEvent,
  type SourceInput,
  type SourceState,
  type Workspace,
} from "../../src/core/types";

/** drag limits for the two resizable panes, in px */
export const SIDEBAR = { min: 180, max: 560, initial: 264 };
export const PANEL = { min: 300, max: 900, initial: 440 };
/** the solo view's centered panel; the window caps it before max does */
export const SOLO = { min: 420, max: 2400, initial: 980 };

const LAYOUT_KEY = "canopy.layout";

/** how often a window re-reads the archive overview on its own */
const HISTORY_REFRESH = 10 * 60_000;

interface Layout {
  sidebarWidth: number;
  panelWidths: Record<string, number>;
  /** px width of the panel in the solo view, shared by every solo tab */
  soloWidth: number;
  /** whether the repo tree is showing at all */
  sidebarOpen: boolean;
  /** folded sections, as sectionKey strings */
  collapsed: string[];
}

function loadLayout(): Layout {
  const fallback: Layout = {
    sidebarWidth: SIDEBAR.initial,
    panelWidths: {},
    soloWidth: SOLO.initial,
    sidebarOpen: true,
    collapsed: [],
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
  /** the claude-history archive, per repo; null until the first fetch lands */
  history: HistoryOverview | null;
  /** how Claude starts per repo, keyed by repo path; absent means defaults */
  agents: Record<string, AgentSettings>;

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
  closePanel: (id: string) => void;
  applyEvent: (ev: ServerEvent) => void;
  setWorkspaces: (ws: Workspace[]) => void;
  setSidebarWidth: (px: number) => void;
  toggleSidebar: () => void;
  /** folds or unfolds one section; the tree and the grid fold together */
  toggleGroup: (key: string) => void;
  setPanelWidth: (id: string, px: number) => void;
  setSoloWidth: (px: number) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;

  /** opens the pre-flight dialog for an action on a repo */
  plan: (repoId: string, action: RunAction) => void;
  /** opens a chat with Claude in a repo: the repo's live run if it has one,
   *  else a new idle chat whose first message starts Claude */
  openChat: (repoId: string) => Promise<void>;
  /** opens the repo's agent settings */
  editAgent: (repoId: string) => void;
  setAgent: (repoId: string, settings: AgentSettings) => Promise<void>;
  /** shows a run's console */
  showRun: (runId: string) => void;
  closeSheet: () => void;
  startRun: (repoId: string, action: RunAction, note: string) => Promise<void>;
  answerRun: (runId: string, promptId: string, answer: RunAnswer) => Promise<void>;
  /** the next message in a chat */
  sayRun: (runId: string, text: string) => Promise<void>;
  stopRun: (runId: string) => Promise<void>;
  dismissRun: (runId: string) => Promise<void>;
}

export type Sheet =
  | { kind: "plan"; repoId: string; action: RunAction }
  | { kind: "run"; runId: string }
  | { kind: "agent"; repoId: string };

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
  settings: loadSettings(),
  runs: {},
  sheet: null,
  history: null,
  agents: {},

  init: async () => {
    try {
      const [tree, workspaces, runs, agents] = await Promise.all([
        api.tree(),
        api.workspaces(),
        api.runs(),
        api.agents(),
      ]);
      set({
        root: tree.root,
        sources: tree.sources,
        repos: tree.repos,
        workspaces,
        runs: Object.fromEntries(runs.map((r) => [r.id, r])),
        agents,
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
    const [tree, runs] = await Promise.all([api.rescan(), api.runs()]);
    // a rescan can bring new repos; the server rebuilds the repo→project map
    void get().loadHistory(true);
    set((s) => ({
      ...treeState(s, tree),
      // runs are server state too: a stream gap may have hidden a finish
      runs: Object.fromEntries(runs.map((r) => [r.id, r])),
    }));
  },

  addSource: async (input) => {
    const tree = await api.addSource(input);
    void get().loadHistory(true);
    set((s) => treeState(s, tree));
  },
  removeSource: async (id) => {
    const tree = await api.removeSource(id);
    void get().loadHistory(true);
    set((s) => treeState(s, tree));
  },
  rescanSource: async (id) => {
    const tree = await api.rescanSource(id);
    void get().loadHistory(true);
    set((s) => treeState(s, tree));
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
  closePanel: (id) =>
    set((s) => ({ panels: s.panels.filter((p) => p !== id) })),

  applyEvent: (ev) => {
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
  showRun: (runId) => set({ sheet: { kind: "run", runId } }),
  closeSheet: () => set({ sheet: null }),
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
}));

/** The run a repo's card should talk about: a live one first, else the most
 *  recent finished one still on the server. */
export function runFor(s: CanopyState, repoId: string): Run | undefined {
  let best: Run | undefined;
  for (const r of Object.values(s.runs)) {
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

/** All runs, newest first. */
export function allRuns(s: CanopyState): Run[] {
  return Object.values(s.runs).sort((a, b) => b.startedAt - a.startedAt);
}

/** The repo's agent settings, the defaults when it has none. */
export const agentFor = (s: CanopyState, repo: Repo): AgentSettings =>
  s.agents[repo.path] ?? DEFAULT_AGENT;

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
