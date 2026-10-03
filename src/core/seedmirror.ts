/**
 * A seed as plain data: a bundle of every ref and HEAD, made by git in the
 * seed through `git()`'s seam (the stage runner on an isolated backend,
 * guarded git here otherwise) and streamed into a file canopy owns. A bundle
 * is a pack and a ref list, so canopy reads and clones it without running
 * anything of the seed's: the ship clones a bundle (spec amendment 4,
 * ruling 6), and the peer gate serves a bare mirror canopy keeps from one
 * (ruling 7). Bun.
 */
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exec, git, gitToFile } from "./exec";
import { inQuietSeed, seedHeld } from "./seedgit";
import { SEEDS_DIR } from "./sprout";

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** where canopy keeps its seed mirrors, under the launch root. A dot
 *  folder, so the scan, the watcher's repo list and the gate's list pass
 *  over it. */
export const MIRRORS_DIR = ".canopy-mirrors";

/** a seed's folder name, when it can name a mirror: one plain segment */
export const mirrorSlug = (name: string): string | null => (/^[a-z0-9][a-z0-9._-]*$/i.test(name) && !name.endsWith(".git") ? name : null);

/** canopy's bare mirror of the seed `slug`. Named `.git` so a sync that
 *  leaves repos alone (the Mac's sync to the mini) leaves it alone too. */
export const mirrorPath = (root: string, slug: string): string => join(root, MIRRORS_DIR, slug, ".git");

/** HEAD's commit in a bundle's ref list (`git bundle list-heads`), or null */
export function bundleHead(listing: string): string | null {
  for (const line of listing.split("\n")) {
    const [sha, ref] = line.trim().split(" ");
    if (ref === "HEAD" && sha && SHA.test(sha)) return sha;
  }
  return null;
}

/** One try at a bundle of the seed into `file`: its HEAD commit, or what
 *  held it (the seed busy, its runner away). Throws on a seed with no
 *  commit, one canopy will not run git in, or any other failure. */
async function bundleNow(seedPath: string, file: string, timeoutMs: number): Promise<{ head: string } | { held: string }> {
  const made = await gitToFile(seedPath, ["bundle", "create", "-", "--all", "HEAD"], file, timeoutMs);
  if (seedHeld(made.stderr)) return { held: made.stderr.trim() };
  if (made.code !== 0) {
    if (/ambiguous argument 'HEAD'|unknown revision|empty bundle/i.test(made.stderr)) throw new Error("the seed has no commit yet");
    throw new Error(`git bundle of the seed: ${firstLine(made.stderr)}`);
  }
  // the bundle is canopy's file: read here, with nothing of the seed's
  const heads = await exec(["git", "bundle", "list-heads", file], { timeoutMs: 60_000 });
  const head = heads.code === 0 ? bundleHead(heads.stdout) : null;
  if (head === null) throw new Error(`the seed's bundle names no HEAD${heads.code !== 0 ? `: ${firstLine(heads.stderr)}` : ""}`);
  return { head };
}

/** Writes a bundle of the seed (every ref, and HEAD) to `file`, once the
 *  seed is quiet, and answers its HEAD commit. Throws with the reason on a
 *  seed canopy will not run git in, one with no commit, or any other
 *  failure. */
export async function bundleSeed(seedPath: string, file: string, timeoutMs = 300_000): Promise<{ head: string }> {
  return inQuietSeed(seedPath, async () => {
    const made = await bundleNow(seedPath, file, timeoutMs);
    // a seed held now is waited out, not failed
    if ("held" in made) throw new Error(made.held);
    return made;
  });
}

/** whether `path` is a whole bare repo canopy made: a real folder, no link */
async function isMirror(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isDirectory()) return false;
  return (await lstat(join(path, "HEAD")).catch(() => null))?.isFile() ?? false;
}

/** Why the gate must not serve canopy's mirror of the seed `slug` under
 *  `root`, or null: the seed itself is gone (its mirror stays), there is
 *  no mirror yet, or what is there is not the folder canopy keeps (a link
 *  along the way), or not a whole repo. */
export async function mirrorRefusal(root: string, slug: string): Promise<string | null> {
  // a mirror outlives its seed; a seed that is gone is not served from it
  const seed = await lstat(join(root, SEEDS_DIR, slug)).catch(() => null);
  if (!seed?.isDirectory()) return "there is no such seed";
  const path = mirrorPath(root, slug);
  const real = await realpath(path).catch(() => null);
  if (real === null) return "canopy has no mirror of this seed yet";
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null || real !== mirrorPath(realRoot, slug)) return "canopy's mirror of this seed is not where canopy keeps it";
  if (!(await isMirror(real))) return "canopy's mirror of this seed is not a whole repository";
  return null;
}

/** what one mirror sync did */
export type MirrorSync = "synced" | "same" | "held" | "empty";

/** The bare mirror of each seed the peer gate serves, at
 *  `<root>/.canopy-mirrors/<slug>/.git`. A sync takes the seed's refs and
 *  HEAD through `git()`'s seam and does nothing more while they match what
 *  the mirror last took and the mirror is there; otherwise it fetches a
 *  fresh bundle into the mirror (made again when gone), pruning what the
 *  seed dropped, and sets the mirror's HEAD detached at the seed's. Git in
 *  the mirror runs here: the mirror is canopy's own, which no stage can
 *  write. Syncs of one seed run one at a time; a seed held now (busy, its
 *  runner away) is left for the next sync. */
export class SeedMirrors {
  /** the refs and HEAD each mirror last took, by seed path */
  private readonly took = new Map<string, string>();
  private readonly chains = new Map<string, Promise<MirrorSync>>();

  constructor(
    private readonly root: string,
    private readonly timeoutMs = 300_000,
  ) {}

  /** where the seed at `seedPath` is mirrored, or null for a name no
   *  mirror takes */
  pathFor(seedPath: string): string | null {
    const slug = mirrorSlug(basename(seedPath));
    return slug === null ? null : mirrorPath(this.root, slug);
  }

  sync(seedPath: string): Promise<MirrorSync> {
    const prev = this.chains.get(seedPath);
    const before: Promise<unknown> = prev ? prev.catch(() => undefined) : Promise.resolve();
    const next = before.then(() => this.syncNow(seedPath));
    this.chains.set(seedPath, next);
    const clear = (): void => {
      if (this.chains.get(seedPath) === next) this.chains.delete(seedPath);
    };
    next.then(clear, clear);
    return next;
  }

  private async syncNow(seedPath: string): Promise<MirrorSync> {
    const mirror = this.pathFor(seedPath);
    if (mirror === null) throw new Error(`no mirror takes the seed name ${basename(seedPath)}`);
    const refs = await git(seedPath, ["for-each-ref", "--format=%(objectname) %(refname)"]);
    if (seedHeld(refs.stderr)) return "held";
    if (refs.code !== 0) throw new Error(`the seed's refs: ${firstLine(refs.stderr)}`);
    const head = await git(seedPath, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (seedHeld(head.stderr)) return "held";
    if (head.code !== 0) return "empty";
    const print = `${head.stdout.trim()}\n${refs.stdout}`;
    if (this.took.get(seedPath) === print && (await isMirror(mirror))) return "same";
    const tmp = await mkdtemp(join(tmpdir(), "canopy-mirror-"));
    try {
      const file = join(tmp, "seed.bundle");
      const made = await bundleNow(seedPath, file, this.timeoutMs);
      if ("held" in made) return "held";
      const run = async (what: string, args: string[]): Promise<void> => {
        const r = await exec(["git", ...args], { timeoutMs: this.timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
        if (r.code !== 0) throw new Error(`git ${what} in the seed's mirror: ${firstLine(r.stderr)}`);
      };
      if (!(await isMirror(mirror))) {
        // whatever stands there is not a mirror canopy made: made again
        await rm(dirname(mirror), { recursive: true, force: true });
        await mkdir(dirname(mirror), { recursive: true });
        await run("init", ["init", "-q", "--bare", "--", mirror]);
      }
      await run("fetch", ["-C", mirror, "fetch", "-q", "--prune", "--no-tags", "--update-head-ok", "--", file, "+refs/*:refs/*"]);
      await run("update-ref", ["-C", mirror, "update-ref", "--no-deref", "HEAD", made.head]);
      this.took.set(seedPath, print);
      return "synced";
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
