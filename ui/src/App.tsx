import { HealthView } from "./components/Health";
import { CostsView } from "./components/Costs";
import { KitView } from "./components/Kit";
import { SecretsView } from "./components/Secrets";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Library } from "./components/Library";
import { AgentsView } from "./components/AgentsView";
import { SessionsView } from "./components/Sessions";
import { IncubatorView } from "./components/Incubator";
import { Wordmark } from "./components/TopBar";
import { Dock } from "./components/Dock";
import { FeedDock } from "./components/Feed";
import { RepoGrid } from "./components/RepoGrid";
import { Resizer } from "./components/Resizer";
import { RunSheet } from "./components/RunSheet";
import { TriggersView } from "./components/Triggers";
import { triggersBadge } from "./triggers";
import { SelectBar } from "./components/SelectBar";
import { Sidebar } from "./components/Sidebar";
import { AgentSolo } from "./components/AgentSolo";
import { RunSolo } from "./components/RunSolo";
import { SectionSolo, Solo } from "./components/Solo";
import { ShellSolo, TermDock } from "./components/TermDock";
import { Crowns, TopBar } from "./components/TopBar";
import { NARROW, PHONE, useMedia } from "./media";
import { PANES_CHANNEL, listenPanes, parsePaneMsg, type PaneMsg } from "./panes";
import { OVER_PAGE } from "./surface";
import { CHORD_MS, chordView, pressOf, shortcutFor } from "./shortcuts";
import { runPanel } from "./itempanel";
import { dropAskHere, parseRoute } from "./routes";
import { SORT_MODES, type Theme } from "./settings";
import { SIDEBAR, attentionCount, dockless, useStore, type CanopyState } from "./store";
import { useShallow } from "zustand/react/shallow";
import { agentsBadge, gitBadge, healthBadge, incubatorBadge, type Badge, type BadgeTone } from "./badges";
import { PickMenu, type PickGroup } from "./components/PickMenu";
import { WAITING_PANEL } from "./waiting";
import { bindNavigate } from "./clirun";
import { CommandPop } from "./components/CommandLine";
import { DictationFloat } from "./components/Dictate";

const route = parseRoute(window.location.search);

interface ViewDef {
  key: string;
  label: string;
  /** what the view is for, the line under its name in the menu */
  what: string;
}

const GIT_VIEW: ViewDef = { key: "git", label: "git", what: "Every repo, live" };

/** The views in the menus they sit under: the repos and what serves them,
 *  the agents and what starts them, and the machines underneath. */
const VIEW_GROUPS: { label: string; views: ViewDef[] }[] = [
  {
    label: "repos",
    views: [
      GIT_VIEW,
      { key: "library", label: "library", what: "Tags, notes, links and dev servers" },
      { key: "ports", label: "ports", what: "What is listening, and the dev servers" },
    ],
  },
  {
    label: "agents",
    views: [
      { key: "sessions", label: "sessions", what: "Every shell and agent on every machine, in one screen" },
      { key: "agents", label: "agents", what: "Which harness starts for what, per repo and role" },
      { key: "incubator", label: "incubator", what: "New projects from an idea, clarified and researched before anything is built" },
      { key: "triggers", label: "triggers", what: "Sentry issues and labeled Linear issues that start work on a branch with nobody typing, and what became of each" },
      { key: "kit", label: "kit", what: "The skills every agent has on every machine" },
    ],
  },
  {
    label: "system",
    views: [
      { key: "health", label: "health", what: "What is broken on each backend, and what canopy is fixing" },
      { key: "costs", label: "costs", what: "What Claude, Codex, voice and dictation cost, by service, repo and run" },
      { key: "secrets", label: "secrets", what: "Names, sinks and imports; values only behind a passkey on the mini's page" },
    ],
  },
];

const VIEWS: ViewDef[] = VIEW_GROUPS.flatMap((g) => g.views);

/** the views that are not the git cockpit: their own bar, no board keys */
const OTHER_VIEWS = ["library", "ports", "sessions", "agents", "incubator", "health", "costs", "triggers", "kit", "secrets"];

/** A view tab's live count, or null where its view has nothing waiting. */
function badgeOf(s: CanopyState, key: string): Badge | null {
  switch (key) {
    case "git":
      return gitBadge(attentionCount(s));
    case "agents":
      return s.registryReady ? agentsBadge(Object.values(s.registry)) : null;
    case "health":
      return healthBadge(s.health);
    case "incubator":
      return incubatorBadge(Object.values(s.sprouts));
    case "triggers":
      return triggersBadge(s.triggers);
    default:
      return null;
  }
}

function ViewBadge({ k }: { k: string }) {
  const b = useStore(useShallow((s) => badgeOf(s, k)));
  if (!b) return null;
  return (
    <span className={`view-badge t-${b.tone}`} title={b.title}>
      {b.text}
    </span>
  );
}

/** The most pressing tone among the views other than `view` that carry a
 *  count: rust before lichen before sky. A string, so the selector settles. */
function elsewhereTone(s: CanopyState, view: string): BadgeTone | null {
  let worst: BadgeTone | null = null;
  for (const { key } of VIEWS) {
    if (key === view) continue;
    const t = badgeOf(s, key)?.tone;
    if (t && (worst === null || TONE_RANK[t] > TONE_RANK[worst])) worst = t;
  }
  return worst;
}

const TONE_RANK: Record<BadgeTone, number> = { sky: 0, lichen: 1, rust: 2 };

/** The views as one word, the one showing, with its count; the menu lists
 *  every view under its group, each with its count and what it is for. A
 *  dot after the word says another view has something to show. */
function ViewMenu({ view, navigate }: { view: string; navigate: (next: string) => void }) {
  const current = VIEWS.find((v) => v.key === view) ?? GIT_VIEW;
  const elsewhere = useStore((s) => elsewhereTone(s, view));
  const groups: PickGroup[] = VIEW_GROUPS.map((g) => ({
    label: g.label,
    options: g.views.map((v) => ({
      value: v.key,
      label: (
        <>
          {v.label}
          <ViewBadge k={v.key} />
        </>
      ),
      what: v.what,
    })),
  }));
  return (
    <PickMenu
      className="view-pick"
      label="Canopy views"
      value={current.key}
      groups={groups}
      onPick={navigate}
      title={`${current.label}: ${current.what}. Every view is in this menu`}
      trigger={
        <>
          {current.label}
          <ViewBadge k={current.key} />
          {elsewhere && <span className={`dot view-elsewhere t-${elsewhere}`} aria-label="another view has something to show" />}
        </>
      }
    />
  );
}

/** The phone's status bar in the palette's own bark: each theme-color meta
 *  in index.html takes `--bark1` as its media's scheme paints it, or as the
 *  scheme the setting forces does. A probe with its own color-scheme is
 *  what makes `light-dark()` resolve to the side asked for. */
function paintThemeColor(theme: Theme) {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.color = "var(--bark1)";
  document.body.appendChild(probe);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    probe.style.colorScheme = theme !== "system" ? theme : meta.media.includes("dark") ? "dark" : "light";
    meta.content = getComputedStyle(probe).color;
  }
  probe.remove();
}

export function App() {
  const [view, setView] = useState(() => new URLSearchParams(location.search).get("view") || "git");
  const [project, setProject] = useState(() => new URLSearchParams(location.search).get("project"));
  const navigate = useCallback((next: string) => {
    const url = new URL(location.href);
    if (next === "git") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    url.searchParams.delete("project");
    history.pushState(null, "", url);
    setView(next);
    setProject(null);
  }, []);
  useEffect(() => bindNavigate(navigate), [navigate]);
  const showRepo = useCallback((id: string) => {
    navigate("git");
    useStore.getState().openPanel(id);
    void useStore.getState().rescan();
  }, [navigate]);
  useEffect(() => {
    const pop = () => {
      const query = new URLSearchParams(location.search);
      setView(query.get("view") || "git");
      setProject(query.get("project"));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const init = useStore((s) => s.init);
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const setDirtyOnly = useStore((s) => s.setDirtyOnly);
  const setSetting = useStore((s) => s.setSetting);
  const theme = useStore((s) => s.settings.theme);
  const palette = useStore((s) => s.settings.palette);
  const moreContrast = useStore((s) => s.settings.moreContrast);
  const density = useStore((s) => s.settings.density);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const setDrawer = useStore((s) => s.setDrawer);
  const narrow = useMedia(NARROW);
  // the carousel gives the dock the cards' room; a phone's dock covers them
  // already and stays as it was
  const phone = useMedia(PHONE);
  const carousel = useStore((s) => s.settings.dockCarousel && s.panels.length > 0) && !phone;
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

  // Theme, palette, contrast and density live on <html> so the solo view
  // and the popover get them too. "system" removes the attribute and lets
  // color-scheme decide. Before paint, so a saved palette never flashes
  // forest first.
  useLayoutEffect(() => {
    const el = document.documentElement;
    if (theme === "system") delete el.dataset["theme"];
    else el.dataset["theme"] = theme;
    el.dataset["palette"] = palette;
    if (moreContrast) el.dataset["contrast"] = "more";
    else delete el.dataset["contrast"];
    el.dataset["density"] = density;
    paintThemeColor(theme);
  }, [theme, palette, moreContrast, density]);

  // `?view=agents&ask=<id>`, the link an away DM carries: the inbox opens on
  // that ask once the page is up, and the link leaves the URL so a reload
  // does not open it again.
  useEffect(() => {
    if (!loaded || !route.ask) return;
    useStore.getState().openInbox(`ask:${route.ask}`);
    dropAskHere();
  }, [loaded]);

  // Pop out and back, the main window's side (listenPanes)
  useEffect(() => {
    if (dockless() || typeof BroadcastChannel === "undefined") return;
    const s = () => useStore.getState();
    const ch = new BroadcastChannel(PANES_CHANNEL);
    const line = {
      listen: (hear: (data: unknown) => void) => (ch.onmessage = (e: MessageEvent) => hear(e.data)),
      postMessage: (m: PaneMsg) => ch.postMessage(m),
      close: () => ch.close(),
    };
    return listenPanes(line, {
      popped: () => s().popped,
      heardHello: (id) => s().heardHello(id),
      returnPanel: (id) => s().returnPanel(id),
      forgetPopped: (id) => s().forgetPopped(id),
    });
  }, []);

  // Pop out and back, the pop-out's side: only a solo window opened with
  // popped=1 joins, so a plain solo tab never takes a panel from the dock.
  // It says hello from its first render, before the grove has loaded, so a
  // reload's hello lands inside the dock's wait on its bye. A chat's
  // window speaks under its panel's id (FR-047).
  useEffect(() => {
    const id = route.run ? runPanel(route.run) : route.repo;
    if (!route.popped || !id || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(PANES_CHANNEL);
    const hello: PaneMsg = { type: "hello", id };
    ch.onmessage = (e: MessageEvent) => {
      if (parsePaneMsg(e.data)?.type === "who") ch.postMessage(hello);
    };
    ch.postMessage(hello);
    const bye = () => ch.postMessage({ type: "bye", id } satisfies PaneMsg);
    // a page brought back from the back-forward cache is showing again
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) ch.postMessage(hello);
    };
    window.addEventListener("pagehide", bye);
    window.addEventListener("pageshow", shown);
    return () => {
      window.removeEventListener("pagehide", bye);
      window.removeEventListener("pageshow", shown);
      ch.close();
    };
  }, []);

  // Anyone pointing or typing anywhere on the page is here: the broker
  // hears it (at most once a minute), so an agent's ask waits for them in
  // canopy rather than half an hour for someone who is gone.
  useEffect(() => {
    const here = () => useStore.getState().pagePresence();
    window.addEventListener("pointerdown", here, true);
    window.addEventListener("keydown", here, true);
    return () => {
      window.removeEventListener("pointerdown", here, true);
      window.removeEventListener("keydown", here, true);
    };
  }, []);

  // A `?repo=` link pins that repo once the tree is in. Only once: a rescan
  // that drops the repo should not bring the panel back.
  useEffect(() => {
    if (!loaded || route.solo || route.shell || route.section || !route.repo || pinned.current) return;
    pinned.current = true;
    if (useStore.getState().repos.some((r) => r.id === route.repo)) {
      openPanel(route.repo);
    }
  }, [loaded, openPanel]);

  // when `g` was pressed, while it waits for the letter of its view
  const goAt = useRef(0);
  useEffect(() => {
    // Every key reads the one table the ? sheet lists (shortcuts.ts), so
    // the sheet cannot drift from what the keys do.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const box = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      const press = pressOf(e);
      // g then a letter: the letter is the chord's, whatever it does alone
      if (goAt.current) {
        const armed = Date.now() - goAt.current < CHORD_MS;
        goAt.current = 0;
        if (armed && !box && press) {
          e.preventDefault();
          const next = chordView(press);
          if (next) navigate(next);
          return;
        }
      }
      const sc = press === null ? null : shortcutFor(press, view);
      if (!sc || (box && !sc.anywhere)) return;
      // a window holding one panel, one shell or one chat has no prompt
      const whole = !route.run && !(route.repo && (route.solo || route.shell || route.section));
      const st = useStore.getState();
      const over = !!document.querySelector(OVER_PAGE);
      switch (sc.action) {
        case "find":
          e.preventDefault();
          st.openSearch();
          return;
        case "command":
          // ⌘K toggles it from a box or a shell too, like the find chord; `:` opens it, as an editor's does
          if (!whole) return;
          if (sc.anywhere) {
            e.preventDefault();
            st.setCliOpen(!st.cliOpen);
          } else if (!over) {
            e.preventDefault();
            st.setCliOpen(true);
          }
          return;
        case "help":
          if (st.sheet || over) return;
          e.preventDefault();
          st.openKeys(view);
          return;
        case "go":
          if (st.sheet || over) return;
          e.preventDefault();
          goAt.current = Date.now();
          return;
        case "new":
          // ⌘N is the browser's new window, which a page cannot take
          if (st.sproutsReady && !st.sheet && !over) {
            e.preventDefault();
            st.openNewSprout();
          }
          return;
        case "escape":
          // the drawer is the top layer while it is out
          if (st.drawerOpen && !over) {
            // taken, so a surface under the drawer stays: this listener may run
            // before the surface's, which then finds the drawer already gone
            e.preventDefault();
            st.setDrawer(false);
            return;
          }
          // A sheet, a menu or a popover owns Escape while it is up, and a
          // surface over the page or its panel takes it first
          if (st.selecting && !st.sheet && !over && !document.querySelector(".surface-focus, .surface-full, .section-full")) st.setSelecting(false);
          return;
        case "select-all":
          // a select box owns ⌘A
          if (st.selecting && !st.sheet && !over && t.tagName !== "SELECT") {
            e.preventDefault();
            st.pickAll();
          }
          return;
        case "filter":
          e.preventDefault();
          document.getElementById("filter-input")?.focus();
          return;
        case "filters":
          document.getElementById("filters-btn")?.click();
          return;
        case "tree":
          if (narrow) st.setDrawer(!st.drawerOpen);
          else toggleSidebar();
          return;
        case "feed":
          st.toggleFeed();
          return;
        case "waiting":
          // opens "waiting on you", or brings it forward; never closes it
          st.openPanel(WAITING_PANEL);
          return;
        case "dirty":
          setDirtyOnly(!st.dirtyOnly);
          return;
        case "favorites":
          st.setFavoritesOnly(!st.favoritesOnly);
          return;
        case "select":
          st.setSelecting(!st.selecting);
          return;
        case "sort": {
          const cur = st.settings.sort;
          const next = SORT_MODES[(SORT_MODES.indexOf(cur) + 1) % SORT_MODES.length];
          if (next) setSetting("sort", next);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDirtyOnly, setSetting, toggleSidebar, view, narrow, navigate]);

  // a window grown past the narrow width has the tree beside the cards again
  useEffect(() => {
    if (!narrow && useStore.getState().drawerOpen) setDrawer(false);
  }, [narrow, setDrawer]);

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
  // a window of one thing keeps the mic that follows focus
  const solo = route.agent ? (
    <AgentSolo card={route.agent.card} follow={route.agent.follow} />
  ) : route.run ? (
    <RunSolo id={route.run} popped={route.popped} />
  ) : route.solo && route.repo ? (
    <Solo id={route.repo} />
  ) : route.shell && route.repo ? (
    <ShellSolo id={route.repo} />
  ) : route.section && route.repo ? (
    <SectionSolo id={route.repo} section={route.section} />
  ) : null;
  if (solo)
    return (
      <>
        {solo}
        <DictationFloat />
      </>
    );
  const nav = <ViewMenu view={view} navigate={navigate} />;
  return (
    <div className="app">
      {OTHER_VIEWS.includes(view) ? <>
      <header className="app-nav">
        <Wordmark />
        {nav}
      </header>
      {view === "sessions" ? (
        <SessionsView onView={navigate} />
      ) : view === "agents" ? (
        <AgentsView onGit={() => navigate("git")} />
      ) : view === "incubator" ? (
        <IncubatorView onGit={() => navigate("git")} />
      ) : view === "health" ? (
        <HealthView />
      ) : view === "costs" ? (
        <CostsView />
      ) : view === "triggers" ? (
        <TriggersView />
      ) : view === "kit" ? (
        <KitView />
      ) : view === "secrets" ? (
        <SecretsView />
      ) : (
        <Library ports={view === "ports"} project={project} onRepo={showRepo} onPorts={() => navigate("ports")} />
      )}
      </> : <>
      <TopBar nav={nav} />
      <div
        className={`body${sidebarOpen ? "" : " no-side"}${carousel ? " carousel" : ""}`}
        style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
      >
        {narrow && drawerOpen && (
          <>
            <div className="drawer-back" aria-hidden="true" onClick={() => setDrawer(false)} />
            <Sidebar drawer />
          </>
        )}
        {!narrow && sidebarOpen && (
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
      <SelectBar />
      </>}
      <FeedDock />
      {view !== "sessions" && <TermDock />}
      <RunSheet />
      <CommandPop />
      <DictationFloat />
    </div>
  );
}
