import { parseAnswer } from "./answers";
import { ACTIONS, busyWith, splitMembers } from "../core/actions";
import { PREFLIGHT_HEADERS, corsHeaders, parseOrigins } from "../core/cors";
import { Library, libraryOriginAllowed, openBind, tailnetHost } from "../core/library";
import { PreviewProxy, parsePortRange, previewHostOk, previewable } from "../core/preview";
import { parsePreviewHost, parsePreviewPublic } from "../core/previewPublic";
import { listeningPorts, repoOfCwd } from "../core/ports";
import { watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { arch, homedir, hostname } from "node:os";
import { CANOPY_DIR, readBuild, readPkg } from "../core/build";
import { AdviceFiles } from "../core/improvements";
import { adviceMessage } from "../core/retro";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  commit,
  fetchRepo,
  getCommit,
  getDiff,
  getLog,
  isHash,
  pull,
  push,
  stageFile,
  UnknownCommitError,
  type DiffTarget,
} from "../core/git";
import { accessFromUrls, githubLogin, listRemotes, ownRemotes, pushAccess } from "../core/access";
import { linkArchived } from "../core/archive";
import { linkFavorites } from "../core/favorite";
import { linkPulls, parsePullCounts, PULLS_QUERY } from "../core/github";
import {
  HistoryError,
  historyOverview,
  historySearch,
  historySession,
  historySessions,
  locateHistory,
  openHistoryNote,
} from "../core/history";
import { browseLocal, browseRemote, expandHome, SshError } from "../core/browse";
import { builtinCheck, isBuiltinCheck } from "../core/builtincheck";
import { runCheck } from "../core/check";
import { exec, git, onHost, setSeedGit } from "../core/exec";
import { fleetSkipReason, Flows } from "../core/flow";
import { INHERITED_ENV, SECRET_ENV, isKeystroke, isTermId, parseTermMessage, Scrollback, shellArgs, startTerm, termPlace, termSize, type TermSession, type TermSize } from "../core/term";
import { attachTmuxTerm, hasSession, history, killSession, listSessions, newSession, paneInfo, paneText, sendLine, serverUp, snapshot, tmuxBase } from "../core/tmux";
import { clip, continueLine, countLines, expiredShells, forgetKept, KEEP_EVERY, listKept, lostShells, readKeptHistory, replayCommand, replayFile, restoredBanner, writeKept } from "../core/keep";
import { PASTE_MAX, pasteName, pasteText, savePaste } from "../core/paste";
import { apiBase, ForgeAuthError, linkForgeClones, listForgeRepos } from "../core/forge";
import { isSshHost, parseLocator, parseSshHosts, shellQuote, tildeQuote } from "../core/host";
import { readEvidence } from "../core/evidence";
import { FlowFiles, flowsDir, loadFlowRecords, lockFlows, type FlowsLock } from "../core/flowstore";
import { hasGatewayKey, jev, jevJudge } from "../core/jev";
import { isDefaultAgent, normalizeAgent } from "../core/agent";
import type { AgentEnv } from "../core/harness";
import { paneAgent } from "../core/procs";
import { effectiveAgents, hasProfile, isProfileName, launchPick, normalizePick, normalizeRepoAgent, pickRefusal, repoAgentRefusal } from "../core/route";
import { selfName } from "../core/backends";
import { Incubator, IncubatorError, incubatorWorkflow, type NoteSink, type Transcriber } from "../core/incubator";
import { seedOps } from "../core/seed";
import { SproutFiles } from "../core/sproutstore";
import { transcribeConfig, transcriber } from "../core/transcribe";
import { shipConfig, shipper, type Shipper } from "../core/shipper";
import { seedSource, type SeedSource } from "../core/seedsource";
import { vaultConfig, vaultNotes } from "../core/vault";
import { linkPeers, NO_PUSH, peerUrl } from "../core/peers";
import { initRepo, PassSeen, seedRepo, syncAll, syncRepo, takeWip, trackBranch } from "../core/peersync";
import { normalizeLaunch } from "../core/launch";
import { Launcher, LauncherError } from "../core/launcher";
import {
  agentLine,
  availableHarnesses,
  backendCaps,
  hostOpeners,
  isOpenerId,
  LoginHarnesses,
  missingHarness,
  openFile,
  openGroup,
  openIn,
} from "../core/openers";
import { clientKey, HELPER_PING, HELPER_TIMEOUT, helperRefusal, isLoopback, isLoopbackHost, parseDefaultGateway, parseHelperQuery, parseHelperReply, reachFrom, staleHelpers, type HelperAsk } from "../core/helper";
import { devicesOf, parseStream, type Stream } from "../core/presence";
import { mapPool, searchRepo } from "../core/search";
import { readActivity } from "../core/activity";
import { agentSessions, hasAgentSession, isSessionId, newestTranscript, resumeLine } from "../core/sessions";
import { BUNDLED_DIR, findWorkflow, loadWorkflows } from "../core/workflows";
import {
  launchSource,
  refreshRepo,
  repoRel,
  scanSource,
  type ScanOptions,
} from "../core/scan";
import {
  addSource,
  agentFor,
  agentRoutes,
  launchFor,
  loadConfig,
  rememberRoot,
  removeSource,
  removeWorkspace,
  setArchived,
  setFavorite,
  setKeepShells,
  setLaunch,
  setProfile,
  setRepoAgent,
  setRepoAll,
  setRole,
  setWorkspaceLook,
  upsertWorkspace,
} from "../core/store";
import { RememberedRules, scopeOf } from "../core/remember";
import { QUIET_WAIT, Runner } from "../core/runner";
import { NotWaitingError, type RunDriver } from "../core/driver";
import { ANSWERS_FILE, isSeedRepoId, SEED_AGENT_REFUSAL, SEEDS_DIR, withStoredAnswers } from "../core/sprout";
import { SeedMirrors } from "../core/seedmirror";
import { sweepCodexTrust } from "../core/codextrust";
import { seedBusy, seedBusyFor, seedHeld, seedRootsNow, setSeedBusy, setSeedRoots } from "../core/seedgit";
import { suggestMessage } from "../core/suggest";
import {
  HISTORY_WINDOWS,
  LAUNCH_SOURCE,
  RUN_ACTIONS,
  effectivePrimary,
  isAgentRole,
  isHarness,
  isWsColor,
  type AgentSettings,
  type AgentTable,
  type CanopyConfig,
  type Harness,
  type ClientInfo,
  type Device,
  type FlowChoice,
  type HelperInfo,
  type GrepRepoResult,
  type HistoryOverview,
  type HistoryWindow,
  type KeptShell,
  type ListeningPort,
  type PortsResult,
  type PreviewSlot,
  type Peer,
  type PeerBranch,
  type PeerSeen,
  type PeerState,
  type PullCount,
  type Repo,
  type RunAction,
  type Run,
  type WorkspaceScope,
  type ScanResult,
  type ServerEvent,
  type ShellPlace,
  type Source,
  type SourceInput,
  type Workflow,
  type SourceState,
  type TermInfo,
  type Workspace,
  type WsColor,
  TERM_GONE,
} from "../core/types";
import type { About, AdviceAccepted, AdviceEntry, IncubatorStages, RepoStatus } from "../core/types";
import { holdQuiet, type QuietHold, seedGitThrough, StageClient } from "../core/stageclient";
import { STAGE_AWAY } from "../core/stagewire";
import { DEFAULT_IGNORE } from "../core/scan";
import { ChanHub, PUT_MAX } from "./tailchan";
import { RegistryHub } from "./registry";
import { AskHub } from "./asks";
import { BODY_MAX as INTAKE_BODY_MAX, IncubatorHub, canopyRepoOf } from "./incubator";
import { SCAN_EVERY, type AgentProc } from "../core/agentscan";
import { TaskHub } from "./tasks";
import type { TaskTimings } from "../core/tasks";
import { shellHandle } from "../core/tailchan";
import { loadChanConfig, type ChanConfig } from "../core/chan";
import type { ServerWebSocket } from "bun";

/** One scanned folder as the server runs it: the source, its watcher when
 *  it is local, and the guard against rescanning for the same new .git. */
interface SourceRuntime {
  src: SourceState;
  watcher: FSWatcher | null;
  /** .git locations already rescanned for; stops repos that the scan cannot
   *  reach (deeper than maxDepth) from triggering a rescan on every write */
  probed: Set<string>;
  /** a scan of this source in flight, so callers share it */
  scanning: Promise<void> | null;
}

interface ServerState {
  /** the launch root */
  root: string;
  /** the line start=agent types into a new shell, for the settings its
   *  route resolved to and what its commands are to see */
  agentLine: (repo: Repo, agent: AgentSettings, env: AgentEnv) => Promise<string>;
  /** the agent harnesses this backend offers, looked up on each call so one
   *  installed while canopy runs is seen at the next scan: on this
   *  process's PATH, or found by the user's login shell */
  harnesses: () => Harness[];
  /** whether a harness is known to be missing here, the login shell asked
   *  again first when its last answer said so; false while that shell has
   *  not answered, so a start is refused only on an answer */
  harnessMissing: (h: Harness) => Promise<boolean>;
  /** which canopy this is, read once at start */
  about: About;
  /** every source, the launch root first */
  sources: SourceRuntime[];
  /** all sources' repos in one tree, rebuilt after any source scan */
  result: ScanResult;
  /** directory names the scan and the watcher both skip */
  ignore: string[];
  /** GitHub identity: undefined = not asked yet, null = gh gave none (asked
   *  again every activity pass, see `retryLogin`) */
  login?: string | null;
  /** push permission memo, keyed "owner/name" — see core/access */
  access: Map<string, boolean | null>;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  /** what each event stream said about its browser, for the streams that
   *  said anything; `devicesOf` folds them into the devices list */
  streams: Map<ReadableStreamDefaultController<Uint8Array>, Stream>;
  /** the helpers dialled in, by name; a browser opens through the one it
   *  picked (or adopted by address, see `clientCaps` in core/client) */
  helpers: Map<string, Helper>;
  /** the address a browser has when docker's proxy is what delivered it:
   *  the container's default gateway, null off Linux */
  gateway: string | null;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Claude Code jobs, one live session per repo at most */
  runner: Runner;
  /** the rules an allow said to remember, answering runs' permissions */
  remembered: RememberedRules;
  /** workflow runs, step by step, over the runner's jobs */
  flows: Flows;
  /** the claude-history overview, kept for HISTORY_TTL and for one scan */
  history: HistoryCache | null;
  /** an overview being built, so concurrent callers share it */
  historyPending: Promise<HistoryCache> | null;
  /** the shells behind browser terminals, by the id the browser gave each;
   *  a shell outlives its socket, and the server too when tmux holds it */
  terms: Map<string, LiveTerm>;
  /** the argv front for canopy's tmux server, or null for plain ptys (no
   *  tmux on PATH, or CANOPY_TMUX=0), which end with the server */
  tmux: string[] | null;
  /** installed releases, pull request builds and launched processes */
  launcher: Launcher;
  /** tailchan: the routes, the stream as the UI's handle, canopy's posts */
  chan: ChanHub;
  /** a repo's named processes on tmux (server/tasks) */
  tasks: TaskHub;
  /** open pull request counts by GitHub slug, from the last activity pass */
  pulls: Map<string, PullCount>;
  /** the paths of the repos archived in canopy, kept in step with the
   *  config so a rebuild, which cannot wait on a read, can mark them */
  archived: Set<string>;
  /** the paths of the repos starred in canopy, kept the same way */
  favorites: Set<string>;
  /** the names of each repo's own remotes, by path, settled once per repo:
   *  what the background fetch pulls and where a tip may come from */
  own: Map<string, string[]>;
  /** the peer list `own` was last filtered against, from the last
   *  whole-tree pass's own settings read; a change (a peer added, removed
   *  or renamed) clears `own` so a same-named remote is judged again.
   *  ownRemotesOf reads only this, never the disk, so a peer change is
   *  noticed the next time a pass runs rather than the next time a repo's
   *  own-remotes memo happens to miss (which, once every repo is warm,
   *  might be never). */
  peerNamesSeen: Peer[];
  /** peer sync outcomes by repo id, from the last whole-tree pass or a
   *  per-repo action; what `linkPeers` attaches to each repo as `.peers` */
  peerStates: Map<string, PeerState>;
  /** each peer's reachability from the last whole-tree pass */
  peerSeen: PeerSeen[];
  /** per repo id, the branch+peer pairs already reported diverged, so the
   *  notice fires once for each divergence */
  divergedSeen: Map<string, Set<string>>;
  /** repo paths whose peer remotes were set up (a non-dry initRepo) this
   *  process, so a restart or a dry-to-on flip sets them up again */
  inited: Set<string>;
  /** the current occupant of the peering queue (a whole-tree pass, or a
   *  route action), whichever is running or next in line; see withPeering */
  peering: Promise<void> | null;
  /** the whole-tree pass currently pending (queued or running), if any: a
   *  second refreshPeers call while this is set joins it instead of
   *  queueing a duplicate pass behind it */
  pendingPass: Promise<void> | null;
  /** canopy's mirror of each seed, which the peer gate serves in its place
   *  (seedmirror.ts, amendment 4) */
  mirrors: SeedMirrors;
  /** whether seeds stay out of the peer pass, the peer routes, the
   *  background fetch and the clone of what a peer has: on an isolated
   *  backend, where canopy runs no git in a seed */
  seedsStayHome: boolean;
  /** an activity pass under way, so the timer never stacks a second one */
  activity: Promise<void> | null;
  /** the shells a machine going down left behind, the ones no live session
   *  answers for; what the browser is offered to restore */
  kept: KeptShell[];
  /** a snapshot pass under way, so the timer never stacks a second one */
  keeping: Promise<void> | null;
  /** the in-app browser's preview ports; null when previews are off */
  preview: PreviewProxy | null;
  /** the agent registry: this machine's scan posted to the broker, and the
   *  broker's cards followed for `/api/registry` */
  registry: RegistryHub;
  /** asks for a human: the broker's open asks followed for the inbox,
   *  answers, presence and guards through the answer token */
  asks: AskHub;
  /** new projects carried from an idea through clarify and on (core/incubator.ts) */
  incubator: IncubatorHub;
  /** the name this backend goes by (`selfName`), read at start; what a
   *  shell's `CANOPY_BACKEND` says */
  backendName: string;
  /** where a shell on this machine reaches this server, `CANOPY_API`; null
   *  until the server listens */
  apiUrl: string | null;
}

/** One shell the server holds and the sockets on it. On a plain pty the
 *  one session is shared and its output kept for the next socket; on tmux
 *  the shell is a session there and every socket runs a client of its own
 *  (`TermSocket.client`), so `pty` is null. */
interface LiveTerm {
  info: TermInfo;
  pty: { session: TermSession; scrollback: Scrollback } | null;
  sockets: Set<ServerWebSocket<TermSocket>>;
  /** set once DELETE has asked tmux to end it, so a client's exit is told apart from the shell's own */
  ending?: boolean;
  /** when a browser last typed into it (a keystroke frame, not a
   *  terminal's own reply), for `/api/terms/watched` */
  lastInput?: number;
}

/** how long after a keystroke a shell counts as watched: its agent's asks
 *  stay at the terminal someone is at */
export const WATCH_SPAN = 2 * 60_000;

/** what a terminal websocket carries from the upgrade to its handlers */
interface TermSocket {
  repo: Repo;
  /** the browser's name for the shell */
  id: string;
  place: ShellPlace;
  /** only rejoin a held shell; a name the server does not hold is gone */
  attach: boolean;
  /** type the agent's line in once, if this socket starts the shell: the
   *  settings the shell route resolved to, with the launch pick applied */
  start: AgentSettings | null;
  /** why a start cannot go ahead (its harness is not here), said by
   *  closing the socket before any shell starts */
  refused: string | null;
  /** the first message for the agent, its argument on that line; empty for none */
  prompt: string;
  cols: number;
  rows: number;
  /** the device this socket belongs to, by its stream's id, for `viewers` */
  device: string | null;
  live?: LiveTerm;
  /** on tmux, this socket's own client on the session */
  client?: TermSession;
  /** what arrived while the shell was still starting, sent once it is up */
  pending?: (string | Uint8Array)[];
}

/** a helper on its websocket: what it registered and the intents it has
 *  not answered yet, by id */
interface Helper {
  info: HelperInfo;
  ws: ServerWebSocket<Socket>;
  pending: Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  next: number;
  /** when this end last heard from the helper, a pong included */
  seen: number;
}

/** what a helper websocket carries: its registration (the address it
 *  dialled from is in it); `kind` tells the two socket kinds apart */
interface HelperSocket {
  kind: "helper";
  info: HelperInfo;
}

type Socket = (TermSocket & { kind: "term" }) | HelperSocket;

/** what a headless backend answers when asked to run a desktop opener or the
 *  launcher: they are macOS GUI commands, so a container cannot do them, and
 *  the client's own machine is where such a thing belongs */
const NO_DESKTOP = "this canopy backend has no desktop; openers run on your own machine";

/** what the open routes answer when the browser named no attached helper and
 *  is not on a Mac that runs canopy */
const NO_HELPER = "no canopy helper is attached for this browser; run `canopy helper` on your machine and pick it in settings";

/** What the backend knows about a browser at `key`: its address, whether
 *  it is on this machine (`here`, see `onThisMachine`) with a desktop of its
 *  own, and whether it is the address docker's proxy hands a container for
 *  every client. */
function clientInfo(state: ServerState, key: string, here: boolean): ClientInfo {
  return { address: key, local: here && hostOpeners(), shared: key === state.gateway };
}

/** Whether a request comes from a browser on this machine: from loopback,
 *  for a loopback name. A tunnel or reverse proxy on this Mac connects from
 *  loopback too, but for a browser that asked for its public name from
 *  somewhere else, and an opener clicked there must not open here. */
const onThisMachine = (key: string, url: URL): boolean => isLoopback(key) && isLoopbackHost(url.hostname);

/** The container's default gateway on Linux, null elsewhere or when the
 *  route table cannot be read: a published-port connection through docker's
 *  userland proxy reaches the container from that address. */
async function defaultGateway(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    return parseDefaultGateway(await readFile("/proc/net/route", "utf8"));
  } catch {
    return null;
  }
}

const helperList = (state: ServerState): HelperInfo[] => [...state.helpers.values()].map((h) => h.info);

/** the helper list to every stream, on any attach or detach */
function tellHelpers(state: ServerState): void {
  broadcast(state, { type: "helpers", helpers: helperList(state) });
}

/** one intent to the helper `name`, settled by its reply or the timeout */
function askHelper(state: ServerState, name: string, intent: HelperAsk): Promise<void> {
  const helper = state.helpers.get(name);
  if (!helper) return Promise.reject(new HttpError(400, NO_HELPER));
  const refused = helperRefusal(helper.info, intent);
  if (refused) return Promise.reject(new HttpError(400, refused));
  const id = helper.next++;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      helper.pending.delete(id);
      reject(new HttpError(504, `the helper ${helper.info.name} did not answer in time`));
    }, HELPER_TIMEOUT);
    helper.pending.set(id, { resolve, reject, timer });
    helper.ws.send(JSON.stringify({ id, ...intent }));
  });
}

/** a helper's reply lands on the intent it names */
function helperReplied(state: ServerState, name: string, text: string): void {
  const helper = state.helpers.get(name);
  const reply = parseHelperReply(text);
  if (!helper || !reply) return;
  const p = helper.pending.get(reply.id);
  if (!p) return;
  helper.pending.delete(reply.id);
  clearTimeout(p.timer);
  if ("ok" in reply) p.resolve();
  else p.reject(new HttpError(502, `${helper.info.name}: ${reply.error}`));
}

/** the helper `name` goes: its waiting intents fail, every stream hears */
function dropHelper(state: ServerState, name: string, ws: ServerWebSocket<Socket>): void {
  const helper = state.helpers.get(name);
  if (!helper || helper.ws !== ws) return;
  state.helpers.delete(name);
  for (const p of helper.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new HttpError(502, `the helper ${helper.info.name} went away`));
  }
  tellHelpers(state);
}

/** anything from a helper, a pong included, says its machine is still there */
function helperSeen(state: ServerState, name: string, ws: ServerWebSocket<Socket>): void {
  const helper = state.helpers.get(name);
  if (helper && helper.ws === ws) helper.seen = Date.now();
}

/** Ping every helper and drop the ones that have not answered inside the
 *  deadline. A client that dies with its machine sends no close frame, so
 *  without this its entry would sit in the list for good: the browser would
 *  keep offering a helper that is not there and every open through it would
 *  wait out `HELPER_TIMEOUT` before failing. */
function sweepHelpers(state: ServerState): void {
  const peers = [...state.helpers.values()].map((h) => ({ name: h.info.name, seen: h.seen }));
  for (const name of staleHelpers(peers, Date.now())) {
    const helper = state.helpers.get(name);
    if (!helper) continue;
    helper.ws.close(1001, "no answer from this helper");
    dropHelper(state, name, helper.ws);
  }
  for (const h of state.helpers.values()) if (h.ws.readyState === WebSocket.OPEN) h.ws.ping();
}

/** Where a click lands: on the helper the browser named (`helper` in the
 *  body, its pick or the one it adopted), on the backend's own desktop for
 *  a browser on a Mac that runs it, or nowhere (400 saying what is
 *  missing). A helper reaches the backend's repos over ssh through
 *  `CANOPY_SSH_HOST`, so a local path is rewritten to that locator on the
 *  way; a repo already elsewhere keeps its own. */
type OpenVia = { via: "backend" } | { via: "helper"; name: string };

function openVia(state: ServerState, here: boolean, helper: unknown): OpenVia {
  if (typeof helper === "string" && helper !== "") {
    if (state.helpers.has(helper)) return { via: "helper", name: helper };
    throw new HttpError(400, `the helper ${helper} is not attached; ${NO_HELPER}`);
  }
  if (here && hostOpeners()) return { via: "backend" };
  // Attached helpers are not picked for a browser automatically when the
  // proxy hides its address, so name them: the fix is one pick in settings.
  const names = [...state.helpers.keys()];
  const missing = names.length > 0
    ? `this browser has not picked a helper; pick ${names.join(" or ")} under desktop openers in settings`
    : NO_HELPER;
  throw new HttpError(400, hostOpeners() ? missing : `${NO_DESKTOP}; ${missing}`);
}

function helperPath(path: string): string {
  const r = reachFrom(path, process.env.CANOPY_SSH_HOST || null);
  if (typeof r === "string") return r;
  throw new HttpError(400, r.error);
}

/** what a socket's keystrokes and resizes go to */
const sessionOf = (ws: ServerWebSocket<TermSocket>): TermSession | undefined => ws.data.client ?? ws.data.live?.pty?.session;

/** one frame from the browser to the shell: keystrokes, or a resize */
function relay(session: TermSession, msg: string | Uint8Array) {
  if (typeof msg === "string") {
    const m = parseTermMessage(msg);
    if (m?.kind === "resize") session.resize(m.size);
    return;
  }
  session.write(msg);
}

/** Every shell, as the browser reads the list. On tmux the sessions there
 *  are the truth (another canopy on the same config dir may have made or
 *  ended one), so the map is brought in line with them first. */
async function listTerms(state: ServerState): Promise<TermInfo[]> {
  if (state.tmux) {
    const seen = new Set<string>();
    for (const s of await listSessions(state.tmux)) {
      seen.add(s.id);
      if (state.terms.has(s.id)) continue;
      state.terms.set(s.id, {
        info: { id: s.id, repoId: s.repoId, path: s.path, place: s.place, attached: false, viewers: [], startedAt: s.createdAt, ...(s.handle ? { handle: s.handle } : {}), ...(s.task ? { task: s.task } : {}) },
        pty: null,
        sockets: new Set(),
      });
    }
    // deleting the current entry while iterating a Map is defined behaviour
    for (const id of state.terms.keys()) if (!seen.has(id)) state.terms.delete(id);
  }
  return [...state.terms.values()].filter((t) => !t.info.task).map((t) => termInfo(state, t));
}

/** Ends a shell by id; false when there is none. On a pty the exit hook
 *  drops it; on tmux the session is killed and its clients follow. */
async function endTerm(state: ServerState, id: string): Promise<boolean> {
  const live = state.terms.get(id);
  if (!state.tmux) {
    if (!live?.pty) return false;
    live.pty.session.close();
    return true;
  }
  if (!live && !(await hasSession(state.tmux, id))) return false;
  if (live) live.ending = true;
  await killSession(state.tmux, id);
  state.terms.delete(id);
  // a snapshot pass that had this shell in hand may still be writing its
  // record; forgetting after it is done is what makes the forget stick
  await state.keeping;
  await forgetKept(id);
  tellTerms(state);
  return true;
}

/* ---------- what a shell leaves behind (core/keep) ---------- */

/** Writes out what every shell the server holds has on its screen and in
 *  its history. Only while `keepShells` is on: this is whatever the shell
 *  printed, and it lands in a file that outlives the process. */
async function snapshotShells(state: ServerState): Promise<void> {
  const tmux = state.tmux;
  if (!tmux) return;
  for (const live of state.terms.values()) {
    if (live.info.task) continue;
    const { id, repoId, path, place, startedAt } = live.info;
    try {
      const [text, pane] = await Promise.all([snapshot(tmux, id), paneInfo(tmux, id)]);
      // tmux would not say: the session or its whole server is gone (the
      // shells container restarted under this server), and the record the
      // last good pass wrote is exactly what a restore wants, so it stays
      if (text === null || pane === null) continue;
      // ended while this pass was on it: the end forgets the record, and
      // writing it now would put it back on offer
      if (live.ending || state.terms.get(id) !== live) continue;
      const history = clip(text);
      const agent = await paneAgent(pane);
      const rec: KeptShell = { id, repoId, path, place, startedAt, savedAt: Date.now(), lines: countLines(history), agent };
      await writeKept(rec, history);
    } catch {
      // a shell that ended while the pass was running; the next one is right
    }
  }
}

/** The records on disk, minus the ones past the retention window and the
 *  ones a live session answers for: what is left is offered to restore.
 *  Broadcast when the list changed. */
async function refreshKept(state: ServerState): Promise<KeptShell[]> {
  const all = await listKept();
  const gone = new Set(expiredShells(all, Date.now()));
  for (const id of gone) await forgetKept(id);
  const kept = lostShells(
    all.filter((k) => !gone.has(k.id)),
    state.terms.keys(),
  );
  const same = kept.length === state.kept.length && kept.every((k, i) => state.kept[i]?.id === k.id && state.kept[i]?.savedAt === k.savedAt);
  state.kept = kept;
  if (!same) broadcast(state, { type: "kept", kept });
  return kept;
}

/** one snapshot pass and the refresh behind it, never two at once */
function keepPass(state: ServerState): Promise<void> {
  if (state.keeping) return state.keeping;
  const pass = (async () => {
    const cfg = await loadConfig();
    if (cfg.keepShells) await snapshotShells(state);
    await refreshKept(state);
  })()
    .catch(() => {})
    .finally(() => {
      state.keeping = null;
    });
  state.keeping = pass;
  return pass;
}

/** The name this backend goes by in a refusal: its peer name, else its
 *  host's, the same one the multi-backend registry uses. */
async function machineName(): Promise<string> {
  return selfName((await loadConfig()).self, hostname());
}

/** Why a start on a harness at `path` is refused, or null: a harness this
 *  backend lacks is refused before any shell starts, in words the UI shows
 *  as they are ("codex is not installed on mini"), not a shell that dies at
 *  once. A repo on another host runs its agent there, over ssh, so what is
 *  installed here says nothing about it. */
async function harnessRefusal(state: ServerState, h: Harness, path: string): Promise<string | null> {
  if (parseLocator(path).host !== null) return null;
  return (await state.harnessMissing(h)) ? missingHarness(h, await machineName()) : null;
}

async function needHarness(state: ServerState, h: Harness, path: string): Promise<void> {
  const why = await harnessRefusal(state, h, path);
  if (why) throw new HttpError(400, why);
}

/** Starts a built-in action's run on a repo, after the checks every run
 *  route makes: the repo is a folder on this machine (not on another host,
 *  not a forge listing), no workflow or other run has it, and its route's
 *  harness is installed here. A workspace run (`scope`) is Claude Code's
 *  alone for now, since its other folders go in as --add-dir. */
async function startRepoRun(
  state: ServerState,
  repo: Repo,
  action: RunAction,
  note: string,
  client: unknown,
  scope?: WorkspaceScope,
): Promise<Run> {
  // The runner spawns the agent here, at the repo's path; there is no
  // agent to spawn at a folder on another host.
  if (repo.host) throw new HttpError(400, `agent runs only work on this machine; ${repo.name} is on ${repo.host}`);
  // A forge repo is a listing with a web address for a path. The repo
  // route's own gate stops it first; a workspace whose primary was put
  // there by hand reaches here.
  if (repo.forge) throw new HttpError(400, `${repo.name} is on the forge; an agent runs in a folder on this machine`);
  // A workflow owns the repo while it runs, gate included: a second
  // agent here would make the flow's next step throw and die.
  if (state.flows.activeFor(repo.id)) throw new HttpError(409, "a workflow is running here");
  const busy = state.runner.activeFor(repo.id);
  if (busy) throw new HttpError(409, busyWith(repo.name, busy.verb));
  const agent = agentFor(await loadConfig(), repo.path, action === "chat" ? "chat" : "job");
  // Before the workspace and install checks, so a workspace propose on
  // Codex hears what is wrong with the action, not with the workspace.
  if (action === "propose" && agent.harness !== "claude") throw new HttpError(400, "plan, then build needs Claude Code");
  if (scope && agent.harness !== "claude") throw new HttpError(400, "workspace runs need Claude Code");
  await needHarness(state, agent.harness, repo.path);
  // the device it was started from, when the browser said and is on the stream
  const by = deviceNameOf(state, typeof client === "string" ? client : null) ?? undefined;
  return state.runner.start(repo, action, ACTIONS[action], note, agent, by, scope);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON body that must be an object. Bad JSON, null or an array is a 400
 *  here, not the TypeError reading a field off one would turn into a 500. */
async function objectBody(req: Request): Promise<Record<string, unknown>> {
  const raw: unknown = await req.json().catch(() => null);
  if (!isRecord(raw)) throw new HttpError(400, "malformed body");
  return raw;
}

/** A workflow whose steps name an agent profile this backend has not got
 *  is refused before anything starts, rather than quietly running that step
 *  on the repo's flow route instead. */
function stepProfileRefusal(cfg: CanopyConfig, wf: Workflow): string | null {
  const profiles = agentRoutes(cfg).profiles;
  const step = wf.steps.find((s) => s.agent && !hasProfile(profiles, s.agent));
  return step ? `step ${step.name} of ${wf.name} names agent profile ${step.agent ?? ""}, which this backend does not have` : null;
}

/** The settings a workflow step's run starts with on a repo: the step's own
 *  `agent:` profile as the explicit pick, else the repo's flow route. */
const stepAgentFor = (cfg: CanopyConfig, path: string, profile: string | undefined): AgentSettings =>
  agentFor(cfg, path, "flow", profile ? { profile } : undefined);

/** No incubator stage runs with permissions bypassed, whatever the routes
 *  say: a seed may be a stranger's clone, and the stage is unattended. Yolo
 *  is off, and a route's extra flags are dropped, since they could carry a
 *  bypass of their own (`--dangerously-skip-permissions`, a codex sandbox
 *  override) that no list of words would surely catch. */
const stageAgent = (a: AgentSettings): AgentSettings => ({ ...a, yolo: false, extra: "" });

/** What accepting a piece of retro advice does (amendment 5, ruling 12). A
 *  workflow of the user's own, in the config dir, is opened on this
 *  backend's desktop when it has one, else named for the page to show. A
 *  bundled workflow, or advice with no file, opens a chat on canopy's own
 *  checkout, idle: the lesson and its edit come back as a draft for the
 *  page's message box, and no agent starts until the user reads it and
 *  sends it. The text is an agent's, so it is never sent on the user's
 *  behalf. The chat's agent is the repo's chat route with yolo off and its
 *  extra flags dropped, as a stage's is; the user's own allow rules still
 *  apply, as in any chat they start. */
async function acceptAdvice(state: ServerState, entry: AdviceEntry): Promise<AdviceAccepted> {
  const wf = entry.file ? findWorkflow(await loadWorkflows({ path: "", host: "none" }), entry.file) : undefined;
  if (wf?.source === "user") {
    let opened = false;
    if (hostOpeners()) opened = await openFile(dirname(wf.file), basename(wf.file), 1).then(
      () => true,
      () => false,
    );
    return { kind: "file", path: wf.file, opened, ...(entry.edit ? { edit: entry.edit } : {}) };
  }
  const repo = await canopyRepoOf(state.result.repos, CANOPY_DIR, readPkg().homepage, realpath);
  if (!repo) throw new IncubatorError(409, "canopy's own checkout is not in this backend's scan, so there is no repo to open the chat on");
  if (state.flows.activeFor(repo.id) || state.runner.activeFor(repo.id)) throw new IncubatorError(409, `${repo.name} has a run or a workflow going; accept this once it ends`);
  const agent = { ...agentFor(await loadConfig(), repo.path, "chat"), yolo: false, extra: "" };
  await needHarness(state, agent.harness, repo.path);
  // the bundled file as the checkout holds it, not where this process runs from
  const file = wf ? join("lib", "workflows", relative(BUNDLED_DIR, wf.file)) : null;
  const run = state.runner.start(repo, "chat", ACTIONS.chat, "", agent);
  // the run itself, so the page shows the chat before its event lands
  return { kind: "chat", runId: run.id, repoId: repo.id, run, draft: adviceMessage(entry, file) };
}

/** whether a repo is a sprout's seed, by its path under the launch root:
 *  true before the incubator has taken its records back, so a flow restored
 *  first is held to the same rule */
export const isSeedPath = (root: string, path: string): boolean => path.startsWith(join(root, SEEDS_DIR) + sep);

/** Every harness a workflow's steps would start on for these repos is
 *  installed here, checked before the first step starts. */
async function needStepHarnesses(state: ServerState, cfg: CanopyConfig, wf: Workflow, paths: string[]): Promise<void> {
  const needed = new Map<Harness, string>();
  for (const path of paths) for (const s of wf.steps) if (s.body) needed.set(stepAgentFor(cfg, path, s.agent).harness, path);
  for (const [h, path] of needed) await needHarness(state, h, path);
}

/** A shell running again under the name it had, at the same repo, with what
 *  it printed before the machine went down ahead of it and a banner saying
 *  where that came from. The processes that were in it are gone: the agent
 *  that was running is offered as a line to run, not resumed. */
async function restoreTerm(state: ServerState, id: string, size: TermSize, resume: boolean): Promise<TermInfo> {
  const tmux = state.tmux;
  if (!tmux) throw new HttpError(400, "this backend holds shells on plain ptys, which nothing outlives");
  const rec = state.kept.find((k) => k.id === id);
  if (!rec) throw new HttpError(404, "no shell kept under that name");
  if (state.terms.has(id) || (await hasSession(tmux, id))) throw new HttpError(409, "that shell is running already");
  if (!state.result.repos.some((r) => r.id === rec.repoId)) throw new HttpError(400, `the repo that shell was in is not in the scan: ${rec.repoId}`);
  // the harness that was running, with the repo's own flags for it when its
  // shell route is that harness; checked before anything is undone
  let line: string | null = null;
  if (resume && rec.agent) {
    if (isSeedPath(state.root, rec.path)) throw new HttpError(400, SEED_AGENT_REFUSAL);
    await needHarness(state, rec.agent, rec.path);
    const env = shellEnv(state, rec.repoId, rec.path, id);
    line = continueLine(rec.agent, agentFor(await loadConfig(), rec.path, "shell", { harness: rec.agent }), env);
  }
  // The replay runs in the pane, ahead of the shell, so what the lost shell
  // had becomes this session's own tmux history: every client that attaches,
  // now or tomorrow, gets it the way it gets any other history. The record
  // goes first and the replay file is written after it, since forgetting a
  // shell takes any replay file with it.
  const history = await readKeptHistory(id);
  await forgetKept(id);
  const file = await replayFile(id, history);
  const shell = shellArgs(rec.path);
  const command = file ? replayCommand(file, restoredBanner(new Date(rec.savedAt).toLocaleString()), shell) : shell;
  try {
    await newSession(
      tmux,
      { id, repoId: rec.repoId, path: rec.path, place: rec.place, ...handleOf(state, rec.repoId, rec.path, id), env: canopyEnv(state, rec.repoId, rec.path, id) },
      size,
      command,
    );
  } catch (e) {
    // nothing will read the replay now, and the retention sweep only knows
    // about records
    await forgetKept(id);
    throw e;
  }
  const at = Date.now();
  const live: LiveTerm = {
    info: { id, repoId: rec.repoId, path: rec.path, place: rec.place, attached: false, viewers: [], startedAt: at, restoredAt: at, ...handleOf(state, rec.repoId, rec.path, id) },
    pty: null,
    sockets: new Set(),
  };
  state.terms.set(id, live);
  if (line) {
    // the shell has to be up to read it; send-keys is input, not a command
    await Bun.sleep(400);
    await sendLine(tmux, id, line);
  }
  tellTerms(state);
  await refreshKept(state);
  return termInfo(state, live);
}

/** A new shell at a repo under the browser's name, with an agent
 *  conversation from that repo picked back up in it: `claude --resume` or
 *  `codex resume`, with the repo's settings for that harness, typed in once
 *  the shell is up, so quitting the agent leaves the shell at the repo. The
 *  browser's tab then joins it like any held shell, and so does every other
 *  device's. */
async function resumeTerm(
  state: ServerState,
  repo: Repo,
  id: string,
  place: ShellPlace,
  session: string,
  harness: Harness,
  size: TermSize,
): Promise<TermInfo> {
  if (repo.host) throw new HttpError(400, "conversations are read off this machine; a repo on another host has none here");
  if (!(await hasAgentSession(harness, repo.path, session))) throw new HttpError(404, `no ${harness} conversation under that id at this repo`);
  if (state.terms.has(id) || state.kept.some((k) => k.id === id)) throw new HttpError(409, "that shell name is taken");
  await needHarness(state, harness, repo.path);
  const env = shellEnv(state, repo.id, repo.path, id);
  const line = resumeLine(session, agentFor(await loadConfig(), repo.path, "shell", { harness }), env);
  const tmux = state.tmux;
  let live: LiveTerm;
  if (tmux) {
    if (await hasSession(tmux, id)) throw new HttpError(409, "that shell name is taken");
    await newSession(tmux, { id, repoId: repo.id, path: repo.path, place, ...handleOf(state, repo.id, repo.path, id), env: canopyEnv(state, repo.id, repo.path, id) }, size);
    live = {
      info: { id, repoId: repo.id, path: repo.path, place, attached: false, viewers: [], startedAt: Date.now(), ...handleOf(state, repo.id, repo.path, id) },
      pty: null,
      sockets: new Set(),
    };
    state.terms.set(id, live);
    tellTerms(state);
    // the shell has to be up to read it; send-keys is input, not a command
    await Bun.sleep(400);
    await sendLine(tmux, id, line);
  } else {
    live = openPtyTerm(state, { repo, id, place, attach: false, start: null, refused: null, prompt: "", device: null, ...size }, size);
    await Bun.sleep(400);
    live.pty?.session.write(`${line}\r`);
  }
  return termInfo(state, live);
}

/** the longest first message a new agent shell takes off its socket's url */
const PROMPT_MAX = 6000;

/** The agent's line into a shell this socket just started, after the same
 *  beat resume waits for the shell to read input, with the first message as
 *  its argument: either harness takes it as the conversation's first turn
 *  once its own start-up (the folder trust question among it) is through,
 *  which typing it in later cannot be sure of. */
async function typeAgent(state: ServerState, live: LiveTerm, repo: Repo, agent: AgentSettings, prompt: string): Promise<void> {
  const base = await state.agentLine(repo, agent, shellEnv(state, live.info.repoId, live.info.path, live.info.id));
  const line = prompt ? `${base} ${shellQuote(prompt)}` : base;
  await Bun.sleep(400);
  if (state.tmux) await sendLine(state.tmux, live.info.id, line);
  else live.pty?.session.write(`${line}\r`);
}

/** What the agent in a canopy shell hands its own commands, beside what the
 *  shell already has: its tailchan handle and where it runs (`canopyEnv`),
 *  which a harness that filters its commands' environment (codex) would
 *  otherwise drop. */
function shellEnv(state: ServerState, repoId: string, path: string, id: string): AgentEnv {
  const handle = handleOf(state, repoId, path, id).handle;
  return { ...(handle ? { TAILCHAN_AS: handle } : {}), ...canopyEnv(state, repoId, path, id) };
}

/** Where a new shell runs, in its environment, so an agent's hook can put
 *  it on the registry card (`where.canopy`) and call back: the shell's id,
 *  this backend's name, the repo's id here, and this server's address on
 *  the machine's loopback. None for an ssh line, which would leave them on
 *  this side of the connection. */
function canopyEnv(state: ServerState, repoId: string, path: string, id: string): Record<string, string> {
  if (parseLocator(path).host !== null) return {};
  return {
    CANOPY_TERM: id,
    CANOPY_BACKEND: state.backendName,
    CANOPY_REPO: repoId,
    ...(state.apiUrl ? { CANOPY_API: state.apiUrl } : {}),
  };
}

/** `CANOPY_API` off the address the server binds: loopback for a loopback
 *  or wildcard bind, else that address itself */
function apiUrlFor(bind: string, port: number): string {
  const any = bind === "0.0.0.0" || bind === "::" || bind === "[::]" || bind === "localhost" || bind.startsWith("127.") || bind === "::1";
  const host = any ? "127.0.0.1" : bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;
  return `http://${host}:${port}`;
}

/** The tailchan handle a new shell runs under, as a spread: none when the
 *  backend knows no broker (the variable would mean nothing) or the shell
 *  is an ssh line (it would stay on this side of the connection). */
function handleOf(state: ServerState, repoId: string, path: string, id: string): { handle?: string } {
  if (!state.chan.cfg || parseLocator(path).host !== null) return {};
  const name = state.result.repos.find((r) => r.id === repoId)?.name ?? repoId;
  return { handle: shellHandle(name, id) };
}

/** A shell on a plain pty under the browser's name: the one session every
 *  socket on it shares, its output kept for the next socket, its exit told
 *  to them all. Throws when the spawn fails (a folder that is gone, a shell
 *  that is not there). */
function openPtyTerm(state: ServerState, data: TermSocket, size: TermSize): LiveTerm {
  const { repo, id, place } = data;
  const scrollback = new Scrollback();
  const sockets = new Set<ServerWebSocket<TermSocket>>();
  const env = shellEnv(state, repo.id, repo.path, id);
  const session = startTerm(repo.path, size, {
    data: (chunk) => {
      scrollback.push(chunk);
      for (const ws of sockets) ws.sendBinary(chunk);
    },
    exit: (code) => {
      state.terms.delete(id);
      for (const ws of sockets) {
        try {
          ws.send(JSON.stringify({ exit: code }));
          ws.close(1000, "the shell exited");
        } catch {
          // the browser went first
        }
      }
      sockets.clear();
      tellTerms(state);
    },
  }, Object.keys(env).length ? env : undefined);
  const live: LiveTerm = {
    info: { id, repoId: repo.id, path: repo.path, place, attached: false, viewers: [], startedAt: Date.now(), ...handleOf(state, repo.id, repo.path, id) },
    pty: { session, scrollback },
    sockets,
  };
  state.terms.set(id, live);
  tellTerms(state);
  return live;
}

/** A socket onto a shell on tmux: the session made when this is the first
 *  socket to name it, then what scrolled off before now, then a client of
 *  the socket's own on the session, which tmux draws for and asks about the
 *  terminal while the browser is there to answer. A session that turns out
 *  gone (the shell exited with no one watching) is told so. */
async function joinTmuxTerm(state: ServerState, tmux: string[], ws: ServerWebSocket<TermSocket>): Promise<void> {
  const { repo, id, place, cols, rows } = ws.data;
  const size = { cols, rows };
  let live = state.terms.get(id);
  if (!live) {
    await newSession(tmux, { id, repoId: repo.id, path: repo.path, place, ...handleOf(state, repo.id, repo.path, id), env: canopyEnv(state, repo.id, repo.path, id) }, size);
    live = {
      info: { id, repoId: repo.id, path: repo.path, place, attached: false, viewers: [], startedAt: Date.now(), ...handleOf(state, repo.id, repo.path, id) },
      pty: null,
      sockets: new Set(),
    };
    state.terms.set(id, live);
    tellTerms(state);
    const start = ws.data.start;
    if (start) void typeAgent(state, live, repo, start, ws.data.prompt).catch(() => {});
  } else if (!(await hasSession(tmux, id))) {
    state.terms.delete(id);
    tellTerms(state);
    ws.close(TERM_GONE, "that shell is gone");
    return;
  }
  const missed = await history(tmux, id, rows);
  if (ws.readyState !== WebSocket.OPEN) return;
  if (missed) ws.sendBinary(new TextEncoder().encode(missed));
  const held = live;
  const client = attachTmuxTerm(tmux, id, size, {
    data: (chunk) => {
      ws.sendBinary(chunk);
    },
    exit: (code) => {
      held.sockets.delete(ws);
      ws.data.client = undefined;
      void (held.ending ? Promise.resolve(false) : hasSession(tmux, id)).then((alive) => {
        try {
          if (alive) {
            // the client went but the shell did not (a detach from inside):
            // no exit frame, so the browser rejoins and gets a new client
            ws.close(1000, "the client detached");
          } else {
            if (state.terms.get(id) === held) state.terms.delete(id);
            // A shell that exited leaves nothing worth restoring, but the
            // session can also be gone because the tmux server went with its
            // container or its machine, which is the one case where what it
            // left is the whole point. Only the first forgets. The client
            // exits 0 when its session ended under a live server, which
            // includes the last shell on a Mac's tmux server, where the
            // server then exits with it (`exit-empty on`) and asking it
            // afterwards finds nothing; it exits 1 when the server went.
            void (code === 0 ? Promise.resolve(true) : serverUp(tmux)).then(async (exited) => {
              if (!exited) return;
              await state.keeping;
              await forgetKept(id);
            });
            ws.send(JSON.stringify({ exit: code }));
            ws.close(1000, "the shell exited");
          }
        } catch {
          // the browser went first
        }
        tellTerms(state);
      });
    },
  });
  ws.data.live = held;
  ws.data.client = client;
  held.sockets.add(ws);
  tellTerms(state);
}

interface HistoryCache {
  at: number;
  /** the scan the repo→project map was built from */
  scannedAt: number;
  /** null when the CLI could not be located */
  bin: string | null;
  value: HistoryOverview;
}

/** claude-history syncs hourly; a five-minute memo keeps the two CLI calls
 *  behind the overview off every reload. */
const HISTORY_TTL = 5 * 60_000;

const isRunAction = (v: unknown): v is RunAction =>
  typeof v === "string" && (RUN_ACTIONS as readonly string[]).includes(v);

const isFlowChoice = (v: unknown): v is FlowChoice => v === "continue" || v === "retry" || v === "stop";

const isHistoryWindow = (v: unknown): v is HistoryWindow =>
  typeof v === "string" && (HISTORY_WINDOWS as readonly string[]).includes(v);

async function loadHistory(state: ServerState, force = false): Promise<HistoryCache> {
  const c = state.history;
  if (
    !force &&
    c &&
    c.scannedAt === state.result.scannedAt &&
    Date.now() - c.at < HISTORY_TTL
  ) {
    return c;
  }
  if (state.historyPending) return state.historyPending;
  const scannedAt = state.result.scannedAt;
  state.historyPending = (async () => {
    const cfg = await loadConfig();
    const loc = locateHistory(cfg);
    let entry: HistoryCache;
    if ("reason" in loc) {
      entry = {
        at: Date.now(),
        scannedAt,
        bin: null,
        value: { available: false, reason: loc.reason, fetchedAt: Date.now() },
      };
    } else {
      const value = await historyOverview(loc.bin, state.result.repos).catch(
        (err: unknown): HistoryOverview => ({
          available: false,
          reason: String(err instanceof Error ? err.message : err),
          fetchedAt: Date.now(),
        }),
      );
      entry = { at: Date.now(), scannedAt, bin: loc.bin, value };
    }
    state.history = entry;
    return entry;
  })().finally(() => {
    state.historyPending = null;
  });
  return state.historyPending;
}

/** The CLI and the project id behind one repo's history routes. */
async function historyContext(
  state: ServerState,
  repo: Repo,
): Promise<{ bin: string; project: string }> {
  const c = await loadHistory(state);
  const v = c.value;
  if (!v.available) throw new HttpError(503, v.reason);
  if (!c.bin) throw new HttpError(503, "claude-history is not available");
  const h = v.repos[repo.id];
  if (!h) throw new HttpError(404, "no Claude sessions recorded for this repo");
  return { bin: c.bin, project: h.project };
}

/** Scan options from config — DEFAULT_IGNORE plus whatever the user added.
 *  A repo's tip comes off the remotes the activity pass has found to be the
 *  user's own; until it has looked, none. */
function scanOpts(state: ServerState, cfg: CanopyConfig): Required<ScanOptions> {
  return {
    maxDepth: cfg.maxDepth,
    ignore: [...DEFAULT_IGNORE, ...cfg.ignore],
    tipRemotes: (path) => state.own.get(path) ?? [],
  };
}

type PeerSettings = Pick<CanopyConfig, "self" | "peers" | "peerSync" | "seed">;

/** The test hook behind `peerSettings`: CANOPY_PEERS_JSON, read only under
 *  NODE_ENV=test (bun test sets it), so a local folder named as a peer
 *  (alias null) — which config validation would refuse — never reaches a
 *  real run. Pure, so the gate itself can be tested without a server. */
export function peerSettingsFromEnv(env: Record<string, string | undefined>): PeerSettings | null {
  if (env["NODE_ENV"] !== "test") return null;
  const raw = env["CANOPY_PEERS_JSON"];
  return raw ? (JSON.parse(raw) as PeerSettings) : null;
}

/** The peer settings: the config's, or CANOPY_PEERS_JSON in tests. */
async function peerSettings(): Promise<PeerSettings> {
  const fromEnv = peerSettingsFromEnv(process.env);
  if (fromEnv) return fromEnv;
  const cfg = await loadConfig();
  return { self: cfg.self, peers: cfg.peers, peerSync: cfg.peerSync, seed: cfg.seed };
}

const enc = new TextEncoder();

/** An error carrying the status the client should see. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function broadcast(state: ServerState, event: ServerEvent): void {
  const data = enc.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const c of state.clients) {
    try {
      c.enqueue(data);
    } catch {
      state.clients.delete(c);
      state.streams.delete(c);
    }
  }
}

const deviceList = (state: ServerState): Device[] => devicesOf(state.streams.values());

/** the device a stream id belongs to right now, by name, or null */
function deviceNameOf(state: ServerState, id: string | null): string | null {
  if (!id) return null;
  return deviceList(state).find((d) => d.id === id)?.name ?? null;
}

/** the devices list to every stream, a beat after the last change so a
 *  reload (one stream closing, another opening) is one event, not two */
function tellDevices(state: ServerState): void {
  const t = state.timers.get("devices");
  if (t) clearTimeout(t);
  state.timers.set(
    "devices",
    setTimeout(() => {
      state.timers.delete("devices");
      broadcast(state, { type: "devices", devices: deviceList(state) });
    }, 300),
  );
}

/** one shell as the list shows it: attached when any socket is on it, the
 *  devices behind those sockets by name */
function termInfo(state: ServerState, t: LiveTerm): TermInfo {
  const viewers: string[] = [];
  for (const ws of t.sockets) {
    const name = deviceNameOf(state, ws.data.device);
    if (name && !viewers.includes(name)) viewers.push(name);
  }
  return { ...t.info, attached: t.sockets.size > 0, viewers };
}

/** the shells to every stream: after a start, an end, a join or a leave.
 *  Off the map alone, no tmux reconcile (that shells out) behind it; the
 *  GET does that. One being ended is left out, so no window adopts it in
 *  the moment before it goes. */
function tellTerms(state: ServerState): void {
  const terms = [...state.terms.values()].filter((t) => !t.ending && !t.info.task).map((t) => termInfo(state, t));
  broadcast(state, { type: "terms", terms });
  state.tasks.refresh();
}

function repoById(state: ServerState, id: string): Repo {
  const repo = state.result.repos.find((r) => r.id === id);
  if (!repo) throw new HttpError(404, `unknown repo: ${id}`);
  return repo;
}

async function refreshAndBroadcast(
  state: ServerState,
  id: string,
): Promise<Repo> {
  return (await refreshHeld(state, id)).repo;
}

/** refreshAndBroadcast, saying whether the seed was held: a busy seed, or
 *  one whose stage runner could not read it, keeps its last status and is
 *  read again later */
async function refreshHeld(state: ServerState, id: string): Promise<{ repo: Repo; held: boolean }> {
  const repo = state.result.repos.find((r) => r.id === id);
  if (!repo) throw new HttpError(404, `unknown repo: ${id}`);
  if (busySeed(repo)) {
    scheduleRefresh(state, id, SEED_RETRY);
    return { repo, held: true };
  }
  const fresh = await refreshRepo(repo, state.own.get(repo.path) ?? []);
  if (seedHeld(fresh.error)) {
    scheduleRefresh(state, id, SEED_RETRY);
    return { repo, held: true };
  }
  // Re-find after the await: a concurrent rescan may have replaced the array,
  // and writing back a pre-await index would land in the wrong slot.
  const idx = state.result.repos.findIndex((r) => r.id === id);
  if (idx !== -1) state.result.repos[idx] = fresh;
  broadcast(state, { type: "repo", repo: fresh });
  return { repo: fresh, held: false };
}

const WATCH_GIT_HINTS = ["HEAD", "index", "ORIG_HEAD", "refs", "worktrees"];

/** How often a remote source's repos get their status re-read: there is no
 *  watcher on another host, and a scan of a whole tree is too much to repeat. */
const REMOTE_REFRESH = 5 * 60_000;

/** How long after start the first fetch and pull request pass runs. */
const ACTIVITY_DELAY = 3_000;

const bySource = (order: string[]) => (a: Repo, b: Repo): number =>
  order.indexOf(a.source) - order.indexOf(b.source) || a.id.localeCompare(b.id);

/** The tree the clients see, rebuilt from the sources after any change. */
function rebuildResult(state: ServerState, repos: Repo[]): void {
  const order = state.sources.map((rt) => rt.src.id);
  state.result = {
    root: state.root,
    sources: state.sources.map((rt) => ({ ...rt.src })),
    // Which forge repos are already cloned here can only be told once every
    // source is in the same list, so it is settled on the way out; the pull
    // request counts and the peer states ride along from the last activity
    // pass and the last peer pass.
    repos: linkFavorites(
      linkArchived(
        linkPeers(linkPulls(linkForgeClones([...repos].sort(bySource(order))), state.pulls), state.peerStates),
        state.archived,
      ),
      state.favorites,
    ),
    scannedAt: Date.now(),
    backend: backendCaps(state.harnesses()),
  };
}

/** Rescans one source and swaps its repos into the tree. A failed scan keeps
 *  the repos from the last good one and records why on the source. */
function scanOne(state: ServerState, rt: SourceRuntime, opts: Required<ScanOptions>): Promise<void> {
  if (rt.scanning) return rt.scanning;
  rt.scanning = (async () => {
    try {
      const fresh = (await scanSource(rt.src, opts)).map((r) => {
        // by the refusal, not by the seed being busy now: it may have gone
        // quiet between the read and here
        if (!seedHeld(r.error)) return r;
        // the scan's read was refused: keep the last status, read it later
        scheduleRefresh(state, r.id, SEED_RETRY);
        const was = state.result.repos.find((p) => p.id === r.id);
        return was ? { ...r, status: was.status, error: was.error } : r;
      });
      const kept = state.result.repos.filter((r) => r.source !== rt.src.id);
      rt.src = { ...rt.src, repos: fresh.length, scannedAt: Date.now(), error: undefined };
      rebuildResult(state, [...kept, ...fresh]);
    } catch (err) {
      rt.src = { ...rt.src, error: String(err instanceof Error ? err.message : err) };
      rebuildResult(state, state.result.repos);
    }
  })().finally(() => {
    rt.scanning = null;
  });
  return rt.scanning;
}

async function scanAll(state: ServerState): Promise<void> {
  const cfg = await loadConfig();
  const opts = scanOpts(state, cfg);
  state.ignore = opts.ignore;
  await Promise.all(state.sources.map((rt) => scanOne(state, rt, opts)));
}

/** Key for the debounce timer of a whole-source rescan (no repo owns it). */
const rescanKey = (id: string): string => `\0rescan:${id}`;

function scheduleRescan(state: ServerState, rt: SourceRuntime): void {
  const key = rescanKey(rt.src.id);
  clearTimeout(state.timers.get(key));
  state.timers.set(
    key,
    setTimeout(() => {
      state.timers.delete(key);
      void (async () => {
        try {
          const cfg = await loadConfig();
          const opts = scanOpts(state, cfg);
          state.ignore = opts.ignore;
          await scanOne(state, rt, opts);
          broadcast(state, { type: "scan", result: state.result });
        } catch {
          // a rescan that fails leaves the previous tree in place
        }
      })();
    }, 1_000),
  );
}

/** A status re-read for one repo, debounced: a burst of file events, or a
 *  fetch and the watcher seeing its refs move, become one read. */
function scheduleRefresh(state: ServerState, id: string, wait = 400): void {
  clearTimeout(state.timers.get(id));
  state.timers.set(
    id,
    setTimeout(() => {
      state.timers.delete(id);
      // a busy seed keeps its last status and is read once it is quiet
      const repo = state.result.repos.find((r) => r.id === id);
      if (repo && busySeed(repo)) return scheduleRefresh(state, id, SEED_RETRY);
      refreshAndBroadcast(state, id).catch(() => {});
    }, wait),
  );
}

/** A status read for a run's or a flow's outcome: null, not the last
 *  status, for a busy seed, so nothing is judged on a reading from before
 *  the run; the card is read again once the seed is quiet. */
async function freshStatus(state: ServerState, id: string): Promise<RepoStatus | null> {
  const repo = state.result.repos.find((r) => r.id === id);
  if (repo && busySeed(repo)) {
    scheduleRefresh(state, id, SEED_RETRY);
    return null;
  }
  return refreshHeld(state, id)
    .then((r) => {
      if (r.held) return null;
      // a run's or a flow's outcome read: the seed's mirror follows it
      void syncMirror(state, r.repo.path);
      return r.repo.status;
    })
    .catch(() => null);
}

/** Brings a seed's mirror up to the seed, in the background: after canopy's
 *  own commit there and after a run's outcome is read there. A seed held
 *  now is left for the next sync; a failure is logged, never thrown. */
function syncMirror(state: ServerState, path: string): Promise<void> {
  if (!isSeedPath(state.root, path)) return Promise.resolve();
  return state.mirrors.sync(path).then(
    () => {},
    (err: unknown) => console.error(`canopy: mirror of ${path}:`, err instanceof Error ? err.message : err),
  );
}

/** the launch root's seeds, by path */
const seedPaths = (state: ServerState): string[] =>
  state.result.repos.filter((r) => r.source === LAUNCH_SOURCE && isSeedRepoId(r.id)).map((r) => r.path);

/** how often a status read put off by a busy seed asks again */
const SEED_RETRY = 1_000;

/** a seed canopy runs no git in for now (seedgit.ts) */
const busySeed = (repo: Repo): boolean => !repo.host && !repo.forge && seedBusy(repo.path);

function startWatcher(state: ServerState, rt: SourceRuntime): void {
  if (rt.src.kind !== "local" || rt.watcher) return;
  const sourceId = rt.src.id;
  try {
    rt.watcher = watch(
      rt.src.path,
      { recursive: true },
      (_ev, filename) => {
        if (!filename) return;
        const parts = filename.split("/");
        if (parts.some((p) => state.ignore.includes(p))) return;
        const gitIdx = parts.indexOf(".git");
        if (gitIdx !== -1) {
          const inner = parts[gitIdx + 1] ?? "";
          if (!WATCH_GIT_HINTS.includes(inner)) return;
        }
        // longest repo (by its path under this source) that prefixes the
        // changed path
        let match: Repo | null = null;
        for (const r of state.result.repos) {
          if (r.source !== sourceId) continue;
          const rel = repoRel(r);
          if (rel === "." || filename === rel || filename.startsWith(rel + "/")) {
            if (!match || rel.length > repoRel(match).length) match = r;
          }
        }
        if (!match) {
          // A .git appearing outside every known repo means a new clone or
          // init — only a rescan can pick it up. Try each location once: if
          // the rescan does find it, later events match a repo id instead.
          const owner = parts.slice(0, gitIdx).join("/");
          if (gitIdx !== -1 && !rt.probed.has(owner)) {
            rt.probed.add(owner);
            scheduleRescan(state, rt);
          }
          return;
        }
        scheduleRefresh(state, match.id);
      },
    );
  } catch (err) {
    console.error(`watcher unavailable for ${rt.src.label}:`, err);
  }
}

/** Re-reads every remote repo's status, a few at a time. Broadcast per
 *  repo, so a card updates as soon as its own answer is in. */
async function refreshRemote(state: ServerState): Promise<void> {
  // A forge answers with the whole list or nothing, so its source is scanned
  // again rather than walked repo by repo.
  const forges = state.sources.filter((rt) => rt.src.kind === "forgejo" && !rt.scanning);
  if (forges.length > 0) {
    const opts = scanOpts(state, await loadConfig());
    await Promise.all(forges.map((rt) => scanOne(state, rt, opts)));
    broadcast(state, { type: "scan", result: state.result });
  }
  const remote = new Set(
    state.sources.filter((rt) => rt.src.kind === "ssh" && !rt.scanning).map((rt) => rt.src.id),
  );
  const ids = state.result.repos.filter((r) => remote.has(r.source)).map((r) => r.id);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++];
      if (id !== undefined) await refreshAndBroadcast(state, id).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
}

/** How many repos fetch at once: enough to get through the tree in a
 *  minute or two, few enough not to swamp a link or a rate limit. */
const FETCH_CONCURRENCY = 4;

/** A repo's own remotes, remembered by path. `learned` says this was the
 *  first look, so the caller can re-read a status taken before it. The
 *  GitHub lookups behind it are memoized in `access`. */
/** Whether `peer`'s remote on this repo is canopy's own: either the
 *  no-push marker is set, or the url is exactly what canopy would have
 *  written (peerUrl(peer, id)). The url check is what lets a half-made
 *  remote a crash left between `remote add` and the marker (url set,
 *  nothing else yet) be recognized as canopy's own and repaired rather
 *  than mistaken for a stranger's forever. A same-named remote matching
 *  neither is the user's own; initRepo leaves it alone, and this keeps it
 *  in `own` too, since it is exactly the kind of remote the origin fetch
 *  is for. Exported for a direct unit test of the url-match repair case. */
export async function isPeerRemote(repoPath: string, repoId: string, peer: Peer): Promise<boolean> {
  // through git(), so a seed's remotes are read only past the seed guard
  const url = await git(repoPath, ["remote", "get-url", peer.name]);
  if (url.code === 0 && url.stdout.trim() === peerUrl(peer, repoId)) return true;
  const pushurl = await git(repoPath, ["config", "--get", `remote.${peer.name}.pushurl`]);
  return pushurl.code === 0 && pushurl.stdout.trim() === NO_PUSH;
}

/** Exported for a direct unit test: narrowed to the slice of ServerState
 *  and Repo it actually needs, so a test can drive it against a bare fake
 *  (a `login` of `null` skips the real `gh api user` call below). */
export async function ownRemotesOf(
  state: { own: Map<string, string[]>; peerNamesSeen: Peer[]; login?: string | null; access: Map<string, boolean | null> },
  repo: { path: string; id: string },
): Promise<{ names: string[]; learned: boolean }> {
  const known = state.own.get(repo.path);
  if (known !== undefined) return { names: known, learned: false };
  // No disk read here: state.peerNamesSeen is the peer list as of the last
  // whole-tree pass (peerPass keeps it current and clears `own` itself when
  // it changes), so a memo miss costs one status read and some git config
  // reads, never a fresh peerSettings() call.
  const peers = state.peerNamesSeen;
  if (state.login === undefined) state.login = await githubLogin();
  let names = await ownRemotes(await listRemotes(repo.path), { login: state.login, permission: state.access });
  // Peer remotes are pulled by the peer pass, not the origin fetch, and kept
  // out of status.tip too: the tip reads only the names settled here.
  const drop = await Promise.all(
    names.map((n) => {
      const peer = peers.find((p) => p.name === n);
      return peer ? isPeerRemote(repo.path, repo.id, peer) : Promise.resolve(false);
    }),
  );
  names = names.filter((_, i) => !drop[i]);
  state.own.set(repo.path, names);
  return { names, learned: true };
}

/** Fetches every local repo's own remotes, a few at a time, and schedules
 *  a status re-read for each repo whose remote refs moved, or whose status
 *  was read before its own remotes were known and so has no tip yet. A
 *  repo with a run under way is skipped: a fetch landing mid-run would
 *  change the fingerprint the run's outcome is judged by. */
async function fetchLocal(state: ServerState): Promise<void> {
  const local = new Set(state.sources.filter((rt) => rt.src.kind === "local").map((rt) => rt.src.id));
  const repos = state.result.repos.filter(
    (r) => local.has(r.source) && !r.forge && !r.error && (r.remotes?.length ?? 0) > 0 && !(state.seedsStayHome && isSeedPath(state.root, r.path)),
  );
  await mapPool(repos, FETCH_CONCURRENCY, async (repo) => {
    const { names, learned } = await ownRemotesOf(state, repo);
    if (names.length === 0) return;
    if (state.runner.activeFor(repo.id)) return;
    const { changed } = await fetchRepo(repo.path, names);
    if (changed || learned) scheduleRefresh(state, repo.id);
  });
}

/** Re-reads the open pull request counts for every repo the gh login can
 *  see and broadcasts each repo whose count changed. A missing or logged
 *  out gh leaves the counts as they were. */
async function refreshPulls(state: ServerState): Promise<void> {
  const r = await exec(["gh", "api", "graphql", "--paginate", "--slurp", "-f", `query=${PULLS_QUERY}`], {
    timeoutMs: 60_000,
  });
  if (r.code !== 0) return;
  let body: unknown;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    return;
  }
  state.pulls = parsePullCounts(body);
  const before = state.result.repos;
  const after = linkArchived(linkPulls(before, state.pulls), state.archived);
  state.result.repos = after;
  after.forEach((repo, i) => {
    // A count first arriving as zero is what the browser already assumes;
    // announcing it would pulse most of the board on every start.
    const was = before[i]?.pulls?.open ?? 0;
    const counted = was > 0 || (repo.pulls?.open ?? 0) > 0;
    if (repo !== before[i] && (counted || repo.archived !== before[i]?.archived)) broadcast(state, { type: "repo", repo });
  });
}

/** A GitHub login that did not resolve (gh offline when the server started,
 *  a DNS hiccup) is asked for again on every pass until it answers. Every
 *  repo judged while it was missing had its GitHub remotes counted as not
 *  the user's, so no background fetch and no remote tip; those judgements,
 *  and the push lookups that failed with it, are made again. */
async function retryLogin(state: ServerState): Promise<void> {
  if (state.login !== null) return;
  const login = await githubLogin();
  if (!login) return;
  state.login = login;
  state.own.clear();
  for (const [slug, perm] of state.access) if (perm === null) state.access.delete(slug);
}

/** The activity pass: fetch the user's own repos, then count their pull
 *  requests, each on the remote refresh timer and once soon after start. */
function refreshActivity(state: ServerState): Promise<void> {
  if (state.activity) return state.activity;
  state.activity = (async () => {
    try {
      await retryLogin(state);
      // every seed's mirror, so the gate is at most one pass behind
      await Promise.all(seedPaths(state).map((p) => syncMirror(state, p)));
      const cfg = await loadConfig();
      if (cfg.fetch) await fetchLocal(state);
      await refreshPeers(state).catch((err) => console.error("canopy: peer pass", err));
      await refreshPulls(state);
    } catch (err) {
      console.error("activity refresh failed:", err);
    }
  })().finally(() => {
    state.activity = null;
  });
  return state.activity;
}

/** A repo peer sync covers: a local repo under the launch root, with no
 *  ongoing scan error, and not a seed on an isolated backend, where canopy
 *  runs no git in one (amendment 4, ruling 9). */
const peerable = (state: ServerState, r: Repo): boolean =>
  r.source === LAUNCH_SOURCE && !r.host && !r.forge && !r.error && !(state.seedsStayHome && isSeedRepoId(r.id));

/** Runs `job` through the peering queue (withPeering), but coalesces
 *  repeat calls: while a job started this way is still pending (queued
 *  behind something else, or running), a second call returns that same
 *  promise instead of enqueueing job() again behind it. `pending` is a
 *  separate field from the queue itself (state.peering), since the queue
 *  alone cannot tell "a pass is next in line" from "a pass is one of
 *  several things next in line" - only this call site knows which of its
 *  own requests are for the same job. Exported for a direct unit test of
 *  the coalescing, alongside withPeering. */
export function queuePass(state: { peering: Promise<void> | null; pendingPass: Promise<void> | null }, job: () => Promise<void>): Promise<void> {
  if (state.pendingPass) return state.pendingPass;
  const run = withPeering(state, job);
  state.pendingPass = run.finally(() => {
    state.pendingPass = null;
  });
  return state.pendingPass;
}

/** Pulls from every peer: snapshot, fetch, fast-forward, clone what is
 *  missing. Repos with a run under way are skipped, like the fetch. A timer
 *  pass, a manual /api/peers/sync, and every route action (sync, take,
 *  track, seed) all go through the one peering queue (withPeering), so none of
 *  them ever runs at the same time as another; a pass specifically also
 *  coalesces through queuePass, since a second timer tick or sync request
 *  while one is already pending should join it, not queue a duplicate pass
 *  behind it. */
function refreshPeers(state: ServerState): Promise<void> {
  return queuePass(state, () => peerPass(state));
}

async function peerPass(state: ServerState): Promise<void> {
  const s = await peerSettings();
  notePeerList(state, s.peers);
  if (s.peerSync === "off" || !s.self) return;
  if (s.peers.length === 0) return;
  const dry = s.peerSync === "dry";
  const repos = state.result.repos.filter((r) => peerable(state, r) && !state.runner.activeFor(r.id));
  for (const r of repos) {
    if (state.inited.has(r.path)) continue;
    await initRepo(r.path, r.id, s.peers, dry);
    // Only a non-dry setup counts as inited: a dry pass wrote no remotes, so
    // flipping to "on" without a restart must still set them up.
    if (!dry) state.inited.add(r.path);
  }
  const { states, seen, cloned, failed } = await syncAll(
    repos.map((r) => r.id),
    { self: s.self, peers: s.peers, seed: s.seed, dry, root: state.root, ...(state.seedsStayHome ? { skip: isSeedRepoId } : {}) },
    FETCH_CONCURRENCY,
  );
  if (seenChanged(state.peerSeen, seen)) broadcast(state, { type: "peers", seen });
  state.peerSeen = seen;
  for (const [id, st] of states) applyPeerState(state, id, st);
  for (const f of failed) console.error(`canopy: peer clone failed: ${f.id}: ${f.error}`);
  // In dry mode cloneMissing only lists what it would clone, without making
  // the folder, so `cloned` here is not real: nothing to rescan or announce.
  if (!dry && cloned.length > 0) {
    const launch = state.sources.find((rt) => rt.src.id === LAUNCH_SOURCE);
    if (launch) await scanOne(state, launch, scanOpts(state, await loadConfig()));
    broadcast(state, { type: "scan", result: state.result });
  }
  // Drop peer state for anything no longer in the tree: a repo removed since
  // the last pass, or (defensively) an id that never belonged there.
  const treeIds = new Set(state.result.repos.map((r) => r.id));
  for (const id of state.peerStates.keys()) if (!treeIds.has(id)) state.peerStates.delete(id);
}

/** Whether `after` differs from `before`, ignoring `at` and ignoring order:
 *  syncAll's workers race, so which peer gets marked first varies pass to
 *  pass even when reachability itself hasn't changed. */
function seenChanged(before: PeerSeen[], after: PeerSeen[]): boolean {
  const key = (list: PeerSeen[]) =>
    JSON.stringify([...list].map((s) => ({ ...s, at: 0 })).sort((a, b) => a.name.localeCompare(b.name)));
  return key(before) !== key(after);
}

/** Whether two peer lists are the same, ignoring order: what ownRemotesOf's
 *  classification actually depends on (name, alias and root all feed
 *  peerUrl; a change to any of them, not just a name added or removed,
 *  means a repo's remotes need judging again). */
function samePeerList(a: Peer[], b: Peer[]): boolean {
  const key = (list: Peer[]) => JSON.stringify([...list].sort((x, y) => x.name.localeCompare(y.name)));
  return key(a) === key(b);
}

/** Keeps `peerNamesSeen` (what ownRemotesOf reads, never the disk) in step
 *  with the peer list: called once per pass, off or on, dry or not, so a
 *  repo's remotes are classified against whatever the peer list actually
 *  is right now rather than whatever it was on the last own-remotes memo
 *  miss (which, once every repo is warm, might be never). Clears `own`
 *  only when the list actually changed, so a same-list call costs nothing.
 *  Exported for a direct unit test of this bookkeeping on its own. */
export function notePeerList(state: { own: Map<string, string[]>; peerNamesSeen: Peer[] }, peers: Peer[]): void {
  if (samePeerList(state.peerNamesSeen, peers)) return;
  state.own.clear();
  state.peerNamesSeen = peers;
}

const PEER_ACTIONS = ["sync", "take", "track", "seed"] as const;
export type PeerAction = (typeof PEER_ACTIONS)[number];
const isPeerAction = (v: unknown): v is PeerAction => (PEER_ACTIONS as readonly unknown[]).includes(v);

/** Runs one /api/repos/peer action through the peering queue, every
 *  action and not only sync: a pass running alongside a take could
 *  fast-forward the branch between takeWip's HEAD check and its read-tree,
 *  and a track or seed writes to the same repo the pass is working in.
 *  Exported for a direct unit test of the queue ordering. */
export function runPeerAction<T>(state: { peering: Promise<void> | null }, action: PeerAction, ops: Record<PeerAction, () => Promise<T>>): Promise<T> {
  return withPeering(state, ops[action]);
}

/** A true FIFO queue over `state.peering`, not just a wait-then-run: every
 *  writer of `state.peering` goes through here, the whole-tree pass
 *  (queuePass, wrapping this) included, so it is the one and only queue,
 *  never bypassed by a direct write. Each caller chains itself onto
 *  whatever the field currently holds (the pass, or an earlier queued
 *  caller here) and replaces it with its own tail *synchronously*, before
 *  awaiting the one it replaced. Two callers arriving back to back
 *  therefore never both see the same holder and race to run `fn`
 *  together: the second always sees the first's tail, not the original
 *  holder. A route action (sync's initRepo and syncRepo, a take, a track,
 *  a seed) must never touch the same repo's config, refs or files as the
 *  pass, or another queued action, at the same time. Exported for a direct unit test of
 *  the queue ordering: takes just the slice of ServerState it needs, so a
 *  test can drive it against a bare `{ peering: null }`. */
export async function withPeering<T>(state: { peering: Promise<void> | null }, fn: () => Promise<T>): Promise<T> {
  const prev = state.peering;
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    return fn();
  })();
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  state.peering = tail;
  void tail.finally(() => {
    // Only clear the field if nothing has queued behind us since: a later
    // caller's own tail is what state.peering must still point to.
    if (state.peering === tail) state.peering = null;
  });
  return run;
}

/** The divergences in a repo's new peer state not reported yet. `seen`
 *  keeps exactly the pairs diverged now, so one that settles and later
 *  diverges again is reported again. A state that carries an error may
 *  have stopped before it compared anything, so its short list forgets
 *  nothing. Exported for a direct unit test. */
export function newDivergences(
  seen: Map<string, Set<string>>,
  id: string,
  diverged: PeerBranch[],
  opts: { errored?: boolean } = {},
): PeerBranch[] {
  const had = seen.get(id);
  const now = new Set<string>(opts.errored ? had : []);
  const fresh: PeerBranch[] = [];
  for (const d of diverged) {
    const key = `${d.branch} ${d.peer}`;
    now.add(key);
    if (!had?.has(key)) fresh.push(d);
  }
  if (now.size > 0) seen.set(id, now);
  else seen.delete(id);
  return fresh;
}

/** Records one repo's peer state, notifies on a divergence the first time it
 *  is seen, schedules a status re-read when something moved, and broadcasts
 *  the repo only when its peer state actually changed (broadcasting every
 *  repo each pass would pulse the whole board). Ignores an id not in the
 *  tree: a dry pass's would-be clone, or a repo removed mid-pass. */
function applyPeerState(state: ServerState, id: string, st: PeerState): void {
  const idx = state.result.repos.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const before = state.peerStates.get(id);
  const changed = !before || JSON.stringify({ ...before, at: 0 }) !== JSON.stringify({ ...st, at: 0 });
  state.peerStates.set(id, st);
  if (!changed) return;
  for (const d of newDivergences(state.divergedSeen, id, st.diverged, { errored: !!st.error })) notifyDiverged(id, d);
  if (st.moved.length > 0) scheduleRefresh(state, id);
  const repo = state.result.repos[idx]!;
  const next = { ...repo, peers: st };
  state.result.repos[idx] = next;
  broadcast(state, { type: "repo", repo: next });
}

/** Best effort: `ctl` exists only where _control is installed. The PATH is
 *  passed explicitly: `Bun.which` with no options resolves against the PATH
 *  the process started with, not a later `process.env["PATH"]`, which would
 *  otherwise make this unstubbable in a test. */
function notifyDiverged(id: string, d: PeerBranch): void {
  const ctl = Bun.which("ctl", { PATH: process.env["PATH"] ?? "" });
  if (!ctl) return;
  void exec([ctl, "notify", "soft", `${id}: ${d.branch} diverged from ${d.peer} (${d.behind} here, ${d.ahead} there)`], { timeoutMs: 10_000 });
}

/* ---------- adding a source: check the folder before storing it ---------- */

/** Parses the add-a-folder body; anything off gets a 400 with the reason. */
function parseSourceInput(v: unknown): SourceInput {
  if (!v || typeof v !== "object") throw new HttpError(400, "malformed source");
  const b = v as {
    kind?: unknown;
    path?: unknown;
    host?: unknown;
    label?: unknown;
    url?: unknown;
    tokenFile?: unknown;
  };
  const path = typeof b.path === "string" ? b.path.trim() : "";
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : undefined;
  if (b.kind === "local") {
    if (!path) throw new HttpError(400, "a folder path is needed");
    return { kind: "local", path, ...(label ? { label } : {}) };
  }
  if (b.kind === "ssh") {
    const host = typeof b.host === "string" ? b.host.trim() : "";
    if (!isSshHost(host)) throw new HttpError(400, "an ssh host alias is needed");
    return { kind: "ssh", host, path: path || "~", ...(label ? { label } : {}) };
  }
  if (b.kind === "forgejo") {
    const raw = typeof b.url === "string" ? b.url.trim() : "";
    if (!raw) throw new HttpError(400, "the forge's address is needed");
    const tokenFile = typeof b.tokenFile === "string" ? b.tokenFile.trim() : "";
    let url: string;
    try {
      url = apiBase(raw);
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
    return {
      kind: "forgejo",
      url,
      ...(tokenFile ? { tokenFile } : {}),
      ...(label ? { label } : {}),
    };
  }
  throw new HttpError(400, "kind must be local, ssh or forgejo");
}

/** The folder as its host knows it: absolute, and confirmed to be a
 *  directory. A remote check also proves ssh can get in at all. */
async function resolveSource(input: SourceInput): Promise<SourceInput> {
  if (input.kind === "forgejo") {
    // Listing the repos is the only check worth making: it proves the
    // address answers, the token is accepted, and there is something to show.
    try {
      await listForgeRepos(input, { timeoutMs: 20_000 });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      throw new HttpError(err instanceof ForgeAuthError ? 400 : 502, msg);
    }
    return input;
  }
  if (input.kind === "local") {
    const path = resolve(expandHome(input.path));
    const st = await stat(path).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, `not a folder: ${path}`);
    return { ...input, path };
  }
  const r = await onHost(
    input.host,
    ["sh", "-c", `cd ${tildeQuote(input.path)} && pwd -P`],
    { timeoutMs: 20_000 },
  );
  if (r.code === 255) {
    throw new HttpError(502, `ssh ${input.host}: ${r.stderr.trim() || "connection failed"}`);
  }
  const path = r.stdout.trim();
  if (r.code !== 0 || !path.startsWith("/")) {
    throw new HttpError(400, `${input.host}: ${r.stderr.trim() || `not a folder: ${input.path}`}`);
  }
  return { ...input, path };
}

/** A local folder inside, or around, one already scanned would list the
 *  same repos twice under two ids. */
function overlapping(state: ServerState, path: string): Source | undefined {
  return state.sources
    .map((rt) => rt.src)
    .find(
      (s) =>
        s.kind === "local" &&
        (s.path === path || path.startsWith(s.path + "/") || s.path.startsWith(path + "/")),
    );
}

async function sshHosts(): Promise<string[]> {
  const text = await readFile(join(homedir(), ".ssh", "config"), "utf8").catch(() => "");
  return parseSshHosts(text);
}

/** how many repos a search runs git grep in at once */
const GREP_CONCURRENCY = 8;
/** the longest search a browser can ask for */
const GREP_MAX = 200;

/** One search term, checked: git grep reads a newline as two patterns and a
 *  NUL cannot reach an argv at all, so both are refused rather than mangled. */
function grepQuery(v: unknown): string {
  const q = typeof v === "string" ? v.trim() : "";
  if (q === "") throw new HttpError(400, "empty query");
  if (q.length > GREP_MAX) throw new HttpError(400, `query longer than ${GREP_MAX} characters`);
  if (/[\n\r\0]/.test(q)) throw new HttpError(400, "query must be one line");
  return q;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

async function handleApi(
  state: ServerState,
  req: Request,
  url: URL,
  key: string,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const here = onThisMachine(key, url);

  if (path === "/api/tree" && method === "GET") return json(state.result);
  if (path === "/api/about" && method === "GET") return json(state.about);
  // what the backend knows of this browser, and the helpers dialled in
  if (path === "/api/client" && method === "GET") return json(clientInfo(state, key, here));
  if (path === "/api/helpers" && method === "GET") return json(helperList(state));
  if (path === "/api/devices" && method === "GET") return json(deviceList(state));
  const chanRes = await state.chan.handle(req, url);
  if (chanRes) return chanRes;
  const registryRes = await state.registry.handle(req, url);
  if (registryRes) return registryRes;
  const askRes = await state.asks.handle(req, url);
  if (askRes) return askRes;
  const incubatorRes = await state.incubator.handle(req, url);
  if (incubatorRes) return incubatorRes;
  const taskRes = await state.tasks.handle(req, url, (id) => state.result.repos.find((r) => r.id === id));
  if (taskRes) return taskRes;

  // The in-app browser: what listens on the backend's loopback, each port
  // with the repo its process runs in when that can be seen, and a preview
  // port for one of them.
  if (path === "/api/ports" && method === "GET") {
    const reserved = state.preview?.reserved ?? [];
    const local = state.result.repos.filter((r) => !r.host && !r.forge);
    const ports: ListeningPort[] = (await listeningPorts())
      .filter((l) => !reserved.includes(l.port))
      .map((l) => {
        const repo = repoOfCwd(l.cwd, local);
        return { port: l.port, ...(l.command ? { command: l.command } : {}), ...(repo ? { repo } : {}) };
      });
    const pub = state.preview?.publicTemplate;
    const host = state.preview?.host;
    return json({
      ports,
      slots: state.preview?.slots ?? [],
      ...(pub ? { public: pub } : {}),
      ...(host ? { host } : {}),
    } satisfies PortsResult);
  }
  if (path === "/api/preview" && method === "POST") {
    if (!state.preview) throw new HttpError(503, "previews are off (CANOPY_PREVIEW_PORTS)");
    const b = (await req.json()) as { port?: unknown };
    if (!previewable(b.port, state.preview.reserved)) throw new HttpError(400, "a port to preview is needed (not canopy's own)");
    const slot = await state.preview.serve(b.port);
    if (slot === null) throw new HttpError(503, "no preview port could be opened");
    return json({ slot, port: b.port } satisfies PreviewSlot);
  }

  if (path === "/api/rescan" && method === "POST") {
    await scanAll(state);
    broadcast(state, { type: "scan", result: state.result });
    return json(state.result);
  }

  if (path === "/api/sources" && method === "GET") return json(state.result.sources);
  if (path === "/api/hosts" && method === "GET") return json(await sshHosts());
  if (path === "/api/browse" && method === "GET") {
    // Read-only, and loopback-only like everything else here; still, a
    // remote listing goes through the same host check as adding one.
    const dir = url.searchParams.get("path") ?? "~";
    const host = url.searchParams.get("host");
    if (host === null || host === "") {
      try {
        return json(await browseLocal(dir));
      } catch (err) {
        throw new HttpError(400, String(err instanceof Error ? err.message : err));
      }
    }
    if (!isSshHost(host)) throw new HttpError(400, "an ssh host alias is needed");
    try {
      return json(await browseRemote(host, dir));
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      throw new HttpError(err instanceof SshError ? 502 : 400, msg);
    }
  }
  if (path === "/api/sources" && method === "POST") {
    const input = await resolveSource(parseSourceInput(await req.json()));
    if (input.kind === "local") {
      const clash = overlapping(state, input.path);
      if (clash) throw new HttpError(409, `already covered by ${clash.label}`);
    }
    let stored;
    try {
      stored = await addSource(input);
    } catch (err) {
      throw new HttpError(409, String(err instanceof Error ? err.message : err));
    }
    const rt: SourceRuntime = {
      src: { ...stored, launch: false, repos: 0, scannedAt: 0 },
      watcher: null,
      probed: new Set(),
      scanning: null,
    };
    state.sources.push(rt);
    const opts = scanOpts(state, await loadConfig());
    await scanOne(state, rt, opts);
    startWatcher(state, rt);
    broadcast(state, { type: "scan", result: state.result });
    return json(state.result, 201);
  }
  if (path === "/api/sources" && method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    const rt = state.sources.find((s) => s.src.id === id);
    if (!rt) throw new HttpError(404, `unknown source: ${id}`);
    if (rt.src.launch) throw new HttpError(400, "the launch folder stays; start canopy elsewhere to change it");
    await removeSource(id);
    rt.watcher?.close();
    clearTimeout(state.timers.get(rescanKey(id)));
    state.sources = state.sources.filter((s) => s !== rt);
    rebuildResult(state, state.result.repos.filter((r) => r.source !== id));
    broadcast(state, { type: "scan", result: state.result });
    return json(state.result);
  }
  if (path === "/api/sources/rescan" && method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    const rt = state.sources.find((s) => s.src.id === id);
    if (!rt) throw new HttpError(404, `unknown source: ${id}`);
    const opts = scanOpts(state, await loadConfig());
    state.ignore = opts.ignore;
    await scanOne(state, rt, opts);
    broadcast(state, { type: "scan", result: state.result });
    return json(state.result);
  }

  // A search across many repos at once: one row per repo, in the order
  // asked, each with its hits or the reason it could not be searched. A
  // slow host only costs its own row.
  if (path === "/api/grep" && method === "POST") {
    const b = (await req.json()) as { q?: unknown; ids?: unknown };
    const q = grepQuery(b.q);
    if (!Array.isArray(b.ids) || !b.ids.every((id): id is string => typeof id === "string")) {
      return json({ error: "ids must be a list of repo ids" }, 400);
    }
    const repos = b.ids.map((id) => repoById(state, id));
    const rows = await mapPool(repos, GREP_CONCURRENCY, async (repo): Promise<GrepRepoResult> => {
      if (repo.forge) {
        return { repo: repo.id, hits: [], truncated: false, error: "only on the forge" };
      }
      try {
        return { repo: repo.id, ...(await searchRepo(repo.path, q)) };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { repo: repo.id, hits: [], truncated: false, error };
      }
    });
    return json(rows);
  }

  if (path === "/api/history" && method === "GET") {
    const c = await loadHistory(state, url.searchParams.get("refresh") === "1");
    return json(c.value);
  }

  if (path === "/api/runs" && method === "GET") {
    return json(state.runner.list());
  }
  if (path === "/api/runs" && method === "DELETE") {
    state.runner.dismiss(url.searchParams.get("id") ?? "");
    return json({ ok: true });
  }

  if (path === "/api/terms" && method === "GET") return json(await listTerms(state));
  if (path === "/api/terms/kept" && method === "GET") {
    await listTerms(state);
    return json({ keeping: (await loadConfig()).keepShells, kept: await refreshKept(state) });
  }
  if (path === "/api/terms/kept" && method === "DELETE") {
    const term = url.searchParams.get("term") ?? "";
    if (!state.kept.some((k) => k.id === term)) return json({ error: "no shell kept under that name" }, 404);
    await forgetKept(term);
    await refreshKept(state);
    return json({ ok: true });
  }
  if (path === "/api/terms/restore" && method === "POST") {
    const b = (await req.json()) as { term?: unknown; cols?: unknown; rows?: unknown; resume?: unknown };
    if (typeof b.term !== "string") return json({ error: "term must be a shell name" }, 400);
    const size = termSize(typeof b.cols === "number" ? b.cols : 80, typeof b.rows === "number" ? b.rows : 24);
    return json(await restoreTerm(state, b.term, size, b.resume === true));
  }
  if (path === "/api/keep" && method === "POST") {
    const b = (await req.json()) as { on?: unknown };
    if (typeof b.on !== "boolean") return json({ error: "on must be true or false" }, 400);
    // through the config queue: a write of its own raced every other
    // setting's and could lose one or leave the file unreadable
    await setKeepShells(b.on);
    // awaited, so the answer means the shells held right now are written;
    // a pass already running read the switch before it was set, so it is
    // waited out and a fresh one taken
    if (b.on) {
      await state.keeping;
      await keepPass(state);
    }
    return json({ keeping: b.on });
  }
  if (path === "/api/terms/paste" && method === "POST") {
    // an image the browser could not paste through the terminal, saved
    // where the shell can read it; the browser types the path in
    const live = state.terms.get(url.searchParams.get("term") ?? "");
    if (!live) return json({ error: "no such shell" }, 404);
    const host = parseLocator(live.info.path).host;
    if (host) return json({ error: `this shell runs on ${host}, where a pasted image cannot be saved` }, 400);
    const name = pasteName(live.info.id, req.headers.get("content-type") ?? "", Date.now());
    if (!name) return json({ error: "only a png, jpeg, gif or webp image can be pasted" }, 415);
    if (Number(req.headers.get("content-length") ?? 0) > PASTE_MAX) return json({ error: "the image is over 20 MB" }, 413);
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength === 0) return json({ error: "the image is empty" }, 400);
    if (bytes.byteLength > PASTE_MAX) return json({ error: "the image is over 20 MB" }, 413);
    const saved = await savePaste(name, bytes);
    return json({ path: saved, text: pasteText(saved) }, 201);
  }
  if (path === "/api/terms/agent" && method === "GET") {
    const term = url.searchParams.get("term") ?? "";
    const live = state.terms.get(term);
    if (live?.info.task || state.tasks.knows(term)) return json({ error: "that is a task, not a shell" }, 400);
    // A shell not held (yet: a panel asks as its tab appears, before its
    // socket starts the shell; or no more) runs no agent. Every caller reads
    // a failure as none anyway, so an error status would only be noise.
    if (!live || live.ending) return json({ agent: null });
    // a plain pty has no one to ask: what canopy started there may have
    // exited back to the shell, so it never counts as an agent
    if (!state.tmux) return json({ agent: null });
    const pane = await paneInfo(state.tmux, term);
    return json({ agent: pane ? await paneAgent(pane) : null });
  }
  // Whether someone is at this shell: a browser typed into it within
  // WATCH_SPAN. The tailchan hook asks before it routes an ask, so an
  // unknown shell (or a task) is simply not watched rather than an error,
  // and the hook fails safe.
  if (path === "/api/terms/watched" && method === "GET") {
    const live = state.terms.get(url.searchParams.get("term") ?? "");
    const at = live && !live.info.task ? live.lastInput : undefined;
    return json({ watched: at !== undefined && Date.now() - at < WATCH_SPAN });
  }
  // The newest transcript of the agent in a shell, in the shell's repo on
  // this machine, for a hand-off to the other harness: the pane's own agent
  // when tmux can say, else the `harness` the page names.
  if (path === "/api/terms/transcript" && method === "GET") {
    const term = url.searchParams.get("term") ?? "";
    const live = state.terms.get(term);
    if (live?.info.task || state.tasks.knows(term)) return json({ error: "that is a task, not a shell" }, 400);
    if (!live || live.ending) return json({ error: "no such shell" }, 404);
    if (parseLocator(live.info.path).host) return json({ error: "that shell runs on another machine" }, 404);
    const asked = url.searchParams.get("harness");
    const pane = state.tmux ? await paneInfo(state.tmux, term) : null;
    const running = pane ? await paneAgent(pane) : null;
    const harness = running ?? (isHarness(asked) ? asked : null);
    if (!harness) return json({ error: "no agent runs in that shell" }, 404);
    const file = await newestTranscript(harness, live.info.path);
    if (!file) return json({ error: `no ${harness} transcript in ${live.info.path}` }, 404);
    return json({ harness, path: file });
  }
  if (path === "/api/terms/text" && method === "GET") {
    const term = url.searchParams.get("term") ?? "";
    const live = state.terms.get(term);
    if (!live || live.ending) return json({ error: "no such shell" }, 404);
    // a plain pty's text is the browser terminal's own buffer, which has no
    // stale frames in it since nothing strips the alternate screen there
    if (!state.tmux) return json({ text: null, fullscreen: false });
    const got = await paneText(state.tmux, term);
    return got ? json(got) : json({ error: "tmux did not answer" }, 502);
  }
  if (path === "/api/terms" && method === "DELETE") {
    const term = url.searchParams.get("term") ?? "";
    // a task's session, held or only on record, is stopped by the task routes alone
    if (state.terms.get(term)?.info.task || state.tasks.knows(term)) return json({ error: "that is a task; stop it from its repo's tasks" }, 400);
    if (!(await endTerm(state, term))) return json({ error: "no such shell" }, 404);
    return json({ ok: true });
  }
  if (path === "/api/runs/answer" && method === "POST") {
    const b = (await req.json()) as { id?: unknown; promptId?: unknown; answer?: unknown; client?: unknown };
    const answer = parseAnswer(b.answer);
    if (typeof b.id !== "string" || typeof b.promptId !== "string" || !answer) {
      return json({ error: "malformed answer" }, 400);
    }
    // a run canopy does not hold, a prompt the run never asked (404), and
    // one it asked and is not waiting on now (409) are the browser's stale
    // view, not the server failing
    if (!state.runner.get(b.id)) return json({ error: "no such run" }, 404);
    if (!state.runner.asked(b.id, b.promptId)) return json({ error: "this run never asked that prompt" }, 404);
    if (!state.runner.waiting(b.id, b.promptId)) return json({ error: new NotWaitingError().message }, 409);
    // checked before a rule is kept: an answer of the wrong kind settles nothing
    const misfit = state.runner.misfit(b.id, b.promptId, answer);
    if (misfit) return json({ error: misfit }, 400);
    // an allow that remembers keeps its rule first: one that would not
    // cover this very prompt, or a scope the run does not have, is refused
    // and nothing is answered
    if (answer.kind === "allow" && answer.remember) {
      const { rule, scope: kind } = answer.remember;
      let held: ReturnType<Runner["rememberScope"]>;
      try {
        held = state.runner.rememberScope(b.id, b.promptId, rule);
      } catch (err) {
        return json({ error: String(err instanceof Error ? err.message : err) }, 409);
      }
      const scope = scopeOf(kind, held.scope);
      if (!scope) return json({ error: "only a workflow's step run can be remembered for its step or its workflow" }, 400);
      const by = deviceNameOf(state, typeof b.client === "string" ? b.client : null);
      await state.remembered.add(rule, scope, { ...(by ? { by } : {}), from: held.title });
      broadcast(state, { type: "remembered", rules: state.remembered.list() });
    }
    // the questions as they were asked, before the answer settles them
    const asked = state.runner.get(b.id)?.prompt;
    let run: Run;
    try {
      run = state.runner.answer(b.id, b.promptId, answer);
    } catch (err) {
      // settled by someone else while the rule above was being kept
      if (err instanceof NotWaitingError) return json({ error: err.message }, 409);
      throw err;
    }
    // the new rule may cover what other runs are waiting on
    if (answer.kind === "allow" && answer.remember) state.runner.recheck();
    // an answer inside an incubator stage is one of the sprout's inputs (amendment 6, ruling 14)
    if (answer.kind === "answers" && asked?.kind === "question" && asked.id === b.promptId) {
      state.incubator.inc.runAnswered(b.id, asked.questions, answer.answers);
    }
    return json(run);
  }
  if (path === "/api/remembered" && method === "GET") return json({ rules: state.remembered.list() });
  if (path === "/api/remembered/forget" && method === "POST") {
    const b = (await req.json()) as { id?: unknown };
    if (typeof b.id !== "string") return json({ error: "missing rule id" }, 400);
    if (!(await state.remembered.forget(b.id))) return json({ error: "no such remembered rule" }, 404);
    broadcast(state, { type: "remembered", rules: state.remembered.list() });
    return json({ rules: state.remembered.list() });
  }
  if (path === "/api/runs/stop" && method === "POST") {
    const b = (await req.json()) as { id?: unknown };
    if (typeof b.id !== "string") return json({ error: "missing run id" }, 400);
    return json(state.runner.stop(b.id));
  }
  if (path === "/api/runs/say" && method === "POST") {
    const b = (await req.json()) as { id?: unknown; text?: unknown };
    if (typeof b.id !== "string" || typeof b.text !== "string") {
      return json({ error: "missing run id or text" }, 400);
    }
    return json(state.runner.say(b.id, b.text));
  }

  if (path === "/api/verdict" && method === "GET") return json({ ready: state.flows.hasEvaluator });

  if (path === "/api/flows" && method === "GET") return json(state.flows.list());
  if (path === "/api/flows" && method === "DELETE") {
    try {
      state.flows.dismiss(url.searchParams.get("id") ?? "");
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
    return json({ ok: true });
  }
  if (path === "/api/flows/resume" && method === "POST") {
    const b = (await req.json()) as { id?: unknown; choice?: unknown };
    if (typeof b.id !== "string" || !isFlowChoice(b.choice)) return json({ error: "missing flow id or choice" }, 400);
    try {
      return json(state.flows.resume(b.id, b.choice));
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
  }
  if (path === "/api/flows/stop" && method === "POST") {
    const b = (await req.json()) as { id?: unknown };
    if (typeof b.id !== "string") return json({ error: "missing flow id" }, 400);
    try {
      return json(state.flows.stop(b.id));
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
  }

  if (path === "/api/fleets" && method === "GET") return json(state.flows.fleets());
  if (path === "/api/fleet" && method === "POST") {
    const b = (await req.json()) as { workflow?: unknown; ids?: unknown; note?: unknown };
    if (typeof b.workflow !== "string" || !Array.isArray(b.ids) || !b.ids.every((x) => typeof x === "string")) {
      return json({ error: "missing workflow or ids" }, 400);
    }
    const ids = b.ids as string[];
    const repos = ids.map((id) => state.result.repos.find((r) => r.id === id)).filter((r): r is Repo => r !== undefined);
    if (!repos.length) return json({ error: "no known repos in ids" }, 400);
    // The fleet's workflow is resolved once, from the bundled and user
    // sources: a fleet runs the same file everywhere, so repo overrides
    // do not apply.
    const wf = findWorkflow(await loadWorkflows({ path: "", host: "none" }), b.workflow);
    if (!wf) return json({ error: `unknown workflow: ${b.workflow}` }, 400);
    if (wf.listed === false) return json({ error: `${wf.name} runs only inside the incubator` }, 400);
    const note = typeof b.note === "string" ? b.note : "";
    if (wf.noteRequired && !note.trim()) return json({ error: "this workflow needs a note" }, 400);
    const cfg = await loadConfig();
    const refused = stepProfileRefusal(cfg, wf);
    if (refused) return json({ error: refused }, 400);
    await needStepHarnesses(state, cfg, wf, repos.filter((r) => !fleetSkipReason(r, wf)).map((r) => r.path));
    return json(state.flows.startFleet(repos, wf, note, (r, profile) => stepAgentFor(cfg, r.path, profile)), 201);
  }
  if (path === "/api/fleet/stop" && method === "POST") {
    const b = (await req.json()) as { id?: unknown };
    if (typeof b.id !== "string") return json({ error: "missing fleet id" }, 400);
    try {
      return json(state.flows.stopFleet(b.id));
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
  }
  if (path === "/api/fleet" && method === "DELETE") {
    try {
      state.flows.dismissFleet(url.searchParams.get("id") ?? "");
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
    return json({ ok: true });
  }

  // agent settings, per repo, keyed by path like workspaces
  if (path === "/api/launchers" && method === "GET") {
    return json((await loadConfig()).launchers);
  }
  if (path === "/api/jobs" && method === "GET") return json(state.launcher.list());
  if (path === "/api/jobs" && method === "DELETE") {
    state.launcher.dismiss(url.searchParams.get("id") ?? "");
    return json({ ok: true });
  }
  if (path === "/api/jobs/stop" && method === "POST") {
    const b = (await req.json()) as { id?: unknown };
    if (typeof b.id !== "string") return json({ error: "missing id" }, 400);
    return json(state.launcher.stop(b.id));
  }
  // agent routing: the profiles, the route per role and the repo overrides
  // (core/route); every write is normalized here and broadcast whole
  if (path === "/api/agents" && method === "GET") {
    return json(agentRoutes(await loadConfig()));
  }
  if (path === "/api/agents/profile" && method === "POST") {
    const b = (await req.json().catch(() => null)) as { name?: unknown; settings?: unknown } | null;
    if (!b || !isProfileName(b.name)) return json({ error: "a profile is named by lowercase letters, digits, - and _, up to 32" }, 400);
    if (b.settings !== null && (typeof b.settings !== "object" || Array.isArray(b.settings))) {
      return json({ error: "settings, or null to delete the profile" }, 400);
    }
    const agents = await setProfile(b.name, b.settings === null ? null : normalizeAgent(b.settings));
    broadcast(state, { type: "agents", agents });
    return json(agents);
  }
  if (path === "/api/agents/role" && method === "POST") {
    const b = (await req.json().catch(() => null)) as { role?: unknown; pick?: unknown } | null;
    if (!b || !isAgentRole(b.role)) return json({ error: "unknown role" }, 400);
    const pick = b.pick === null || b.pick === undefined ? null : normalizePick(b.pick);
    if (b.pick !== null && b.pick !== undefined && !pick) return json({ error: "a pick is a profile by name or settings of its own" }, 400);
    const why = pick ? pickRefusal(b.role, pick) : null;
    if (why) return json({ error: why }, 400);
    const agents = await setRole(b.role, pick);
    broadcast(state, { type: "agents", agents });
    return json(agents);
  }
  if (path === "/api/agents/resolve" && method === "GET") {
    const repo = repoById(state, url.searchParams.get("id") ?? "");
    const table: AgentTable = { roles: effectiveAgents(agentRoutes(await loadConfig()), repo.path), harnesses: state.harnesses() };
    return json(table);
  }
  // What a registry card's session did, from its transcript on this
  // machine (core/activity): found by harness and session id, `cwd` only
  // naming the folder Claude Code files it under, so no path reaches the disk.
  if (path === "/api/agents/activity" && method === "GET") {
    const harness = url.searchParams.get("harness");
    const session = url.searchParams.get("session") ?? "";
    if (!isHarness(harness)) return json({ error: "unknown harness" }, 400);
    if (!isSessionId(session)) return json({ error: "session must be a session id" }, 400);
    const got = await readActivity(harness, session, url.searchParams.get("cwd") ?? "");
    if (!got) return json({ error: `no ${harness} transcript of that session on ${state.backendName}` }, 404);
    return json(got);
  }

  if (path === "/api/backends" && method === "GET") {
    const cfg = await loadConfig();
    return json({ self: selfName(cfg.self, hostname()), backends: cfg.backends });
  }

  if (path === "/api/peers" && method === "GET") {
    const s = await peerSettings();
    return json({ self: s.self, peers: s.peers, seen: state.peerSeen, sync: s.peerSync });
  }
  if (path === "/api/peers/sync" && method === "POST") {
    void refreshPeers(state).catch((err) => console.error("canopy: peer pass", err));
    return json({}, 202);
  }

  if (path === "/api/workspaces" && method === "GET") {
    return json((await loadConfig()).workspaces);
  }
  // workspace membership arrives as repo ids; stored as absolute paths.
  // An unknown id is a client bug — never store it as if it were a path.
  // A forge repo has a web address where a path would be, and a workspace
  // opens its members as folders, so it cannot join one.
  const idToPath = (id: string): string => {
    const repo = repoById(state, id);
    if (repo.forge) {
      throw new HttpError(400, `${repo.name} is on the forge, not a folder a workspace can open`);
    }
    return repo.path;
  };
  if (path === "/api/workspaces" && method === "POST") {
    const b = (await req.json()) as { name: string; repos?: string[] };
    const workspaces = await upsertWorkspace(
      b.name,
      (b.repos ?? []).map(idToPath),
    );
    broadcast(state, { type: "workspaces", workspaces });
    return json(workspaces);
  }
  if (path === "/api/workspaces" && method === "DELETE") {
    const b = (await req.json()) as { name: string; repo?: string };
    const workspaces = await removeWorkspace(
      b.name,
      b.repo ? idToPath(b.repo) : undefined,
    );
    broadcast(state, { type: "workspaces", workspaces });
    return json(workspaces);
  }
  // The look: the primary (a member, by repo id) and the color, each set,
  // cleared with null, or left alone when absent. Membership never moves.
  if (path === "/api/workspaces" && method === "PATCH") {
    const b = await objectBody(req);
    if (typeof b.name !== "string") return json({ error: "missing workspace name" }, 400);
    const look: { primary?: string | null; color?: WsColor | null } = {};
    if (b.primary === null) look.primary = null;
    else if (typeof b.primary === "string") {
      // a workspace run starts in its primary, and runs start only here
      const repo = repoById(state, b.primary);
      if (repo.host) throw new HttpError(400, `${repo.name} is on ${repo.host}; a workspace run starts in a primary on this machine`);
      look.primary = idToPath(b.primary);
    }
    else if (b.primary !== undefined) return json({ error: "a primary is a repo id or null" }, 400);
    if (b.color === null) look.color = null;
    else if (isWsColor(b.color)) look.color = b.color;
    else if (b.color !== undefined) return json({ error: "unknown color" }, 400);
    let workspaces: Workspace[];
    try {
      workspaces = await setWorkspaceLook(b.name, look);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg === "unknown workspace") throw new HttpError(404, msg);
      if (msg.startsWith("not a member of ")) throw new HttpError(400, msg);
      throw err;
    }
    broadcast(state, { type: "workspaces", workspaces });
    return json(workspaces);
  }
  // One run on the primary, the other local members added as folders. Every
  // local member must be free: a run or a workflow going on any of them
  // refuses it. While it runs only the primary is held, the way every run
  // holds its repo. A seed's agents run only through the incubator, behind
  // its git guards and in its stage, so a seed primary refuses the run and a
  // seed member is left out like one on another host.
  if (path === "/api/workspaces/run" && method === "POST") {
    const b = await objectBody(req);
    if (typeof b.name !== "string") return json({ error: "missing workspace name" }, 400);
    if (!isRunAction(b.action)) return json({ error: "unknown action" }, 400);
    const ws = (await loadConfig()).workspaces.find((w) => w.name === b.name);
    if (!ws) return json({ error: "unknown workspace" }, 404);
    const primaryPath = effectivePrimary(ws);
    if (!primaryPath) return json({ error: "the workspace has no repos" }, 400);
    const primary = state.result.repos.find((r) => r.path === primaryPath);
    if (!primary) return json({ error: `the primary ${primaryPath} is not among the scanned repos` }, 404);
    if (isSeedPath(state.root, primary.path)) throw new HttpError(400, SEED_AGENT_REFUSAL);
    const { others, skipped } = splitMembers(ws, primaryPath, state.result.repos, (r) => isSeedPath(state.root, r.path));
    for (const r of others) {
      const busy = state.runner.activeFor(r.id);
      if (busy) throw new HttpError(409, busyWith(r.name, busy.verb));
      if (state.flows.activeFor(r.id)) throw new HttpError(409, `a workflow is running in ${r.name}`);
    }
    const note = typeof b.note === "string" ? b.note : "";
    const scope: WorkspaceScope = { workspace: ws.name, primary: primary.path, others: others.map((r) => r.path), skipped };
    return json(await startRepoRun(state, primary, b.action, note, b.client, scope), 201);
  }
  if (path === "/api/workspaces/open" && method === "POST") {
    const b = (await req.json()) as { name: string; app: string; helper?: unknown };
    if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
    const via = openVia(state, here, b.helper);
    const cfg = await loadConfig();
    const ws = cfg.workspaces.find((w) => w.name === b.name);
    if (!ws) return json({ error: "unknown workspace" }, 404);
    const primary = effectivePrimary(ws) ?? undefined;
    if (via.via === "backend") {
      await openGroup(b.app, b.name, ws.repos, (p) => agentFor(cfg, p), primary);
    } else {
      const agents: Record<string, AgentSettings> = {};
      const repos = ws.repos.map((p) => {
        const there = helperPath(p);
        agents[there] = agentFor(cfg, p);
        return there;
      });
      const group = { app: b.app, name: b.name, repos, agents, ...(primary ? { primary: helperPath(primary) } : {}) };
      await askHelper(state, via.name, { group });
    }
    return json({ ok: true });
  }

  // /api/repos/<action>?id=<repo id> — the id rides in the query string
  // because it can be "." (the scan root itself), and a "." path segment is
  // normalized away before the request ever reaches us.
  const m = /^\/api\/repos\/([a-z]+)$/.exec(path);
  if (m) {
    const repo = repoById(state, url.searchParams.get("id") ?? "");
    const action = m[1];
    // Archiving is canopy's own mark, not git's, so a forge-only card can
    // take it too; it comes ahead of the forge refusal below.
    if (method === "POST" && action === "archive") {
      const body = (await req.json().catch(() => null)) as { archived?: unknown } | null;
      if (typeof body?.archived !== "boolean") throw new HttpError(400, "archived must be true or false");
      state.archived = new Set(await setArchived(repo.path, body.archived));
      // Re-found after the write: a rescan may have replaced the array.
      const idx = state.result.repos.findIndex((r) => r.id === repo.id);
      const now = state.result.repos[idx];
      if (!now) throw new HttpError(404, `unknown repo: ${repo.id}`);
      const [marked] = linkArchived([now], state.archived);
      state.result.repos[idx] = marked!;
      broadcast(state, { type: "repo", repo: marked! });
      return json(marked);
    }
    // The star is canopy's own mark too, so it sits here for the same reason.
    if (method === "POST" && action === "favorite") {
      const body = (await req.json().catch(() => null)) as { favorite?: unknown } | null;
      if (typeof body?.favorite !== "boolean") throw new HttpError(400, "favorite must be true or false");
      state.favorites = new Set(await setFavorite(repo.path, body.favorite));
      const idx = state.result.repos.findIndex((r) => r.id === repo.id);
      const now = state.result.repos[idx];
      if (!now) throw new HttpError(404, `unknown repo: ${repo.id}`);
      const [starred] = linkFavorites([now], state.favorites);
      state.result.repos[idx] = starred!;
      broadcast(state, { type: "repo", repo: starred! });
      return json(starred);
    }
    // A forge repo is a listing, not a checkout: git has nothing to run
    // against and no folder to open. Where the clone is known, say so — the
    // card next to it is the one that answers.
    if (repo.forge) {
      const clone = repo.forge.clonedAs;
      throw new HttpError(
        400,
        clone === undefined
          ? `${repo.name} is only on the forge — clone it before ${action}`
          : `${repo.name} is the forge's copy — ${action} belongs to the clone, ${clone}`,
      );
    }

    if (method === "GET" && action === "log") {
      return json(await getLog(repo.path));
    }
    if (method === "GET" && action === "access") {
      // Resolve the identity once per server, not once per request.
      if (state.login === undefined) state.login = await githubLogin();
      return json({
        access: await pushAccess(repo.path, {
          login: state.login,
          permission: state.access,
        }),
      });
    }
    if (method === "GET" && action === "resumable") {
      // Claude Code and Codex conversations started at the repo on this
      // machine, read straight off ~/.claude and ~/.codex, so it answers
      // without claude-history
      return json(repo.host ? [] : await agentSessions(repo.path));
    }
    if (method === "POST" && action === "resume") {
      const b = (await req.json()) as { term?: unknown; place?: unknown; session?: unknown; harness?: unknown; cols?: unknown; rows?: unknown };
      if (!isTermId(b.term)) return json({ error: "a shell is named by 32 hex digits in term" }, 400);
      if (!isSessionId(b.session)) return json({ error: "session must be a session id" }, 400);
      // a page from before harnesses resumes claude, all it ever listed
      const harness = b.harness === undefined ? "claude" : b.harness;
      if (!isHarness(harness)) return json({ error: "unknown harness" }, 400);
      if (isSeedPath(state.root, repo.path)) return json({ error: SEED_AGENT_REFUSAL }, 400);
      return json(await resumeTerm(state, repo, b.term, termPlace(b.place), b.session, harness, termSize(b.cols, b.rows)), 201);
    }
    if (method === "GET" && action === "sessions") {
      const { bin, project } = await historyContext(state, repo);
      const w = url.searchParams.get("since") ?? "30d";
      if (!isHistoryWindow(w)) return json({ error: "unknown window" }, 400);
      return json(await historySessions(bin, project, w));
    }
    if (method === "GET" && action === "session") {
      const { bin, project } = await historyContext(state, repo);
      const sid = url.searchParams.get("session") ?? "";
      return json(await historySession(bin, project, sid));
    }
    if (method === "GET" && action === "grep") {
      return json(await searchRepo(repo.path, grepQuery(url.searchParams.get("q"))));
    }
    if (method === "POST" && action === "openfile") {
      const b = (await req.json()) as { file?: unknown; line?: unknown; helper?: unknown };
      if (typeof b.file !== "string" || b.file === "" || b.file.includes("\0")) {
        return json({ error: "file must be a path in the repo" }, 400);
      }
      const line = typeof b.line === "number" && Number.isInteger(b.line) && b.line > 0 ? b.line : 1;
      const via = openVia(state, here, b.helper);
      if (via.via === "backend") await openFile(repo.path, b.file, line);
      else await askHelper(state, via.name, { file: { path: helperPath(repo.path), file: b.file, line } });
      return json({ ok: true });
    }
    if (method === "GET" && action === "search") {
      const { bin, project } = await historyContext(state, repo);
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ error: "empty query" }, 400);
      return json(await historySearch(bin, project, q));
    }
    if (method === "POST" && action === "note") {
      const { bin, project } = await historyContext(state, repo);
      const b = (await req.json()) as { session?: unknown };
      if (typeof b.session !== "string") return json({ error: "missing session" }, 400);
      await openHistoryNote(bin, project, b.session);
      return json({ ok: true });
    }
    if (method === "GET" && action === "commit") {
      const hash = url.searchParams.get("hash") ?? "";
      if (!isHash(hash)) return json({ error: "invalid commit hash" }, 400);
      try {
        return json(await getCommit(repo.path, hash));
      } catch (err) {
        if (err instanceof UnknownCommitError) {
          throw new HttpError(404, err.message);
        }
        throw err;
      }
    }
    if (method === "GET" && action === "diff") {
      const file = url.searchParams.get("file") ?? "";
      const commit = url.searchParams.get("commit");
      const orig = url.searchParams.get("orig");
      let target: DiffTarget;
      if (commit !== null) {
        if (!isHash(commit)) return json({ error: "invalid commit hash" }, 400);
        target =
          orig === null
            ? { kind: "commit", hash: commit }
            : { kind: "commit", hash: commit, orig };
      } else if (url.searchParams.get("untracked") === "1") {
        target = { kind: "untracked" };
      } else {
        target = {
          kind: "worktree",
          staged: url.searchParams.get("staged") === "1",
        };
      }
      const diff = await getDiff(repo.path, file, target);
      return json({ diff });
    }
    if (method === "POST" && action === "stage") {
      const b = (await req.json()) as { file: string; unstage?: boolean; orig?: unknown };
      await stageFile(repo.path, b.file, b.unstage ?? false, typeof b.orig === "string" ? b.orig : undefined);
      return json(await refreshAndBroadcast(state, repo.id));
    }
    if (method === "POST" && action === "commit") {
      const b = (await req.json()) as { message: string; stageAll?: boolean };
      if (!b.message?.trim()) return json({ error: "empty message" }, 400);
      const out = await commit(repo.path, b.message, {
        stageAll: b.stageAll ?? false,
      });
      await refreshAndBroadcast(state, repo.id);
      return json({ ok: true, out });
    }
    if (method === "POST" && action === "push") {
      const out = await push(repo.path);
      await refreshAndBroadcast(state, repo.id);
      return json({ ok: true, out });
    }
    if (method === "POST" && action === "pull") {
      const out = await pull(repo.path);
      await refreshAndBroadcast(state, repo.id);
      return json({ ok: true, out });
    }
    if (method === "POST" && action === "suggest") {
      const files = repo.status?.files ?? [];
      return json(await suggestMessage(repo.path, files, agentFor(await loadConfig(), repo.path, "suggest"), { seed: isSeedPath(state.root, repo.path) }));
    }
    if (method === "POST" && action === "open") {
      const b = (await req.json()) as { app: string; tab?: unknown; helper?: unknown };
      if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
      const via = openVia(state, here, b.helper);
      const agent = agentFor(await loadConfig(), repo.path);
      const tab = b.tab === true;
      // the backend's own desktop runs the agent here, so its harness has to
      // be here; a helper's machine answers for itself
      if (via.via === "backend" && (b.app === "agent" || b.app === "herdr")) await needHarness(state, agent.harness, repo.path);
      if (via.via === "backend") await openIn(b.app, repo.path, agent, { tab });
      else await askHelper(state, via.name, { open: { app: b.app, path: helperPath(repo.path), agent, tab } });
      return json({ ok: true });
    }
    if (method === "POST" && action === "agent") {
      // Validated field by field: a stray value must not reach a command
      // line. A body of plain settings is a page from before roles: the
      // repo's whole-repo pick, and at the builtin defaults its reset, the
      // way that page meant them. That page knows of no roles, so the
      // repo's per-role picks stay as they are either way.
      const raw: unknown = await req.json().catch(() => null);
      const legacy =
        typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length > 0 && !("all" in raw) && !("roles" in raw);
      if (legacy) {
        const all = normalizeAgent(raw);
        const agents = await setRepoAll(repo.path, isDefaultAgent(all) ? null : all);
        broadcast(state, { type: "agents", agents });
        return json(agents);
      }
      const next = normalizeRepoAgent(raw);
      const why = repoAgentRefusal(next);
      if (why) return json({ error: why }, 400);
      const agents = await setRepoAgent(repo.path, next);
      broadcast(state, { type: "agents", agents });
      return json(agents);
    }
    if (method === "POST" && action === "refresh") {
      return json(await refreshAndBroadcast(state, repo.id));
    }
    if (method === "GET" && action === "workflows") {
      // the incubator's stages run only from the incubator
      return json((await loadWorkflows(repo)).filter((e) => !e.ok || e.workflow.listed !== false));
    }
    // The launcher. Releases are read and installed for any repo with a
    // GitHub remote, wherever its checkout is: the download lands here and
    // runs here. Builds need the checkout, so a repo on another host gets
    // 400 from the launcher itself.
    if (method === "GET" && action === "releases") {
      return json(await state.launcher.releases(repo, launchFor(await loadConfig(), repo.path)));
    }
    if (method === "GET" && action === "pulls") {
      return json(await state.launcher.pulls(repo));
    }
    if (method === "GET" && action === "builds") {
      return json(await state.launcher.builds(repo, launchFor(await loadConfig(), repo.path)));
    }
    if (method === "POST" && action === "install") {
      if (!hostOpeners()) return json({ error: NO_DESKTOP }, 400);
      const b = (await req.json()) as { tag?: unknown; asset?: unknown };
      if (typeof b.tag !== "string" || !b.tag) return json({ error: "missing tag" }, 400);
      const asset = typeof b.asset === "string" && b.asset ? b.asset : null;
      const job = await state.launcher.install(repo, b.tag, asset, launchFor(await loadConfig(), repo.path));
      return json(job, 201);
    }
    if (method === "POST" && action === "build") {
      if (isSeedPath(state.root, repo.path)) return json({ error: "a seed is built by its own stages; the launcher builds it once it ships" }, 400);
      if (!hostOpeners()) return json({ error: NO_DESKTOP }, 400);
      const b = (await req.json()) as { pr?: unknown };
      const ref =
        b.pr === undefined || b.pr === null
          ? ({ kind: "local" } as const)
          : typeof b.pr === "number" && Number.isInteger(b.pr) && b.pr > 0
            ? ({ kind: "pr", number: b.pr } as const)
            : null;
      if (!ref) return json({ error: "pr must be a pull request number" }, 400);
      return json(await state.launcher.build(repo, ref, launchFor(await loadConfig(), repo.path)), 201);
    }
    if (method === "POST" && action === "launch") {
      if (!hostOpeners()) return json({ error: NO_DESKTOP }, 400);
      const b = (await req.json()) as { build?: unknown };
      if (typeof b.build !== "string") return json({ error: "missing build" }, 400);
      return json(await state.launcher.launch(repo, b.build, launchFor(await loadConfig(), repo.path)));
    }
    if (method === "POST" && action === "halt") {
      const b = (await req.json()) as { build?: unknown };
      if (typeof b.build !== "string") return json({ error: "missing build" }, 400);
      return json({ ok: true, stopped: state.launcher.stopLaunch(repo, b.build) });
    }
    if (method === "POST" && action === "uninstall") {
      const b = (await req.json()) as { build?: unknown };
      if (typeof b.build !== "string") return json({ error: "missing build" }, 400);
      await state.launcher.remove(repo, b.build);
      return json({ ok: true });
    }
    if (method === "POST" && action === "launcher") {
      const launchers = await setLaunch(repo.path, normalizeLaunch(await req.json()));
      broadcast(state, { type: "launchers", launchers });
      return json(launchers);
    }
    if (method === "POST" && action === "flow") {
      if (repo.host) return json({ error: `agent runs only work on this machine; ${repo.name} is on ${repo.host}` }, 400);
      const b = (await req.json()) as { workflow?: unknown; note?: unknown };
      if (typeof b.workflow !== "string") return json({ error: "missing workflow" }, 400);
      const entries = await loadWorkflows(repo);
      const wf = findWorkflow(entries, b.workflow);
      if (wf?.listed === false) return json({ error: `${wf.name} runs only inside the incubator` }, 400);
      if (!wf) {
        const broken = entries.find((e) => !e.ok && e.name === b.workflow);
        return json({ error: broken && !broken.ok ? broken.error : `unknown workflow: ${b.workflow}` }, 400);
      }
      const note = typeof b.note === "string" ? b.note : "";
      const cfg = await loadConfig();
      const refused = stepProfileRefusal(cfg, wf);
      if (refused) return json({ error: refused }, 400);
      await needStepHarnesses(state, cfg, wf, [repo.path]);
      try {
        return json(state.flows.start(repo, wf, note, (profile) => stepAgentFor(cfg, repo.path, profile)), 201);
      } catch (err) {
        throw new HttpError(400, String(err instanceof Error ? err.message : err));
      }
    }
    if (method === "POST" && action === "run") {
      const b = await objectBody(req);
      if (!isRunAction(b.action)) return json({ error: "unknown action" }, 400);
      const note = typeof b.note === "string" ? b.note : "";
      return json(await startRepoRun(state, repo, b.action, note, b.client), 201);
    }
    if (method === "POST" && action === "peer") {
      if (!peerable(state, repo)) throw new HttpError(400, "peer sync covers local repos under the launch root");
      const raw: unknown = await req.json().catch(() => null);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "malformed body");
      const body = raw as { action?: unknown; peer?: unknown; branch?: unknown };
      const bodyAction = body.action;
      if (!isPeerAction(bodyAction)) throw new HttpError(400, `unknown action: ${String(body.action)}`);
      const s = await peerSettings();
      if (!s.self) throw new HttpError(400, "peers are not set up: no self in the config");
      const self = s.self;
      // Off blocks every action; dry (below) governs only the background
      // pass and this route's own "sync" — take and track are explicit user
      // actions and always run for real.
      if (s.peerSync === "off") throw new HttpError(409, "peer sync is off");
      const needPeer = bodyAction === "take" || bodyAction === "track";
      if (needPeer) {
        if (typeof body.peer !== "string" || body.peer === "") throw new HttpError(400, "peer is required");
        if (typeof body.branch !== "string" || body.branch === "") throw new HttpError(400, "branch is required");
      }
      const peer = s.peers.find((p) => p.name === body.peer);
      if (needPeer && !peer) throw new HttpError(404, `unknown peer: ${String(body.peer)}`);
      // The same conflicts the run action refuses on: a Claude run or a
      // workflow already has this repo, and initRepo/syncRepo/takeWip could
      // step on files or refs either of those is using.
      const activeRun = state.runner.activeFor(repo.id);
      if (activeRun) throw new HttpError(409, busyWith(repo.name, activeRun.verb));
      if (state.flows.activeFor(repo.id)) throw new HttpError(409, "a workflow is running here");
      const dry = s.peerSync === "dry";
      let take: unknown;
      try {
        // Only take answers with something; the rest answer the repo alone.
        take = await runPeerAction<unknown>(state, bodyAction, {
          sync: async () => {
            await initRepo(repo.path, repo.id, s.peers, dry);
            applyPeerState(state, repo.id, await syncRepo(repo.id, { self, peers: s.peers, seed: s.seed, dry, root: state.root }, new PassSeen()));
          },
          take: () => takeWip(repo.path, peer!.name, body.branch as string),
          track: () => trackBranch(repo.path, peer!.name, body.branch as string),
          seed: async () => {
            await seedRepo(repo.path, repo.id, s.peers, s.seed, dry);
          },
        });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(409, String(err instanceof Error ? err.message : err));
      }
      const fresh = await refreshAndBroadcast(state, repo.id);
      return json(take ? { ...fresh, take } : fresh);
    }
  }
  return json({ error: "not found" }, 404);
}

function sse(state: ServerState, who: Stream | null): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      state.clients.add(c);
      c.enqueue(enc.encode(`: hello\n\n`));
      if (who) {
        state.streams.set(c, who);
        tellDevices(state);
      }
    },
    cancel() {
      state.clients.delete(ctrl);
      if (state.streams.delete(ctrl)) tellDevices(state);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Thrown when the port cannot be bound, so the CLI can suggest --port instead
 * of surfacing Bun's raw "Failed to start server" text. Deliberately not named
 * "in use": Bun reports EADDRINUSE for privileged ports too, where the real
 * cause is a missing root, so only the caller can tell the two apart.
 */
export class PortUnavailableError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is unavailable`);
    this.name = "PortUnavailableError";
  }
}

function bind<T>(port: number, listen: () => T): T {
  try {
    return listen();
  } catch (err) {
    // Match on the errno, not the message — Bun's wording is not an API.
    if ((err as { code?: string }).code === "EADDRINUSE") {
      throw new PortUnavailableError(port);
    }
    throw err;
  }
}

export async function startServer(opts: {
  root: string;
  port?: number;
  /** tailchan's address and handles; absent reads them off the env and the
   *  CLI's config, null turns tailchan off */
  chan?: ChanConfig | null;
  /** task timings, shrunk by tests */
  tasks?: Partial<TaskTimings>;
  /** the line start=agent types into a new shell; tests swap in a stand-in */
  agentLine?: (repo: Repo, agent: AgentSettings, env: AgentEnv) => Promise<string>;
  /** the harnesses the backend has, in place of looking on PATH; tests */
  harnesses?: Harness[];
  /** the agent registry's timings and scan; tests turn the scan on with a
   *  stand-in lister (it is off under `bun test` and `CANOPY_AGENT_SCAN=0`) */
  registry?: { scanEvery?: number; relistEvery?: number; lister?: () => Promise<AgentProc[]>; container?: boolean };
  /** the asks hub's timings, shrunk by tests */
  asks?: { closedKeep?: number; relistEvery?: number; sweepEvery?: number };
  /** the incubator: tests turn autostart off and pass a speech model and
   *  vault of their own; `stage` is the stage runner's client in place of
   *  CANOPY_STAGE_SOCKET's (null for none), `unisolated` stands in for
   *  CANOPY_INCUBATOR_UNISOLATED=1, and `stageEvery` is how often the
   *  runner is asked whether it answers */
  incubator?: {
    autostart?: boolean;
    transcribe?: Transcriber | null;
    notes?: NoteSink | null;
    ship?: Shipper | null;
    /** where a renovate or extend seed comes from; seedSource unless a test says */
    source?: SeedSource | null;
    stage?: StageClient | null;
    unisolated?: boolean;
    stageEvery?: number;
    /** what accepting a piece of retro advice does, in place of the chat or the file */
    accept?: (entry: AdviceEntry) => Promise<AdviceAccepted>;
    /** how often a park is looked at for its day-old retro */
    tickEvery?: number;
  };
  /** the runner's driver per harness; tests swap in a stand-in agent */
  /** `quietWait` shortens how long a stage run's or check's end waits for
   *  the stage runner to call its seed quiet, for tests */
  runner?: { driver?: (harness: Harness) => RunDriver; quietWait?: number };
}): Promise<{ port: number; stop: () => void }> {
  const cfg = await loadConfig();
  const root = await realpath(opts.root);
  // canopy's git in a seed goes through the guard (seedgit.ts)
  setSeedRoots([join(root, SEEDS_DIR)]);
  // and codex trusts no seed, so none of its own .codex/ config is read (codextrust.ts)
  void sweepCodexTrust(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), join(root, SEEDS_DIR))
    .then((changed) => changed && console.log("canopy: dropped codex's trust in incubator seeds"))
    .catch(() => {});
  const port = opts.port ?? cfg.port;
  const runtime = (src: Source): SourceRuntime => ({
    src: { ...src, repos: 0, scannedAt: 0 },
    watcher: null,
    probed: new Set(),
    scanning: null,
  });
  // A stored source that is the launch root again would list every repo
  // twice; the launch root wins and keeps its bare ids.
  const extras = cfg.sources.filter((s) => s.kind !== "local" || s.path !== root);
  const fixed = opts.harnesses;
  // one broker address for tailchan and the registry both
  const chanCfg = opts.chan === undefined ? loadChanConfig() : opts.chan;
  // canopy holds no answer token (each browser keeps its own key, which
  // server/asks.ts forwards), but a deploy from before may still set one:
  // it is never read, and kept out of every shell, run and tmux server
  // started from here all the same (`exec` and `termEnv` pass the live env).
  delete process.env["CANOPY_TAILCHAN_ANSWER_TOKEN"];
  // A canopy started from a canopy shell carries that shell's own names
  // (CANOPY_TERM, TAILCHAN_AS and the rest), which every child would
  // otherwise inherit through `{...process.env}`.
  for (const k of INHERITED_ENV) delete process.env[k];
  const scanOff = process.env["CANOPY_AGENT_SCAN"] === "0" || process.env["NODE_ENV"] === "test";
  // Which harnesses a start may use: fixed by a test, else this process's
  // PATH together with what the user's login shell finds (an rc file's
  // PATH, an nvm install, an alias), which is where a canopy shell and the
  // agent opener type the agent in. Under `bun test` the login shell is
  // left alone: a test's backend is the PATH it runs with.
  const login = fixed || process.env["NODE_ENV"] === "test" ? null : new LoginHarnesses();
  const harnesses = fixed ? () => [...fixed] : login ? () => login.list() : availableHarnesses;
  const harnessMissing = fixed
    ? async (h: Harness) => !fixed.includes(h)
    : login
      ? (h: Harness) => login.missing(h)
      : async (h: Harness) => !availableHarnesses().includes(h);
  // Stages fail closed. With CANOPY_STAGE_SOCKET set, a stage runs only
  // through the stage runner, and waits while it is away. Without it, a
  // stage runs here only under CANOPY_INCUBATOR_UNISOLATED=1; otherwise no
  // stage starts at all.
  const socket = process.env["CANOPY_STAGE_SOCKET"];
  const stage: StageClient | null = opts.incubator?.stage !== undefined ? opts.incubator.stage : socket ? new StageClient(socket) : null;
  const unisolated = opts.incubator?.unisolated ?? process.env["CANOPY_INCUBATOR_UNISOLATED"] === "1";
  /** Why an answering runner may not start a stage: its fence is not
   *  confirmed (no probe target, the first probe still out, or a probe that
   *  got through), in its own words. Null once its probe timed out. */
  const unfencedWhy = (): string | null => {
    if (!stage || stage.harnessesNow() === null) return null;
    const f = stage.fenceNow();
    return f?.fenced === true ? null : (f?.reason ?? "the stage runner says nothing of its fence: update the stages image");
  };
  const isolation = (): string | null =>
    stage
      ? stage.harnessesNow()
        ? unfencedWhy()
        : STAGE_AWAY
      : unisolated
        ? null
        : "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1";
  /** a stage's runs and checks: the runner's client while it answers behind
   *  its fence, null while it is away or unfenced (the stage waits),
   *  undefined to run here unisolated */
  const stageFor = (): StageClient | null | undefined =>
    stage ? (stage.harnessesNow() && unfencedWhy() === null ? stage : null) : unisolated ? undefined : null;
  /** what a stage run or check says when `stageFor` gives null: the
   *  runner's absence, or the env to set when no runner is set up */
  const stageAway = (): string => isolation() ?? STAGE_AWAY;
  // On an isolated backend canopy runs no git in a seed: every call goes to
  // the stage runner and runs as the stage user, and while the runner is
  // away or unfenced it waits, never running here instead (amendment 4).
  // Unisolated, seed git runs here behind the guard as before. A stopped
  // server's seeds stay away, so a refresh or a mirror sync still in flight
  // never falls back to git here; the hook answers for this root's seeds
  // alone, so another backend's (a later server's) are its own.
  let stopped = false;
  setSeedGit(
    stage
      ? seedGitThrough(
          () => (stopped ? null : (stageFor() ?? null)),
          () => (stopped ? "canopy is stopping" : stageAway()),
          seedRootsNow,
          (path) => isSeedPath(root, path),
        )
      : null,
  );
  if (process.env["NODE_ENV"] !== "test") {
    console.log(
      stage
        ? `stages: isolated through ${socket ?? "the stage runner"}`
        : unisolated
          ? "stages: not isolated (CANOPY_INCUBATOR_UNISOLATED=1)"
          : "stages: off until the stage runner is set up",
    );
  }
  // the rules an allow said to remember, in the config dir
  const remembered = new RememberedRules();
  // every run is told which backend started it (CANOPY_BACKEND), and codex
  // hears canopy's version in its handshake
  const runnerOpts = {
    remembered: () => remembered.list(),
    backend: selfName(cfg.self, hostname()),
    version: readPkg().version ?? "0",
    // a seed's runs are an incubator stage's: no GitHub login of canopy's
    stage: (repo: Repo) => isSeedPath(root, repo.path),
    stageExec: stageFor,
    stageAway,
    ...(opts.runner?.driver ? { driver: opts.runner.driver } : {}),
    ...(opts.runner?.quietWait !== undefined ? { quietWait: opts.runner.quietWait } : {}),
  };
  /** seeds with a check running, by the seed's path */
  const seedChecks = new Map<string, number>();
  /** checks whose seed the stage runner still calls busy, let go on stop */
  const checkHolds = new Set<QuietHold>();
  const runner = new Runner({
    onChange: (run) => {
      broadcast(state, { type: "run", run });
      state.flows.onRun(run);
      state.chan.onRun(run);
    },
    onGone: (id) => {
      broadcast(state, { type: "run-gone", id });
      state.chan.forget(id);
    },
    // Re-read status directly rather than waiting on the watcher's
    // debounce: the card and the run's outcome should agree at once.
    status: (repoId) => freshStatus(state, repoId),
  }, runnerOpts);
  // set once this server holds the flows folder (after the bind); without it
  // no record is written or removed
  let flowFiles: FlowFiles | null = null;
  const flows = new Flows(runner, {
    onChange: (flow) => {
      broadcast(state, { type: "flow", flow });
      state.chan.onFlow(flow);
      state.incubator.onFlow(flow);
    },
    onGone: (id) => {
      broadcast(state, { type: "flow-gone", id });
      state.chan.forget(id);
    },
    onFleet: (fleet) => {
      broadcast(state, { type: "fleet", fleet });
      state.chan.onFleet(fleet);
    },
    onFleetGone: (id) => {
      broadcast(state, { type: "fleet-gone", id });
      state.chan.forget(id);
    },
    // a seed's check starts without canopy's GitHub login, like its runs
    check: async (repo, command) => {
      // @name is a built-in canopy runs itself over readSeed, never a shell line
      if (isBuiltinCheck(command)) return builtinCheck(command, repo.path);
      if (!isSeedPath(root, repo.path)) return runCheck(repo, command, false);
      // canopy runs no git in any seed while a check runs in one (seedgit.ts),
      // nor after it while the stage runner still says something runs there
      seedChecks.set(repo.path, (seedChecks.get(repo.path) ?? 0) + 1);
      const drop = (): void => {
        const n = (seedChecks.get(repo.path) ?? 1) - 1;
        if (n > 0) seedChecks.set(repo.path, n);
        else seedChecks.delete(repo.path);
      };
      const client = stageFor();
      let held = false;
      try {
        const result = await runCheck(repo, command, true, client, stageAway());
        if (client) {
          const hold = holdQuiet(client, repo.path, runnerOpts.quietWait ?? QUIET_WAIT, "check");
          checkHolds.add(hold);
          held = true;
          void hold.released.then(() => {
            checkHolds.delete(hold);
            drop();
          });
          await hold.settled;
        }
        return result;
      } finally {
        if (!held) drop();
      }
    },
    evaluator: hasGatewayKey() ? jev : null,
    judge: hasGatewayKey() ? jevJudge : null,
    // a seed's answers.md is canopy's record, built at the gate from its own
    // store; the seed's copy is a summary any stage could have written over
    evidence: async (repo, paths) => {
      const files = await readEvidence(repo.path, paths);
      if (!isSeedPath(root, repo.path) || !paths.includes(ANSWERS_FILE)) return files;
      return withStoredAnswers(files, (await state.incubator.inc.answersEvidence(repo.path)) ?? null);
    },
    save: (rec) => flowFiles?.save(rec),
    forget: (id) => flowFiles?.forget(id),
    // a step's run ends on its result, while its process may still be going;
    // a seed's gate reads status once that process is gone and the seed quiet
    status: async (repoId) => {
      const repo = state.result.repos.find((r) => r.id === repoId);
      if (repo && isSeedPath(root, repo.path)) await runner.whenQuiet(repo.path);
      return freshStatus(state, repoId);
    },
  });
  const launcher = new Launcher({
    onJob: (job) => broadcast(state, { type: "job", job }),
    onJobGone: (id) => broadcast(state, { type: "job-gone", id }),
    onBuilds: (repoId, what, build) => broadcast(state, { type: "builds", repoId, what, build }),
  });
  const vault = vaultConfig();
  const speech = transcribeConfig();
  const ship = shipConfig(process.env, runnerOpts.backend);
  // The configs hold what they read; the env keeps neither secret, so no
  // shell, run or tmux server started from here inherits them (`exec` and
  // `termEnv` pass the live env). /proc/<pid>/environ still shows the
  // values canopy was started with, which deletion cannot reach.
  for (const k of SECRET_ENV) delete process.env[k];
  if (process.env["NODE_ENV"] !== "test") {
    if (!vault) console.error("incubator: no CANOPY_VAULT_TOKEN, so no vault notes");
    if (!speech) console.error("incubator: no CANOPY_TRANSCRIBE_URL, so voice memos stay untranscribed");
    if (!ship.vercelToken) console.error("incubator: no VERCEL_TOKEN, so a built project parks before its deploy");
    if (!ship.firebaseToken) console.error("incubator: no FIREBASE_TOKEN, so a vercel+firebase project parks before its deploy");
  }
  // one store, stamped with the realpath'd root, for the incubator and for
  // what a server without the flows lock lists
  const sprouts = new SproutFiles(root);
  // the improvements list retros fold into, and the page hears of each change
  const adviceFiles = new AdviceFiles(undefined, (advice) => broadcast(state, { type: "advice", advice }));
  const state: ServerState = {
    root,
    agentLine: opts.agentLine ?? (async (_repo, agent, env) => agentLine(agent, undefined, env)),
    harnesses,
    harnessMissing,
    about: {
      ...readBuild(),
      startedAt: Date.now(),
      bun: Bun.version,
      platform: process.platform,
      arch: arch(),
      hostname: hostname(),
      root,
      homepage: readPkg().homepage ?? null,
    },
    sources: [runtime(launchSource(root)), ...extras.map((s) => runtime({ ...s, launch: false }))],
    result: { root, sources: [], repos: [], scannedAt: 0, backend: backendCaps(harnesses()) },
    ignore: [...DEFAULT_IGNORE, ...cfg.ignore],
    access: new Map(),
    clients: new Set(),
    streams: new Map(),
    helpers: new Map(),
    gateway: await defaultGateway(),
    timers: new Map(),
    history: null,
    historyPending: null,
    terms: new Map(),
    tmux: tmuxBase(),
    runner,
    remembered,
    flows,
    launcher,
    chan: new ChanHub(chanCfg, {
      broadcast: (ev) => broadcast(state, ev),
      repoName: (id) => state.result.repos.find((r) => r.id === id)?.name ?? id,
      isFlowRun: (runId) => state.flows.list().some((f) => f.steps.some((st) => st.runId === runId)),
      isSproutFlow: (flow) => state.incubator.speaksFor(flow),
    }),
    tasks: new TaskHub({
      tmux: tmuxBase(),
      repos: () => state.result.repos,
      own: async (repo) => {
        // a seed's tasks.json is the agents' to write: nothing in it starts on its own
        if (isSeedPath(root, repo.path)) return false;
        // no remote is never the user's by this test, and asking gh costs a process
        if (!repo.remotes?.length) return false;
        if (state.login === undefined) state.login = await githubLogin();
        return (await accessFromUrls(repo.remotes ?? [], { login: state.login, permission: state.access })) === "ok";
      },
      viewers: (id) => {
        const t = state.terms.get(id);
        return t ? termInfo(state, t).viewers : [];
      },
      hold: (info) => {
        if (!state.terms.has(info.id)) state.terms.set(info.id, { info, pty: null, sockets: new Set() });
      },
      broadcast: (ev) => broadcast(state, ev),
      gaveUp: (repo, task) => state.chan.onTaskGaveUp(repo, task),
      ...(opts.tasks ? { timings: opts.tasks } : {}),
    }),
    pulls: new Map(),
    archived: new Set(cfg.archived),
    favorites: new Set(cfg.favorites),
    own: new Map(),
    // Seeded from settings at startup, not []: fetchLocal can run before
    // the first peer pass does (refreshActivity fetches, then peers), and
    // an empty seed would have it treat every existing peer remote as the
    // user's own for that one pass, fetching and reading tips off it,
    // before the pass corrects it and clears own again.
    peerNamesSeen: (await peerSettings()).peers,
    peerStates: new Map(),
    peerSeen: [],
    divergedSeen: new Map(),
    inited: new Set(),
    peering: null,
    pendingPass: null,
    mirrors: new SeedMirrors(root),
    seedsStayHome: stage !== null,
    activity: null,
    kept: [],
    keeping: null,
    preview: null,
    registry: new RegistryHub(chanCfg, {
      broadcast: (ev) => broadcast(state, ev),
      repos: () => state.result.repos,
      scanEvery: opts.registry?.scanEvery ?? (scanOff ? 0 : SCAN_EVERY),
      ...(opts.registry?.relistEvery !== undefined ? { relistEvery: opts.registry.relistEvery } : {}),
      ...(opts.registry?.lister ? { lister: opts.registry.lister } : {}),
      ...(opts.registry?.container !== undefined ? { container: opts.registry.container } : {}),
    }),
    asks: new AskHub(chanCfg, {
      broadcast: (ev) => broadcast(state, ev),
      deviceName: (client) => deviceNameOf(state, client),
      ...opts.asks,
    }),
    incubator: new IncubatorHub(
      new Incubator({
        root,
        store: sprouts,
        seeds: seedOps(runnerOpts.backend, (path) => syncMirror(state, path)),
        flows: {
          // the same checks a flow started from a repo's menu passes
          start: async (repo, wf, note) => {
            const c = await loadConfig();
            const refused = stepProfileRefusal(c, wf);
            if (refused) throw new Error(refused);
            await needStepHarnesses(state, c, wf, [repo.path]);
            return state.flows.start(repo, wf, note, (profile) => stageAgent(stepAgentFor(c, repo.path, profile)));
          },
          get: (id) => state.flows.get(id),
          resume: (id, choice) => state.flows.resume(id, choice),
          stop: (id) => state.flows.stop(id),
        },
        // the bundled and the user's own only: a seed's .canopy/workflows never replaces a stage
        workflow: incubatorWorkflow,
        rescan: async () => {
          const rt = state.sources.find((s) => s.src.id === LAUNCH_SOURCE);
          if (!rt) return;
          // a scan already under way may have walked past the new seed
          if (rt.scanning) await rt.scanning;
          await scanOne(state, rt, scanOpts(state, await loadConfig()));
          broadcast(state, { type: "scan", result: state.result });
        },
        repo: (id) => state.result.repos.find((r) => r.id === id),
        transcribe: opts.incubator?.transcribe !== undefined ? opts.incubator.transcribe : transcriber(speech),
        notes: opts.incubator?.notes !== undefined ? opts.incubator.notes : vaultNotes(vault),
        ship: opts.incubator?.ship !== undefined ? opts.incubator.ship : shipper(ship),
        // a renovate or extend seed is rebuilt in this process; the mirror syncs after, as for a commit
        source:
          opts.incubator?.source !== undefined
            ? opts.incubator.source
            : seedSource({
                repos: () => state.result.repos,
                self: runnerOpts.backend,
                committed: (path) => syncMirror(state, path),
                owners: async () => (await loadConfig()).extendOwners,
              }),
        advice: adviceFiles,
        onChange: (sprout) => {
          broadcast(state, { type: "incubator", sprout });
          state.chan.onSprout(sprout);
        },
        onGone: (id) => {
          broadcast(state, { type: "incubator-gone", id });
          state.chan.forget(id);
        },
        // CANOPY_INCUBATOR_AUTOSTART=0 holds every sprout queued: a scratch
        // server for a UI check, or a pause while something is wrong
        autostart: opts.incubator?.autostart ?? process.env["CANOPY_INCUBATOR_AUTOSTART"] !== "0",
        isolation,
        // a stage starts only once the runner answers behind its fence
        shell: stage !== null,
        onWaiting: () => tellStages(),
      }),
      () => sprouts.list(),
      () => stagesNow(),
      { files: adviceFiles, accept: (entry) => (opts.incubator?.accept ?? ((e) => acceptAdvice(state, e)))(entry) },
    ),
    backendName: selfName(cfg.self, hostname()),
    apiUrl: null,
  };
  /** where stages run now, for the route and the `stages` event */
  const stagesNow = (): IncubatorStages => ({
    isolated: stage !== null && stage.harnessesNow() !== null && unfencedWhy() === null,
    mode: stage ? "runner" : unisolated ? "unisolated" : "off",
    waiting: state.incubator.inc.waiting(),
    unfenced: unfencedWhy(),
  });
  let toldStages = JSON.stringify(stagesNow());
  /** the `stages` event, only when what it says changed */
  const tellStages = (): void => {
    const now = stagesNow();
    const said = JSON.stringify(now);
    if (said === toldStages) return;
    toldStages = said;
    broadcast(state, { type: "stages", stages: now });
  };
  // A seed is busy while its stages are alive: a check in it, a run on it,
  // or a stage process there (until the stage runner says its seed is
  // quiet). On an isolated backend that is the seed's own stages alone,
  // since canopy's git there runs in the stages container as the stage
  // user (setSeedGit below). Unisolated, git runs here as canopy: canopy
  // reads a seed's config, then git reads it again, and a stage process can
  // write any seed in between, so any stage alive holds every seed.
  setSeedBusy((path) =>
    seedBusyFor(path, seedRootsNow(), {
      isolated: stage !== null,
      checks: seedChecks,
      aliveIn: (seed) => state.runner.stageAliveIn(seed),
      aliveAny: () => state.runner.liveAny(),
    }),
  );
  await rememberRoot(root);
  // The login shell's first answer lands whenever it lands; a list that
  // differs from what the tree offered goes out to the browsers with it.
  void login?.refresh().then(() => {
    const was = state.result.backend.harnesses ?? [];
    const now = state.harnesses();
    if (state.result.scannedAt === 0 || (now.length === was.length && now.every((h, i) => h === was[i]))) return;
    rebuildResult(state, state.result.repos);
    broadcast(state, { type: "scan", result: state.result });
  });
  await Promise.all(state.sources.map((rt) => scanOne(state, rt, scanOpts(state, cfg))));
  // The launch root failing to scan is fatal, as it always was: there is
  // nothing to show. An extra source failing is a note on that source.
  const launch = state.sources[0];
  if (launch?.src.error) throw new Error(launch.src.error);
  // The shells the last server left on tmux, before listening, so a
  // browser rejoining finds them held. Said out loud, since a missing
  // tmux falls back to plain ptys and looks the same until a restart.
  await listTerms(state);
  // and the ones a machine going down left behind, which are offered to
  // restore rather than held
  const kept = await refreshKept(state);
  await state.tasks.start();
  console.error(
    state.tmux
      ? `shells on tmux (${state.tmux[0]}), ${state.terms.size} held from before${kept.length ? `, ${kept.length} to restore` : ""}`
      : "shells on plain ptys (no tmux found; they end with the server)",
  );

  const webDir = join(import.meta.dir, "../../dist/web");
  // Loopback by default: every mutating git route here is unauthenticated,
  // so on a Mac the server is reachable only from the same machine. A shared
  // backend in a container sets CANOPY_BIND=0.0.0.0 to listen on the
  // container's interfaces; its published port is bound to the tailnet
  // address alone, so the tailnet is the trust edge (see docs/deploy.md).
  const bindHost = process.env["CANOPY_BIND"] || "127.0.0.1";
  // No auth does not mean any web page may drive the API: a page on another
  // origin could otherwise post a run or open a shell over a websocket
  // (neither needs a CORS preflight), and a domain rebound to this address
  // could read everything. The same gate as the Library's: a local or
  // tailnet host by its own name, or the configured public origin.
  const publicOrigin = process.env["CANOPY_PUBLIC_ORIGIN"];
  // Other canopy pages (another machine's, or this one's own behind
  // tailscale serve) that may drive this backend; see the multi-backend spec.
  // Parsed before the Library is constructed so it gets the same list.
  const origins = parseOrigins(process.env["CANOPY_ORIGINS"]);
  {
    const raw = process.env["CANOPY_ORIGINS"];
    if (raw) {
      const dropped = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !origins.includes(part));
      for (const bad of dropped) {
        console.warn(`canopy: CANOPY_ORIGINS ignores "${bad}" (not an exact http(s) origin)`);
      }
    }
  }
  const beyondLoopback = openBind();
  const library = new Library(root, publicOrigin, beyondLoopback, origins);
  // The in-app browser's ports, each listener started on first use. A
  // preview dials the backend's loopback, which in the container is the
  // shells container's too (compose puts canopy in its network namespace),
  // so a dev server started in a canopy shell is reachable.
  const slots = parsePortRange(process.env["CANOPY_PREVIEW_PORTS"]);
  const previewPublic = parsePreviewPublic(process.env["CANOPY_PREVIEW_PUBLIC"]);
  let boundPort = port;
  state.preview = slots.length
    ? new PreviewProxy(slots, {
        bind: bindHost,
        own: () => boundPort,
        hostOk: (h) => previewHostOk(h, beyondLoopback, tailnetHost),
        publicTemplate: previewPublic,
        host: parsePreviewHost(process.env["CANOPY_PREVIEW_HOST"]),
        hostFor: async (p) => (await listeningPorts()).find((l) => l.port === p)?.host,
      })
    : null;
  const route = async (req: Request, srv: Bun.Server<Socket>, url: URL): Promise<Response | undefined> => {
    if (url.pathname === "/api/library" || url.pathname === "/library" || url.pathname.startsWith("/library/")) return library.handle(req);
    if (url.pathname.startsWith("/api/") && !libraryOriginAllowed(req, publicOrigin, beyondLoopback, origins)) {
      return json({ error: "Foreign origin" }, 403);
    }
    const key = clientKey(srv.requestIP(req)?.address ?? "127.0.0.1");
    if (url.pathname === "/api/events") return sse(state, parseStream(url.searchParams, key));
    if (url.pathname === "/api/helper") {
      // a helper dialling in from a client machine: its registration
      // rides in the query, one helper per name (a newer one wins)
      const info = parseHelperQuery(url.searchParams, key);
      if ("error" in info) return json({ error: info.error }, 400);
      const data: HelperSocket = { kind: "helper", info };
      if (srv.upgrade(req, { data })) return undefined;
      return json({ error: "a websocket is expected here" }, 426);
    }
    if (url.pathname === "/api/term") {
      // A shell in the browser: the socket carries the repo it lands in.
      // The same rules as the openers: a forge repo has no folder to be in.
      let repo: Repo;
      try {
        repo = repoById(state, url.searchParams.get("id") ?? "");
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        return json({ error: String(err instanceof Error ? err.message : err) }, status);
      }
      if (repo.forge) return json({ error: `${repo.name} is on the forge; there is no folder to open a shell in` }, 400);
      const id = url.searchParams.get("term");
      if (!isTermId(id)) return json({ error: "a shell is named by 32 hex digits in term=" }, 400);
      const place = termPlace(url.searchParams.get("place"));
      const attach = url.searchParams.get("attach") === "1";
      // start=agent types the shell route's agent in, a launch pick
      // (profile= or harness=) beating the route; start=claude is the same
      // from a page older than harnesses
      const wants = !attach && ["agent", "claude"].includes(url.searchParams.get("start") ?? "");
      const start = wants
        ? agentFor(await loadConfig(), repo.path, "shell", launchPick(url.searchParams.get("profile"), url.searchParams.get("harness")))
        : null;
      // a seed's agents start through the incubator alone, with its limits
      const refused = start && isSeedPath(state.root, repo.path) ? SEED_AGENT_REFUSAL : start ? await harnessRefusal(state, start.harness, repo.path) : null;
      const prompt = start ? (url.searchParams.get("prompt") ?? "").slice(0, PROMPT_MAX) : "";
      const size = termSize(url.searchParams.get("cols"), url.searchParams.get("rows"));
      const dev = url.searchParams.get("client") ?? "";
      const device = /^[0-9a-f]{16}$/.test(dev) ? dev : null;
      const data: Socket = { kind: "term", repo, id, place, attach, start, refused, prompt, device, ...size };
      if (srv.upgrade(req, { data })) return undefined;
      return json({ error: "a websocket is expected here" }, 426);
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(state, req, url, clientKey(srv.requestIP(req)?.address ?? "127.0.0.1"));
      } catch (err) {
        const status =
          err instanceof HttpError || err instanceof HistoryError || err instanceof LauncherError
            ? err.status
            : // a stage while the stage runner is away waits; matched by name across modules
              err instanceof Error && err.name === "StageAwayError"
              ? 503
              : 500;
        return json(
          { error: String(err instanceof Error ? err.message : err) },
          status,
        );
      }
    }
    const filePath =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(join(webDir, filePath));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(join(webDir, "index.html")));
  };
  const server = bind(port, () =>
    Bun.serve<Socket>({
      port,
      hostname: bindHost,
      idleTimeout: 0,
      // just over the largest body a route takes: an intake, a file posted
      // to tailchan, a pasted image
      maxRequestBodySize: Math.max(INTAKE_BODY_MAX, PUT_MAX, PASTE_MAX) + 1024 * 1024,
      fetch: async (req, srv) => {
        const url = new URL(req.url);
        const api = url.pathname.startsWith("/api/");
        const cors = api ? corsHeaders(req.headers.get("origin"), origins) : null;
        // A preflight runs nothing: answer it before any route, and only for
        // a listed origin.
        if (api && req.method === "OPTIONS") {
          return cors
            ? new Response(null, { status: 204, headers: { ...cors, ...PREFLIGHT_HEADERS } })
            : json({ error: "Foreign origin" }, 403);
        }
        // A preflight-shaped OPTIONS outside /api is not a real preflight (no
        // route here answers one), and the static file serving below has no
        // method check of its own. Refuse it here, before route runs, rather
        // than letting it fall through to a 200 with the SPA or an asset.
        if (!api && req.method === "OPTIONS") return new Response(null, { status: 405 });
        const res = await route(req, srv, url);
        if (!res || !cors) return res;
        // a proxied or streamed answer may hold immutable headers; rewrap it
        const out = new Response(res.body, res);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      },
      websocket: {
        // Keystrokes go down as binary frames and the pty's output comes
        // back the same way; the one text frame each way is JSON: a resize
        // from the browser, the shell's exit from here. A socket for a shell
        // the server already holds joins it: what the shell wrote while no
        // one was looking goes first, then the pty takes the socket's size so
        // a full-screen program repaints. One that asked only to rejoin and
        // names a shell not here is told so and closed.
        open(ws) {
          if (ws.data.kind === "helper") {
            const { info } = ws.data;
            const old = state.helpers.get(info.name);
            if (old) {
              state.helpers.delete(info.name);
              old.ws.close(1000, "another helper registered under this name");
              for (const p of old.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new HttpError(502, `the helper ${old.info.name} was replaced`));
              }
            }
            state.helpers.set(info.name, { info, ws, pending: new Map(), next: 1, seen: Date.now() });
            tellHelpers(state);
            return;
          }
          const term = ws as ServerWebSocket<TermSocket>;
          const { id, attach, cols, rows } = term.data;
          const held = state.terms.get(id);
          // A name a lost shell was kept under is not a new shell's to take:
          // a window reloaded after a reboot still names it, and starting a
          // shell there would hide the record from the restore offer and
          // write over it at the next pass. It comes back through a restore.
          // A task's session belongs to the task hub: only an attach-only socket
          // (a task tab) may reach it, and never one that would start a shell.
          if (!attach && state.tasks.knows(id)) {
            term.close(TERM_GONE, "that is a task, not a shell");
            return;
          }
          if (!held && (attach || state.kept.some((k) => k.id === id))) {
            term.close(TERM_GONE, "that shell is gone");
            return;
          }
          // a start on a harness this backend lacks ends here, before any
          // shell starts, with the reason as the tab's last line; a join
          // onto a held shell starts nothing and goes ahead
          if (!held && term.data.refused) {
            term.close(1011, term.data.refused.slice(0, 120));
            return;
          }
          // Starting takes a moment; what the browser sends before then
          // waits in `pending` and goes down once the shell is up.
          term.data.pending = [];
          const settle = (ok: () => void) => {
            const queued = term.data.pending ?? [];
            term.data.pending = undefined;
            if (term.readyState !== WebSocket.OPEN) return;
            ok();
            const session = sessionOf(term);
            if (session) for (const msg of queued) relay(session, msg);
          };
          const failed = (err: unknown) => {
            term.close(1011, String(err instanceof Error ? err.message : err).slice(0, 120));
          };
          const tmux = state.tmux;
          if (tmux) {
            joinTmuxTerm(state, tmux, term).then(() => settle(() => {}), failed);
            return;
          }
          if (held?.pty) {
            const { session, scrollback } = held.pty;
            settle(() => {
              term.data.live = held;
              held.sockets.add(term);
              const missed = scrollback.bytes();
              if (missed.length > 0) term.sendBinary(missed);
              session.resize({ cols, rows });
              tellTerms(state);
            });
            return;
          }
          try {
            const live = openPtyTerm(state, term.data, { cols, rows });
            const start = term.data.start;
            if (start) void typeAgent(state, live, term.data.repo, start, term.data.prompt).catch(() => {});
            settle(() => {
              term.data.live = live;
              live.sockets.add(term);
              tellTerms(state);
            });
          } catch (err) {
            failed(err);
          }
        },
        message(ws, msg) {
          if (ws.data.kind === "helper") {
            helperSeen(state, ws.data.info.name, ws);
            if (typeof msg === "string") helperReplied(state, ws.data.info.name, msg);
            return;
          }
          const term = ws as ServerWebSocket<TermSocket>;
          // a person at the keyboard, not the terminal answering a query:
          // the shell is watched (the page's own beat says the human is here)
          if (typeof msg !== "string" && isKeystroke(msg)) {
            const live = state.terms.get(term.data.id);
            if (live && !live.info.task) live.lastInput = Date.now();
          }
          const session = sessionOf(term);
          if (session) relay(session, msg);
          else term.data.pending?.push(msg);
        },
        // The websocket layer answers a ping on its own; both handlers are
        // here for what the frame proves, that the machine at the other end
        // of a helper's socket is still up.
        ping(ws) {
          if (ws.data.kind === "helper") helperSeen(state, ws.data.info.name, ws);
        },
        pong(ws) {
          if (ws.data.kind === "helper") helperSeen(state, ws.data.info.name, ws);
        },
        // The browser going away leaves the shell running: a reload, a
        // closed tab or a lost connection comes back to it by name. Ending a
        // shell is DELETE /api/terms. On tmux the socket's own client goes.
        close(ws) {
          if (ws.data.kind === "helper") {
            dropHelper(state, ws.data.info.name, ws);
            return;
          }
          const term = ws as ServerWebSocket<TermSocket>;
          term.data.client?.detach();
          term.data.client = undefined;
          if (term.data.live?.sockets.delete(term)) tellTerms(state);
        },
      },
    }),
  );
  boundPort = server.port ?? port;
  state.apiUrl = apiUrlFor(bindHost, boundPort);
  // Only after the bind succeeds: a watcher started earlier would outlive a
  // failed listen and hold the process open.
  for (const rt of state.sources) startWatcher(state, rt);
  // The flows the last server left, only now that the port is ours (a second
  // canopy that fails to bind must not rerun them), and only by the one
  // server holding the flows folder: two on one config dir would both rerun
  // every mid-step flow. Records written for another root stay for it.
  const flowsLock = await lockFlows().catch((err): FlowsLock => {
    console.error(`flows: could not lock ${flowsDir()}: ${String(err instanceof Error ? err.message : err)}`);
    return { owner: false, holder: 0 };
  });
  // One bounded hello before the flows come back and the sprouts are
  // pumped, so a flow restored mid-step finds a runner compose started
  // beside canopy. If it does not answer, that flow parks and the sprouts
  // wait; the watch below starts them once it does.
  if (stage) await stage.hello(10_000);
  if (flowsLock.owner) {
    flowFiles = new FlowFiles(root);
    state.flows.restore(
      await loadFlowRecords(root),
      (path) => state.result.repos.find((r) => r.path === path),
      // a seed's flow is an incubator stage, held to the same rule as a fresh one
      (repo) => (profile) => (isSeedPath(root, repo.path) ? stageAgent(stepAgentFor(cfg, repo.path, profile)) : stepAgentFor(cfg, repo.path, profile)),
    );
    // the sprouts the last server left, once their flows are back; a server
    // without the lock lists them and takes nothing in (server/incubator.ts)
    await state.incubator.restore();
  } else {
    state.incubator.notKeeping(flowsLock.holder);
    if (flowsLock.holder) {
      console.error(`flows: canopy pid ${flowsLock.holder} keeps the records in ${flowsDir()}; flows started here are not kept across a restart`);
    }
  }
  /** whether the last good hello said fenced: a flip pumps the queue */
  let wasFenced = unfencedWhy() === null;
  const stopStageWatch = stage
    ? stage.watch(
        opts.incubator?.stageEvery ?? 15_000,
        () => {
          state.incubator.inc.pump();
          tellStages();
        },
        () => {
          state.incubator.inc.pump();
          tellStages();
        },
        // every good hello, not only the one after a miss: a flow can park
        // while the client still believed the runner up, and the fence can
        // come or go while the runner answers throughout. Parks resume only
        // on a hello that says fenced; the resumed flows take their slots
        // back before the queue is pumped.
        () => {
          const fenced = unfencedWhy() === null;
          const resumed = fenced ? state.flows.resumeStageParks() : 0;
          if (resumed > 0 || fenced !== wasFenced) state.incubator.inc.pump();
          wasFenced = fenced;
          tellStages();
        },
      )
    : null;
  tellStages();
  // a park waits a day for its retro with nothing else happening to pump the queue
  const retroTimer = setInterval(() => state.incubator.inc.tick(), opts.incubator?.tickEvery ?? 10 * 60_000);
  const remoteTimer = setInterval(() => {
    void refreshRemote(state)
      .catch((err) => console.error("canopy: remote refresh", err))
      .then(() => refreshActivity(state));
  }, REMOTE_REFRESH);
  // The first activity pass soon after the tree is up, not five minutes in:
  // the cards should not claim "in sync" on the strength of last week's fetch.
  const firstActivity = setTimeout(() => void refreshActivity(state), ACTIVITY_DELAY);

  const helperTimer = setInterval(() => sweepHelpers(state), HELPER_PING);

  // What the shells have on their screens, written out while `keepShells`
  // is on, so a machine going down does not take them with the tmux server.
  void state.chan.start().catch((err) => console.error("canopy: tailchan", err));
  state.registry.start();
  state.asks.start();
  const keepTimer = setInterval(() => void keepPass(state), KEEP_EVERY);

  // A named event rather than an SSE comment, so the page sees it: a phone
  // behind Cloudflare can hold a stream the browser thinks is open while
  // nothing arrives, and only a missing ping tells the page to open another.
  const heartbeat = setInterval(() => {
    for (const c of state.clients) {
      try {
        c.enqueue(enc.encode(`event: ping\ndata: \n\n`));
      } catch {
        state.clients.delete(c);
        if (state.streams.delete(c)) tellDevices(state);
      }
    }
  }, 25_000);

  const stopLibrary = () => library.stop();
  process.on("exit", stopLibrary);
  return {
    port: server.port ?? port,
    stop: () => {
      state.tasks.stop();
      clearInterval(heartbeat);
      clearInterval(helperTimer);
      clearInterval(keepTimer);
      clearInterval(remoteTimer);
      clearInterval(retroTimer);
      clearTimeout(firstActivity);
      for (const t of state.timers.values()) clearTimeout(t);
      stopStageWatch?.();
      // the hook stays, answering SEED_AWAY for this root's seeds
      stopped = true;
      // before the flows stop, so their ends park no sprout
      state.incubator.detach();
      state.flows.detach();
      flowFiles = null;
      if (flowsLock.owner) flowsLock.release();
      state.flows.stopAll();
      state.runner.stopAll();
      for (const h of checkHolds) h.cancel();
      state.launcher.shutdown();
      state.chan.close();
      state.registry.close();
      state.asks.close();
      // the ptys go with the server; a shell on tmux stays for the next one
      for (const t of state.terms.values()) {
        t.pty?.session.detach();
        for (const ws of t.sockets) ws.data.client?.detach();
      }
      state.terms.clear();
      for (const [name, h] of state.helpers) {
        h.ws.close(1001, "the backend is stopping");
        dropHelper(state, name, h.ws);
      }
      library.stop();
      state.preview?.stop();
      process.off("exit", stopLibrary);
      for (const rt of state.sources) rt.watcher?.close();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const { port } = await startServer({ root });
  console.log(`canopy server on http://${process.env["CANOPY_BIND"] || "127.0.0.1"}:${port} (root: ${root})`);
}
