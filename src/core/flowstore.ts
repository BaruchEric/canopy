/** Flows on disk: one JSON record per flow under the config dir, written
 *  through a temp file and a rename so a crash never leaves half a record
 *  under the real name. Bun/node only; the server is the one caller. */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlowRecord } from "./flow";
import { configDir } from "./store";

export const flowsDir = (): string => join(configDir(), "flows");

/** a flow id: the first group of a UUID */
const ID = /^[0-9a-f]{8}$/;

/** a temp file this old is a crash's leftover; a younger one may be mid-write */
const STRAY_TMP_MS = 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A record this canopy can run, or null. Checks the shape the engine relies
 *  on (an id fit for a filename, one flow step per workflow step, a current
 *  step in range); the rest is the engine's own output. */
export function parseFlowRecord(text: string): FlowRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(v) || v["v"] !== 1 || typeof v["before"] !== "string") return null;
  const flow = v["flow"];
  const workflow = v["workflow"];
  if (!isObject(flow) || !isObject(workflow)) return null;
  const id = flow["id"];
  const steps = flow["steps"];
  const wsteps = workflow["steps"];
  const current = flow["current"];
  if (typeof id !== "string" || !ID.test(id) || typeof flow["repoId"] !== "string") return null;
  if (!Array.isArray(steps) || !Array.isArray(wsteps) || steps.length !== wsteps.length) return null;
  if (typeof current !== "number" || !Number.isInteger(current) || current < 0 || current >= steps.length) return null;
  // the checks above cover every field the engine reads before trusting it
  return v as unknown as FlowRecord;
}

export async function loadFlowRecords(dir = flowsDir()): Promise<FlowRecord[]> {
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
    if (rec && name === `${rec.flow.id}.json`) out.push(rec);
    else console.error(`flows: skipping ${name}, not a flow record this canopy can read`);
  }
  return out;
}

/** Writes records as the engine saves them. Each save is serialized at once
 *  and only the newest per flow is written; one write per flow at a time. */
export class FlowFiles {
  /** the next text to write per id; "" means delete */
  private pending = new Map<string, string>();
  private writing = new Set<string>();

  constructor(private dir = flowsDir()) {}

  save(rec: FlowRecord): void {
    this.pending.set(rec.flow.id, JSON.stringify(rec));
    void this.drain(rec.flow.id);
  }

  forget(id: string): void {
    this.pending.set(id, "");
    void this.drain(id);
  }

  /** resolves once every write queued so far is done */
  async idle(): Promise<void> {
    while (this.writing.size > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private async drain(id: string): Promise<void> {
    if (this.writing.has(id)) return;
    this.writing.add(id);
    try {
      while (this.pending.has(id)) {
        const text = this.pending.get(id) ?? "";
        this.pending.delete(id);
        const path = join(this.dir, `${id}.json`);
        if (text === "") {
          await rm(path, { force: true });
          continue;
        }
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, text, { mode: 0o600 });
        await rename(tmp, path);
      }
    } catch (err) {
      console.error(`flows: could not save ${id}: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      this.writing.delete(id);
    }
  }
}
