export interface RepoFile {
  /** path relative to the repo root */
  path: string;
  /** original path for renames/copies */
  orig?: string;
  /** index (staged) state: M A D R C U or "." */
  index: string;
  /** worktree (unstaged) state: M D U or "." */
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface LastCommit {
  hash: string;
  subject: string;
  /** unix seconds */
  at: number;
}

export interface RepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: RepoFile[];
  lastCommit: LastCommit | null;
}

export interface Repo {
  /** stable id — path relative to the scan root ("." for the root itself) */
  id: string;
  name: string;
  /** absolute path */
  path: string;
  /** top-level folder under the scan root ("" when the repo is the root) */
  group: string;
  status: RepoStatus | null;
  error?: string;
}

export interface ScanResult {
  root: string;
  repos: Repo[];
  scannedAt: number;
}

export interface Workspace {
  name: string;
  /** absolute repo paths — stable across different scan roots */
  repos: string[];
}

export interface CanopyConfig {
  port: number;
  maxDepth: number;
  /** dir names never descended into */
  ignore: string[];
  workspaces: Workspace[];
  recentRoots: string[];
}

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

export type ServerEvent =
  | { type: "repo"; repo: Repo }
  | { type: "scan"; result: ScanResult }
  | { type: "workspaces"; workspaces: Workspace[] };

export const dirtyCount = (r: Repo): number => r.status?.files.length ?? 0;
export const isDirty = (r: Repo): boolean =>
  dirtyCount(r) > 0 || (r.status?.ahead ?? 0) > 0;
