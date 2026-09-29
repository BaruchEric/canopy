import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDefaultAgent, normalizeAgent } from "./agent";
import { isDefaultLaunch, normalizeLaunch } from "./launch";
import { normalizeBackends } from "./backends";
import { normalizeTaskPatch } from "./tasks";
import { DEFAULT_SEED, PEER_SYNC, isPeerName, normalizePeers, normalizeSeed } from "./peers";
import {
  DEFAULT_AGENT,
  DEFAULT_LAUNCH,
  LAUNCH_SOURCE,
  type AgentSettings,
  type CanopyConfig,
  type LaunchSettings,
  type SourceInput,
  type StoredSource,
  type TaskPatch,
  type Workspace,
} from "./types";

export const DEFAULT_PORT = 7850;

/** Built fresh each call: a shared object would hand every caller the same
 *  `workspaces` array, and one `push` would leak into every later load. */
const defaults = (): CanopyConfig => ({
  port: DEFAULT_PORT,
  maxDepth: 4,
  ignore: [],
  workspaces: [],
  recentRoots: [],
  sources: [],
  historyBin: null,
  agents: {},
  launchers: {},
  tasks: {},
  archived: [],
  fetch: true,
  keepShells: false,
  tailchanNotify: false,
  self: null,
  peers: [],
  peerSync: "off",
  seed: [...DEFAULT_SEED],
  backends: [],
});

/** Every stored entry re-validated; one left at the defaults is dropped, so
 *  the file only holds repos that differ from them. */
function normalizeAgents(v: unknown): Record<string, AgentSettings> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, AgentSettings> = {};
  for (const [path, raw] of Object.entries(v as Record<string, unknown>)) {
    const a = normalizeAgent(raw);
    if (!isDefaultAgent(a)) out[path] = a;
  }
  return out;
}

/** The launch settings the same way: only repos that differ from the defaults. */
function normalizeLaunchers(v: unknown): Record<string, LaunchSettings> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, LaunchSettings> = {};
  for (const [path, raw] of Object.entries(v as Record<string, unknown>)) {
    const l = normalizeLaunch(raw);
    if (!isDefaultLaunch(l)) out[path] = l;
  }
  return out;
}

/** Task overrides by repo path: each entry checked like a repo file's, and a
 *  repo with none left out. */
function normalizeTasks(v: unknown): Record<string, TaskPatch[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, TaskPatch[]> = {};
  for (const [path, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const kept = list.map(normalizeTaskPatch).filter((p): p is TaskPatch => typeof p !== "string" && Object.keys(p).length > 1);
    if (kept.length) out[path] = kept;
  }
  return out;
}

/** A hand-edited source survives only when every field it needs is there;
 *  a half entry would later become a repo id nothing can resolve. */
function isStoredSource(v: unknown): v is StoredSource {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s["id"] !== "string" || !s["id"] || s["id"] === LAUNCH_SOURCE) return false;
  if (typeof s["label"] !== "string") return false;
  if (s["kind"] === "forgejo") {
    if (typeof s["url"] !== "string" || !s["url"]) return false;
    return s["tokenFile"] === undefined || typeof s["tokenFile"] === "string";
  }
  if (typeof s["path"] !== "string") return false;
  if (s["kind"] === "local") return true;
  return s["kind"] === "ssh" && typeof s["host"] === "string" && s["host"] !== "";
}

export function configDir(): string {
  return (
    process.env["CANOPY_CONFIG_DIR"] ??
    join(homedir(), ".config", "canopy")
  );
}

const configPath = (): string => join(configDir(), "config.json");

/** Merge over defaults, repairing fields whose type is wrong — a hand-edited
 *  `"workspaces": null` survives a plain spread and throws on every read. */
function normalize(parsed: Partial<CanopyConfig>): CanopyConfig {
  const base = defaults();
  const cfg = { ...base, ...parsed };
  return {
    ...cfg,
    port: Number.isFinite(cfg.port) ? cfg.port : base.port,
    maxDepth: Number.isFinite(cfg.maxDepth) ? cfg.maxDepth : base.maxDepth,
    ignore: Array.isArray(cfg.ignore) ? cfg.ignore : [],
    recentRoots: Array.isArray(cfg.recentRoots) ? cfg.recentRoots : [],
    sources: (Array.isArray(cfg.sources) ? cfg.sources : []).filter(isStoredSource),
    historyBin:
      typeof cfg.historyBin === "string" && cfg.historyBin ? cfg.historyBin : null,
    workspaces: (Array.isArray(cfg.workspaces) ? cfg.workspaces : []).filter(
      (w): w is Workspace =>
        Boolean(w) && typeof w.name === "string" && Array.isArray(w.repos),
    ),
    agents: normalizeAgents(cfg.agents),
    launchers: normalizeLaunchers(cfg.launchers),
    tasks: normalizeTasks(cfg.tasks),
    archived: Array.isArray(cfg.archived)
      ? cfg.archived.filter((p, i, all): p is string => typeof p === "string" && p !== "" && all.indexOf(p) === i)
      : [],
    fetch: typeof cfg.fetch === "boolean" ? cfg.fetch : base.fetch,
    keepShells: typeof cfg.keepShells === "boolean" ? cfg.keepShells : base.keepShells,
    tailchanNotify: typeof cfg.tailchanNotify === "boolean" ? cfg.tailchanNotify : base.tailchanNotify,
    self: typeof cfg.self === "string" && isPeerName(cfg.self) ? cfg.self : null,
    peers: normalizePeers(cfg.peers),
    peerSync: PEER_SYNC.includes(cfg.peerSync) ? cfg.peerSync : "off",
    seed: normalizeSeed(cfg.seed),
    backends: normalizeBackends(cfg.backends),
  };
}

export async function loadConfig(): Promise<CanopyConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch {
    return defaults(); // no config yet — first run
  }
  try {
    return normalize(JSON.parse(raw) as Partial<CanopyConfig>);
  } catch {
    // Unreadable config: preserve it instead of letting the next save erase
    // every workspace the user had.
    const backup = `${configPath()}.corrupt-${Date.now()}`;
    await rename(configPath(), backup).catch(() => {});
    console.error(`canopy: unreadable config, moved to ${backup}`);
    return defaults();
  }
}

/** Reads the config without ever writing anything: no quarantine rename of
 *  a corrupt file, no directory created, nothing. A missing file still means
 *  "this machine never configured anything" (`defaults()`); the file being
 *  present but unreadable or invalid JSON is a different situation the
 *  caller must handle itself, so it comes back as `null` rather than
 *  silently falling back to defaults. Used by the peer gate, which answers a
 *  peer's ssh key and must never leave a mark on the serving machine just
 *  because it was asked a question. */
export async function loadConfigReadOnly(): Promise<CanopyConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? (err as Record<string, unknown>).code : undefined;
    return code === "ENOENT" ? defaults() : null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // valid JSON that isn't a plain object (null, an array, a number, a
    // string) is just as unusable a config as bad JSON: normalize()'s
    // `{...base, ...parsed}` spread would silently tolerate it (an array
    // spreads as numeric-keyed junk) rather than throwing, so this has to be
    // checked explicitly rather than left to the try/catch.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalize(parsed as Partial<CanopyConfig>);
  } catch {
    return null;
  }
}

/** tells one write's temporary file from another's in the same process */
let saves = 0;

export async function saveConfig(cfg: CanopyConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  // Write-then-rename: a crash mid-write leaves the old config intact rather
  // than a truncated file that loadConfig would have to quarantine. A file
  // of its own per write: two writes sharing one interleaved their bytes,
  // and the first rename took the file out from under the second.
  const tmp = `${configPath()}.tmp-${process.pid}-${++saves}`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n");
  await rename(tmp, configPath());
}

/** Serialize read-modify-write cycles so concurrent callers in this process
 *  don't each load the same base config and clobber one another. */
let queue: Promise<unknown> = Promise.resolve();
function withConfig<T>(fn: (cfg: CanopyConfig) => Promise<T> | T): Promise<T> {
  const run = queue.then(async () => {
    const cfg = await loadConfig();
    const out = await fn(cfg);
    await saveConfig(cfg);
    return out;
  });
  queue = run.catch(() => {});
  return run;
}

export async function rememberRoot(root: string): Promise<void> {
  await withConfig((cfg) => {
    cfg.recentRoots = [
      root,
      ...cfg.recentRoots.filter((r) => r !== root),
    ].slice(0, 10);
  });
}

export async function upsertWorkspace(
  name: string,
  repos: string[],
): Promise<Workspace[]> {
  return withConfig((cfg) => {
    const existing = cfg.workspaces.find((w) => w.name === name);
    if (existing) {
      existing.repos = [...new Set([...existing.repos, ...repos])];
    } else {
      cfg.workspaces.push({ name, repos: [...new Set(repos)] });
    }
    return cfg.workspaces;
  });
}

export async function removeWorkspace(
  name: string,
  repo?: string,
): Promise<Workspace[]> {
  return withConfig((cfg) => {
    if (repo) {
      const ws = cfg.workspaces.find((w) => w.name === name);
      if (ws) ws.repos = ws.repos.filter((r) => r !== repo);
    } else {
      cfg.workspaces = cfg.workspaces.filter((w) => w.name !== name);
    }
    return cfg.workspaces;
  });
}

/* ---------- agent settings, per repo ---------- */

/** The settings for a repo path, the defaults when it has none. */
export const agentFor = (cfg: CanopyConfig, path: string): AgentSettings =>
  cfg.agents[path] ?? DEFAULT_AGENT;

/** Stores a repo's settings; setting everything back to the defaults removes
 *  the entry. Returns the whole map, which is what the browsers hold. */
export async function setAgent(
  path: string,
  settings: AgentSettings,
): Promise<Record<string, AgentSettings>> {
  return withConfig((cfg) => {
    const a = normalizeAgent(settings);
    if (isDefaultAgent(a)) delete cfg.agents[path];
    else cfg.agents[path] = a;
    return cfg.agents;
  });
}

/* ---------- archived repos ---------- */

/** Archives or restores a repo by path. Returns every archived path. */
export async function setArchived(path: string, on: boolean): Promise<string[]> {
  return withConfig((cfg) => {
    const rest = cfg.archived.filter((p) => p !== path);
    cfg.archived = on ? [...rest, path] : rest;
    return cfg.archived;
  });
}

/** Turns keeping shells across a reboot on or off. */
export async function setKeepShells(on: boolean): Promise<void> {
  await withConfig((cfg) => {
    cfg.keepShells = on;
  });
}

/** Turns canopy's tailchan posts on or off. */
export async function setTailchanNotify(on: boolean): Promise<void> {
  await withConfig((cfg) => {
    cfg.tailchanNotify = on;
  });
}

/* ---------- launch settings, per repo ---------- */

/** The launch settings for a repo path, the defaults when it has none. */
export const launchFor = (cfg: CanopyConfig, path: string): LaunchSettings =>
  cfg.launchers[path] ?? DEFAULT_LAUNCH;

/** Stores a repo's launch settings; all four blank removes the entry. */
export async function setLaunch(
  path: string,
  settings: LaunchSettings,
): Promise<Record<string, LaunchSettings>> {
  return withConfig((cfg) => {
    const l = normalizeLaunch(settings);
    if (isDefaultLaunch(l)) delete cfg.launchers[path];
    else cfg.launchers[path] = l;
    return cfg.launchers;
  });
}

/* ---------- task overrides ---------- */

export const tasksFor = (cfg: CanopyConfig, path: string): TaskPatch[] => cfg.tasks[path] ?? [];

/** Stores, replaces or (with null, or a patch that says nothing but its
 *  name) removes one task's override. Returns the repo's list. */
export async function setTask(path: string, name: string, patch: TaskPatch | null): Promise<TaskPatch[]> {
  return withConfig((cfg) => {
    const list = (cfg.tasks[path] ?? []).filter((t) => t.name !== name);
    if (patch && Object.keys(patch).length > 1) list.push({ ...patch, name });
    if (list.length) cfg.tasks[path] = list;
    else delete cfg.tasks[path];
    return list;
  });
}

/* ---------- sources ---------- */

/** A label as an id: lowercase, one dash between words, nothing a URL or a
 *  repo id would trip on. */
export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "source";
}

/** The first of `base`, `base-2`, `base-3`… not already taken. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken, LAUNCH_SOURCE]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** The label a source gets when none was given: the folder's own name, or
 *  the forge's hostname. */
export function defaultLabel(input: SourceInput): string {
  if (input.kind === "forgejo") {
    const host = input.url.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? input.url;
    return host.split(":")[0] || input.url;
  }
  const base = input.path.replace(/\/+$/, "").split("/").pop() || input.path;
  return input.kind === "ssh" ? `${input.host}:${base}` : base;
}

const samePlace = (a: SourceInput, b: StoredSource): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "forgejo") return b.kind === "forgejo" && a.url === b.url;
  if (b.kind === "forgejo") return false;
  return a.path === b.path && (a.kind !== "ssh" || b.kind !== "ssh" || a.host === b.host);
};

/** Persists a source. The path is stored as given: the server resolves it
 *  before calling, since only the server can ask a remote host. */
export async function addSource(input: SourceInput): Promise<StoredSource> {
  return withConfig((cfg) => {
    const dup = cfg.sources.find((s) => samePlace(input, s));
    if (dup) throw new Error(`already added as ${dup.label}`);
    const label = input.label?.trim() || defaultLabel(input);
    const id = uniqueId(
      slugify(label),
      cfg.sources.map((s) => s.id),
    );
    const stored: StoredSource =
      input.kind === "forgejo"
        ? {
            id,
            label,
            kind: "forgejo",
            url: input.url,
            ...(input.tokenFile ? { tokenFile: input.tokenFile } : {}),
          }
        : input.kind === "ssh"
          ? { id, label, kind: "ssh", host: input.host, path: input.path }
          : { id, label, kind: "local", path: input.path };
    cfg.sources.push(stored);
    return stored;
  });
}

export async function removeSource(id: string): Promise<StoredSource[]> {
  return withConfig((cfg) => {
    cfg.sources = cfg.sources.filter((s) => s.id !== id);
    return cfg.sources;
  });
}
