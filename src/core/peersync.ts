/** Peer sync, the Bun half: snapshots, fetches, fast-forwards, clones and
 *  seeds, every git call through `git()`. The decisions are in peers.ts. */
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { git, onHost } from "./exec";
import { BUSY_MARKERS, ffTarget, isPeerName, isSafeRel, NO_PUSH, parseQuotedWords, parseRefLines, parseWipLines, peerMissing, peerRefspecs, peerUnreachable, peerUrl, repoWanted, seedWanted } from "./peers";
import type { Peer, PeerState, PeerWip } from "./types";

export async function currentBranch(repo: string): Promise<string | null> {
  const r = await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (r.code !== 0) return null;
  const head = await git(repo, ["rev-parse", "-q", "--verify", "HEAD"]);
  return head.code === 0 ? r.stdout.trim() : null;
}

/** Fails closed: a repo git can't read status for is treated as dirty,
 *  since "clean" is what lets a take write straight into the working
 *  tree, and a status git can't answer is not a promise of a clean one. */
export async function isDirty(repo: string): Promise<boolean> {
  const r = await git(repo, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
  return r.code !== 0 || r.stdout.length > 0;
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

/** What a forced peer key may reach: git-upload-pack under the workspace
 *  root, and three read-only queries. This is the security boundary between
 *  a peer's ssh key and the rest of the machine, so every check here refuses
 *  on doubt rather than best-guessing. */

export interface PeerListing { id: string; origin: string | null }

/** Whether `to` lies outside `from`, once both are resolved to real paths.
 *  A symlink inside the root can point anywhere; this is what keeps it from
 *  taking a peer key with it. */
const escapes = (from: string, to: string): boolean => {
  const rel = relative(from, to);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/** The target of a gitfile (a regular file holding `gitdir: <path>`, the
 *  form a worktree checkout or a submodule leaves in place of a real `.git`
 *  directory), resolved against the file's own folder. Null when the file
 *  can't be read or doesn't look like a gitfile. */
function gitfileTarget(file: string): string | null {
  let content: string;
  try { content = readFileSync(file, "utf8"); } catch { return null; }
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim();
  const m = /^gitdir:\s*(.+)$/.exec(firstLine);
  const raw = m?.[1]?.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(dirname(file), raw);
}

/** Whether `gitDir`'s own `commondir` file (present on a linked worktree's
 *  gitdir, pointing back at the main repo's real one) resolves outside
 *  `realRoot`. No commondir file is not an escape; an unreadable or
 *  unresolvable one is. */
function commondirEscapes(gitDir: string, realRoot: string): boolean {
  const commonFile = join(gitDir, "commondir");
  if (!existsSync(commonFile)) return false;
  let content: string;
  try { content = readFileSync(commonFile, "utf8"); } catch { return true; }
  const rel = content.trim();
  if (!rel) return true;
  const target = isAbsolute(rel) ? rel : resolve(gitDir, rel);
  let real: string;
  try { real = realpathSync(target); } catch { return true; }
  return escapes(realRoot, real);
}

/** Whether a candidate repo directory (already known to be under
 *  `realRoot` itself) reaches outside it once gitfiles and commondirs are
 *  followed: `dir` may itself be a gitdir with a commondir, and `dir/.git`
 *  may be a gitfile pointing anywhere, whose own gitdir may in turn have a
 *  commondir. A worktree checkout or a checked-out submodule under the
 *  root is exactly this shape and must still be accepted, so this follows
 *  rather than refusing gitfiles outright; anything missing or unreadable
 *  along the way refuses instead of guessing. */
function candidateEscapes(dir: string, realRoot: string): boolean {
  if (commondirEscapes(dir, realRoot)) return true;
  const gitEntry = join(dir, ".git");
  let st;
  try { st = statSync(gitEntry); } catch { return false; } // no .git entry here: nothing further to follow
  if (st.isFile()) {
    const target = gitfileTarget(gitEntry);
    if (target === null) return true; // unreadable or malformed: refuse
    let realTarget: string;
    try { realTarget = realpathSync(target); } catch { return true; } // missing target: refuse
    return escapes(realRoot, realTarget) || commondirEscapes(realTarget, realRoot);
  }
  if (st.isDirectory()) {
    let realGitEntry: string;
    try { realGitEntry = realpathSync(gitEntry); } catch { return true; }
    return escapes(realRoot, realGitEntry) || commondirEscapes(realGitEntry, realRoot);
  }
  return false;
}

/** Absolute repo dir for an id, or null when the id leaves the root, is not
 *  a repo there, or reaches outside the root through a symlink, a gitfile,
 *  or a commondir. */
export function safeId(root: string, id: string): string | null {
  if (id === "" || id.startsWith("/") || id.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
  const dir = resolve(root, id);
  if (relative(root, dir).startsWith("..")) return null;
  if (!existsSync(join(dir, ".git"))) return null;
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpathSync(root);
    realDir = realpathSync(dir);
  } catch {
    return null; // gone between the existsSync check and here: not a repo
  }
  if (escapes(realRoot, realDir)) return null;
  if (candidateEscapes(realDir, realRoot)) return null;
  return dir;
}

export async function serveList(root: string, maxDepth = 4): Promise<PeerListing[]> {
  const out: PeerListing[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (existsSync(join(dir, ".git")) && dir !== root) {
      const id = relative(root, dir);
      const o = await git(dir, ["remote", "get-url", "origin"]);
      out.push({ id, origin: o.code === 0 ? o.stdout.trim() : null });
      return; // never below a repo
    }
    if (depth >= maxDepth) return;
    let names: string[] = [];
    try { names = await readdir(dir); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const p = join(dir, n);
      if ((await lstat(p).catch(() => null))?.isDirectory()) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function serveSeeds(root: string, id: string, allow: string[]): Promise<string[]> {
  const dir = safeId(root, id);
  if (!dir) throw new Error(`not a repo: ${id}`);
  const r = await git(dir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  return r.stdout.split("\0").filter((f) => f && !f.endsWith("/") && seedWanted(allow, f)).sort();
}

export async function serveSeed(root: string, id: string, file: string, allow: string[]): Promise<Uint8Array> {
  const dir = safeId(root, id);
  if (!dir) throw new Error(`not a repo: ${id}`);
  const norm = normalize(file);
  if (norm.startsWith("..") || norm.startsWith("/") || !seedWanted(allow, norm)) throw new Error(`not seedable: ${file}`);
  if (!(await serveSeeds(root, id, allow)).includes(norm)) throw new Error(`not seedable: ${file}`);
  const st = await lstat(join(dir, norm));
  if (!st.isFile()) throw new Error(`not a file: ${file}`);
  return new Uint8Array(await readFile(join(dir, norm)));
}

export type GateCommand =
  | { kind: "upload-pack"; path: string }
  | { kind: "list" }
  | { kind: "seeds"; id: string }
  | { kind: "seed"; id: string; file: string };

/** Without --strict, git's own enter_repo() does not stop at the literal
 *  path: it tries these suffixes in order and chdirs into the first one
 *  that is a directory. A path that doesn't exist can still resolve this
 *  way (a bare `<path>.git` symlink needs no `<path>` at all), so the gate
 *  has to check what upload-pack would actually open, not just the literal
 *  argument. */
const ENTER_REPO_SUFFIXES = ["/.git", "", ".git/.git", ".git"];

/** What the forced command may run. `root` is the absolute workspace root.
 *  git-upload-pack under the root is checked lexically first, then every
 *  path enter_repo's suffix probing could resolve it to is checked by real
 *  path too, and by candidateEscapes for a gitfile or commondir it leads to,
 *  so nothing under the root can hand a symlink, a worktree's gitfile or a
 *  commondir off to something outside it. A resolved path with no existing
 *  candidate at all is left to the lexical check alone: upload-pack itself
 *  will fail on it. */
export function gateCommand(line: string, root: string, home: string): GateCommand | { error: string } {
  const w = parseQuotedWords(line);
  if (!w || w.length === 0) return { error: "refused" };
  if (w[0] === "git-upload-pack" && w.length === 2) {
    const raw = w[1]!.replace(/^~\//, "");
    const path = resolve(raw.startsWith("/") ? raw : join(home, raw));
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { error: "outside the workspace" };
    let realRoot: string | null = null;
    for (const suffix of ENTER_REPO_SUFFIXES) {
      const candidate = path + suffix;
      let st;
      try { st = statSync(candidate); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (realRoot === null) {
        try { realRoot = realpathSync(root); } catch { return { error: "outside the workspace" }; } // root itself is gone
      }
      let realCandidate: string;
      try { realCandidate = realpathSync(candidate); } catch { continue; } // gone between the stat and here
      if (escapes(realRoot, realCandidate) || candidateEscapes(realCandidate, realRoot)) return { error: "outside the workspace" };
    }
    return { kind: "upload-pack", path };
  }
  if (w[0] === "canopy-peer") {
    if (w[1] === "list" && w.length === 2) return { kind: "list" };
    if (w[1] === "seeds" && w.length === 3) return { kind: "seeds", id: w[2]! };
    if (w[1] === "seed" && w.length === 4) return { kind: "seed", id: w[2]!, file: w[3]! };
  }
  return { error: "refused" };
}

/** A peer query: in-process for a local peer (alias null), else over ssh to
 *  the gate, which answers `canopy-peer …`. */
export async function askPeer(peer: Peer, words: string[], seedAllow: string[]) {
  if (peer.alias === null) {
    try {
      const [cmd, a, b] = words;
      if (cmd === "list") return { ok: true as const, out: JSON.stringify(await serveList(peer.root)) };
      if (cmd === "seeds" && a) return { ok: true as const, out: JSON.stringify(await serveSeeds(peer.root, a, seedAllow)) };
      if (cmd === "seed" && a && b) return { ok: true as const, out: Buffer.from(await serveSeed(peer.root, a, b, seedAllow)).toString("base64") };
      return { ok: false as const, unreachable: false, error: "refused" };
    } catch (err) {
      return { ok: false as const, unreachable: false, error: String(err instanceof Error ? err.message : err) };
    }
  }
  const r = await onHost(peer.alias, ["canopy-peer", ...words], { timeoutMs: 60_000 });
  if (r.code === 0) return { ok: true as const, out: r.stdout };
  return { ok: false as const, unreachable: peerUnreachable(r.stderr), error: r.stderr.trim() || `exit ${r.code}` };
}

/** A listing entry with a string id, kept whatever else is wrong with it;
 *  a peer's answer is untrusted, so nothing here assumes the shape holds. */
function asListing(v: unknown): PeerListing[] | null {
  if (!Array.isArray(v)) return null;
  const out: PeerListing[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const { id, origin } = entry as Record<string, unknown>;
    if (typeof id !== "string") continue;
    out.push({ id, origin: typeof origin === "string" ? origin : null });
  }
  return out;
}

export async function listPeer(peer: Peer, seedAllow: string[]) {
  const r = await askPeer(peer, ["list"], seedAllow);
  if (!r.ok) return { unreachable: r.unreachable, error: r.error };
  try {
    const listing = asListing(JSON.parse(r.out));
    return listing ?? { unreachable: false, error: "unreadable listing" };
  } catch {
    return { unreachable: false, error: "unreadable listing" };
  }
}

/** The realpath of `p` itself, or of the first ancestor of `p` that
 *  exists, walking up as far as the filesystem root (which always exists).
 *  Null only on a race: an ancestor existed at the `existsSync` check and
 *  was gone by the `realpath` call a moment later. */
async function deepestRealAncestor(p: string): Promise<string | null> {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) {
      try { return await realpath(cur); } catch { return null; }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Whether `p`'s deepest existing ancestor resolves inside `containerReal`
 *  (the already-resolved real path of the workspace root or repo it must
 *  stay under). A symlink anywhere along the way — already there, or
 *  created in a race between two calls of this — is what this refuses. */
async function staysInside(p: string, containerReal: string): Promise<boolean> {
  const real = await deepestRealAncestor(p);
  return real !== null && (real === containerReal || real.startsWith(containerReal + sep));
}

/** A strict base64 decode: null for anything that isn't valid base64 once
 *  trimmed, rather than Buffer.from's lenient best-effort decoding of what
 *  is, over ssh, a peer's untrusted reply. */
export function decodeBase64Strict(s: string): Buffer | null {
  if (s === "") return Buffer.alloc(0);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return null;
  return Buffer.from(s, "base64");
}

/** Copies each allowlisted ignored file a peer has and this repo lacks.
 *  Written beside the target under a random name and linked into place, so
 *  a file that appeared meanwhile is never replaced. A peer's answer is
 *  untrusted twice over: a file name that fails isSafeRel (path traversal,
 *  an absolute path, a leading dash) is skipped before it ever becomes a
 *  path, and even a safe-looking name is checked against the repo's real
 *  path before and after the directory it lives in is created, since a
 *  symlink already sitting inside the repo (or one that lands there in a
 *  race) can point anywhere a lexical check alone would not catch. */
export async function seedRepo(repo: string, id: string, peers: Peer[], allow: string[], dry: boolean): Promise<string[]> {
  const wrote: string[] = [];
  let repoReal: string;
  try { repoReal = await realpath(repo); } catch { return wrote; } // repo is gone: nothing to seed into
  for (const p of peers.filter((x) => x.role === "git")) {
    const list = await askPeer(p, ["seeds", id], allow);
    if (!list.ok) continue;
    let files: string[] = [];
    try {
      const v: unknown = JSON.parse(list.out);
      if (!Array.isArray(v)) continue;
      files = v.filter((f): f is string => typeof f === "string");
    } catch { continue; }
    for (const f of files) {
      const dest = join(repo, f);
      if (!isSafeRel(f) || !seedWanted(allow, f) || existsSync(dest) || wrote.includes(f)) continue;
      if (!(await staysInside(dest, repoReal))) continue; // before creating anything
      if (dry) { wrote.push(f); continue; }
      const got = await askPeer(p, ["seed", id, f], allow);
      if (!got.ok) continue;
      const bytes = decodeBase64Strict(got.out.trim());
      if (bytes === null) continue;
      const dir = dirname(dest);
      const tmp = `${dest}.canopy-seed-${randomBytes(8).toString("hex")}`;
      try {
        await mkdir(dir, { recursive: true });
        if (!(await staysInside(dest, repoReal))) continue; // again: mkdir may have followed a symlink made meanwhile
        await writeFile(tmp, bytes, { flag: "wx", mode: 0o600 }); // wx: refuses to write through anything already at tmp
        await chmod(tmp, 0o600);
        try {
          await link(tmp, dest); // fails if dest now exists: never overwrite
          wrote.push(f);
        } catch {
          // EEXIST (dest now exists, even as a dangling symlink): someone
          // made it meanwhile, theirs stands. Anything else: a real
          // failure for this file alone. Either way it is simply not
          // written, and the loop moves on to the next file.
        }
      } catch {
        // mkdir or writeFile failed for this file: skip it, the loop goes on
      } finally {
        await rm(tmp, { force: true });
      }
    }
  }
  return wrote;
}

/** Clones every repo a peer has and this workspace lacks. A peer's listing
 *  is untrusted: an id that fails isSafeRel is skipped before it ever
 *  becomes a join(root, id); an id that passes that check but still
 *  resolves outside root once symlinks are followed (an existing local
 *  folder in its path may hold one) is skipped by the same staysInside
 *  check seedRepo uses; and an origin url that starts with "-" or holds
 *  "::" is never handed to `git remote add` (a leading dash could be read
 *  as an option, "::" opens a remote helper). The clone itself takes "--"
 *  ahead of the url and destination for the same reason. A failure cloning
 *  or setting up one repo — including one thrown by initRepo or seedRepo —
 *  is recorded in `failed` and the loop moves on to the next repo. */
export async function cloneMissing(root: string, peers: Peer[], allow: string[], dry: boolean, env: Record<string, string>) {
  const cloned: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const gitPeers = peers.filter((p) => p.role === "git");
  let rootReal: string;
  try { rootReal = await realpath(root); } catch { return { cloned, failed }; } // root is gone
  for (const p of gitPeers) {
    const listing = await listPeer(p, allow);
    if (!Array.isArray(listing)) continue;
    for (const { id, origin } of listing) {
      if (!isSafeRel(id)) continue;
      const dest = join(root, id);
      if (!repoWanted(p, id) || existsSync(dest) || cloned.includes(id)) continue;
      if (!(await staysInside(dest, rootReal))) continue;
      if (dry) { cloned.push(id); continue; }
      try {
        const r = await onHost(null, ["git", "clone", "--quiet", "--origin", p.name, "--", peerUrl(p, id), dest], {
          timeoutMs: 600_000, env: { GIT_TERMINAL_PROMPT: "0", ...env },
        });
        if (r.code !== 0) {
          await rm(dest, { recursive: true, force: true });
          failed.push({ id, error: r.stderr.trim().split("\n").pop() || "clone failed" });
          continue;
        }
        const safeOrigin = origin && !origin.startsWith("-") && !origin.includes("::") ? origin : null;
        if (safeOrigin) await git(dest, ["remote", "add", "origin", safeOrigin]);
        await initRepo(dest, id, gitPeers, false);
        await seedRepo(dest, id, gitPeers, allow, false);
        cloned.push(id);
      } catch (err) {
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        failed.push({ id, error: String(err instanceof Error ? err.message : err) });
      }
    }
  }
  return { cloned, failed };
}

/** Peer and branch names below arrive from a request (a server route, the
 *  CLI), so both are checked before anything touches git. The leading-"-"
 *  and "@{" checks on the branch are explicit rather than left to
 *  check-ref-format, since the point of both is to keep a request-supplied
 *  name from ever reaching a later git call (branch, update-ref, ...)
 *  looking like a flag or a shorthand git resolves against the repo's own
 *  reflog (check-ref-format --branch accepts "@{-1}", the previous branch,
 *  and expands it to whatever that happens to be here) instead of the
 *  literal name asked for. */
function assertPeerName(peer: string): void {
  if (!isPeerName(peer)) throw new Error(`not a peer name: ${peer}`);
}

async function assertBranchName(repo: string, branch: string): Promise<void> {
  if (branch.startsWith("-") || branch.includes("@{")) throw new Error(`not a branch name: ${branch}`);
  const r = await git(repo, ["check-ref-format", "--branch", branch]);
  if (r.code !== 0) throw new Error(`not a branch name: ${branch}`);
}

/** Whether landing `wip` as files here (a read-tree onto the worktree)
 *  would silently drop or corrupt part of it: true when any path the WIP
 *  adds relative to HEAD is blocked on disk, checked component by
 *  component from the repo root down rather than by lstat'ing the leaf
 *  alone. The leaf existing at all is occupied, the same as before; a
 *  parent component that exists but isn't a real directory — an ignored
 *  file, or an ignored symlink to one elsewhere — is occupied too, since
 *  read-tree would have to remove it to make room for the real directory
 *  the WIP needs, and does that silently rather than failing. Every check
 *  is an lstat, which never follows a symlink, so a symlinked folder in
 *  the way counts as occupied in its own right rather than as whatever it
 *  happens to point at (a leaf lstat on the full path would instead
 *  traverse through it, often landing on ENOENT past the symlink and
 *  reading the path as free). */
async function wipOccupiesPath(repo: string, wip: string): Promise<boolean> {
  const d = await git(repo, ["diff-tree", "-r", "-z", "--name-only", "--diff-filter=A", "HEAD", wip]);
  for (const p of d.stdout.split("\0").filter(Boolean)) {
    const segments = p.split("/").filter(Boolean);
    let prefix = "";
    for (let i = 0; i < segments.length; i++) {
      prefix = prefix === "" ? segments[i]! : `${prefix}/${segments[i]}`;
      let st;
      try {
        st = await lstat(join(repo, prefix));
      } catch (err) {
        // Only "genuinely not there" (ENOENT) clears it, and clears
        // everything below it too, since a filesystem path can't exist
        // under a parent that doesn't: move on to the next added path.
        // Anything else (a permissions error, and so on) can't be told
        // apart from occupied, so it counts as one.
        const code = typeof err === "object" && err !== null && "code" in err ? (err as Record<string, unknown>).code : undefined;
        if (code === "ENOENT") break;
        return true;
      }
      const isLeaf = i === segments.length - 1;
      if (isLeaf || !st.isDirectory()) return true;
    }
  }
  return false;
}

/** Creates branch `name` at `hash`. Returns the name on success; returns
 *  null only when someone else created that exact name in the meantime (a
 *  race a caller can retry under the next candidate name); any other
 *  failure throws, since nothing about retrying would make it succeed (a
 *  full disk, a locked ref, a name git itself refuses for some other
 *  reason) and a caller that only re-checked "does this name exist yet"
 *  before retrying would loop on it forever. */
async function createBranch(repo: string, name: string, hash: string): Promise<string | null> {
  const c = await git(repo, ["branch", name, hash]);
  if (c.code === 0) return name;
  const now = await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}`]);
  if (now.code === 0) return null; // someone else landed here first: try the next name
  throw new Error(c.stderr.trim());
}

/** Whether `name` is the branch some worktree here — the main one or a
 *  linked one made with `git worktree add` — currently has checked out.
 *  update-ref, unlike checkout, does not refuse to move a branch out from
 *  under whoever has it checked out, so this is what landWip checks
 *  instead before treating it as free to replace. A worktree listing git
 *  itself can't produce is treated as "in use": refusing to replace is the
 *  safe side of not being able to tell. */
async function branchInUse(repo: string, name: string): Promise<boolean> {
  const r = await git(repo, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return true;
  return r.stdout.split("\n").includes(`branch refs/heads/${name}`);
}

/** Lands a WIP hash on a scratch branch. wip/<peer>/<branch> is used when
 *  it is free, or replaced in place (a compare-and-swap on its current
 *  tip) when it already exists, is not checked out anywhere, and is
 *  untouched since canopy last put a WIP there (its tip's committer is
 *  "canopy", the identity snapshotWip commits with). A branch the user has
 *  since committed onto, or is still looking at in another worktree, is
 *  never moved: local branches only ever move forward, so the take lands
 *  on wip/<peer>/<branch>-2 and up instead — reusing one already at this
 *  exact hash (a repeat take of the same WIP while the base stays
 *  blocked), otherwise the first free one. */
async function landWip(repo: string, peer: string, branch: string, hash: string): Promise<string> {
  const base = `wip/${peer}/${branch}`;
  const cur = await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${base}`]);
  if (cur.code !== 0) {
    const made = await createBranch(repo, base, hash);
    if (made !== null) return made;
  } else {
    const old = cur.stdout.trim();
    if (old === hash) return base; // already exactly this WIP
    const committer = await git(repo, ["log", "-1", "--format=%cn", `refs/heads/${base}`]);
    if (committer.code === 0 && committer.stdout.trim() === "canopy" && !(await branchInUse(repo, base))) {
      const r = await git(repo, ["update-ref", `refs/heads/${base}`, hash, old]);
      if (r.code === 0) return base;
    }
  }
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`;
    const exists = await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}`]);
    if (exists.code === 0) {
      if (exists.stdout.trim() === hash) return name; // already exactly this WIP
      continue;
    }
    const made = await createBranch(repo, name, hash);
    if (made !== null) return made;
  }
}

/** Lands a peer's WIP here: as uncommitted files when the tree is clean,
 *  HEAD is the WIP's parent, and nothing on disk already occupies a path
 *  it adds; otherwise as a scratch branch (see landWip). */
export async function takeWip(repo: string, peer: string, branch: string): Promise<{ how: "files" | "branch"; branch?: string }> {
  assertPeerName(peer);
  await assertBranchName(repo, branch);
  const ref = `refs/peer-wip/${peer}/${branch}`;
  const wip = await git(repo, ["rev-parse", "-q", "--verify", ref]);
  if (wip.code !== 0) throw new Error(`no WIP from ${peer} on ${branch}`);
  const hash = wip.stdout.trim();
  const parent = await git(repo, ["rev-parse", "-q", "--verify", `${hash}^`]);
  const head = await git(repo, ["rev-parse", "-q", "--verify", "HEAD"]);
  const onParent = parent.code === 0 && head.code === 0 && head.stdout.trim() === parent.stdout.trim();
  const clear = onParent && !(await isDirty(repo)) && !(await isBusy(repo)) && !(await wipOccupiesPath(repo, hash));
  if (clear) {
    const r = await git(repo, ["read-tree", "-u", "-m", "HEAD", hash]);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    const done = await git(repo, ["reset", "--quiet"]);
    if (done.code !== 0) throw new Error(done.stderr.trim());
    return { how: "files" as const };
  }
  return { how: "branch" as const, branch: await landWip(repo, peer, branch, hash) };
}

export async function trackBranch(repo: string, peer: string, branch: string): Promise<void> {
  assertPeerName(peer);
  await assertBranchName(repo, branch);
  const tip = await git(repo, ["rev-parse", "-q", "--verify", `refs/remotes/${peer}/${branch}`]);
  if (tip.code !== 0) throw new Error(`${peer} has no branch ${branch}`);
  const r = await git(repo, ["branch", "--no-track", branch, tip.stdout.trim()]);
  if (r.code !== 0) throw new Error(r.stderr.trim());
}
