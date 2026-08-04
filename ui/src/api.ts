import type {
  LogEntry,
  Repo,
  ScanResult,
  ServerEvent,
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
  log: (id: string) => req<LogEntry[]>(`/api/repos/log?${rq(id)}`),
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
