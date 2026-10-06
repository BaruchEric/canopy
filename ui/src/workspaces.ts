/** Which workspaces a repo is in, and whether it is one's primary. Pure,
 *  for the cards and the workspace menu. */
import { effectivePrimary, type Workspace } from "../../src/core/types";

export const wsOf = (workspaces: readonly Workspace[], repoPath: string): Workspace[] =>
  workspaces.filter((w) => w.repos.includes(repoPath));

export const isPrimary = (ws: Workspace, repoPath: string): boolean => effectivePrimary(ws) === repoPath;
