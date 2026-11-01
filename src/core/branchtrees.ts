/** Worktrees kept by hand, one per branch (FR-051): where they live, how a
 *  branch names its folder and picks its port, and the git and copy calls
 *  that make, read and remove one. The conventions are worktrunk's
 *  (max-sixty/worktrunk): a tree is addressed by its branch, a fresh tree
 *  gets the repo's setup and the main checkout's ignored build caches as
 *  copy-on-write clones, and each tree has a port of its own. The record
 *  beside the trees is the server's (server/branchtrees.ts). Shells out
 *  through `exec`, so this needs Bun. */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exec, git } from "./exec";
import { countStatusEntries } from "./git";
import { parsePortRange } from "./preview";
import { configDir } from "./store";
import { repoKey } from "./worktree";

export const treesRoot = (): string => join(configDir(), "trees");
/** the record beside a repo's trees, which no slug may take */
export const TREES_RECORD = "trees.json";
/** the ports a tree's shells get as PORT when `CANOPY_TREE_PORTS` is unset:
 *  the range FR-039's task ports reserved, so the two share one pool */
export const TREE_PORTS_DEFAULT = "7900-7949";
export const SLUG_MAX = 48;
/** copying one ignored entry; a clone is instant, a plain copy of a big
 *  node_modules on ext4 is not */
export const COPY_TIMEOUT = 10 * 60_000;

export type BranchTreeState = "preparing" | "ready" | "failed";

/** One tree as the record keeps it; the live counts come from git. */
export interface BranchTreeRecord {
  slug: string;
  branch: string;
  base: string;
  port: number | null;
  madeAt: number;
  caches: boolean;
  state: BranchTreeState;
  why?: string;
}

export interface TreesRecord {
  trees: BranchTreeRecord[];
}

export const EMPTY_TREES: TreesRecord = { trees: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const STATES: readonly BranchTreeState[] = ["preparing", "ready", "failed"];

/** `trees.json` read back: entries that lack a slug or a branch are dropped
 *  rather than failing the file, so one bad line never hides the rest. */
export function parseTreesRecord(text: string): TreesRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_TREES;
  }
  if (!isRecord(raw) || !Array.isArray(raw["trees"])) return EMPTY_TREES;
  const trees: BranchTreeRecord[] = [];
  for (const t of raw["trees"]) {
    if (!isRecord(t) || typeof t["slug"] !== "string" || typeof t["branch"] !== "string") continue;
    const state = STATES.find((s) => s === t["state"]) ?? "ready";
    trees.push({
      slug: t["slug"],
      branch: t["branch"],
      base: typeof t["base"] === "string" ? t["base"] : "",
      port: typeof t["port"] === "number" && Number.isInteger(t["port"]) ? t["port"] : null,
      madeAt: typeof t["madeAt"] === "number" ? t["madeAt"] : 0,
      caches: t["caches"] !== false,
      state,
      ...(state === "failed" && typeof t["why"] === "string" ? { why: t["why"] } : {}),
    });
  }
  return { trees };
}

/** The folder a branch gets: lowercase, with runs of anything but letters,
 *  digits, dots and underscores as one dash, at most SLUG_MAX long. Empty
 *  when nothing survives, and never the record's own name. */
export function treeSlug(branch: string): string {
  const s = branch
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, SLUG_MAX)
    .replace(/[-.]+$/, "");
  return s === TREES_RECORD || s.includes("..") ? "" : s;
}

/** git's own rules for a branch name (check-ref-format --branch), the ones
 *  worth refusing before git does: no spaces or control characters, none of
 *  `~ ^ : ? * [ \`, no `..` or `@{`, no leading dash, no component that
 *  starts with a dot or ends in `.lock`, no empty component, no trailing
 *  dot or slash, and not `@` alone. */
export function isBranchName(name: string): boolean {
  if (name === "" || name === "@" || name.length > 200) return false;
  // control characters are the point of this check
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.startsWith("-")) return false;
  if (name.endsWith(".") || name.endsWith("/")) return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** the ports trees draw from, as `CANOPY_TREE_PORTS` says */
export const treePorts = (spec: string | undefined = process.env["CANOPY_TREE_PORTS"]): number[] =>
  parsePortRange(spec ?? TREE_PORTS_DEFAULT);

/** FNV-1a over the branch, so the same branch gets the same port on every
 *  machine with the same range (worktrunk's `hash_port`). */
export function branchHash(branch: string): number {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(branch)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The branch's port: its hash into the range, walking forward past the
 *  ports already taken (another tree's, or something listening); null when
 *  the range has none left. */
export function treePort(branch: string, ports: readonly number[], taken: ReadonlySet<number>): number | null {
  if (ports.length === 0) return null;
  const start = branchHash(branch) % ports.length;
  for (let i = 0; i < ports.length; i++) {
    const port = ports[(start + i) % ports.length];
    if (port !== undefined && !taken.has(port)) return port;
  }
  return null;
}

export const treeDir = (repoPath: string, slug: string, root = treesRoot()): string => join(root, repoKey(repoPath), slug);

const out = (r: { stdout: string }): string => r.stdout.trim();
const why = (r: { stderr: string; stdout: string; code: number }, what: string): string =>
  (r.stderr.trim() || r.stdout.trim()).split("\n").filter(Boolean).pop() ?? `${what} exited ${r.code}`;

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).code === 0;
}

/** Makes the tree: the branch checked out when it exists (git refuses one
 *  checked out elsewhere, with its own words), else made at `base`. */
export async function addBranchTree(repo: string, dir: string, branch: string, base: string): Promise<"new" | "existing"> {
  await git(repo, ["worktree", "prune"]);
  await mkdir(dirname(dir), { recursive: true });
  const existing = await branchExists(repo, branch);
  const args = existing ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base];
  const r = await git(repo, args, 120_000);
  if (r.code !== 0) throw new Error(why(r, "git worktree add"));
  return existing ? "existing" : "new";
}

/** The main checkout's ignored entries, as paths relative to it: whole
 *  ignored folders as one entry (`node_modules`, `ui/node_modules`,
 *  `target`) and single ignored files (`.env`). git's own folder is never
 *  among them. */
export async function ignoredEntries(repo: string): Promise<string[]> {
  const r = await git(repo, ["-c", "core.quotePath=false", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], 60_000);
  if (r.code !== 0) throw new Error(why(r, "git ls-files"));
  return r.stdout
    .split("\0")
    .map((e) => e.replace(/\/+$/, ""))
    .filter((e) => e !== "" && e !== ".git" && !e.startsWith(".git/"));
}

/** `cp` as a clone where the file system can: clonefile on macOS (APFS),
 *  reflink on Linux (btrfs, XFS), a plain copy anywhere else. */
export function copyArgs(platform: NodeJS.Platform, from: string, to: string): string[] {
  if (platform === "darwin") return ["cp", "-R", "-c", from, to];
  if (platform === "linux") return ["cp", "-R", "--reflink=auto", from, to];
  return ["cp", "-R", from, to];
}

export interface CopyOutcome {
  copied: string[];
  /** entries already in the tree, left as they are */
  kept: string[];
  failed: { path: string; why: string }[];
}

/** Clones the entries into the tree at the same relative paths, one at a
 *  time; an entry the tree already has is kept (a second run after a
 *  failure copies the rest). A failed entry is noted and the next is tried. */
export async function copyIgnored(repo: string, dir: string, entries: readonly string[], platform: NodeJS.Platform = process.platform): Promise<CopyOutcome> {
  const outcome: CopyOutcome = { copied: [], kept: [], failed: [] };
  for (const entry of entries) {
    const from = join(repo, entry);
    const to = join(dir, entry);
    if (existsSync(to)) {
      outcome.kept.push(entry);
      continue;
    }
    if (!existsSync(from)) continue;
    await mkdir(dirname(to), { recursive: true });
    const r = await exec(copyArgs(platform, from, to), { timeoutMs: COPY_TIMEOUT });
    if (r.code === 0) outcome.copied.push(entry);
    else outcome.failed.push({ path: entry, why: why(r, "cp") });
  }
  return outcome;
}

export interface TreeStatus {
  head: string;
  ahead: number;
  behind: number;
  files: number;
  at?: number;
}

/** Where a tree stands: HEAD short, ahead and behind of its base (both
 *  zero when the base is gone), changed entries, the last commit's time. */
export async function treeStatus(dir: string, base: string): Promise<TreeStatus> {
  const [head, counts, status, log] = await Promise.all([
    git(dir, ["rev-parse", "--short", "HEAD"]),
    base ? git(dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`]) : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
    git(dir, ["-c", "core.quotePath=false", "status", "--porcelain=v2", "-uall"]),
    git(dir, ["log", "-1", "--format=%ct"]),
  ]);
  const [behind = "0", ahead = "0"] = counts.code === 0 ? out(counts).split(/\s+/) : [];
  const at = log.code === 0 ? Number(out(log)) * 1000 : 0;
  return {
    head: head.code === 0 ? out(head) : "",
    ahead: Number(ahead) || 0,
    behind: Number(behind) || 0,
    files: status.code === 0 ? countStatusEntries(status.stdout) : 0,
    ...(at > 0 ? { at } : {}),
  };
}

/** Removes the tree, from disk too when git no longer knows it, and the
 *  branch when asked. */
export async function removeBranchTree(repo: string, dir: string, branch: string, deleteBranch: boolean): Promise<void> {
  const r = await git(repo, ["worktree", "remove", "--force", dir], 60_000);
  if (r.code !== 0) await rm(dir, { recursive: true, force: true });
  await git(repo, ["worktree", "prune"]);
  if (deleteBranch) {
    const d = await git(repo, ["branch", "-D", branch]);
    if (d.code !== 0) throw new Error(why(d, "git branch -D"));
  }
}

/** The folders under a repo's trees folder, record aside. */
export async function listTreeDirs(repoPath: string, root = treesRoot()): Promise<string[]> {
  const repoDir = join(root, repoKey(repoPath));
  let names: string[];
  try {
    names = await readdir(repoDir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (name === TREES_RECORD) continue;
    const dir = join(repoDir, name);
    if ((await stat(dir).catch(() => null))?.isDirectory()) dirs.push(dir);
  }
  return dirs.sort();
}

export { removeRefusal, treeWords } from "./treewords";
