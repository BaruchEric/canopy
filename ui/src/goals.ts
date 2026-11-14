// Pure helpers for a goal started from the top: a coordinator held at the
// anchor, which is no repo. Browser-safe.
import { GOAL_LIMITS, goalAnchor, isGoalAnchor } from "../../src/core/coordinator";
import { resolveAgent } from "../../src/core/route";
import { isSeedId, sizeWord } from "../../src/core/sprout";
import type { AgentEffort, AgentRoutes, Mention, Repo } from "../../src/core/types";
import { rankWords } from "./mentions";
import { backendOf, isHome, plainOf } from "./registry";
import type { Conn } from "./store";

// the id as a person reads it, without the store: feed.ts and inbox.ts use
// this file and the store imports them
const idWords = (id: string): string => (isHome(id) ? plainOf(id) : `${plainOf(id)} on ${backendOf(id)}`);

/** the anchor's word wherever a run's repo is printed */
export const GOAL_WORD = "goal";

/** the goal's word for the anchor, which is never in the repo list, and
 *  nothing for a repo: for a place that has its own way to name a repo */
export const anchorWord = (repoId: string): string | undefined => (isGoalAnchor(repoId) ? GOAL_WORD : undefined);

/** the name to print for a run's repo: "goal" for the anchor, the repo's
 *  name when known, else the id as text */
export function runRepoName(repos: readonly Repo[], repoId: string): string {
  return anchorWord(repoId) ?? repos.find((r) => r.id === repoId)?.name ?? idWords(repoId);
}

/** a run's repo as its id reads, the backend's name with it as `idText`
 *  gives it ("dev-tools/canopy on mini"), and "goal" for the anchor: for a
 *  head that must say where the run is */
export const runRepoId = (repoId: string): string => anchorWord(repoId) ?? idWords(repoId);

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

/** what may close a word after a repo's id: "@app," and "@app." name app */
const TRAILING = /[,.;:!?)]+$/;

/** The repos a goal's text names: every `@<id>` at the start of a word
 *  whose id is one of `choices`' plain ids, exactly or once a closing stop
 *  or comma is off it. Qualified, in the order written, once each. */
export function namedRepos(text: string, choices: readonly Repo[]): string[] {
  const byPlain = new Map(choices.map((r) => [plainOf(r.id), r.id]));
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const word = m[1] ?? "";
    const id = byPlain.get(word) ?? byPlain.get(word.replace(TRAILING, ""));
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The composer's `@` menu over a backend's repos, best first: each repo as
 *  a row `rankWords` can rank, named by its plain id, which is what a pick
 *  writes, with its name beside it when the id is a path. */
export function goalRepoRows(choices: readonly Repo[], query: string): Mention[] {
  const rows = choices.map((r): Mention => {
    const name = plainOf(r.id);
    return { name, kind: "builtin", harness: "claude", from: "builtin", description: r.name === name ? "" : r.name };
  });
  return rankWords(rows, query);
}

/** Why a goal cannot start as it stands against the server's limits
 *  (`GOAL_LIMITS`), the first one crossed, or null. */
export function goalLimitsWhy(goal: { text: string; repos: number; files: readonly { size: number }[] }): string | null {
  if (goal.text.length > GOAL_LIMITS.goal) return `The goal is over ${GOAL_LIMITS.goal} characters.`;
  if (goal.repos > GOAL_LIMITS.repos) return `A goal names at most ${GOAL_LIMITS.repos} repos; this one names ${goal.repos}.`;
  if (goal.files.length > GOAL_LIMITS.files) return `At most ${GOAL_LIMITS.files} files go with a goal; remove ${goal.files.length - GOAL_LIMITS.files}.`;
  const bytes = goal.files.reduce((n, f) => n + f.size, 0);
  if (bytes > GOAL_LIMITS.bytes) return `The files come to ${sizeWord(bytes)}; a goal takes ${GOAL_LIMITS.bytes / 1024 / 1024} MB in all.`;
  return null;
}
