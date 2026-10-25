import { useEffect, useState } from "react";
import { useStore } from "../store";
import { isItemTab, isPopupName, type ItemTab, type PageTab, type SectionTab } from "../sectiontabs";
import { AgentScreen, useAllAgents } from "./AgentFocus";
import { PanelSection } from "./Dock";
import { PopupTabView } from "./PopupTab";
import { Console } from "./RunSheet";
import { SectionWindow } from "./Surface";

/**
 * A card's section shown in a shell window's tab or pane (FR-030). It sits
 * as it does in a window of its own: always open, its gear with no place in
 * a panel to offer, the panel's own styles around it.
 */
export function SectionTabView({ tab }: { tab: SectionTab }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === tab.repoId));
  if (!repo) return <p className="panel-clean sec-tab-gone">That repo is not here now.</p>;
  if (repo.error) return <p className="panel-error">Could not read this repo: {repo.error}</p>;
  return (
    <SectionWindow.Provider value={true}>
      <div className="panel sec-tab-panel">
        <div className="panel-body">
          <PanelSection k={tab.key} repo={repo} />
        </div>
      </div>
    </SectionWindow.Provider>
  );
}

/** Whatever a page tab holds: a section, a run (an agent's chat or a
 *  coordinator, as the run sheet shows it), an agent session as the board
 *  shows it, or one of the top bar's popups. */
export function PageTabView({ tab }: { tab: PageTab }) {
  if (!isItemTab(tab)) return <SectionTabView tab={tab} />;
  switch (tab.kind) {
    case "run":
      return <RunTabView tab={tab} />;
    case "agent":
      return <AgentTabView tab={tab} />;
    case "popup":
      return isPopupName(tab.ref) ? <PopupTabView name={tab.ref} /> : null;
  }
}

/** a run as the run sheet has it, its ✕ closing the tab */
function RunTabView({ tab }: { tab: ItemTab }) {
  const run = useStore((s) => s.runs[tab.ref]);
  const repo = useStore((s) => (run ? s.repos.find((r) => r.id === run.repoId) : undefined));
  const untab = useStore((s) => s.untab);
  if (!run) return <p className="panel-clean sec-tab-gone">That run is not on the server now.</p>;
  return (
    <div className="sheet run-tab">
      <Console run={run} repo={repo} onClose={() => untab(tab.id)} />
    </div>
  );
}

/** an agent session as the board has it: its shell, its peek, or its run */
function AgentTabView({ tab }: { tab: ItemTab }) {
  const cards = useAllAgents();
  const card = cards.find((c) => c.id === tab.ref);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!card) return <p className="panel-clean sec-tab-gone">That agent is not running now.</p>;
  return (
    <div className="agent-tab">
      <AgentScreen card={card} live active showing now={now} />
    </div>
  );
}
