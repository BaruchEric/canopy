/** Peer sync, the Bun half: snapshots, fetches, fast-forwards, clones and
 *  seeds, every git call through `git()`. The decisions are in peers.ts. */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { git } from "./exec";
import { BUSY_MARKERS, ffTarget, NO_PUSH, parseRefLines, parseWipLines, peerMissing, peerRefspecs, peerUnreachable, peerUrl } from "./peers";
import type { Peer, PeerState, PeerWip } from "./types";

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

/** ssh for git's own fetches, sharing canopy's per-host connection. */
export const gitSshCommand = (controlDir: string): string =>
  `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=${join(controlDir, "ssh-%C")} -o ControlPersist=120`;

/** Adds or repairs each git peer's remote. Safe to repeat. */
export async function initRepo(repo: string, id: string, peers: Peer[], dry: boolean): Promise<void> {
  if (dry) return;
  for (const p of peers) {
    if (p.role !== "git") continue;
    const url = peerUrl(p, id);
    const has = (await git(repo, ["remote", "get-url", p.name])).code === 0;
    await git(repo, has ? ["remote", "set-url", p.name, url] : ["remote", "add", p.name, url]);
    const [heads, wip] = peerRefspecs(p.name);
    await git(repo, ["config", "--replace-all", `remote.${p.name}.fetch`, heads]);
    await git(repo, ["config", "--add", `remote.${p.name}.fetch`, wip]);
    await git(repo, ["config", `remote.${p.name}.tagOpt`, "--no-tags"]);
    await git(repo, ["config", `remote.${p.name}.pushurl`, NO_PUSH]);
  }
}

export type FetchOutcome = "ok" | "missing" | "unreachable" | { error: string };

/** Fetches a peer by URL and explicit refspecs rather than by remote name,
 *  so it works whether or not `initRepo` has ever run: dry mode skips
 *  `initRepo`, and a named-remote fetch would then read every repo as
 *  "missing" for having no such remote. */
export async function fetchPeer(repo: string, id: string, peer: Peer, env: Record<string, string>): Promise<FetchOutcome> {
  const [heads, wip] = peerRefspecs(peer.name);
  const r = await git(repo, ["fetch", "--prune", "--no-tags", "--quiet", peerUrl(peer, id), heads, wip], 60_000, { GIT_TERMINAL_PROMPT: "0", ...env });
  if (r.code === 0) return "ok";
  if (peerUnreachable(r.stderr)) return "unreachable";
  if (peerMissing(r.stderr)) return "missing";
  return { error: r.stderr.trim().split("\n").pop() || `git fetch exited ${r.code}` };
}

export async function peerTips(repo: string, peers: string[]) {
  const local = new Map<string, string>();
  for (const { ref, hash } of parseRefLines((await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"])).stdout)) {
    local.set(ref.slice("refs/heads/".length), hash);
  }
  const byPeer = new Map<string, Map<string, string>>();
  for (const p of peers) {
    const m = new Map<string, string>();
    const prefix = `refs/remotes/${p}/`;
    for (const { ref, hash } of parseRefLines((await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", prefix])).stdout)) {
      if (ref !== `${prefix}HEAD`) m.set(ref.slice(prefix.length), hash);
    }
    byPeer.set(p, m);
  }
  return { local, byPeer };
}

/** ahead/behind as seen from the peer tip's side: ahead is commits the peer
 *  has that we don't, behind is commits we have that the peer doesn't. */
async function counts(repo: string, local: string, tip: string): Promise<{ ahead: number; behind: number }> {
  const r = await git(repo, ["rev-list", "--left-right", "--count", `${local}...${tip}`]);
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

const ancestor = async (repo: string, a: string, b: string): Promise<boolean> =>
  a === b || (await git(repo, ["merge-base", "--is-ancestor", b, a])).code === 0;

export async function fastForward(repo: string, peers: string[], dry: boolean) {
  const out: Pick<PeerState, "moved" | "diverged" | "peerOnly" | "would"> = { moved: [], diverged: [], peerOnly: [], would: [] };
  const { local, byPeer } = await peerTips(repo, peers);
  for (const [peer, branches] of byPeer) {
    for (const b of branches.keys()) if (!local.has(b)) out.peerOnly.push({ peer, branch: b });
  }
  const head = await currentBranch(repo);
  const busy = await isBusy(repo);
  const dirty = await isDirty(repo);
  for (const [branch, mine] of local) {
    const tips = [];
    for (const [peer, branches] of byPeer) {
      const h = branches.get(branch);
      if (h && h !== mine) tips.push({ peer, hash: h, ...(await counts(repo, mine, h)) });
    }
    if (tips.length === 0) continue;
    // Pairwise containment among the tips, asked once each.
    const known = new Map<string, boolean>();
    for (const a of tips) for (const b of tips) known.set(`${a.hash}>${b.hash}`, await ancestor(repo, a.hash, b.hash));
    const d = ffTarget(branch, tips, (a, b) => a === b || known.get(`${a}>${b}`) === true);
    out.diverged.push(...d.diverged);
    if (!d.to) continue;
    // Busy (a rebase, merge, cherry-pick... anywhere in the repo) blocks
    // every branch, checked out or not: a detached-HEAD rebase reports no
    // current branch at all, so the branch it is rewriting would otherwise
    // slip through the checked-out-only guard below. Dirty only ever
    // threatens the branch actually checked out.
    if (busy || (branch === head && dirty)) continue;
    if (dry) { out.would!.push({ branch, to: d.to.hash, peer: d.to.peer }); continue; }
    const r = branch === head
      ? await git(repo, ["merge", "--ff-only", "--quiet", d.to.hash])
      : await git(repo, ["update-ref", "-m", `canopy: fast-forward from ${d.to.peer}`, `refs/heads/${branch}`, d.to.hash, mine]);
    if (r.code === 0) out.moved.push({ branch, from: mine, to: d.to.hash, peer: d.to.peer });
  }
  if (!dry) delete out.would;
  return out;
}

export async function peerWips(repo: string, peers: string[]): Promise<PeerWip[]> {
  const out: PeerWip[] = [];
  for (const p of peers) {
    const r = await git(repo, ["for-each-ref", "--format=%(objectname) %(committerdate:unix) %(parent) %(refname)", `refs/peer-wip/${p}/`]);
    for (const w of parseWipLines(r.stdout, p)) {
      const d = await git(repo, ["diff", "--name-only", "-z", w.parent, w.hash]);
      out.push({ ...w, files: d.stdout.split("\0").filter(Boolean).length });
    }
  }
  return out;
}
