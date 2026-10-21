import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentCard } from "../../../src/core/types";
import { agentName } from "../allagents";
import { joinTarget, machineOf, stateWord } from "../agentcards";
import { healthBadge } from "../badges";
import { NARROW, useMedia } from "../media";
import { backendOf, qual } from "../registry";
import { agentRows, heldShellAt, machinesOf, nextWaitingRow, pickRepos, sessionsKey, showingIn, stepTab, tabsIn, untabbed, type Machine, type RepoTone, type TabScope } from "../sessions";
import { useStore } from "../store";
import { OVER_PAGE } from "../surface";
import { viewKey, type TermTab } from "../term";
import { AgentScreen, QuickAnswer, useAllAgents, useShellProbe } from "./AgentFocus";
import { ShellSpotHere } from "./Surface";
import { TermTabs, TermView } from "./TermDock";
import { SignInChips } from "./TopBar";

/** whether a key went to something that types: a field or a shell */
const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".xterm") !== null);

const TONE_DOT: Record<RepoTone, string> = { waiting: "rust", working: "moss live", live: "moss", dirty: "lichen", quiet: "hollow" };

const STATE_DOT: Record<AgentCard["state"], string> = { waiting: "rust", working: "moss live", idle: "moss", lost: "faint", ended: "faint" };

/** the textarea of the shell showing, once the layout has settled */
const refocus = (box: Element | null) =>
  requestAnimationFrame(() => box?.querySelector<HTMLElement>(".term-view:not([hidden]) textarea")?.focus());

/**
 * The sessions view: every shell and agent in one screen, laid out like a
 * terminal multiplexer. The machines tree and the agents list down the left,
 * the strip's shells as tabs across the top, the one showing under them with
 * the keyboard. The strip at the foot of the page stays away while this view
 * is up, since both would join the same shells.
 */
export function SessionsView({ onView }: { onView: (view: string) => void }) {
  useShellProbe();
  const cards = useAllAgents();
  const terms = useStore((s) => s.terms);
  const activeTerm = useStore((s) => s.activeTerm);
  const showTerm = useStore((s) => s.showTerm);
  const openTerm = useStore((s) => s.openTerm);
  const joinTerm = useStore((s) => s.joinTerm);
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
  const held = useMemo(() => tabsIn(untabbed(shells, strip), scope, backendOf), [shells, strip, scope]);
  const showing = visible.find((t) => t.id === activeTerm) ?? null;
  const [menu, setMenu] = useState<{ id: string; at: DOMRect } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rows = useMemo(() => agentRows(cards), [cards]);
  const pickedCard = picked && "agent" in picked ? cards.find((c) => c.id === picked.agent) : undefined;
  const pickedInfo = picked && "shell" in picked ? shells.find((t) => t.id === picked.shell) : undefined;
  const pickedRepo = pickedInfo ? repos.find((r) => r.id === pickedInfo.repoId) : undefined;
  const pickedShell = useMemo<TermTab | null>(
    () => (pickedInfo && pickedRepo ? { id: pickedInfo.id, repoId: pickedRepo.id, name: pickedRepo.name, path: pickedRepo.path, place: pickedInfo.place, joinOnly: true } : null),
    [pickedInfo, pickedRepo],
  );
  const overTabs = pickedCard !== undefined || pickedShell !== null;
  // the agent showing: the one picked, or the one in the tab showing
  const currentAgent = pickedCard?.id ?? (overTabs || !activeTerm ? null : (rows.find((c) => joinTarget(c, shown, qual) === activeTerm)?.id ?? null));
  const currentRepo = pickedShell ? pickedShell.repoId : overTabs ? null : (showing?.repoId ?? (scope && "repo" in scope ? scope.repo : null));

  // a scope that leaves the showing tab out shows its last tab instead
  useEffect(() => {
    const want = showingIn(visible, activeTerm);
    if (want && want !== activeTerm) showTerm(want);
  }, [visible, activeTerm, showTerm]);
  const machines = useMemo(
    () => machinesOf({ home, shown, repos, shells, tabs: strip, cards, backendOf }, currentRepo ? [currentRepo] : []),
    [home, shown, repos, shells, strip, cards, currentRepo],
  );

  const showTab = (id: string) => {
    // a press on the tab already showing leaves focus alone, so the second
    // press of a double-click (rename) does not hand it to the shell
    const moved = id !== activeTerm || overTabs;
    setPicked(null);
    showTerm(id);
    setDrawer(false);
    if (moved) refocus(main.current);
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
    if (currentRepo) openTerm(currentRepo, "strip");
    else {
      if (narrow) setDrawer(true);
      requestAnimationFrame(() => newBox.current?.focus());
    }
  };

  // read inside the key handler, which is set up once
  const live = useRef({ visible, activeTerm, rows, overTabs, currentAgent, showTab, pickAgent, newShell });
  live.current = { visible, activeTerm, rows, overTabs, currentAgent, showTab, pickAgent, newShell };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(OVER_PAGE)) return;
      const k = sessionsKey(e, typing(e.target));
      if (!k) return;
      const l = live.current;
      e.preventDefault();
      if (k === "next-tab" || k === "prev-tab") {
        const id = stepTab(l.visible, l.overTabs ? null : l.activeTerm, k === "next-tab" ? 1 : -1);
        if (id) l.showTab(id);
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
      <div className={`sessions${narrow ? " narrow" : ""}`}>
        {narrow && drawer && <div className="drawer-back" aria-hidden="true" onClick={() => setDrawer(false)} />}
        {(!narrow || drawer) && side}
        <section className="ss-main" aria-label="Sessions">
          <TermTabs
            terms={visible}
            active={overTabs ? null : activeTerm}
            onShow={showTab}
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
                  </span>
                )}
                {pickedShell && (
                  <span className="term-tab on ss-picked" title="a shell held in a repo's panel, joined here">
                    <span className="dot moss" aria-hidden="true" />
                    {pickedShell.name} (panel)
                  </span>
                )}
                {held.map((t) => {
                  const name = repos.find((r) => r.id === t.repoId)?.name ?? t.repoId;
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
                <button type="button" className="mini ss-plus" aria-label="New shell" title="new shell (n)" onClick={newShell}>
                  +
                </button>
              </>
            }
          />
          <div className="term-body" ref={main}>
            {strip.map((t) => (
              <TermView key={viewKey(t)} tab={t} active={!overTabs && t.id === activeTerm} />
            ))}
            {pickedShell && <TermView key={pickedShell.id} tab={pickedShell} active />}
            {pickedCard && (
              <div className="ss-agent-pane">
                <AgentScreen card={pickedCard} live active showing now={now} />
              </div>
            )}
            {!overTabs && visible.length === 0 && (
              <div className="ss-blank">
                <p>{scope ? `No shells open at ${scopeName(scope, repos)}.` : "No shells open."}</p>
                <p className="ss-faint">{scope && "repo" in scope ? "Press + or n to open one." : "Pick a repo on the left, or press n and type its name."}</p>
              </div>
            )}
          </div>
          <footer className="ss-status">
            <span className="ss-keys">
              <span className="ss-faint">[ ] tabs · n new shell · w next waiting · double-click a tab to rename</span>
              <SignInChips />
            </span>
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
          tabs={visible}
          onClose={() => setMenu(null)}
          onRename={(id) => setRenaming(id)}
          onMove={(id, by) => {
            const i = visible.findIndex((t) => t.id === id);
            const other = visible[i + by];
            if (other) swapTerms(id, other.id);
          }}
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

/** A tab's menu: rename, a new shell beside it, move it along the row,
 *  hide it (the shell runs on) or close it (the shell ends). */
function TabMenu({
  id,
  at,
  tabs,
  onClose,
  onRename,
  onMove,
}: {
  id: string;
  at: DOMRect;
  tabs: readonly TermTab[];
  onClose: () => void;
  onRename: (id: string) => void;
  onMove: (id: string, by: 1 | -1) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // read by the listeners below, set up once
  const close = useRef(onClose);
  close.current = onClose;
  const openTerm = useStore((s) => s.openTerm);
  const hideTerm = useStore((s) => s.hideTerm);
  const closeTerm = useStore((s) => s.closeTerm);
  const tab = tabs.find((t) => t.id === id);
  const i = tabs.findIndex((t) => t.id === id);
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !box.current?.contains(e.target)) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  if (!tab) return null;
  const act = (f: () => void) => () => {
    onClose();
    f();
  };
  const left = Math.max(8, Math.min(at.left, window.innerWidth - 200));
  return (
    <div ref={box} className="ss-tabmenu" role="menu" aria-label={`The tab at ${tab.label ?? tab.name}`} style={{ top: at.bottom + 2, left }}>
      <button type="button" role="menuitem" onClick={act(() => onRename(id))}>
        rename <span className="ss-faint">F2</span>
      </button>
      <button type="button" role="menuitem" onClick={act(() => openTerm(tab.repoId, "strip"))}>
        new shell at {tab.name}
      </button>
      <button type="button" role="menuitem" disabled={i <= 0} onClick={act(() => onMove(id, -1))}>
        move left
      </button>
      <button type="button" role="menuitem" disabled={i < 0 || i >= tabs.length - 1} onClick={act(() => onMove(id, 1))}>
        move right
      </button>
      <button type="button" role="menuitem" title="Takes the tab away here and leaves the shell running" onClick={act(() => hideTerm(id))}>
        hide, keep running
      </button>
      <button type="button" role="menuitem" className="t-rust" title="Ends the shell on every device" onClick={act(() => closeTerm(id))}>
        close and end the shell
      </button>
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
