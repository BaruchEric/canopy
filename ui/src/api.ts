import type { Dictation, LiveAnswer, VoiceContext, VoiceInfo, VoiceSession } from "../../src/core/voicewire";
import type { CostReport } from "../../src/core/costs";
import type { VoiceEngine } from "./voicelive";
import type {
  AwakeInfo,
  AwakeMode,
  HealthCheck,
  KitAction,
  KitApplyResult,
  KitInfo,
  LandEntry,
  LandingInfo,
  PrWatch,
  KitInstallResult,
  KitMcpPreview,
  HealthInfo,
  CapacityInfo,
  SecretAuditEntry,
  SecretProposalIn,
  SecretsInfo,
  RepoCheckDef,
  RepoHealthInfo,
  RangerInfo,
  SweepInfo,
  SweepOutcome,
  SweepSettings,
  RangerWake,
  TermScreen,
  AgentActivity,
  AgentKind,
  About,
  AgentPick,
  AgentScope,
  AgentRole,
  AgentSession,
  AgentSettings,
  AgentTable,
  Harness,
  MoveCheck,
  MoveOut,
  MovePlan,
  RepoAgent,
  BackendEntry,
  Ask,
  AskAnswer,
  AsksInfo,
  GuardsInfo,
  Presence,
  ChanMessage,
  RegistryInfo,
  TailchanInfo,
  Device,
  HelperInfo,
  ClientInfo,
  CommitDetail,
  Fleet,
  Flow,
  FlowChoice,
  GrepRepoResult,
  GrepResult,
  RepoFiles,
  DirEntry,
  Mention,
  HistoryHit,
  HistoryOverview,
  HistorySession,
  HistorySessionDetail,
  HistoryWindow,
  Job,
  LaunchSettings,
  Listing,
  KeptShell,
  PortsResult,
  PreviewSlot,
  ElsewhereDetail,
  LogEntry,
  Build,
  Peer,
  PeerSeen,
  PeerSync,
  Pull,
  PushAccess,
  Release,
  Repo,
  RememberedRule,
  Run,
  RunAction,
  RunAnswer,
  ScanResult,
  ShellPlace,
  ServerEvent,
  SourceInput,
  SourceState,
  SpecHalf,
  TaskAction,
  TaskInfo,
  TaskLogPage,
  TaskPatch,
  TasksResult,
  TermInfo,
  WorkflowEntry,
  Workspace,
  WsColor,
  IncubatorStages,
  Sprout,
  SproutDetail,
  AdviceAccepted,
  AdviceOffer,
  ScreenProfile,
} from "../../src/core/types";
import type { SecretAct } from "../../src/core/secretwire";
import type { Delivery, TriggerEvent, TriggersInfo } from "../../src/core/trigger";
import type { ProfileFields } from "../../src/core/screenlayouts";
import { pickUrl, split, wsUrl, type BackendSignal } from "./backends";
import { normalizeRoutes } from "../../src/core/route";
import { keyHeaders } from "./answerKey";
import { isAuthInfo, originOf, TOKEN_HEADER, tokenHeaders, type AuthInfo } from "./callerToken";
import {
  qDevice,
  qEvent,
  qFleet,
  qFlow,
  qGrep,
  qHistory,
  qJob,
  qCheck,
  qKept,
  qRepo,
  qLanding,
  qPrs,
  qTriggers,
  qRun,
  qScan,
  qSource,
  qSprout,
  qSproutDetail,
  qTask,
  qTerm,
  type Q,
} from "./qualify";
import { baseOf, homeName, plainOf, qual, registry } from "./registry";
import { clientId } from "./client";
import type { CoordEdit } from "./coord";

/* Every call goes to the backend its id names, with the id that backend
   knows, and whatever carries ids comes back under that backend's name. The
   home backend's ids are bare and its answers come back as they came, so a
   page with one backend sends and gets what it always did. */

let signal: (backend: string, sig: BackendSignal) => void = () => {};

/** Hears what every request and stream saw of its backend; one listener. */
export function onBackendSignal(fn: (backend: string, sig: BackendSignal) => void): void {
  signal = fn;
}

/** Whether a backend has a URL to reach yet: home always, another once the
 *  store has settled which of its URLs this page uses. Until then a call to
 *  it must not fall back to the page's own origin, which would hand home an
 *  id that is not its own. */
export const reachable = (b: string): boolean => b === homeName() || baseOf(b) !== "";

/** A fleet start that reached some backends and not others: `started` is
 *  every fleet that did start, kept so the caller can fold them in and drop
 *  their repos from a selection, rather than losing them because one more
 *  backend never answered. */
export class PartialFleetError extends Error {
  constructor(
    message: string,
    public readonly started: Fleet[],
  ) {
    super(message);
    this.name = "PartialFleetError";
  }
}

async function req<T>(b: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!reachable(b)) throw new Error(`${b} has not answered yet`);
  const base = baseOf(b);
  const opts: RequestInit = { ...init };
  // The backend's own token, when this page signed in to it. To another
  // origin it rides only where it is needed: a write, and /api/auth, which
  // says who this page is. A read is open to anyone, and a GET with no
  // custom header and no Content-Type is a simple request with no preflight,
  // whose failing at an edge gate would mark the whole backend offline.
  const method = (init.method ?? "GET").toUpperCase();
  const keyed = !base || (method !== "GET" && method !== "HEAD") || path.split("?")[0] === "/api/auth";
  const headers = keyed ? tokenHeaders(originOf(base), init.headers) : new Headers(init.headers);
  if (typeof init.body === "string" && init.headers === undefined) headers.set("Content-Type", "application/json");
  const sent = headers.get(TOKEN_HEADER);
  opts.headers = headers;
  // another origin: the gate's cookie has to ride along
  if (base) opts.credentials = "include";
  let r: Response;
  try {
    r = await fetch(base + path, opts);
  } catch {
    const reason = `${b || "canopy"} did not answer`;
    signal(b, { kind: "unreachable", reason });
    throw new Error(reason);
  }
  // Parse defensively: a dead API or a proxy error page is not JSON, and
  // letting that SyntaxError escape would hide the real status.
  const text = await r.text();
  let body: (T & { error?: string; login?: unknown; need?: unknown }) | undefined;
  try {
    body = JSON.parse(text) as T & { error?: string; login?: unknown; need?: unknown };
  } catch {
    signal(b, { kind: "answered" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    throw new Error("unreadable response from canopy server");
  }
  if (r.status === 401 && typeof body.login === "string") {
    signal(b, { kind: "signin", login: body.login });
    throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  }
  // canopy's own caller check: never the gate's sign-in, which carries a login
  if ((r.status === 401 || r.status === 403) && typeof body.need === "string") signal(b, { kind: "refused", status: r.status, need: body.need, token: sent });
  else signal(b, { kind: "answered" });
  // the status rides on the error for a caller that tells a refusal apart
  // (a backend with no broker answers 503) from a failure
  if (!r.ok) throw Object.assign(new Error(body.error ?? `${r.status} ${r.statusText}`), { status: r.status });
  return body;
}

/** Repo ids ride in the query string — an id can be "." and a "." path
 *  segment is normalized out of the URL before the request is sent. */
const rq = (id: string, extra: Record<string, string> = {}): string =>
  new URLSearchParams({ id, ...extra }).toString();

/** The backend an id belongs to and the id that backend knows. */
const on = (id: string): [string, string] => split(registry(), id);

/** An answer from `b` with its ids under `b`'s name; home's as it came. */
function from<T>(b: string, v: T, f: (q: Q, v: T) => T): T {
  if (b === homeName()) return v;
  return f((id) => qual(b, id), v);
}
const fromAll = <T>(b: string, list: T[], f: (q: Q, v: T) => T): T[] =>
  b === homeName() ? list : list.map((v) => from(b, v, f));

/** One sprout's action on the backend its id names, its answer qualified. */
async function sproutReq(id: string, path: string, init: RequestInit): Promise<Sprout> {
  const [b, plain] = on(id);
  return from(b, await req<Sprout>(b, `${path}?id=${encodeURIComponent(plain)}`, init), qSprout);
}

/** Ids by the backend they belong to, in registry order, each as that
 *  backend knows it and in the order given. None at all is home's. */
function byBackend(ids: readonly string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const [b, plain] = on(id);
    const list = groups.get(b) ?? [];
    list.push(plain);
    groups.set(b, list);
  }
  if (groups.size === 0) return [[homeName(), []]];
  const names = registry().names;
  return [...groups].sort(([x], [y]) => names.indexOf(x) - names.indexOf(y));
}

/** One ask of a whole backend, and one of a repo (or run, shell, ...) on it. */
async function repoReq<T>(id: string, path: (plain: string) => string, init?: RequestInit): Promise<T> {
  const [b, plain] = on(id);
  return req<T>(b, path(plain), init);
}

/** A GET whose body is a file, not JSON: the gate's cookie rides along,
 *  and a refusal's JSON error still comes back as the error. */
async function blobReq(b: string, path: string): Promise<Blob> {
  if (!reachable(b)) throw new Error(`${b} has not answered yet`);
  const base = baseOf(b);
  // a read: the token rides on the page's own origin alone, as in req
  const r = await fetch(base + path, base ? { credentials: "include" } : { headers: tokenHeaders(originOf(base)) });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    throw Object.assign(new Error(body?.error ?? `${r.status} ${r.statusText}`), { status: r.status });
  }
  return r.blob();
}

export const api = {
  tree: async (b: string = homeName()) => from(b, await req<ScanResult>(b, "/api/tree"), qScan),
  rescan: async (b: string = homeName()) =>
    from(b, await req<ScanResult>(b, "/api/rescan", { method: "POST" }), qScan),
  sources: async (b: string = homeName()) => fromAll(b, await req<SourceState[]>(b, "/api/sources"), qSource),
  addSource: async (input: SourceInput, b: string = homeName()) =>
    from(
      b,
      await req<ScanResult>(b, "/api/sources", {
        method: "POST",
        body: JSON.stringify(input),
      }),
      qScan,
    ),
  removeSource: async (id: string) => {
    const [b, plain] = on(id);
    return from(b, await req<ScanResult>(b, `/api/sources?${rq(plain)}`, { method: "DELETE" }), qScan);
  },
  rescanSource: async (id: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<ScanResult>(b, `/api/sources/rescan?${rq(plain)}`, {
        method: "POST",
        body: "{}",
      }),
      qScan,
    );
  },
  /** aliases from ~/.ssh/config, for the add-a-folder form */
  hosts: (b: string = homeName()) => req<string[]>(b, "/api/hosts"),
  /** one folder's subfolders, here or on a host, for the folder browser */
  browse: (path: string, host?: string, b: string = homeName()) =>
    req<Listing>(
      b,
      `/api/browse?${new URLSearchParams({ path, ...(host ? { host } : {}) }).toString()}`,
    ),
  log: (id: string) => repoReq<LogEntry[]>(id, (p) => `/api/repos/log?${rq(p)}`),
  /** a worktree's or a branch's work, for the changes section's drill */
  elsewhere: (id: string, at: { worktree: string } | { branch: string }) =>
    repoReq<ElsewhereDetail>(id, (p) => `/api/repos/elsewhere?${rq(p, at)}`),
  show: (id: string, hash: string) =>
    repoReq<CommitDetail>(id, (p) => `/api/repos/commit?${rq(p, { hash })}`),
  commitDiff: (id: string, hash: string, file: string, orig?: string) =>
    repoReq<{ diff: string }>(
      id,
      (p) =>
        `/api/repos/diff?${rq(p, {
          file,
          commit: hash,
          ...(orig === undefined ? {} : { orig }),
        })}`,
    ),
  access: (id: string) =>
    repoReq<{ access: PushAccess }>(id, (p) => `/api/repos/access?${rq(p)}`),
  /** `worktree` reads the file in one of the repo's linked worktrees */
  diff: (id: string, file: string, staged: boolean, untracked: boolean, worktree?: string) =>
    repoReq<{ diff: string }>(
      id,
      (p) =>
        `/api/repos/diff?${rq(p, {
          file,
          staged: staged ? "1" : "0",
          untracked: untracked ? "1" : "0",
          ...(worktree === undefined ? {} : { worktree }),
        })}`,
    ),
  /** `orig` is a rename's old path, which goes on or off the index with it */
  stage: async (id: string, file: string, unstage: boolean, orig?: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Repo>(b, `/api/repos/stage?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify({ file, unstage, orig }),
      }),
      qRepo,
    );
  },
  commit: (id: string, message: string, stageAll: boolean) =>
    repoReq<{ ok: true; out: string }>(id, (p) => `/api/repos/commit?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify({ message, stageAll }),
    }),
  push: (id: string) =>
    repoReq<{ ok: true; out: string }>(id, (p) => `/api/repos/push?${rq(p)}`, {
      method: "POST",
      body: "{}",
    }),
  pull: (id: string) =>
    repoReq<{ ok: true; out: string }>(id, (p) => `/api/repos/pull?${rq(p)}`, {
      method: "POST",
      body: "{}",
    }),
  /** removes the repo's index.lock when it is stale; 409 when it is not */
  unlock: (id: string) =>
    repoReq<{ ok: true; cleared: string }>(id, (p) => `/api/repos/unlock?${rq(p)}`, {
      method: "POST",
      body: "{}",
    }),
  suggest: (id: string) =>
    repoReq<{ message: string; source: "ai" | "heuristic" }>(
      id,
      (p) => `/api/repos/suggest?${rq(p)}`,
      { method: "POST", body: "{}" },
    ),
  /** `tab` asks the terminal openers for a tab in the front window */
  /** `helper` names the `canopy helper` that opens it on this machine;
   *  without one the backend's own desktop does, when the browser is on it */
  open: (id: string, app: string, tab = false, helper?: string) =>
    repoReq<{ ok: true }>(id, (p) => `/api/repos/open?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify({ app, tab, helper }),
    }),
  /** a backend's agent routing: profiles, the route per role, and the repo
   *  overrides by path; an older backend's plain map of settings reads as
   *  those repos' whole-repo picks */
  agents: async (b: string = homeName()) => normalizeRoutes(await req<unknown>(b, "/api/agents")),
  /** a repo's override, whole; an empty one removes it. A backend older
   *  than routing takes plain settings (`flatAgent`) instead. */
  setRepoAgent: async (id: string, agent: RepoAgent | AgentSettings) =>
    normalizeRoutes(
      await repoReq<unknown>(id, (p) => `/api/repos/agent?${rq(p)}`, {
        method: "POST",
        body: JSON.stringify(agent),
      }),
    ),
  /** writes a profile on a backend, or deletes it with null */
  setProfile: async (name: string, settings: AgentSettings | null, b: string = homeName()) =>
    normalizeRoutes(await req<unknown>(b, "/api/agents/profile", { method: "POST", body: JSON.stringify({ name, settings }) })),
  /** points a role at a pick on a backend, or back at the default with null */
  setRole: async (role: AgentRole, pick: AgentPick | null, b: string = homeName()) =>
    normalizeRoutes(await req<unknown>(b, "/api/agents/role", { method: "POST", body: JSON.stringify({ role, pick }) })),

  setAgentScope: async (scope: AgentScope, pick: AgentPick | null, b: string = homeName()) =>
    normalizeRoutes(await req<unknown>(b, "/api/agents/scope", { method: "POST", body: JSON.stringify({ ...scope, pick }) })),
  /** one repo's effective table, as its backend resolves it */
  resolveAgents: (id: string) => repoReq<AgentTable>(id, (p) => `/api/agents/resolve?${rq(p)}`),
  history: async (refresh = false, b: string = homeName(), window?: HistoryWindow) => {
    const params = new URLSearchParams();
    if (refresh) params.set("refresh", "1");
    if (window) params.set("window", window);
    const query = params.toString();
    const path = query ? `/api/history?${query}` : "/api/history";
    return from(b, await req<HistoryOverview>(b, path), qHistory);
  },
  sessions: (id: string, since: HistoryWindow) =>
    repoReq<HistorySession[]>(id, (p) => `/api/repos/sessions?${rq(p, { since })}`),
  session: (id: string, session: string) =>
    repoReq<HistorySessionDetail>(id, (p) => `/api/repos/session?${rq(p, { session })}`),
  search: (id: string, q: string) =>
    repoReq<HistoryHit[]>(id, (p) => `/api/repos/search?${rq(p, { q })}`),
  /** file contents of one repo, through git grep */
  grep: (id: string, q: string) =>
    repoReq<GrepResult>(id, (p) => `/api/repos/grep?${rq(p, { q })}`),
  /** the same search across many repos, one row each in the order given;
   *  over several backends, one that fails marks only its own rows */
  grepAll: async (q: string, ids: string[]): Promise<GrepRepoResult[]> => {
    const groups = byBackend(ids);
    const one = groups.length === 1 ? groups[0] : undefined;
    // one backend: its answer, or its error, as it always was
    if (one) {
      const [b, plain] = one;
      const rows = await req<GrepRepoResult[]>(b, "/api/grep", { method: "POST", body: JSON.stringify({ q, ids: plain }) });
      return fromAll(b, rows, qGrep);
    }
    const found = new Map<string, GrepRepoResult>();
    await Promise.all(
      groups.map(async ([b, plain]) => {
        try {
          const rows = await req<GrepRepoResult[]>(b, "/api/grep", { method: "POST", body: JSON.stringify({ q, ids: plain }) });
          for (const row of fromAll(b, rows, qGrep)) found.set(row.repo, row);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          for (const id of plain) found.set(qual(b, id), { repo: qual(b, id), hits: [], truncated: false, error });
        }
      }),
    );
    return ids.map((id) => found.get(id) ?? { repo: id, hits: [], truncated: false, error: "no answer for this repo" });
  },
  /** every file of a repo's working tree that git does not ignore */
  files: (id: string) => repoReq<RepoFiles>(id, (p) => `/api/repos/ls?${rq(p)}`),
  /** the commands and skills a prompt box offers after / and $ */
  mentions: (id: string) => repoReq<Mention[]>(id, (p) => `/api/repos/mentions?${rq(p)}`),
  /** one folder straight off the disk, what git ignores included */
  dir: (id: string, path: string) => repoReq<DirEntry[]>(id, (p) => `/api/repos/dir?${rq(p, { path })}`),
  /** one file's bytes, refused (413) past `max` */
  rawFile: (id: string, path: string, max: number) => {
    const [b, plain] = on(id);
    return blobReq(b, `/api/repos/raw?${rq(plain, { path, max: String(max) })}`);
  },
  /** opens one file of a repo at a line in VS Code */
  openFile: (id: string, file: string, line: number, helper?: string) =>
    repoReq<{ ok: true }>(id, (p) => `/api/repos/openfile?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify({ file, line, helper }),
    }),
  openNote: (id: string, session: string) =>
    repoReq<{ ok: true }>(id, (p) => `/api/repos/note?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify({ session }),
    }),
  /** saves an image for shell `id` on the backend; `text` is its path as
   *  the shell should see it typed */
  pasteImage: (id: string, image: Blob) =>
    repoReq<{ path: string; text: string }>(id, (p) => `/api/terms/paste?term=${encodeURIComponent(p)}`, {
      method: "POST",
      headers: { "Content-Type": image.type },
      body: image,
    }),
  /** saves a picture taken in the preview's design mode (FR-029) on the
   *  repo's backend, beside the pasted images, where its agent can read it */
  clipImage: (id: string, image: Blob) =>
    repoReq<{ path: string; text: string }>(id, (p) => `/api/repos/clip?${rq(p)}`, {
      method: "POST",
      headers: { "Content-Type": image.type },
      body: image,
    }),
  /** the shells the server holds, attached or waiting for a browser */
  terms: async (b: string = homeName()) => fromAll(b, await req<TermInfo[]>(b, "/api/terms"), qTerm),
  /** the newest transcript of the agent in a shell, on the shell's own
   *  machine: the pane's agent when tmux can say, else `harness` */
  termTranscript: (id: string, harness?: Harness) =>
    repoReq<{ harness: Harness; path: string }>(id, (p) => `/api/terms/transcript?term=${encodeURIComponent(p)}${harness ? `&harness=${harness}` : ""}`),
  /** what a shell is running, asked of tmux: claude, codex or neither */
  termAgent: (id: string) =>
    repoReq<{ agent: AgentKind | null }>(id, (p) => `/api/terms/agent?term=${encodeURIComponent(p)}`),
  /** what a shell's pane shows now, for a peek; null text on a plain pty */
  termScreen: (id: string) => repoReq<TermScreen>(id, (p) => `/api/terms/screen?term=${encodeURIComponent(p)}`),
  /** a shell's text as tmux holds it, for a copy; null text on a plain pty */
  termText: (id: string) =>
    repoReq<{ text: string | null; fullscreen: boolean }>(id, (p) => `/api/terms/text?term=${encodeURIComponent(p)}`),
  /** names a held shell by hand, so every device's tab says it; an empty
   *  name takes it off */
  labelTerm: (id: string, label: string) =>
    repoReq<{ ok: true; label?: string }>(id, () => "/api/terms/label", { method: "POST", body: JSON.stringify({ term: plainOf(id), label }) }),
  /** moves a held shell to the strip or its repo's panel, so every
   *  device's tab moves with it (FR-031) */
  placeTerm: (id: string, place: ShellPlace) =>
    repoReq<{ ok: true; place: ShellPlace }>(id, () => "/api/terms/place", { method: "POST", body: JSON.stringify({ term: plainOf(id), place }) }),
  /** ends one shell; closing its socket alone leaves it running */
  endTerm: (id: string) =>
    repoReq<{ ok: true }>(id, (p) => `/api/terms?term=${encodeURIComponent(p)}`, { method: "DELETE" }),
  /** the shells a machine going down left behind, and whether the backend
   *  is recording them at all */
  kept: async (b: string = homeName()) => {
    const got = await req<{ keeping: boolean; kept: KeptShell[] }>(b, "/api/terms/kept");
    return b === homeName() ? got : { ...got, kept: fromAll(b, got.kept, qKept) };
  },
  /** starts a kept shell again under its own name; `resume` also runs the
   *  line that picks the agent's conversation back up */
  restoreShell: async (id: string, resume: boolean, cols = 80, rows = 24) => {
    const [b, term] = on(id);
    return from(
      b,
      await req<TermInfo>(b, "/api/terms/restore", { method: "POST", body: JSON.stringify({ term, cols, rows, resume }) }),
      qTerm,
    );
  },
  /** drops what a kept shell left, history and all */
  forgetShell: (id: string) =>
    repoReq<{ ok: true }>(id, (p) => `/api/terms/kept?term=${encodeURIComponent(p)}`, { method: "DELETE" }),
  /** the agent conversations started at a repo on the backend, both
   *  harnesses', newest first; an older backend's have no harness and are
   *  claude's */
  agentSessions: async (repoId: string) =>
    (await repoReq<AgentSession[]>(repoId, (p) => `/api/repos/resumable?${rq(p)}`)).map((x) => ({ ...x, harness: x.harness ?? "claude" })),
  /** a new shell at the repo under `term`, with that conversation picked
   *  back up in it by its own harness */
  resumeAgent: async (repoId: string, term: string, place: ShellPlace, session: string, harness: Harness, cols = 80, rows = 24) => {
    const [b, plain] = on(repoId);
    return from(
      b,
      await req<TermInfo>(b, `/api/repos/resume?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify({ term: plainOf(term), place, session, harness, cols, rows }),
      }),
      qTerm,
    );
  },
  /** what moving a shell's session would carry, from the shell's backend */
  movePlan: (term: string, session?: string | null, harness?: Harness | null) =>
    repoReq<MovePlan>(term, (p) => `/api/terms/move/plan?term=${encodeURIComponent(p)}${session ? `&session=${encodeURIComponent(session)}` : ""}${harness ? `&harness=${harness}` : ""}`),
  /** whether the target repo can take a move as it stands */
  moveCheck: (repoId: string, body: { from: string; branch: string; head: string; transcriptBytes: number; session: string; harness: Harness }) =>
    repoReq<MoveCheck>(repoId, (p) => `/api/repos/movecheck?${rq(p)}`, { method: "POST", body: JSON.stringify(body) }),
  /** stops the shell's agent and snapshots its work, under the move id the
   *  later calls name again (32 hex digits, minted by the sheet) */
  moveOut: (term: string, session: string, harness: Harness, move: string) =>
    repoReq<MoveOut>(term, (p) => `/api/terms/move/out?term=${encodeURIComponent(p)}&move=${move}`, { method: "POST", body: JSON.stringify({ session, harness }) }),
  moveTranscript: (term: string, session: string, move: string) => {
    const [b, plain] = on(term);
    return blobReq(b, `/api/terms/move/transcript?term=${encodeURIComponent(plain)}&session=${encodeURIComponent(session)}&move=${move}`);
  },
  /** loads the moved work and conversation into a new shell `term` at the target repo */
  moveIn: async (repoId: string, out: MoveOut, transcript: Blob, source: string, term: string, place: ShellPlace, cols = 80, rows = 24) => {
    const [b, plain] = on(repoId);
    const form = new FormData();
    // the move id is the source's alone; left out, the target never sees it
    form.set("meta", JSON.stringify({ ...out, move: undefined, from: source, term: plainOf(term), place, cols, rows }));
    form.set("transcript", transcript, "transcript.jsonl");
    return from(b, await req<TermInfo>(b, `/api/repos/movein?${rq(plain)}`, { method: "POST", body: form }), qTerm);
  },
  moveFinish: (term: string, move: string) =>
    repoReq<{ ok: true; reset: string }>(term, (p) => `/api/terms/move/finish?term=${encodeURIComponent(p)}&move=${move}`, { method: "POST" }),
  moveUndo: (term: string, move: string) =>
    repoReq<{ ok: true; resumed: boolean }>(term, (p) => `/api/terms/move/undo?term=${encodeURIComponent(p)}&move=${move}`, { method: "POST" }),
  /** turns the recording on or off for this backend */
  setKeeping: (on: boolean, b: string = homeName()) =>
    req<{ keeping: boolean }>(b, "/api/keep", { method: "POST", body: JSON.stringify({ on }) }),
  /** keep awake on one backend: its mode and whether it holds the machine now */
  awake: (b: string = homeName()) => req<AwakeInfo>(b, "/api/awake"),
  setAwake: (mode: AwakeMode, b: string = homeName()) => req<AwakeInfo>(b, "/api/awake", { method: "POST", body: JSON.stringify({ mode }) }),
  /** tailchan: the broker's view as the UI's handle, or why it is off */
  tailchan: () => req<TailchanInfo>(homeName(), "/api/tailchan"),
  /** the agent registry, the home backend's alone; a 503 without a broker */
  registry: () => req<RegistryInfo>(homeName(), "/api/registry"),
  /** what a registry card's session did, read from its transcript by the
   *  backend `b` on the machine it ran on; a 404 when the file is not there */
  agentActivity: (b: string, harness: Harness, session: string, cwd: string) =>
    req<AgentActivity>(b, `/api/agents/activity?harness=${harness}&session=${encodeURIComponent(session)}&cwd=${encodeURIComponent(cwd)}`),
  /** the models a spoken conversation would use, each null when the home backend has no key for it */
  voice: (b: string = homeName()) => req<VoiceInfo>(b, "/api/voice"),
  /** a field's recorded clip as text, from a backend whose /api/voice says it can */
  dictate: (b: string, clip: Blob, seconds: number) => req<Dictation>(b, `/api/voice/dictate?seconds=${seconds.toFixed(1)}`, { method: "POST", body: clip }),
  /** a call's length once it ends, for the cost ledger on the backend that billed it */
  voiceEnded: (engine: VoiceEngine, seconds: number, context: VoiceContext) =>
    req<{ ok: true }>(homeName(), "/api/voice/ended", { method: "POST", body: JSON.stringify({ engine, seconds, context }) }),
  /** a backend's cost ledger over the last `days` local days */
  costs: (days: number, b: string) => req<CostReport>(b, `/api/costs?days=${days}`),
  /** a client secret for one conversation, minted by the home backend */
  voiceSession: () => req<VoiceSession>(homeName(), "/api/voice/session", { method: "POST", body: "{}" }),
  /** a GPT-Live session for this page's WebRTC offer, started by the home backend with its key */
  voiceLive: (sdp: string, context?: VoiceContext) => req<LiveAnswer>(homeName(), "/api/voice/live", { method: "POST", body: JSON.stringify({ sdp, context }) }),
  /** the broker's asks as the home backend follows them, and presence; a
   *  503 without a broker */
  asks: () => req<AsksInfo>(homeName(), "/api/asks"),
  /** one ask, open or long closed, for a link to it */
  ask: (id: string) => req<Ask>(homeName(), `/api/asks/one?id=${encodeURIComponent(id)}`),
  /** Answers an ask with this browser's answer key, which the home backend
   *  (and it alone) forwards to the broker; `client` names this browser, so
   *  the broker can say which device answered. */
  answerAsk: (id: string, answer: AskAnswer & { remember?: string }, key: string) =>
    req<Ask>(homeName(), "/api/asks/answer", { method: "POST", headers: keyHeaders(key), body: JSON.stringify({ id, ...answer, client: clientId() }) }),
  /** the incubator, one backend's at a time; a sprout's calls go to the
   *  backend its id names */
  sprouts: async (b: string = homeName()) => fromAll(b, await req<Sprout[]>(b, "/api/incubator"), qSprout),
  incubatorStages: (b: string = homeName()) => req<IncubatorStages>(b, "/api/incubator/stages"),
  sprout: async (id: string) => {
    const [b, plain] = on(id);
    return from(b, await req<SproutDetail>(b, `/api/incubator/one?id=${encodeURIComponent(plain)}`), qSproutDetail);
  },
  /** multipart, so a voice memo or an image goes as it is */
  newSprout: async (form: FormData, b: string = homeName()) =>
    from(b, await req<Sprout>(b, "/api/incubator", { method: "POST", body: form }), qSprout),
  addSproutInputs: (id: string, form: FormData) => sproutReq(id, "/api/incubator/input", { method: "POST", body: form }),
  answerSprout: (id: string, body: { answers: Record<string, string> } | { skip: true }) =>
    sproutReq(id, "/api/incubator/answer", { method: "POST", body: JSON.stringify(body) }),
  stopSprout: (id: string) => sproutReq(id, "/api/incubator/stop", { method: "POST", body: "{}" }),
  resumeSprout: (id: string, choice: "continue" | "retry") =>
    sproutReq(id, "/api/incubator/resume", { method: "POST", body: JSON.stringify({ choice }) }),
  /** the user's yes or no to an extend's push; a yes names the head it saw */
  handOffSprout: (id: string, approve: boolean, head: string) =>
    sproutReq(id, "/api/incubator/handoff", { method: "POST", body: JSON.stringify({ approve, head }) }),
  dismissSprout: (id: string) => {
    const [b, plain] = on(id);
    return req<{ ok: true }>(b, `/api/incubator?id=${encodeURIComponent(plain)}`, { method: "DELETE" });
  },
  /** what is broken on one backend and what it is healing */
  // a backend that answers something else (a proxy's page, an older build) has none
  health: async (b: string = homeName()) => {
    const r = await req<Partial<HealthInfo> | null>(b, "/api/health");
    return fromAll(b, Array.isArray(r?.checks) ? r.checks : [], qCheck);
  },
  /** this backend's usage windows and any starts held for capacity */
  capacity: (b: string = homeName()) => req<CapacityInfo>(b, "/api/capacity"),
  /** the kit on one backend: the machines it reaches, their cells and plans */
  kit: (b: string = homeName()) => req<KitInfo>(b, "/api/kit"),
  kitScan: (b: string) => req<KitInfo>(b, "/api/kit/scan", { method: "POST", body: "{}" }),
  /** the machine's whole plan, or the actions given (one cell's) */
  kitApply: (b: string, machine: string, actions?: KitAction[]) =>
    req<KitApplyResult>(b, "/api/kit/apply", { method: "POST", body: JSON.stringify({ machine, actions }) }),
  kitSkillAdopt: (b: string, machine: string, agent: string, name: string) =>
    req<KitApplyResult>(b, "/api/kit/skill-adopt", { method: "POST", body: JSON.stringify({ machine, agent, name }) }),
  kitSkillRestore: (b: string, machine: string, agent: string, name: string) =>
    req<KitApplyResult>(b, "/api/kit/skill-restore", { method: "POST", body: JSON.stringify({ machine, agent, name }) }),
  /** runs the install line the page showed; the server refuses one that has changed */
  kitInstall: (b: string, machine: string, tool: string, line: string) =>
    req<KitInstallResult>(b, "/api/kit/install", { method: "POST", body: JSON.stringify({ machine, tool, line }) }),
  kitAdopt: (b: string, machine: string, agent: string, names?: string[]) =>
    req<KitApplyResult>(b, "/api/kit/adopt", { method: "POST", body: JSON.stringify({ machine, agent, names }) }),
  kitRestore: (b: string, machine: string, agent: string, name: string) =>
    req<KitApplyResult>(b, "/api/kit/restore", { method: "POST", body: JSON.stringify({ machine, agent, name }) }),
  /** what adopt would change, both sides masked */
  kitPreview: (b: string, machine: string, agent: string, name: string) =>
    req<KitMcpPreview>(b, `/api/kit/preview?${new URLSearchParams({ machine, agent, name }).toString()}`),
  /** heal one check now, by its plain id on that backend */
  healCheck: async (b: string, id: string) => from(b, await req<HealthCheck>(b, `/api/health/heal?id=${encodeURIComponent(id)}`, { method: "POST", body: "{}" }), qCheck),
  /* the secret store (server/secrets.ts); no answer here ever holds a value
     but a reveal's, and none carries ids, so nothing is qualified */
  secrets: (b: string = homeName()) => req<SecretsInfo>(b, "/api/secrets"),
  secretsAudit: (b: string) => req<SecretAuditEntry[]>(b, "/api/secrets/audit"),
  secretsBegin: (b: string, kind: "login" | "register", code: string | null) =>
    req<unknown>(b, "/api/secrets/gate/begin", { method: "POST", body: JSON.stringify({ kind, code }) }),
  secretsFinish: (b: string, kind: "login" | "register", code: string | null, response: unknown, label: string) =>
    req<{ ok: true }>(b, "/api/secrets/gate/finish", { method: "POST", body: JSON.stringify({ kind, code, response, label }) }),
  secretsLogout: (b: string) => req<{ ok: true }>(b, "/api/secrets/logout", { method: "POST", body: "{}" }),
  secretsAct: (b: string, act: SecretAct) => req<unknown>(b, "/api/secrets/act", { method: "POST", body: JSON.stringify({ act }) }),
  secretsPropose: (b: string, items: SecretProposalIn[]) =>
    req<{ added: number; dropped: number }>(b, "/api/secrets/proposals", { method: "POST", body: JSON.stringify({ items }) }),
  secretsPull: (b: string) => req<SecretsInfo>(b, "/api/secrets/pull", { method: "POST", body: "{}" }),
  secretsScan: (b: string) => req<{ items: SecretProposalIn[]; missing: string[] }>(b, "/api/secrets/scan", { method: "POST", body: "{}" }),
  secretsTake: (b: string, id: string, key: string) => req<SecretProposalIn>(b, "/api/secrets/take", { method: "POST", body: JSON.stringify({ id, key }) }),
  secretsUnlock: (b: string, passphrase: string) => req<{ ok: true }>(b, "/api/secrets/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }),
  secretsLock: (b: string) => req<{ ok: true }>(b, "/api/secrets/lock", { method: "POST", body: "{}" }),
  secretsKey: (b: string, passphrase: string, replace: boolean) =>
    req<{ recipient: string }>(b, "/api/secrets/key", { method: "POST", body: JSON.stringify({ passphrase, replace }) }),
  /** the ranger, canopy's always-on agent, one backend's */
  ranger: (b: string = homeName()) => req<RangerInfo>(b, "/api/ranger"),
  /** a change to its settings: on, profile, handle, telegram, fresh */
  setRanger: (b: string, patch: Record<string, unknown>) => req<RangerInfo>(b, "/api/ranger", { method: "POST", body: JSON.stringify(patch) }),
  rangerAct: (b: string, act: "restart" | "fresh") => req<RangerInfo>(b, `/api/ranger/${act}`, { method: "POST", body: "{}" }),
  /** a wake set from the page, which is Eric's */
  addRangerWake: (b: string, wake: { prompt: string; cron?: string; when?: string }) =>
    req<RangerWake>(b, "/api/ranger/wakes", { method: "POST", body: JSON.stringify({ ...wake, by: "eric" }) }),
  removeRangerWake: (b: string, id: string) => req<RangerInfo>(b, `/api/ranger/wakes?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** the sweep: what went idle on the home backend, offered for closing */
  sweep: () => req<SweepInfo>(homeName(), "/api/sweep"),
  /** closes the items named, each after a fresh look; an outcome per key */
  closeSweep: async (keys: string[]) => (await req<{ outcomes: SweepOutcome[] }>(homeName(), "/api/sweep", { method: "POST", body: JSON.stringify({ keys }) })).outcomes,
  /** answers the scheduled fire's ask: closes those of its keys the plan
   *  still ticks, and clears the whole ask */
  answerSweepAsk: async (keys: string[]) =>
    (await req<{ outcomes: SweepOutcome[] }>(homeName(), "/api/sweep/ask", { method: "POST", body: JSON.stringify({ keys }) })).outcomes,
  /** drops the ask, closing nothing */
  dismissSweepAsk: () => req<{ ok: true }>(homeName(), "/api/sweep/ask", { method: "DELETE" }),
  /** patches the sweep's settings; a refusal (a bad cron) is its error */
  setSweepSettings: (patch: Record<string, unknown>) => req<SweepSettings>(homeName(), "/api/sweep/settings", { method: "POST", body: JSON.stringify(patch) }),
  /** starts a chat on a swept chat's session; it waits idle for a message */
  resumeSwept: (runId: string) => req<Run>(homeName(), "/api/sweep/resume", { method: "POST", body: JSON.stringify({ runId }) }),
  /** the retro lessons on offer */
  advice: () => req<AdviceOffer[]>(homeName(), "/api/incubator/advice"),
  /** accepts or dismisses one; a chat it opened is named by the page's ids */
  answerAdvice: async (key: string, accept: boolean) => {
    const out = await req<{ advice: AdviceOffer[]; accepted?: AdviceAccepted }>(homeName(), "/api/incubator/advice", {
      method: "POST",
      body: JSON.stringify({ key, accept }),
    });
    const a = out.accepted;
    if (a?.kind !== "chat") return out;
    return { ...out, accepted: { ...a, runId: qual(homeName(), a.runId), repoId: qual(homeName(), a.repoId) } };
  },
  /** away pins until cleared; clearing it is being here */
  setAway: (away: boolean, key: string) =>
    req<Presence>(homeName(), "/api/presence", { method: "POST", headers: keyHeaders(key), body: JSON.stringify({ away }) }),
  /** the page's own "someone is here", which is also how a key is tested */
  presenceBeat: (key: string) =>
    req<{ presence: Presence | null }>(homeName(), "/api/presence/beat", { method: "POST", headers: keyHeaders(key), body: "{}" }),
  /** the broker's guard rules */
  guards: () => req<GuardsInfo>(homeName(), "/api/guards"),
  setGuards: (rules: string[], key: string) =>
    req<GuardsInfo>(homeName(), "/api/guards", { method: "PUT", headers: keyHeaders(key), body: JSON.stringify({ rules }) }),
  chanRead: (target: string, n = 50) =>
    req<ChanMessage[]>(homeName(), `/api/tailchan/read?target=${encodeURIComponent(target)}&n=${n}`),
  chanSend: (target: string, body: string, kind: "text" | "clip" = "text") =>
    req<ChanMessage>(homeName(), "/api/tailchan/send", { method: "POST", body: JSON.stringify({ target, body, kind }) }),
  chanPut: (target: string, file: File, note = "") =>
    req<ChanMessage>(homeName(), `/api/tailchan/put?target=${encodeURIComponent(target)}&name=${encodeURIComponent(file.name)}&note=${encodeURIComponent(note)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }),
  chanNotify: (on: boolean) =>
    req<{ notify: boolean }>(homeName(), "/api/tailchan/notify", { method: "POST", body: JSON.stringify({ on }) }),
  runs: async (b: string = homeName()) => fromAll(b, await req<Run[]>(b, "/api/runs"), qRun),
  /** `client` is this browser's id, so the run says which device started it */
  run: async (id: string, action: RunAction, note: string, client?: string, branch?: boolean, pr?: boolean) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Run>(b, `/api/repos/run?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify({ action, note, client, ...(branch !== undefined ? { branch } : {}), ...(pr ? { pr } : {}) }),
      }),
      qRun,
    );
  },
  /** one backend's PRs that branch runs opened; an older backend has none */
  prs: async (b: string = homeName()) => {
    const r = await req<PrWatch[] | null>(b, "/api/prs");
    return from(b, Array.isArray(r) ? r : [], qPrs);
  },
  /** one backend's trigger rules and events; null from a backend from before triggers */
  triggers: async (b: string = homeName()): Promise<TriggersInfo | null> => {
    const r = await req<TriggersInfo | null>(b, "/api/triggers");
    if (!r || !Array.isArray(r.events)) return null;
    return { ...r, events: from(b, r.events, qTriggers) };
  },
  /** Fires an issue rule, or a schedule for every matching repo or one. */
  fireTrigger: (b: string, rule: string, title: string, repo?: string) =>
    req<Delivery>(b, "/api/triggers/fire", { method: "POST", body: JSON.stringify({ rule, title, ...(repo ? { repo: plainOf(repo) } : {}) }) }),
  /** runs one rule's poll now; the events it makes come over the stream */
  pollTrigger: async (b: string, rule: string) => {
    await req<{ ok: true }>(b, "/api/triggers/poll", { method: "POST", body: JSON.stringify({ rule }) });
  },
  /** resume, retry or stop a trigger event, by its qualified id */
  triggerAct: async (id: string, act: "resume" | "retry" | "stop") => {
    const [b, plain] = on(id);
    await req<TriggerEvent>(b, `/api/triggers/${act}`, { method: "POST", body: JSON.stringify({ id: plain }) });
  },
  dismissTrigger: async (id: string) => {
    const [b, plain] = on(id);
    await req<{ ok: true }>(b, `/api/triggers/events?id=${encodeURIComponent(plain)}`, { method: "DELETE" });
  },
  /** "open PR" on a ready branch run, by its run's or its branch's id */
  openPr: async (id: string, draft = false) => {
    const [b, plain] = on(id);
    await req<PrWatch>(b, "/api/prs/open", { method: "POST", body: JSON.stringify({ run: plain, ...(draft ? { draft } : {}) }) });
  },
  /** the PR footer's toggles */
  setPr: async (id: string, change: { autoFix?: boolean; autoMerge?: boolean }) => {
    const [b, plain] = on(id);
    await req<PrWatch>(b, "/api/prs/set", { method: "POST", body: JSON.stringify({ run: plain, ...change }) });
  },
  /** closes the PR and its remote branch; the run may land here again */
  closePr: async (id: string) => {
    const [b, plain] = on(id);
    await req<{ ok: true }>(b, "/api/prs/close", { method: "POST", body: JSON.stringify({ run: plain }) });
  },
  /** one backend's caller check: its mode, callers, pair requests and who
   *  this page is to it; null from a backend from before there was one */
  auth: async (b: string = homeName()): Promise<AuthInfo | null> => {
    const r = await req<unknown>(b, "/api/auth");
    return isAuthInfo(r) ? r : null;
  },
  /** asks a backend to let this page in; the secret claims the token once approved */
  /** `renew` is the asker's own last pair: the server replaces it, when it still waits, with this one */
  pair: (b: string, label: string, renew?: { id: string; secret: string }) =>
    req<{ id: string; code: string; secret: string }>(b, "/api/auth/pair", { method: "POST", body: JSON.stringify({ label, kind: "page", ...renew }) }),
  /** the token once someone approved the pair, or waiting until then */
  claim: (b: string, id: string, secret: string) =>
    req<{ token: string } | { waiting: true }>(b, "/api/auth/claim", { method: "POST", body: JSON.stringify({ id, secret }) }),
  /** approves a waiting pair with the first sign-in code from the server's log */
  firstCode: (b: string, id: string, code: string) => req<{ ok: true }>(b, "/api/auth/first", { method: "POST", body: JSON.stringify({ id, code }) }),
  approvePair: (b: string, id: string) => req<{ ok: true }>(b, "/api/auth/approve", { method: "POST", body: JSON.stringify({ id }) }),
  denyPair: (b: string, id: string) => req<{ ok: true }>(b, "/api/auth/deny", { method: "POST", body: JSON.stringify({ id }) }),
  revokeCaller: (b: string, id: string) => req<{ ok: true }>(b, "/api/auth/revoke", { method: "POST", body: JSON.stringify({ id }) }),
  /** a one-use ticket for a socket the browser cannot put a header on */
  ticket: async (b: string, what: "term" | "helper") => (await req<{ ticket: string }>(b, "/api/auth/ticket", { method: "POST", body: JSON.stringify({ for: what }) })).ticket,
  /** one backend's branch runs and landing queue; an older backend has none */
  landing: async (b: string = homeName()) => {
    const r = await req<Partial<LandingInfo> | null>(b, "/api/landing");
    const info: LandingInfo = {
      runs: Array.isArray(r?.runs) ? r.runs : [],
      entries: Array.isArray(r?.entries) ? r.entries : [],
      orphans: Array.isArray(r?.orphans) ? r.orphans : [],
      notices: Array.isArray(r?.notices) ? r.notices : [],
      ...(Array.isArray(r?.collisions) ? { collisions: r.collisions } : {}),
    };
    return from(b, info, qLanding);
  },
  /** "land" on a ready branch run, by its run's or its branch's id;
   *  `approve` is the sensitive patch id the approve sheet showed */
  land: async (id: string, approve?: string, skipJudge?: boolean) => {
    const [b, plain] = on(id);
    await req<LandEntry>(b, "/api/landing/land", { method: "POST", body: JSON.stringify({ run: plain, ...(approve ? { approve } : {}), ...(skipJudge ? { skipJudge: true } : {}) }) });
  },
  /** "land all" in one repo: the ready runs that need no approval */
  landAll: async (repoId: string) => {
    const [b, plain] = on(repoId);
    return req<{ queued: string[]; skipped: { id: string; branch: string; why: string }[] }>(b, "/api/landing/land-all", { method: "POST", body: JSON.stringify({ repo: plain }) });
  },
  /** one file's diff as a branch run's latest sort saw it */
  landingDiff: async (id: string, path: string) => {
    const [b, plain] = on(id);
    return req<{ path: string; diff: string }>(b, `/api/landing/diff?${rq(plain, { path })}`);
  },
  /** "seen" on landing notices, each sent to its own backend */
  seenLanding: async (ids: readonly string[]) => {
    const by = new Map<string, string[]>();
    for (const id of ids) {
      const [b, plain] = on(id);
      by.set(b, [...(by.get(b) ?? []), plain]);
    }
    await Promise.all([...by].map(([b, list]) => req<{ ok: true }>(b, "/api/landing/seen", { method: "POST", body: JSON.stringify({ ids: list }) })));
  },
  /** "fix it" on a sent-back branch: the run it starts */
  fixLanding: async (id: string) => {
    const [b, plain] = on(id);
    return from(b, await req<Run>(b, "/api/landing/fix", { method: "POST", body: JSON.stringify({ id: plain }) }), qRun);
  },
  /** gives a sent-back branch up, with its worktree */
  dropLanding: async (id: string) => {
    const [b, plain] = on(id);
    await req<{ ok: true }>(b, "/api/landing/drop", { method: "POST", body: JSON.stringify({ id: plain }) });
  },
  /** an orphaned run worktree on backend `b`: removed, or queued */
  orphanLanding: (b: string, dir: string, action: "remove" | "queue") =>
    req<{ ok: true }>(b, "/api/landing/orphan", { method: "POST", body: JSON.stringify({ dir, action }) }),
  /** `key`, sent to the home backend alone, makes a remembered rule good
   *  for agents in a terminal too (core/sessionrules.ts) */
  answerRun: async (id: string, promptId: string, answer: RunAnswer, key?: string | null) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Run>(b, "/api/runs/answer", {
        method: "POST",
        ...(key && b === homeName() && answer.kind === "allow" && answer.remember ? { headers: keyHeaders(key) } : {}),
        // the device, which a remembered rule keeps as who remembered it
        body: JSON.stringify({ id: plain, promptId, answer, client: clientId() }),
      }),
      qRun,
    );
  },
  /** a backend's remembered rules, which answer its runs' permissions */
  remembered: (b: string = homeName()) => req<{ rules: RememberedRule[] }>(b, "/api/remembered"),
  forgetRemembered: (b: string, id: string) =>
    req<{ rules: RememberedRule[] }>(b, "/api/remembered/forget", { method: "POST", body: JSON.stringify({ id }) }),
  stopRun: async (id: string) => {
    const [b, plain] = on(id);
    return from(b, await req<Run>(b, "/api/runs/stop", { method: "POST", body: JSON.stringify({ id: plain }) }), qRun);
  },
  /** the next message in a chat */
  say: async (id: string, text: string) => {
    const [b, plain] = on(id);
    return from(b, await req<Run>(b, "/api/runs/say", { method: "POST", body: JSON.stringify({ id: plain, text }) }), qRun);
  },
  dismissRun: (id: string) =>
    repoReq<{ ok: true }>(id, (p) => `/api/runs?${rq(p)}`, { method: "DELETE" }),
  /** edits or removes a coordinator's proposed card (FR-010); the run's
   *  broadcast carries the change, so the answer is not read */
  coordTask: async (runId: string, id: string, change: CoordEdit | { remove: true }) => {
    const [b, plain] = on(runId);
    const body = "remove" in change ? { run: plain, id, remove: true } : { run: plain, id, ...change, ...(change.repo !== undefined ? { repo: on(change.repo)[1] } : {}) };
    await req<{ ok: true }>(b, "/api/coordinator/tasks", { method: "POST", body: JSON.stringify(body) });
  },
  /** start these: every proposed card of a coordinator joins its queue */
  coordStart: async (runId: string) => {
    const [b, plain] = on(runId);
    await req<{ ok: true }>(b, "/api/coordinator/start", { method: "POST", body: JSON.stringify({ run: plain }) });
  },
  workflows: (id: string) => repoReq<WorkflowEntry[]>(id, (p) => `/api/repos/workflows?${rq(p)}`),
  /** `request` is the sheet's own id for this start, so sending it again
   *  after a lost answer finds the flow instead of starting another */
  startFlow: async (id: string, workflow: string, note: string, request?: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Flow>(b, `/api/repos/flow?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify({ workflow, note, ...(request ? { request } : {}) }),
      }),
      qFlow,
    );
  },
  flows: async (b: string = homeName()) => fromAll(b, await req<Flow[]>(b, "/api/flows"), qFlow),
  resumeFlow: async (id: string, choice: FlowChoice) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Flow>(b, "/api/flows/resume", {
        method: "POST",
        body: JSON.stringify({ id: plain, choice }),
      }),
      qFlow,
    );
  },
  stopFlow: async (id: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Flow>(b, "/api/flows/stop", {
        method: "POST",
        body: JSON.stringify({ id: plain }),
      }),
      qFlow,
    );
  },
  dismissFlow: (id: string) => repoReq<{ ok: true }>(id, (p) => `/api/flows?${rq(p)}`, { method: "DELETE" }),
  verdict: (b: string = homeName()) => req<{ ready: boolean }>(b, "/api/verdict"),
  /** which canopy the server is, and where and since when it runs */
  about: (b: string = homeName()) => req<About>(b, "/api/about"),
  /** what the backend knows of this browser, and the helpers dialled in */
  client: (b: string = homeName()) => req<ClientInfo>(b, "/api/client"),
  helpers: (b: string = homeName()) => req<HelperInfo[]>(b, "/api/helpers"),
  /** the browsers on the event stream now */
  devices: async (b: string = homeName()) => fromAll(b, await req<Device[]>(b, "/api/devices"), qDevice),
  fleets: async (b: string = homeName()) => fromAll(b, await req<Fleet[]>(b, "/api/fleets"), qFleet),
  /** one fleet per backend the repos are on, in registry order. One backend
   *  (always true with a single-backend registry): its answer, or its error,
   *  as it always was. Several: every request goes regardless of the
   *  others' outcome (`allSettled`, not `all`), so one backend failing does
   *  not cost what the others started; a failure is thrown as a
   *  `PartialFleetError` naming each failed backend and carrying the fleets
   *  that did start, once every backend has been heard from. `request`
   *  works as it does for `startFlow`, on each backend. */
  startFleet: async (workflow: string, ids: string[], note: string, request?: string): Promise<Fleet[]> => {
    const groups = byBackend(ids);
    const body = (plain: string[]) => JSON.stringify({ workflow, ids: plain, note, ...(request ? { request } : {}) });
    const one = groups.length === 1 ? groups[0] : undefined;
    if (one) {
      const [b, plain] = one;
      const fleet = await req<Fleet>(b, "/api/fleet", {
        method: "POST",
        body: body(plain),
      });
      return [from(b, fleet, qFleet)];
    }
    const results = await Promise.allSettled(
      groups.map(async ([b, plain]) => {
        try {
          return from(
            b,
            await req<Fleet>(b, "/api/fleet", {
              method: "POST",
              body: body(plain),
            }),
            qFleet,
          );
        } catch (err) {
          throw new Error(`${b}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    const started: Fleet[] = [];
    const failed: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") started.push(r.value);
      else failed.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
    if (failed.length > 0) throw new PartialFleetError(`no fleet started: ${failed.join("; ")}`, started);
    return started;
  },
  stopFleet: async (id: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Fleet>(b, "/api/fleet/stop", {
        method: "POST",
        body: JSON.stringify({ id: plain }),
      }),
      qFleet,
    );
  },
  dismissFleet: (id: string) => repoReq<{ ok: true }>(id, (p) => `/api/fleet?${rq(p)}`, { method: "DELETE" }),
  /* the in-app browser: what listens on the backend, and a preview port for one */
  ports: async (b: string = homeName()): Promise<PortsResult> => {
    const r = await req<PortsResult>(b, "/api/ports");
    return { ...r, ports: r.ports.map((p) => (p.repo === undefined ? p : { ...p, repo: qual(b, p.repo) })) };
  },
  preview: (port: number, b: string = homeName()) =>
    req<PreviewSlot>(b, "/api/preview", {
      method: "POST",
      body: JSON.stringify({ port }),
    }),
  /* the launcher: releases, pull requests and builds of one repo */
  releases: (id: string) => repoReq<Release[]>(id, (p) => `/api/repos/releases?${rq(p)}`),
  pulls: (id: string) => repoReq<Pull[]>(id, (p) => `/api/repos/pulls?${rq(p)}`),
  builds: (id: string) => repoReq<Build[]>(id, (p) => `/api/repos/builds?${rq(p)}`),
  /** downloads and unpacks one release's asset; `asset` overrides the pick */
  install: async (id: string, tag: string, asset?: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Job>(b, `/api/repos/install?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify({ tag, ...(asset ? { asset } : {}) }),
      }),
      qJob,
    );
  },
  /** checks a pull request out and builds it, or builds the checkout itself */
  build: async (id: string, pr?: number) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Job>(b, `/api/repos/build?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify(pr === undefined ? {} : { pr }),
      }),
      qJob,
    );
  },
  launch: (id: string, build: string) =>
    repoReq<Build>(id, (p) => `/api/repos/launch?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify({ build }),
    }),
  /** ends the process a launch started, when canopy still holds it */
  halt: (id: string, build: string) =>
    repoReq<{ ok: true; stopped: boolean }>(id, (p) => `/api/repos/halt?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify({ build }),
    }),
  uninstall: (id: string, build: string) =>
    repoReq<{ ok: true }>(id, (p) => `/api/repos/uninstall?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify({ build }),
    }),
  /** every repo's launch settings, keyed by repo path */
  launchers: (b: string = homeName()) => req<Record<string, LaunchSettings>>(b, "/api/launchers"),
  setLaunch: (id: string, settings: LaunchSettings) =>
    repoReq<Record<string, LaunchSettings>>(id, (p) => `/api/repos/launcher?${rq(p)}`, {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  tasks: async (id: string) => {
    const [b, plain] = on(id);
    const r = await req<TasksResult>(b, `/api/repos/tasks?${rq(plain)}`);
    return { ...r, tasks: fromAll(b, r.tasks, qTask) };
  },
  taskAct: async (id: string, action: TaskAction, name?: string, reason?: string) => {
    const [b, plain] = on(id);
    const r = await req<TasksResult>(b, `/api/repos/tasks?${rq(plain)}`, {
      method: "POST",
      body: JSON.stringify({ action, ...(name ? { name } : {}), ...(reason ? { reason } : {}) }),
    });
    return { ...r, tasks: fromAll(b, r.tasks, qTask) };
  },
  taskDef: async (id: string, name: string, def: TaskPatch | null, target: "canopy" | "repo") => {
    const [b, plain] = on(id);
    const r = await req<TasksResult>(b, `/api/repos/tasks/def?${rq(plain)}`, { method: "POST", body: JSON.stringify({ name, def, target }) });
    return { ...r, tasks: fromAll(b, r.tasks, qTask) };
  },
  /** a repo's checks, its file's and canopy's merged, with its file's errors */
  repoHealth: (id: string) => repoReq<RepoHealthInfo>(id, (p) => `/api/repos/health?${rq(p)}`),
  /** stores a check in canopy's layer for the repo, by its name */
  saveRepoCheck: (id: string, check: RepoCheckDef) =>
    repoReq<RepoHealthInfo>(id, (p) => `/api/repos/health?${rq(p)}`, { method: "POST", body: JSON.stringify(check) }),
  removeRepoCheck: (id: string, name: string) => repoReq<RepoHealthInfo>(id, (p) => `/api/repos/health?${rq(p, { name })}`, { method: "DELETE" }),
  taskLog: (id: string, name: string, q = "", before?: number) =>
    repoReq<TaskLogPage>(id, (p) => `/api/repos/tasks/log?${rq(p, { name, q, ...(before ? { before: String(before) } : {}) })}`),
  allTasks: async (b: string = homeName()) => fromAll(b, await req<TaskInfo[]>(b, "/api/tasks"), qTask),
  jobs: async (b: string = homeName()) => fromAll(b, await req<Job[]>(b, "/api/jobs"), qJob),
  stopJob: async (id: string) => {
    const [b, plain] = on(id);
    return from(b, await req<Job>(b, "/api/jobs/stop", { method: "POST", body: JSON.stringify({ id: plain }) }), qJob);
  },
  dismissJob: (id: string) => repoReq<{ ok: true }>(id, (p) => `/api/jobs?${rq(p)}`, { method: "DELETE" }),
  /** self, the configured peers, who was last seen reachable, and the mode */
  peers: (b: string = homeName()) =>
    req<{ self: string | null; peers: Peer[]; seen: PeerSeen[]; sync: PeerSync }>(b, "/api/peers"),
  /** one repo's peer action: take a peer's WIP, track a peer-only branch,
   *  sync just this repo, or seed the allow-listed files into it */
  peerAction: async (id: string, body: { action: "take" | "track" | "sync" | "seed"; peer?: string; branch?: string }) => {
    const [b, plain] = on(id);
    const got = await req<Repo & { take?: { how: string; branch?: string } }>(b, `/api/repos/peer?${rq(plain)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return from(b, got, (q, r) => ({ ...qRepo(q, r), ...(r.take === undefined ? {} : { take: r.take }) }));
  },
  /** starts one peer pass over every repo on a backend; it answers before
   *  the pass ends, and the repos it moves come back as events */
  peersSync: (b: string = homeName()) => req<Record<string, never>>(b, "/api/peers/sync", { method: "POST" }),
  /** `canopy spec sync`: writes the shared spec's blocks into a checkout;
   *  halves null keeps what the repo took before */
  specSync: async (id: string, halves: SpecHalf[] | null) => {
    const [b, plain] = on(id);
    const got = await req<{ written: string[]; removed?: string[]; version: string; halves: SpecHalf[]; repo: Repo }>(b, `/api/repos/spec?${rq(plain)}`, {
      method: "POST",
      body: JSON.stringify(halves === null ? {} : { halves }),
    });
    return { ...got, repo: from(b, got.repo, qRepo) };
  },
  /** archives a repo in canopy, or takes the mark off; answers the repo */
  archive: async (id: string, archived: boolean) => {
    const [b, plain] = on(id);
    const got = await req<Repo>(b, `/api/repos/archive?${rq(plain)}`, {
      method: "POST",
      body: JSON.stringify({ archived }),
    });
    return from(b, got, qRepo);
  },
  /** stars a repo in canopy, or takes the star off; answers the repo */
  favorite: async (id: string, favorite: boolean) => {
    const [b, plain] = on(id);
    const got = await req<Repo>(b, `/api/repos/favorite?${rq(plain)}`, {
      method: "POST",
      body: JSON.stringify({ favorite }),
    });
    return from(b, got, qRepo);
  },
  /** marks a repo as the harness, or takes the mark off; answers the repo */
  harness: async (id: string, harness: boolean) => {
    const [b, plain] = on(id);
    const got = await req<Repo>(b, `/api/repos/harness?${rq(plain)}`, {
      method: "POST",
      body: JSON.stringify({ harness }),
    });
    return from(b, got, qRepo);
  },
  /** the backends this page may talk to, as its home backend's config names them */
  backends: () => req<{ self: string | null; backends: BackendEntry[] }>(homeName(), "/api/backends"),
  workspaces: () => req<Workspace[]>(homeName(), "/api/workspaces"),
  wsAdd: (name: string, repos: string[]) =>
    req<Workspace[]>(homeName(), "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, repos }),
    }),
  wsRemove: (name: string, repo?: string) =>
    req<Workspace[]>(homeName(), "/api/workspaces", {
      method: "DELETE",
      body: JSON.stringify({ name, repo }),
    }),
  wsOpen: (name: string, app: string, helper?: string) =>
    req<{ ok: true }>(homeName(), "/api/workspaces/open", {
      method: "POST",
      body: JSON.stringify({ name, app, helper }),
    }),
  /** sets or clears (null) a workspace's primary, a repo id, and its color;
   *  what is absent stays as it was */
  wsLook: (name: string, look: { primary?: string | null; color?: WsColor | null }) =>
    req<Workspace[]>(homeName(), "/api/workspaces", {
      method: "PATCH",
      body: JSON.stringify({ name, ...look }),
    }),
  /** a run on the workspace's primary that sees the other members too */
  wsRun: (name: string, action: RunAction, note: string) =>
    req<Run>(homeName(), "/api/workspaces/run", {
      method: "POST",
      body: JSON.stringify({ name, action, note, client: clientId() }),
    }),
  /** the screen layout profiles, kept on the home backend: the presets,
   *  changed ones as changed, then the user's own */
  layouts: () => req<{ profiles: ScreenProfile[] }>(homeName(), "/api/layouts"),
  /** a new profile of the user's own, or (`from`) a copy of any profile */
  layoutCreate: (what: { profile: ProfileFields } | { from: string }) =>
    req<{ profile: ScreenProfile; profiles: ScreenProfile[] }>(homeName(), "/api/layouts", { method: "POST", body: JSON.stringify(what) }),
  /** a profile changed; a preset's change is kept beside it, for a reset */
  layoutUpdate: (id: string, profile: ProfileFields) =>
    req<{ profile: ScreenProfile; profiles: ScreenProfile[] }>(homeName(), `/api/layouts?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ profile }),
    }),
  layoutDelete: (id: string) => req<{ profiles: ScreenProfile[] }>(homeName(), `/api/layouts?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  layoutReset: (id: string) => req<{ profiles: ScreenProfile[] }>(homeName(), `/api/layouts/reset?id=${encodeURIComponent(id)}`, { method: "POST" }),
};

/** Which base URL a backend is reached at from this page: its first pick,
 *  or the fallback when the first does not answer within three seconds;
 *  null when it has no URL this page can use. */
export async function resolveBase(
  entry: BackendEntry,
  pageOrigin: string,
  entries: readonly BackendEntry[],
): Promise<string | null> {
  const { first, fallback } = pickUrl(pageOrigin, entry, entries);
  if (!first) return null;
  if (!fallback) return first;
  try {
    await fetch(`${first}/api/about`, { credentials: "include", signal: AbortSignal.timeout(3000) });
    return first;
  } catch {
    return fallback;
  }
}

/** One frame off a backend's stream, its ids under the backend's name;
 *  null for one that is not an event. */
export function readFrame(b: string, data: string): ServerEvent | null {
  let ev: ServerEvent;
  try {
    ev = JSON.parse(data) as ServerEvent;
  } catch {
    return null;
  }
  if (ev === null || typeof ev !== "object") return null;
  return from(b, ev, qEvent);
}

/** The websocket URL for a path on a backend. */
export function socketUrl(b: string, path: string): string {
  const base = baseOf(b);
  // only home reads the page's own host, and only a browser has one
  const page = base || typeof location === "undefined" ? { protocol: "http:", host: "" } : location;
  return wsUrl(base, page, path);
}

/** How long an open stream may go without a frame before the page takes it
 *  for dead. The server pings every 25s, so this is two missed pings and
 *  some slack. */
export const STREAM_STALE = 70_000;
const STREAM_CHECK = 15_000;
const RETRY_FIRST = 1_000;
const RETRY_MAX = 30_000;

/** EventSource's readyState values, spelled out since the class may not
 *  exist where this module is imported (tests). */
const CONNECTING = 0;
const OPEN = 1;

/** What to do about the stream on a watchdog tick or when the tab shows
 *  again. An open stream that has gone quiet is half-open (a phone asleep,
 *  a proxy that dropped it without a close), and the browser will never
 *  notice on its own: `recycle` closes it and opens another. A closed one
 *  is a stream the browser gave up on (a reconnect answered by something
 *  other than the stream, like a login page), which it will not retry:
 *  `reopen`, unless a retry is already waiting. A connecting one is the
 *  browser's own retry at work. Pure, for the test. */
export function streamAction(
  readyState: number,
  lastSeen: number,
  now: number,
  retryPending: boolean,
): "keep" | "recycle" | "reopen" {
  if (readyState === CONNECTING) return "keep";
  if (readyState === OPEN) return now - lastSeen > STREAM_STALE ? "recycle" : "keep";
  return retryPending ? "keep" : "reopen";
}

export function subscribe(
  b: string,
  onEvent: (ev: ServerEvent) => void,
  /** called when the stream comes back after a drop — the server replays
   *  nothing, so everything that changed during the gap must be refetched */
  onReconnect?: () => void,
  /** who this browser is, for the devices list; none for an anonymous stream */
  who: Record<string, string> = {},
): () => void {
  const q = new URLSearchParams(who).toString();
  const base = baseOf(b);
  const url = base + (q ? `/api/events?${q}` : "/api/events");
  let everOpened = false;
  let stopped = false;
  let lastSeen = Date.now();
  let retry: ReturnType<typeof setTimeout> | null = null;
  let wait = RETRY_FIRST;
  let es = open();

  function open(): EventSource {
    // another origin: the gate's cookie has to ride along
    const s = new EventSource(url, { withCredentials: base !== "" });
    lastSeen = Date.now();
    s.onopen = () => {
      signal(b, { kind: "stream-open" });
      lastSeen = Date.now();
      wait = RETRY_FIRST;
      if (everOpened) onReconnect?.();
      everOpened = true;
    };
    s.onmessage = (m) => {
      lastSeen = Date.now();
      try {
        const ev = readFrame(b, m.data as string);
        if (ev) onEvent(ev);
      } catch {
        // ignore malformed frames
      }
    };
    s.addEventListener("ping", () => {
      lastSeen = Date.now();
    });
    // The browser retries a dropped stream by itself and only gives up
    // (readyState CLOSED) on an answer that is not one; from there on the
    // retries are ours, at doubling waits.
    s.onerror = () => {
      signal(b, { kind: "stream-lost" });
      if (s.readyState !== CONNECTING && s === es) schedule();
    };
    return s;
  }

  function schedule(): void {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      replace();
    }, wait);
    wait = Math.min(wait * 2, RETRY_MAX);
  }

  function replace(): void {
    if (stopped) return;
    es.close();
    es = open();
  }

  function check(): void {
    if (stopped) return;
    const act = streamAction(es.readyState, lastSeen, Date.now(), retry !== null);
    if (act === "recycle") replace();
    else if (act === "reopen") schedule();
  }

  const watchdog = setInterval(check, STREAM_CHECK);
  // A backgrounded tab's timers are throttled or frozen, so the watchdog may
  // not have run for hours when the page shows again; look at once.
  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  return () => {
    stopped = true;
    clearInterval(watchdog);
    if (retry) clearTimeout(retry);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    es.close();
  };
}

/** where a tailchan file downloads from, through the backend */
export const chanBlobUrl = (id: string): string => `/api/tailchan/blob?id=${encodeURIComponent(id)}`;
