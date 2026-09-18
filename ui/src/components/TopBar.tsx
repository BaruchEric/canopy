import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { allRuns, attentionCount, useStore } from "../store";
import { isRunActive } from "../../../src/core/types";
import { FilterMenu } from "./Filters";
import { Seg } from "./Seg";
import { SettingsMenu } from "./Settings";
import { SourcesMenu } from "./Sources";

/** The three crowns and a trunk. `live` makes them breathe (loading screen). */
export function Crowns({ size = 18, live = false }: { size?: number; live?: boolean }) {
  return (
    <svg
      className={live ? "crowns live" : "crowns"}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <circle cx="11" cy="12" r="8" fill="var(--moss)" />
      <circle cx="21" cy="10" r="7" fill="var(--moss-deep)" />
      <circle cx="17" cy="16" r="7" fill="var(--moss-pale)" opacity="0.85" />
      <rect x="15" y="20" width="3" height="9" rx="1" fill="var(--trunk)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="canopy">
      <Crowns />
      canopy
    </span>
  );
}

const SORT = [
  { value: "folder", label: "folder", title: "By topic folder, as on disk" },
  {
    value: "activity",
    label: "activity",
    title: "What needs a hand first: changes, unpushed, behind, quiet",
  },
  { value: "recent", label: "recent", title: "By last commit: today, this week, this month…" },
  { value: "name", label: "name", title: "One flat list, a to z" },
  { value: "user", label: "user", title: "By the git identity each repo commits as" },
] as const;

/** Live runs across the grove. Absent when nothing is going; a click opens
 *  the run that needs an answer first, else the newest one. */
function RunsPill() {
  const runs = useStore(useShallow((s) => allRuns(s).filter(isRunActive)));
  const showRun = useStore((s) => s.showRun);
  if (runs.length === 0) return null;
  const waiting = runs.filter((r) => r.status === "waiting");
  const target = waiting[0] ?? runs[0];
  const text =
    waiting.length > 0
      ? `${waiting.length} need${waiting.length === 1 ? "s" : ""} you`
      : `${runs.length} claude run${runs.length === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      className={waiting.length > 0 ? "pill runs on" : "pill runs"}
      title="Show the run"
      onClick={() => {
        if (target) showRun(target.id);
      }}
    >
      <span className={waiting.length > 0 ? "dot lichen" : "dot sky live"} />
      {text}
    </button>
  );
}

export function TopBar() {
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const dirtyOnly = useStore((s) => s.dirtyOnly);
  const setDirtyOnly = useStore((s) => s.setDirtyOnly);
  const attention = useStore(attentionCount);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWs);
  const setActiveWs = useStore((s) => s.setActiveWs);
  const sort = useStore((s) => s.settings.sort);
  const setSetting = useStore((s) => s.setSetting);
  const rescan = useStore((s) => s.rescan);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const openSearch = useStore((s) => s.openSearch);
  const selecting = useStore((s) => s.selecting);
  const selected = useStore((s) => s.selected);
  const setSelecting = useStore((s) => s.setSelecting);
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
      <button
        type="button"
        className={sidebarOpen ? "icon-btn side-toggle" : "icon-btn side-toggle on"}
        aria-expanded={sidebarOpen}
        aria-controls="sidebar"
        title={sidebarOpen ? "Hide the repo tree ([)" : "Show the repo tree ([)"}
        onClick={toggleSidebar}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M9.5 4v16" />
        </svg>
      </button>
      <Wordmark />
      <SourcesMenu />

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

      <button
        type="button"
        className="icon-btn"
        title="Search file contents across the repos in view (⌘⇧F)"
        aria-label="Search file contents"
        onClick={openSearch}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </button>

      <button
        type="button"
        className={selecting ? "pill on" : "pill"}
        aria-pressed={selecting}
        title="Pick repos to run one workflow on all of them"
        onClick={() => setSelecting(!selecting)}
      >
        {selecting ? `${selected.length} picked` : "select"}
      </button>

      <Seg
        className="seg-sort"
        label="Group repos by"
        value={sort}
        options={SORT}
        onChange={(v) => setSetting("sort", v)}
      />

      <RunsPill />

      <button
        type="button"
        className={dirtyOnly ? "pill on" : "pill"}
        aria-pressed={dirtyOnly}
        title="Only repos with changes, unpushed commits, or errors (d)"
        onClick={() => setDirtyOnly(!dirtyOnly)}
      >
        <span className={attention > 0 ? "dot lichen" : "dot moss"} />
        {attention === 0
          ? "all quiet"
          : `${attention} need${attention === 1 ? "s" : ""} attention`}
      </button>

      <FilterMenu />

      <label className="search">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.8-3.8" />
        </svg>
        <input
          id="filter-input"
          className="filter"
          type="search"
          placeholder="filter repos"
          aria-label="Filter repos"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter("");
          }}
        />
        <kbd aria-hidden="true">/</kbd>
      </label>

      <button
        type="button"
        className="mini"
        onClick={() => void doRescan()}
        disabled={scanning}
      >
        {scanning ? "scanning…" : "rescan"}
      </button>

      <SettingsMenu />
    </header>
  );
}
