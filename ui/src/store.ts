import { create } from "zustand";
import { api, subscribe } from "./api";
import type { Repo, ServerEvent, Workspace } from "../../src/core/types";

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
}

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
    set((s) => ({
      root: tree.root,
      repos: tree.repos,
      // drop panels whose repo no longer exists — a panel with no repo
      // renders nothing, including its own close button
      panels: s.panels.filter((id) => tree.repos.some((r) => r.id === id)),
    }));
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
      set((s) => ({
        root: ev.result.root,
        repos: ev.result.repos,
        panels: s.panels.filter((id) =>
          ev.result.repos.some((r) => r.id === id),
        ),
      }));
    } else if (ev.type === "workspaces") {
      set({ workspaces: ev.workspaces });
    }
  },

  setWorkspaces: (workspaces) => set({ workspaces }),
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
