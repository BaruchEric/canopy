import { ACTIONS } from "../core/actions";
import { PREFLIGHT_HEADERS, corsHeaders, parseOrigins } from "../core/cors";
import { Library, libraryOriginAllowed, openBind, tailnetHost } from "../core/library";
import { PreviewProxy, parsePortRange, previewHostOk, previewable } from "../core/preview";
import { parsePreviewHost, parsePreviewPublic } from "../core/previewPublic";
import { listeningPorts, repoOfCwd } from "../core/ports";
import { watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { arch, homedir, hostname } from "node:os";
import { readBuild, readPkg } from "../core/build";
import { join, resolve } from "node:path";
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
import { exec, onHost } from "../core/exec";
import { Flows, type CheckResult } from "../core/flow";
import { isTermId, parseTermMessage, Scrollback, shellArgs, startTerm, termPlace, termSize, type TermSession, type TermSize } from "../core/term";
import { attachTmuxTerm, hasSession, history, killSession, listSessions, newSession, paneInfo, paneText, sendLine, serverUp, snapshot, tmuxBase } from "../core/tmux";
import { clip, continueLine, countLines, expiredShells, forgetKept, KEEP_EVERY, listKept, lostShells, readKeptHistory, replayCommand, replayFile, restoredBanner, writeKept } from "../core/keep";
import { PASTE_MAX, pasteName, pasteText, savePaste } from "../core/paste";
import { apiBase, ForgeAuthError, linkForgeClones, listForgeRepos } from "../core/forge";
import { isSshHost, parseLocator, parseSshHosts, shellQuote, tildeQuote } from "../core/host";
import { hasGatewayKey, jev } from "../core/jev";
import { isDefaultAgent, normalizeAgent } from "../core/agent";
import type { AgentEnv } from "../core/harness";
import { paneAgent } from "../core/procs";
import { effectiveAgents, isProfileName, launchPick, normalizePick, normalizeRepoAgent, pickRefusal, repoAgentRefusal } from "../core/route";
import { selfName } from "../core/backends";
import { linkPeers, NO_PUSH, peerUrl } from "../core/peers";
import { initRepo, PassSeen, seedRepo, syncAll, syncRepo, takeWip, trackBranch } from "../core/peersync";
import { normalizeLaunch } from "../core/launch";
import { Launcher, LauncherError } from "../core/launcher";
import { agentLine, availableHarnesses, backendCaps, hostOpeners, isOpenerId, missingHarness, openFile, openGroup, openIn } from "../core/openers";
import { clientKey, HELPER_PING, HELPER_TIMEOUT, isLoopback, isLoopbackHost, parseDefaultGateway, parseHelperQuery, parseHelperReply, reachFrom, staleHelpers, type HelperIntent } from "../core/helper";
import { devicesOf, parseStream, type Stream } from "../core/presence";
import { mapPool, searchRepo } from "../core/search";
import { agentSessions, hasAgentSession, isSessionId, resumeLine } from "../core/sessions";
import { findWorkflow, loadWorkflows } from "../core/workflows";
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
  setRole,
  upsertWorkspace,
} from "../core/store";
import { Runner } from "../core/runner";
import { suggestMessage } from "../core/suggest";
import {
  HISTORY_WINDOWS,
  LAUNCH_SOURCE,
  RUN_ACTIONS,
  isAgentRole,
  isHarness,
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
  type RunAnswer,
  type ScanResult,
  type ServerEvent,
  type ShellPlace,
  type Source,
  type SourceInput,
  type SourceState,
  type TermInfo,
  TERM_GONE,
} from "../core/types";
import type { About } from "../core/types";
import { DEFAULT_IGNORE } from "../core/scan";
import { ChanHub } from "./tailchan";
import { RegistryHub } from "./registry";
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
  /** the agent harnesses this backend has, looked up on each call so one
   *  installed while canopy runs is seen at the next scan */
  harnesses: () => Harness[];
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
}

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
function askHelper(state: ServerState, name: string, intent: Omit<HelperIntent, "id">): Promise<void> {
  const helper = state.helpers.get(name);
  if (!helper) return Promise.reject(new HttpError(400, NO_HELPER));
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

/** A start on a harness this backend lacks is refused before any shell
 *  starts, in words the UI shows as they are: "codex is not installed on
 *  mini", not a shell that dies at once. */
async function needHarness(state: ServerState, h: Harness): Promise<void> {
  if (!state.harnesses().includes(h)) throw new HttpError(400, missingHarness(h, await machineName()));
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
    await needHarness(state, rec.agent);
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
  await needHarness(state, harness);
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

/** The browser's reply to a run prompt, checked field by field: a malformed
 *  body must not reach the SDK as an "allow". */
function parseAnswer(v: unknown): RunAnswer | null {
  if (!v || typeof v !== "object") return null;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === "allow" || kind === "allow-all" || kind === "deny") return { kind };
  if (kind !== "answers") return null;
  const raw = (v as { answers?: unknown }).answers;
  if (!raw || typeof raw !== "object") return null;
  const answers: Record<string, string> = {};
  for (const [q, a] of Object.entries(raw)) {
    if (typeof a !== "string") return null;
    answers[q] = a;
  }
  return { kind: "answers", answers };
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

/** stdout and stderr of a check, tail-capped for the sheet */
const CHECK_OUTPUT_CAP = 4000;
const CHECK_TIMEOUT = 10 * 60_000;

/** A step's check, in the repo, through a login shell so the user's PATH
 *  (bun, cargo) applies; over ssh for a remote repo. */
async function runCheck(repo: Repo, command: string): Promise<CheckResult> {
  const { host, path } = parseLocator(repo.path);
  const r =
    host === null
      ? await exec(["sh", "-lc", command], { cwd: path, timeoutMs: CHECK_TIMEOUT })
      : await onHost(host, ["sh", "-lc", `cd ${shellQuote(path)} && ${command}`], { timeoutMs: CHECK_TIMEOUT });
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return { exit: r.code, output: out.length > CHECK_OUTPUT_CAP ? `…${out.slice(-CHECK_OUTPUT_CAP)}` : out };
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
  const repo = state.result.repos.find((r) => r.id === id);
  if (!repo) throw new HttpError(404, `unknown repo: ${id}`);
  const fresh = await refreshRepo(repo, state.own.get(repo.path) ?? []);
  // Re-find after the await: a concurrent rescan may have replaced the array,
  // and writing back a pre-await index would land in the wrong slot.
  const idx = state.result.repos.findIndex((r) => r.id === id);
  if (idx !== -1) state.result.repos[idx] = fresh;
  broadcast(state, { type: "repo", repo: fresh });
  return fresh;
}

const WATCH_GIT_HINTS = ["HEAD", "index", "ORIG_HEAD", "refs"];

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
      const fresh = await scanSource(rt.src, opts);
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
function scheduleRefresh(state: ServerState, id: string): void {
  clearTimeout(state.timers.get(id));
  state.timers.set(
    id,
    setTimeout(() => {
      state.timers.delete(id);
      refreshAndBroadcast(state, id).catch(() => {});
    }, 400),
  );
}

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
  const url = await exec(["git", "-C", repoPath, "remote", "get-url", peer.name]);
  if (url.code === 0 && url.stdout.trim() === peerUrl(peer, repoId)) return true;
  const pushurl = await exec(["git", "-C", repoPath, "config", "--get", `remote.${peer.name}.pushurl`]);
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
    (r) => local.has(r.source) && !r.forge && !r.error && (r.remotes?.length ?? 0) > 0,
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
 *  ongoing scan error. */
const peerable = (r: Repo): boolean => r.source === LAUNCH_SOURCE && !r.host && !r.forge && !r.error;

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
  const repos = state.result.repos.filter((r) => peerable(r) && !state.runner.activeFor(r.id));
  for (const r of repos) {
    if (state.inited.has(r.path)) continue;
    await initRepo(r.path, r.id, s.peers, dry);
    // Only a non-dry setup counts as inited: a dry pass wrote no remotes, so
    // flipping to "on" without a restart must still set them up.
    if (!dry) state.inited.add(r.path);
  }
  const { states, seen, cloned, failed } = await syncAll(
    repos.map((r) => r.id),
    { self: s.self, peers: s.peers, seed: s.seed, dry, root: state.root },
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
    if (!live || live.ending) return json({ error: "no such shell" }, 404);
    // a plain pty has no one to ask: what canopy started there may have
    // exited back to the shell, so it never counts as an agent
    if (!state.tmux) return json({ agent: null });
    const pane = await paneInfo(state.tmux, term);
    return json({ agent: pane ? await paneAgent(pane) : null });
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
    const b = (await req.json()) as { id?: unknown; promptId?: unknown; answer?: unknown };
    const answer = parseAnswer(b.answer);
    if (typeof b.id !== "string" || typeof b.promptId !== "string" || !answer) {
      return json({ error: "malformed answer" }, 400);
    }
    return json(state.runner.answer(b.id, b.promptId, answer));
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
    const note = typeof b.note === "string" ? b.note : "";
    if (wf.noteRequired && !note.trim()) return json({ error: "this workflow needs a note" }, 400);
    const cfg = await loadConfig();
    return json(state.flows.startFleet(repos, wf, note, (r) => agentFor(cfg, r.path, "flow")), 201);
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
  if (path === "/api/workspaces/open" && method === "POST") {
    const b = (await req.json()) as { name: string; app: string; helper?: unknown };
    if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
    const via = openVia(state, here, b.helper);
    const cfg = await loadConfig();
    const ws = cfg.workspaces.find((w) => w.name === b.name);
    if (!ws) return json({ error: "unknown workspace" }, 404);
    if (via.via === "backend") {
      await openGroup(b.app, b.name, ws.repos, (p) => agentFor(cfg, p));
    } else {
      const agents: Record<string, AgentSettings> = {};
      const repos = ws.repos.map((p) => {
        const there = helperPath(p);
        agents[there] = agentFor(cfg, p);
        return there;
      });
      await askHelper(state, via.name, { group: { app: b.app, name: b.name, repos, agents } });
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
      return json(await suggestMessage(repo.path, files));
    }
    if (method === "POST" && action === "open") {
      const b = (await req.json()) as { app: string; tab?: unknown; helper?: unknown };
      if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
      const via = openVia(state, here, b.helper);
      const agent = agentFor(await loadConfig(), repo.path);
      const tab = b.tab === true;
      // the backend's own desktop runs the agent here, so its harness has to
      // be here; a helper's machine answers for itself
      if (via.via === "backend" && (b.app === "agent" || b.app === "herdr")) await needHarness(state, agent.harness);
      if (via.via === "backend") await openIn(b.app, repo.path, agent, { tab });
      else await askHelper(state, via.name, { open: { app: b.app, path: helperPath(repo.path), agent, tab } });
      return json({ ok: true });
    }
    if (method === "POST" && action === "agent") {
      // Validated field by field: a stray value must not reach a command
      // line. A body of plain settings is a page from before roles: the
      // repo's whole-repo pick, and at the builtin defaults its reset, the
      // way that page meant them.
      const raw: unknown = await req.json().catch(() => null);
      const legacy = typeof raw === "object" && raw !== null && !Array.isArray(raw) && !("all" in raw) && !("roles" in raw);
      let next = normalizeRepoAgent(raw);
      if (legacy && next.all && !("profile" in next.all) && isDefaultAgent(next.all)) next = {};
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
      return json(await loadWorkflows(repo));
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
      if (repo.host) return json({ error: `Claude runs only work on this machine; ${repo.name} is on ${repo.host}` }, 400);
      const b = (await req.json()) as { workflow?: unknown; note?: unknown };
      if (typeof b.workflow !== "string") return json({ error: "missing workflow" }, 400);
      const entries = await loadWorkflows(repo);
      const wf = findWorkflow(entries, b.workflow);
      if (!wf) {
        const broken = entries.find((e) => !e.ok && e.name === b.workflow);
        return json({ error: broken && !broken.ok ? broken.error : `unknown workflow: ${b.workflow}` }, 400);
      }
      const note = typeof b.note === "string" ? b.note : "";
      const agent = agentFor(await loadConfig(), repo.path, "flow");
      try {
        return json(state.flows.start(repo, wf, note, agent), 201);
      } catch (err) {
        throw new HttpError(400, String(err instanceof Error ? err.message : err));
      }
    }
    if (method === "POST" && action === "run") {
      // The runner spawns claude here, at the repo's path; there is no
      // claude to spawn at a folder on another host.
      if (repo.host) return json({ error: `Claude runs only work on this machine; ${repo.name} is on ${repo.host}` }, 400);
      // A workflow owns the repo while it runs, gate included: a second
      // claude here would make the flow's next step throw and die.
      if (state.flows.activeFor(repo.id)) throw new HttpError(409, "a workflow is running here");
      const b = (await req.json()) as { action?: unknown; note?: unknown; client?: unknown };
      if (!isRunAction(b.action)) return json({ error: "unknown action" }, 400);
      const note = typeof b.note === "string" ? b.note : "";
      const agent = agentFor(await loadConfig(), repo.path, b.action === "chat" ? "chat" : "job");
      // the device it was started from, when the browser said and is on the stream
      const by = deviceNameOf(state, typeof b.client === "string" ? b.client : null) ?? undefined;
      return json(state.runner.start(repo, b.action, ACTIONS[b.action], note, agent, by), 201);
    }
    if (method === "POST" && action === "peer") {
      if (!peerable(repo)) throw new HttpError(400, "peer sync covers local repos under the launch root");
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
      if (activeRun) throw new HttpError(409, `${repo.name} already has a ${activeRun.verb} run going`);
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
}): Promise<{ port: number; stop: () => void }> {
  const cfg = await loadConfig();
  const root = await realpath(opts.root);
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
  const scanOff = process.env["CANOPY_AGENT_SCAN"] === "0" || process.env["NODE_ENV"] === "test";
  const harnesses = fixed ? () => [...fixed] : availableHarnesses;
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
    status: (repoId) =>
      refreshAndBroadcast(state, repoId)
        .then((r) => r.status)
        .catch(() => null),
  });
  const flows = new Flows(runner, {
    onChange: (flow) => {
      broadcast(state, { type: "flow", flow });
      state.chan.onFlow(flow);
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
    check: runCheck,
    evaluator: hasGatewayKey() ? jev : null,
    status: (repoId) =>
      refreshAndBroadcast(state, repoId)
        .then((r) => r.status)
        .catch(() => null),
  });
  const launcher = new Launcher({
    onJob: (job) => broadcast(state, { type: "job", job }),
    onJobGone: (id) => broadcast(state, { type: "job-gone", id }),
    onBuilds: (repoId, what, build) => broadcast(state, { type: "builds", repoId, what, build }),
  });
  const state: ServerState = {
    root,
    agentLine: opts.agentLine ?? (async (_repo, agent, env) => agentLine(agent, undefined, env)),
    harnesses,
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
    flows,
    launcher,
    chan: new ChanHub(chanCfg, {
      broadcast: (ev) => broadcast(state, ev),
      repoName: (id) => state.result.repos.find((r) => r.id === id)?.name ?? id,
      isFlowRun: (runId) => state.flows.list().some((f) => f.steps.some((st) => st.runId === runId)),
    }),
    tasks: new TaskHub({
      tmux: tmuxBase(),
      repos: () => state.result.repos,
      own: async (repo) => {
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
    backendName: selfName(cfg.self, hostname()),
    apiUrl: null,
  };
  await rememberRoot(root);
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
      const refused = start && !state.harnesses().includes(start.harness) ? missingHarness(start.harness, await machineName()) : null;
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
      clearTimeout(firstActivity);
      for (const t of state.timers.values()) clearTimeout(t);
      state.flows.stopAll();
      state.runner.stopAll();
      state.launcher.shutdown();
      state.chan.close();
      state.registry.close();
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
