/**
 * One sink's sync, shared by the secrets service (the mini's sinks) and a
 * reader backend with an unlocked key (the Mac's): read the file, open each
 * mapped value, and write the keys `decideKey` says to write. A refused
 * path or a file that does not parse is left alone and named. No state or
 * error here holds a value.
 */

import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Applied } from "./applied";
import { openValue } from "./secretcrypt";
import { MCP_SERVER_STRICT_SRC, type SecretFile, type SinkDef } from "./secretfile";
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

/** only names the kit's sinks could have: <server>.env and <server>.headers.json */
const MCP_ENV_FILE = new RegExp(`^${MCP_SERVER_STRICT_SRC}\\.(env|headers\\.json)$`);

/** the sink paths on `machine` inside `dir`, which a prune keeps */
export const mcpEnvKeep = (f: SecretFile, machine: string, dir: string): string[] =>
  Object.values(f.sinks).filter((s) => s.machine === machine && dirname(s.path) === dir).map((s) => s.path);

/** Delete the files in a machine's mcp-env folder that no sink names any
 *  more, so a revoke takes the value off disk (phase 2 plan, call 8).
 *  Only a regular file goes: a directory or a symlink of such a name is
 *  left (lstat, so a link is never followed). Never rejects, since the
 *  passes that call it run unawaited and Bun ends on an unhandled
 *  rejection; a file it could not remove is named in `failed`. A missing
 *  folder deletes nothing. */
export async function pruneMcpEnv(dir: string, keep: readonly string[]): Promise<{ removed: string[]; failed: string[] }> {
  const out = { removed: [] as string[], failed: [] as string[] };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const n of names.filter((x) => MCP_ENV_FILE.test(x) && !keep.includes(join(dir, x))).sort()) {
    const p = join(dir, n);
    try {
      if (!(await lstat(p)).isFile()) continue;
      await rm(p, { force: true });
      out.removed.push(n);
    } catch {
      out.failed.push(n);
    }
  }
  return out;
}
