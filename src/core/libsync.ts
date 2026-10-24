/** Library sync, the pure half (docs/superpowers/specs/2026-10-24-library-sync-design.md):
 *  the Library's five files flattened into keyed entries, stamped with who
 *  changed each one when, and merged key by key with the newer stamp
 *  winning. No I/O; server/libsync.ts reads, fetches and writes. */
import { createHash } from "node:crypto";
import type { LibrarySyncMode } from "./types";

export type { LibrarySyncMode };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type LibFile = "categories" | "references" | "tags" | "relations" | "health";
export const LIB_FILES: Record<LibFile, string> = {
  categories: "categories.json",
  references: "references.json",
  tags: "tags.json",
  relations: "relations.json",
  health: "health.json",
};
export const LIB_FILE_NAMES: readonly string[] = Object.values(LIB_FILES);

/** each file's parsed JSON; a file that is missing or did not parse is absent */
export type LibFiles = Partial<Record<LibFile, Json>>;
/** every shared entry's value, by key */
export type Entries = Record<string, Json>;

export const LIBRARY_SYNC_MODES: readonly LibrarySyncMode[] = ["off", "dry", "on"];

export interface Stamp {
  at: number;
  by: string;
}
/** an entry in sync.json: its value's hash and stamp */
export interface Held extends Stamp {
  h: string;
}
export interface Joined {
  how: "seed" | "adopt";
  from?: string;
  at: number;
}
/** sync.json, which only the canopy server writes */
export interface SyncState {
  v: 1;
  joined: Joined;
  entries: Record<string, Held>;
  tombs: Record<string, Stamp>;
}
/** what `GET /api/library/sync` answers */
export type SyncDoc =
  | { backend: string; ready: false }
  | { backend: string; ready: true; entries: Record<string, Stamp & { v: Json }>; tombs: Record<string, Stamp> };

/** one other backend as the last pull from it went */
export interface LibraryPeerStatus {
  name: string;
  /** the tailnet URL pulled from; null when its entry has none */
  url: string | null;
  /** the last pull tried */
  at: number | null;
  /** the last pull that got a doc */
  ok: number | null;
  /** why the last pull got no doc: away, not joined, a bad answer */
  away: string | null;
  /** why its last merge is held, with the way through */
  held: string | null;
  /** what its last merge took and deleted here, or would have in dry mode */
  taken: number;
  deleted: number;
  /** category tombstones kept back while their folder has projects */
  kept: string[];
  dry: boolean;
}

/** `GET /api/library/sync/status` and the CLI's `--status` */
export interface LibrarySyncStatus {
  mode: LibrarySyncMode;
  self: string | null;
  joined: Joined | null;
  peers: LibraryPeerStatus[];
  /** what stops every pass: a file that did not parse, a write refused */
  error: string | null;
}

/** the dict sections of categories.json, by key prefix */
const DICTS = { cat: "categories", ovr: "overrides", link: "links", note: "notes" } as const;
/** the list-as-set sections of categories.json */
const SETS = { arch: "archived", fav: "favorites", pin: "pinned", ign: "ignore" } as const;
/** the plain settings both machines share; the host keys are never here */
const SHARED_SETTINGS = ["stale_days", "github_login", "dev_port_base"] as const;

/** which file a key's entry lives in */
export function fileOf(key: string): LibFile | null {
  const colon = key.indexOf(":");
  if (colon <= 0) return null;
  const prefix = key.slice(0, colon);
  if (prefix in DICTS || prefix in SETS || prefix === "set") return "categories";
  if (prefix === "ref") return "references";
  if (prefix === "tag") return "tags";
  if (prefix === "rel") return "relations";
  if (prefix === "health") return "health";
  return null;
}

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** JSON with every object's keys sorted, so a reordered value is the same value */
export function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const hashOf = (v: Json): string => createHash("sha256").update(canonical(v)).digest("hex").slice(0, 16);

const relKey = (a: string, b: string): string => `rel:${a}|${b}`;

/** the relations file's pairs, sorted within and unique, as save_relations keeps them */
function pairsOf(v: Json | undefined): [string, string][] {
  const raw = isObject(v) ? v["pairs"] : v;
  const out: [string, string][] = [];
  if (!Array.isArray(raw)) return out;
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string") continue;
    const [a, b] = [p[0], p[1]].sort() as [string, string];
    if (a !== b) out.push([a, b]);
  }
  return out;
}

/** The shared entries in the files given. A file left out contributes none. */
export function flatten(files: LibFiles): Entries {
  const out: Entries = {};
  const cfg = files.categories;
  if (isObject(cfg)) {
    for (const [prefix, section] of Object.entries(DICTS)) {
      const d = cfg[section];
      if (isObject(d)) for (const [k, v] of Object.entries(d)) out[`${prefix}:${k}`] = v;
    }
    for (const [prefix, section] of Object.entries(SETS)) {
      for (const s of strings(cfg[section])) out[`${prefix}:${s}`] = true;
    }
    for (const k of SHARED_SETTINGS) if (k in cfg) out[`set:${k}`] = cfg[k] as Json;
  }
  const refs = files.references;
  if (Array.isArray(refs)) {
    for (const r of refs) if (isObject(r) && typeof r["id"] === "string" && !(`ref:${r["id"]}` in out)) out[`ref:${r["id"]}`] = r;
  }
  const tags = files.tags;
  if (isObject(tags)) for (const [k, v] of Object.entries(tags)) out[`tag:${k}`] = v;
  if (files.relations !== undefined) for (const [a, b] of pairsOf(files.relations)) out[relKey(a, b)] = [a, b];
  const health = files.health;
  if (isObject(health)) for (const [k, v] of Object.entries(health)) out[`health:${k}`] = v;
  return out;
}

/** the entries under one prefix, as name to value, new ones sorted */
function under(entries: Entries, prefix: string): [string, Json][] {
  const p = `${prefix}:`;
  return Object.keys(entries)
    .filter((k) => k.startsWith(p))
    .sort()
    .map((k) => [k.slice(p.length), entries[k] as Json]);
}

/** a dict rebuilt from entries: the base's order first, then the new names */
function dictFrom(base: Json | undefined, items: [string, Json][]): JsonObject {
  const have = new Map(items);
  const out: JsonObject = {};
  if (isObject(base)) for (const k of Object.keys(base)) if (have.has(k)) out[k] = have.get(k) as Json;
  for (const [k, v] of items) if (!(k in out)) out[k] = v;
  return out;
}

/** a list-as-set rebuilt the same way */
function setFrom(base: Json | undefined, items: [string, Json][]): string[] {
  const have = new Set(items.map(([k]) => k));
  const out = strings(base).filter((s, i, all) => have.has(s) && all.indexOf(s) === i);
  for (const [k] of items) if (!out.includes(k)) out.push(k);
  return out;
}

/** The files rebuilt from `entries` on top of `base`, which gives each
 *  file's order and everything in it that is not shared (the host keys,
 *  `version`, a reference with no id). Only the files that come out
 *  different from `base` are returned, and a file that was missing is
 *  returned only when it now has entries. */
export function unflatten(entries: Entries, base: LibFiles): LibFiles {
  const out: LibFiles = {};
  const changed = (file: LibFile, next: Json, empty: boolean): void => {
    const was = base[file];
    if (was === undefined ? !empty : canonical(was) !== canonical(next)) out[file] = next;
  };

  const cfgBase = isObject(base.categories) ? base.categories : {};
  const cfg: JsonObject = { ...cfgBase };
  for (const [prefix, section] of Object.entries(DICTS)) {
    const items = under(entries, prefix);
    if (items.length || section in cfgBase) cfg[section] = dictFrom(cfgBase[section], items);
  }
  for (const [prefix, section] of Object.entries(SETS)) {
    const items = under(entries, prefix);
    if (items.length || section in cfgBase) cfg[section] = setFrom(cfgBase[section], items);
  }
  for (const k of SHARED_SETTINGS) {
    const key = `set:${k}`;
    if (key in entries) cfg[k] = entries[key] as Json;
    else delete cfg[k];
  }
  // categories.json always exists where the Library has run, so it is never created here
  if (base.categories !== undefined) changed("categories", cfg, false);

  const refItems = new Map(under(entries, "ref"));
  const refs: Json[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(base.references) ? base.references : []) {
    if (!isObject(r) || typeof r["id"] !== "string") {
      refs.push(r);
      continue;
    }
    const id = r["id"];
    if (seen.has(id) || !refItems.has(id)) continue;
    seen.add(id);
    refs.push(refItems.get(id) as Json);
  }
  for (const [id, v] of refItems) if (!seen.has(id)) refs.push(v);
  changed("references", refs, refItems.size === 0);

  const tagItems = under(entries, "tag");
  changed("tags", dictFrom(base.tags, tagItems), tagItems.length === 0);

  const pairs = under(entries, "rel")
    .map(([, v]) => v)
    .filter((v): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string")
    .map(([a, b]) => [a, b].sort() as [string, string])
    .sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1));
  changed("relations", { pairs }, pairs.length === 0);

  const healthItems = under(entries, "health");
  changed("health", dictFrom(base.health, healthItems), healthItems.length === 0);
  return out;
}

/** Stamps every change in `current` since `prev`: a key whose value hash
 *  moved is stamped at `now` by `self`, and a key that vanished becomes a
 *  tombstone. A change is always stamped after the stamp it replaces, so a
 *  clock behind the one that stamped the old value (another machine's, or
 *  a seed's file times) never lets an edit lose to what it replaced. Keys
 *  of files outside `scope` (missing, or failed to parse) are left exactly
 *  as they were. */
export function stampPass(prev: SyncState, current: Entries, scope: ReadonlySet<LibFile>, now: number, self: string): { state: SyncState; changed: string[] } {
  const entries = { ...prev.entries };
  const tombs = { ...prev.tombs };
  const changed: string[] = [];
  const after = (key: string): number => Math.max(now, (entries[key]?.at ?? tombs[key]?.at ?? -1) + 1);
  for (const [key, v] of Object.entries(current)) {
    const file = fileOf(key);
    if (!file || !scope.has(file)) continue;
    const h = hashOf(v);
    if (entries[key]?.h === h) continue;
    entries[key] = { h, at: after(key), by: self };
    delete tombs[key];
    changed.push(key);
  }
  for (const key of Object.keys(prev.entries)) {
    const file = fileOf(key);
    if (!file || !scope.has(file) || key in current) continue;
    tombs[key] = { at: after(key), by: self };
    delete entries[key];
    changed.push(key);
  }
  return { state: { ...prev, entries, tombs }, changed };
}

/** A first stamp for `--seed`: every entry stamped at its file's
 *  modification time, so this copy is where the others start. */
export function seedState(current: Entries, mtimes: Partial<Record<LibFile, number>>, self: string, now: number): SyncState {
  const entries: Record<string, Held> = {};
  for (const [key, v] of Object.entries(current)) {
    const file = fileOf(key);
    if (!file) continue;
    entries[key] = { h: hashOf(v), at: Math.floor(mtimes[file] ?? now), by: self };
  }
  return { v: 1, joined: { how: "seed", at: now }, entries, tombs: {} };
}

/** `--adopt`: another backend's entries and stamps, whole */
export function adoptDoc(doc: Extract<SyncDoc, { ready: true }>, now: number): { values: Entries; state: SyncState } {
  const values: Entries = {};
  const entries: Record<string, Held> = {};
  for (const [key, e] of Object.entries(doc.entries)) {
    if (!fileOf(key)) continue;
    values[key] = e.v;
    entries[key] = { h: hashOf(e.v), at: e.at, by: e.by };
  }
  const tombs: Record<string, Stamp> = {};
  for (const [key, t] of Object.entries(doc.tombs)) if (fileOf(key) && !(key in entries)) tombs[key] = { at: t.at, by: t.by };
  return { values, state: { v: 1, joined: { how: "adopt", from: doc.backend, at: now }, entries, tombs } };
}

/** the doc this backend answers peers with, from its stamped state */
export function docOf(backend: string, state: SyncState, values: Entries): Extract<SyncDoc, { ready: true }> {
  const entries: Record<string, Stamp & { v: Json }> = {};
  for (const [key, v] of Object.entries(values)) {
    const s = state.entries[key];
    if (s) entries[key] = { v, at: s.at, by: s.by };
  }
  return { backend, ready: true, entries, tombs: { ...state.tombs } };
}

/** whether stamp `a` beats `b`: later wins, a tie goes to the greater name */
export const newer = (a: Stamp, b: Stamp | undefined): boolean => !b || a.at > b.at || (a.at === b.at && a.by > b.by);

/** at most this many deletions go through without `--accept` */
export const MASS_DELETE = 20;

export interface MergeResult {
  values: Entries;
  state: SyncState;
  /** keys whose value was set or changed here */
  taken: string[];
  /** keys deleted here */
  deleted: string[];
  /** keys whose stamp moved with the value already the same */
  restamped: string[];
  /** category tombstones kept back while their folder has projects */
  keptCategories: string[];
  /** why the whole merge is held, or null */
  held: string | null;
}

/** Whether `deleted` deletions out of `total` entries is a mass deletion:
 *  more than MASS_DELETE, or more than a fifth once that is five or more. */
export const massDeletion = (deleted: number, total: number): boolean => deleted > MASS_DELETE || (deleted >= 5 && deleted * 5 > total);

/** Merges a peer's doc into this backend's stamped values, key by key.
 *  `keepCategory(name)` says a category's folder here still has projects,
 *  which keeps its tombstone back (phase 2 moves them first). With
 *  `accept` false, a mass deletion holds the whole merge. */
export function merge(
  mine: { state: SyncState; values: Entries },
  theirs: Extract<SyncDoc, { ready: true }>,
  opts: { keepCategory?: (name: string) => boolean; accept?: boolean } = {},
): MergeResult {
  const values = { ...mine.values };
  const entries = { ...mine.state.entries };
  const tombs = { ...mine.state.tombs };
  const taken: string[] = [];
  const deleted: string[] = [];
  const restamped: string[] = [];
  const keptCategories: string[] = [];
  const mineStamp = (key: string): Stamp | undefined => entries[key] ?? tombs[key];

  for (const [key, e] of Object.entries(theirs.entries)) {
    if (!fileOf(key) || !newer(e, mineStamp(key))) continue;
    const h = hashOf(e.v);
    const same = key in values && entries[key]?.h === h;
    entries[key] = { h, at: e.at, by: e.by };
    delete tombs[key];
    if (same) {
      restamped.push(key);
    } else {
      values[key] = e.v;
      taken.push(key);
    }
  }
  for (const [key, t] of Object.entries(theirs.tombs)) {
    if (!fileOf(key) || key in theirs.entries || !newer(t, mineStamp(key))) continue;
    if (key.startsWith("cat:") && key in values && opts.keepCategory?.(key.slice("cat:".length))) {
      keptCategories.push(key);
      continue;
    }
    if (key in values) {
      delete values[key];
      deleted.push(key);
    }
    delete entries[key];
    tombs[key] = { at: t.at, by: t.by };
  }

  const held = !opts.accept && massDeletion(deleted.length, Object.keys(mine.values).length)
    ? `${theirs.backend} would delete ${deleted.length} of ${Object.keys(mine.values).length} entries`
    : null;
  if (held) return { values: mine.values, state: mine.state, taken: [], deleted, restamped: [], keptCategories, held };
  return { values, state: { ...mine.state, entries, tombs }, taken, deleted, restamped, keptCategories, held: null };
}

/** sync.json read back, or null when it is missing or not one */
export function parseSyncState(raw: unknown): SyncState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const j = r["joined"] as Record<string, unknown> | undefined;
  if (r["v"] !== 1 || !j || (j["how"] !== "seed" && j["how"] !== "adopt") || typeof j["at"] !== "number") return null;
  const stamp = (v: unknown): v is Stamp =>
    !!v && typeof v === "object" && typeof (v as Stamp).at === "number" && typeof (v as Stamp).by === "string";
  const entries: Record<string, Held> = {};
  for (const [k, v] of Object.entries((r["entries"] as Record<string, unknown>) ?? {})) {
    if (stamp(v) && typeof (v as Held).h === "string") entries[k] = { h: (v as Held).h, at: v.at, by: v.by };
  }
  const tombs: Record<string, Stamp> = {};
  for (const [k, v] of Object.entries((r["tombs"] as Record<string, unknown>) ?? {})) if (stamp(v)) tombs[k] = { at: v.at, by: v.by };
  const joined: Joined = { how: j["how"], at: j["at"] };
  if (typeof j["from"] === "string") joined.from = j["from"];
  return { v: 1, joined, entries, tombs };
}

/** a peer's answer read back, or null when it is not a doc */
export function parseSyncDoc(raw: unknown): SyncDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["backend"] !== "string") return null;
  if (r["ready"] === false) return { backend: r["backend"], ready: false };
  if (r["ready"] !== true || !r["entries"] || typeof r["entries"] !== "object" || !r["tombs"] || typeof r["tombs"] !== "object") return null;
  const entries: Record<string, Stamp & { v: Json }> = {};
  for (const [k, v] of Object.entries(r["entries"] as Record<string, unknown>)) {
    const e = v as Record<string, unknown>;
    if (e && typeof e["at"] === "number" && typeof e["by"] === "string" && "v" in e) entries[k] = { v: e["v"] as Json, at: e["at"], by: e["by"] };
  }
  const tombs: Record<string, Stamp> = {};
  for (const [k, v] of Object.entries(r["tombs"] as Record<string, unknown>)) {
    const t = v as Record<string, unknown>;
    if (t && typeof t["at"] === "number" && typeof t["by"] === "string") tombs[k] = { at: t["at"], by: t["by"] };
  }
  return { backend: r["backend"], ready: true, entries, tombs };
}
