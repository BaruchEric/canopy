/** Peer sync, the Bun half: snapshots, fetches, fast-forwards, clones and
 *  seeds, every git call through `git()`. The decisions are in peers.ts. */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { git } from "./exec";
import { BUSY_MARKERS } from "./peers";

export async function currentBranch(repo: string): Promise<string | null> {
  const r = await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (r.code !== 0) return null;
  const head = await git(repo, ["rev-parse", "-q", "--verify", "HEAD"]);
  return head.code === 0 ? r.stdout.trim() : null;
}

export async function isDirty(repo: string): Promise<boolean> {
  const r = await git(repo, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
  return r.code === 0 && r.stdout.length > 0;
}

async function gitPath(repo: string, name: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--git-path", name]);
  const p = r.stdout.trim();
  return isAbsolute(p) ? p : join(repo, p);
}

export async function isBusy(repo: string): Promise<boolean> {
  for (const m of BUSY_MARKERS) if (existsSync(await gitPath(repo, m))) return true;
  return false;
}

/** The tree the working copy would commit, built in a copy of the index so
 *  the user's own index is never written or locked. */
async function worktreeTree(repo: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "canopy-wip-"));
  const index = join(dir, "index");
  try {
    const real = await gitPath(repo, "index");
    if (existsSync(real)) await copyFile(real, index);
    const env = { GIT_INDEX_FILE: index };
    if ((await git(repo, ["add", "-A"], 60_000, env)).code !== 0) return null;
    const t = await git(repo, ["write-tree"], 30_000, env);
    return t.code === 0 ? t.stdout.trim() : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function snapshotWip(
  repo: string,
  self: string,
  dry: boolean,
): Promise<{ branch: string; at: number; wrote: boolean } | null> {
  const branch = await currentBranch(repo);
  if (!branch) return null;
  const ref = `refs/wip/${branch}`;
  const had = await git(repo, ["rev-parse", "-q", "--verify", ref]);
  if (!(await isDirty(repo))) {
    if (had.code === 0 && !dry) await git(repo, ["update-ref", "-d", ref, had.stdout.trim()]);
    return null;
  }
  const tree = await worktreeTree(repo);
  if (!tree) return null;
  const at = Date.now();
  if (had.code === 0) {
    const last = await git(repo, ["rev-parse", `${ref}^{tree}`]);
    if (last.stdout.trim() === tree) return { branch, at, wrote: false };
  }
  if (dry) return { branch, at, wrote: true };
  const c = await git(repo, ["commit-tree", tree, "-p", "HEAD", "-m", `wip ${self} ${new Date(at).toISOString()}`]);
  if (c.code !== 0) return null;
  const old = had.code === 0 ? [had.stdout.trim()] : [];
  await git(repo, ["update-ref", "-m", "canopy wip", ref, c.stdout.trim(), ...old]);
  return { branch, at, wrote: true };
}
