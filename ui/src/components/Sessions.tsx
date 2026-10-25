import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { HARNESSES, type AgentCard } from "../../../src/core/types";
import { agentName } from "../allagents";
import { joinTarget, machineOf, stateWord } from "../agentcards";
import { healthBadge } from "../badges";
import { NARROW, useMedia } from "../media";
import { backendOf, qual } from "../registry";
import { agentRows, heldShellAt, machinesOf, newTabKey, nextWaitingRow, pickRepos, sessionsKey, showingIn, splitKey, stepTab, tabsIn, untabbed, type Machine, type RepoTone, type TabKind, type TabScope } from "../sessions";
import { boxesOf, groupOf, hasPane, headOf, leaveGroup, neighbourOf, paneIds, rowOf, setAt, splitIn, type Box, type Edge, type PaneTree } from "../splitpanes";
import { connOf, idText, useStore } from "../store";
import { isItemTab, isPageTab, isPageTabId, itemTabsAt, pageTabLabel, sectionTabsAt, tabbableKeys, type PageTab } from "../sectiontabs";
import { OVER_PAGE } from "../surface";
import { LABEL_MAX, viewKey, type TermTab } from "../term";
import { AgentScreen, QuickAnswer, useAllAgents, useShellProbe } from "./AgentFocus";
import { useIsChat } from "./Registry";
import { PaneHead, Seams, SectionPaneHead, TabMenu, boxStyle, moveTo, openedSince, takes, termIds, usePaneDrag, useSplits } from "./SessionPanes";
import { PageTabView } from "./SectionTab";
import { ShellSpotHere } from "./Surface";
import { SweepButton } from "./Sweep";
import { TermTabs, TermView } from "./TermDock";
import { SignInChips } from "./TopBar";

/** whether a key went to something that types: a field or a shell */
const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".xterm") !== null);

const TONE_DOT: Record<RepoTone, string> = { waiting: "rust", working: "moss live", live: "moss", dirty: "lichen", quiet: "hollow" };

const STATE_DOT: Record<AgentCard["state"], string> = { waiting: "rust", working: "moss live", idle: "moss", lost: "faint", ended: "faint" };

/** the textarea of the shell showing (the focused pane of a split tab),
 *  once the layout has settled; never taken from a field typed in
 *  meanwhile, such as a rename the second press of a double-click opened */
const refocus = (box: Element | null) =>
  requestAnimationFrame(() => {
    const at = document.activeElement;
    if (at instanceof HTMLInputElement) return;
    (box?.querySelector<HTMLElement>(".ss-pane.on .term-view:not([hidden]) textarea") ?? box?.querySelector<HTMLElement>(".term-view:not([hidden]) textarea"))?.focus();
  });

/**
 * The sessions view: every shell and agent in one screen, laid out like a
 * terminal multiplexer. The machines tree and the agents list down the left,
 * the strip's shells as tabs across the top, the one showing under them with
 * the keyboard. The strip at the foot of the page stays away while this view
 * is up, since both would join the same shells.
 */
/** the strip, as the place a card's tab moves to (FR-031) */
const STRIP = { place: "strip" as const };

export function SessionsView({ onView }: { onView: (view: string) => void }) {
  useShellProbe();
  const cards = useAllAgents();
  const terms = useStore((s) => s.terms);
  const activeTerm = useStore((s) => s.activeTerm);
  const showTerm = useStore((s) => s.showTerm);
  const openTerm = useStore((s) => s.openTerm);
  const joinTerm = useStore((s) => s.joinTerm);
  const closeTerm = useStore((s) => s.closeTerm);
  const swapTerms = useStore((s) => s.swapTerms);
  const renameTerm = useStore((s) => s.renameTerm);
  const repos = useStore((s) => s.repos);
  const shells = useStore((s) => s.shells);
  const home = useStore((s) => s.home);
  const shown = useStore(useShallow((s) => s.backendOrder));
  const warn = useStore(useShallow((s) => healthBadge(s.health)));
  const narrow = useMedia(NARROW);
  const [drawer, setDrawer] = useState(false);
  // what the main pane shows in place of a tab, until a tab is picked
  // again: an agent whose shell is not one of the tabs, or a panel shell
  // the backend holds, joined
  const [picked, setPicked] = useState<{ agent: string } | { shell: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const main = useRef<HTMLDivElement>(null);
  const newBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const strip = useMemo(() => terms.filter((t) => t.place === "strip"), [terms]);
  // the tab row shows what the left column picked: a repo, a machine, or all
  const [scope, setScope] = useState<TabScope>(() => {
    const t = strip.find((x) => x.id === activeTerm);
    return t ? { repo: t.repoId } : null;
  });
  const visible = useMemo(() => tabsIn(strip, scope, backendOf), [strip, scope]);
  // the cards' sections, chats and popups sitting as tabs in the strip
  // (FR-030), after the
  // shells; the one showing stands in for activeTerm until a shell is picked
  const allSectionTabs = useStore((s) => s.settings.sectionTabs);
  const stripPage = useStore((s) => s.stripPage);
  const showStripPage = useStore((s) => s.showStripPage);
  const tabSection = useStore((s) => s.tabSection);
  const tabItem = useStore((s) => s.tabItem);
  const untab = useStore((s) => s.untab);
  const order = useStore((s) => s.settings.sectionOrder);
  const hiddenSections = useStore((s) => s.settings.sectionsHidden);
  const allItemTabs = useStore((s) => s.settings.itemTabs);
  const pagesAll = useMemo<PageTab[]>(() => [...sectionTabsAt(allSectionTabs, "strip"), ...itemTabsAt(allItemTabs, "strip")], [allSectionTabs, allItemTabs]);
  // a chat or a popup with no repo shows whatever the scope
  const pages = useMemo(() => pagesAll.filter((t) => !t.repoId || tabsIn([{ repoId: t.repoId }], scope, backendOf).length > 0), [pagesAll, scope]);
  const current = stripPage && pagesAll.some((t) => t.id === stripPage) ? stripPage : activeTerm;
  const show = (id: string) => (isPageTabId(id) ? showStripPage(id) : showTerm(id));
  const repoName = (repoId: string) => repos.find((r) => r.id === repoId)?.name ?? idText(repoId);
  const held = useMemo(() => tabsIn(untabbed(shells, strip), scope, backendOf), [shells, strip, scope]);
  // Split tabs (FR-026): the saved groups, with the tabs since closed taken
  // out. The row shows a group as one tab, and a group any of whose panes
  // is in scope brings the rest along.
  const { groups, write: writeSplits } = useSplits("strip");
  const reachIds = useMemo(() => {
    const ids = new Set([...visible, ...pages].map((t) => t.id));
    for (const g of groups) {
      const ps = paneIds(g);
      if (ps.some((id) => ids.has(id))) for (const id of ps) ids.add(id);
    }
    return ids;
  }, [visible, pages, groups]);
  const reach = useMemo(() => strip.filter((t) => reachIds.has(t.id)), [strip, reachIds]);
  const reachPages = useMemo(() => pagesAll.filter((t) => reachIds.has(t.id)), [pagesAll, reachIds]);
  const { row, panes } = useMemo(() => rowOf<TermTab | PageTab>([...visible, ...pages], groups), [visible, pages, groups]);
  const termRow = useMemo(() => row.filter((t): t is TermTab => !isPageTab(t)), [row]);
  const pageRow = useMemo(() => row.filter(isPageTab), [row]);
  const showing = current === activeTerm ? (reach.find((t) => t.id === activeTerm) ?? null) : null;
  // a seam's tree while it is dragged, and a pane on its way elsewhere
  const [draft, setDraft] = useState<PaneTree | null>(null);
  // the pane last focused in each split tab, by each of its panes, so going
  // back to the tab lands where you were
  const lastIn = useRef(new Map<string, string>());
  const [menu, setMenu] = useState<{ id: string; at: DOMRect } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // the repo the new-tab box is open for, and what the last new tab ran
  const [newTab, setNewTab] = useState<string | null>(null);
  const [kind, setKind] = useState<TabKind>("shell");
  const chat = useIsChat();
  const rows = useMemo(() => agentRows(cards, chat), [cards, chat]);
  const pickedCard = picked && "agent" in picked ? cards.find((c) => c.id === picked.agent) : undefined;
  const pickedInfo = picked && "shell" in picked ? shells.find((t) => t.id === picked.shell) : undefined;
  const pickedRepo = pickedInfo ? repos.find((r) => r.id === pickedInfo.repoId) : undefined;
  const pickedShell = useMemo<TermTab | null>(
    () => (pickedInfo && pickedRepo ? { id: pickedInfo.id, repoId: pickedRepo.id, name: pickedRepo.name, path: pickedRepo.path, place: pickedInfo.place, joinOnly: true } : null),
    [pickedInfo, pickedRepo],
  );
  const overTabs = pickedCard !== undefined || pickedShell !== null;
  // the agent showing: the one picked, or the one in the tab showing
  const currentAgent = pickedCard?.id ?? (overTabs || !showing ? null : (rows.find((c) => joinTarget(c, shown, qual) === showing.id)?.id ?? null));
  const pageShowing = current === activeTerm ? undefined : reachPages.find((t) => t.id === current);
  const currentRepo = pickedShell ? pickedShell.repoId : overTabs ? null : (showing?.repoId ?? pageShowing?.repoId ?? (scope && "repo" in scope ? scope.repo : null));

  // a scope that leaves the showing tab out shows its last tab instead
  useEffect(() => {
    const want = showingIn([...reach, ...reachPages], current);
    if (want && want !== current) show(want);
  }, [reach, reachPages, current]);
  const group = !overTabs && current ? groupOf(groups, current) : undefined;
  useEffect(() => {
    if (!group || !current) return;
    for (const id of paneIds(group)) lastIn.current.set(id, current);
  }, [group, current]);
  // a phone shows the focused pane alone
  const tree = narrow || !group ? null : (draft && hasPane(draft, current ?? "") ? draft : group);
  const boxes = useMemo(() => (tree ? boxesOf(tree) : null), [tree]);
  // the panes a drag can land on: a split tab's, or the one tab showing
  const targets = useMemo<Record<string, Box>>(
    () => boxes ?? (current && !overTabs && reachIds.has(current) ? { [current]: { x: 0, y: 0, w: 1, h: 1 } } : {}),
    [boxes, current, overTabs, reachIds],
  );
  const machines = useMemo(
    () => machinesOf({ home, shown, repos, shells, tabs: strip, cards, backendOf }, currentRepo ? [currentRepo] : []),
    [home, shown, repos, shells, strip, cards, currentRepo],
  );

  const showTab = (id: string) => {
    // a press on the tab already showing leaves focus alone, so the second
    // press of a double-click (rename) does not hand it to the shell
    const moved = id !== current || overTabs;
    setPicked(null);
    show(id);
    setDrawer(false);
    if (moved) refocus(main.current);
  };
  // a tab in the row: a split one goes back to the pane last focused in it,
  // or stays on the one focused now
  const showRowTab = (id: string) => {
    const g = groupOf(groups, id);
    if (!g) return showTab(id);
    if (!overTabs && current && hasPane(g, current)) return showTab(current);
    const last = lastIn.current.get(id);
    showTab(last && hasPane(g, last) ? last : id);
  };
  // put the shell opened since `before` beside `id`
  const besideNew = (id: string, before: ReadonlySet<string>, edge: Edge) => {
    const made = openedSince(before);
    if (made && made !== id) writeSplits((g) => splitIn(g, id, made, edge));
  };
  // a new shell at the same repo, beside `id`; a popup has no repo to open one at
  const splitFrom = (id: string, edge: Edge) => {
    const tab = strip.find((t) => t.id === id) ?? pagesAll.find((t) => t.id === id);
    if (!tab?.repoId) return;
    const before = termIds();
    setPicked(null);
    openTerm(tab.repoId, "strip");
    besideNew(id, before, edge);
  };
  // a pane's ×: the shell ends, as the tab's × ends it (a section goes
  // back to its card), and the focus goes to the pane beside it
  const closePane = (id: string) => {
    const g = groupOf(groups, id);
    const next = g && id === current ? neighbourOf(g, id) : null;
    if (next) showTab(next);
    writeSplits((gs) => leaveGroup(gs, id));
    if (isPageTabId(id)) untab(id);
    else closeTerm(id);
  };
  const { drag, grab, preview } = usePaneDrag(
    main,
    targets,
    (id, target, edge) => {
      writeSplits((g) => splitIn(g, target, id, edge));
      showTab(id);
    },
    {
      accepts: (id) => takes(id, STRIP),
      drop: (id, target, edge) => {
        setPicked(null);
        void moveTo(id, STRIP, target, edge);
      },
    },
  );
  // a tab's menu moves it to its card's shells, when the card takes it
  const cardOf = (id: string) => {
    const repoId = strip.find((t) => t.id === id)?.repoId ?? pagesAll.find((t) => t.id === id)?.repoId;
    const card = repoId ? { place: "panel" as const, repoId } : null;
    return card && takes(id, card) ? { label: "to its card's shells", run: (x: string) => void moveTo(x, card) } : undefined;
  };
  const openRepo = (repoId: string) => {
    setDrawer(false);
    setScope({ repo: repoId });
    const last = strip.filter((t) => t.repoId === repoId).at(-1);
    if (last) return showTab(last.id);
    // a shell already running there comes up before a new one is started
    const held = heldShellAt(repoId, shells, strip);
    if (held?.place === "strip") {
      setPicked(null);
      joinTerm(held.id);
      refocus(main.current);
    } else if (held) setPicked({ shell: held.id });
    else {
      setPicked(null);
      openTerm(repoId, "strip");
    }
  };
  const pickAgent = (c: AgentCard) => {
    // an agent in one of the tabs' shells is that tab
    const target = joinTarget(c, shown, qual);
    const own = target ? strip.find((t) => t.id === target) : undefined;
    if (own) {
      if (!visible.includes(own)) setScope({ repo: own.repoId });
      showTab(own.id);
    }
    else {
      setPicked({ agent: c.id });
      setDrawer(false);
    }
  };
  const newShell = () => {
    if (currentRepo) setNewTab(currentRepo);
    else {
      if (narrow) setDrawer(true);
      requestAnimationFrame(() => newBox.current?.focus());
    }
  };

  // read inside the key handler, which is set up once
  const head = overTabs ? null : headOf(row, groups, current);
  const live = useRef({ row, head, current, rows, currentAgent, showRowTab, pickAgent, newShell, splitFrom });
  live.current = { row, head, current, rows, currentAgent, showRowTab, pickAgent, newShell, splitFrom };
  const startTab = (repoId: string, name: string, run: TabKind) => {
    setNewTab(null);
    setKind(run);
    setPicked(null);
    if (scope && !tabsIn([{ repoId }], scope, backendOf).length) setScope({ repo: repoId });
    if (run === "shell") openTerm(repoId, "strip", undefined, undefined, undefined, name);
    else openTerm(repoId, "strip", "agent", undefined, { harness: run }, name);
    refocus(main.current);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(OVER_PAGE)) return;
      const k = sessionsKey(e, typing(e.target));
      if (!k) return;
      const l = live.current;
      e.preventDefault();
      if (k === "next-tab" || k === "prev-tab") {
        const id = stepTab(l.row, l.head, k === "next-tab" ? 1 : -1);
        if (id) l.showRowTab(id);
      } else if (k === "new") l.newShell();
      else {
        const id = nextWaitingRow(l.rows, l.currentAgent);
        const c = id ? l.rows.find((r) => r.id === id) : undefined;
        if (c) l.pickAgent(c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The split keys work from inside a shell, so they are read on the way
  // down, before xterm sees them (Ctrl+Shift+D would reach the shell as
  // Ctrl+D and end it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const edge = splitKey(e);
      if (!edge || document.querySelector(OVER_PAGE)) return;
      const l = live.current;
      if (!l.head || !l.current) return;
      e.preventDefault();
      e.stopPropagation();
      l.splitFrom(l.current, edge);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const side = (
    <aside className={`ss-side${narrow ? " drawer" : ""}`} aria-label="Machines and agents">
      <Machines machines={machines} scope={scope} tabs={strip.length} onRepo={openRepo} onScope={setScope} />
      <NewShell box={newBox} home={home} onRepo={openRepo} />
      <section className="ss-agents" aria-label="Agents">
        <header className="ss-head">
          <span>agents</span>
          <span className="ss-faint">priority</span>
        </header>
        {rows.length === 0 && <p className="ss-empty">no agents running</p>}
        <ul className="ss-list">
          {rows.map((c) => (
            <li key={c.id}>
              <button type="button" className={`ss-agent${c.id === currentAgent ? " on" : ""}`} title={stateWord(c)} onClick={() => pickAgent(c)}>
                <span className={`dot ${STATE_DOT[c.state]}`} aria-hidden="true" />
                <span className="ss-lines">
                  <span className="ss-line">
                    <span className="ss-faint">{machineOf(c)}</span>
                    {" · "}
                    <span className="ss-name">{agentName(c)}</span>
                    {" · "}
                    <span className="ss-faint">{c.state === "waiting" ? (c.waiting ?? "waiting") : c.state}</span>
                  </span>
                  <span className="ss-sub">{[c.harness, c.model].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
              {c.state === "waiting" && (
                <div className="ss-answer">
                  <QuickAnswer card={c} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );

  return (
    <ShellSpotHere.Provider value="full">
      <div className={`sessions${narrow ? " narrow" : ""}${drag ? " ss-dragging" : ""}`}>
        {narrow && drawer && <div className="drawer-back" aria-hidden="true" onClick={() => setDrawer(false)} />}
        {(!narrow || drawer) && side}
        <section className="ss-main" aria-label="Sessions">
          <TermTabs
            terms={termRow}
            pages={pageRow}
            pageLabel={(t) => pageTabLabel(t, isItemTab(t) ? undefined : repoName(t.repoId))}
            active={head}
            onShow={showRowTab}
            panes={panes}
            focus={overTabs ? null : showing}
            onGrab={narrow ? undefined : grab}
            caption=""
            lead={<ScopeChip scope={scope} names={repos} onClear={() => setScope(null)} />}
            onMenu={(id, at, rename) => (rename ? setRenaming(id) : setMenu({ id, at }))}
            renaming={renaming}
            onRenamed={(id, label) => {
              setRenaming(null);
              if (label !== null) renameTerm(id, label);
              refocus(main.current);
            }}
            extra={
              <>
                {narrow && (
                  <button type="button" className="mini ss-menu" aria-label="Machines and agents" title="machines and agents" onClick={() => setDrawer(!drawer)}>
                    ☰
                  </button>
                )}
                {pickedCard && (
                  <span className="term-tab on ss-picked" title="the agent picked from the list">
                    <span className={`dot ${STATE_DOT[pickedCard.state]}`} aria-hidden="true" />
                    {agentName(pickedCard)}
                    <button
                      type="button"
                      className="mini ss-keep"
                      title="Keep this agent as a tab here, beside the shells, to split and come back to"
                      onClick={() => {
                        tabItem("strip", { kind: "agent", ref: pickedCard.id, label: agentName(pickedCard) });
                        setPicked(null);
                      }}
                    >
                      keep as a tab
                    </button>
                  </span>
                )}
                {pickedShell && (
                  <span className="term-tab on ss-picked" title="a shell held in a repo's panel, joined here">
                    <span className="dot moss" aria-hidden="true" />
                    {pickedShell.name} (panel)
                  </span>
                )}
                {held.map((t) => {
                  const name = t.label ?? repos.find((r) => r.id === t.repoId)?.name ?? t.repoId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className="term-tab ss-held"
                      title={`A shell at ${name} running with no tab here${t.viewers.length > 0 ? ` (open on ${t.viewers.join(", ")})` : ""}. Press to bring it back`}
                      onClick={() => {
                        setPicked(null);
                        joinTerm(t.id);
                        refocus(main.current);
                      }}
                    >
                      <span className="dot hollow" aria-hidden="true" />
                      {name}
                    </button>
                  );
                })}
                {showing && !overTabs && (
                  <button
                    type="button"
                    className="mini ss-plus"
                    aria-label="Tab actions"
                    title="rename, move, hide or close this tab (or right-click a tab)"
                    onClick={(e) => setMenu({ id: showing.id, at: e.currentTarget.getBoundingClientRect() })}
                  >
                    ⋯
                  </button>
                )}
                <button type="button" className="mini ss-plus" aria-label="New tab" title="new tab (n)" onClick={newShell}>
                  +
                </button>
              </>
            }
          />
          <div className="term-body" ref={main}>
            {/* Every strip shell stays a keyed child here, split or not, and
                a split only places it, since a moved xterm would remount and
                rejoin its shell. */}
            {strip.map((t) => {
              const box = boxes?.[t.id];
              const inView = !overTabs && (boxes ? box !== undefined : t.id === current);
              const on = inView && t.id === current;
              return (
                <div
                  key={viewKey(t)}
                  className={`ss-pane${on ? " on" : ""}${box ? " split" : ""}`}
                  hidden={!inView}
                  style={box ? boxStyle(box) : undefined}
                  onPointerDownCapture={() => {
                    if (inView && t.id !== current) showTerm(t.id);
                  }}
                >
                  {inView && (
                    <PaneHead
                      tab={t}
                      label={t.label ?? t.name}
                      focused={on}
                      grouped={box !== undefined}
                      onGrab={(e) => grab(t.id, e)}
                      onSplit={() => splitFrom(t.id, "right")}
                      onClose={() => closePane(t.id)}
                      onMenu={(at) => setMenu({ id: t.id, at })}
                      onHandedOff={(before) => besideNew(t.id, before, "right")}
                    />
                  )}
                  <div className="ss-pane-body">
                    <TermView tab={t} active={inView} quiet={!on} />
                  </div>
                </div>
              );
            })}
            {reachPages.map((t) => {
              const box = boxes?.[t.id];
              const inView = !overTabs && (boxes ? box !== undefined : t.id === current);
              const on = inView && t.id === current;
              return (
                <div
                  key={t.id}
                  className={`ss-pane sec-pane${on ? " on" : ""}${box ? " split" : ""}`}
                  hidden={!inView}
                  style={box ? boxStyle(box) : undefined}
                  onPointerDownCapture={() => {
                    if (inView && t.id !== current) showStripPage(t.id);
                  }}
                >
                  {inView && (
                    <SectionPaneHead
                      label={pageTabLabel(t, isItemTab(t) ? undefined : repoName(t.repoId))}
                      item={isItemTab(t)}
                      grouped={box !== undefined}
                      canSplit={t.repoId !== undefined}
                      onGrab={(e) => grab(t.id, e)}
                      onSplit={() => splitFrom(t.id, "right")}
                      onClose={() => closePane(t.id)}
                      onMenu={(at) => setMenu({ id: t.id, at })}
                    />
                  )}
                  <div className="ss-pane-body sec-pane-body">
                    <PageTabView tab={t} />
                  </div>
                </div>
              );
            })}
            {tree && group && (
              <Seams
                tree={tree}
                body={() => main.current}
                onDraft={setDraft}
                onCommit={(path, at) => {
                  const id = paneIds(group)[0];
                  if (id) writeSplits((gs) => gs.map((g) => (hasPane(g, id) ? setAt(g, path, at) : g)));
                }}
              />
            )}
            {preview}
            {pickedShell && <TermView key={pickedShell.id} tab={pickedShell} active />}
            {pickedCard && (
              <div className="ss-agent-pane">
                <AgentScreen card={pickedCard} live active showing now={now} />
              </div>
            )}
            {newTab && (
              <NewTab
                repo={repos.find((r) => r.id === newTab)}
                kind={kind}
                onOpen={(name, run) => startTab(newTab, name, run)}
                onCancel={() => {
                  setNewTab(null);
                  refocus(main.current);
                }}
              />
            )}
            {!overTabs && visible.length === 0 && pages.length === 0 && (
              <div className="ss-blank">
                <p>{scope ? `No shells open at ${scopeName(scope, repos)}.` : "No shells open."}</p>
                <p className="ss-faint">{scope && "repo" in scope ? "Press + or n to open one." : "Pick a repo on the left, or press n and type its name."}</p>
              </div>
            )}
          </div>
          <footer className="ss-status">
            <span className="ss-keys">
              <span className="ss-faint">[ ] tabs · n new tab · w next waiting · double-click a tab to rename · ^⇧D split right · ⌥⇧D split down · drag a tab onto a pane</span>
              <SignInChips />
            </span>
            <SweepButton className="ss-sweep" />
            {warn && (
              <button type="button" className={`ss-warn t-${warn.tone}`} title={warn.title} onClick={() => onView("health")}>
                ⚠ {warn.text} {warn.text === "1" ? "warning" : "warnings"}
              </button>
            )}
          </footer>
        </section>
      </div>
      {menu && (
        <TabMenu
          id={menu.id}
          at={menu.at}
          tabs={reach}
          inRow={row.some((t) => t.id === menu.id)}
          grouped={groupOf(groups, menu.id) !== undefined}
          onClose={() => setMenu(null)}
          onRename={(id) => setRenaming(id)}
          onNew={setNewTab}
          onMove={(id, by) => {
            const i = visible.findIndex((t) => t.id === id);
            const other = visible[i + by];
            if (other) swapTerms(id, other.id);
          }}
          onSplit={(id, edge) => {
            if (id !== current) showTab(id);
            splitFrom(id, edge);
          }}
          onLeave={(id) => writeSplits((gs) => leaveGroup(gs, id))}
          pages={reachPages}
          onUntab={closePane}
          sectionsFor={(repoId) => {
            const repo = repos.find((r) => r.id === repoId);
            return repo ? tabbableKeys(allSectionTabs, repo, order, hiddenSections) : [];
          }}
          onAddSection={(repoId, k) => tabSection(repoId, k, "strip")}
          moveOut={cardOf(menu.id)}
        />
      )}
    </ShellSpotHere.Provider>
  );
}

/** what a scope is called: the repo's name or the machine's */
function scopeName(scope: Exclude<TabScope, null>, repos: readonly { id: string; name: string }[]): string {
  return "repo" in scope ? (repos.find((r) => r.id === scope.repo)?.name ?? scope.repo) : scope.machine;
}

/** The tab row's first word: the repo or machine its tabs are filtered to,
 *  with an × back to every tab, or "all". */
function ScopeChip({ scope, names, onClear }: { scope: TabScope; names: readonly { id: string; name: string }[]; onClear: () => void }) {
  if (!scope) return <span className="ss-scope ss-faint">all</span>;
  const name = scopeName(scope, names);
  return (
    <button type="button" className="ss-scope" title={`Showing the tabs at ${name}; press for every tab`} onClick={onClear}>
      {name} <span aria-hidden="true">×</span>
    </button>
  );
}

const KINDS: readonly TabKind[] = ["shell", ...HARNESSES];

/** The new-tab box over the main pane: a name for the tab (the repo's when
 *  left blank) and what it runs, a plain shell or an agent. Enter opens it,
 *  Escape cancels, Ctrl+C clears the name. A harness the repo's machine
 *  lacks is greyed out. */
function NewTab({ repo, kind, onOpen, onCancel }: { repo: { id: string; name: string } | undefined; kind: TabKind; onOpen: (name: string, run: TabKind) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const have = useStore((s) => (repo ? connOf(s, backendOf(repo.id)).backend.harnesses : undefined));
  const usable = (k: TabKind) => k === "shell" || !have || have.includes(k);
  const [run, setRun] = useState<TabKind>(usable(kind) ? kind : "shell");
  const field = useRef<HTMLInputElement>(null);
  // read by the listener below, set up once
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    field.current?.focus();
    const inBox = (t: EventTarget | null) => t instanceof Node && field.current?.closest(".ss-newtab")?.contains(t) === true;
    // Escape from anywhere in the box, not only the name field; a press
    // outside it cancels too
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && inBox(e.target)) {
        e.preventDefault();
        cancel.current();
      }
    };
    const down = (e: PointerEvent) => {
      if (!inBox(e.target)) cancel.current();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
    };
  }, []);
  if (!repo) return null;
  return (
    <div className="ss-newtab" role="dialog" aria-modal="true" aria-label={`New tab at ${repo.name}`}>
      <label className="ss-newtab-name">
        <span className="ss-faint">new tab at {repo.name}</span>
        <input
          ref={field}
          value={name}
          maxLength={LABEL_MAX}
          placeholder={repo.name}
          aria-label="Tab name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            const k = newTabKey(e.nativeEvent);
            if (!k) return;
            e.preventDefault();
            if (k === "open") onOpen(name, run);
            else if (k === "clear") setName("");
          }}
        />
      </label>
      <div className="ss-newtab-runs" role="radiogroup" aria-label="What the tab runs">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={run === k}
            className={run === k ? "on" : ""}
            disabled={!usable(k)}
            title={usable(k) ? (k === "shell" ? "a plain shell" : `a shell with ${k} started in it`) : `${k} is not installed on this machine`}
            onClick={() => {
              setRun(k);
              field.current?.focus();
            }}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="ss-newtab-keys">
        <button type="button" className="on" onClick={() => onOpen(name, run)}>
          ↵ open
        </button>
        <button type="button" onClick={() => setName("")}>
          ^c clear
        </button>
        <button type="button" onClick={onCancel}>
          esc cancel
        </button>
      </div>
    </div>
  );
}

/** The machines tree: each backend and the repos worth a row on it, a dot
 *  for the most pressing thing there and the branch under the name. Picking
 *  "machines", a machine or a repo filters the tab row to it. */
function Machines({
  machines,
  scope,
  tabs,
  onRepo,
  onScope,
}: {
  machines: Machine[];
  scope: TabScope;
  tabs: number;
  onRepo: (id: string) => void;
  onScope: (scope: TabScope) => void;
}) {
  const [folded, setFolded] = useState<string[]>([]);
  const conns = useStore((s) => s.conns);
  return (
    <section className="ss-machines" aria-label="Machines">
      <header className="ss-head">
        <button type="button" className={`ss-all${scope ? "" : " on"}`} title="Show every tab" onClick={() => onScope(null)}>
          machines
        </button>
        <span className="ss-faint">
          {tabs} {tabs === 1 ? "tab" : "tabs"}
        </span>
      </header>
      {machines.map((m) => {
        const closed = folded.includes(m.name);
        const state = conns[m.name]?.status.state ?? "connecting";
        return (
          <div key={m.name} className="ss-machine">
            <div className={`ss-mhead${scope && "machine" in scope && scope.machine === m.name ? " on" : ""}`}>
              <button
                type="button"
                className="ss-fold"
                aria-expanded={!closed}
                aria-label={`${closed ? "Unfold" : "Fold"} ${m.name}`}
                onClick={() => setFolded(closed ? folded.filter((n) => n !== m.name) : [...folded, m.name])}
              >
                {closed ? "▸" : "▾"}
              </button>
              <button type="button" className="ss-mname" title={`${m.name}: ${state}. Show this machine's tabs`} onClick={() => onScope({ machine: m.name })}>
                <span className="ss-name">{m.home ? `${m.name} (here)` : m.name}</span>
                <span className={`dot ${state === "online" ? TONE_DOT[m.tone] : "faint"}`} aria-hidden="true" />
              </button>
            </div>
            {!closed && (
              <ul className="ss-list">
                {m.repos.length === 0 && <li className="ss-empty">{state === "online" ? "no shells or agents" : state}</li>}
                {m.repos.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={`ss-repo${scope && "repo" in scope && scope.repo === r.id ? " on" : ""}`}
                      title={`${r.shells} ${r.shells === 1 ? "shell" : "shells"}, ${r.agents} ${r.agents === 1 ? "agent" : "agents"}`}
                      onClick={() => onRepo(r.id)}
                    >
                      <span className={`dot ${TONE_DOT[r.tone]}`} aria-hidden="true" />
                      <span className="ss-lines">
                        <span className="ss-name">{r.name}</span>
                        {r.branch && <span className="ss-sub">{r.branch}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** "new · <machine>": a repo name typed here opens a shell there, the first
 *  match on Enter. Searches every machine on the page. */
function NewShell({ box, home, onRepo }: { box: React.RefObject<HTMLInputElement | null>; home: string; onRepo: (id: string) => void }) {
  const repos = useStore((s) => s.repos);
  const [q, setQ] = useState("");
  const hits = useMemo(() => pickRepos(repos, q), [repos, q]);
  const open = (id: string) => {
    setQ("");
    box.current?.blur();
    onRepo(id);
  };
  return (
    <div className="ss-new">
      <label className="ss-new-row">
        <span className="ss-faint">new ·</span>
        <input
          ref={box}
          className="ss-new-input"
          value={q}
          placeholder={`a repo on ${home} or any machine`}
          aria-label="New shell at a repo"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) open(hits[0].id);
            else if (e.key === "Escape") {
              setQ("");
              box.current?.blur();
            }
          }}
        />
      </label>
      {hits.length > 0 && (
        <ul className="ss-list ss-hits">
          {hits.map((r) => (
            <li key={r.id}>
              <button type="button" className="ss-repo" onClick={() => open(r.id)}>
                <span className="ss-name">{r.name}</span>
                <span className="ss-faint">{backendOf(r.id)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
