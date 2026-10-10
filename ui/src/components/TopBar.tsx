import { useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { ownRun } from "../flows";
import { allRuns, attentionCount, capsFor, homeConn, pickedIds, useStore, waitingCount } from "../store";
import { WAITING_GLYPH, WAITING_PANEL } from "../waiting";
import { CLI_GLYPH } from "../cli";
import { onBeat } from "../live";
import { NARROW, PHONE, useMedia } from "../media";
import { effectivePrimary, isRunActive, WS_COLORS, type RunAction, type Workspace } from "../../../src/core/types";
import { isHome } from "../registry";
import { baseName } from "../elsewhere";
import { primaryRefusal } from "../workspaces";
import { seenWord } from "../peers";
import { PAGE_BUILD } from "../build";
import { versionLine } from "../../../src/core/version";
import { FilterMenu } from "./Filters";
import { Gear, type GearEntry, type GearGroup } from "./Gear";
import { Seg } from "./Seg";
import { SettingsMenu } from "./Settings";
import { BackendsChip } from "./Backends";
import { ChanChip } from "./Chan";
import { InboxChip } from "./Inbox";
import { NewProjectButton } from "./Incubator";
import { DevicesChip } from "./Devices";
import { KeptShells } from "./KeptShells";
import { ShellsChip } from "./Shells";
import { TasksChip } from "./Tasks";
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

/** The crowns and the name; `version` adds the page's build after it, the
 *  whole line (commit and day) in its tooltip, Settings' about for the rest. */
export function Wordmark({ version = false }: { version?: boolean }) {
  return (
    <span className="wordmark" aria-label="canopy">
      <Crowns />
      canopy
      {version && PAGE_BUILD && (
        <span className="wordmark-ver" title={`canopy ${versionLine(PAGE_BUILD)}`}>
          v{PAGE_BUILD.version}
        </span>
      )}
    </span>
  );
}

const SORT = [
  {
    value: "recent",
    label: "recent",
    title: "By last change, a commit or an edit in the working tree: today, this week, this month…",
  },
  { value: "folder", label: "folder", title: "By topic folder, as on disk" },
  {
    value: "activity",
    label: "activity",
    title: "What needs a hand first: changes, unpushed, behind, quiet",
  },
  { value: "name", label: "name", title: "One flat list, a to z" },
  { value: "user", label: "user", title: "By the git identity each repo commits as" },
  { value: "favorites", label: "★", title: "Favorites first, then everything else, each newest change first" },
] as const;

/** Live runs across the grove. Absent when nothing is going; a click opens
 *  the run that needs an answer first, else the newest one. */
function RunsPill() {
  const runs = useStore(useShallow((s) => allRuns(s).filter((r) => isRunActive(r) && ownRun(s.flowRuns, r))));
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

/** Who this backend last reached in the peer pass, one word per peer, an
 *  unreachable one in the rust colour. Absent with no peers configured. */
function PeersChip() {
  const peerSeen = useStore((s) => s.peerSeen);
  if (peerSeen.length === 0) return null;
  return (
    <span className="peers-chip" title="Peers this backend pulls from">
      {peerSeen.map((p) => (
        <span key={p.name} className={p.ok ? "peer-seen" : "peer-seen offline"}>
          {seenWord(p)}
        </span>
      ))}
    </span>
  );
}

/** The home backend's stream, as one light: moss while it is live, and a
 *  flash on every event it sends, so a change that lands off screen still
 *  shows that the page heard it. Rust when the stream is down. */
function LiveDot() {
  const state = useStore((s) => homeConn(s).status.state);
  const reason = useStore((s) => homeConn(s).status.reason);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onBeat(() => {
        const el = ref.current;
        if (!el) return;
        // restart the flash: drop the class, let a frame see it gone, add it
        el.classList.remove("beat");
        void el.offsetWidth;
        el.classList.add("beat");
      }),
    [],
  );
  const word =
    state === "online"
      ? "live: changes show as they happen"
      : state === "connecting"
        ? "connecting to the backend…"
        : state === "signin"
          ? "sign in to the backend"
          : `offline${reason ? `: ${reason}` : ""}; showing what it last said`;
  return (
    <span ref={ref} className={`live-dot ${state}`} role="status" title={word} aria-label={word}>
      <i aria-hidden="true" />
    </span>
  );
}

function SideToggle() {
  const narrow = useMedia(NARROW);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const setDrawer = useStore((s) => s.setDrawer);
  // beside the cards on a wide window, a drawer over them on a narrow one;
  // lit when the column is folded away, or while the drawer is out
  const open = narrow ? drawerOpen : sidebarOpen;
  const lit = narrow ? drawerOpen : !sidebarOpen;
  return (
    <button
      type="button"
      className={lit ? "icon-btn side-toggle on" : "icon-btn side-toggle"}
      aria-expanded={open}
      aria-controls="sidebar"
      title={open ? "Hide the repo tree ([)" : "Show the repo tree ([)"}
      onClick={() => (narrow ? setDrawer(!drawerOpen) : toggleSidebar())}
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
  );
}

function WsTabs() {
  // the workspace openers go where this browser can open: nothing on a
  // phone, the helper on a laptop next to a headless backend
  const caps = useStore(useShallow(capsFor));
  const canOpen = caps.openers;
  const helper = caps.helper?.name;
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWs);
  const setActiveWs = useStore((s) => s.setActiveWs);
  return (
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
            <span className="ws-dot" data-color={w.color ?? ""} aria-hidden="true" />
            {w.name}
            <span className="tab-count">{w.repos.length}</span>
          </button>
          {/* the gear shows everywhere, a phone too: asking and chatting
              work anywhere; only the openers need a laptop */}
          {activeWs === w.name && (
            <span className="ws-actions">
              {canOpen.includes("code") && (
                <button
                  type="button"
                  className="mini"
                  title="Open all repos in one VS Code window"
                  onClick={() => void api.wsOpen(w.name, "code", helper)}
                >
                  code
                </button>
              )}
              {canOpen.includes("kitty") && (
                <button
                  type="button"
                  className="mini"
                  title="Open a kitty tab per repo"
                  onClick={() => void api.wsOpen(w.name, "kitty", helper)}
                >
                  kitty
                </button>
              )}
              <WsGear ws={w} />
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** What the workspace menu starts, one line each; another kind of run across
 *  a workspace is one more line here. */
const WS_RUNS: { action: RunAction; label: string }[] = [
  { action: "ask", label: "ask in workspace…" },
  { action: "chat", label: "chat in workspace…" },
  { action: "propose", label: "plan, then build in workspace…" },
];

/** The active workspace's menu: a run across it, which member is its
 *  primary, and its color. The look is kept in the backend's config. */
function WsGear({ ws }: { ws: Workspace }) {
  const repos = useStore((s) => s.repos);
  const openWsPlan = useStore((s) => s.openWsPlan);
  const primary = effectivePrimary(ws);
  const look = (l: Parameters<typeof api.wsLook>[1]) => () => api.wsLook(ws.name, l);
  const groups: GearGroup[] = [
    {
      label: "run",
      entries: WS_RUNS.map(({ action, label }): GearEntry => ({
        type: "item",
        label,
        run: () => openWsPlan(ws.name, action),
      })),
    },
    {
      label: "primary",
      entries: ws.repos.map((path): GearEntry => {
        // a workspace holds home's checkouts, so a member is a home card
        const repo = repos.find((r) => isHome(r.id) && r.path === path);
        // one a workspace run would refuse to start in shows, greyed, with why
        const why = primaryRefusal(repo, path);
        if (why !== null || !repo) return { type: "item", label: repo?.name ?? baseName(path), on: path === primary, off: why ?? `${path} is not in the tree`, run: () => undefined };
        return { type: "item", label: repo.name, title: path, on: path === primary, stay: true, run: look({ primary: repo.id }) };
      }),
    },
    {
      label: "color",
      entries: [
        ...WS_COLORS.map((c): GearEntry => ({ type: "item", label: c, on: ws.color === c, stay: true, run: look({ color: c }) })),
        { type: "item", label: "none", on: !ws.color, stay: true, run: look({ color: null }) },
      ],
    },
  ];
  return (
    <Gear
      label={`the ${ws.name} workspace`}
      hint="Ask, chat or plan, then build across the workspace, set its primary and its color"
      groups={groups}
      perScreen={false}
      sheet
      // "plan, then build in workspace…" is cut short at 256
      width={288}
    />
  );
}

function FeedButton() {
  const feedOpen = useStore((s) => s.feedOpen);
  const toggleFeed = useStore((s) => s.toggleFeed);
  return (
    <button
      type="button"
      className={feedOpen ? "icon-btn on" : "icon-btn"}
      aria-pressed={feedOpen}
      title={feedOpen ? "Hide the event feed (e)" : "Show the event feed: every source's events as they happen (e)"}
      aria-label="Event feed"
      onClick={toggleFeed}
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
        <path d="M4 6h16" />
        <path d="M4 12h10" />
        <path d="M4 18h13" />
        <circle cx="19" cy="17" r="2" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}

function SearchButton() {
  const openSearch = useStore((s) => s.openSearch);
  return (
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
  );
}

function SelectPill() {
  const selecting = useStore((s) => s.selecting);
  const picked = useStore((s) => pickedIds(s).length);
  const setSelecting = useStore((s) => s.setSelecting);
  return (
    <button
      type="button"
      className={selecting ? "pill on" : "pill"}
      aria-pressed={selecting}
      title="Pick repos to run one workflow on all of them (x)"
      onClick={() => setSelecting(!selecting)}
    >
      {selecting ? `${picked} picked` : "select"}
    </button>
  );
}

function SortSeg() {
  const sort = useStore((s) => s.settings.sort);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <Seg
      className="seg-sort"
      label="Group repos by"
      value={sort}
      options={SORT}
      onChange={(v) => setSetting("sort", v)}
    />
  );
}

/** "13 need attention", the needs-a-hand filter's switch; on a phone the
 *  words go and the count stays. */
function AttentionPill() {
  const dirtyOnly = useStore((s) => s.dirtyOnly);
  const setDirtyOnly = useStore((s) => s.setDirtyOnly);
  const attention = useStore(attentionCount);
  return (
    <button
      type="button"
      className={dirtyOnly ? "pill attention on" : "pill attention"}
      aria-pressed={dirtyOnly}
      title="Only repos with changes, unpushed commits, or errors (d)"
      onClick={() => setDirtyOnly(!dirtyOnly)}
    >
      <span className={attention > 0 ? "dot lichen" : "dot moss"} />
      {attention === 0 ? (
        "all quiet"
      ) : (
        <>
          <span className="pill-n">{attention}</span>
          <span className="pill-words"> need{attention === 1 ? "s" : ""} attention</span>
        </>
      )}
    </button>
  );
}

function FilterBox() {
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  return (
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
  );
}

function RescanButton() {
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
    <button
      type="button"
      className={scanning ? "mini rescan busy" : "mini rescan"}
      title="Walk every folder again for repos"
      aria-label={scanning ? "scanning" : "rescan"}
      onClick={() => void doRescan()}
      disabled={scanning}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 11a8 8 0 1 0-2.3 5.7" />
        <path d="M20 4v7h-7" />
      </svg>
      <span className="rescan-word">{scanning ? "scanning…" : "rescan"}</span>
    </button>
  );
}

/** Brings up the command line: canopy's CLI words, typed in the page.
 *  ⌘K and `:` do the same. */
function CliButton() {
  const setCliOpen = useStore((s) => s.setCliOpen);
  return (
    <button
      type="button"
      className="mini cli-btn"
      aria-label="Command line"
      aria-keyshortcuts="Meta+K"
      title="Command line (⌘K or :): the canopy CLI's commands, run against this page"
      onClick={() => setCliOpen(true)}
    >
      <span aria-hidden="true">{CLI_GLYPH}</span>
    </button>
  );
}

/** Opens the "waiting on you" panel in the dock, or brings it forward when
 *  it is open: everything that needs you in one place, counted beside its
 *  flag as the inbox chip counts its own. `w` does the same. */
function WaitingButton() {
  const openPanel = useStore((s) => s.openPanel);
  const open = useStore((s) => s.panels.includes(WAITING_PANEL));
  const count = useStore(waitingCount);
  return (
    <button
      type="button"
      className={open ? "mini waiting-btn on" : "mini waiting-btn"}
      aria-label={`Waiting on you, ${count} ${count === 1 ? "thing" : "things"}`}
      title={`Waiting on you (w): asks, prompts, gates, the repos that need you and what failed, ${count} in all, in a dock panel`}
      onClick={() => openPanel(WAITING_PANEL)}
    >
      <span aria-hidden="true">{WAITING_GLYPH}</span> {count || ""}
    </button>
  );
}

/** Who else is here and what is running: each chip is absent when it has
 *  nothing to say. A phone keeps the tasks' chip and the inbox on its first
 *  row instead, where a thumb finds them without scrolling. */
function Chips({ phone = false }: { phone?: boolean }) {
  return (
    <>
      <PeersChip />
      <BackendsChip />
      <KeptShells />
      <ShellsChip />
      {!phone && <TasksChip />}
      <DevicesChip />
      {!phone && <InboxChip />}
      {!phone && <CliButton />}
      {!phone && <WaitingButton />}
      <ChanChip />
    </>
  );
}

/** The top bar: `nav` is the view switcher, which sits beside the name. A
 *  window as wide as a laptop's gets two rows, the views and the scope
 *  above the grouping and the filters; a phone gets three short ones, the
 *  views and the few buttons a thumb reaches for first, then the filter
 *  box, then everything else in one row that scrolls sideways. */
export function TopBar({ nav }: { nav?: ReactNode }) {
  const phone = useMedia(PHONE);

  if (phone) {
    return (
      <header className="topbar phone">
        <div className="tb-line">
          <SideToggle />
          <Wordmark />
          {nav}
          <span className="spacer" />
          {/* the tasks' chip stays in reach with a repo open, when the rows
              under this one go: it brings a task to the front from anywhere */}
          <TasksChip />
          <InboxChip />
          <CliButton />
          <WaitingButton />
          <LiveDot />
          <SearchButton />
          <SettingsMenu />
        </div>
        <div className="tb-line tb-tools">
          <FilterBox />
          <AttentionPill />
          <FilterMenu />
        </div>
        <div className="tb-line tb-tools tb-scroll">
          <NewProjectButton />
          <SortSeg />
          <SelectPill />
          <RunsPill />
          <FeedButton />
          <RescanButton />
          <SourcesMenu />
          <WsTabs />
          <Chips phone />
        </div>
      </header>
    );
  }

  return (
    <header className="topbar">
      <SideToggle />
      <Wordmark version />
      {nav}
      <SourcesMenu />
      <WsTabs />

      <span className="spacer" />

      {/* feed, search and select wrap as one, so a narrow bar never splits them */}
      <span className="topbar-group">
        <LiveDot />
        <FeedButton />
        <SearchButton />
        <NewProjectButton />
        <SelectPill />
      </span>
      <span className="topbar-break" aria-hidden="true" />

      <SortSeg />
      <RunsPill />
      <AttentionPill />
      <FilterMenu />
      <FilterBox />

      {/* rescan and the chips keep to the right end of whichever row they land on */}
      <span className="topbar-group topbar-tail">
        <RescanButton />
        <Chips />
        <SettingsMenu />
      </span>
    </header>
  );
}
