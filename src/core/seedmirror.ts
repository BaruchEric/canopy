/**
 * A seed as plain data: a bundle of every ref and HEAD, made by git in the
 * seed through `git()`'s seam (the stage runner on an isolated backend,
 * guarded git here otherwise) and streamed into a file canopy owns. A bundle
 * is a pack and a ref list, so canopy reads and clones it without running
 * anything of the seed's: the ship clones a bundle (spec amendment 4,
 * ruling 6). Bun.
 */
import { exec, gitToFile } from "./exec";
import { inQuietSeed, seedHeld } from "./seedgit";

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** HEAD's commit in a bundle's ref list (`git bundle list-heads`), or null */
export function bundleHead(listing: string): string | null {
  for (const line of listing.split("\n")) {
    const [sha, ref] = line.trim().split(" ");
    if (ref === "HEAD" && sha && SHA.test(sha)) return sha;
  }
  return null;
}

/** Writes a bundle of the seed (every ref, and HEAD) to `file`, once the
 *  seed is quiet, and answers its HEAD commit. Throws with the reason on a
 *  seed canopy will not run git in, one with no commit, or any other
 *  failure. */
export async function bundleSeed(seedPath: string, file: string, timeoutMs = 300_000): Promise<{ head: string }> {
  const made = await inQuietSeed(seedPath, async () => {
    const r = await gitToFile(seedPath, ["bundle", "create", "-", "--all", "HEAD"], file, timeoutMs);
    // a seed held now (busy, or its runner away) is waited out, not failed
    if (seedHeld(r.stderr)) throw new Error(r.stderr.trim());
    return r;
  });
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
