/**
 * The incubator's leftovers sweep. canopy makes folders for a sprout and
 * takes them back when it is done with them; a crash, a restart mid-step or
 * a removal that failed leaves them behind, and nothing else ever looks at
 * them again:
 *
 * - `<root>/.canopy-making/<slug>.<id>`, a seed being cloned (seed.ts), and
 *   `<slug>.<id>.rework`, a renovate or extend seed being rebuilt (seedsource.ts)
 * - `<seeds>/.shared/.tmp-<pid>-<hex>`, a shared copy being built (stageshare.ts)
 * - `<seeds>/.shared/{inputs,workspace,record}/<id>`, a sprout's shared copies
 * - `<root>/.canopy-mirrors/<slug>`, the peer gate's mirror of a seed (seedmirror.ts)
 * - `<config>/incubator/.dismissed/<id>`, a dismissed sprout's record and inputs
 *
 * The canopy that keeps the incubator (the flows lock holder) runs it at its
 * start and every 6 hours (server/index.ts). It removes only a real folder
 * under a name canopy makes, never a link, never what a sprout on the list
 * holds, and never anything younger than its safe age. A sprout's shared
 * copies go only once this canopy dismissed it: another canopy with its own
 * config folder can keep sprouts on the same launch root. Bun.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAKING_DIR } from "./seed";
import { MIRRORS_DIR, mirrorSlug } from "./seedmirror";
import { isSproutId, SEEDS_DIR } from "./sprout";
import { DISMISSED_DIR } from "./sproutstore";
import { SHARED_DIR } from "./stageshare";
import type { Sprout } from "./types";

/** how old a leftover must be: a clone stops at 10 minutes and a shared
 *  copy builds in seconds, so a day-old one is no live step's */
export const LEFTOVER_AGE = 24 * 3600_000;
/** how long a dismissed sprout's record and inputs are kept */
export const DISMISSED_KEEP = 14 * 24 * 3600_000;
/** how often the server sweeps */
export const LEFTOVER_EVERY = 6 * 3600_000;

const SHARED_KINDS = ["inputs", "workspace", "record"] as const;
/** seedWorkPath's name, the seed's slug, a dot and the sprout's id, and reworkPath's, which adds `.rework` */
const MAKING_NAME = /^[a-z0-9][a-z0-9-]*\.(sp_[0-9a-f]{12})(?:\.rework)?$/;
/** stageshare's scratch folder: its pid and a random suffix */
const TMP_NAME = /^\.tmp-\d+-[0-9a-f]+$/;

export interface LeftoverPlaces {
  /** the launch root, which holds the seeds folder, the making folder and the mirrors */
  root: string;
  /** the incubator's store under the config folder (`incubatorDir()`) */
  store: string;
}

const names = (dir: string): Promise<string[]> => readdir(dir).catch(() => [] as string[]);

/** a real folder's mtime, ms; null for a link, a file or nothing */
async function folderTime(path: string): Promise<number | null> {
  const st = await lstat(path).catch(() => null);
  return st?.isDirectory() ? st.mtimeMs : null;
}

const there = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Removes what is left over, by the rules above, as of `now`, and answers
 *  the paths it removed. `sprouts` is every sprout on the incubator's list,
 *  ended or not. */
export async function sweepLeftovers(at: LeftoverPlaces, sprouts: readonly Pick<Sprout, "id" | "slug">[], now: number): Promise<string[]> {
  const ids = new Set(sprouts.map((s) => s.id));
  const slugs = new Set(sprouts.map((s) => s.slug));
  const seeds = join(at.root, SEEDS_DIR);
  const shared = join(seeds, SHARED_DIR);
  const dismissedDir = join(at.store, DISMISSED_DIR);
  const gone: string[] = [];
  /** the folder, when it is a real one older than `age` */
  const takeOld = async (path: string, age: number, also: number | null = null): Promise<void> => {
    const t = await folderTime(path);
    if (t === null || now - Math.max(t, also ?? 0) <= age) return;
    try {
      await rm(path, { recursive: true, force: true });
      gone.push(path);
    } catch {
      // the next sweep tries again
    }
  };

  for (const name of await names(join(at.root, MAKING_DIR))) {
    const id = MAKING_NAME.exec(name)?.[1];
    if (id === undefined || ids.has(id)) continue;
    await takeOld(join(at.root, MAKING_DIR, name), LEFTOVER_AGE);
  }

  for (const name of await names(shared)) {
    if (TMP_NAME.test(name)) await takeOld(join(shared, name), LEFTOVER_AGE);
  }

  // only sprouts this canopy dismissed, and none on the list
  const dismissed = (await names(dismissedDir)).filter((id) => isSproutId(id) && !ids.has(id));
  for (const kind of SHARED_KINDS) {
    for (const id of dismissed) await takeOld(join(shared, kind, id), LEFTOVER_AGE);
  }

  for (const name of await names(join(at.root, MIRRORS_DIR))) {
    // a mirror is a seed's while the seed is there, or its sprout is on the list
    if (mirrorSlug(name) === null || slugs.has(name) || (await there(join(seeds, name)))) continue;
    const mirror = join(at.root, MIRRORS_DIR, name);
    // a sync writes inside .git, which moves its time and not the top folder's
    await takeOld(mirror, LEFTOVER_AGE, await folderTime(join(mirror, ".git")));
  }

  for (const id of dismissed) {
    // its shared copies first, so a sweep that could not take them tries again
    const left = await Promise.all(SHARED_KINDS.map((kind) => there(join(shared, kind, id))));
    if (!left.some(Boolean)) await takeOld(join(dismissedDir, id), DISMISSED_KEEP);
  }
  return gone;
}
