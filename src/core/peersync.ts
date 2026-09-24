/** Peer sync, the Bun half: snapshots, fetches, fast-forwards, clones and
 *  seeds, every git call through `git()`. The decisions are in peers.ts. */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
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

/** The committer time of a ref's commit, in ms; null when the ref or its
 *  log entry cannot be read. */
async function commitTimeMs(repo: string, ref: string): Promise<number | null> {
  const r = await git(repo, ["log", "-1", "--format=%ct", ref]);
  if (r.code !== 0) return null;
  const secs = Number(r.stdout.trim());
  return Number.isFinite(secs) ? secs * 1000 : null;
}

/** The tree the working copy would commit, built in a copy of the index so
 *  the user's own index is never written or locked. Dry runs also keep new
 *  objects out of the repo's real store: new blobs and the tree land in a
 *  scratch object directory that reads existing objects through the real
 *  one as an alternate, so nothing is written there. */
async function worktreeTree(repo: string, dry: boolean): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "canopy-wip-"));
  const index = join(dir, "index");
  try {
    const real = await gitPath(repo, "index");
    if (existsSync(real)) await copyFile(real, index);
    const env: Record<string, string> = { GIT_INDEX_FILE: index };
    if (dry) {
      const scratchObjects = join(dir, "objects");
      await mkdir(scratchObjects, { recursive: true });
      env.GIT_OBJECT_DIRECTORY = scratchObjects;
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = await gitPath(repo, "objects");
    }
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
    if (had.code === 0 && !dry) {
      const d = await git(repo, ["update-ref", "-d", ref, had.stdout.trim()]);
      if (d.code !== 0) {
        const still = await git(repo, ["rev-parse", "-q", "--verify", ref]);
        if (still.code === 0) return null; // real failure, the ref is still there
      }
    }
    return null;
  }
  const tree = await worktreeTree(repo, dry);
  if (!tree) return null;
  if (had.code === 0) {
    const last = await git(repo, ["rev-parse", `${ref}^{tree}`]);
    if (last.stdout.trim() === tree) {
      // Same tree, but only a no-op when HEAD hasn't moved past the
      // snapshot's own parent; otherwise a fresh snapshot is still due.
      const parent = await git(repo, ["rev-parse", `${ref}^`]);
      const head = await git(repo, ["rev-parse", "HEAD"]);
      if (parent.code === 0 && head.code === 0 && parent.stdout.trim() === head.stdout.trim()) {
        const at = (await commitTimeMs(repo, ref)) ?? Date.now();
        return { branch, at, wrote: false };
      }
    }
  }
  const at = Date.now();
  if (dry) return { branch, at, wrote: true };
  // Environment identity, not config: a machine's own git identity may be
  // unset (a container with no user.email), and a wip snapshot is canopy's
  // commit, not the user's.
  const identity = {
    GIT_AUTHOR_NAME: "canopy",
    GIT_AUTHOR_EMAIL: `canopy@${self}`,
    GIT_COMMITTER_NAME: "canopy",
    GIT_COMMITTER_EMAIL: `canopy@${self}`,
  };
  const c = await git(
    repo,
    ["commit-tree", tree, "-p", "HEAD", "-m", `wip ${self} ${new Date(at).toISOString()}`],
    30_000,
    identity,
  );
  if (c.code !== 0) return null;
  const old = had.code === 0 ? [had.stdout.trim()] : [];
  const u = await git(repo, ["update-ref", "-m", "canopy wip", ref, c.stdout.trim(), ...old]);
  if (u.code !== 0) return null;
  return { branch, at, wrote: true };
}
