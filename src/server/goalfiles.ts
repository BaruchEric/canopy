/** A goal's files folder (FR-067): the files Eric brings to a goal started
 *  from the top, kept under the coordinator's seeds at
 *  `<CANOPY_COORD_ROOT>/goal-files/<run id>/`, the same path in the canopy
 *  and coordinator containers. It outlives the coordinator's run, so a card's
 *  worker still reads it, and `pruneGoalFiles` takes it a week after its
 *  newest file once the run is gone. Node's fs, so the server's alone; the
 *  names come from `goalFileNames` in core/coordinator.ts. */

import { constants, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
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
const sizeWords = (n: number): string => (n % MB === 0 ? `${n / MB} MB` : `${n} bytes`);

/** A refusal in words a card's outcome carries. Any other error on the way
 *  (EACCES, EIO) is put as "<name> could not be read", so no host path
 *  reaches the card. */
class Refused extends Error {}

/** Test seams: a step run between the folder's check and the open, where a
 *  swap of the folder would land, and one run just after the open file's
 *  stat, where a swap back or a write that grows the file would. */
export interface GoalReadRace {
  beforeOpen?: () => Promise<void>;
  afterOpen?: () => Promise<void>;
}

export interface GoalReadMore {
  /** what the card's files have left of their total, and the words a file
   *  that would pass it is refused with */
  room?: { bytes: number; over: string };
  race?: GoalReadRace;
}

/** One goal file's bytes, for a project card's intake in the incubator
 *  (FR-067). The coordinator can rewrite its goal's folder, and the bytes
 *  leave its reach for the incubator's, so nothing is read through a link:
 *  the folder must be the goal's own under the seeds, and the file a plain
 *  file of its own, opened without following a link swapped in after the
 *  list. After the open, the file canopy holds must still be the one at the
 *  goal's own path (its device and inode against an lstat there, and on
 *  Linux the kernel's own path for the open file), and the folder must
 *  still be no link, so a folder swapped for a link between the check and
 *  the open is caught too. A file over `max` bytes, or over the card's room
 *  left, is refused before it is read, and the read stops one byte past
 *  the size the open file's stat gave, so a file that grows is refused
 *  without reading on to its end. Each refusal names the file, in words a card's outcome
 *  carries. */
export async function readGoalFile(seeds: string, runId: string, name: string, max: number, more: GoalReadMore = {}): Promise<Uint8Array> {
  try {
    return await readChecked(seeds, runId, name, max, more);
  } catch (e) {
    if (e instanceof Refused) throw e;
    console.error(`goal files: ${name} for ${runId} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(`${name} could not be read`);
  }
}

async function readChecked(seeds: string, runId: string, name: string, max: number, { room, race }: GoalReadMore): Promise<Uint8Array> {
  if (!plainName(name)) throw new Refused(`not a plain file name: ${name}`);
  const dir = goalFilesDir(seeds, runId);
  const real = await realpath(dir).catch(() => null);
  if (real === null) throw new Refused("the goal's files folder is gone");
  const expected = goalFilesDir(await realpath(seeds), runId);
  if (real !== expected) throw new Refused("the goal's files folder is a link; canopy reads no goal file through one");
  const path = join(expected, name);
  await race?.beforeOpen?.();
  let fh: FileHandle;
  try {
    // non-blocking, so a fifo swapped in cannot hang the read
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (errCode(e) === "ELOOP") throw new Refused(`${name} is a link; canopy reads no goal file through one`);
    if (errCode(e) === "ENOENT") throw new Refused(`${name} is no longer in the goal's files folder`);
    throw e;
  }
  try {
    const st = await fh.stat();
    await race?.afterOpen?.();
    if (!(await stillHere(fh, st, dir, expected, path))) throw new Refused(`the goal's files folder changed while canopy opened ${name}; canopy reads no goal file through a link`);
    if (!st.isFile()) throw new Refused(`${name} is not a plain file`);
    if (st.size > max) throw new Refused(`${name} is over ${sizeWords(max)}`);
    if (room && st.size > room.bytes) throw new Refused(room.over);
    const data = await readUpTo(fh, st.size + 1);
    if (data.byteLength > st.size) throw new Refused(`${name} grew while canopy read it`);
    return data;
  } finally {
    await fh.close();
  }
}

/** Whether the open file is still the goal's own at `path`: the same device
 *  and inode as an lstat there, the folder still resolving to itself, and,
 *  where the kernel says it (Linux's /proc/self/fd), the open file's own
 *  path. The first two leave a gap a swap undone and redone between them
 *  could pass; the kernel's path has none. */
async function stillHere(fh: FileHandle, st: { dev: number; ino: number }, dir: string, expected: string, path: string): Promise<boolean> {
  const at = await lstat(path).catch(() => null);
  if (!at || at.dev !== st.dev || at.ino !== st.ino) return false;
  if ((await realpath(dir).catch(() => null)) !== expected) return false;
  const held = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
  return held === null || held === path;
}

/** At most `cap` bytes from the start of the file, and no more. */
async function readUpTo(fh: FileHandle, cap: number): Promise<Uint8Array> {
  const buf = new Uint8Array(cap);
  let got = 0;
  while (got < cap) {
    const { bytesRead } = await fh.read(buf, got, cap - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** A card's goal files for its intake, in order, each read as
 *  `readGoalFile` reads it and handed back with what it came with, under a
 *  running total: the file that would take the card's files past `total`
 *  bytes is refused before it is read, so no more than the incubator takes
 *  is held before it is asked. */
export async function readGoalFiles<T extends { name: string }>(seeds: string, runId: string, files: readonly T[], max: number, total: number): Promise<(T & { data: Uint8Array })[]> {
  const over = `the card's goal files come to over ${sizeWords(total)}`;
  const out: (T & { data: Uint8Array })[] = [];
  let used = 0;
  for (const f of files) {
    const data = await readGoalFile(seeds, runId, f.name, max, { room: { bytes: total - used, over } });
    used += data.byteLength;
    out.push({ ...f, data });
  }
  return out;
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
