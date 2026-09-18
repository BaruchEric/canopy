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
  /** when the file on disk last changed, unix seconds; absent when it is
   *  gone (deleted) or could not be read */
  mtime?: number;
}

export interface LastCommit {
  hash: string;
  subject: string;
  /** unix seconds */
  at: number;
}

/** The identity a repo commits as: `user.name` / `user.email` as git resolves
 *  them from inside that repo, so per-folder includeIf overrides count. */
export interface GitUser {
  name: string;
  email: string;
}

export interface RepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: RepoFile[];
  lastCommit: LastCommit | null;
  /** null when neither user.name nor user.email is set anywhere */
  user: GitUser | null;
}

/* ---------- sources: the folders canopy scans ---------- */

/** Where a scanned source is: a folder on this machine, a folder on a host
 *  ssh can reach, or a self-hosted Forgejo the API lists repos from. A
 *  forgejo source has no folder — its repos are on the server, not here. */
export type SourcePlace =
  | { kind: "local"; path: string }
  | { kind: "ssh"; host: string; path: string }
  | { kind: "forgejo"; url: string; tokenFile?: string };

/** What the browser or the CLI sends to add one. */
export type SourceInput = SourcePlace & { label?: string };

/** A folder canopy scans for repos. Extra sources live in config; the launch
 *  root is the CLI argument and is never stored. */
export type Source = SourcePlace & {
  /** a slug of the label; repo ids under it read `<id>:<path>`. The launch
   *  root is LAUNCH_SOURCE and its repo ids stay bare. */
  id: string;
  label: string;
  /** the folder canopy was started on: always present, cannot be removed */
  launch: boolean;
};

/** A source with what its last scan found. */
export type SourceState = Source & {
  repos: number;
  scannedAt: number;
  /** why the last scan failed; the repos from before it stay in place */
  error?: string;
};

export const LAUNCH_SOURCE = "launch";

/** One folder as the add-a-folder browser shows it. */
export interface Listing {
  /** absolute, as the host resolves it */
  path: string;
  /** null at the filesystem root */
  parent: string | null;
  /** visible subfolders, a to z; `repo` when one holds a .git */
  dirs: { name: string; repo: boolean }[];
}

/** A repo canopy knows only from a forge's API: there is no working copy
 *  here, so status, openers and runs do not apply to it. */
export interface ForgeRepo {
  kind: "forgejo";
  /** `owner/name` on the forge */
  slug: string;
  /** the ssh url to clone it from */
  clone: string;
  /** the branch the forge calls default */
  branch: string;
  /** last push, ms since epoch; 0 when the forge did not say */
  updated: number;
  private: boolean;
  /** a repo with no commits yet — there is nothing to clone */
  empty: boolean;
  /** the id of the local repo that already has this as a remote, when one
   *  in this scan does. Filled in after every scan, not by the fetch. */
  clonedAs?: string;
}

export interface Repo {
  /** stable id — path relative to the source root ("." for the root itself),
   *  prefixed `<source id>:` for every source but the launch root */
  id: string;
  name: string;
  /** absolute path, `ssh://<host><path>` for a repo on another host, or the
   *  forge's web address for a repo that only exists on a forge */
  path: string;
  /** top-level folder under the scan root ("" when the repo is the root);
   *  under an extra source, the source's label then that folder */
  group: string;
  /** the source this repo was found under */
  source: string;
  /** the ssh host the repo lives on; absent for this machine */
  host?: string;
  status: RepoStatus | null;
  /** the remote as a page you can open; absent when no remote maps to one */
  link?: string;
  /** one line from the repo's manifest or README. Read at scan time only —
   *  it is near-static, so a file event does not re-read it. */
  description?: string;
  /** every configured remote's url, read with the meta. What ties a repo to
   *  the same repo on a forge. */
  remotes?: string[];
  /** set only on a repo that lives on a forge and nowhere here */
  forge?: ForgeRepo;
  error?: string;
}

/** A repo with no working copy on any machine canopy can reach: git cannot
 *  be run against it, so status, diffs, openers and runs all refuse. */
export const isForge = (r: Pick<Repo, "forge">): boolean => r.forge !== undefined;

export interface ScanResult {
  /** the launch root */
  root: string;
  /** every source, the launch root first, with its scan outcome */
  sources: SourceState[];
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
  /** extra folders scanned alongside the launch root, in display order */
  sources: StoredSource[];
  /** the claude-history CLI; null looks on PATH, then in ~/dev/dev-tools */
  historyBin: string | null;
  /** how Claude Code starts per repo, keyed by the repo's absolute path (or
   *  ssh locator) like workspaces are; a repo with no entry uses the defaults */
  agents: Record<string, AgentSettings>;
}

/* ---------- agent settings: how Claude Code starts for a repo ---------- */

/** Model aliases the claude CLI takes; "default" leaves the choice to it. */
export const AGENT_MODELS = ["default", "fable", "opus", "sonnet", "haiku"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export const AGENT_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** Applied wherever canopy starts Claude for the repo: the agent opener, a
 *  herdr workspace, and the runs and chats in the browser. */
export interface AgentSettings {
  model: AgentModel;
  effort: AgentEffort;
  /** skip every permission prompt (the CLI's --dangerously-skip-permissions;
   *  bypassPermissions mode for a run). On by default: canopy is a cockpit
   *  for one's own repos, and a prompt nobody is watching just stalls. */
  yolo: boolean;
  /** anything else for the claude command line, split like a shell would */
  extra: string;
}

export const DEFAULT_AGENT: AgentSettings = {
  model: "default",
  effort: "default",
  yolo: true,
  extra: "",
};

/** A source as config holds it: everything but the launch flag. */
export type StoredSource = SourcePlace & { id: string; label: string };

/** Whether a push has anywhere to land. "unknown" means we could not tell and
 *  the UI stays quiet — a hint on every repo is worse than no hint. */
export type PushAccess = "ok" | "denied" | "unknown";

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

/** One path a commit touched, with the line counts git's numstat gives it. */
export interface CommitFile {
  path: string;
  /** the old path of a rename or copy */
  orig?: string;
  /** git's status letter: M A D R C T U, or X for anything it cannot name */
  status: string;
  /** null for a binary file, where lines mean nothing */
  added: number | null;
  deleted: number | null;
}

/** What the history drill shows for one commit. */
export interface CommitDetail {
  /** full 40-character hash */
  hash: string;
  short: string;
  subject: string;
  /** the message after the subject, trimmed; empty when there is none */
  body: string;
  author: string;
  email: string;
  /** committer time, unix seconds */
  at: number;
  parents: string[];
  files: CommitFile[];
}

/* ---------- openers: where a repo opens ---------- */

/** Apps a repo opens in. `agent` is Claude Code itself: an interactive
 *  session in a terminal window at the repo, kitty when it is installed and
 *  Terminal otherwise. `herdr` is the same session inside a herdr workspace
 *  (herdr.dev, the terminal workspace manager for coding agents). Both start
 *  Claude with the repo's agent settings. */
export const OPENER_IDS = ["kitty", "terminal", "code", "finder", "agent", "herdr"] as const;
export type OpenerId = (typeof OPENER_IDS)[number];

/** The openers that start Claude rather than a plain app. */
export const CLAUDE_OPENERS: readonly OpenerId[] = ["agent", "herdr"];

/* ---------- runs: a job handed to Claude Code for one repo ---------- */

export const RUN_ACTIONS = ["ask", "chat"] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export type RunStatus =
  /** the process is starting or Claude is working */
  | "working"
  /** a permission or a question is waiting for the user */
  | "waiting"
  /** a chat between turns: Claude has answered and waits for the next message */
  | "idle"
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
  /** Claude's words (text), a tool call, a one-line remark from canopy, or a
   *  message the user sent in a chat */
  kind: "text" | "tool" | "note" | "user";
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
  /** a built-in action's name, or the workflow's name for a flow's step */
  action: string;
  /** the words the chip and the sheet use, copied from the spec at start */
  verb: string;
  progress: string;
  expectsChange: boolean;
  /** a chat keeps its process between turns and takes messages */
  chat: boolean;
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

/** A run with a live Claude process: working, waiting on a prompt, or a chat
 *  between turns. One at a time per repo. */
export const isRunActive = (r: Run): boolean =>
  r.status === "working" || r.status === "waiting" || r.status === "idle";

export type ServerEvent =
  | { type: "repo"; repo: Repo }
  | { type: "scan"; result: ScanResult }
  | { type: "workspaces"; workspaces: Workspace[] }
  | { type: "agents"; agents: Record<string, AgentSettings> }
  | { type: "run"; run: Run }
  | { type: "run-gone"; id: string }
  | { type: "flow"; flow: Flow }
  | { type: "flow-gone"; id: string }
  | { type: "fleet"; fleet: Fleet }
  | { type: "fleet-gone"; id: string };

/* ---------- the archive: what claude-history holds for each repo ---------- */

/** One repo's slice of the claude-history index. Totals are all-time; the day
 *  arrays cover the overview's `days` (oldest first) and feed the rings. */
export interface RepoHistory {
  /** claude-history project id, the key its CLI takes */
  project: string;
  sessions: number;
  /** API-equivalent list price of every token, not a bill */
  costUsd: number;
  tokens: number;
  /** commits made while a session was running */
  commits: number;
  first: string | null;
  last: string | null;
  /** spend per local day */
  days: number[];
  /** sessions started per local day */
  daySessions: number[];
}

/** The archive as the grove sees it, or the one-line reason it cannot. */
export type HistoryOverview =
  | {
      available: true;
      /** local dates (YYYY-MM-DD) the day arrays cover, oldest first */
      days: string[];
      /** the heaviest single day across every repo, so all rings share a scale */
      maxDay: number;
      /** by repo id; repos with no project in the archive are absent */
      repos: Record<string, RepoHistory>;
      fetchedAt: number;
    }
  | {
      available: false;
      /** why the claude-history CLI or its index cannot be reached */
      reason: string;
      fetchedAt: number;
    };

/** The repo's slice, when the archive is reachable and knows the repo. */
export const historyFor = (
  o: HistoryOverview | null,
  repoId: string,
): RepoHistory | undefined => (o?.available ? o.repos[repoId] : undefined);

export const HISTORY_WINDOWS = ["30d", "90d", "all"] as const;
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number];

/* The rows below are claude-history's own `--json` shapes, passed through
   untouched (hence the snake_case): its README treats them as an API. */

/** one row of `claude-history sessions --json` */
export interface HistorySession {
  id: string;
  /** "mac", a remote name, or "cloud" */
  host: string;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
  first_prompt: string | null;
  turns: number;
  tool_calls: number;
  /** tokens and cost include the session's subagent runs */
  tokens: number;
  cost: number;
  subs: number;
  commits: number;
  /** 0 once Claude Code has deleted the transcript; the mirror keeps it */
  source_present: number;
}

export interface HistoryTurn {
  idx: number;
  started_at: string | null;
  ended_at: string | null;
  /** "prompt" or "command" (a slash command) */
  prompt_kind: string;
  prompt: string;
  reply: string;
  assistant_messages: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  thinking_tokens: number;
  cost_usd: number | null;
  /** JSON array of model ids */
  models: string;
}

export interface HistoryTool {
  turn_idx: number | null;
  name: string;
  /** JSON of the tool input, truncated by claude-history */
  input: string;
  result: string | null;
  is_error: number;
  duration_ms: number | null;
}

export interface HistorySubagent {
  agent_type: string | null;
  agent_description: string | null;
  turns: number;
  tool_calls: number;
  cost_usd: number | null;
}

export interface HistoryCommit {
  hash: string;
  ts: string;
  subject: string;
}

/** `claude-history show --json` */
export interface HistorySessionDetail {
  session: {
    id: string;
    project_id: string;
    host: string;
    cwd: string | null;
    started_at: string | null;
    ended_at: string | null;
    title: string | null;
    first_prompt: string | null;
    /** JSON object of model id → API messages */
    models: string;
    turns: number;
    messages: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    thinking_tokens: number;
    cost_usd: number | null;
    git_branch: string | null;
    version: string | null;
    source_present: number;
    /** the vault note `claude-history export` writes for this session */
    note_path?: string;
  };
  turns: HistoryTurn[];
  tools: HistoryTool[];
  subagents: HistorySubagent[];
  commits: HistoryCommit[];
}

/** one hit of `claude-history search --json` */
export interface HistoryHit {
  session_id: string;
  turn_idx: number;
  /** "user" or "assistant" */
  role: string;
  /** matches wrapped in [square brackets] */
  snippet: string;
  project_id: string;
  started_at: string | null;
  title: string | null;
}

/** one line `git grep` matched in a repo */
export interface GrepHit {
  /** path relative to the repo root */
  file: string;
  /** 1-based line */
  line: number;
  /** 1-based column of the first match on the line, in the clipped text */
  col: number;
  /** the line, clipped around the match when it is long */
  text: string;
}

/** what one repo answered a search with */
export interface GrepResult {
  hits: GrepHit[];
  /** the repo had more than the cap and the list stops short */
  truncated: boolean;
}

/** one repo's row in a search across many */
export interface GrepRepoResult extends GrepResult {
  /** the repo id */
  repo: string;
  /** why this repo could not be searched; the hits are empty then */
  error?: string;
}

export const dirtyCount = (r: Repo): number => r.status?.files.length ?? 0;
export const isDirty = (r: Repo): boolean =>
  dirtyCount(r) > 0 || (r.status?.ahead ?? 0) > 0;

/* ---------- workflows: markdown files that drive Claude step by step ---------- */

export const WORKFLOW_WHENS = ["dirty", "unpushed", "dirty-or-unpushed", "any"] as const;
export type WorkflowWhen = (typeof WORKFLOW_WHENS)[number];

export const GATE_KINDS = ["continue", "ask", "verdict"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** where a workflow file came from; later sources win by name */
export type WorkflowSource = "bundled" | "user" | "repo";

export interface WorkflowStep {
  name: string;
  /** permission rules for this step's run, named sets already expanded */
  tools: string[];
  turns: number;
  /** a shell command run in the repo after the step; exit 0 passes */
  check: string | null;
  gate: GateKind;
  /** the step's prompt; empty for a check-only step */
  body: string;
}

export interface Workflow {
  /** `[a-z0-9-]+`, unique across the three sources */
  name: string;
  label: string;
  verb: string;
  blurb: string;
  when: WorkflowWhen;
  expectsChange: boolean;
  notePlaceholder: string;
  noteRequired: boolean;
  steps: WorkflowStep[];
  source: WorkflowSource;
  /** absolute path of the file */
  file: string;
}

/** what the menu lists: a workflow, or a file that failed to parse */
export type WorkflowEntry =
  | { ok: true; workflow: Workflow }
  | { ok: false; name: string; source: WorkflowSource; file: string; error: string };

/* ---------- the verdict gate: Jev reads a step's summary ---------- */

export type VerdictOutcome = "done" | "partial" | "blocked";

/** the answers as the evaluator returns them, one per question */
export interface VerdictAnswers {
  outcome: { choice: VerdictOutcome; probabilities?: Record<string, number> };
  needsYou: { probability: number };
  offScope: { probability: number };
}

export interface Verdict {
  answers: VerdictAnswers;
  /** whether the flow may go on without the user */
  go: boolean;
  /** why it may not, one line; null when go */
  reason: string | null;
}

/* ---------- flows: one workflow running on one repo ---------- */

export type FlowStatus = "working" | "waiting" | "gated" | "done" | "failed" | "stopped";
export type StepStatus = "pending" | "running" | "checking" | "gated" | "passed" | "failed" | "skipped";
export type FlowChoice = "continue" | "retry" | "stop";

export interface FlowStep {
  name: string;
  status: StepStatus;
  /** the step's Run, once it has one */
  runId?: string;
  check?: { command: string; exit: number; output: string };
  verdict?: Verdict;
  /** Claude's closing summary, the last text of the run */
  summary?: string;
  /** why a gate parked or a step failed, for the sheet */
  reason?: string;
}

export interface Flow {
  id: string;
  repoId: string;
  workflow: string;
  verb: string;
  fleetId?: string;
  note: string;
  status: FlowStatus;
  steps: FlowStep[];
  /** index of the step in progress or parked */
  current: number;
  startedAt: number;
  endedAt?: number;
  /** why a failed flow failed */
  error?: string;
  /** set when the flow ends, for workflows that expect change */
  outcome?: "changed" | "unchanged";
}

/** A flow with a live step: running, waiting on a prompt, or parked at a gate. */
export const isFlowActive = (f: Flow): boolean =>
  f.status === "working" || f.status === "waiting" || f.status === "gated";

/* ---------- fleets: one workflow over many repos ---------- */

export interface FleetRepo {
  repoId: string;
  /** the flow, once started */
  flowId?: string;
  /** why this repo was passed over, when it was */
  skipped?: string;
}

export interface Fleet {
  id: string;
  workflow: string;
  verb: string;
  note: string;
  repos: FleetRepo[];
  status: "working" | "done" | "stopped";
  startedAt: number;
  endedAt?: number;
}
