/**
 * A repo's knowledge graph, its Bun half (FR-072): prepares canopy's copy of
 * Understand-Anything on this machine, reads a checkout's graph, and starts
 * and stops the graph's viewer. The run's spec, the JSON readers and the
 * words are core/understand.ts.
 *
 * The plugin is a pnpm monorepo upstream: its skill scripts import a built
 * core whose tree-sitter grammars come from npm, and its viewer serves a
 * built dashboard. lib/understand-anything holds the source and canopy's
 * bun.lock; the first graph run or open on a machine copies it into the
 * config dir, installs it with bun and builds the core and the dashboard,
 * keyed by a hash of the source, so an update or an edit builds a fresh copy
 * and canopy's own checkout and image stay as they are.
 *
 * The viewer is the copy's own `packages/viewer/bin/viewer.mjs`, canopy's
 * code, and the checkout gives it JSON alone. canopy starts it detached on a
 * free 127.0.0.1 port with a token of its own, records it under the config
 * dir, and the page reaches it through a preview slot. canopy's copy stops
 * itself two hours after its last request.
 */

import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { exec } from "../core/exec";
import { configDir } from "../core/store";
import {
  UNDERSTAND_VERSION,
  graphFolder,
  parseGraph,
  parseMeta,
  parseServerState,
  withMeta,
  type UnderstandFolder,
  type UnderstandGraph,
  type UnderstandInfo,
  type UnderstandPlugin,
  type UnderstandServer,
} from "../core/understand";
import { floorplanNode, floorplanPath, realRoot } from "./floorplan";
import { claudeBinary } from "../core/claudedrive";

/** canopy's copy of the plugin's source, with its bun.lock */
export const UNDERSTAND_SOURCE = join(import.meta.dir, "../../lib/understand-anything");

/** A refusal the route answers 400 with: the words say what to do. */
export class UnderstandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnderstandError";
  }
}

const lastLine = (s: string): string => s.trim().split("\n").pop() ?? "";

// ---------------------------------------------------------------- the copy

/** Every file under `dir`, relative to it, sorted; node_modules and build
 *  output left out, as git leaves them out of lib/. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      if (name === "node_modules" || name === "dist" || name === ".DS_Store") continue;
      const path = rel ? join(rel, name) : name;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out.sort();
}

/** A short hash of the source's paths and bytes: the prepared copy's key.
 *  VENDOR.md is canopy's notes and changes nothing that runs, so an edit
 *  to it does not make every backend build the plugin again. */
export function sourceKey(dir: string): string {
  const h = createHash("sha256");
  for (const rel of sourceFiles(dir)) {
    if (rel === "VENDOR.md") continue;
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

let cachedKey: string | null = null;
/** the source's key, hashed once per server: the source changes only with
 *  a pull, and the server restarts after one */
const currentKey = (): string => (cachedKey ??= sourceKey(UNDERSTAND_SOURCE));

/** where prepared copies live */
const copiesDir = (): string => join(configDir(), "understand");

/** the prepared copy for the source as it is now: the run's --plugin-dir */
export const pluginDir = (): string => join(copiesDir(), `plugin-${UNDERSTAND_VERSION}-${currentKey()}`);

/** the understand skill inside the prepared copy */
export const skillDir = (): string => join(pluginDir(), "skills", "understand");

/** the file a finished prepare leaves, so a copy cut short is never used */
const STAMP = ".canopy-prepared";

/** The skill's scripts a graph run may start: its `.mjs` and `.py` files. */
export function skillScripts(dir = skillDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".mjs") || n.endsWith(".py"))
      .sort();
  } catch {
    return [];
  }
}

let preparing: Promise<void> | null = null;
let failure: string | null = null;

/** Where the prepared copy stands. */
export function pluginInfo(): UnderstandPlugin {
  if (existsSync(join(pluginDir(), STAMP))) return { state: "ready" };
  if (preparing) return { state: "preparing" };
  if (failure) return { state: "failed", error: failure };
  return { state: "unprepared" };
}

/** One step of a prepare; a failure says which step and its last line. */
async function step(what: string, cmd: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<void> {
  const r = await exec(cmd, { cwd, env, timeoutMs });
  if (r.code !== 0) throw new Error(`${what} failed: ${lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code}`}`);
}

/** Copies the source into a scratch folder beside the copy, installs it
 *  with bun from canopy's bun.lock (no install scripts: the grammars' own
 *  native builds are not needed, their wasm is), builds the core and the
 *  dashboard, puts the dashboard where the viewer serves it from, stamps it
 *  and moves it into place. Older copies go once the new one is in. */
async function prepare(): Promise<void> {
  const dest = pluginDir();
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(copiesDir(), { recursive: true });
  cpSync(UNDERSTAND_SOURCE, tmp, { recursive: true, filter: (src) => !/[/\\](node_modules|dist)$/.test(src) });
  const env = { PATH: floorplanPath(floorplanNode(), null, process.env["PATH"] ?? "") };
  const bun = process.execPath;
  try {
    await step("bun install", [bun, "install", "--frozen-lockfile", "--ignore-scripts"], tmp, env, 600_000);
    await step("building the core", [bun, "run", "build"], join(tmp, "packages", "core"), env, 300_000);
    await step("building the dashboard", [bun, "run", "build"], join(tmp, "packages", "dashboard"), env, 300_000);
    const viewer = join(tmp, "packages", "viewer");
    cpSync(join(tmp, "packages", "dashboard", "dist"), join(viewer, "dist"), { recursive: true });
    mkdirSync(join(viewer, "bin", "dist"), { recursive: true });
    cpSync(join(tmp, "packages", "core", "dist", "staleness.js"), join(viewer, "bin", "dist", "staleness.js"));
    writeFileSync(join(tmp, STAMP), `${JSON.stringify({ version: UNDERSTAND_VERSION, key: currentKey(), at: new Date().toISOString() })}\n`);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  for (const name of readdirSync(copiesDir())) {
    const path = join(copiesDir(), name);
    if (name.startsWith("plugin-") && path !== dest && !name.includes(".tmp-")) rmSync(path, { recursive: true, force: true });
  }
}

/** Starts a prepare unless the copy is ready or one is going; a failed one
 *  is tried again. Answers where the copy stands now. */
export function startPrepare(): UnderstandPlugin {
  if (pluginInfo().state === "ready" || preparing) return pluginInfo();
  failure = null;
  preparing = prepare()
    .catch((err: unknown) => {
      failure = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      preparing = null;
    });
  return pluginInfo();
}

/** Waits for a prepare going on, for tests and the CLI's own server. */
export const preparedNow = async (): Promise<UnderstandPlugin> => {
  await preparing;
  return pluginInfo();
};

// ---------------------------------------------------------------- the run

/** A folder of links the run puts first on PATH: `python` to python3 where
 *  the machine has no `python`, since the skill's two merge scripts are
 *  started under that name and Debian has only python3. */
export function pythonDir(): string | null {
  if (Bun.which("python")) return null;
  const python3 = Bun.which("python3");
  if (!python3) return null;
  const dir = join(copiesDir(), "bin");
  const link = join(dir, "python");
  try {
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(python3, link);
  } catch {
    return null;
  }
  return dir;
}

/** The variables a graph run gets: node's, claude's and the python link's
 *  folders first on PATH, and the plugin told to keep a graph in the
 *  checkout it was asked about, even a worktree (canopy's kept trees are
 *  worktrees, and the plugin would write into the main checkout). */
export function understandEnv(): Record<string, string> {
  const base = floorplanPath(floorplanNode(), claudeBinary(), process.env["PATH"] ?? "");
  const py = pythonDir();
  return {
    PATH: py ? `${py}:${base}` : base,
    UNDERSTAND_NO_WORKTREE_REDIRECT: "1",
  };
}

/** Keeps the graph's folder out of git: a `.gitignore` of `*` inside it,
 *  written before a run, unless the repo already tracks files there (a
 *  repo that commits its graph keeps doing so). */
export async function keepOutOfGit(root: string, folder: UnderstandFolder): Promise<void> {
  const dir = join(root, folder);
  const ignore = join(dir, ".gitignore");
  if (existsSync(ignore)) return;
  const tracked = await exec(["git", "ls-files", "--", folder], { cwd: root, timeoutMs: 10_000 });
  if (tracked.code === 0 && tracked.stdout.trim()) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(ignore, "# canopy keeps Understand-Anything's graph out of git\n*\n");
}

// ---------------------------------------------------------------- reading

/** the checkout's graph folder: the legacy name when it is there */
export const folderOf = (root: string): UnderstandFolder => graphFolder((name) => existsSync(join(root, name)));

const summaries = new Map<string, { mtimeMs: number; size: number; graph: UnderstandGraph }>();

/** knowledge-graph.json read for its summary, kept while the file's time
 *  and size hold, since a large repo's graph runs to megabytes. */
function readGraphFile(path: string): UnderstandGraph {
  const st = statSync(path);
  const hit = summaries.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.graph;
  let graph: UnderstandGraph;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    graph = parseGraph(raw);
  } catch {
    graph = { state: "unknown", analyzedAt: null, commit: null, nodes: null, edges: null, files: null, layers: null, tour: null, error: "knowledge-graph.json is not valid JSON" };
  }
  summaries.set(path, { mtimeMs: st.mtimeMs, size: st.size, graph });
  return graph;
}

function readMeta(path: string): ReturnType<typeof parseMeta> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseMeta(raw);
  } catch {
    return null;
  }
}

/** Commits on HEAD since `commit` and the files they changed, or nulls when
 *  git does not know the commit (a shallow clone, a rewritten branch). */
async function since(root: string, commit: string | null): Promise<{ behind: number | null; changed: number | null }> {
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) return { behind: null, changed: null };
  const [count, diff] = await Promise.all([
    exec(["git", "rev-list", "--count", `${commit}..HEAD`], { cwd: root, timeoutMs: 10_000 }),
    exec(["git", "diff", "--name-only", commit, "HEAD", "--"], { cwd: root, timeoutMs: 10_000 }),
  ]);
  const behind = count.code === 0 ? Number(count.stdout.trim()) : NaN;
  if (!Number.isInteger(behind)) return { behind: null, changed: null };
  return { behind, changed: diff.code === 0 ? diff.stdout.split("\n").filter(Boolean).length : null };
}

/** A checkout's graph: its file, where HEAD has gone since, the extras
 *  beside it, the plugin, its viewer and the run at it. */
export async function understandInfo(root: string, run: string | null): Promise<UnderstandInfo> {
  const real = realRoot(root);
  const folder = folderOf(real);
  const dir = join(real, folder);
  const file = join(dir, "knowledge-graph.json");
  const graph: UnderstandGraph = existsSync(file)
    ? withMeta(readGraphFile(file), readMeta(join(dir, "meta.json")))
    : { state: "none", analyzedAt: null, commit: null, nodes: null, edges: null, files: null, layers: null, tour: null };
  const [git, server] = await Promise.all([graph.state === "graph" ? since(real, graph.commit) : { behind: null, changed: null }, liveServer(real)]);
  return {
    ...graph,
    folder,
    ...git,
    domain: existsSync(join(dir, "domain-graph.json")),
    lessons: existsSync(join(dir, "code-lessons.json")),
    plugin: pluginInfo(),
    server: server ? { port: server.port } : null,
    run,
  };
}

// ---------------------------------------------------------------- the viewer

/** a checkout's viewer record, by a hash of its real path */
const stateFile = (real: string): string => join(copiesDir(), "servers", `${createHash("sha256").update(real).digest("hex").slice(0, 16)}.json`);

function readServer(real: string): UnderstandServer | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile(real), "utf8"));
    const s = parseServerState(raw);
    return s && s.root === real ? s : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

/** whether a viewer answers on `port` for `token`; the token is canopy's
 *  own random one, so a pid the system handed to something else since, or
 *  another server on the port, never passes */
async function answers(port: number, token: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/config.json?token=${token}`, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** whether something accepts a connection on `port`, without a request,
 *  which the viewer would count against its idle stop */
async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** The checkout's viewer while one is up: its pid alive and its port
 *  taken. A status read uses this, so reading never keeps an idle viewer
 *  alive; `open` also asks it with the token before handing it out. */
export async function liveServer(real: string): Promise<UnderstandServer | null> {
  const s = readServer(realRoot(real));
  if (!s || !alive(s.pid)) return null;
  return (await listening(s.port)) ? s : null;
}

/** a port no one listens on now, from the system */
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Starts the checkout's viewer, or finds the one up for the copy as it is
 *  now (one from an older copy is stopped and started again), and answers
 *  its port and token. The plugin must be prepared; the route sees to that. */
export async function openUnderstand(root: string): Promise<{ port: number; token: string }> {
  const real = realRoot(root);
  const folder = folderOf(real);
  if (!existsSync(join(real, folder, "knowledge-graph.json"))) throw new UnderstandError("there is no graph here yet: make it first");
  if (pluginInfo().state !== "ready") throw new UnderstandError("Understand-Anything is not ready on this backend yet");
  const up = await liveServer(real);
  // only a viewer that takes canopy's token is canopy's: one from an older
  // copy stops, and a pid or port someone else holds now is left alone
  const ours = up !== null && (await answers(up.port, up.token));
  if (up && ours && up.key === currentKey()) return { port: up.port, token: up.token };
  if (up && ours) await stopUnderstand(root);

  const port = freePort();
  const token = randomBytes(16).toString("hex");
  const node = floorplanNode();
  const logs = join(copiesDir(), "servers");
  mkdirSync(logs, { recursive: true });
  const log = stateFile(real).replace(/\.json$/, ".log");
  const viewer = join(pluginDir(), "packages", "viewer", "bin", "viewer.mjs");
  const proc = Bun.spawn([node, viewer, real, "--port", String(port), "--no-open"], {
    cwd: real,
    // only what it needs: canopy's own env holds tokens the viewer has no use for
    env: {
      PATH: floorplanPath(node, null, process.env["PATH"] ?? ""),
      HOME: process.env["HOME"] ?? real,
      UNDERSTAND_ACCESS_TOKEN: token,
      ...(process.env["UNDERSTAND_IDLE_MS"] ? { UNDERSTAND_IDLE_MS: process.env["UNDERSTAND_IDLE_MS"] } : {}),
    },
    stdin: "ignore",
    stdout: Bun.file(log),
    stderr: Bun.file(log),
    detached: true,
  });
  proc.unref();
  const s: UnderstandServer = { pid: proc.pid, port, token, root: real, key: currentKey() };
  writeFileSync(stateFile(real), `${JSON.stringify(s)}\n`);
  for (const end = Date.now() + 15_000; Date.now() < end; await Bun.sleep(150)) {
    if (await answers(port, token)) return { port, token };
    if (proc.exitCode !== null) break;
  }
  const said = existsSync(log) ? lastLine(readFileSync(log, "utf8")) : "";
  throw new Error(`the graph's viewer did not answer${said ? `: ${said}` : ""} (its log is ${relative(configDir(), log)} in canopy's config dir)`);
}

/** how long a viewer gets to end after SIGTERM before SIGKILL */
const STOP_GRACE = 3_000;

/** Stops the checkout's viewer and answers once it is gone; false when none
 *  was up. */
export async function stopUnderstand(root: string): Promise<boolean> {
  const real = realRoot(root);
  const up = await liveServer(real);
  const s = up && (await answers(up.port, up.token)) ? up : null;
  rmSync(stateFile(real), { force: true });
  if (!s) return false;
  const gone = async (ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (!alive(s.pid)) return true;
    return !alive(s.pid);
  };
  try {
    process.kill(s.pid, "SIGTERM");
    if (!(await gone(STOP_GRACE))) {
      process.kill(s.pid, "SIGKILL");
      await gone(1_000);
    }
  } catch {
    // it ended between the check and the signal
  }
  return true;
}
