/** A goal's files folder (FR-067): the files Eric brings to a goal started
 *  from the top, kept under the coordinator's seeds at
 *  `<CANOPY_COORD_ROOT>/goal-files/<run id>/`, the same path in the canopy
 *  and coordinator containers. It outlives the coordinator's run, so a card's
 *  worker still reads it, and `pruneGoalFiles` takes it a week after its
 *  newest file once the run is gone. Node's fs, so the server's alone; the
 *  names come from `goalFileNames` in core/coordinator.ts. */

import { constants, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Run } from "../core/types";

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

const MB = 1024 * 1024;
const errCode = (e: unknown): string | undefined => (e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined);

/** One goal file's bytes, for a project card's intake in the incubator
 *  (FR-067). The coordinator can rewrite its goal's folder, and the bytes
 *  leave its reach for the incubator's, so nothing is read through a link:
 *  the folder must be the goal's own under the seeds, and the file a plain
 *  file of its own, opened without following a link swapped in after the
 *  list. A file over `max` bytes is refused before it is read. Each refusal
 *  names the file, in words a card's outcome carries. */
export async function readGoalFile(seeds: string, runId: string, name: string, max: number): Promise<Uint8Array> {
  if (!plainName(name)) throw new Error(`not a plain file name: ${name}`);
  const dir = goalFilesDir(seeds, runId);
  const real = await realpath(dir).catch(() => null);
  if (real === null) throw new Error("the goal's files folder is gone");
  if (real !== goalFilesDir(await realpath(seeds), runId)) throw new Error("the goal's files folder is a link; canopy reads no goal file through one");
  let fh: FileHandle;
  try {
    // non-blocking, so a fifo swapped in cannot hang the read
    fh = await open(join(real, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (errCode(e) === "ELOOP") throw new Error(`${name} is a link; canopy reads no goal file through one`);
    if (errCode(e) === "ENOENT") throw new Error(`${name} is no longer in the goal's files folder`);
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${name} is not a plain file`);
    const over = `${name} is over ${max % MB === 0 ? `${max / MB} MB` : `${max} bytes`}`;
    if (st.size > max) throw new Error(over);
    const data = await fh.readFile();
    if (data.byteLength > max) throw new Error(over);
    return data;
  } finally {
    await fh.close();
  }
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

/** Removes the goal started as run `runId`'s files folder at once, and
 *  answers whether it did: for a goal that ended before any card could
 *  read it. Only a real folder named like a run id under absolute seeds is
 *  taken, never a link or a file. */
export async function dropGoalFiles(seeds: string, runId: string): Promise<boolean> {
  if (!isAbsolute(seeds) || !RUN_ID.test(runId)) return false;
  const dir = goalFilesDir(seeds, runId);
  try {
    if (!(await lstat(dir)).isDirectory()) return false;
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The run ids whose files folder a prune keeps, from the runs at work now:
 *  every coordinator, and every goal whose folder a run reads through its
 *  added folders. A card's child, and a fix or follow-up on a card's
 *  branch, can run on after its goal ended. Only an added folder that is
 *  exactly one goal's folder under these seeds counts. */
export function liveGoalIds(seeds: string, active: readonly Pick<Run, "id" | "action" | "addDirs">[]): Set<string> {
  const root = resolve(seeds, GOAL_FILES);
  const live = new Set<string>();
  for (const run of active) {
    if (run.action === "coordinate") live.add(run.id);
    for (const dir of run.addDirs ?? []) {
      if (!isAbsolute(dir)) continue;
      const full = resolve(dir);
      if (dirname(full) === root && RUN_ID.test(basename(full))) live.add(basename(full));
    }
  }
  return live;
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
