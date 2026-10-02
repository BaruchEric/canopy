/** Flows on disk: one JSON record per flow under the config dir, written
 *  through a temp file and a rename so a crash never leaves half a record
 *  under the real name. Bun/node only; the server is the one caller. */

import { readFileSync, rmSync } from "node:fs";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlowRecord } from "./flow";
import { configDir } from "./store";

export const flowsDir = (): string => join(configDir(), "flows");

/** a flow id: the first group of a UUID */
const ID = /^[0-9a-f]{8}$/;

/** a temp file this old is a crash's leftover; a younger one may be mid-write */
const STRAY_TMP_MS = 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A record as it sits on disk: the engine's record and the launch root of
 *  the server that wrote it. The config dir is shared by every root canopy
 *  runs on, so a server takes back only the records written for its own. */
export interface FlowFile extends FlowRecord {
  root: string;
}

const isStep = (s: unknown): boolean => isObject(s) && typeof s["name"] === "string" && typeof s["status"] === "string";

/** A record this canopy can run, or null. Checks the shape the engine relies
 *  on (an id fit for a filename, one flow step per workflow step, each an
 *  object with a name and a status, a current step in range, the repo's path
 *  and the root); the rest is the engine's own output. */
export function parseFlowRecord(text: string): FlowFile | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(v) || v["v"] !== 1 || typeof v["before"] !== "string") return null;
  if (typeof v["repoPath"] !== "string" || typeof v["root"] !== "string") return null;
  const flow = v["flow"];
  const workflow = v["workflow"];
  if (!isObject(flow) || !isObject(workflow)) return null;
  const id = flow["id"];
  const steps = flow["steps"];
  const wsteps = workflow["steps"];
  const current = flow["current"];
  if (typeof id !== "string" || !ID.test(id) || typeof flow["repoId"] !== "string") return null;
  if (!Array.isArray(steps) || !Array.isArray(wsteps) || steps.length !== wsteps.length) return null;
  if (!steps.every(isStep)) return null;
  if (typeof current !== "number" || !Number.isInteger(current) || current < 0 || current >= steps.length) return null;
  // the checks above cover every field the engine reads before trusting it
  return v as unknown as FlowFile;
}

/** The records written for `root`. One written for another root is left on
 *  disk as it is, for the server that runs there. */
export async function loadFlowRecords(root: string, dir = flowsDir()): Promise<FlowRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  // best effort: clear temp files a crash left between the write and the rename
  for (const name of names.filter((n) => n.endsWith(".json.tmp"))) {
    try {
      const path = join(dir, name);
      if (Date.now() - (await stat(path)).mtimeMs > STRAY_TMP_MS) await rm(path, { force: true });
    } catch {
      // gone already, or not ours to remove
    }
  }
  const out: FlowRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const text = await readFile(join(dir, name), "utf8").catch(() => null);
    const rec = text === null ? null : parseFlowRecord(text);
    if (!rec || name !== `${rec.flow.id}.json`) console.error(`flows: skipping ${name}, not a flow record this canopy can read`);
    else if (rec.root === root) out.push(rec);
  }
  return out;
}

const LOCK = "owner.lock";

/** Whether this process holds the flows folder: only the holder takes back
 *  and writes records, since two servers on one config dir would otherwise
 *  both rerun the same mid-step flows. */
export type FlowsLock = { owner: true; release: () => void } | { owner: false; holder: number };

/** the tokens of the locks this process holds, which tells a second server
 *  in the same process (the tests) from a stale lock that carries our pid */
const held = new Set<string>();

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // refused means the process is there, just not ours to signal
    return (err as { code?: string }).code === "EPERM";
  }
};

const readLock = (text: string): { pid: number; token: string } | null => {
  try {
    const v: unknown = JSON.parse(text);
    if (!isObject(v)) return null;
    const pid = v["pid"];
    const token = v["token"];
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof token === "string" ? { pid, token } : null;
  } catch {
    return null;
  }
};

/** Takes the flows folder for this server: a pid file made exclusively (a
 *  whole file linked into place, so nobody reads it half written), taken
 *  over when the process that made it is gone. */
export async function lockFlows(dir = flowsDir()): Promise<FlowsLock> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK);
  const token = crypto.randomUUID();
  const text = JSON.stringify({ pid: process.pid, token });
  const tmp = `${path}.${token}`;
  await writeFile(tmp, text, { mode: 0o600 });
  try {
    let holder = 0;
    for (let tries = 0; tries < 3; tries++) {
      try {
        await link(tmp, path);
        held.add(token);
        return { owner: true, release: () => releaseLock(path, token, text) };
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
      }
      const lock = readLock(await readFile(path, "utf8").catch(() => ""));
      if (lock && (lock.pid === process.pid ? held.has(lock.token) : alive(lock.pid))) return { owner: false, holder: lock.pid };
      // a server that is gone left it (or it is no lock at all): take it over
      holder = lock?.pid ?? 0;
      await rm(path, { force: true });
    }
    return { owner: false, holder };
  } finally {
    await rm(tmp, { force: true });
  }
}

function releaseLock(path: string, token: string, text: string): void {
  held.delete(token);
  try {
    // only our own: a server that took a lock we lost is not ours to undo
    if (readFileSync(path, "utf8") === text) rmSync(path, { force: true });
  } catch {
    // gone already
  }
}

/** Writes records as the engine saves them. Each save is serialized at once
 *  and only the newest per flow is written; one write per flow at a time. */
export class FlowFiles {
  /** the next text to write per id; "" means delete */
  private pending = new Map<string, string>();
  private writing = new Set<string>();

  /** `root` is the launch root every record is written for */
  constructor(
    private root: string,
    private dir = flowsDir(),
  ) {}

  save(rec: FlowRecord): void {
    const file: FlowFile = { ...rec, root: this.root };
    this.pending.set(rec.flow.id, JSON.stringify(file));
    void this.drain(rec.flow.id);
  }

  forget(id: string): void {
    this.pending.set(id, "");
    void this.drain(id);
  }

  /** resolves once every write queued so far is done */
  async idle(): Promise<void> {
    while (this.writing.size > 0 || this.pending.size > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private async drain(id: string): Promise<void> {
    if (this.writing.has(id)) return;
    this.writing.add(id);
    try {
      // a failed write goes on to the newer text queued behind it, which is
      // often a flow's last word (its end, or its dismissal)
      while (this.pending.has(id)) {
        const text = this.pending.get(id) ?? "";
        this.pending.delete(id);
        try {
          await this.write(id, text);
        } catch (err) {
          console.error(`flows: could not save ${id}: ${String(err instanceof Error ? err.message : err)}`);
        }
      }
    } finally {
      this.writing.delete(id);
    }
  }

  private async write(id: string, text: string): Promise<void> {
    const path = join(this.dir, `${id}.json`);
    if (text === "") {
      await rm(path, { force: true });
      return;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  }
}
