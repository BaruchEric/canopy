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

/** The newest commit on any remote-tracking branch that the checkout does
 *  not have: work pushed from another machine, a cloud agent's branch, a PR
 *  branch nobody checked out here. Only as fresh as the last fetch. */
export interface RemoteTip {
  /** `origin/feature`: the remote-tracking ref without `refs/remotes/` */
  ref: string;
  hash: string;
  subject: string;
  /** committer date, unix seconds */
  at: number;
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
  /** absent when every remote-tracking branch is already in the checkout's
   *  history, or the repo has no remotes */
  tip?: RemoteTip;
}

/** Open pull requests on the repo's GitHub page, counted for the repos the
 *  gh login can see; absent on any other repo. */
export interface PullCount {
  open: number;
  /** the pull request list on GitHub */
  url: string;
  /** GitHub has the repo archived (read-only) */
  archived?: true;
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
  /** open pull requests on GitHub, when the repo has a GitHub remote the gh
   *  login can see; re-read on the remote refresh timer */
  pulls?: PullCount;
  /** set only on a repo that lives on a forge and nowhere here */
  forge?: ForgeRepo;
  peers?: PeerState;
  /** who archived the repo: the user in canopy, or its owner on GitHub,
   *  canopy's mark winning when both did. Still scanned, but off the board
   *  unless a browser asks to see archived repos. */
  archived?: "canopy" | "github";
  /** set on a repo the user starred in canopy */
  favorite?: true;
  error?: string;
}

/** A repo with no working copy on any machine canopy can reach: git cannot
 *  be run against it, so status, diffs, openers and runs all refuse. */
export const isForge = (r: Pick<Repo, "forge">): boolean => r.forge !== undefined;

/** What this canopy backend can do for the clients on it, so the UI hides
 *  controls a headless or non-macOS backend cannot perform rather than
 *  showing them dead. A shared backend in a Linux container has `openers`
 *  false: the desktop openers and the launcher are macOS `open`/`osascript`
 *  and cannot run there. The in-browser core (shells, runs, git, search) is
 *  unaffected; it belongs to wherever the repo lives, which is the backend. */
export interface Backend {
  /** the backend host is a macOS desktop, so the desktop openers (kitty,
   *  Terminal, Finder, agent, herdr) and the launcher work; false in a
   *  container, where the UI hides them */
  openers: boolean;
  /** the ssh alias a client uses to reach this backend for VS Code
   *  Remote-SSH (from `CANOPY_SSH_HOST`), or null when unset */
  sshHost: string | null;
  /** the agent harnesses whose binary this backend finds, so the UI greys
   *  out one a machine lacks; absent from a backend older than harnesses,
   *  which only ever started claude */
  harnesses?: Harness[];
}

/** A helper: `canopy helper` running on a client machine, dialled in to the
 *  backend over a websocket and registered with what it can open there. A
 *  browser picks the helper that is its own machine by name (`helper` in its
 *  settings); when the backend sees real client addresses, a browser adopts
 *  the one helper at its own address by itself. */
export interface HelperInfo {
  /** the machine's name, what the helper was started with; one helper per
   *  name, a newer one replacing an older */
  name: string;
  /** the helper's `process.platform`: darwin, linux */
  platform: string;
  /** the openers it runs there */
  openers: OpenerId[];
  /** unix ms of the registration */
  since: number;
  /** the address the backend saw the helper dial in from */
  address: string;
}

/** Which canopy this is: the package version and the commit it was built
 *  from. `commit` is null when neither git nor the build said (a tarball
 *  without `.git` and no CANOPY_COMMIT); `dirty` is a checkout with
 *  uncommitted changes to tracked files, which the commit alone does not
 *  describe. */
export interface BuildInfo {
  version: string;
  commit: string | null;
  /** the commit's committer date, ISO 8601 */
  committedAt: string | null;
  dirty: boolean;
}

/** `GET /api/about`: the server's build and where and since when it runs. */
export interface About extends BuildInfo {
  /** ms since the epoch */
  startedAt: number;
  bun: string;
  platform: string;
  arch: string;
  hostname: string;
  /** the scan root the server was started on */
  root: string;
  homepage: string | null;
}

/** What the backend knows about one browser: the address it sees it at, and
 *  whether that is the backend's own machine with a desktop (a Mac running
 *  canopy), in which case the openers run there with no helper. */
export interface ClientInfo {
  address: string;
  local: boolean;
  /** the address is one many browsers arrive under (docker's proxy in
   *  front of a container hands the backend its own gateway for every
   *  client), so it says nothing about which machine the browser is on */
  shared: boolean;
}

/** One browser on the backend, as presence shows it: a browser profile is
 *  one device (its id lives in localStorage, so two windows of one profile
 *  are one device with two streams), named by the user or by its user
 *  agent. Best effort: it comes off the event stream's open and close. */
export interface Device {
  /** the browser's own id, 16 hex digits it made and keeps */
  id: string;
  /** what the user calls it, or the browser's guess ("Mac, Chrome") */
  name: string;
  /** the browser's platform word: mac, android, windows, linux, ios, other */
  platform: string;
  /** the address the backend sees it at (a proxy's when `shared`) */
  address: string;
  /** unix ms of the oldest stream it has open now */
  since: number;
  /** how many event streams (windows, tabs) it has open */
  streams: number;
}

export const DEVICE_PLATFORMS = ["mac", "android", "windows", "linux", "ios", "other"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** What one browser can have opened on its own machine, and who does it: the
 *  backend itself when the browser is on the backend host and that host has a
 *  desktop, the helper the browser picked, or nobody, in which case the UI
 *  shows no opener but the VS Code link. Derived in the browser from
 *  `ClientInfo`, the helper list and its own choice. */
export interface ClientCaps {
  openers: OpenerId[];
  via: "backend" | "helper" | null;
  helper: HelperInfo | null;
}

export interface ScanResult {
  /** the launch root */
  root: string;
  /** every source, the launch root first, with its scan outcome */
  sources: SourceState[];
  repos: Repo[];
  scannedAt: number;
  /** what this backend can do for its clients */
  backend: Backend;
}

export interface Workspace {
  name: string;
  /** absolute repo paths — stable across different scan roots */
  repos: string[];
}

export type PeerRole = "git" | "mirror";
export type PeerSync = "off" | "dry" | "on";

/** A machine this one pulls from. `alias` is an ssh_config alias; null is a
 *  folder on this machine (tests, and a peer mounted locally). `root` is the
 *  peer's workspace root: home-relative unless absolute. */
export interface Peer {
  name: string;
  alias: string | null;
  root: string;
  role: PeerRole;
  /** globs over repo ids; absent means every repo */
  repos?: string[];
}

export interface PeerSeen {
  name: string;
  ok: boolean;
  at: number;
  error?: string;
}

/** One branch where this repo and a peer disagree. */
export interface PeerBranch {
  branch: string;
  peer: string;
  ahead: number;
  behind: number;
}

/** One path a peer's WIP touches, as `git diff --name-status` names it
 *  against the WIP's parent. An untracked file shows as "A": the snapshot
 *  tree is built with `git add -A`, which erases that difference. */
export interface PeerWipPath {
  status: string;
  path: string;
}

export interface PeerWip {
  peer: string;
  branch: string;
  at: number;
  parent: string;
  hash: string;
  /** every path the WIP touches, however many `paths` lists */
  files: number;
  /** the first WIP_PATHS of them; absent from a backend older than this */
  paths?: PeerWipPath[];
}

export interface PeerState {
  moved: { branch: string; from: string; to: string; peer: string }[];
  diverged: PeerBranch[];
  wip: PeerWip[];
  ownWip?: { branch: string; at: number };
  peerOnly: { peer: string; branch: string }[];
  /** no git peer has this repo */
  onlyHere: boolean;
  /** what dry mode would have moved, instead of `moved` */
  would?: { branch: string; to: string; peer: string }[];
  error?: string;
  at: number;
}

/** Another canopy server this page may connect to: its name (a peer name,
 *  so `|` can never appear in it) and where it answers. `public` is an
 *  https origin behind the edge gate; `tailnet` an origin on the tailnet. */
export interface BackendEntry {
  name: string;
  public?: string;
  tailnet?: string;
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
  /** which agent a repo starts, whole or per role, keyed by the repo's
   *  absolute path (or ssh locator) like workspaces are; an entry written
   *  before roles existed is plain `AgentSettings` on disk and reads as
   *  `{ all: entry }`. A repo with no entry follows the role and default
   *  routes (core/route). */
  agents: Record<string, RepoAgent>;
  /** named agent settings a route can point at; `default` is the backend
   *  default, and the builtin `DEFAULT_AGENT` when unset */
  profiles: Record<string, AgentSettings>;
  /** the route per role: a profile or settings of its own */
  agentRoles: Partial<Record<AgentRole, AgentPick>>;
  /** how a repo's builds are made and run, keyed like agents */
  launchers: Record<string, LaunchSettings>;
  /** per-machine task overrides by repo path (core/tasks) */
  tasks: Record<string, TaskPatch[]>;
  /** the repos archived in canopy, by path like agents */
  archived: string[];
  /** the repos starred in canopy, by path like agents */
  favorites: string[];
  /** whether the server fetches the user's own local repos in the background
   *  (every REMOTE_REFRESH), so behind counts and remote tips stay current */
  fetch: boolean;
  /** Whether a shell's history is written to disk so it can be restored
   *  after the machine goes down. Off by default and deliberately: what a
   *  shell printed is whatever it printed, secrets included, and this keeps
   *  it in a file that outlives the process. */
  keepShells: boolean;
  /** whether canopy posts its runs, flows and fleets to tailchan: an end to
   *  its channel, a prompt or a gate waiting on you as a DM (which pings) */
  tailchanNotify: boolean;
  /** this machine's name among its peers; null until set */
  self: string | null;
  /** the machines this one pulls from (see docs/superpowers/specs/2026-09-23-peer-sync-design.md) */
  peers: Peer[];
  /** whether the peer pass runs: off, dry (report only) or on */
  peerSync: PeerSync;
  /** ignored files copied from a peer when a repo lacks them (names or simple globs) */
  seed: string[];
  /** the canopy backends a page served from here may connect to, in the
   *  order a client falls back through (see the multi-backend spec) */
  backends: BackendEntry[];
}

/* ---------- the launcher: release builds and pull requests, run here ---------- */

/** How canopy builds and runs a repo: its released builds, a pull request's
 *  checkout, or the checkout itself. Blank fields fall back to what a file's
 *  name says (asset, launch) or leave the step out (build, run). */
export interface LaunchSettings {
  /** a glob the release asset for this machine matches, `*-macos-arm64.dmg`;
   *  blank picks by the platform words in the names */
  asset: string;
  /** shell line run in a checkout before it can be launched; blank skips it */
  build: string;
  /** shell line that launches a checkout, run from its root; blank means the
   *  checkout cannot be launched */
  run: string;
  /** shell line that launches an installed release, `{file}` being the app or
   *  binary the download unpacked; blank opens it the way its kind says */
  launch: string;
}

export const DEFAULT_LAUNCH: LaunchSettings = { asset: "", build: "", run: "", launch: "" };

export interface ReleaseAsset {
  name: string;
  size: number;
  /** the public download address */
  url: string;
  /** the API address, which a private repo's download asks with a token */
  apiUrl: string;
}

/** One release as the forge lists it, with the asset canopy would install. */
export interface Release {
  tag: string;
  name: string;
  prerelease: boolean;
  /** unix ms; 0 for a draft */
  publishedAt: number;
  url: string;
  assets: ReleaseAsset[];
  /** the asset name that fits this machine, when one does */
  pick: string | null;
}

/** An open pull request, enough to check it out and say what it is. */
export interface Pull {
  number: number;
  title: string;
  author: string;
  /** the head branch */
  branch: string;
  draft: boolean;
  /** unix ms */
  updatedAt: number;
  url: string;
}

export type BuildKind = "release" | "pr" | "local";

/** Something the launcher can run: an installed release, a pull request's
 *  built checkout, or the repo's own checkout. Keys read `release:<tag>`,
 *  `pr:<number>` and `local`. */
export interface Build {
  key: string;
  kind: BuildKind;
  label: string;
  /** the folder it lives in: the unpacked release, the worktree, or the repo */
  dir: string;
  /** what a launch runs, one line; null when nothing in the folder can run */
  what: string | null;
  /** unix ms when it was installed or last built; 0 for the local checkout */
  at: number;
  launches: number;
  /** unix ms of the last launch */
  lastLaunch: number | null;
  /** a process canopy started from it is still going */
  running: boolean;
  /** the commit a pull request's checkout was built at */
  head?: string;
}

export type JobKind = "install" | "build";
export type JobStatus = "working" | "done" | "failed" | "stopped";

/** A download or a build in progress, with the tail of its output. */
export interface Job {
  id: string;
  repoId: string;
  kind: JobKind;
  /** the build key it produces */
  build: string;
  title: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** the last JOB_TAIL lines the process printed */
  lines: string[];
  /** bytes so far and in total for a download; total 0 when unknown */
  progress?: { done: number; total: number };
  error?: string;
}

/** how many lines of output a job keeps */
export const JOB_TAIL = 400;

export const isJobActive = (j: Job): boolean => j.status === "working";

/* ---------- agent settings: which harness starts, and how, for a repo ---------- */

/** The agent harnesses canopy starts: Claude Code and Codex. What differs
 *  between them (flags, resume, sessions) is a table in core/harness. */
export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const isHarness = (v: unknown): v is Harness => typeof v === "string" && (HARNESSES as readonly string[]).includes(v);

/** Model aliases the claude CLI takes; "default" leaves the choice to it.
 *  Codex takes any model name (core/harness has the rule). */
export const AGENT_MODELS = ["default", "fable", "opus", "sonnet", "haiku"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/** Every effort some harness takes; which harness takes which is in
 *  core/harness ("ultra" is codex's alone). */
export const AGENT_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** Applied wherever canopy starts an agent for the repo: a shell's agent,
 *  the agent opener, a herdr workspace, and the runs and chats in the
 *  browser. An entry saved before harnesses has no `harness` and reads as
 *  claude. */
export interface AgentSettings {
  harness: Harness;
  /** claude: one of AGENT_MODELS; codex: "default" or a model name */
  model: string;
  effort: AgentEffort;
  /** skip every permission prompt (claude's --dangerously-skip-permissions,
   *  bypassPermissions mode for a run; codex's
   *  --dangerously-bypass-approvals-and-sandbox). On by default: canopy is a
   *  cockpit for one's own repos, and a prompt nobody is watching just stalls. */
  yolo: boolean;
  /** anything else for the command line, split like a shell would */
  extra: string;
}

export const DEFAULT_AGENT: AgentSettings = {
  harness: "claude",
  model: "default",
  effort: "default",
  yolo: true,
  extra: "",
};

/** The kinds of work canopy starts an agent for: an interactive shell (the
 *  panel's own, a new agent shell, resume, the agent and herdr openers, the
 *  guided panel's asks), a chat and a job (the runner's two modes), a
 *  workflow step, and a commit-message suggestion. */
export const AGENT_ROLES = ["shell", "chat", "job", "flow", "suggest"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const isAgentRole = (v: unknown): v is AgentRole => typeof v === "string" && (AGENT_ROLES as readonly string[]).includes(v);

/** What a route points at: a named profile, or settings of its own. */
export type AgentPick = { profile: string } | AgentSettings;

/** One repo's override: a pick for every role, and picks per role that
 *  beat it. */
export interface RepoAgent {
  all?: AgentPick;
  roles?: Partial<Record<AgentRole, AgentPick>>;
}

/** A one-off choice at launch that beats every route: a profile by name, or
 *  a harness ("new codex shell"), which takes the route's own settings when
 *  they are that harness's and the first profile of that harness otherwise. */
export type LaunchPick = { profile: string } | { harness: Harness };

/** `GET /api/agents` and the `agents` event: the backend's whole routing. */
export interface AgentRoutes {
  /** every profile, `default` always among them */
  profiles: Record<string, AgentSettings>;
  roles: Partial<Record<AgentRole, AgentPick>>;
  /** the repo overrides by path */
  repos: Record<string, RepoAgent>;
}

/** Where resolved settings came from, first layer that answered winning. */
export const AGENT_LAYERS = ["explicit", "repo-role", "repo", "role", "default", "builtin"] as const;
export type AgentLayer = (typeof AGENT_LAYERS)[number];

/** A layer that named something but was passed over, and why: a profile
 *  that is gone, or a harness the role cannot run yet. */
export interface AgentSkip {
  from: AgentLayer;
  profile?: string;
  why: string;
}

export interface ResolvedAgent {
  settings: AgentSettings;
  from: AgentLayer;
  /** the profile the settings came from, when a profile pick answered */
  profile?: string;
  /** the layers above `from` that were passed over */
  skipped?: AgentSkip[];
}

/** `GET /api/agents/resolve?id=`: each role's resolved settings for one
 *  repo, and the harnesses the backend has. */
export interface AgentTable {
  roles: Record<AgentRole, ResolvedAgent>;
  harnesses: Harness[];
}

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
  /** on no remote yet: past the upstream, or on no remote-tracking branch at
   *  all when the branch has no upstream; the commits a push would send */
  unpushed?: true;
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

/** Apps a repo opens in. `agent` is the repo's agent itself (the shell
 *  role's harness): an interactive session in a terminal window at the repo,
 *  kitty when it is installed and Terminal otherwise. `herdr` is the same
 *  session inside a herdr workspace (herdr.dev, the terminal workspace
 *  manager for coding agents). Both start it with the repo's agent settings. */
export const OPENER_IDS = ["kitty", "terminal", "code", "finder", "agent", "herdr"] as const;
export type OpenerId = (typeof OPENER_IDS)[number];

/** The openers that start an agent rather than a plain app. */
export const AGENT_OPENERS: readonly OpenerId[] = ["agent", "herdr"];

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
  /** the device it was started from, when the request said */
  by?: string;
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
  | { type: "agents"; agents: AgentRoutes }
  | { type: "run"; run: Run }
  | { type: "run-gone"; id: string }
  | { type: "flow"; flow: Flow }
  | { type: "flow-gone"; id: string }
  | { type: "fleet"; fleet: Fleet }
  | { type: "fleet-gone"; id: string }
  | { type: "job"; job: Job }
  | { type: "job-gone"; id: string }
  /** a repo's builds changed outside a job: launched, exited, removed, or a
   *  job just installed or built one; the panel re-reads the list */
  | { type: "builds"; repoId: string; what: BuildChange; build: string }
  | { type: "launchers"; launchers: Record<string, LaunchSettings> }
  /** sent to the browsers on one address only: what their machine can open
   *  changed, a helper came or went */
  | { type: "helpers"; helpers: HelperInfo[] }
  /** the shells the server holds, whenever one starts, ends, or a socket
   *  joins or leaves; the whole list each time, no tmux reconcile behind it */
  | { type: "terms"; terms: TermInfo[] }
  /** the browsers on the event stream, whenever one comes or goes */
  | { type: "devices"; devices: Device[] }
  /** the shells left behind by a backend that went down, whenever the list
   *  changes: one is kept, restored or forgotten */
  | { type: "kept"; kept: KeptShell[] }
  | { type: "peers"; seen: PeerSeen[] }
  /** a repo's tasks, whenever one starts, stops, dies, is edited or a viewer comes or goes */
  | { type: "tasks"; repoId: string; tasks: TaskInfo[] }
  /** a tailchan message the UI's handle heard, or one the UI just sent */
  | { type: "chan"; message: ChanMessage }
  /** agent cards the broker changed, whole, and the ids of any it dropped
   *  (swept after a week); the home backend's alone, like `chan` */
  | { type: "registry"; cards: AgentCard[]; gone?: string[] };

export type BuildChange = "installed" | "built" | "launched" | "exited" | "removed";

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

/* ---------- shells: the ptys the server keeps for browser terminals ---------- */

/** the websocket close code for a socket that asked to rejoin a shell the
 *  server no longer holds (it exited, or the server restarted) */
export const TERM_GONE = 4404;

/** The two places a shell can live inside a window. */
export type ShellPlace = "panel" | "strip";

/** One pty the server holds, as `GET /api/terms` lists it: a browser that
 *  comes back reattaches to the ones it knows and adopts the rest. */
export interface TermInfo {
  /** the browser-made id the socket named it by */
  id: string;
  repoId: string;
  /** the repo's locator, where the shell landed */
  path: string;
  /** where the browser that opened it kept it */
  place: ShellPlace;
  /** whether a socket is on it right now */
  attached: boolean;
  /** the names of the devices with a socket on it, one each */
  viewers: string[];
  startedAt: number;
  /** when this shell was restored from what a lost one left behind; absent
   *  for a shell that has been running all along */
  restoredAt?: number;
  /** the tailchan handle the shell runs under, for one started while the
   *  backend knew a broker */
  handle?: string;
  /** the task this session runs, for a task's session; never set on a shell */
  task?: string;
}

/* ---------- tasks: a repo's named processes (core/tasks, server/tasks) ---------- */

/** which layer last said something about a task */
export type TaskSource = "detected" | "repo" | "canopy";

/** `stopped` is a task stopped by hand with its exit on record; `exited` is a clean exit 0 */
export type TaskStatus = "idle" | "running" | "exited" | "stopped" | "failed" | "backoff" | "gave-up";

export interface TaskFlags {
  /** the task the preview pairs with; one per repo */
  dev?: boolean;
  /** restarted when it fails and after the backend comes back */
  keep?: boolean;
  /** started when the repo's panel opens */
  withPanel?: boolean;
  /** left out of the list (a detected task you do not want) */
  hidden?: boolean;
}

/** a whole task, as detection or a merge produces it */
export interface TaskDef extends TaskFlags {
  name: string;
  /** one shell line, run from the repo root or `cwd` */
  cmd: string;
  /** relative to the repo root, never outside it */
  cwd?: string;
}

/** what one layer says about a task: a repo file or canopy's config may set
 *  only some fields of a task another layer defined */
export interface TaskPatch extends TaskFlags {
  name: string;
  cmd?: string;
  cwd?: string;
}

/** one task as the browser reads it: its merged definition and what it is doing */
export interface TaskInfo extends TaskDef {
  repoId: string;
  source: TaskSource;
  /** auto flags a repo file asked for that were not applied, since the repo is not the user's */
  suggested?: { keep?: true; withPanel?: true };
  /** the tmux session's id, 32 hex digits; the shell socket joins it */
  termId: string;
  status: TaskStatus;
  /** a session is there to join (running, or a dead pane not yet reaped) */
  live: boolean;
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number | null;
  /** when a keep task is due to be started again */
  retryAt?: number;
  /** restarts by keep running since the last manual start */
  restarts: number;
  viewers: string[];
  /** a task still running whose definition or repo is gone */
  gone?: "definition" | "repo";
}

export interface TasksResult {
  tasks: TaskInfo[];
  /** what was wrong with `.canopy/tasks.json` or the merge */
  errors: string[];
}

export type TaskAction = "start" | "stop" | "restart";

/** what `tasks/state.json` keeps per task, by termId */
export interface TaskRecord {
  repoId: string;
  path: string;
  name: string;
  want: "running" | "stopped";
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number | null;
  /** failures in a row under keep running, so a backoff survives a canopy restart */
  fails?: number;
  /** keep running gave up on it; only a start by hand clears this */
  gaveUp?: boolean;
}

export interface TaskLogLine {
  /** the line's number across the old and current log, from 1 */
  n: number;
  text: string;
  /** when the run this line belongs to started, ms; null before any marker */
  at: number | null;
  /** a start marker line */
  mark?: true;
}

export interface TaskLogPage {
  lines: TaskLogLine[];
  /** earlier lines match too */
  more: boolean;
}

/** One agent conversation started at a repo on the backend, which a shell on
 *  any device can pick back up: `claude --resume` or `codex resume`. */
export interface AgentSession {
  /** which harness it belongs to */
  harness: Harness;
  /** the harness's session id, a uuid */
  id: string;
  /** when its file was last written, ms */
  at: number;
  /** the file's size in bytes, a rough sense of how long it ran */
  size: number;
  /** the first thing typed into it, clipped */
  prompt: string | null;
  /** the summary Claude Code wrote for it, when it wrote one */
  summary: string | null;
  /** the branch it started on */
  branch: string | null;
}

/** the agent canopy can tell was running in a shell */
export type AgentKind = Harness;

/** What a shell left on disk for after the machine it ran on goes down.
 *  Written only while `keepShells` is on, one record per shell, with its
 *  history capped and old records dropped. A record whose session is still
 *  live is not offered: this is what is left of the ones that are not. */
export interface KeptShell {
  id: string;
  repoId: string;
  /** the repo's locator, where the shell was */
  path: string;
  place: ShellPlace;
  startedAt: number;
  /** when its history was last captured */
  savedAt: number;
  /** lines of history kept */
  lines: number;
  /** what was running in it when it was last looked at, when canopy could tell */
  agent: AgentKind | null;
}

/** A port something listens on at the backend's loopback, as the preview
 *  section offers it: the process behind it and the repo its working folder
 *  lies in, when the backend can see that process. */
export interface ListeningPort {
  port: number;
  /** the process's name (`node`, `bun`, `vite`), when it could be read */
  command?: string;
  /** the id of the repo the process runs in, when its cwd is inside one */
  repo?: string;
}

/** `GET /api/ports`: what listens, and whether previews can be served at all */
export interface PortsResult {
  ports: ListeningPort[];
  /** the preview ports canopy proxies through; empty when previews are off */
  slots: number[];
  /** `CANOPY_PREVIEW_PUBLIC`: each slot's public https name, `{slot}` for
   *  its number, for a page on canopy's public address */
  public?: string;
  /** `CANOPY_PREVIEW_HOST`: the tailnet IP another machine's plain http
   *  page frames this backend's slots at */
  host?: string;
}

/** `POST /api/preview`: the preview port a backend port is proxied on */
export interface PreviewSlot {
  slot: number;
  port: number;
}

/* ---------- tailchan: the tailnet message broker ---------- */

/** One message as the broker sends it. `handle` is the sender's declared
 *  name, `node` the tailnet machine it came from, `ts` unix ms. */
export interface ChanMessage {
  id: number;
  channel: string;
  handle: string;
  node: string;
  /** text, json, clip, object or event */
  kind: string;
  body: string;
  meta: Record<string, unknown>;
  ts: number;
}

/** A handle seen in the last day, `live` while it has a stream open. */
export interface ChanWho {
  handle: string;
  node: string;
  last_seen: number;
  live: boolean;
}

/** A channel the UI's handle can see; a DM is `dm.<a>+<b>`. */
export interface ChanChannel {
  name: string;
  topic: string;
  private: boolean;
  members: string[];
  count: number;
  last_ts: number | null;
  expires_at: number | null;
  subscribed: boolean;
}

/** What GET /api/tailchan answers: off, with why, or the broker's view. */
export type TailchanInfo =
  | { ready: false; reason: string }
  | {
      ready: true;
      /** the handle the UI speaks as */
      as: string;
      /** canopy's own handle and channel for what it posts */
      bot: string;
      channel: string;
      /** whether canopy posts its runs, flows and fleets */
      notify: boolean;
      who: ChanWho[];
      channels: ChanChannel[];
    };

/* ---------- the agent registry: every agent on the tailnet, as the broker keeps it ---------- */

export const AGENT_STATES = ["working", "idle", "waiting", "ended", "lost"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** the states an agent is still running in */
export const LIVE_AGENT_STATES: readonly AgentState[] = ["working", "idle", "waiting"];

export const isLiveAgent = (c: Pick<AgentCard, "state">): boolean => LIVE_AGENT_STATES.includes(c.state);

/** Where an agent card came from: a canopy shell or run (its hook saw
 *  `CANOPY_TERM` or `CANOPY_RUN`), a hooked agent anywhere else, or a
 *  backend's process scan (no hooks, so no session, handle or state). */
export type AgentOrigin = "canopy-shell" | "canopy-run" | "elsewhere" | "scan";

/**
 * One agent as tailchan's broker keeps it, field for field (the broker's
 * `AgentCard` in homelab/services/tailchan/server.ts). `node` is the
 * tailnet machine that wrote it, from WhoIs; the rest is what its hook or a
 * scan said. `repo` is the remote as a web url, the key cards join repo
 * cards on. A scan card has an empty `handle`, since nothing reads a DM for
 * it. Times are unix ms.
 */
export interface AgentCard {
  /** `${harness}:${session}` from a hook, `scan:${node}:${c|h}:${pid}` from a scan */
  id: string;
  /** what a DM goes to; "" on a scan card */
  handle: string;
  node: string;
  harness: Harness | "other";
  session: string | null;
  origin: AgentOrigin;
  cwd: string;
  repo: string | null;
  branch: string | null;
  model: string | null;
  /** the permission mode as the harness reports it */
  mode: string | null;
  state: AgentState;
  /** one line: what it waits on */
  waiting: string | null;
  caps: string[];
  offers: string[];
  /** page the human when this agent starts waiting while they are away */
  notifyIdle: boolean;
  where: {
    os: string;
    container: boolean;
    pid: number | null;
    /** TERM_PROGRAM: kitty, vscode, … */
    term: string | null;
    canopy: { backend: string; term?: string; run?: string } | null;
  };
  transcript: string | null;
  startedAt: number;
  seenAt: number;
  endedAt: number | null;
}

/** `GET /api/registry` (a 503 without a broker): every card the broker
 *  holds, live and the week's ended and lost ones */
export interface RegistryInfo {
  ready: true;
  cards: AgentCard[];
}

/** One agent process a backend's scan found, as `POST /v1/agents/scan`
 *  takes it: the repo (as a web url) and branch when its folder is in a
 *  scanned repo. */
export interface ScanProc {
  pid: number;
  harness: Harness;
  cwd: string;
  startedAt: number;
  repo?: string;
  branch?: string;
}

/** The scan's whole post: every agent in this pid namespace, which the
 *  broker makes this node's scan cards there. */
export interface ScanBody {
  /** whether the scan ran in a container, the pid namespace it names */
  container: boolean;
  procs: ScanProc[];
  /** darwin or linux */
  os?: string;
}
