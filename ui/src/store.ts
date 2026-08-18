import { create } from "zustand";
import { api, subscribe } from "./api";
import { clamp } from "./util";
import type { Repo, ServerEvent, Workspace } from "../../src/core/types";

/** drag limits for the two resizable panes, in px */
export const SIDEBAR = { min: 180, max: 560, initial: 264 };
export const PANEL = { min: 300, max: 900, initial: 440 };

const LAYOUT_KEY = "canopy.layout";

interface Layout {
  sidebarWidth: number;
  panelWidths: Record<string, number>;
}

function loadLayout(): Layout {
  const fallback: Layout = { sidebarWidth: SIDEBAR.initial, panelWidths: {} };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as {
      sidebarWidth?: unknown;
      panelWidths?: Record<string, unknown>;
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
    return {
      sidebarWidth:
        typeof sw === "number" && Number.isFinite(sw)
          ? clamp(sw, SIDEBAR.min, SIDEBAR.max)
          : SIDEBAR.initial,
      panelWidths,
    };
  } catch {
    return fallback;
  }
}

function saveLayout(sidebarWidth: number, panelWidths: Record<string, number>) {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ sidebarWidth, panelWidths }),
    );
  } catch {
    // storage can be disabled outright; the layout just won't survive a reload
  }
}

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
  repos: Repo[];
  workspaces: Workspace[];
  loaded: boolean;
  /** why the initial load failed, if it did */
  loadError: string | null;
  filter: string;
  dirtyOnly: boolean;
  /** active workspace tab; null = all */
  activeWs: string | null;
  /** repo ids pinned open in the dock, left to right */
  panels: string[];
  /** repo id → last SSE update, for the update pulse */
  updatedAt: Record<string, number>;
  /** px width of the repo tree, dragged by the sidebar resizer */
  sidebarWidth: number;
  /** repo id → px width of its dock panel; missing means PANEL.initial */
  panelWidths: Record<string, number>;

  /** loads the tree and opens the SSE stream; returns its unsubscribe */
  init: () => Promise<() => void>;
  rescan: () => Promise<void>;
  setFilter: (f: string) => void;
  setDirtyOnly: (v: boolean) => void;
  setActiveWs: (name: string | null) => void;
  openPanel: (id: string) => void;
  closePanel: (id: string) => void;
  applyEvent: (ev: ServerEvent) => void;
  setWorkspaces: (ws: Workspace[]) => void;
  setSidebarWidth: (px: number) => void;
  setPanelWidth: (id: string, px: number) => void;
}

const layout = loadLayout();

export const useStore = create<CanopyState>((set, get) => ({
  root: "",
  repos: [],
  workspaces: [],
  loaded: false,
  loadError: null,
  filter: "",
  dirtyOnly: false,
  activeWs: null,
  panels: [],
  updatedAt: {},
  sidebarWidth: layout.sidebarWidth,
  panelWidths: layout.panelWidths,

  init: async () => {
    try {
      const [tree, workspaces] = await Promise.all([
        api.tree(),
        api.workspaces(),
      ]);
      set({
        root: tree.root,
        repos: tree.repos,
        workspaces,
        loaded: true,
        loadError: null,
      });
    } catch (err) {
      // Without this the app sits on the loading screen forever with no
      // message and no way back.
      set({ loadError: String(err instanceof Error ? err.message : err) });
      return () => {};
    }
    // Handed back so the caller can close the stream — StrictMode mounts
    // effects twice, and an unclosed EventSource leaks a live connection.
    return subscribe(
      (ev) => get().applyEvent(ev),
      () => {
        // the server may still be coming back up — a failed resync just
        // leaves the current tree in place until the next event
        void get().rescan().catch(() => {});
      },
    );
  },

  rescan: async () => {
    const tree = await api.rescan();
    set((s) => {
      const panelWidths = pruneWidths(s.panelWidths, tree.repos);
      if (panelWidths !== s.panelWidths) saveLayout(s.sidebarWidth, panelWidths);
      return {
        root: tree.root,
        repos: tree.repos,
        // drop panels whose repo no longer exists — a panel with no repo
        // renders nothing, including its own close button
        panels: s.panels.filter((id) => tree.repos.some((r) => r.id === id)),
        panelWidths,
      };
    });
  },

  setFilter: (filter) => set({ filter }),
  setDirtyOnly: (dirtyOnly) => set({ dirtyOnly }),
  setActiveWs: (activeWs) => set({ activeWs }),

  openPanel: (id) =>
    set((s) => ({
      panels: s.panels.includes(id) ? s.panels : [...s.panels, id],
    })),
  closePanel: (id) =>
    set((s) => ({ panels: s.panels.filter((p) => p !== id) })),

  applyEvent: (ev) => {
    if (ev.type === "repo") {
      set((s) => ({
        repos: s.repos.map((r) => (r.id === ev.repo.id ? ev.repo : r)),
        updatedAt: { ...s.updatedAt, [ev.repo.id]: Date.now() },
      }));
    } else if (ev.type === "scan") {
      set((s) => {
        const panelWidths = pruneWidths(s.panelWidths, ev.result.repos);
        if (panelWidths !== s.panelWidths) {
          saveLayout(s.sidebarWidth, panelWidths);
        }
        return {
          root: ev.result.root,
          repos: ev.result.repos,
          panels: s.panels.filter((id) =>
            ev.result.repos.some((r) => r.id === id),
          ),
          panelWidths,
        };
      });
    } else if (ev.type === "workspaces") {
      set({ workspaces: ev.workspaces });
    }
  },

  setWorkspaces: (workspaces) => set({ workspaces }),

  setSidebarWidth: (px) =>
    set((s) => {
      const sidebarWidth = clamp(px, SIDEBAR.min, SIDEBAR.max);
      saveLayout(sidebarWidth, s.panelWidths);
      return { sidebarWidth };
    }),
  setPanelWidth: (id, px) =>
    set((s) => {
      const panelWidths = {
        ...s.panelWidths,
        [id]: clamp(px, PANEL.min, PANEL.max),
      };
      saveLayout(s.sidebarWidth, panelWidths);
      return { panelWidths };
    }),
}));

export function visibleRepos(s: CanopyState): Repo[] {
  let list = s.repos;
  if (s.activeWs) {
    const ws = s.workspaces.find((w) => w.name === s.activeWs);
    if (ws) list = list.filter((r) => ws.repos.includes(r.path));
  }
  if (s.dirtyOnly) {
    list = list.filter(
      (r) =>
        (r.status?.files.length ?? 0) > 0 ||
        (r.status?.ahead ?? 0) > 0 ||
        Boolean(r.error),
    );
  }
  const f = s.filter.trim().toLowerCase();
  if (f) list = list.filter((r) => r.id.toLowerCase().includes(f));
  return list;
}
