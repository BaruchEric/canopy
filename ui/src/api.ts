import type {
  AgentSettings,
  CommitDetail,
  HistoryHit,
  HistoryOverview,
  HistorySession,
  HistorySessionDetail,
  HistoryWindow,
  Listing,
  LogEntry,
  PushAccess,
  Repo,
  Run,
  RunAction,
  RunAnswer,
  ScanResult,
  ServerEvent,
  SourceInput,
  SourceState,
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
  open: (id: string, app: string) =>
    req<{ ok: true }>(`/api/repos/open?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ app }),
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
  openNote: (id: string, session: string) =>
    req<{ ok: true }>(`/api/repos/note?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ session }),
    }),
  runs: () => req<Run[]>("/api/runs"),
  run: (id: string, action: RunAction, note: string) =>
    req<Run>(`/api/repos/run?${rq(id)}`, {
      method: "POST",
      body: JSON.stringify({ action, note }),
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
  wsOpen: (name: string, app: string) =>
    req<{ ok: true }>("/api/workspaces/open", {
      method: "POST",
      body: JSON.stringify({ name, app }),
    }),
};

export function subscribe(
  onEvent: (ev: ServerEvent) => void,
  /** called when the stream comes back after a drop — the server replays
   *  nothing, so everything that changed during the gap must be refetched */
  onReconnect?: () => void,
): () => void {
  const es = new EventSource("/api/events");
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
