/**
 * Seeds are written by agents, `.git` included, and canopy runs git in them
 * (the watcher's status, fetch, the peer pass, ship's clone). A config key
 * like core.fsmonitor, a filter driver, an include or an ext:: url turns that
 * git call into a program the agent chose, run as canopy. So every git call
 * canopy makes in a seed is refused unless the `.git` git would use holds
 * only keys canopy and plain commits write, and carries flags and a ceiling
 * that turn the rest off: no submodule's own config, no walk up past the
 * seeds dir. The pure parts are tested in seedgit.test.ts; `guardSeed` is Bun.
 */
import { lstat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** laid on every git call canopy makes in a seed */
export const SEED_GIT_FLAGS: readonly string[] = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.ext.allow=never",
  // a committed gitlink with a `.git` folder beside it would run that
  // folder's config on status, with nothing in the seed's own config
  "-c", "diff.ignoreSubmodules=all",
  "-c", "submodule.recurse=false",
  "-c", "fetch.recurseSubmodules=false",
  // a .git git cannot use sends it on to the folder itself as a bare repo,
  // with a config at the seed's top the guard never read
  "-c", "safe.bareRepository=explicit",
];

const ALLOWED: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  // a subsection keeps its dots (branch.release-1.2.merge), so `.+`, not `[^.]+`
  /^remote\..+\.(url|fetch|pushurl|tagopt|prune)$/,
  // what a person's own tools write too: VS Code's merge base, a rebase or push remote, a description
  /^branch\..+\.(remote|merge|rebase|pushremote|description|vscode-merge-base)$/,
  /^user\.(name|email)$/,
  /^extensions\.objectformat$/,
];

/** a url git would hand to a transport helper or read as a flag */
const badUrl = (v: string): boolean => v.includes("::") || v.trimStart().startsWith("-");

/** what is wrong with a seed's config, from `git config --list --null`'s
 *  pairs, or null when every key is one canopy expects */
export function seedConfigRefusal(entries: readonly [string, string][]): string | null {
  for (const [raw, value] of entries) {
    const key = raw.toLowerCase();
    if (!ALLOWED.some((re) => re.test(key))) return `its .git/config sets ${key}; if you set it yourself, git config --unset-all ${key} lets canopy back in`;
    if (/\.(url|pushurl)$/.test(key) && badUrl(value)) return `its .git/config sets ${key} to a command, not an address`;
  }
  return null;
}

/** whether `path` is inside one of the seeds dirs, not the dir itself */
export function underSeeds(path: string, roots: readonly string[]): boolean {
  if (path.includes("://")) return false;
  return roots.some((r) => path.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** the seeds dir `path` is, or null */
export function seedsDirOf(path: string, roots: readonly string[]): string | null {
  if (path.includes("://")) return null;
  const bare = (p: string) => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p);
  return roots.find((r) => bare(r) === bare(path)) ?? null;
}

/** the seeds dir `path` sits under, or null */
export function seedsRootOf(path: string, roots: readonly string[]): string | null {
  if (path.includes("://")) return null;
  return roots.find((r) => path.startsWith(r.endsWith(sep) ? r : r + sep)) ?? null;
}

/** the seed `path` sits in: the first folder under its seeds dir, or null */
export function seedTopOf(path: string, roots: readonly string[]): string | null {
  const root = seedsRootOf(path, roots);
  if (root === null) return null;
  const base = root.endsWith(sep) ? root : root + sep;
  const first = path.slice(base.length).split(sep)[0];
  return first ? base + first : null;
}

let seedRoots: readonly string[] = [];
/** the seeds dirs, set once by the server; tests set their own */
export function setSeedRoots(roots: readonly string[]): void {
  seedRoots = [...roots];
  memo.clear();
}
export const seedRootsNow = (): readonly string[] => seedRoots;

/** what git() answers in a seed while it is busy */
export const SEED_BUSY = "canopy waits for the stage running in this seed";

/** what git() answers in a seed on an isolated backend while the stage
 *  runner, which runs every git call there, is away or unfenced */
export const SEED_AWAY = "canopy reads this seed through the stage runner, which cannot run it now";

/** whether a git error is a seed held for now (busy, or its runner away),
 *  which a reader waits out rather than shows */
export const seedHeld = (text: string | undefined): boolean => !!text && (text.includes(SEED_BUSY) || text.includes(SEED_AWAY));

let busyHook: (path: string) => boolean = () => false;
/** set once by the server: a seed with a stage process alive in it */
export function setSeedBusy(busy: (path: string) => boolean): void {
  busyHook = busy;
}
export const seedBusy = (path: string): boolean => busyHook(path);

/** what makes a seed busy, as the server knows it */
export interface SeedStages {
  /** canopy's seed git runs in the stages container (a stage runner is set up) */
  isolated: boolean;
  /** the seeds with a check running, by the seed's own path */
  checks: ReadonlyMap<string, number>;
  /** a stage run active on the seed, or a stage process held there */
  aliveIn(seed: string): boolean;
  /** the same, for any seed */
  aliveAny(): boolean;
}

/** Whether canopy holds off its git at `path`. On an isolated backend only
 *  the seed's own stages hold it: canopy's git there runs in the stages
 *  container as the stage user, so a stage in another seed swapping this
 *  one's config reaches nothing of canopy's. On an unisolated backend git
 *  runs here as canopy, so any stage alive anywhere holds every seed. */
export function seedBusyFor(path: string, roots: readonly string[], s: SeedStages): boolean {
  const top = seedTopOf(path, roots);
  if (top === null) return false;
  if (!s.isolated) return s.checks.size > 0 || s.aliveAny();
  return s.checks.has(top) || s.aliveIn(top);
}

/** how long canopy's own write to a seed (a commit, a ship's clone) waits for
 *  the stages to go quiet before it fails */
export const SEED_QUIET_MAX = 2 * 60 * 60 * 1000;
const QUIET_POLL = 250;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Settles once `seedBusy(path)` is false, or throws after `maxMs`, so
 *  canopy's own writes wait their turn rather than fail. */
export async function whenSeedsQuiet(path: string, maxMs = SEED_QUIET_MAX, poll = QUIET_POLL): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (seedBusy(path)) {
    if (Date.now() >= deadline) throw new Error(`${SEED_BUSY}: the seeds were still busy after ${Math.round(maxMs / 60_000)} min`);
    await pause(Math.min(poll, Math.max(1, deadline - Date.now())));
  }
}

/** Runs `f` once the seed is quiet, and again if a stage starting in
 *  between, or the stage runner going away, holds its git calls
 *  (`seedHeld`), all within `maxMs`. */
export async function inQuietSeed<T>(path: string, f: () => Promise<T>, maxMs = SEED_QUIET_MAX, poll = QUIET_POLL): Promise<T> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    await whenSeedsQuiet(path, Math.max(0, deadline - Date.now()), poll);
    try {
      return await f();
    } catch (e) {
      if (!seedHeld(String(e)) || Date.now() >= deadline) throw e;
      await pause(poll);
    }
  }
}

/** keyed on ctime too: `touch -r` puts an mtime back, nothing puts a ctime back */
const memo = new Map<string, { ctime: number; mtime: number; ino: number; size: number; refusal: string | null }>();

/** `--list --null` output as key/value pairs: `key\nvalue\0` */
function parseList(out: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const nl = rec.indexOf("\n");
    pairs.push(nl < 0 ? [rec, ""] : [rec.slice(0, nl), rec.slice(nl + 1)]);
  }
  return pairs;
}

const lstatOrNull = (p: string) => lstat(p).catch(() => null);

/** the `.git` git would use from `path`: the first one walking up to the
 *  seed's top folder, which the ceiling keeps git from walking past */
async function dotGitFor(path: string, root: string): Promise<string | null> {
  let dir = path;
  for (;;) {
    const candidate = join(dir, ".git");
    if (await lstatOrNull(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir || up === root || !up.startsWith(root + sep)) return null;
    dir = up;
  }
}

/** null when canopy may run git at `path`, else why not. A path outside
 *  every seeds dir is always null. */
export async function guardSeed(path: string): Promise<string | null> {
  const root = seedsRootOf(path, seedRoots);
  if (root === null) return null;
  const dotGit = await dotGitFor(path, root.endsWith(sep) ? root.slice(0, -1) : root);
  if (dotGit === null) return null; // not a repo yet: the ceiling stops git at the seeds dir
  const st = await lstatOrNull(dotGit);
  if (!st) return null;
  if (st.isSymbolicLink()) return "its .git is a symlink";
  if (!st.isDirectory()) return "its .git is a gitfile pointing elsewhere";
  // git passes over a .git with no HEAD and walks on, to a .git this guard
  // never judged
  const head = await lstatOrNull(join(dotGit, "HEAD"));
  if (!head?.isFile()) return "its .git is not a whole repository (no HEAD)";
  // either file points git at a config this guard never read
  if (await lstatOrNull(join(dotGit, "commondir"))) return "its .git has a commondir, which points git at another config";
  if (await lstatOrNull(join(dotGit, "config.worktree"))) return "its .git has a config.worktree";
  const file = join(dotGit, "config");
  const fst = await lstatOrNull(file);
  if (!fst) return null;
  if (fst.isSymbolicLink()) return "its .git/config is a symlink";
  const seen = memo.get(file);
  if (seen && seen.ctime === fst.ctimeMs && seen.mtime === fst.mtimeMs && seen.ino === fst.ino && seen.size === fst.size) return seen.refusal;
  // Bun.spawn, not exec(): exec.ts imports this file, and the guard must not
  // route back through git()
  const p = Bun.spawn(["git", "config", "--file", file, "--no-includes", "--list", "--null"], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const refusal = code !== 0 ? "its .git/config does not parse" : seedConfigRefusal(parseList(out));
  memo.set(file, { ctime: fst.ctimeMs, mtime: fst.mtimeMs, ino: fst.ino, size: fst.size, refusal });
  return refusal;
}

/** why canopy will not run git at `path` (the seeds dir itself, or a seed
 *  the guard refuses), or null; a path outside every seeds dir is null */
export async function seedGitRefusal(path: string): Promise<string | null> {
  if (seedsDirOf(path, seedRoots) !== null) return "canopy runs no git in the seeds folder itself; the seeds folder is never a repo";
  const refused = await guardSeed(path);
  return refused ? `canopy will not run git in this seed: ${refused}` : null;
}
