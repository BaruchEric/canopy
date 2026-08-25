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

/** Whether a push has anywhere to land. "unknown" means we could not tell and
 *  the UI stays quiet — a hint on every repo is worse than no hint. */
export type PushAccess = "ok" | "denied" | "unknown";

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

/* ---------- runs: a job handed to Claude Code for one repo ---------- */

export const RUN_ACTIONS = [
  "commit",
  "push",
  "commit-push",
  "deploy",
  "ask",
] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export type RunStatus =
  /** the process is starting or Claude is working */
  | "working"
  /** a permission or a question is waiting for the user */
  | "waiting"
  | "done"
  | "failed"
  | "stopped";

export interface RunTool {
  /** tool name as Claude Code reports it: Bash, Edit, Read, ... */
  name: string;
  /** one line for the timeline: the command, the file, or the tool name */
  title: string;
  status: "running" | "ok" | "error";
  /** tool output, truncated */
  output?: string;
}

export interface RunStep {
  id: string;
  /** unix ms */
  at: number;
  /** Claude's words (text), a tool call, or a one-line remark from canopy */
  kind: "text" | "tool" | "note";
  text?: string;
  tool?: RunTool;
}

export interface RunQuestionOption {
  label: string;
  description: string;
}

export interface RunQuestion {
  question: string;
  /** chip label, a few characters */
  header: string;
  options: RunQuestionOption[];
  multiSelect: boolean;
}

export type RunPrompt =
  | {
      id: string;
      kind: "permission";
      tool: string;
      /** what Claude wants to do, as one line */
      title: string;
      /** the full command or input, for the details view */
      detail: string;
    }
  | { id: string; kind: "question"; questions: RunQuestion[] };

/** The user's reply to a RunPrompt. Answers map question text to the chosen
 *  label(s); "allow-all" allows every later permission in the same run. */
export type RunAnswer =
  | { kind: "allow" }
  | { kind: "allow-all" }
  | { kind: "deny" }
  | { kind: "answers"; answers: Record<string, string> };

export interface RunResult {
  /** Claude's closing message */
  text: string;
  costUsd: number;
  durationMs: number;
  turns: number;
}

export interface Run {
  id: string;
  repoId: string;
  action: RunAction;
  /** what the user typed into the note box, if anything */
  note: string;
  status: RunStatus;
  /** unix ms */
  startedAt: number;
  endedAt?: number;
  steps: RunStep[];
  /** the prompt the run is blocked on, when status is "waiting" */
  prompt: RunPrompt | null;
  result?: RunResult;
  /** why a failed run failed */
  error?: string;
  /** whether git status differed after the run from before it; set when
   *  the run ends, for actions that are supposed to change something */
  outcome?: "changed" | "unchanged";
}

/** The parts of a status a run is expected to move: the working tree and
 *  the branch's position. Equal fingerprints before and after a commit or
 *  push mean the run did nothing the card can show. */
export function statusFingerprint(st: RepoStatus | null): string {
  if (!st) return "";
  const files = st.files
    .map((f) => `${f.path}:${f.index}${f.worktree}${f.untracked ? "?" : ""}`)
    .sort();
  return JSON.stringify({
    files,
    ahead: st.ahead,
    behind: st.behind,
    head: st.lastCommit?.hash ?? "",
  });
}

export const isRunActive = (r: Run): boolean =>
  r.status === "working" || r.status === "waiting";

export type ServerEvent =
  | { type: "repo"; repo: Repo }
  | { type: "scan"; result: ScanResult }
  | { type: "workspaces"; workspaces: Workspace[] }
  | { type: "run"; run: Run }
  | { type: "run-gone"; id: string };

export const dirtyCount = (r: Repo): number => r.status?.files.length ?? 0;
export const isDirty = (r: Repo): boolean =>
  dirtyCount(r) > 0 || (r.status?.ahead ?? 0) > 0;
