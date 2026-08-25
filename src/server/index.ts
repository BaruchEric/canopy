import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import {
  commit,
  getDiff,
  getLog,
  pull,
  push,
  stageFile,
} from "../core/git";
import { githubLogin, pushAccess } from "../core/access";
import {
  HistoryError,
  historyOverview,
  historySearch,
  historySession,
  historySessions,
  locateHistory,
  openHistoryNote,
} from "../core/history";
import { isOpenerId, openGroup, openIn } from "../core/openers";
import { refreshRepo, scan } from "../core/scan";
import {
  loadConfig,
  rememberRoot,
  removeWorkspace,
  upsertWorkspace,
} from "../core/store";
import { Runner } from "../core/runner";
import { suggestMessage } from "../core/suggest";
import {
  HISTORY_WINDOWS,
  RUN_ACTIONS,
  type CanopyConfig,
  type HistoryOverview,
  type HistoryWindow,
  type Repo,
  type RunAction,
  type RunAnswer,
  type ScanResult,
  type ServerEvent,
} from "../core/types";
import { DEFAULT_IGNORE } from "../core/scan";

interface ServerState {
  root: string;
  result: ScanResult;
  /** directory names the scan and the watcher both skip */
  ignore: string[];
  /** .git locations already rescanned for; stops repos that the scan cannot
   *  reach (deeper than maxDepth) from triggering a rescan on every write */
  probed: Set<string>;
  /** GitHub identity, resolved once: undefined = not asked yet, null = no gh */
  login?: string | null;
  /** push permission memo, keyed "owner/name" — see core/access */
  access: Map<string, boolean | null>;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  watcher: FSWatcher | null;
  /** Claude Code jobs, one live session per repo at most */
  runner: Runner;
  /** the claude-history overview, kept for HISTORY_TTL and for one scan */
  history: HistoryCache | null;
  /** an overview being built, so concurrent callers share it */
  historyPending: Promise<HistoryCache> | null;
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

/** Scan options from config — DEFAULT_IGNORE plus whatever the user added. */
function scanOpts(cfg: CanopyConfig): { maxDepth: number; ignore: string[] } {
  return {
    maxDepth: cfg.maxDepth,
    ignore: [...DEFAULT_IGNORE, ...cfg.ignore],
  };
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
    }
  }
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
  const fresh = await refreshRepo(state.root, repo);
  // Re-find after the await: a concurrent rescan may have replaced the array,
  // and writing back a pre-await index would land in the wrong slot.
  const idx = state.result.repos.findIndex((r) => r.id === id);
  if (idx !== -1) state.result.repos[idx] = fresh;
  broadcast(state, { type: "repo", repo: fresh });
  return fresh;
}

const WATCH_GIT_HINTS = ["HEAD", "index", "ORIG_HEAD", "refs"];

/** Key for the debounce timer of a whole-tree rescan (no repo owns it). */
const RESCAN_KEY = "\0rescan";

function scheduleRescan(state: ServerState): void {
  clearTimeout(state.timers.get(RESCAN_KEY));
  state.timers.set(
    RESCAN_KEY,
    setTimeout(() => {
      state.timers.delete(RESCAN_KEY);
      void (async () => {
        try {
          const cfg = await loadConfig();
          const opts = scanOpts(cfg);
          state.ignore = opts.ignore;
          state.result = await scan(state.root, opts);
          broadcast(state, { type: "scan", result: state.result });
        } catch {
          // a rescan that fails leaves the previous tree in place
        }
      })();
    }, 1_000),
  );
}

function startWatcher(state: ServerState): void {
  try {
    state.watcher = watch(
      state.root,
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
        // longest repo id that prefixes the changed path
        let match: string | null = null;
        for (const r of state.result.repos) {
          if (r.id === "." || filename === r.id || filename.startsWith(r.id + "/")) {
            if (!match || r.id.length > match.length) match = r.id;
          }
        }
        if (!match) {
          // A .git appearing outside every known repo means a new clone or
          // init — only a rescan can pick it up. Try each location once: if
          // the rescan does find it, later events match a repo id instead.
          const owner = parts.slice(0, gitIdx).join("/");
          if (gitIdx !== -1 && !state.probed.has(owner)) {
            state.probed.add(owner);
            scheduleRescan(state);
          }
          return;
        }
        const id = match;
        clearTimeout(state.timers.get(id));
        state.timers.set(
          id,
          setTimeout(() => {
            state.timers.delete(id);
            refreshAndBroadcast(state, id).catch(() => {});
          }, 400),
        );
      },
    );
  } catch (err) {
    console.error("watcher unavailable:", err);
  }
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

async function handleApi(
  state: ServerState,
  req: Request,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/tree" && method === "GET") return json(state.result);

  if (path === "/api/rescan" && method === "POST") {
    const cfg = await loadConfig();
    const opts = scanOpts(cfg);
    state.ignore = opts.ignore;
    state.result = await scan(state.root, opts);
    broadcast(state, { type: "scan", result: state.result });
    return json(state.result);
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

  if (path === "/api/workspaces" && method === "GET") {
    return json((await loadConfig()).workspaces);
  }
  // workspace membership arrives as repo ids; stored as absolute paths.
  // An unknown id is a client bug — never store it as if it were a path.
  const idToPath = (id: string): string => repoById(state, id).path;
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
    const b = (await req.json()) as { name: string; app: string };
    if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
    const cfg = await loadConfig();
    const ws = cfg.workspaces.find((w) => w.name === b.name);
    if (!ws) return json({ error: "unknown workspace" }, 404);
    await openGroup(b.app, b.name, ws.repos);
    return json({ ok: true });
  }

  // /api/repos/<action>?id=<repo id> — the id rides in the query string
  // because it can be "." (the scan root itself), and a "." path segment is
  // normalized away before the request ever reaches us.
  const m = /^\/api\/repos\/([a-z]+)$/.exec(path);
  if (m) {
    const repo = repoById(state, url.searchParams.get("id") ?? "");
    const action = m[1];

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
    if (method === "GET" && action === "diff") {
      const file = url.searchParams.get("file") ?? "";
      const staged = url.searchParams.get("staged") === "1";
      const untracked = url.searchParams.get("untracked") === "1";
      const diff = await getDiff(repo.path, file, { staged, untracked });
      return json({ diff });
    }
    if (method === "POST" && action === "stage") {
      const b = (await req.json()) as { file: string; unstage?: boolean };
      await stageFile(repo.path, b.file, b.unstage ?? false);
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
      const b = (await req.json()) as { app: string };
      if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
      await openIn(b.app, repo.path);
      return json({ ok: true });
    }
    if (method === "POST" && action === "refresh") {
      return json(await refreshAndBroadcast(state, repo.id));
    }
    if (method === "POST" && action === "run") {
      const b = (await req.json()) as { action?: unknown; note?: unknown };
      if (!isRunAction(b.action)) return json({ error: "unknown action" }, 400);
      const note = typeof b.note === "string" ? b.note : "";
      return json(state.runner.start(repo, b.action, note), 201);
    }
  }
  return json({ error: "not found" }, 404);
}

function sse(state: ServerState): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      state.clients.add(c);
      c.enqueue(enc.encode(`: hello\n\n`));
    },
    cancel() {
      state.clients.delete(ctrl);
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
}): Promise<{ port: number; stop: () => void }> {
  const cfg = await loadConfig();
  const root = resolve(opts.root);
  const port = opts.port ?? cfg.port;
  const scanOptions = scanOpts(cfg);
  const result = await scan(root, scanOptions);
  const state: ServerState = {
    root,
    result,
    ignore: scanOptions.ignore,
    probed: new Set(),
    access: new Map(),
    clients: new Set(),
    timers: new Map(),
    watcher: null,
    history: null,
    historyPending: null,
    runner: new Runner({
      onChange: (run) => broadcast(state, { type: "run", run }),
      onGone: (id) => broadcast(state, { type: "run-gone", id }),
      // Re-read status directly rather than waiting on the watcher's
      // debounce: the card and the run's outcome should agree at once.
      status: (repoId) =>
        refreshAndBroadcast(state, repoId)
          .then((r) => r.status)
          .catch(() => null),
    }),
  };
  await rememberRoot(root);

  const webDir = join(import.meta.dir, "../../dist/web");
  const server = bind(port, () =>
    Bun.serve({
      port,
      // Loopback only: every mutating git route here is unauthenticated.
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/events") return sse(state);
        if (url.pathname.startsWith("/api/")) {
          try {
            return await handleApi(state, req, url);
          } catch (err) {
            const status =
              err instanceof HttpError || err instanceof HistoryError
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
      },
    }),
  );
  // Only after the bind succeeds: a watcher started earlier would outlive a
  // failed listen and hold the process open.
  startWatcher(state);

  const heartbeat = setInterval(() => {
    for (const c of state.clients) {
      try {
        c.enqueue(enc.encode(`: ping\n\n`));
      } catch {
        state.clients.delete(c);
      }
    }
  }, 25_000);

  return {
    port: server.port ?? port,
    stop: () => {
      clearInterval(heartbeat);
      state.runner.stopAll();
      state.watcher?.close();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const { port } = await startServer({ root });
  console.log(`canopy server on http://127.0.0.1:${port} (root: ${root})`);
}
