import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SWEPT_DAYS } from "./keep";
import { configDir } from "./store";
import type { SweepLogEntry, SweptChat } from "./types";

/* What the sweep keeps on disk: the chats it stopped, so a resume can start
 * from their session, and a short log of its passes. */

const DAY = 24 * 60 * 60 * 1000;
/** passes the log remembers */
const LOG_KEEP = 50;

export const sweepDir = (): string => join(configDir(), "sweep");

/** tells one write's temporary file from another's in the same process */
let writes = 0;

async function readList<T>(name: string): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(sweepDir(), name), "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// Write-then-rename, as the config does: a crash mid-write leaves the old
// file whole.
async function writeList(name: string, list: unknown[]): Promise<void> {
  await mkdir(sweepDir(), { recursive: true });
  const file = join(sweepDir(), name);
  const tmp = `${file}.tmp-${process.pid}-${++writes}`;
  await writeFile(tmp, JSON.stringify(list, null, 2) + "\n");
  await rename(tmp, file);
}

/** Serializes read-modify-write cycles so two callers do not clobber each
 *  other's change. */
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

const fresh = (c: SweptChat): boolean => c.sweptAt >= Date.now() - SWEPT_DAYS * DAY;

export async function readSweptChats(): Promise<SweptChat[]> {
  return (await readList<SweptChat>("chats.json")).filter(fresh);
}

export function addSweptChat(c: SweptChat): Promise<void> {
  return locked(async () => {
    const rest = (await readSweptChats()).filter((x) => x.runId !== c.runId);
    await writeList("chats.json", [...rest, c]);
  });
}

/** Removes the record and hands it back, or null when there is none. */
export function takeSweptChat(runId: string): Promise<SweptChat | null> {
  return locked(async () => {
    const all = await readSweptChats();
    const hit = all.find((x) => x.runId === runId);
    if (!hit) return null;
    await writeList("chats.json", all.filter((x) => x.runId !== runId));
    return hit;
  });
}

export function appendLog(e: SweepLogEntry): Promise<void> {
  return locked(async () => {
    const log = await readLog();
    await writeList("log.json", [...log, e].slice(-LOG_KEEP));
  });
}

export function readLog(): Promise<SweepLogEntry[]> {
  return readList<SweepLogEntry>("log.json");
}
