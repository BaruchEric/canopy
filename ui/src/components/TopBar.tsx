import { HealthChip } from "./Health";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { ownRun } from "../flows";
import { allRuns, attentionCount, capsFor, homeConn, pickedIds, useStore, waitingCount, wantsSignIn } from "../store";
import { WAITING_GLYPH, WAITING_PANEL } from "../waiting";
import { CLI_GLYPH } from "../cli";
import { NARROW, PHONE, useMedia } from "../media";
import { effectivePrimary, isRunActive, WS_COLORS, type RunAction, type Workspace } from "../../../src/core/types";
import { isHome } from "../registry";
import { baseName } from "../elsewhere";
import { primaryRefusal } from "../workspaces";
import { PAGE_BUILD } from "../build";
import { TUCK_START, nextTuck, scrollEdges, type Tuck } from "../topbar";
import { buildMoved, versionLine } from "../../../src/core/version";
import { isOwnCode } from "../callerToken";
import { FilterMenu } from "./Filters";
import { PickMenu, type PickGroup, type PickOption } from "./PickMenu";
import { Gear, type GearEntry, type GearGroup } from "./Gear";
import { SettingsMenu } from "./Settings";
import { BackendMenu } from "./BackendMenu";
import { ChanChip } from "./Chan";
import { InboxChip } from "./Inbox";
import { NewProjectButton } from "./Incubator";
import { KeptShells } from "./KeptShells";
import { ShellsChip } from "./Shells";
import { RangerChip } from "./Ranger";
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
  { value: "favorites", label: "★ favorites", title: "Favorites first, then everything else, each newest change first" },
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

/** The workspaces as one word, the one in use, with every repo when none
 *  is; the menu lists each with its count and the repos it holds. The
 *  active one's openers and gear sit beside the word, outside the menu: a
 *  gear opens in a portal, and a press in it would close a menu it sat in.
 *  Absent until a workspace exists, since there is nothing to choose. */
function WsMenu() {
  // the workspace openers go where this browser can open: nothing on a
  // phone, the helper on a laptop next to a headless backend
  const caps = useStore(useShallow(capsFor));
  const canOpen = caps.openers;
  const helper = caps.helper?.name;
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWs);
  const setActiveWs = useStore((s) => s.setActiveWs);
  if (workspaces.length === 0) return null;
  const w = workspaces.find((x) => x.name === activeWs) ?? null;
  const groups: PickGroup[] = [
    {
      label: "workspace",
      options: [
        { value: "", label: "all repos", what: "Every repo in the tree, no workspace" },
        ...workspaces.map((x): PickOption => {
          const names = x.repos.map(baseName);
          return {
            value: x.name,
            label: (
              <>
                <span className="ws-dot" data-color={x.color ?? ""} aria-hidden="true" />
                {x.name}
                <span className="tab-count">{x.repos.length}</span>
              </>
            ),
            what: names.slice(0, 4).join(", ") + (names.length > 4 ? `, +${names.length - 4}` : ""),
            title: x.repos.join("\n"),
          };
        }),
      ],
    },
  ];
  return (
    <span className="ws-pick">
      <PickMenu
        className={w ? "ws-on" : ""}
        label="Workspace"
        value={activeWs ?? ""}
        groups={groups}
        onPick={(v) => setActiveWs(v || null)}
        title={w ? `Showing the ${w.name} workspace, ${w.repos.length} repos` : "Showing every repo; pick a workspace to see only its repos"}
        trigger={
          w ? (
            <>
              <span className="ws-dot" data-color={w.color ?? ""} aria-hidden="true" />
              {w.name}
              <span className="tab-count">{w.repos.length}</span>
            </>
          ) : (
            <span className="pick-dim">all repos</span>
          )
        }
      />
      {/* the gear shows everywhere, a phone too: asking and chatting work
          anywhere; only the openers need a laptop */}
      {w && (
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

/** The grouping as one word, the one in use; the rest are a click away, each
 *  with the line that says what it does. `s` steps through them. */
function SortMenu() {
  const sort = useStore((s) => s.settings.sort);
  const setSetting = useStore((s) => s.setSetting);
  const current = SORT.find((o) => o.value === sort) ?? SORT[0];
  return (
    <PickMenu
      label="Group repos by"
      value={sort}
      groups={[{ label: "group by", options: SORT.map((o) => ({ value: o.value, label: o.label, what: o.title })) }]}
      onPick={(v) => {
        const o = SORT.find((x) => x.value === v);
        if (o) setSetting("sort", o.value);
      }}
      title={`Grouped by ${current.label}: ${current.title} (s for the next)`}
      hint="s steps to the next one from anywhere on the page."
      trigger={
        <>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" />
          </svg>
          {current.label}
        </>
      }
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
      aria-label={attention === 0 ? "All quiet" : `${attention} need${attention === 1 ? "s" : ""} attention`}
      title="Only repos with changes, unpushed commits, or errors (d)"
      onClick={() => setDirtyOnly(!dirtyOnly)}
    >
      <span className={attention > 0 ? "dot lichen" : "dot moss"} />
      {attention === 0 ? (
        <>
          <span className="quiet-all">all </span>quiet
        </>
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
      className={scanning ? "icon-btn rescan busy" : "icon-btn rescan"}
      title={scanning ? "Scanning every folder for repos…" : "Rescan: walk every folder again for repos"}
      aria-label={scanning ? "scanning" : "rescan"}
      onClick={() => void doRescan()}
      disabled={scanning}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 11a8 8 0 1 0-2.3 5.7" />
        <path d="M20 4v7h-7" />
      </svg>
    </button>
  );
}

/** Shown once home comes back as another build than the one this page
 *  loaded against (a redeploy under an open tab): a reload brings the new
 *  page in, and shells keep running through it. */
function ReloadChip() {
  const now = useStore((s) => homeConn(s).about);
  const first = useStore((s) => s.aboutAtLoad);
  if (now === null || first === null || !buildMoved(first, now)) return null;
  return (
    <button
      type="button"
      className="mini reload-chip"
      title={`canopy ${versionLine(now)} is running; this page loaded against ${versionLine(first)}. Reload to take the new page; shells keep running.`}
      onClick={() => location.reload()}
    >
      <span className="chip-icon" aria-hidden="true">↻</span> new build
    </button>
  );
}

/** One chip per backend whose caller check is on and does not know this
 *  page. Pressing it asks the backend to let this page in; while that waits
 *  the chip shows the code to match where it is approved, and a box for the
 *  first sign-in code from the server's log, for when no page is signed in
 *  to approve it. */
function SignInChips() {
  const names = useStore(useShallow((s) => s.backendOrder.filter((n) => wantsSignIn(s.authByBackend[n]) || s.signIns[n]?.state === "waiting")));
  return (
    <>
      {names.map((n) => (
        <SignInChip key={n} backend={n} />
      ))}
    </>
  );
}

const OWN_CODE = "that is this request's code; the first code is a different one, printed in the server's log";

function SignInChip({ backend }: { backend: string }) {
  const signIn = useStore((s) => s.signIns[backend]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (signIn?.state === "waiting") {
    const own = isOwnCode(code, signIn.code);
    const send = () => {
      if (!code.trim() || own) return;
      setBusy(true);
      setErr(null);
      useStore
        .getState()
        .useFirstCode(backend, code)
        .then(() => setCode(""))
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    };
    return (
      <span className="signin-strip" role="status" aria-label={`Signing in to ${backend}`}>
        <span className="signin-hint">match</span>
        <span className="signin-code" title="The code this page's pair request shows: match it where the request is approved">
          {signIn.code}
        </span>
        <span className="signin-hint">in a signed-in page's inbox</span>
        <span className="signin-hint signin-or">or enter the first code from {backend}'s server log</span>
        <input
          className="signin-input"
          value={code}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          placeholder="first code"
          aria-label={`The first sign-in code from ${backend}'s server log`}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        {(own || err) && (
          <span className="signin-err" title={own ? OWN_CODE : (err ?? "")}>
            {own ? OWN_CODE : err}
          </span>
        )}
      </span>
    );
  }
  const failed = signIn?.state === "failed" ? signIn.why : null;
  return (
    <button
      type="button"
      className={failed ? "mini signin-chip failed" : "mini signin-chip"}
      title={
        failed
          ? `The last sign-in did not finish: ${failed}. Press to ask again`
          : `${backend} checks who calls it and does not know this page. Signing in asks it to let this page in; approve it from a signed-in page's inbox or with the first code from its log`
      }
      aria-label={`Sign in to ${backend}`}
      onClick={() => void useStore.getState().signIn(backend)}
    >
      sign in<span className="signin-to">{"\u00a0"}to {backend}</span>
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
      <span className="chip-icon thin" aria-hidden="true">{CLI_GLYPH}</span>
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
      <span className="chip-icon" aria-hidden="true">{WAITING_GLYPH}</span> {count || ""}
    </button>
  );
}

/** A run of controls that belong together. The bar draws a hairline between
 *  one run and the next on a row, and a run whose chips all have nothing to
 *  say takes no room. */
function Cluster({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <span className={className ? `tb-cluster ${className}` : "tb-cluster"} role="group" aria-label={label}>
      {children}
    </span>
  );
}

/** Whether the focus is somewhere text is typed. */
const typing = (el: Element | null): boolean =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);

/** The phone's tool rows fold away while the cards scroll down and come
 *  back on the way up (`nextTuck`), and never while the filter box has the
 *  focus or a menu in the bar is open. A tap leaves the focus on the button
 *  it pressed, so a button's focus does not hold them. Only `.main`'s
 *  scrolls count: the dock, the shells and the panels scroll on their own.
 *  `/` and `f` reach into the folded rows, so either key brings them back
 *  before the page's own handler looks for the box or the button. */
function useTuck(head: RefObject<HTMLElement | null>, fold: RefObject<HTMLElement | null>): [boolean, () => void] {
  const [tucked, setTucked] = useState(false);
  const state = useRef<Tuck>(TUCK_START);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains("main")) return;
      const bar = head.current;
      const focus = document.activeElement;
      const held = bar !== null && ((bar.contains(focus) && typing(focus)) || bar.querySelector(".settings-pop, .shells-pop") !== null);
      const t = held
        ? { tucked: false, anchor: el.scrollTop, hold: 0 }
        : nextTuck(state.current, {
            top: el.scrollTop,
            range: el.scrollHeight - el.clientHeight,
            room: fold.current?.scrollHeight ?? 0,
            now: performance.now(),
          });
      state.current = t;
      setTucked(t.tucked);
    };
    // the capture phase runs before App's keydown on the window, and
    // flushSync drops `inert` before that handler moves the focus
    const onKey = (e: KeyboardEvent) => {
      if (!state.current.tucked || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "/" || e.key === "f") && !typing(e.target instanceof Element ? e.target : null)) {
        state.current = { ...state.current, tucked: false };
        flushSync(() => setTucked(false));
      }
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [head, fold]);
  const show = useCallback(() => {
    state.current = { ...state.current, tucked: false };
    setTucked(false);
  }, []);
  return [tucked, show];
}

/** Marks a row that scrolls sideways with which of its ends hold more, so
 *  its fade shows only where there is something past the edge. */
function useScrollEdges(row: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const mark = () => {
      const { start, end } = scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
      el.toggleAttribute("data-more-start", start);
      el.toggleAttribute("data-more-end", end);
    };
    mark();
    el.addEventListener("scroll", mark, { passive: true });
    // the chips come and go, which changes the width with no scroll
    const seen = new ResizeObserver(mark);
    seen.observe(el);
    const kids = new MutationObserver(mark);
    kids.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", mark);
      seen.disconnect();
      kids.disconnect();
    };
  }, [row]);
}

/** The phone's bar: three short rows, the views and the few buttons a thumb
 *  reaches for first, then the filter box, then everything else in one row
 *  that scrolls sideways, faded at whichever end has more. The two lower
 *  rows fold away while the cards scroll down. */
function PhoneBar({ nav }: { nav?: ReactNode }) {
  const head = useRef<HTMLElement>(null);
  const fold = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [tucked, show] = useTuck(head, fold);
  useScrollEdges(scroller);
  return (
    <header ref={head} className={tucked ? "topbar phone tucked" : "topbar phone"} onFocus={show}>
      <div className="tb-line">
        <SideToggle />
        <Wordmark />
        {nav}
        <span className="spacer" />
        <SignInChips />
        <ReloadChip />
        {/* few enough that the views keep room to show: what waits on you
            and the tasks stay in reach with a repo open, when the rows
            under this one go (the tasks' chip brings a task to the front
            from anywhere); the rest ride in the row that scrolls */}
        <Cluster label="Waiting and tasks">
          <WaitingButton />
          <TasksChip />
        </Cluster>
        <Cluster label="This page">
          <BackendMenu />
          <SearchButton />
          <SettingsMenu />
        </Cluster>
      </div>
      <div className="tb-fold" inert={tucked}>
        <div ref={fold} className="tb-fold-in">
          <div className="tb-line tb-tools">
            <FilterBox />
            <AttentionPill />
            <FilterMenu />
          </div>
          <div ref={scroller} className="tb-line tb-tools tb-scroll">
            <Cluster label="Make">
              <NewProjectButton />
              <SelectPill />
            </Cluster>
            <Cluster label="Show">
              <SortMenu />
              <FeedButton />
              <CliButton />
            </Cluster>
            <Cluster label="Scanned folders">
              <SourcesMenu />
              <RescanButton />
            </Cluster>
            <WsMenu />
            <Cluster label="For you">
              <InboxChip />
              <ChanChip />
            </Cluster>
            <Cluster label="Running">
              <RunsPill />
              <ShellsChip />
              <KeptShells />
              <RangerChip compact />
            </Cluster>
            <Cluster label="Health">
              <HealthChip />
            </Cluster>
          </div>
        </div>
      </div>
    </header>
  );
}

/** The top bar: `nav` is the view switcher, which sits beside the name. A
 *  window wider than a phone gets two rows that stay two: the views, the
 *  scope, the finders and the makers above; the grouping and the filters,
 *  then the chips, below. The filter box takes the room the row has spare
 *  and gives it back first, and the words shorten as the window narrows
 *  (styles.css, "the top bar narrowing"); only a row that still cannot fit
 *  wraps. A phone gets `PhoneBar`. The chips come in runs: what wants you,
 *  what is running, and the backend itself, each chip absent when it has
 *  nothing to say. */
export function TopBar({ nav }: { nav?: ReactNode }) {
  const phone = useMedia(PHONE);
  const narrow = useMedia(NARROW);
  if (phone) return <PhoneBar nav={nav} />;

  return (
    <header className="topbar">
      <div className="tb-line tb-top">
        <SideToggle />
        <Wordmark version />
        {nav}
        <Cluster label="Scanned folders">
          <SourcesMenu />
          <RescanButton />
        </Cluster>
        <WsMenu />
        {/* the finders and the makers wrap as one, so a narrow bar never splits them */}
        <span className="topbar-group topbar-tail">
          <Cluster label="Find">
            <SearchButton />
            <CliButton />
            <FeedButton />
          </Cluster>
          <Cluster label="Make">
            <NewProjectButton />
            <SelectPill />
          </Cluster>
        </span>
      </div>

      <div className="tb-line tb-tools">
        <Cluster label="Show" className="tb-show">
          <SortMenu />
          <AttentionPill />
          <FilterMenu />
          <FilterBox />
        </Cluster>

        {/* the chips keep to the right end of whichever row they land on */}
        <span className="topbar-group topbar-tail">
          <SignInChips />
          <ReloadChip />
          <Cluster label="For you">
            <WaitingButton />
            <InboxChip />
            <ChanChip />
          </Cluster>
          <Cluster label="Running">
            <RunsPill />
            <ShellsChip />
            <KeptShells />
            <TasksChip />
            <RangerChip compact={narrow} />
          </Cluster>
          <Cluster label="This backend">
            <HealthChip />
            <BackendMenu />
          </Cluster>
          <Cluster label="Settings">
            <SettingsMenu />
          </Cluster>
        </span>
      </div>
    </header>
  );
}
