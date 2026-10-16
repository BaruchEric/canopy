/**
 * The secret store's file (docs/superpowers/specs/2026-10-14-secrets-design.md):
 * its shape, its canonical form, the ed25519 signature over that form, and
 * which machines each value is sealed to. Pure and browser-safe: WebCrypto
 * is the only thing it calls, and Bun and the browser both have it.
 */

import type { SecretImpact, SecretMeta, SecretSinkFormat, SecretStack } from "./types";

export const AGE_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";
/** a letter first, so no name is an integer-like key that JSON reorders */
export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
export const SINK_ID = /^[a-z][a-z0-9-]{0,62}$/;
export const MACHINE = /^[a-z][a-z0-9-]{0,29}$/;
export const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const JSON_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*){0,15}$/;
/** the server part of an `mcp:<server>#<hash>` entry, and the hash part: one source each */
export const MCP_SERVER_SRC = "[a-z0-9][a-z0-9._-]{0,63}";
export const HASH_SRC = "[0-9a-f]{64}";
export const ALLOW = new RegExp(`^(sink:[a-z][a-z0-9-]{0,62}|mcp:${MCP_SERVER_SRC}#${HASH_SRC})$`);
const MCP_ALLOW = new RegExp(`^mcp:(${MCP_SERVER_SRC})#(${HASH_SRC})$`);
/** a kit MCP server that may hold secrets: its sink ids must pass SINK_ID */
export const MCP_SERVER_STRICT_SRC = "[a-z][a-z0-9-]{0,31}";
export const MCP_SERVER = new RegExp(`^${MCP_SERVER_STRICT_SRC}$`);
/** an http header a secret can fill; also a one-segment JSON_PATH */
export const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** an X25519 recipient; a post-quantum one is longer and not taken yet */
export const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** a compose project name; also what the canopy-restart script accepts */
export const PROJECT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESTART = PROJECT;
/** a sink's `restart` that turns the derived project off */
export const NO_RESTART = "none";
/** where the mini's stacks live; a sink in one restarts its project */
export const STACKS_ROOT = "/opt/stacks";

export interface SecretEntry {
  description: string;
  tags: string[];
  created: string;
  rotated: string;
  to: string[];
  allow: string[];
  /** armored age, sealed to `to` */
  value: string;
}

export interface SinkDef {
  machine: string;
  path: string;
  format: SecretSinkFormat;
  keys: Record<string, string>;
  /** the compose project a write restarts, or "none"; unset, the writer
   *  finds it from the sink's folder (phase 3, `stackFor`) */
  restart?: string;
}

export interface SecretSignature {
  by: string;
  alg: "ed25519";
  sig: string;
}

export interface SecretFile {
  version: 1;
  /** raised by one at every signed write, so a reader can refuse an older
   *  signed file put back on top of a newer one */
  seq: number;
  /** machine name to age recipient; `mini` and `breakglass` always */
  keys: Record<string, string>;
  secrets: Record<string, SecretEntry>;
  sinks: Record<string, SinkDef>;
  /** null only in memory, between a change and its signing */
  signature: SecretSignature | null;
}

export const nowStamp = (ms = Date.now()): string => new Date(ms).toISOString();

/** Sorted keys at every depth, no whitespace, `undefined` keys dropped. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical JSON holds no NaN or Infinity");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON holds no ${typeof v}`);
}

/** what the signature covers: everything but the signature */
const signedBytes = (f: SecretFile): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(canonical({ version: f.version, seq: f.seq, keys: f.keys, secrets: f.secrets, sinks: f.sinks }));

/** The file as written to disk: canonical order, two-space indent, so a diff
 *  in Forgejo reads line by line. */
export const serializeFile = (f: SecretFile): string => `${JSON.stringify(JSON.parse(canonical(f)), null, 2)}\n`;

export const emptyFile = (keys: Record<string, string>): SecretFile => ({ version: 1, seq: 0, keys: { ...keys }, secrets: {}, sinks: {}, signature: null });

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ED = { name: "Ed25519" };

export async function signFile(f: SecretFile, key: CryptoKey, by: string): Promise<SecretFile> {
  const sig = new Uint8Array(await crypto.subtle.sign(ED, key, signedBytes(f)));
  return { ...f, signature: { by, alg: "ed25519", sig: toB64(sig) } };
}

/** True only when the pinned public key (raw, base64) signed this content. */
export async function verifyFile(f: SecretFile, publicB64: string): Promise<boolean> {
  if (!f.signature || f.signature.alg !== "ed25519") return false;
  try {
    const key = await crypto.subtle.importKey("raw", fromB64(publicB64), ED, false, ["verify"]);
    return await crypto.subtle.verify(ED, key, fromB64(f.signature.sig), signedBytes(f));
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const stamp = (v: unknown): v is string => typeof v === "string" && STAMP.test(v);

function parseEntry(name: string, e: unknown, keys: Record<string, string>): SecretEntry | string {
  if (!SECRET_NAME.test(name)) return `secret name ${name} is not allowed (a letter, then letters, digits, _ . -)`;
  if (!isObj(e)) return `secret ${name} is not an object`;
  const { description, tags, created, rotated, to, allow, value } = e;
  if (typeof description !== "string" || !strs(tags) || !stamp(created) || !stamp(rotated) || !strs(to) || !strs(allow) || typeof value !== "string") {
    return `secret ${name} is missing a field or has one of the wrong type`;
  }
  if (!value.startsWith(AGE_HEAD)) return `secret ${name}'s value is not an age file`;
  const bad = allow.find((a) => !ALLOW.test(a));
  if (bad !== undefined) return `secret ${name} allows ${bad}, which is neither sink:<id> nor mcp:<server>#<sha256>`;
  if (to.some((m) => !(m in keys))) return `secret ${name} is sealed to a machine with no key`;
  return { description, tags, created, rotated, to, allow, value };
}

function parseSink(id: string, s: unknown, secrets: Record<string, SecretEntry>): SinkDef | string {
  if (!SINK_ID.test(id)) return `sink id ${id} is not allowed (a lowercase letter, then lowercase letters, digits, -)`;
  if (!isObj(s)) return `sink ${id} is not an object`;
  const { machine, path, format, keys, restart } = s;
  if (typeof machine !== "string" || !MACHINE.test(machine) || machine === "breakglass") return `sink ${id} names no machine it could live on`;
  if (typeof path !== "string" || !path.startsWith("/") || path.split("/").includes("..")) return `sink ${id}'s path must be absolute with no ..`;
  if (format !== "dotenv" && format !== "json") return `sink ${id}'s format is neither dotenv nor json`;
  if (!isObj(keys)) return `sink ${id} has no keys object`;
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(keys)) {
    if (!(format === "dotenv" ? DOTENV_KEY : JSON_PATH).test(k)) return `sink ${id}'s key ${k} is not a ${format === "dotenv" ? "dotenv name" : "dotted JSON path"}`;
    if (typeof n !== "string" || !(n in secrets)) return `sink ${id} maps ${k} to ${String(n)}, a secret the file does not hold`;
    out[k] = n;
  }
  if (restart !== undefined && (typeof restart !== "string" || !RESTART.test(restart))) return `sink ${id}'s restart is not a stack name`;
  return { machine, path, format, keys: out, ...(typeof restart === "string" ? { restart } : {}) };
}

export function parseSecretFile(text: string): { file: SecretFile } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "secrets.json is not JSON" };
  }
  if (!isObj(raw)) return { error: "secrets.json is not an object" };
  if (raw["version"] !== 1) return { error: "secrets.json has a version this canopy does not read" };
  const { seq, keys, secrets, sinks, signature } = raw;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return { error: "secrets.json needs seq, a whole number from 0" };
  if (!isObj(keys) || !isObj(secrets) || !isObj(sinks)) return { error: "secrets.json needs keys, secrets and sinks objects" };
  const outKeys: Record<string, string> = {};
  for (const [m, r] of Object.entries(keys)) {
    if (!MACHINE.test(m) || typeof r !== "string" || !AGE_RECIPIENT.test(r)) return { error: `key ${m} is not a machine name with an X25519 age recipient` };
    outKeys[m] = r;
  }
  if (!outKeys["mini"] || !outKeys["breakglass"]) return { error: "secrets.json needs the mini and breakglass keys" };
  const outSecrets: Record<string, SecretEntry> = {};
  for (const [name, e] of Object.entries(secrets)) {
    const entry = parseEntry(name, e, outKeys);
    if (typeof entry === "string") return { error: entry };
    outSecrets[name] = entry;
  }
  const outSinks: Record<string, SinkDef> = {};
  for (const [id, s] of Object.entries(sinks)) {
    const sink = parseSink(id, s, outSecrets);
    if (typeof sink === "string") return { error: sink };
    outSinks[id] = sink;
  }
  let sig: SecretSignature | null = null;
  if (signature !== undefined && signature !== null) {
    if (!isObj(signature) || typeof signature["by"] !== "string" || signature["alg"] !== "ed25519" || typeof signature["sig"] !== "string") {
      return { error: "secrets.json's signature is not {by, alg: ed25519, sig}" };
    }
    sig = { by: signature["by"], alg: "ed25519", sig: signature["sig"] };
  }
  return { file: { version: 1, seq, keys: outKeys, secrets: outSecrets, sinks: outSinks, signature: sig } };
}

/** the sinks that map a key to `name`, sorted */
export function usedBy(f: SecretFile, name: string): string[] {
  return Object.entries(f.sinks)
    .filter(([, s]) => Object.values(s.keys).includes(name))
    .map(([id]) => id)
    .sort();
}

/** the sink that carries one MCP server's env, or its headers, on one machine */
export const mcpSinkId = (server: string, machine: string, headers = false): string => `mcp-${server}-${machine}${headers ? "-headers" : ""}`;

/** where that sink lives under a machine's home */
export const mcpEnvPath = (home: string, server: string, headers = false): string =>
  `${home.replace(/\/+$/, "")}/.claude/mcp-env/${server}${headers ? ".headers.json" : ".env"}`;

export function parseMcpAllow(entry: string): { server: string; hash: string } | null {
  const m = MCP_ALLOW.exec(entry);
  return m ? { server: m[1] ?? "", hash: m[2] ?? "" } : null;
}

/** whether a sink id is one of this server's env or headers sinks on that machine */
export const isServerSink = (id: string, server: string, machine: string): boolean =>
  id === mcpSinkId(server, machine) || id === mcpSinkId(server, machine, true);

/** which project a sink restarts, given its id and definition */
export type StackOf = (id: string, sink: SinkDef) => string | null;

/** the project set on the sink, when one is; a reader with no project list knows no more */
export const setStack: StackOf = (_id, s) => (s.restart && s.restart !== NO_RESTART ? s.restart : null);

const parentOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/** The compose project a write to this sink restarts (phase 3 spec, part
 *  A1): a set `restart` wins and "none" turns it off. Otherwise, for a
 *  sink on `machine` at /opt/stacks/<dir>/…, the one running project whose
 *  first config file sits directly in /opt/stacks/<dir>. None or several
 *  is null. */
export function stackFor(sink: SinkDef, machine: string, projects: readonly SecretStack[]): string | null {
  if (sink.restart !== undefined) return sink.restart === NO_RESTART ? null : sink.restart;
  if (sink.machine !== machine) return null;
  const m = new RegExp(`^${STACKS_ROOT}/([^/]+)/`).exec(sink.path);
  if (!m) return null;
  const dir = `${STACKS_ROOT}/${m[1]}`;
  const hits = projects.filter((p) => p.files[0] !== undefined && parentOf(p.files[0]) === dir);
  return hits.length === 1 ? (hits[0]?.name ?? null) : null;
}

/** Everything a change to `name` reaches: its sinks, the MCP servers its
 *  allowlist names with the machines holding their env sinks, and the
 *  projects those sinks restart. */
export function impactOf(f: SecretFile, name: string, stackOf: StackOf = setStack): SecretImpact {
  const sinks = usedBy(f, name).flatMap((id) => {
    const s = f.sinks[id];
    if (!s) return [];
    const keys = Object.entries(s.keys).filter(([, n]) => n === name).map(([k]) => k).sort();
    return [{ id, machine: s.machine, path: s.path, keys }];
  });
  const servers = (f.secrets[name]?.allow ?? []).flatMap((a) => {
    const p = parseMcpAllow(a);
    if (!p) return [];
    const machines = [...new Set(Object.entries(f.sinks).filter(([id, s]) => isServerSink(id, p.server, s.machine)).map(([, s]) => s.machine))].sort();
    return [{ server: p.server, hash: p.hash, machines }];
  });
  const stacks = [...new Set(sinks.flatMap((s) => {
    const def = f.sinks[s.id];
    const p = def ? stackOf(s.id, def) : null;
    return p ? [p] : [];
  }))].sort();
  return { sinks, servers, stacks };
}

/** the reach as a list of names: sink ids, then "the MCP server <name>" */
export const reachList = (r: SecretImpact): string[] => [...r.sinks.map((s) => s.id), ...r.servers.map((s) => `the MCP server ${s.server}`)];

/** a list joined as "a, b and c" */
export const joinList = (parts: string[]): string => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? ""));

/** the reach in one line, for a refused delete */
/** why a secret cannot be deleted while something reaches it */
export const reachRefusal = (name: string, r: SecretImpact): string => `${reachText(name, r)}; take it out of those first`;

export function reachText(name: string, r: SecretImpact): string {
  const parts = reachList(r);
  return parts.length === 0 ? `${name} is used by nothing` : `${name} is used by ${joinList(parts)}`;
}

/** The machines a value is sealed to: the mini and the break-glass key
 *  always, and each machine that owns a sink using it. The Mac writes gpd's
 *  sinks (phase 3), so a gpd sink adds the Mac. Sorted. */
export function recipientsFor(f: SecretFile, name: string): string[] {
  const to = new Set(["mini", "breakglass"]);
  for (const id of usedBy(f, name)) {
    const m = f.sinks[id]?.machine;
    if (m) to.add(m === "gpd" ? "mac" : m);
  }
  return [...to].sort();
}

/** the age recipients for those machines, or which have no key yet */
export function recipientKeys(f: SecretFile, machines: readonly string[]): { keys: string[] } | { missing: string[] } {
  const missing = machines.filter((m) => !f.keys[m]);
  if (missing.length > 0) return { missing };
  return { keys: machines.flatMap((m) => (f.keys[m] ? [f.keys[m]] : [])) };
}

/** What is wrong with a file that parses: a sink outside its secret's
 *  allowlist, a value sealed to other machines than the rule says. */
export function fileProblems(f: SecretFile): string[] {
  const out: string[] = [];
  for (const [id, s] of Object.entries(f.sinks)) {
    for (const [key, name] of Object.entries(s.keys)) {
      const e = f.secrets[name];
      if (!e) out.push(`sink ${id} maps ${key} to ${name}, which is gone`);
      else if (!e.allow.includes(`sink:${id}`)) out.push(`sink ${id} uses ${name}, whose allowlist does not hold sink:${id}`);
    }
  }
  for (const [name, e] of Object.entries(f.secrets)) {
    const want = recipientsFor(f, name).join(", ");
    const have = [...e.to].sort().join(", ");
    if (want !== have) out.push(`${name} is sealed to ${have}, not ${want}`);
  }
  return out;
}

export function metaOf(f: SecretFile, name: string, stackOf: StackOf = setStack): SecretMeta | null {
  const e = f.secrets[name];
  if (!e) return null;
  return { name, description: e.description, tags: [...e.tags], created: e.created, rotated: e.rotated, to: [...e.to], allow: [...e.allow], usedBy: usedBy(f, name), impact: impactOf(f, name, stackOf) };
}

export const metaList = (f: SecretFile, stackOf: StackOf = setStack): SecretMeta[] =>
  Object.keys(f.secrets)
    .sort()
    .flatMap((n) => {
      const m = metaOf(f, n, stackOf);
      return m ? [m] : [];
    });
