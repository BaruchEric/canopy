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
import { lstat, realpath, stat } from "node:fs/promises";
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

let busyHook: (path: string) => boolean = () => false;
/** set once by the server: a seed with a stage process alive in it */
export function setSeedBusy(busy: (path: string) => boolean): void {
  busyHook = busy;
}
export const seedBusy = (path: string): boolean => busyHook(path);

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

/** why the peer gate must not let upload-pack serve `path`. upload-pack opens
 *  the first of `path` plus each of `suffixes` (enter_repo's probing) that is
 *  a repo, through any symlink, so every one that exists is judged by its
 *  real path: inside a seed it must be the seed's folder or its `.git`, the
 *  folder must not be a bare repo of its own, and the guard must pass. */
export async function seedServeRefusal(path: string, suffixes: readonly string[]): Promise<string | null> {
  const lexical = await seedGitRefusal(path);
  if (lexical) return lexical;
  for (const suffix of suffixes) {
    const candidate = path + suffix;
    const st = await stat(candidate).catch(() => null);
    if (!st) continue;
    const real = await realpath(candidate).catch(() => null);
    if (real === null) continue;
    if (seedsDirOf(real, seedRoots) !== null) return "canopy runs no git in the seeds folder itself; the seeds folder is never a repo";
    const top = seedTopOf(real, seedRoots);
    if (top === null) continue;
    if (!st.isDirectory() || (real !== top && real !== join(top, ".git"))) return "canopy will not run git in this seed: a seed is served only as its own folder";
    if (await lstatOrNull(join(top, "HEAD"))) return "canopy will not run git in this seed: its folder is a bare repository, with a config the guard never read";
    const refused = await seedGitRefusal(top);
    if (refused) return refused;
  }
  return null;
}
