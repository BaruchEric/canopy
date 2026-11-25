/**
 * Each health check's record on disk (FR-088): its last state changes and
 * when it was last well, in `<config dir>/health-history.json`, so a restart
 * or a redeploy keeps the health page's tapes. The hub asks for a check's
 * record when it first adds the check, and hands over every check after a
 * change; the file is written only when a record differs, through a temp
 * file and a rename at 0600.
 *
 * A check the hub does not hold keeps its record. After a restart a repo's
 * checks come back only once the repo is scanned, which can be after the
 * first write. A check still missing once the hub has run for `SETTLE` was
 * removed, and its record goes at the next write.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HISTORY_MAX, type HealthRecord } from "../core/health";
import { configDir } from "../core/store";
import type { HealthCheck, HealthEvent, HealthState } from "../core/types";

/** how long after a start a check the hub has not added may still come */
export const SETTLE = 10 * 60_000;

const STATES: ReadonlySet<unknown> = new Set<HealthState>(["ok", "down", "healing", "gave-up", "off", "unknown"]);
const isState = (v: unknown): v is HealthState => STATES.has(v);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseEvent(v: unknown): HealthEvent | null {
  if (!isRecord(v)) return null;
  const { at, state, why } = v;
  if (!isTime(at) || !isState(state) || (why !== null && typeof why !== "string")) return null;
  return { at, state, why };
}

/** The file read back, every record checked again: a bad event is left
 *  out, the rest kept in time order and cut to the cap. */
export function parseRecords(raw: string): Map<string, HealthRecord> {
  const out = new Map<string, HealthRecord>();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  const checks = isRecord(v) ? v["checks"] : null;
  if (!isRecord(checks)) return out;
  for (const [id, r] of Object.entries(checks)) {
    if (!isRecord(r) || !Array.isArray(r["history"])) continue;
    const history = r["history"]
      .map(parseEvent)
      .filter((e): e is HealthEvent => e !== null)
      .sort((a, b) => a.at - b.at)
      .slice(-HISTORY_MAX);
    const lastOk = isTime(r["lastOk"]) ? r["lastOk"] : null;
    if (history.length > 0 || lastOk !== null) out.set(id, { lastOk, history });
  }
  return out;
}

const text = (records: ReadonlyMap<string, HealthRecord>): string =>
  `${JSON.stringify({ checks: Object.fromEntries([...records].sort(([a], [b]) => a.localeCompare(b))) })}\n`;

export class HealthRecords {
  private kept: Map<string, HealthRecord>;
  private written: string;
  private chain: Promise<void> = Promise.resolve();
  private readonly started: number;

  constructor(
    private readonly file: string = join(configDir(), "health-history.json"),
    private readonly now: () => number = Date.now,
  ) {
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = null;
    }
    this.kept = raw === null ? new Map() : parseRecords(raw);
    this.written = raw ?? "";
    this.started = now();
  }

  /** the record a check had, for the hub's first add of it */
  restore(id: string): HealthRecord | undefined {
    return this.kept.get(id);
  }

  /** Every check the hub holds, written when a record changed. Resolves
   *  once the write is done; a failed write is said and the next change
   *  tries again. */
  save(checks: readonly HealthCheck[]): Promise<void> {
    const next = new Map<string, HealthRecord>();
    for (const c of checks) if (c.history.length > 0 || c.lastOk !== null) next.set(c.id, { lastOk: c.lastOk, history: c.history });
    if (this.now() - this.started < SETTLE) {
      const live = new Set(checks.map((c) => c.id));
      for (const [id, r] of this.kept) if (!live.has(id)) next.set(id, r);
    }
    this.kept = next;
    const body = text(next);
    if (body === this.written) return this.chain;
    this.written = body;
    this.chain = this.chain.then(async () => {
      const dir = dirname(this.file);
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = join(dir, `.${basename(this.file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, this.file);
      } catch (err) {
        // the next change writes again rather than taking this as written
        if (this.written === body) this.written = "";
        console.error(`health: ${this.file} not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return this.chain;
  }
}
