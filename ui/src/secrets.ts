/* The secrets view's pure parts: which backend writes, whether this page is
   the gate, the list's filter, and the sinks with their owners' states.
   Nothing here ever sees a value. */

import { DOTENV_KEY, JSON_PATH, SECRET_NAME, joinList, reachList } from "../../src/core/secretfile";
import type { SecretKeyState, SecretMeta, SecretSinkFormat, SecretSinkInfo, SecretsInfo } from "../../src/core/types";

/** the backend whose info comes from the mini's service, in page order */
export function writerOf(all: Readonly<Record<string, SecretsInfo>>, order: readonly string[]): string | null {
  return order.find((b) => all[b]?.role === "writer") ?? null;
}

/** the backends reading a pulled copy, in page order: after an allow or a
 *  revoke the page asks each to pull, so its kit cells catch up without
 *  waiting for the pull interval */
export function readersOf(all: Readonly<Record<string, SecretsInfo>>, order: readonly string[]): string[] {
  return order.filter((b) => all[b]?.role === "reader");
}

/** gated actions answer only on the writer's gate page (`info.gate`, a full
 *  URL), so the view offers them only on that page's origin */
export const gateHere = (info: SecretsInfo | undefined, origin: string): boolean => info?.role === "writer" && originOf(info.gate) === origin;

/** a 401 from the passkey gate: `req` puts the status on the error */
export function isGateClosed(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 401;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function tagsOf(list: readonly SecretMeta[]): string[] {
  return [...new Set(list.flatMap((m) => m.tags))].sort();
}

export function filterSecrets(list: readonly SecretMeta[], text: string, tag: string | null): SecretMeta[] {
  const t = text.trim().toLowerCase();
  const hit = (s: string) => s.toLowerCase().includes(t);
  return list.filter((m) => (tag === null || m.tags.includes(tag)) && (t === "" || hit(m.name) || hit(m.description) || m.tags.some(hit)));
}

export interface SinkRow {
  sink: SecretSinkInfo;
  /** the backend that reported this sink's key states, if any did */
  owner: string | null;
}

/** The writer's sinks (or, with the writer away, the first readable copy's),
 *  each with the key states and error its owner reported. Only the backend
 *  that owns a sink fills `state`, so the owner is whoever did. */
export function sinkRows(all: Readonly<Record<string, SecretsInfo>>, order: readonly string[], writer: string | null): SinkRow[] {
  const base = writer ? all[writer] : order.map((b) => all[b]).find((i) => i?.ok);
  if (!base) return [];
  return base.sinks.map((sink) => {
    const owner = order.find((b) => Object.keys(all[b]?.sinks.find((x) => x.id === sink.id)?.state ?? {}).length > 0) ?? null;
    const own = owner === null ? undefined : all[owner]?.sinks.find((x) => x.id === sink.id);
    return { sink: own ? { ...sink, state: own.state, error: own.error } : sink, owner };
  });
}

/** a sink's keys as the editor shows them, one `KEY=secret_name` a line */
export const keysText = (keys: Readonly<Record<string, string>>): string =>
  Object.entries(keys)
    .map(([k, n]) => `${k}=${n}`)
    .join("\n");

/** the editor's lines back into keys; the service checks again */
export function parseKeysText(text: string, format: SecretSinkFormat): Record<string, string> | { error: string } {
  const keys: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    const at = line.indexOf("=");
    if (at < 0) return { error: `line ${i + 1} has no =` };
    const key = line.slice(0, at).trim();
    const name = line.slice(at + 1).trim();
    if (!(format === "json" ? JSON_PATH : DOTENV_KEY).test(key)) return { error: `line ${i + 1}: ${key} is not a ${format === "json" ? "JSON path" : "dotenv key"}` };
    if (!SECRET_NAME.test(name)) return { error: `line ${i + 1}: ${name} is not a secret name` };
    if (key in keys) return { error: `line ${i + 1}: ${key} is mapped twice` };
    keys[key] = name;
  }
  return keys;
}

/** the tone class each key state wears */
export const KEY_TONE: Record<SecretKeyState, string> = {
  same: "moss",
  drift: "rust",
  missing: "lichen",
  waiting: "sky",
  unknown: "",
  "phase 3": "",
};

/** the line that restarts a stack, until phase 3's button */
export const restartLine = (stack: string): string => `cd /opt/stacks/${stack} && docker compose up -d`;

export interface ReachRow {
  kind: "sink" | "server" | "stack";
  name: string;
  machine: string;
  detail: string;
  /** a sink's key states from its owner's last pass, or its error; null for the rest */
  state: string | null;
}

function sinkState(rows: readonly SinkRow[], id: string, keys: readonly string[]): string | null {
  const s = rows.find((r) => r.sink.id === id)?.sink;
  if (!s) return null;
  if (s.error) return s.error;
  return [...new Set(keys.map((k) => s.state[k] ?? "unknown"))].join(", ");
}

/** everything a rotation of `meta` reaches, for the preview and for after the write */
export function reachRows(meta: SecretMeta, rows: readonly SinkRow[], awaited: (owner: string | null) => boolean = () => false): ReachRow[] {
  // a sink's states are its owner's last pass: while that owner has not passed over the write, they are the old ones
  const stateOf = (id: string, keys: readonly string[]): string | null => {
    const owner = rows.find((x) => x.sink.id === id)?.owner ?? null;
    return owner !== null && awaited(owner) ? `waiting for ${owner}'s pass` : sinkState(rows, id, keys);
  };
  const r = meta.impact;
  if (!r) {
    return meta.usedBy.map((id) => {
      const s = rows.find((x) => x.sink.id === id)?.sink;
      return { kind: "sink", name: id, machine: s?.machine ?? "", detail: "", state: stateOf(id, Object.keys(s?.keys ?? {})) };
    });
  }
  return [
    ...r.sinks.map((s): ReachRow => ({ kind: "sink", name: s.id, machine: s.machine, detail: `${s.path}, ${s.keys.join(", ")}`, state: stateOf(s.id, s.keys) })),
    ...r.servers.map((s): ReachRow => ({ kind: "server", name: s.server, machine: s.machines.join(", "), detail: "new agent sessions get the new value; running ones keep the old one", state: null })),
    ...r.stacks.map((st): ReachRow => ({ kind: "stack", name: st, machine: "mini", detail: restartLine(st), state: null })),
  ];
}

/** the sheet's "used by" line; a backend from before the reach lists sinks only */
export const usedByText = (meta: SecretMeta): string =>
  meta.impact ? joinList(reachList(meta.impact)) || "nothing" : meta.usedBy.join(", ") || "no sink";

const TONE_ORDER = ["rust", "lichen", "sky", "", "moss"];

/** the tone of a reach row's state: each key state wears its KEY_TONE, a wait
 *  is sky, anything else (a sink's error) is rust, and a joined list takes
 *  its worst */
export function stateTone(state: string | null): string {
  if (state === null) return "";
  const tones = state.split(", ").map((p) => (p in KEY_TONE ? KEY_TONE[p as SecretKeyState] : p.startsWith("waiting for ") ? "sky" : "rust"));
  return TONE_ORDER.find((t) => tones.includes(t)) ?? "";
}

/** what a successful write left behind: its commit and each backend's last finished sink pass */
export interface WriteMark {
  head: string | null;
  at: Record<string, string | null | undefined>;
}

export function markOf(data: unknown, all: Readonly<Record<string, SecretsInfo>>): WriteMark {
  const head = typeof data === "object" && data !== null ? (data as { head?: unknown }).head : null;
  return { head: typeof head === "string" ? head : null, at: Object.fromEntries(Object.entries(all).map(([b, i]) => [b, i.sinksAt])) };
}

/** Has `owner` finished a sink pass over the write? A reader publishes its
 *  new head before it runs the pass, so the head says nothing; `sinksAt` is
 *  the commit its last finished pass read. Passed when that reached the
 *  write's commit or moved off where it was; true when nothing can be known
 *  (no mark, no commit, a backend that does not report `sinksAt`). */
export function passedOver(mark: WriteMark | null, owner: string | null, info: SecretsInfo | undefined): boolean {
  if (!mark || mark.head === null || owner === null || !info || info.sinksAt === undefined) return true;
  const done = info.sinksAt;
  if (done === null) return false;
  return done.startsWith(mark.head) || mark.head.startsWith(done) || done !== mark.at[owner];
}
