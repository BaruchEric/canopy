/** Which workspaces a repo is in, and whether it is one's primary. Pure,
 *  for the cards and the workspace menu. */
import { isSeedId } from "../../src/core/sprout";
import { effectivePrimary, type Repo, type Workspace } from "../../src/core/types";

export const wsOf = (workspaces: readonly Workspace[], repoPath: string): Workspace[] =>
  workspaces.filter((w) => w.repos.includes(repoPath));

export const isPrimary = (ws: Workspace, repoPath: string): boolean => effectivePrimary(ws) === repoPath;

/** Why a member at `path` (its card `repo`, when the tree has one) cannot be
 *  the workspace's primary, or null when it can. These are the members a
 *  workspace run refuses as its primary: a run starts in a folder on this
 *  machine, and a seed's agents run only through the incubator. The server
 *  keeps its own refusal; this only keeps the menu from offering them. */
export function primaryRefusal(repo: Repo | undefined, path: string): string | null {
  if (!repo) return `${path} is not in the tree`;
  if (repo.host) return `${repo.name} is on ${repo.host}; the primary has to be on this machine`;
  if (repo.forge) return `${repo.name} is on the forge; the primary has to be a folder on this machine`;
  if (isSeedId(repo.id)) return `${repo.name} is an incubator seed; its agents run through the incubator`;
  return null;
}
