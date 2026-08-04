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
import { isOpenerId, openGroup, openIn } from "../core/openers";
import { refreshRepo, scan } from "../core/scan";
import {
  loadConfig,
  rememberRoot,
  removeWorkspace,
  upsertWorkspace,
} from "../core/store";
import { suggestMessage } from "../core/suggest";
import type { CanopyConfig, Repo, ScanResult, ServerEvent } from "../core/types";
import { DEFAULT_IGNORE } from "../core/scan";

interface ServerState {
  root: string;
  result: ScanResult;
  /** directory names the scan and the watcher both skip */
  ignore: string[];
  /** .git locations already rescanned for; stops repos that the scan cannot
   *  reach (deeper than maxDepth) from triggering a rescan on every write */
  probed: Set<string>;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  watcher: FSWatcher | null;
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
    clients: new Set(),
    timers: new Map(),
    watcher: null,
  };
  startWatcher(state);
  await rememberRoot(root);

  const webDir = join(import.meta.dir, "../../dist/web");
  const server = Bun.serve({
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
          const status = err instanceof HttpError ? err.status : 500;
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
  });

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
