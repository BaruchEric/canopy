/**
 * The top-level views only the view switch shows, each in a chunk of its
 * own so the page loads without them. Once the page is idle they are
 * fetched anyway, with xterm: a view opened later shows at once, and a
 * redeploy that empties dist/web cannot take a chunk this page still needs.
 * A view whose chunk did not load says so and offers a reload.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { loadXterm } from "../xterm";

const LOADS = {
  sessions: () => import("./Sessions"),
  secrets: () => import("./Secrets"),
  kit: () => import("./Kit"),
  costs: () => import("./Costs"),
  triggers: () => import("./Triggers"),
  clock: () => import("./Clock"),
  library: () => import("./Library"),
  agents: () => import("./AgentsView"),
  incubator: () => import("./Incubator"),
  work: () => import("./Work"),
};

function Unloaded() {
  return (
    <div className="loading grove" role="alert">
      <p>This view could not load. canopy may have been updated since this page opened.</p>
      <button type="button" className="mini" onClick={() => location.reload()}>
        reload
      </button>
    </div>
  );
}

function view<M, P extends object>(load: () => Promise<M>, pick: (m: M) => (props: P) => ReactNode): (props: P) => ReactNode {
  const Lazy = lazy(() =>
    load().then(
      (m) => ({ default: pick(m) }),
      () => ({ default: Unloaded as (props: P) => ReactNode }),
    ),
  );
  return (props: P) => (
    <Suspense fallback={<div className="loading" role="status">Loading…</div>}>
      <Lazy {...props} />
    </Suspense>
  );
}

export const SessionsView = view(LOADS.sessions, (m) => m.SessionsView);
export const SecretsView = view(LOADS.secrets, (m) => m.SecretsView);
export const KitView = view(LOADS.kit, (m) => m.KitView);
export const CostsView = view(LOADS.costs, (m) => m.CostsView);
export const TriggersView = view(LOADS.triggers, (m) => m.TriggersView);
export const ClockView = view(LOADS.clock, (m) => m.ClockView);
export const Library = view(LOADS.library, (m) => m.Library);
// its props parameter is optional, which leaves them to be named here
export const AgentsView = view(LOADS.agents, (m): ((props: { onGit?: () => void }) => ReactNode) => m.AgentsView);
export const IncubatorView = view(LOADS.incubator, (m) => m.IncubatorView);
export const WorkView = view(LOADS.work, (m) => m.WorkView);

/** fetches every lazy chunk once the page has nothing else to do; returns the cancel */
export function warmChunks(): () => void {
  const go = () => {
    for (const load of [...Object.values(LOADS), loadXterm]) void load().catch(() => {});
  };
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(go, { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(go, 2000);
  return () => clearTimeout(t);
}
