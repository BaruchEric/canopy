import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Dock } from "./components/Dock";
import { RepoGrid } from "./components/RepoGrid";
import { Resizer } from "./components/Resizer";
import { RunSheet } from "./components/RunSheet";
import { Sidebar } from "./components/Sidebar";
import { Solo } from "./components/Solo";
import { Crowns, TopBar } from "./components/TopBar";
import { parseRoute } from "./routes";
import { SORT_MODES } from "./settings";
import { SIDEBAR, useStore } from "./store";

const route = parseRoute(window.location.search);

export function App() {
  const init = useStore((s) => s.init);
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const setDirtyOnly = useStore((s) => s.setDirtyOnly);
  const setSetting = useStore((s) => s.setSetting);
  const theme = useStore((s) => s.settings.theme);
  const density = useStore((s) => s.settings.density);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const openPanel = useStore((s) => s.openPanel);
  const [attempt, setAttempt] = useState(0);
  const pinned = useRef(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void init().then((un) => {
      if (cancelled) un();
      else unsubscribe = un;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [init, attempt]);

  // Theme and density live on <html> so the solo view and the popover get
  // them too. "system" removes the attribute and lets color-scheme decide.
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") delete el.dataset["theme"];
    else el.dataset["theme"] = theme;
    el.dataset["density"] = density;
  }, [theme, density]);

  // A `?repo=` link pins that repo once the tree is in. Only once: a rescan
  // that drops the repo should not bring the panel back.
  useEffect(() => {
    if (!loaded || route.solo || !route.repo || pinned.current) return;
    pinned.current = true;
    if (useStore.getState().repos.some((r) => r.id === route.repo)) {
      openPanel(route.repo);
    }
  }, [loaded, openPanel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("filter-input")?.focus();
      } else if (e.key === "f") {
        document.getElementById("filters-btn")?.click();
      } else if (e.key === "[") {
        toggleSidebar();
      } else if (e.key === "d") {
        setDirtyOnly(!useStore.getState().dirtyOnly);
      } else if (e.key === "s") {
        const cur = useStore.getState().settings.sort;
        const next =
          SORT_MODES[(SORT_MODES.indexOf(cur) + 1) % SORT_MODES.length];
        if (next) setSetting("sort", next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDirtyOnly, setSetting, toggleSidebar]);

  if (!loaded) {
    if (loadError) {
      return (
        <div className="loading grove" role="alert">
          <Crowns size={40} />
          <p>Could not reach the canopy server: {loadError}</p>
          <button
            type="button"
            className="mini"
            onClick={() => setAttempt((n) => n + 1)}
          >
            try again
          </button>
        </div>
      );
    }
    return (
      <div className="loading grove" role="status">
        <Crowns size={40} live />
        scanning the grove…
      </div>
    );
  }
  if (route.solo && route.repo) return <Solo id={route.repo} />;
  return (
    <div className="app">
      <TopBar />
      <div
        className={sidebarOpen ? "body" : "body no-side"}
        style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
      >
        {sidebarOpen && (
          <>
            <Sidebar />
            <Resizer
              className="sidebar-resizer"
              label="Repository tree width"
              value={sidebarWidth}
              min={SIDEBAR.min}
              max={SIDEBAR.max}
              initial={SIDEBAR.initial}
              dir={1}
              cssVar="--sidebar-w"
              target={(h) => h.parentElement}
              onCommit={setSidebarWidth}
            />
          </>
        )}
        <RepoGrid />
        <Dock />
      </div>
      <RunSheet />
    </div>
  );
}
