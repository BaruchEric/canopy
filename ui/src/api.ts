import type {
  AgentActivity,
  AgentKind,
  About,
  AgentPick,
  AgentRole,
  AgentSession,
  AgentSettings,
  AgentTable,
  Harness,
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
import type { ProfileFields } from "../../src/core/screenlayouts";
import { pickUrl, split, wsUrl, type BackendSignal } from "./backends";
import { normalizeRoutes } from "../../src/core/route";
import { keyHeaders } from "./answerKey";
import {
  qDevice,
  qEvent,
  qFleet,
  qFlow,
  qGrep,
  qHistory,
  qJob,
  qKept,
  qRepo,
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
  // a GET with no Content-Type is a simple request: no preflight to another origin
  if (typeof init.body === "string" && init.headers === undefined) {
    opts.headers = { "Content-Type": "application/json" };
  }
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
  let body: (T & { error?: string; login?: unknown }) | undefined;
  try {
    body = JSON.parse(text) as T & { error?: string; login?: unknown };
  } catch {
    signal(b, { kind: "answered" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    throw new Error("unreadable response from canopy server");
  }
  if (r.status === 401 && typeof body.login === "string") {
    signal(b, { kind: "signin", login: body.login });
    throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  }
  signal(b, { kind: "answered" });
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
  diff: (id: string, file: string, staged: boolean, untracked: boolean) =>
    repoReq<{ diff: string }>(
      id,
      (p) =>
        `/api/repos/diff?${rq(p, {
          file,
          staged: staged ? "1" : "0",
          untracked: untracked ? "1" : "0",
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
  /** one repo's effective table, as its backend resolves it */
  resolveAgents: (id: string) => repoReq<AgentTable>(id, (p) => `/api/agents/resolve?${rq(p)}`),
  history: async (refresh = false, b: string = homeName()) =>
    from(b, await req<HistoryOverview>(b, refresh ? "/api/history?refresh=1" : "/api/history"), qHistory),
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
  /** the shells the server holds, attached or waiting for a browser */
  terms: async (b: string = homeName()) => fromAll(b, await req<TermInfo[]>(b, "/api/terms"), qTerm),
  /** the newest transcript of the agent in a shell, on the shell's own
   *  machine: the pane's agent when tmux can say, else `harness` */
  termTranscript: (id: string, harness?: Harness) =>
    repoReq<{ harness: Harness; path: string }>(id, (p) => `/api/terms/transcript?term=${encodeURIComponent(p)}${harness ? `&harness=${harness}` : ""}`),
  /** what a shell is running, asked of tmux: claude, codex or neither */
  termAgent: (id: string) =>
    repoReq<{ agent: AgentKind | null }>(id, (p) => `/api/terms/agent?term=${encodeURIComponent(p)}`),
  /** a shell's text as tmux holds it, for a copy; null text on a plain pty */
  termText: (id: string) =>
    repoReq<{ text: string | null; fullscreen: boolean }>(id, (p) => `/api/terms/text?term=${encodeURIComponent(p)}`),
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
  /** turns the recording on or off for this backend */
  setKeeping: (on: boolean, b: string = homeName()) =>
    req<{ keeping: boolean }>(b, "/api/keep", { method: "POST", body: JSON.stringify({ on }) }),
  /** tailchan: the broker's view as the UI's handle, or why it is off */
  tailchan: () => req<TailchanInfo>(homeName(), "/api/tailchan"),
  /** the agent registry, the home backend's alone; a 503 without a broker */
  registry: () => req<RegistryInfo>(homeName(), "/api/registry"),
  /** what a registry card's session did, read from its transcript by the
   *  backend `b` on the machine it ran on; a 404 when the file is not there */
  agentActivity: (b: string, harness: Harness, session: string, cwd: string) =>
    req<AgentActivity>(b, `/api/agents/activity?harness=${harness}&session=${encodeURIComponent(session)}&cwd=${encodeURIComponent(cwd)}`),
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
  run: async (id: string, action: RunAction, note: string, client?: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Run>(b, `/api/repos/run?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify({ action, note, client }),
      }),
      qRun,
    );
  },
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
  workflows: (id: string) => repoReq<WorkflowEntry[]>(id, (p) => `/api/repos/workflows?${rq(p)}`),
  startFlow: async (id: string, workflow: string, note: string) => {
    const [b, plain] = on(id);
    return from(
      b,
      await req<Flow>(b, `/api/repos/flow?${rq(plain)}`, {
        method: "POST",
        body: JSON.stringify({ workflow, note }),
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
   *  that did start, once every backend has been heard from. */
  startFleet: async (workflow: string, ids: string[], note: string): Promise<Fleet[]> => {
    const groups = byBackend(ids);
    const one = groups.length === 1 ? groups[0] : undefined;
    if (one) {
      const [b, plain] = one;
      const fleet = await req<Fleet>(b, "/api/fleet", {
        method: "POST",
        body: JSON.stringify({ workflow, ids: plain, note }),
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
              body: JSON.stringify({ workflow, ids: plain, note }),
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
    const got = await req<{ written: string[]; version: string; halves: SpecHalf[]; repo: Repo }>(b, `/api/repos/spec?${rq(plain)}`, {
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
