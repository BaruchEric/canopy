// Pure helpers for a goal started from the top: a coordinator held at the
// anchor, which is no repo. Browser-safe.
import { goalAnchor, isGoalAnchor } from "../../src/core/coordinator";
import { resolveAgent } from "../../src/core/route";
import { isSeedId } from "../../src/core/sprout";
import type { AgentEffort, AgentRoutes, Repo } from "../../src/core/types";
import { backendOf, isHome, plainOf } from "./registry";
import type { Conn } from "./store";

// the id as a person reads it, without the store: feed.ts and inbox.ts use
// this file and the store imports them
const idWords = (id: string): string => (isHome(id) ? plainOf(id) : `${plainOf(id)} on ${backendOf(id)}`);

/** the name to print for a run's repo: "goal" for the anchor, which is never
 *  in the repo list, the repo's name when known, else the id as text */
export function runRepoName(repos: readonly Repo[], repoId: string): string {
  if (isGoalAnchor(repoId)) return "goal";
  return repos.find((r) => r.id === repoId)?.name ?? idWords(repoId);
}

/** the backends, in registry order, that can run a coordinator and answer now */
export function coordBackends(conns: Record<string, Conn>, order: readonly string[]): string[] {
  return order.filter((b) => {
    const c = conns[b];
    return c !== undefined && c.status.state === "online" && c.about?.coordinator === true;
  });
}

/** the model and effort a coordinator starts with when the person picks none */
export function coordDefaults(routes: AgentRoutes): { model: string; effort: AgentEffort } {
  const { model, effort } = resolveAgent(routes, "", "coordinate").settings;
  return { model, effort };
}

/** the repos a goal can name on one backend: local checkouts, no host, forge
 *  listing, seed or the anchor */
export function goalRepoChoices(repos: readonly Repo[], backend: string): Repo[] {
  return repos.filter((r) => backendOf(r.id) === backend && !r.host && !r.forge && !isSeedId(r.id) && !isGoalAnchor(r.id));
}

/** the repo a run belongs to, for a line that carries a repo: the anchor,
 *  which is never in the list, stands in as the goal under the run's own id */
export function runRepo(repos: readonly Repo[], repoId: string): Repo | undefined {
  const found = repos.find((r) => r.id === repoId);
  if (found || !isGoalAnchor(repoId)) return found;
  return { ...goalAnchor(""), id: repoId, name: runRepoName(repos, repoId) };
}
