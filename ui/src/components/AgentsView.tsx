import { useRef, useState } from "react";
import { HARNESS } from "../../../src/core/harness";
import { HARNESSES } from "../../../src/core/types";
import { harnessesOf, hasRouting } from "../agents";
import { connOf, multi, routesOf, useStore } from "../store";
import { BoardTab } from "./Board";
import { ChanChip } from "./Chan";
import { InboxChip } from "./Inbox";
import { RegistryTab } from "./Registry";
import { Routing } from "./Routing";
import { Seg } from "./Seg";
import { WidgetGear, shareEntries, useZoom, zoomStyle } from "./Surface";

type Tab = "board" | "registry" | "routing";

const TABS = [
  { value: "board", label: "board", title: "Every agent at once, live (the registry's, canopy's runs and chats, and agents in canopy shells): a rail beside one in focus, a wall, a spotlight, a dashboard, a board by state, or lanes" },
  { value: "registry", label: "registry", title: "Every agent on the tailnet: running, waiting, and the day's ended ones" },
  { value: "routing", label: "routing", title: "Which agent starts for what: profiles, roles and repo overrides" },
] as const;

/**
 * The agents view: a fourth view beside git, library and ports. The
 * registry tab is every agent tailchan's broker knows of, on any machine
 * (only when the home backend has a broker). Routing is the profiles a
 * route can name, the route per role, the repos that override them, and any
 * repo's effective table. Routes are the backend's own; on a board with
 * several, the picker at the top says whose are shown. `onGit` takes the
 * page to the git view, where a joined panel shell shows.
 */
export function AgentsView({ onGit }: { onGit?: () => void } = {}) {
  const home = useStore((s) => s.home);
  const order = useStore((s) => s.backendOrder);
  const isMulti = useStore(multi);
  const [picked, setPicked] = useState<string | null>(null);
  const scope = picked && order.includes(picked) ? picked : home;
  const routes = useStore((s) => routesOf(s, scope));
  const has = useStore((s) => harnessesOf(connOf(s, scope).backend));
  const routing = useStore((s) => hasRouting(connOf(s, scope).backend));
  const ready = useStore((s) => s.registryReady);
  // the board first: it needs no broker, since canopy's own runs, chats
  // and shells are on it. The registry tab shows only with a broker
  const [chosen, setTab] = useState<Tab | null>(null);
  const tab: Tab = chosen === "registry" && !ready ? "board" : (chosen ?? "board");
  const tabs = ready ? TABS : TABS.filter((t) => t.value !== "registry");
  const body = useRef<HTMLDivElement>(null);
  const { zoom, entry: zoomEntry } = useZoom("agents");

  return (
    <section className="agents-view" aria-label="Agents">
      <div className="agents-bar">
        <Seg label="Agents view" value={tab} options={tabs} onChange={setTab} />
        {tab === "routing" && isMulti && (
          <Seg
            label="Backend"
            value={scope}
            options={order.map((b) => ({ value: b, label: b, title: `The routes ${b} keeps` }))}
            onChange={setPicked}
          />
        )}
        {(tab === "registry" || tab === "board") && (
          <span className="agents-has">
            <InboxChip onGit={onGit} />
            {ready && <ChanChip />}
          </span>
        )}
        {tab === "routing" && <span className="agents-has" title="The harnesses this backend has installed">
          <InboxChip onGit={onGit} />
          {HARNESSES.map((h) => (
            <span key={h} className={has.includes(h) ? `harness-chip h-${h}` : "harness-chip off"}>
              {HARNESS[h].glyph} {HARNESS[h].label}
              {has.includes(h) ? "" : " · not installed"}
            </span>
          ))}
        </span>}
        <WidgetGear label="the agents" what="agents" zoom={zoomEntry} share={shareEntries({ el: () => body.current, label: "agents" })} />
      </div>
      <div ref={body} className={tab === "board" ? "agents-body board-body" : "agents-body"} style={zoomStyle(zoom)}>
        {tab === "registry" ? (
          <RegistryTab onGit={onGit} />
        ) : tab === "board" ? (
          <BoardTab onGit={onGit} />
        ) : (
          <Routing scope={scope} routes={routes} has={has} routing={routing} />
        )}
      </div>
    </section>
  );
}
