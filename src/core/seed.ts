/**
 * A sprout's seed: the git repo at `<root>/_incubator/<slug>` that the scan
 * shows as a card and every stage's agent works in. canopy makes it,
 * writes the `.canopy/` files the spec names, and commits them as itself.
 * The agent writes these files too, so canopy reads and writes them as plain
 * files only: never through a symlink anywhere below the seed, never a file
 * with another hard link, never past 256 KB.
 */
import { constants, lstatSync, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { exec, git } from "./exec";
import { networkOrigin } from "./peersync";
import { inQuietSeed, seedHeld } from "./seedgit";
import { isSproutId, urlWithoutSecret } from "./sprout";

export const SEED_READ_MAX = 256 * 1024;

/** what a clone may carry that would change how Claude runs in the seed:
 *  clarify runs with `--setting-sources user,project,local`, so a stranger's
 *  project settings could add hooks or allow rules */
const AGENT_SETTINGS = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];

/** environment identity, not config: the backend's own git identity may be
 *  unset (a container), and these commits are canopy's */
const identity = (self: string): Record<string, string> => ({
  GIT_AUTHOR_NAME: "canopy",
  GIT_AUTHOR_EMAIL: `canopy@${self}`,
  GIT_COMMITTER_NAME: "canopy",
  GIT_COMMITTER_EMAIL: `canopy@${self}`,
});

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/** Every git call canopy makes in a seed: a seed may be a stranger's
 *  clone, so no hook of anyone's runs (a clone carries none, but the
 *  user's init template or global config could name some, and the agent
 *  could plant one in the seed's own config), nor an fsmonitor, which is a
 *  command too. Filters stay: git has no one switch that turns every clean
 *  and smudge driver off. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
/** and a path is only ever the file it names; the calls that need pathspec
 *  magic (`:(icase)`) take NO_HOOKS alone */
const QUIET = [...NO_HOOKS, "--literal-pathspecs"];
/** canopy's own commits, which nothing may refuse or sign */
const COMMIT = [...QUIET, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify"];

const errCode = (e: unknown): string | undefined =>
  e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;

/** lstat, or null when nothing is there */
async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

/** the folders and file name of `rel`, refusing anything that is not a plain
 *  relative path below the seed */
function partsOf(rel: string): string[] {
  const parts = rel.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  if (isAbsolute(rel) || parts.length === 0 || parts.includes("..")) {
    throw new Error(`${rel || "(empty)"} is not a path inside the seed`);
  }
  return parts;
}

const linkError = (rel: string): Error => new Error(`${rel} goes through a symlink; canopy uses only plain files in the seed`);

/**
 * Where `rel` lands in the seed, checked: the seed and every folder on the
 * way are real folders, not symlinks, and the file's folder resolves inside
 * the seed. With `make`, missing folders are made one at a time, each checked
 * as it appears. Null when a folder on the way is missing and `make` is off.
 * The file itself is checked by the caller.
 */
async function place(path: string, rel: string, make: boolean): Promise<string | null> {
  const parts = partsOf(rel);
  const root = await lstatOrNull(path);
  if (!root) {
    if (make) throw new Error(`${path} is not a seed`);
    return null;
  }
  if (root.isSymbolicLink()) throw linkError(rel);
  if (!root.isDirectory()) throw new Error(`${path} is not a folder`);
  let cur = path;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    let st = await lstatOrNull(cur);
    if (!st) {
      if (!make) return null;
      await mkdir(cur).catch((e: unknown) => {
        if (errCode(e) !== "EEXIST") throw e;
      });
      st = await lstat(cur);
    }
    if (st.isSymbolicLink()) throw linkError(rel);
    if (!st.isDirectory()) throw new Error(`${rel} is not under a folder`);
  }
  // a folder swapped for a symlink between the walk and here still lands
  // outside, which this catches
  const out = relative(await realpath(path), await realpath(cur));
  if (out === ".." || out.startsWith(`..${sep}`) || isAbsolute(out)) throw linkError(rel);
  return join(cur, parts[parts.length - 1] ?? "");
}

/** refuse a file the agent could have pointed elsewhere: a symlink, a hard
 *  link to a file outside the seed, or anything that is not a plain file */
function checkFile(rel: string, st: Stats): void {
  if (st.isSymbolicLink()) throw linkError(rel);
  if (!st.isFile()) throw new Error(`${rel} is not a file`);
  if (st.nlink > 1) throw new Error(`${rel} has another hard link; canopy uses only plain files in the seed`);
}

export async function commitSeed(path: string, rels: string[], message: string, self: string): Promise<boolean> {
  const present: string[] = [];
  for (const rel of rels) {
    const file = await place(path, rel, false);
    const st = file ? await lstatOrNull(file) : null;
    if (!st) continue;
    checkFile(rel, st);
    present.push(rel);
  }
  if (present.length === 0) return false;
  // -f: a clone's .gitignore or the global excludes may well name .canopy/
  const add = await git(path, [...QUIET, "add", "-f", "--", ...present]);
  if (add.code !== 0) throw new Error(`git add: ${firstLine(add.stderr)}`);
  const staged = await git(path, [...QUIET, "diff", "--cached", "--quiet", "--", ...present]);
  if (staged.code === 0) return false;
  const c = await git(path, [...COMMIT, "-m", message, "--", ...present], 30_000, identity(self));
  if (c.code !== 0) throw new Error(`git commit: ${firstLine(c.stderr)}`);
  return true;
}

/** take the clone's own agent settings out, as canopy's commit, so the
 *  first agent run in the seed never reads them. A `.claude` that is a
 *  symlink or a file goes whole, since its settings cannot be told apart.
 *  Names match in any letter case: a case-insensitive disk (APFS) hands
 *  Claude a tracked `.Claude/settings.json` as `.claude/settings.json`. */
export async function dropAgentSettings(path: string, self: string): Promise<void> {
  const claude = await lstatOrNull(join(path, ".claude"));
  const names = claude && !claude.isDirectory() ? [".claude", ".mcp.json"] : AGENT_SETTINGS;
  const specs = names.map((n) => `:(icase)${n}`);
  const listed = await git(path, [...NO_HOOKS, "ls-files", "-z", "--", ...specs]);
  if (listed.code !== 0) throw new Error(`git ls-files: ${firstLine(listed.stderr)}`);
  const tracked = listed.stdout.split("\0").filter((n) => n !== "");
  const onDisk: string[] = [];
  for (const n of names) if (await lstatOrNull(join(path, n))) onDisk.push(n);
  if (tracked.length === 0 && onDisk.length === 0) return;
  if (tracked.length > 0) {
    const r = await git(path, [...QUIET, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...tracked]);
    if (r.code !== 0) throw new Error(`git rm: ${firstLine(r.stderr)}`);
  }
  // the files themselves, tracked under any case or not tracked at all
  for (const n of [...tracked, ...onDisk]) await rm(join(path, n), { recursive: true, force: true });
  // committed by the names the index had, since a commit's pathspec must
  // match something git knows
  const staged = tracked.length > 0 ? await git(path, [...QUIET, "diff", "--cached", "--quiet", "--", ...tracked]) : null;
  if (staged && staged.code !== 0) {
    const c = await git(path, [...COMMIT, "-m", "seed: drop the cloned project's agent settings", "--", ...tracked], 30_000, identity(self));
    if (c.code !== 0) throw new Error(`git commit: ${firstLine(c.stderr)}`);
  }
  // nothing of them may be left, in the index or on disk, or makeSeed takes
  // the seed back rather than leave it for a run
  const left = await git(path, [...NO_HOOKS, "status", "--porcelain", "-z", "--ignored", "--", ...specs]);
  const still = await git(path, [...NO_HOOKS, "ls-files", "-z", "--", ...specs]);
  if (left.code !== 0 || still.code !== 0 || left.stdout !== "" || still.stdout !== "") {
    throw new Error("the cloned project's agent settings are still in the seed");
  }
}

/** the folder under the launch root that seeds are built in, a dot folder
 *  the scan never walks into */
export const MAKING_DIR = ".canopy-making";

/** Where a seed is built before it moves into place: under the launch
 *  root's `.canopy-making`, beside the seeds folder rather than in it. A
 *  clone writes its url, token and all, into its `.git/config` until canopy
 *  sets it clean, and the stages container mounts the seeds folder, so the
 *  clone happens where no stage can read it; on the same disk, so the move
 *  into place stays one rename. A seed folder is there only once it is
 *  whole, so a restart in the middle of a clone, or between the clone and
 *  taking its agent settings out, leaves nothing a later prepare would take
 *  as made. It is named for the sprout as well as the slug: a sprout stopped
 *  and dismissed mid-clone frees its slug for a new intake, and the two
 *  attempts must not clear each other's folder. */
export const seedWorkPath = (path: string, id: string): string => join(dirname(dirname(path)), MAKING_DIR, `${basename(path)}.${id}`);

export async function makeSeed(
  path: string,
  files: Record<string, string>,
  clone: string | undefined,
  opts: { self: string; id: string; originOk?: (url: string) => boolean; cloneTimeoutMs?: number },
): Promise<void> {
  // it names the work folder, so it is checked like any path component
  if (!isSproutId(opts.id)) throw new Error(`${opts.id || "(empty)"} is not a sprout id`);
  if (await lstatOrNull(path)) throw new Error(`${path} is there already`);
  if (clone && !(opts.originOk ?? networkOrigin)(clone)) throw new Error(`not a network git url: ${urlWithoutSecret(clone)}`);
  await mkdir(dirname(path), { recursive: true });
  const work = seedWorkPath(path, opts.id);
  // what this sprout's attempt a restart cut short left behind
  await rm(work, { recursive: true, force: true });
  await mkdir(dirname(work), { recursive: true });
  // made here, not by git, so the folder is surely this call's to take back
  await mkdir(work).catch((e: unknown) => {
    throw errCode(e) === "EEXIST" ? new Error(`${work} is being made already`) : e;
  });
  try {
    if (clone) {
      const r = await exec(["git", ...QUIET, "clone", "--quiet", "--", clone, work], {
        timeoutMs: opts.cloneTimeoutMs ?? 600_000,
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      // git may name the url in its error, token and all, in any form
      // (rewritten by an insteadOf, say), so every http(s) userinfo goes
      const said = firstLine(r.stderr).split(clone).join(urlWithoutSecret(clone)).replace(/(https?:\/\/)[^@/\s]+@/gi, "$1");
      if (r.code !== 0) throw new Error(`git clone failed: ${said}`);
      const mv = await git(work, [...NO_HOOKS, "remote", "rename", "origin", "upstream"]);
      if (mv.code !== 0) throw new Error(`git remote rename: ${firstLine(mv.stderr)}`);
      // a token the clone needed stays out of the seed's .git/config
      const clean = urlWithoutSecret(clone);
      if (clean !== clone) {
        const set = await git(work, [...NO_HOOKS, "remote", "set-url", "upstream", clean]);
        if (set.code !== 0) throw new Error(`git remote set-url: ${firstLine(set.stderr)}`);
      }
    } else {
      const r = await git(work, [...QUIET, "init", "-q", "-b", "main"]);
      if (r.code !== 0) throw new Error(`git init: ${firstLine(r.stderr)}`);
    }
    for (const [rel, text] of Object.entries(files)) await writeSeed(work, rel, text);
    await commitSeed(work, Object.keys(files), "seed: a new project from the incubator", opts.self);
    if (clone) await dropAgentSettings(work, opts.self);
    // a rename onto an empty folder made meanwhile would replace it without a word
    if (await lstatOrNull(path)) throw new Error(`${path} is there already`);
    await rename(work, path);
  } catch (e) {
    // a half-made seed would block the retry, and a clone that still has
    // its own agent settings must not be left for a run to find
    await rm(work, { recursive: true, force: true });
    throw e;
  }
}

/** a file the agent wrote, or null when it is not there */
export async function readSeed(path: string, rel: string): Promise<string | null> {
  const file = await place(path, rel, false);
  if (!file) return null;
  const st = await lstatOrNull(file);
  if (!st) return null;
  checkFile(rel, st);
  if (st.size > SEED_READ_MAX) throw new Error(`${rel} is over 256 KB`);
  // no-follow so a swap after the lstat fails instead of following the link,
  // non-blocking so a fifo swapped in cannot hang the read
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e: unknown) => {
    throw errCode(e) === "ELOOP" ? linkError(rel) : e;
  });
  try {
    const now = await fh.stat();
    checkFile(rel, now);
    const buf = Buffer.alloc(SEED_READ_MAX + 1);
    let got = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
      if (got > SEED_READ_MAX) throw new Error(`${rel} is over 256 KB`);
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function writeSeed(path: string, rel: string, text: string): Promise<void> {
  const file = await place(path, rel, true);
  if (!file) throw new Error(`${rel} is not a path inside the seed`);
  const st = await lstatOrNull(file);
  if (st) checkFile(rel, st);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fh = await open(file, flags, 0o644).catch((e: unknown) => {
    throw errCode(e) === "ELOOP" ? linkError(rel) : e;
  });
  try {
    // checked again on the open file before anything in it changes
    checkFile(rel, await fh.stat());
    await fh.truncate(0);
    await fh.writeFile(text, "utf8");
  } finally {
    await fh.close();
  }
}

/** the seed operations as the Incubator takes them; `committed` hears of
 *  each seed canopy committed in (the server syncs its mirror) */
export function seedOps(self: string, committed?: (path: string) => void) {
  return {
    make: (path: string, files: Record<string, string>, clone: string | undefined, id: string) => makeSeed(path, files, clone, { self, id }),
    read: readSeed,
    write: writeSeed,
    /** the seed's HEAD after the commit, which the ship holds the seed to */
    commit: async (path: string, rels: string[], message: string): Promise<string> => {
      // a busy seed (its own stage alive on an isolated backend, any
      // stage on an unisolated one) is waited out; a commit already made
      // stages nothing the second time
      const head = await inQuietSeed(path, async () => {
        await commitSeed(path, rels, message, self);
        const r = await git(path, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
        if (seedHeld(r.stderr)) throw new Error(r.stderr.trim());
        if (r.code !== 0) throw new Error(`the seed has no commit after canopy's: ${firstLine(r.stderr)}`);
        return r.stdout.trim();
      });
      committed?.(path);
      return head;
    },
    /** the seed's HEAD, once it is quiet, with nothing committed */
    headOf: (path: string): Promise<string> =>
      inQuietSeed(path, async () => {
        const r = await git(path, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
        if (seedHeld(r.stderr)) throw new Error(r.stderr.trim());
        if (r.code !== 0) throw new Error(`the seed has no commit: ${firstLine(r.stderr)}`);
        return r.stdout.trim();
      }),
    /** a dangling symlink counts as there, as makeSeed would refuse it */
    exists: (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
  };
}
