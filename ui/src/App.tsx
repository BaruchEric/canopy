import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Dock } from "./components/Dock";
import { RepoGrid } from "./components/RepoGrid";
import { Resizer } from "./components/Resizer";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { SIDEBAR, useStore } from "./store";

export function App() {
  const init = useStore((s) => s.init);
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const setDirtyOnly = useStore((s) => s.setDirtyOnly);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const [attempt, setAttempt] = useState(0);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("filter-input")?.focus();
      } else if (e.key === "d") {
        setDirtyOnly(!useStore.getState().dirtyOnly);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDirtyOnly]);

  if (!loaded) {
    if (loadError) {
      return (
        <div className="loading" role="alert">
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
      <div className="loading" role="status">
        scanning the grove…
      </div>
    );
  }
  return (
    <div className="app">
      <TopBar />
      <div
        className="body"
        style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
      >
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
        <RepoGrid />
        <Dock />
      </div>
    </div>
  );
}
