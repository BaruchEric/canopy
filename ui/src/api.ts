import type {
  AgentSettings,
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
  LogEntry,
  Build,
  Pull,
  PushAccess,
  Release,
  Repo,
  Run,
  RunAction,
  RunAnswer,
  ScanResult,
  ServerEvent,
  SourceInput,
  SourceState,
  TermInfo,
  WorkflowEntry,
  Workspace,
} from "../../src/core/types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  // Parse defensively: a dead API or a proxy error page is not JSON, and
  // letting that SyntaxError escape would hide the real status.
  const text = await r.text();
  let body: (T & { error?: string }) | undefined;
  try {
    body = JSON.parse(text) as T & { error?: string };
  } catch {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    throw new Error("unreadable response from canopy server");
  }
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  return body;
}

/** Repo ids ride in the query string — an id can be "." and a "." path
 *  segment is normalized out of the URL before the request is sent. */
const rq = (id: string, extra: Record<string, string> = {}): string =>
  new URLSearchParams({ id, ...extra }).toString();

export const api = {
  tree: () => req<ScanResult>("/api/tree"),
  rescan: () => req<ScanResult>("/api/rescan", { method: "POST" }),
  sources: () => req<SourceState[]>("/api/sources"),
  addSource: (input: SourceInput) =>
    req<ScanResult>("/api/sources", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeSource: (id: string) =>
    req<ScanResult>(`/api/sources?${rq(id)}`, { method: "DELETE" }),
  rescanSource: (id: string) =>
    req<ScanResult>(`/api/sources/rescan?${rq(id)}`, {
      method: "POST",
      body: "{}",
    }),
  /** aliases from ~/.ssh/config, for the add-a-folder form */
  hosts: () => req<string[]>("/api/hosts"),
  /** one folder's subfolders, here or on a host, for the folder browser */
  browse: (path: string, host?: string) =>
    req<Listing>(
      `/api/browse?${new URLSearchParams({ path, ...(host ? { host } : {}) }).toString()}`,
    ),
  log: (id: string) => req<LogEntry[]>(`/api/repos/log?${rq(id)}`),
  show: (id: string, hash: string) =>
    req<CommitDetail>(`/api/repos/commit?${rq(id, { hash })}`),
  commitDiff: (id: string, hash: string, file: string, orig?: string) =>
    req<{ diff: string }>(
      `/api/repos/diff?${rq(id, {
        file,
        commit: hash,
        ...(orig === undefined ? {} : { orig }),
      })}`,
    ),
  access: (id: string) =>
    req<{ access: PushAccess }>(`/api/repos/access?${rq(id)}`),
  diff: (id: string, file: string, staged: boolean, untracked: boolean) =>
    req<{ diff: string }>(
      `/api/repos/diff?${rq(id, {
        file,
        staged: staged ? "1" : "0",
        untracked: untracked ? "1" : "0",
      })}`,
    ),
  stage: (id: string, file: string, unstage: boolean) =>
    req<Repo>(`/api/repos/stage?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ file, unstage }),
    }),
  commit: (id: string, message: string, stageAll: boolean) =>
    req<{ ok: true; out: string }>(`/api/repos/commit?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ message, stageAll }),
    }),
  push: (id: string) =>
    req<{ ok: true; out: string }>(`/api/repos/push?${rq(id)}`, {
      method: "POST",
      body: "{}",
    }),
  pull: (id: string) =>
    req<{ ok: true; out: string }>(`/api/repos/pull?${rq(id)}`, {
      method: "POST",
      body: "{}",
    }),
  suggest: (id: string) =>
    req<{ message: string; source: "ai" | "heuristic" }>(
      `/api/repos/suggest?${rq(id)}`,
      { method: "POST", body: "{}" },
    ),
  /** `tab` asks the terminal openers for a tab in the front window */
  /** `helper` names the `canopy helper` that opens it on this machine;
   *  without one the backend's own desktop does, when the browser is on it */
  open: (id: string, app: string, tab = false, helper?: string) =>
    req<{ ok: true }>(`/api/repos/open?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ app, tab, helper }),
    }),
  /** every repo's agent settings, keyed by repo path */
  agents: () => req<Record<string, AgentSettings>>("/api/agents"),
  setAgent: (id: string, settings: AgentSettings) =>
    req<Record<string, AgentSettings>>(`/api/repos/agent?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  history: (refresh = false) =>
    req<HistoryOverview>(refresh ? "/api/history?refresh=1" : "/api/history"),
  sessions: (id: string, since: HistoryWindow) =>
    req<HistorySession[]>(`/api/repos/sessions?${rq(id, { since })}`),
  session: (id: string, session: string) =>
    req<HistorySessionDetail>(`/api/repos/session?${rq(id, { session })}`),
  search: (id: string, q: string) =>
    req<HistoryHit[]>(`/api/repos/search?${rq(id, { q })}`),
  /** file contents of one repo, through git grep */
  grep: (id: string, q: string) =>
    req<GrepResult>(`/api/repos/grep?${rq(id, { q })}`),
  /** the same search across many repos, one row each in the order given */
  grepAll: (q: string, ids: string[]) =>
    req<GrepRepoResult[]>("/api/grep", { method: "POST", body: JSON.stringify({ q, ids }) }),
  /** opens one file of a repo at a line in VS Code */
  openFile: (id: string, file: string, line: number, helper?: string) =>
    req<{ ok: true }>(`/api/repos/openfile?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ file, line, helper }),
    }),
  openNote: (id: string, session: string) =>
    req<{ ok: true }>(`/api/repos/note?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ session }),
    }),
  /** the shells the server holds, attached or waiting for a browser */
  terms: () => req<TermInfo[]>("/api/terms"),
  /** ends one shell; closing its socket alone leaves it running */
  endTerm: (id: string) => req<{ ok: true }>(`/api/terms?term=${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** the shells a machine going down left behind, and whether the backend
   *  is recording them at all */
  kept: () => req<{ keeping: boolean; kept: KeptShell[] }>("/api/terms/kept"),
  /** starts a kept shell again under its own name; `resume` also runs the
   *  line that picks the agent's conversation back up */
  restoreShell: (id: string, resume: boolean, cols = 80, rows = 24) =>
    req<TermInfo>("/api/terms/restore", { method: "POST", body: JSON.stringify({ term: id, cols, rows, resume }) }),
  /** drops what a kept shell left, history and all */
  forgetShell: (id: string) => req<{ ok: true }>(`/api/terms/kept?term=${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** turns the recording on or off for this backend */
  setKeeping: (on: boolean) => req<{ keeping: boolean }>("/api/keep", { method: "POST", body: JSON.stringify({ on }) }),
  runs: () => req<Run[]>("/api/runs"),
  /** `client` is this browser's id, so the run says which device started it */
  run: (id: string, action: RunAction, note: string, client?: string) =>
    req<Run>(`/api/repos/run?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ action, note, client }),
    }),
  answerRun: (id: string, promptId: string, answer: RunAnswer) =>
    req<Run>("/api/runs/answer", {
      method: "POST",
      body: JSON.stringify({ id, promptId, answer }),
    }),
  stopRun: (id: string) =>
    req<Run>("/api/runs/stop", { method: "POST", body: JSON.stringify({ id }) }),
  /** the next message in a chat */
  say: (id: string, text: string) =>
    req<Run>("/api/runs/say", { method: "POST", body: JSON.stringify({ id, text }) }),
  dismissRun: (id: string) =>
    req<{ ok: true }>(`/api/runs?${rq(id)}`, { method: "DELETE" }),
  workflows: (id: string) => req<WorkflowEntry[]>(`/api/repos/workflows?${rq(id)}`),
  startFlow: (id: string, workflow: string, note: string) =>
    req<Flow>(`/api/repos/flow?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ workflow, note }),
    }),
  flows: () => req<Flow[]>("/api/flows"),
  resumeFlow: (id: string, choice: FlowChoice) =>
    req<Flow>("/api/flows/resume", {
      method: "POST",
      body: JSON.stringify({ id, choice }),
    }),
  stopFlow: (id: string) =>
    req<Flow>("/api/flows/stop", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  dismissFlow: (id: string) => req<{ ok: true }>(`/api/flows?${rq(id)}`, { method: "DELETE" }),
  verdict: () => req<{ ready: boolean }>("/api/verdict"),
  /** what the backend knows of this browser, and the helpers dialled in */
  client: () => req<ClientInfo>("/api/client"),
  helpers: () => req<HelperInfo[]>("/api/helpers"),
  /** the browsers on the event stream now */
  devices: () => req<Device[]>("/api/devices"),
  fleets: () => req<Fleet[]>("/api/fleets"),
  startFleet: (workflow: string, ids: string[], note: string) =>
    req<Fleet>("/api/fleet", {
      method: "POST",
      body: JSON.stringify({ workflow, ids, note }),
    }),
  stopFleet: (id: string) =>
    req<Fleet>("/api/fleet/stop", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  dismissFleet: (id: string) => req<{ ok: true }>(`/api/fleet?${rq(id)}`, { method: "DELETE" }),
  /* the launcher: releases, pull requests and builds of one repo */
  releases: (id: string) => req<Release[]>(`/api/repos/releases?${rq(id)}`),
  pulls: (id: string) => req<Pull[]>(`/api/repos/pulls?${rq(id)}`),
  builds: (id: string) => req<Build[]>(`/api/repos/builds?${rq(id)}`),
  /** downloads and unpacks one release's asset; `asset` overrides the pick */
  install: (id: string, tag: string, asset?: string) =>
    req<Job>(`/api/repos/install?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ tag, ...(asset ? { asset } : {}) }),
    }),
  /** checks a pull request out and builds it, or builds the checkout itself */
  build: (id: string, pr?: number) =>
    req<Job>(`/api/repos/build?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify(pr === undefined ? {} : { pr }),
    }),
  launch: (id: string, build: string) =>
    req<Build>(`/api/repos/launch?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ build }),
    }),
  /** ends the process a launch started, when canopy still holds it */
  halt: (id: string, build: string) =>
    req<{ ok: true; stopped: boolean }>(`/api/repos/halt?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ build }),
    }),
  uninstall: (id: string, build: string) =>
    req<{ ok: true }>(`/api/repos/uninstall?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ build }),
    }),
  /** every repo's launch settings, keyed by repo path */
  launchers: () => req<Record<string, LaunchSettings>>("/api/launchers"),
  setLaunch: (id: string, settings: LaunchSettings) =>
    req<Record<string, LaunchSettings>>(`/api/repos/launcher?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  jobs: () => req<Job[]>("/api/jobs"),
  stopJob: (id: string) => req<Job>("/api/jobs/stop", { method: "POST", body: JSON.stringify({ id }) }),
  dismissJob: (id: string) => req<{ ok: true }>(`/api/jobs?${rq(id)}`, { method: "DELETE" }),
  workspaces: () => req<Workspace[]>("/api/workspaces"),
  wsAdd: (name: string, repos: string[]) =>
    req<Workspace[]>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, repos }),
    }),
  wsRemove: (name: string, repo?: string) =>
    req<Workspace[]>("/api/workspaces", {
      method: "DELETE",
      body: JSON.stringify({ name, repo }),
    }),
  wsOpen: (name: string, app: string, helper?: string) =>
    req<{ ok: true }>("/api/workspaces/open", {
      method: "POST",
      body: JSON.stringify({ name, app, helper }),
    }),
};

export function subscribe(
  onEvent: (ev: ServerEvent) => void,
  /** called when the stream comes back after a drop — the server replays
   *  nothing, so everything that changed during the gap must be refetched */
  onReconnect?: () => void,
  /** who this browser is, for the devices list; none for an anonymous stream */
  who: Record<string, string> = {},
): () => void {
  const q = new URLSearchParams(who).toString();
  const es = new EventSource(q ? `/api/events?${q}` : "/api/events");
  let everOpened = false;
  es.onopen = () => {
    if (everOpened) onReconnect?.();
    everOpened = true;
  };
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data as string) as ServerEvent);
    } catch {
      // ignore malformed frames
    }
  };
  return () => es.close();
}
