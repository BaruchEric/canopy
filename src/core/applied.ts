/**
 * What a sink owner last wrote: per sink, per key, the rotation stamp of the
 * value it wrote. `decideKey` (sinks.ts) reads it to tell a rotation that
 * must be written from a hand edit that must not be overwritten. Stamps
 * only, never values.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

export type Applied = Record<string, Record<string, string>>;

export async function readApplied(path: string): Promise<Applied> {
  try {
    const v: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Applied = {};
    for (const [id, keys] of Object.entries(v as Record<string, unknown>)) {
      if (typeof keys !== "object" || keys === null) continue;
      out[id] = Object.fromEntries(Object.entries(keys as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
    return out;
  } catch {
    return {};
  }
}

let writes = 0;

export async function writeApplied(path: string, a: Applied): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${++writes}`;
  await writeFile(tmp, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
