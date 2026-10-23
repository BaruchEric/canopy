import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SWEPT_DAYS } from "./keep";
import { configDir } from "./store";
import { isHarness, SWEEP_KINDS, type SweepItem, type SweepLogEntry, type SweepOutcome, type SweptChat } from "./types";

/* What the sweep keeps on disk: the chats it stopped, so a resume can start
 * from their session, a short log of its passes, the scheduled fire's
 * pending ask and when the schedule last fired. */

const DAY = 24 * 60 * 60 * 1000;
/** passes the log remembers */
const LOG_KEEP = 50;

export const sweepDir = (): string => join(configDir(), "sweep");

/** tells one write's temporary file from another's in the same process */
let writes = 0;

/** a file's JSON, or undefined when it is missing or does not parse */
async function readJson(name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(sweepDir(), name), "utf8"));
  } catch {
    return undefined;
  }
}

/** A list file, each entry through `parse`: an entry that does not read
 *  (a hand edit, a file from another version) is left out rather than
 *  failing every route that reads the list. */
async function readList<T>(name: string, parse: (v: unknown) => T | null): Promise<T[]> {
  const parsed = await readJson(name);
  return Array.isArray(parsed) ? each(parsed, parse) : [];
}

/** the entries of `list` that `parse` reads */
const each = <T>(list: readonly unknown[], parse: (v: unknown) => T | null): T[] =>
  list.flatMap((v) => {
    const got = parse(v);
    return got === null ? [] : [got];
  });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const RESULTS: readonly unknown[] = ["closed", "in use now", "gone", "failed"] satisfies SweepOutcome["result"][];

function parseChat(v: unknown): SweptChat | null {
  if (!isObj(v)) return null;
  const { runId, repoId, harness, session, title, sweptAt } = v;
  if (!isStr(runId) || !isStr(repoId) || !isHarness(harness) || !isStr(session) || !isStr(title) || !isTime(sweptAt)) return null;
  return { runId, repoId, harness, session, title, sweptAt };
}

function parseOutcome(v: unknown): SweepOutcome | null {
  if (!isObj(v) || !isStr(v["key"]) || !RESULTS.includes(v["result"])) return null;
  const why = v["why"];
  if (why !== undefined && !isStr(why)) return null;
  return v as unknown as SweepOutcome;
}

function parseItem(v: unknown): SweepItem | null {
  if (!isObj(v)) return null;
  const ok =
    isStr(v["key"]) &&
    (SWEEP_KINDS as readonly unknown[]).includes(v["kind"]) &&
    isStr(v["id"]) &&
    (v["repoId"] === null || isStr(v["repoId"])) &&
    isStr(v["where"]) &&
    isStr(v["title"]) &&
    isTime(v["idleSince"]) &&
    isStr(v["why"]) &&
    isBool(v["closable"]) &&
    isBool(v["checked"]) &&
    (v["handOnly"] === undefined || isBool(v["handOnly"])) &&
    isBool(v["auto"]);
  // an item written before handOnly reads as not held; nothing closes on a
  // stored item's flags, every close plans afresh
  return ok ? ({ ...v, handOnly: v["handOnly"] === true } as unknown as SweepItem) : null;
}

/** A log entry needs its time, who ran it and its outcomes; an outcome or
 *  item inside it that does not read is left out on its own. */
function parseEntry(v: unknown): SweepLogEntry | null {
  if (!isObj(v)) return null;
  const { at, by, outcomes, items } = v;
  if (!isTime(at) || (by !== "eric" && by !== "schedule") || !Array.isArray(outcomes)) return null;
  return { at, by, outcomes: each(outcomes, parseOutcome), items: Array.isArray(items) ? each(items, parseItem) : [] };
}

// Write-then-rename, as the config does: a crash mid-write leaves the old
// file whole.
async function writeJson(name: string, data: unknown): Promise<void> {
  await mkdir(sweepDir(), { recursive: true });
  const file = join(sweepDir(), name);
  const tmp = `${file}.tmp-${process.pid}-${++writes}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
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
  return (await readList("chats.json", parseChat)).filter(fresh);
}

export function addSweptChat(c: SweptChat): Promise<void> {
  return locked(async () => {
    const rest = (await readSweptChats()).filter((x) => x.runId !== c.runId);
    await writeJson("chats.json", [...rest, c]);
  });
}

/** Removes the record and hands it back, or null when there is none. */
export function takeSweptChat(runId: string): Promise<SweptChat | null> {
  return locked(async () => {
    const all = await readSweptChats();
    const hit = all.find((x) => x.runId === runId);
    if (!hit) return null;
    await writeJson("chats.json", all.filter((x) => x.runId !== runId));
    return hit;
  });
}

export function appendLog(e: SweepLogEntry): Promise<void> {
  return locked(async () => {
    const log = await readLog();
    await writeJson("log.json", [...log, e].slice(-LOG_KEEP));
  });
}

export function readLog(): Promise<SweepLogEntry[]> {
  return readList("log.json", parseEntry);
}

/** The scheduled fire's pending ask: what it found closable and left for
 *  Eric. Null when there is none, including a file whose entries all fail
 *  to read. */
export async function readAsk(): Promise<SweepItem[] | null> {
  const items = await readList("ask.json", parseItem);
  return items.length > 0 ? items : null;
}

/** Replaces the ask; null (or an empty list) clears it. */
export function writeAsk(items: SweepItem[] | null): Promise<void> {
  return locked(() => writeJson("ask.json", items && items.length > 0 ? items : null));
}

/** When the schedule last fired (unix ms), or null when it never has or
 *  the state file does not read. */
export async function readLastFire(): Promise<number | null> {
  const state = await readJson("state.json");
  return isObj(state) && isTime(state["lastFire"]) ? state["lastFire"] : null;
}

export function writeLastFire(at: number): Promise<void> {
  return locked(() => writeJson("state.json", { lastFire: at }));
}
