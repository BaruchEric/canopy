/** Worktrees canopy makes: a branch run's own checkout, a prepared warm slot
 *  for the next run, and the launcher's pull request builds. Every git call
 *  goes through `git()`, so a remote
 *  path would reach its host, though only local repos get branch runs.
 *
 *  A run's worktree lives at `<configDir>/worktrees/<repo key>/<run id>` on
 *  a branch `run/<work id>-<slug>`; the landing queue rebases it, fast-
 *  forwards the main checkout to it, and removes both. A warm slot is
 *  `<configDir>/worktrees/<repo key>/warm-<n>`, detached, with `setup` run,
 *  ready for the next branch run. */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { exec, git } from "./exec";
import { configDir } from "./store";
import { branchSlug } from "./work";
import { isWarmName } from "./warm";

export { branchSlug };

export const worktreesRoot = (): string => join(configDir(), "worktrees");

/** A repo's folder name under the worktrees root and the landing records:
 *  its folder name and a hash of its path, so two checkouts of one name stay
 *  apart and the key never changes while the path does not. */
export function repoKey(path: string): string {
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 8);
  return `${basename(path) || "repo"}-${hash}`;
}

export const runTreeDir = (repoPath: string, runId: string, root = worktreesRoot()): string => join(root, repoKey(repoPath), runId);

const out = (r: { stdout: string }): string => r.stdout.trim();
const why = (r: { stderr: string; stdout: string; code: number }, what: string): string =>
  (r.stderr.trim() || r.stdout.trim()).split("\n").filter(Boolean).pop() ?? `${what} exited ${r.code}`;

/** The branch a queue lands on: what `origin/HEAD` names, else `main`, else
 *  `master`; null when none exists. */
export async function defaultBranch(repo: string): Promise<string | null> {
  const sym = await git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0) {
    const name = out(sym).replace(/^origin\//, "");
    if (name && (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}`])).code === 0) return name;
  }
  for (const name of ["main", "master"]) {
    if ((await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}`])).code === 0) return name;
  }
  return null;
}

/** The branch a checkout is on, or null when HEAD is detached. */
export async function currentBranch(path: string): Promise<string | null> {
  const r = await git(path, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return r.code === 0 ? out(r) || null : null;
}

/** A ref's commit, or null. */
export async function revOf(path: string, ref: string): Promise<string | null> {
  const r = await git(path, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  return r.code === 0 ? out(r) || null : null;
}

/** Makes a run's worktree on a new branch from `base`. */
export async function addRunTree(repo: string, dir: string, branch: string, base: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
  await mkdir(dirname(dir), { recursive: true });
  const r = await git(repo, ["worktree", "add", "-b", branch, dir, base], 120_000);
  if (r.code !== 0) throw new Error(why(r, "git worktree add"));
}

/** Adds a detached worktree at `head`, or moves an existing one there: the
 *  launcher's pull request builds. Returns the lines it ran, for the job's log.
 *  assertOwner fences every mutation when a caller can lose ownership. */
export async function detachedTree(repo: string, dir: string, head: string, assertOwner?: () => void): Promise<string[]> {
  if (existsSync(join(dir, ".git"))) {
    assertOwner?.();
    const co = await git(dir, ["checkout", "--detach", head]);
    if (co.code !== 0) throw new Error(co.stderr.trim() || "checkout failed");
    return [`$ git checkout --detach ${head.slice(0, 10)} (in the worktree)`];
  }
  assertOwner?.();
  await rm(dir, { recursive: true, force: true });
  assertOwner?.();
  await mkdir(dirname(dir), { recursive: true });
  assertOwner?.();
  await git(repo, ["worktree", "prune"]);
  assertOwner?.();
  const wt = await git(repo, ["worktree", "add", "--detach", dir, head], 120_000);
  if (wt.code !== 0) throw new Error(wt.stderr.trim() || "worktree add failed");
  return [`$ git worktree add --detach ${dir} ${head.slice(0, 10)}`];
}

/** Moves a detached warm tree into a run path, then creates the run's new
 *  branch at `base`. `-b` refuses an existing ref rather than resetting it.
 *  A failed ownership assertion after moving leaves a detached destination. */
export async function takeWarm(repo: string, from: string, to: string, branch: string, base: string, assertOwner?: () => void): Promise<void> {
  if (existsSync(to)) throw new Error(`worktree destination already exists: ${to}`);
  assertOwner?.();
  const moved = await git(repo, ["worktree", "move", from, to], 60_000);
  if (moved.code !== 0) throw new Error(why(moved, "git worktree move"));
  assertOwner?.();
  const checked = await git(to, ["checkout", "-q", "-b", branch, base], 120_000);
  if (checked.code !== 0) throw new Error(why(checked, "git checkout"));
}

/** A folder's size in bytes, or zero when `du` cannot read it. */
export async function treeSize(dir: string): Promise<number> {
  const r = await exec(["du", "-sk", dir]);
  if (r.code !== 0) return 0;
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  const bytes = kb * 1024;
  return Number.isSafeInteger(kb) && kb >= 0 && Number.isSafeInteger(bytes) ? bytes : 0;
}

/** Whether git has a rebase-merge or rebase-apply state in this checkout. */
export async function midRebase(dir: string): Promise<boolean> {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const r = await git(dir, ["rev-parse", "--git-path", state]);
    const path = out(r);
    if (r.code === 0 && path !== "" && existsSync(resolve(dir, path))) return true;
  }
  return false;
}

/** Removes a worktree and, when named, its branch. A folder git no longer
 *  knows as a worktree is removed from disk all the same. assertOwner, when
 *  supplied, runs before each mutation, including fallback disk removal. */
export async function removeRunTree(repo: string, dir: string, branch?: string, assertOwner?: () => void): Promise<void> {
  assertOwner?.();
  const r = await git(repo, ["worktree", "remove", "--force", dir], 60_000);
  if (r.code !== 0) {
    assertOwner?.();
    await rm(dir, { recursive: true, force: true });
  }
  assertOwner?.();
  await git(repo, ["worktree", "prune"]);
  if (branch) {
    assertOwner?.();
    await git(repo, ["branch", "-D", branch]);
  }
}

/** Every run worktree folder on disk: `<root>/<repo key>/<run id>`. Warm
 *  slots are owned by the pool and are not run orphans. */
export async function listRunTreeDirs(root = worktreesRoot()): Promise<string[]> {
  const dirs: string[] = [];
  let keys: string[];
  try {
    keys = await readdir(root);
  } catch {
    return dirs;
  }
  for (const k of keys) {
    let ids: string[];
    try {
      ids = await readdir(join(root, k));
    } catch {
      continue;
    }
    for (const id of ids) {
      if (isWarmName(id)) continue;
      const d = join(root, k, id);
      if ((await stat(d).catch(() => null))?.isDirectory()) dirs.push(d);
    }
  }
  return dirs.sort();
}

/** A repo's warm slot directories on disk, in slot name order. */
export async function listWarmTreeDirs(repoPath: string, root = worktreesRoot()): Promise<string[]> {
  const repoDir = join(root, repoKey(repoPath));
  let names: string[];
  try {
    names = await readdir(repoDir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (!isWarmName(name)) continue;
    const dir = join(repoDir, name);
    if ((await stat(dir).catch(() => null))?.isDirectory()) dirs.push(dir);
  }
  return dirs.sort();
}

/** The main checkout a linked worktree belongs to, from its common git
 *  dir; null when the folder is not a worktree any more. */
export async function treeRepo(dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.code !== 0) return null;
  const common = out(r);
  return basename(common) === ".git" ? dirname(resolve(common)) : null;
}

/** The repo whose path is `path`, or whose real path is: `treeRepo` gives
 *  git's path, with symlinks resolved (macOS's /var, WSL's /Users link),
 *  so a repo scanned through one matches by its real path. */
export function repoAtPath<R extends { path: string }>(repos: readonly R[], path: string): R | undefined {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return repos.find((r) => r.path === path) ?? repos.find((r) => r.path.startsWith("/") && real(r.path) === path);
}

/** How many commits `dir`'s HEAD has that `base` has not. */
export async function aheadOf(dir: string, base: string): Promise<number> {
  const r = await git(dir, ["rev-list", "--count", `${base}..HEAD`]);
  return r.code === 0 ? Number(out(r)) || 0 : 0;
}

/** The files `status` lists, untracked ones included; empty is clean. */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const r = await git(dir, ["status", "--porcelain=v1", "-uall"]);
  if (r.code !== 0) throw new Error(why(r, "git status"));
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
}

/** What a branch run's worktree holds once it settles: commits and nothing
 *  left over (`ready`), changes not committed (`uncommitted`), or neither. */
export async function treeState(dir: string, base: string): Promise<"ready" | "uncommitted" | "nothing"> {
  if (!existsSync(dir)) return "nothing";
  const dirty = await dirtyFiles(dir).catch(() => ["?"]);
  if (dirty.length > 0) return "uncommitted";
  return (await aheadOf(dir, base)) > 0 ? "ready" : "nothing";
}

export type PushResult = { ok: true } | { rejected: string };

/** Pushes a run's branch to `remote` under its own name, never with
 *  force: a remote branch someone else moved refuses it. */
export async function pushBranch(dir: string, remote: string, branch: string): Promise<PushResult> {
  const r = await git(dir, ["push", "--porcelain", remote, `refs/heads/${branch}:refs/heads/${branch}`], 120_000);
  return r.code === 0 ? { ok: true } : { rejected: why(r, "git push") };
}

/** The remote a run's branch is pushed to: the one `target`'s upstream
 *  names, else `origin`, else the only remote; null when there is none. */
export async function pushRemote(repo: string, target: string): Promise<string | null> {
  const up = await git(repo, ["config", "--get", `branch.${target}.remote`]);
  const named = out(up);
  const list = (await git(repo, ["remote"])).stdout.split("\n").filter(Boolean);
  if (named && list.includes(named)) return named;
  if (list.includes("origin")) return "origin";
  return list.length === 1 ? list[0]! : null;
}

/** A file's text as `HEAD` holds it, not as the folder does; null when
 *  HEAD has no such file. */
export async function showAtHead(repo: string, path: string): Promise<string | null> {
  const r = await git(repo, ["show", `HEAD:${path}`]);
  return r.code === 0 ? r.stdout : null;
}

/** The subjects of the commits `dir`'s HEAD has that `base` has not,
 *  oldest first. */
export async function subjectsSince(dir: string, base: string): Promise<string[]> {
  const r = await git(dir, ["log", "--reverse", "--format=%s", `${base}..HEAD`]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export type RebaseResult = { ok: true } | { conflict: string[] } | { error: string };

/** Rebases the worktree's branch onto `onto`. A conflict is aborted, and
 *  the files git stopped on are named. A rebase a crash left half done is
 *  aborted first. */
export async function rebaseOnto(dir: string, onto: string): Promise<RebaseResult> {
  if (await midRebase(dir)) await git(dir, ["rebase", "--abort"]);
  const r = await git(dir, ["rebase", onto], 120_000, { GIT_EDITOR: "true" });
  if (r.code === 0) return { ok: true };
  const u = await git(dir, ["diff", "--name-only", "--diff-filter=U"]);
  const files = u.stdout.split("\n").filter(Boolean);
  await git(dir, ["rebase", "--abort"]);
  if (files.length > 0) return { conflict: files };
  return { error: why(r, "git rebase") };
}

export type FastForwardResult = { ok: true } | { busy: string[] } | { moved: true } | { error: string };

/** Lists the files after git's "would be overwritten" line, one tab-
 *  indented path per line, up to the advice that follows them. */
export function overwrittenFiles(stderr: string): string[] {
  const files: string[] = [];
  let on = false;
  for (const line of stderr.split("\n")) {
    if (/would be overwritten by merge/.test(line)) {
      on = true;
      continue;
    }
    if (on) {
      if (/^\s+\S/.test(line)) files.push(line.trim());
      else if (files.length > 0) on = false;
    }
  }
  return files;
}

/** Fast-forwards the main checkout to `branch`. Git refuses when the
 *  checkout's own changes touch the same files (`busy`), and when the
 *  branch does not contain the checkout's HEAD (`moved`). */
export async function ffMain(repo: string, branch: string): Promise<FastForwardResult> {
  const r = await git(repo, ["merge", "--ff-only", "--no-edit", branch], 120_000);
  if (r.code === 0) return { ok: true };
  const text = r.stderr + r.stdout;
  const busy = overwrittenFiles(text);
  if (busy.length > 0) return { busy };
  if (/not possible to fast-forward/i.test(text)) return { moved: true };
  return { error: why(r, "git merge --ff-only") };
}
