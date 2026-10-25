import { useStore } from "../store";
import type { SectionTab } from "../sectiontabs";
import { PanelSection } from "./Dock";
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
