import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanopyConfig, Workspace } from "./types";

export const DEFAULT_PORT = 7850;

/** Built fresh each call: a shared object would hand every caller the same
 *  `workspaces` array, and one `push` would leak into every later load. */
const defaults = (): CanopyConfig => ({
  port: DEFAULT_PORT,
  maxDepth: 4,
  ignore: [],
  workspaces: [],
  recentRoots: [],
});

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
    workspaces: (Array.isArray(cfg.workspaces) ? cfg.workspaces : []).filter(
      (w): w is Workspace =>
        Boolean(w) && typeof w.name === "string" && Array.isArray(w.repos),
    ),
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

export async function saveConfig(cfg: CanopyConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  // Write-then-rename: a crash mid-write leaves the old config intact rather
  // than a truncated file that loadConfig would have to quarantine.
  const tmp = `${configPath()}.tmp-${process.pid}`;
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
