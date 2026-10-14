/**
 * One sink's sync, shared by the secrets service (the mini's sinks) and a
 * reader backend with an unlocked key (the Mac's): read the file, open each
 * mapped value, and write the keys `decideKey` says to write. A refused
 * path or a file that does not parse is left alone and named. No state or
 * error here holds a value.
 */

import type { Applied } from "./applied";
import { openValue } from "./secretcrypt";
import type { SecretFile, SinkDef } from "./secretfile";
import { applyKeys, decideKey, readKeys, readSinkFile, writeSinkFile } from "./sinks";
import type { SecretKeyState } from "./types";

export interface SinkIO {
  read(path: string): Promise<{ text: string | null } | { error: string }>;
  write(path: string, text: string): Promise<void>;
}

export const FILE_IO: SinkIO = { read: readSinkFile, write: writeSinkFile };

export interface SinkState {
  state: Record<string, SecretKeyState>;
  error: string | null;
  /** the keys this sync tried to write, for the audit log */
  writes: { key: string; ok: boolean }[];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : "failed");

/** every key waiting: the owner's key is locked and the file keeps what it has */
export const waitingState = (sink: SinkDef): SinkState => ({
  state: Object.fromEntries(Object.keys(sink.keys).map((k) => [k, "waiting" as const])),
  error: null,
  writes: [],
});

/** Sync one sink. `applied` is updated in place for this sink's id. */
export async function syncSink(
  f: SecretFile,
  id: string,
  sink: SinkDef,
  identity: string,
  applied: Applied,
  io: SinkIO,
  refusal: string | null,
): Promise<SinkState> {
  if (refusal) return { state: {}, error: refusal, writes: [] };
  const read = await io.read(sink.path);
  if ("error" in read) return { state: {}, error: read.error, writes: [] };
  const keys = Object.keys(sink.keys);
  const have = read.text === null ? { values: {} as Record<string, string | undefined> } : readKeys(read.text, sink.format, keys);
  if ("error" in have) return { state: {}, error: `${sink.path}: ${have.error}; left as it is`, writes: [] };
  const stamps = { ...applied[id] };
  const state: Record<string, SecretKeyState> = {};
  const updates: Record<string, string> = {};
  let error: string | null = null;
  let writes: { key: string; ok: boolean }[] = [];
  for (const [key, name] of Object.entries(sink.keys)) {
    const e = f.secrets[name];
    if (!e) {
      state[key] = "unknown";
      continue;
    }
    let value: string;
    try {
      value = await openValue(e.value, identity, { name, rotated: e.rotated });
    } catch (err) {
      state[key] = "unknown";
      error = errText(err);
      continue;
    }
    const d = decideKey(stamps[key], e.rotated, have.values[key], value);
    if (d === "write") updates[key] = value;
    else if (d === "same") stamps[key] = e.rotated;
    state[key] = d === "drift" ? "drift" : d === "same" ? "same" : have.values[key] === undefined ? "missing" : "waiting";
  }
  if (Object.keys(updates).length > 0) {
    const next = applyKeys(read.text, sink.format, updates);
    if ("error" in next) return { state, error: `${sink.path}: ${next.error}`, writes };
    writes = Object.keys(updates).map((key) => ({ key, ok: false }));
    try {
      await io.write(sink.path, next.text);
      for (const key of Object.keys(updates)) {
        const name = sink.keys[key];
        const e = name ? f.secrets[name] : undefined;
        if (e) stamps[key] = e.rotated;
        state[key] = "same";
      }
      writes = writes.map((w) => ({ ...w, ok: true }));
    } catch (err) {
      error = `${sink.path} could not be written: ${errText(err)}`;
    }
  }
  applied[id] = stamps;
  return { state, error, writes };
}
