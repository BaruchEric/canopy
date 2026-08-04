import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

export function TopBar() {
  const root = useStore((s) => s.root);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const dirtyOnly = useStore((s) => s.dirtyOnly);
  const setDirtyOnly = useStore((s) => s.setDirtyOnly);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWs);
  const setActiveWs = useStore((s) => s.setActiveWs);
  const rescan = useStore((s) => s.rescan);
  const [scanning, setScanning] = useState(false);

  const doRescan = async () => {
    setScanning(true);
    try {
      await rescan();
    } finally {
      setScanning(false);
    }
  };

  return (
    <header className="topbar">
      <span className="wordmark" aria-label="canopy">
        <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="11" cy="12" r="8" fill="var(--moss)" />
          <circle cx="21" cy="10" r="7" fill="var(--moss-deep)" />
          <circle cx="17" cy="16" r="7" fill="var(--moss-pale)" opacity="0.85" />
          <rect x="15" y="20" width="3" height="9" rx="1" fill="var(--trunk)" />
        </svg>
        canopy
      </span>
      <span className="root-path" title={root}>
        {root}
      </span>

      <nav className="ws-tabs" aria-label="Workspaces">
        <button
          type="button"
          className={activeWs === null ? "tab active" : "tab"}
          onClick={() => setActiveWs(null)}
        >
          all
        </button>
        {workspaces.map((w) => (
          <span key={w.name} className="ws-tab-wrap">
            <button
              type="button"
              className={activeWs === w.name ? "tab active" : "tab"}
              onClick={() => setActiveWs(activeWs === w.name ? null : w.name)}
            >
              {w.name}
              <span className="tab-count">{w.repos.length}</span>
            </button>
            {activeWs === w.name && (
              <span className="ws-actions">
                <button
                  type="button"
                  className="mini"
                  title="Open all repos in one VS Code window"
                  onClick={() => void api.wsOpen(w.name, "code")}
                >
                  code
                </button>
                <button
                  type="button"
                  className="mini"
                  title="Open a kitty tab per repo"
                  onClick={() => void api.wsOpen(w.name, "kitty")}
                >
                  kitty
                </button>
              </span>
            )}
          </span>
        ))}
      </nav>

      <span className="spacer" />
      <label className="toggle">
        <input
          type="checkbox"
          checked={dirtyOnly}
          onChange={(e) => setDirtyOnly(e.target.checked)}
        />
        needs attention
      </label>
      <input
        id="filter-input"
        className="filter"
        type="search"
        placeholder="filter repos  /"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setFilter("");
        }}
      />
      <button
        type="button"
        className="mini"
        onClick={() => void doRescan()}
        disabled={scanning}
      >
        {scanning ? "scanning…" : "rescan"}
      </button>
    </header>
  );
}
