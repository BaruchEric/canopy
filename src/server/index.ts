import { ACTIONS } from "../core/actions";
import { Library } from "../core/library";
import { watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  commit,
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
import { browseLocal, browseRemote, expandHome, SshError } from "../core/browse";
import { exec, onHost } from "../core/exec";
import { Flows, type CheckResult } from "../core/flow";
import { parseTermMessage, startTerm, termSize, type TermSession } from "../core/term";
import { apiBase, ForgeAuthError, linkForgeClones, listForgeRepos } from "../core/forge";
import { isSshHost, parseLocator, parseSshHosts, shellQuote, tildeQuote } from "../core/host";
import { hasGatewayKey, jev } from "../core/jev";
import { normalizeAgent } from "../core/agent";
import { isOpenerId, openFile, openGroup, openIn } from "../core/openers";
import { mapPool, searchRepo } from "../core/search";
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
  loadConfig,
  rememberRoot,
  removeSource,
  removeWorkspace,
  setAgent,
  upsertWorkspace,
} from "../core/store";
import { Runner } from "../core/runner";
import { suggestMessage } from "../core/suggest";
import {
  HISTORY_WINDOWS,
  RUN_ACTIONS,
  type CanopyConfig,
  type FlowChoice,
  type GrepRepoResult,
  type HistoryOverview,
  type HistoryWindow,
  type Repo,
  type RunAction,
  type RunAnswer,
  type ScanResult,
  type ServerEvent,
  type Source,
  type SourceInput,
  type SourceState,
} from "../core/types";
import { DEFAULT_IGNORE } from "../core/scan";

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
  /** every source, the launch root first */
  sources: SourceRuntime[];
  /** all sources' repos in one tree, rebuilt after any source scan */
  result: ScanResult;
  /** directory names the scan and the watcher both skip */
  ignore: string[];
  /** GitHub identity, resolved once: undefined = not asked yet, null = no gh */
  login?: string | null;
  /** push permission memo, keyed "owner/name" — see core/access */
  access: Map<string, boolean | null>;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Claude Code jobs, one live session per repo at most */
  runner: Runner;
  /** workflow runs, step by step, over the runner's jobs */
  flows: Flows;
  /** the claude-history overview, kept for HISTORY_TTL and for one scan */
  history: HistoryCache | null;
  /** an overview being built, so concurrent callers share it */
  historyPending: Promise<HistoryCache> | null;
  /** the shells open in browser terminals, ended with the server */
  terms: Set<TermSession>;
}

/** what a terminal websocket carries from the upgrade to its handlers */
interface TermSocket {
  repo: Repo;
  cols: number;
  rows: number;
  session?: TermSession;
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

/** Scan options from config — DEFAULT_IGNORE plus whatever the user added. */
function scanOpts(cfg: CanopyConfig): Required<ScanOptions> {
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
  const fresh = await refreshRepo(repo);
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

const bySource = (order: string[]) => (a: Repo, b: Repo): number =>
  order.indexOf(a.source) - order.indexOf(b.source) || a.id.localeCompare(b.id);

/** The tree the clients see, rebuilt from the sources after any change. */
function rebuildResult(state: ServerState, repos: Repo[]): void {
  const order = state.sources.map((rt) => rt.src.id);
  state.result = {
    root: state.root,
    sources: state.sources.map((rt) => ({ ...rt.src })),
    // Which forge repos are already cloned here can only be told once every
    // source is in the same list, so it is settled on the way out.
    repos: linkForgeClones([...repos].sort(bySource(order))),
    scannedAt: Date.now(),
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
  const opts = scanOpts(cfg);
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
          const opts = scanOpts(cfg);
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
        const id = match.id;
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
    const opts = scanOpts(await loadConfig());
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
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/tree" && method === "GET") return json(state.result);

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
    const opts = scanOpts(await loadConfig());
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
    const opts = scanOpts(await loadConfig());
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

  if (path === "/api/verdict" && method === "GET") return json({ ready: hasGatewayKey() });

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
    const cfg = await loadConfig();
    const note = typeof b.note === "string" ? b.note : "";
    return json(state.flows.startFleet(repos, wf, note, (r) => agentFor(cfg, r.path)), 201);
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
  if (path === "/api/agents" && method === "GET") {
    return json((await loadConfig()).agents);
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
    const b = (await req.json()) as { name: string; app: string };
    if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
    const cfg = await loadConfig();
    const ws = cfg.workspaces.find((w) => w.name === b.name);
    if (!ws) return json({ error: "unknown workspace" }, 404);
    await openGroup(b.app, b.name, ws.repos, (p) => agentFor(cfg, p));
    return json({ ok: true });
  }

  // /api/repos/<action>?id=<repo id> — the id rides in the query string
  // because it can be "." (the scan root itself), and a "." path segment is
  // normalized away before the request ever reaches us.
  const m = /^\/api\/repos\/([a-z]+)$/.exec(path);
  if (m) {
    const repo = repoById(state, url.searchParams.get("id") ?? "");
    const action = m[1];
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
      const b = (await req.json()) as { file?: unknown; line?: unknown };
      if (typeof b.file !== "string" || b.file === "" || b.file.includes("\0")) {
        return json({ error: "file must be a path in the repo" }, 400);
      }
      const line = typeof b.line === "number" && Number.isInteger(b.line) && b.line > 0 ? b.line : 1;
      await openFile(repo.path, b.file, line);
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
      const b = (await req.json()) as { app: string; tab?: unknown };
      if (!isOpenerId(b.app)) return json({ error: "unknown app" }, 400);
      await openIn(b.app, repo.path, agentFor(await loadConfig(), repo.path), {
        tab: b.tab === true,
      });
      return json({ ok: true });
    }
    if (method === "POST" && action === "agent") {
      // Validated field by field: a stray value must not reach a command line.
      const agents = await setAgent(repo.path, normalizeAgent(await req.json()));
      broadcast(state, { type: "agents", agents });
      return json(agents);
    }
    if (method === "POST" && action === "refresh") {
      return json(await refreshAndBroadcast(state, repo.id));
    }
    if (method === "GET" && action === "workflows") {
      return json(await loadWorkflows(repo));
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
      const agent = agentFor(await loadConfig(), repo.path);
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
      const b = (await req.json()) as { action?: unknown; note?: unknown };
      if (!isRunAction(b.action)) return json({ error: "unknown action" }, 400);
      const note = typeof b.note === "string" ? b.note : "";
      const agent = agentFor(await loadConfig(), repo.path);
      return json(state.runner.start(repo, b.action, ACTIONS[b.action], note, agent), 201);
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
  const root = await realpath(opts.root);
  const port = opts.port ?? cfg.port;
  const scanOptions = scanOpts(cfg);
  const runtime = (src: Source): SourceRuntime => ({
    src: { ...src, repos: 0, scannedAt: 0 },
    watcher: null,
    probed: new Set(),
    scanning: null,
  });
  // A stored source that is the launch root again would list every repo
  // twice; the launch root wins and keeps its bare ids.
  const extras = cfg.sources.filter((s) => s.kind !== "local" || s.path !== root);
  const runner = new Runner({
    onChange: (run) => {
      broadcast(state, { type: "run", run });
      state.flows.onRun(run);
    },
    onGone: (id) => broadcast(state, { type: "run-gone", id }),
    // Re-read status directly rather than waiting on the watcher's
    // debounce: the card and the run's outcome should agree at once.
    status: (repoId) =>
      refreshAndBroadcast(state, repoId)
        .then((r) => r.status)
        .catch(() => null),
  });
  const flows = new Flows(runner, {
    onChange: (flow) => broadcast(state, { type: "flow", flow }),
    onGone: (id) => broadcast(state, { type: "flow-gone", id }),
    onFleet: (fleet) => broadcast(state, { type: "fleet", fleet }),
    onFleetGone: (id) => broadcast(state, { type: "fleet-gone", id }),
    check: runCheck,
    evaluator: hasGatewayKey() ? jev : null,
    status: (repoId) =>
      refreshAndBroadcast(state, repoId)
        .then((r) => r.status)
        .catch(() => null),
  });
  const state: ServerState = {
    root,
    sources: [runtime(launchSource(root)), ...extras.map((s) => runtime({ ...s, launch: false }))],
    result: { root, sources: [], repos: [], scannedAt: 0 },
    ignore: scanOptions.ignore,
    access: new Map(),
    clients: new Set(),
    timers: new Map(),
    history: null,
    historyPending: null,
    terms: new Set(),
    runner,
    flows,
  };
  await rememberRoot(root);
  await Promise.all(state.sources.map((rt) => scanOne(state, rt, scanOptions)));
  // The launch root failing to scan is fatal, as it always was: there is
  // nothing to show. An extra source failing is a note on that source.
  const launch = state.sources[0];
  if (launch?.src.error) throw new Error(launch.src.error);

  const library = new Library(root);
  const webDir = join(import.meta.dir, "../../dist/web");
  const server = bind(port, () =>
    Bun.serve<TermSocket>({
      port,
      // Loopback only: every mutating git route here is unauthenticated.
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: async (req, srv) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/library" || url.pathname === "/library" || url.pathname.startsWith("/library/")) return library.handle(req);
        if (url.pathname === "/api/events") return sse(state);
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
          const size = termSize(url.searchParams.get("cols"), url.searchParams.get("rows"));
          if (srv.upgrade(req, { data: { repo, ...size } })) return undefined;
          return json({ error: "a websocket is expected here" }, 426);
        }
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
      websocket: {
        // Keystrokes go down as binary frames and the pty's output comes
        // back the same way; the one text frame each way is JSON: a resize
        // from the browser, the shell's exit from here.
        open(ws) {
          const { repo, cols, rows } = ws.data;
          try {
            const session = startTerm(repo.path, { cols, rows }, {
              data: (chunk) => {
                ws.sendBinary(chunk);
              },
              exit: (code) => {
                state.terms.delete(session);
                try {
                  ws.send(JSON.stringify({ exit: code }));
                  ws.close(1000, "the shell exited");
                } catch {
                  // the browser went first
                }
              },
            });
            ws.data.session = session;
            state.terms.add(session);
          } catch (err) {
            ws.close(1011, String(err instanceof Error ? err.message : err).slice(0, 120));
          }
        },
        message(ws, msg) {
          const session = ws.data.session;
          if (!session) return;
          if (typeof msg === "string") {
            const m = parseTermMessage(msg);
            if (m?.kind === "resize") session.resize(m.size);
            return;
          }
          session.write(msg);
        },
        close(ws) {
          const session = ws.data.session;
          if (!session) return;
          state.terms.delete(session);
          session.close();
        },
      },
    }),
  );
  // Only after the bind succeeds: a watcher started earlier would outlive a
  // failed listen and hold the process open.
  for (const rt of state.sources) startWatcher(state, rt);
  const remoteTimer = setInterval(() => void refreshRemote(state), REMOTE_REFRESH);

  const heartbeat = setInterval(() => {
    for (const c of state.clients) {
      try {
        c.enqueue(enc.encode(`: ping\n\n`));
      } catch {
        state.clients.delete(c);
      }
    }
  }, 25_000);

  const stopLibrary = () => library.stop();
  process.on("exit", stopLibrary);
  return {
    port: server.port ?? port,
    stop: () => {
      clearInterval(heartbeat);
      clearInterval(remoteTimer);
      for (const t of state.timers.values()) clearTimeout(t);
      state.flows.stopAll();
      state.runner.stopAll();
      for (const t of state.terms) t.close();
      state.terms.clear();
      library.stop();
      process.off("exit", stopLibrary);
      for (const rt of state.sources) rt.watcher?.close();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const { port } = await startServer({ root });
  console.log(`canopy server on http://127.0.0.1:${port} (root: ${root})`);
}
