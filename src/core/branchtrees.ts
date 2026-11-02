/** Worktrees kept by hand, one per branch (FR-051): where they live, how a
 *  branch names its folder and picks its port, and the git and copy calls
 *  that make, read and remove one. The conventions are worktrunk's
 *  (max-sixty/worktrunk): a tree is addressed by its branch, a fresh tree
 *  gets the repo's setup and the main checkout's ignored build caches as
 *  copy-on-write clones, and each tree has a port of its own. The record
 *  beside the trees is the server's (server/branchtrees.ts). Shells out
 *  through `exec`, so this needs Bun. */

import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { exec, git } from "./exec";
import { countStatusEntries, parseWorktreeList } from "./git";
import { parsePortRange } from "./preview";
import { configDir } from "./store";
import { dirtyFiles, ffMain, midRebase, rebaseOnto, repoKey, revOf, subjectsSince } from "./worktree";
import { TREES_SOURCE } from "./treewords";
import type { Repo, Source } from "./types";

export const treesRoot = (): string => join(configDir(), "trees");

/** The trees folder as a source the server scans beside the launch root
 *  and the extra folders, so each kept tree is a card of its own. */
export const treesSource = (root = treesRoot()): Source => ({ id: TREES_SOURCE, kind: "local", path: root, label: "worktrees", launch: false });

/** The scanned cards of the trees source, dressed from the records: a
 *  tree the records know is named `<repo> ⑂ <branch>` after the checkout
 *  it was made from and filed under that checkout's group, so it sits
 *  beside its repo on the board; a folder no record claims keeps the
 *  scanner's name. `others` are the rest of the board's repos. */
export function dressTreeCards(treeRepos: readonly Repo[], others: readonly Repo[], records: ReadonlyMap<string, TreesRecord>, root = treesRoot()): Repo[] {
  return treeRepos.map((r) => {
    for (const [repoPath, rec] of records) {
      const t = rec.trees.find((x) => treeDir(repoPath, x.slug, root) === r.path);
      if (!t) continue;
      const parent = others.find((o) => o.path === repoPath);
      return { ...r, name: `${parent?.name ?? basename(repoPath)} ⑂ ${t.branch}`, ...(parent ? { group: parent.group } : {}) };
    }
    return r;
  });
}
/** the record beside a repo's trees, which no slug may take */
export const TREES_RECORD = "trees.json";
/** the ports a tree's shells get as PORT when `CANOPY_TREE_PORTS` is unset:
 *  the range FR-039's task ports reserved, so the two share one pool */
export const TREE_PORTS_DEFAULT = "7900-7949";
export const SLUG_MAX = 48;
/** copying one ignored entry; a clone is instant, a plain copy of a big
 *  node_modules on ext4 is not */
export const COPY_TIMEOUT = 10 * 60_000;

export type BranchTreeState = "preparing" | "ready" | "failed" | "merging";

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
  /** why the last merge or sync stopped short, until one goes through */
  stopped?: string;
  /** follows its base by itself (rebased onto it when it moves) */
  sync: boolean;
  /** the base's commit the last sync was tried at */
  syncedTo?: string;
}

export interface TreesRecord {
  trees: BranchTreeRecord[];
}

export const EMPTY_TREES: TreesRecord = { trees: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const STATES: readonly BranchTreeState[] = ["preparing", "ready", "failed", "merging"];

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
      ...(typeof t["stopped"] === "string" && t["stopped"] ? { stopped: t["stopped"] } : {}),
      sync: t["sync"] !== false,
      ...(typeof t["syncedTo"] === "string" && t["syncedTo"] ? { syncedTo: t["syncedTo"] } : {}),
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

export interface MergeOptions {
  /** commit what is uncommitted first, everything staged, as worktrunk does */
  commit: boolean;
  /** fold the branch's commits into one */
  squash: boolean;
  /** leave the tree and its branch in place after the fast-forward */
  keep: boolean;
}

export type MergeOutcome = { ok: true; head: string; commits: number } | { stopped: string };

/** The squash commit's message: the first subject as the title and the
 *  rest as a list; the branch's name when there is no subject. */
export function squashMessage(subjects: readonly string[], branch: string): string {
  const [first, ...rest] = subjects;
  if (first === undefined) return branch;
  return rest.length === 0 ? first : `${first}\n\n${rest.map((s) => `- ${s}`).join("\n")}`;
}

/** Stages everything and commits it; false when there was nothing to. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  const add = await git(dir, ["add", "-A"], 60_000);
  if (add.code !== 0) throw new Error(why(add, "git add"));
  if ((await git(dir, ["diff", "--cached", "--quiet"])).code === 0) return false;
  const c = await git(dir, ["commit", "-q", "-m", message], 60_000);
  if (c.code !== 0) throw new Error(why(c, "git commit"));
  return true;
}

/** Folds every commit since the merge base with `base` into one. */
export async function squashSince(dir: string, base: string, message: string): Promise<void> {
  const mb = await git(dir, ["merge-base", base, "HEAD"]);
  if (mb.code !== 0) throw new Error(why(mb, "git merge-base"));
  const reset = await git(dir, ["reset", "-q", "--soft", out(mb)]);
  if (reset.code !== 0) throw new Error(why(reset, "git reset"));
  const c = await git(dir, ["commit", "-q", "-m", message], 60_000);
  if (c.code !== 0) throw new Error(why(c, "git commit"));
}

/** The worktree `branch` is checked out in, as a real path; null when none. */
export async function checkedOutAt(repo: string, branch: string): Promise<string | null> {
  const list = await git(repo, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return null;
  for (const w of parseWorktreeList(list.stdout)) {
    if (!w.bare && !w.prunable && w.branch === branch) return realpath(w.path).catch(() => w.path);
  }
  return null;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type SyncOutcome = { ok: true; replayed: number; behind: number } | { stopped: string };

/** The tree brought up to its base: its branch rebased onto the base with
 *  the uncommitted work stashed first and put back after (`--autostash`).
 *  Nothing happens when the base has no commit the tree lacks. A conflict
 *  aborts the rebase, the stash back in place, and names the files; work
 *  the stash could not put back over the new base stays in the stash, and
 *  the outcome says so. */
export async function syncTree(dir: string, base: string): Promise<SyncOutcome> {
  if (!base) return { stopped: "the tree has no base to sync from" };
  if (await midRebase(dir)) await git(dir, ["rebase", "--abort"]);
  const counts = await git(dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
  if (counts.code !== 0) return { stopped: why(counts, "git rev-list") };
  const [behind = "0", ahead = "0"] = out(counts).split(/\s+/);
  const n = Number(behind) || 0;
  if (n === 0) return { ok: true, replayed: 0, behind: 0 };
  const r = await git(dir, ["rebase", "--autostash", base], 120_000, { GIT_EDITOR: "true" });
  if (r.code === 0) {
    if (/autostash resulted in conflicts/i.test(r.stderr + r.stdout)) {
      return { stopped: `rebased onto ${base}, but the uncommitted work did not go back over it; it is kept in the stash (git stash pop in the tree)` };
    }
    return { ok: true, replayed: Number(ahead) || 0, behind: n };
  }
  const u = await git(dir, ["diff", "--name-only", "--diff-filter=U"]);
  const files = u.stdout.split("\n").filter(Boolean);
  await git(dir, ["rebase", "--abort"]);
  if (files.length > 0) return { stopped: `the rebase onto ${base} stopped on ${files.join(", ")} and was aborted; rebase by hand in the tree` };
  return { stopped: why(r, "git rebase") };
}

/** worktrunk's `wt merge`, without its binary: the tree's uncommitted work
 *  committed, its commits squashed into one, the branch rebased onto its
 *  base, `check` run in the tree (the repo's gates; null when they pass),
 *  the base fast-forwarded to the branch, then the tree and branch removed.
 *  A step that cannot go on says why in `stopped` and leaves the tree as
 *  it stood before that step (a conflict aborts the rebase), so the merge
 *  can run again once the reason is dealt with. The base is fast-forwarded
 *  in the main checkout when it is checked out there (git refuses over the
 *  checkout's own changes to the same files), by moving the ref when it is
 *  checked out nowhere, and not at all while another worktree holds it. */
export async function mergeTree(
  repo: string,
  dir: string,
  branch: string,
  base: string,
  opts: MergeOptions,
  check: (dir: string) => Promise<string | null>,
): Promise<MergeOutcome> {
  if (branch === base) return { stopped: `the tree is on ${base} itself` };
  if (!base || (await revOf(repo, base)) === null) return { stopped: `${base || "its base"} is no longer a branch of the repo` };
  if (await midRebase(dir)) await git(dir, ["rebase", "--abort"]);
  const subjects = await subjectsSince(dir, base);
  let swept = false;
  if (opts.commit) {
    try {
      swept = await commitAll(dir, subjects.length === 0 ? branch : `Uncommitted work on ${branch}`);
    } catch (err) {
      return { stopped: errMessage(err) };
    }
  } else if ((await dirtyFiles(dir)).length > 0) {
    return { stopped: "the tree holds uncommitted changes; commit them, or merge with the commit step on" };
  }
  const count = subjects.length + (swept ? 1 : 0);
  const squashed = opts.squash && count > 1;
  if (squashed) {
    try {
      await squashSince(dir, base, squashMessage(subjects, branch));
    } catch (err) {
      return { stopped: errMessage(err) };
    }
  }
  // a tree its base already holds has nothing to replay or check: merging it is removing it
  if (count > 0) {
    const rebased = await rebaseOnto(dir, base);
    if ("conflict" in rebased) {
      return { stopped: `the rebase onto ${base} stopped on ${rebased.conflict.join(", ")} and was aborted; rebase by hand in the tree, then merge again` };
    }
    if ("error" in rebased) return { stopped: rebased.error };
    const failed = await check(dir);
    if (failed !== null) return { stopped: failed };
    const where = await checkedOutAt(repo, base);
    const main = await realpath(repo).catch(() => repo);
    if (where === main) {
      const ff = await ffMain(repo, branch);
      if ("busy" in ff) return { stopped: `${base} is checked out with changes to ${ff.busy.join(", ")}; commit or stash them, then merge again` };
      if ("moved" in ff) return { stopped: `${base} moved while the merge ran; merge again` };
      if ("error" in ff) return { stopped: ff.error };
    } else if (where !== null) {
      return { stopped: `${base} is checked out at ${where}; the fast-forward needs it in the main checkout or in no worktree` };
    } else {
      if ((await git(repo, ["merge-base", "--is-ancestor", base, branch])).code !== 0) return { stopped: `${base} cannot fast-forward to ${branch}` };
      const moved = await git(repo, ["branch", "-f", base, branch]);
      if (moved.code !== 0) return { stopped: why(moved, "git branch -f") };
    }
  }
  const head = await git(repo, ["rev-parse", "--short", base]);
  if (!opts.keep) {
    try {
      await removeBranchTree(repo, dir, branch, true);
    } catch (err) {
      return { stopped: errMessage(err) };
    }
  }
  return { ok: true, head: head.code === 0 ? out(head) : "", commits: squashed ? 1 : count };
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
