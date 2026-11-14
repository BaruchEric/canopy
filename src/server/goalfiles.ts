/** A goal's files folder (FR-067): the files Eric brings to a goal started
 *  from the top, kept under the coordinator's seeds at
 *  `<CANOPY_COORD_ROOT>/goal-files/<run id>/`, the same path in the canopy
 *  and coordinator containers. It outlives the coordinator's run, so a card's
 *  worker still reads it, and `pruneGoalFiles` takes it a week after its
 *  newest file once the run is gone. Node's fs, so the server's alone; the
 *  names come from `goalFileNames` in core/coordinator.ts. */

import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/** the folder under the seeds that holds every goal's files folder */
const GOAL_FILES = "goal-files";
/** how long a goal's files stay after their newest change, once its run is not live */
export const GOAL_FILES_KEEP = 7 * 24 * 60 * 60_000;
/** a run's id, the only folder name a prune takes */
const RUN_ID = /^[0-9a-f]{8}$/;

export interface GoalFile {
  /** a name from `goalFileNames`: one plain path part */
  name: string;
  data: Uint8Array;
}

/** where the goal started as run `runId` keeps its files */
export const goalFilesDir = (seeds: string, runId: string): string => join(seeds, GOAL_FILES, runId);

const plainName = (name: string): boolean => name !== "" && name !== "." && name !== ".." && !name.includes("\0") && basename(name) === name;

/** Writes a goal's files into `dir`, made here 0700 and never one that is
 *  there already, each file 0600 and new. A name that is not one plain path
 *  part is refused before anything is made, and a write that fails partway
 *  removes the folder it made, so a throw leaves nothing of this call's. */
export async function writeGoalFiles(dir: string, files: readonly GoalFile[]): Promise<void> {
  for (const f of files) if (!plainName(f.name)) throw new Error(`not a plain file name: ${f.name}`);
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  try {
    await chmod(dir, 0o700);
    for (const f of files) await writeFile(join(dir, f.name), f.data, { mode: 0o600, flag: "wx" });
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** The plain files in a goal's folder by name, sorted; none when there is no
 *  folder. A link or a folder inside is never one of them. */
export async function goalFileList(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}

/** the newest mtime of anything in `dir`, or its own when it is empty; null when it does not read */
async function newestIn(dir: string): Promise<number | null> {
  try {
    const names = await readdir(dir);
    const times = await Promise.all(names.map(async (n) => (await lstat(join(dir, n))).mtimeMs));
    return times.length > 0 ? Math.max(...times) : (await lstat(dir)).mtimeMs;
  } catch {
    return null;
  }
}

/** Removes each goal's files folder whose run is not in `live` and whose
 *  newest entry is more than `GOAL_FILES_KEEP` before `now`, and answers the
 *  run ids it removed. Only a real folder named like a run id is taken, never
 *  a link or a file, and a seeds path that is not absolute takes nothing.
 *  It makes nothing: with no goal-files folder there is nothing to do. */
export async function pruneGoalFiles(seeds: string, live: ReadonlySet<string>, now: number): Promise<string[]> {
  if (!isAbsolute(seeds)) return [];
  const root = join(seeds, GOAL_FILES);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !RUN_ID.test(e.name) || live.has(e.name)) continue;
    const dir = join(root, e.name);
    const newest = await newestIn(dir);
    if (newest === null || now - newest <= GOAL_FILES_KEEP) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(e.name);
    } catch {
      // the next prune tries again
    }
  }
  return removed;
}
