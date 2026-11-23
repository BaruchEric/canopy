import { HealthChip } from "./Health";
import { CapacityChip } from "./Capacity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { ownRun } from "../flows";
import { RUN_DOT, pillLine, pillRuns, pillText } from "../runs";
import { allRuns, attentionCount, capsFor, homeConn, pickedIds, useStore, waitingCount, wantsSignIn } from "../store";
import { WAITING_GLYPH, WAITING_PANEL } from "../waiting";
import { CLI_GLYPH } from "../cli";
import { NARROW, PHONE, useMedia } from "../media";
import { effectivePrimary, isRunActive, WS_COLORS, type RunAction, type Workspace } from "../../../src/core/types";
import { isHome } from "../registry";
import { openManager } from "../routes";
import { anchorWord } from "../goals";
import { baseName } from "../elsewhere";
import { primaryRefusal } from "../workspaces";
import { PAGE_BUILD } from "../build";
import { TUCK_START, nextTuck, rowOver, scrollEdges, type Tuck } from "../topbar";
import { buildMoved, versionLine } from "../../../src/core/version";
import { isOwnCode, lacks } from "../callerToken";
import { heldEverywhere } from "../scopeGate";
import { inviteCode } from "../../../src/core/people";
import { FilterMenu } from "./Filters";
import { PickMenu, type PickGroup, type PickOption } from "./PickMenu";
import { Gear, type GearEntry, type GearGroup } from "./Gear";
import { SettingsMenu } from "./Settings";
import { BackendMenu } from "./BackendMenu";
import { IdLabel } from "./IdLabel";
import { PeopleChip } from "./PeopleChip";
import { ChanChip } from "./Chan";
import { InboxChip } from "./Inbox";
import { NotesChip } from "./Notes";
import { ClipsChip } from "./Clipboard";
import { KeptShells } from "./KeptShells";
import { ShellsChip } from "./Shells";
import { RangerChip } from "./Ranger";
import { TasksChip } from "./Tasks";
import { VoiceButton } from "./Voice";
import { SourcesMenu } from "./Sources";
import { chipId, crowdedChips, speaking, type BarChipId } from "../quietbar";
import { BarMore } from "./BarMore";
import { useBarChips } from "./useBarChips";

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
  { value: "state", label: "state", title: "By what goes on at each repo: needs you, working, unread, idle, each newest change first" },
] as const;

/** Live runs across the grove. Absent when nothing is going. One run opens
 *  at a click. Several open a menu with a row each, the ones that need an
 *  answer first: a click that chose one for you left the rest out of reach. */
function RunsPill() {
  const runs = useStore(useShallow((s) => pillRuns(allRuns(s).filter((r) => isRunActive(r) && ownRun(s.flowRuns, r)))));
  // each run's repo by name, in the runs' order, a goal's as the goal: only
  // a name changing draws the pill again, not every scan
  const names = useStore(useShallow((s) => runs.map((r) => anchorWord(r.repoId) ?? s.repos.find((x) => x.id === r.repoId)?.name)));
  const showRun = useStore((s) => s.showRun);
  // read again as the menu opens: a chat between turns sits unchanged for
  // hours, so nothing else would move the ages
  const [now, setNow] = useState(() => Date.now());
  const [first] = runs;
  if (!first) return null;
  const waiting = runs.some((r) => r.status === "waiting");
  const face = (
    <>
      <span className={waiting ? "dot lichen" : "dot sky live"} />
      {pillText(runs)}
    </>
  );
  if (runs.length === 1) {
    return (
      <button type="button" className={waiting ? "pill runs on" : "pill runs"} title="Show the run" onClick={() => showRun(first.id)}>
        {face}
      </button>
    );
  }
  const options = runs.map(
    (r, i): PickOption => ({
      value: r.id,
      label: (
        <>
          <span className={RUN_DOT[r.status] ?? "dot sky live"} aria-hidden="true" />
          <span>
            <IdLabel id={r.repoId} name={names[i]} />
          </span>
        </>
      ),
      what: pillLine(r, now),
      title: r.note || undefined,
    }),
  );
  return (
    <PickMenu
      className="runs-pick"
      btnClass={waiting ? "runs on" : "runs"}
      hang="right"
      label="Live runs"
      value={null}
      groups={[{ options }]}
      onPick={showRun}
      onOpen={() => setNow(Date.now())}
      title={`${runs.length} runs going; pick the one to show`}
      trigger={face}
    />
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
 *  to approve it. The same box takes an invite (FR-074), which signs the
 *  page in as the person it was made for with nobody to approve it. */
export function SignInChips() {
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

/** One backend's sign-in: the button that asks, then the code to match and
 *  the box for the first code. Also the whole of the page's first screen
 *  when its own backend told it nothing until it signs in (App). */
export function SignInChip({ backend }: { backend: string }) {
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
      const invite = inviteCode(code);
      const st = useStore.getState();
      // an invite ends this strip when it is taken; why it was not shows in the page's note
      const sent = invite ? st.joinWith(invite, backend).then((ok) => (ok ? undefined : setCode(""))) : st.useFirstCode(backend, code).then(() => setCode(""));
      sent.catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
    };
    return (
      <span className="signin-strip" role="status" aria-label={`Signing in to ${backend}`}>
        <span className="signin-hint">match</span>
        <span className="signin-code" title="The code this page's pair request shows: match it where the request is approved">
          {signIn.code}
        </span>
        <span className="signin-hint">in a signed-in page's inbox</span>
        <span className="signin-hint signin-or">or enter an invite, or the first code from {backend}'s server log</span>
        <input
          className="signin-input"
          value={code}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          placeholder="invite or first code"
          aria-label={`An invite to ${backend}, or the first sign-in code from its server log`}
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

/** The manager's new box, focused, over the goals and projects going: a
 *  goal across the repos it names (FR-067), or a new project through the
 *  incubator, from one place. `n` does the same. */
function NewButton() {
  // the manager's goals and projects start runs and read every repo: a
  // viewer and a page held to its teams' folders start none (FR-074)
  const off = useStore((s) => lacks(s.authByBackend[s.home], "operate") || heldEverywhere(s.backendOrder, s.authByBackend));
  if (off) return null;
  return (
    <button
      type="button"
      className="mini new-btn"
      aria-keyshortcuts="n"
      title="Something new (n): a goal across repos you have, or a project from an idea, a link, a file, a voice memo or a repo"
      onClick={() => openManager(null, { new: true })}
    >
      + new
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

/** Whether the wide bar's first row has more than it can hold, measured off
 *  its items rather than read off the window's width: the views, the scope
 *  and a finger's larger buttons all change what the row needs. The split
 *  layout this turns on moves the items without resizing them, so the answer
 *  cannot flip back and forth. */
function useSplit(bar: RefObject<HTMLElement | null>): boolean {
  const [split, setSplit] = useState(false);
  useLayoutEffect(() => {
    const el = bar.current;
    const line = el?.querySelector<HTMLElement>(":scope > .tb-top");
    if (!el || !line) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
      const widths = Array.from(line.children, (c) => c.getBoundingClientRect().width);
      setSplit(rowOver(widths, gap, room));
    };
    const seen = new ResizeObserver(measure);
    // the row's items come and go (a workspace menu, a folder chip), and
    // each one's width moves with its words
    const watch = () => {
      seen.disconnect();
      seen.observe(el);
      for (const c of line.children) seen.observe(c);
      measure();
    };
    watch();
    const kids = new MutationObserver(watch);
    kids.observe(line, { childList: true });
    return () => {
      seen.disconnect();
      kids.disconnect();
    };
  }, [bar]);
  return split;
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
          <VoiceButton />
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
              <NewButton />
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
              <NotesChip />
              <ClipsChip />
              <ChanChip />
            </Cluster>
            <Cluster label="Running">
              <RunsPill />
              <ShellsChip />
              <KeptShells />
              <RangerChip compact />
            </Cluster>
            <Cluster label="Health">
              <PeopleChip />
              <CapacityChip />
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
 *  wraps. When it is the first row that cannot fit (a tablet held upright),
 *  the bar splits into three rows laid out on purpose: the views, then the
 *  filters with the finders and the makers, then the chips. A phone gets
 *  `PhoneBar`. The chips come in runs: what wants you, what is running, and
 *  the backend itself, each chip absent when it has nothing to say. */
export function TopBar({ nav }: { nav?: ReactNode }) {
  const phone = useMedia(PHONE);
  // the intermediate level's bar is the quiet one (FR-079); advanced keeps every chip out
  const quiet = useStore((s) => s.settings.level === "intermediate");
  if (quiet) return phone ? <QuietPhoneBar nav={nav} /> : <QuietWideBar nav={nav} />;
  return phone ? <PhoneBar nav={nav} /> : <WideBar nav={nav} />;
}

/** One chip of the quiet bar: on the bar while it has something to say, put
 *  away while it has not. Put away it is still mounted, so its shortcut, its
 *  popover and the bar's menu (`pressChip`) all reach it, and the stylesheet
 *  shows it for as long as its popover is open. */
function Tuck({ id, on, children }: { id: BarChipId; on: ReadonlySet<BarChipId>; children: ReactNode }) {
  return (
    <span className={on.has(id) ? "tb-tuck" : "tb-tuck quiet"} data-tuck={id}>
      {children}
    </span>
  );
}

/** A chip that is on the quiet bar only while its popover is open leaves the
 *  bar when the popover closes, and a popover that hands the focus back to
 *  its chip hands it to nothing: the next Tab would start at the top of the
 *  page. After a close by a key (Escape, or a pick with Enter) the focus goes
 *  to the bar's menu, where the chip was picked. A close by a click leaves
 *  the focus where the click put it. */
function useFocusBack(bar: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof MutationObserver !== "function") return;
    let byKey = false;
    const onKey = () => {
      byKey = true;
    };
    const onPoint = () => {
      byKey = false;
    };
    const watch = new MutationObserver((changes) => {
      if (!byKey) return;
      const shut = changes.some((c) => c.oldValue === "true" && c.target instanceof HTMLElement && c.target.getAttribute("aria-expanded") !== "true" && c.target.closest(".tb-tuck.quiet") !== null);
      if (!shut) return;
      // a frame later, once the popover has handed the focus back
      requestAnimationFrame(() => {
        const at = document.activeElement;
        const lost = at === null || at === document.body || (at instanceof HTMLElement && at.closest(".tb-tuck.quiet") !== null && at.getClientRects().length === 0);
        if (lost) el.querySelector<HTMLElement>(".bar-more-btn")?.focus();
      });
    });
    watch.observe(el, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"], attributeOldValue: true });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPoint, true);
    return () => {
      watch.disconnect();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPoint, true);
    };
  }, [bar]);
}

const NO_CHIPS: ReadonlySet<BarChipId> = new Set();
/** the gap a chip keeps from the one before it, as `.tb-cluster` sets it */
const CHIP_GAP = 4;

/** The speaking chips the wide quiet bar's row has no room for, so the bar
 *  stays one row whatever speaks (`crowdedChips`). Measured off the row, as
 *  `useSplit` measures the advanced bar: what the row holds besides the
 *  chips, with the filter box at its least, is what the chips cannot have.
 *  A chip's width is kept from the last time it was drawn, since one that is
 *  crowded out has no box to measure. The sum leaves out the chips and the
 *  gap before their run whether or not any shows, so the answer is the same
 *  before and after it is applied and cannot flip back and forth. */
function useCrowded(bar: RefObject<HTMLElement | null>, speaks: ReadonlySet<BarChipId>): ReadonlySet<BarChipId> {
  const [crowded, setCrowded] = useState<ReadonlySet<BarChipId>>(NO_CHIPS);
  const widths = useRef<Partial<Record<BarChipId, number>>>({});
  const said = useRef(speaks);
  said.current = speaks;
  const key = [...speaks].join(" ");
  useLayoutEffect(() => {
    const el = bar.current;
    const line = el?.querySelector<HTMLElement>(":scope > .tb-line");
    if (!el || !line) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
      const kids = Array.from(line.children, (c) => c.getBoundingClientRect().width).filter((w) => w > 0);
      const used = kids.reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1);
      const box = line.querySelector<HTMLElement>(".tb-show > .search");
      const give = box ? Math.max(0, box.getBoundingClientRect().width - (parseFloat(getComputedStyle(box).minWidth) || 0)) : 0;
      // the chips in the filter's run each add their width and a gap
      let chips = 0;
      for (const t of line.querySelectorAll<HTMLElement>(".tb-show > [data-tuck]")) {
        const id = chipId(t.dataset.tuck);
        const w = t.firstElementChild?.getBoundingClientRect().width ?? 0;
        if (id === null || w <= 0) continue;
        widths.current[id] = w;
        chips += w + CHIP_GAP;
      }
      // the run of their own: its whole width, and the group's gap before it
      const run = line.querySelector<HTMLElement>(".tb-now");
      const group = run?.parentElement;
      const before = group ? parseFloat(getComputedStyle(group).columnGap) || 0 : 0;
      const runWidth = run?.getBoundingClientRect().width ?? 0;
      if (run && runWidth > 0) {
        chips += runWidth + before;
        for (const t of run.querySelectorAll<HTMLElement>("[data-tuck]")) {
          const id = chipId(t.dataset.tuck);
          const w = t.firstElementChild?.getBoundingClientRect().width ?? 0;
          if (id !== null && w > 0) widths.current[id] = w;
        }
      }
      const room = line.clientWidth - (used - give - chips) - before;
      const next = crowdedChips(said.current, widths.current, room, CHIP_GAP);
      setCrowded((was) => (was.size === next.size && [...next].every((id) => was.has(id)) ? was : next));
    };
    const seen = new ResizeObserver(measure);
    // the row's items come and go, and each one's width moves with its words
    const watch = () => {
      seen.disconnect();
      seen.observe(el);
      for (const c of line.children) seen.observe(c);
      measure();
    };
    watch();
    const kids = new MutationObserver(watch);
    kids.observe(line, { childList: true });
    return () => {
      seen.disconnect();
      kids.disconnect();
    };
  }, [bar, key]);
  return crowded;
}

/** the chips a wide quiet bar shows in one run, in the advanced bar's order */
const NOW_WIDE: readonly BarChipId[] = ["sources", "rescan", "workspaces", "feed", "select", "waiting", "inbox", "notes", "clips", "chan", "runs", "shells", "kept", "tasks", "ranger", "capacity", "health", "backend"];
/** the same run on a phone, less what its first row keeps */
const NOW_PHONE: readonly BarChipId[] = ["sort", "sources", "rescan", "workspaces", "feed", "select", "inbox", "notes", "clips", "chan", "runs", "shells", "kept", "ranger", "capacity", "health"];

/** each chip the quiet bar may put away, as the advanced bar draws it */
function chipOf(id: BarChipId, compact: boolean): ReactNode {
  switch (id) {
    case "sort":
      return <SortMenu />;
    case "attention":
      return <AttentionPill />;
    case "filters":
      return <FilterMenu />;
    case "sources":
      return <SourcesMenu />;
    case "rescan":
      return <RescanButton />;
    case "workspaces":
      return <WsMenu />;
    case "feed":
      return <FeedButton />;
    case "select":
      return <SelectPill />;
    case "waiting":
      return <WaitingButton />;
    case "inbox":
      return <InboxChip />;
    case "notes":
      return <NotesChip />;
    case "clips":
      return <ClipsChip />;
    case "chan":
      return <ChanChip />;
    case "runs":
      return <RunsPill />;
    case "shells":
      return <ShellsChip />;
    case "kept":
      return <KeptShells />;
    case "tasks":
      return <TasksChip />;
    case "ranger":
      return <RangerChip compact={compact} />;
    case "capacity":
      return <CapacityChip />;
    case "health":
      return <HealthChip />;
    case "backend":
      return <BackendMenu />;
  }
}

/** A run of the quiet bar's chips, each in its `Tuck`; the run takes no room
 *  while none of them speaks. */
function Tucked({ label, ids, on, compact = false }: { label: string; ids: readonly BarChipId[]; on: ReadonlySet<BarChipId>; compact?: boolean }) {
  return (
    <Cluster label={label} className={ids.some((id) => on.has(id)) ? "tb-now" : "tb-now tb-none"}>
      {ids.map((id) => (
        <Tuck key={id} id={id} on={on}>
          {chipOf(id, compact)}
        </Tuck>
      ))}
    </Cluster>
  );
}

/** The quiet bar on anything wider than a phone (FR-079): one row. The
 *  views, the filter box, search, the command line, the mic, + new and
 *  settings stay; a chip sits between them only while it has something to
 *  say (`quietbar.ts`), and the menu before settings lists every chip with
 *  its state. The sign-in chips and the people chip hide themselves when
 *  they have nothing to say. A row with more speaking than it can hold wraps. */
function QuietWideBar({ nav }: { nav?: ReactNode }) {
  const narrow = useMedia(NARROW);
  const bar = useRef<HTMLElement>(null);
  const chips = useBarChips();
  const speaks = useMemo(() => speaking(chips), [chips]);
  const crowded = useCrowded(bar, speaks);
  useFocusBack(bar);
  // on the bar: what speaks, less what the row has no room for
  const on = useMemo(() => new Set([...speaks].filter((id) => !crowded.has(id))), [speaks, crowded]);
  return (
    <header ref={bar} className="topbar calm">
      <div className="tb-line tb-top">
        <SideToggle />
        <Wordmark version />
        {nav}
        <Cluster label="Show" className="tb-show">
          <Tuck id="sort" on={on}>
            <SortMenu />
          </Tuck>
          <Tuck id="attention" on={on}>
            <AttentionPill />
          </Tuck>
          <Tuck id="filters" on={on}>
            <FilterMenu />
          </Tuck>
          <FilterBox />
        </Cluster>
        <span className="topbar-group topbar-tail">
          <SignInChips />
          <ReloadChip />
          {/* who else is on, and "viewing" for a role that only reads
              (FR-074); it shows nothing on a canopy of one person */}
          <PeopleChip />
          <Tucked label="Right now" ids={NOW_WIDE} on={on} compact={narrow} />
          <Cluster label="Find and make">
            <SearchButton />
            <CliButton />
            <VoiceButton />
            <NewButton />
          </Cluster>
          <Cluster label="The rest">
            <BarMore chips={chips} crowded={crowded} />
            <SettingsMenu />
          </Cluster>
        </span>
      </div>
    </header>
  );
}

/** The quiet bar on a phone: two rows where the advanced bar has three. The
 *  first keeps the views and the few buttons a thumb reaches for, with what
 *  waits on you, the tasks and the backend's light only while they speak;
 *  the second is the filter box, the chips that speak, + new and the
 *  command line, which scroll sideways when they outgrow it, and the menu,
 *  which holds its place at the row's end. It folds away with the cards as
 *  the advanced bar's lower rows do. */
function QuietPhoneBar({ nav }: { nav?: ReactNode }) {
  const head = useRef<HTMLElement>(null);
  const fold = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [tucked, show] = useTuck(head, fold);
  useScrollEdges(scroller);
  useFocusBack(head);
  const chips = useBarChips();
  const on = useMemo(() => speaking(chips), [chips]);
  return (
    <header ref={head} className={tucked ? "topbar phone calm tucked" : "topbar phone calm"} onFocus={show}>
      <div className="tb-line">
        <SideToggle />
        <Wordmark />
        {nav}
        <span className="spacer" />
        <SignInChips />
        <ReloadChip />
        <Tucked label="Waiting and tasks" ids={["waiting", "tasks"]} on={on} />
        <Cluster label="This page">
          <Tuck id="backend" on={on}>
            <BackendMenu />
          </Tuck>
          <SearchButton />
          <VoiceButton />
          <SettingsMenu />
        </Cluster>
      </div>
      <div className="tb-fold" inert={tucked}>
        <div ref={fold} className="tb-fold-in">
          {/* the menu holds its place at the row's end while the rest scrolls */}
          <div className="tb-line tb-tools tb-pinned">
            <div ref={scroller} className="tb-line tb-tools tb-scroll">
              <FilterBox />
              <Tuck id="attention" on={on}>
                <AttentionPill />
              </Tuck>
              <Tuck id="filters" on={on}>
                <FilterMenu />
              </Tuck>
              <Tucked label="Right now" ids={NOW_PHONE} on={on} compact />
              <PeopleChip />
              <Cluster label="Make">
                <NewButton />
                <CliButton />
              </Cluster>
            </div>
            <BarMore chips={chips} />
          </div>
        </div>
      </div>
    </header>
  );
}

function WideBar({ nav }: { nav?: ReactNode }) {
  const narrow = useMedia(NARROW);
  const bar = useRef<HTMLElement>(null);
  const split = useSplit(bar);

  return (
    <header ref={bar} className={split ? "topbar split" : "topbar"}>
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
            <VoiceButton />
          </Cluster>
          <Cluster label="Make">
            <NewButton />
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
            <NotesChip />
            <ClipsChip />
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
            <PeopleChip />
            <CapacityChip />
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
