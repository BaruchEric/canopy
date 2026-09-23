import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDefaultAgent, normalizeAgent } from "./agent";
import { isDefaultLaunch, normalizeLaunch } from "./launch";
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
  fetch: true,
  keepShells: false,
  self: null,
  peers: [],
  peerSync: "off",
  seed: [...DEFAULT_SEED],
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
    fetch: typeof cfg.fetch === "boolean" ? cfg.fetch : base.fetch,
    keepShells: typeof cfg.keepShells === "boolean" ? cfg.keepShells : base.keepShells,
    self: typeof cfg.self === "string" && isPeerName(cfg.self) ? cfg.self : null,
    peers: normalizePeers(cfg.peers),
    peerSync: PEER_SYNC.includes(cfg.peerSync) ? cfg.peerSync : "off",
    seed: normalizeSeed(cfg.seed),
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

/** Turns keeping shells across a reboot on or off. */
export async function setKeepShells(on: boolean): Promise<void> {
  await withConfig((cfg) => {
    cfg.keepShells = on;
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
