/**
 * Sink files: the dotenv and JSON files a secret is written into on the
 * machine that owns them. A write touches only the keys it manages, goes
 * through a temp file in the same folder, and refuses what it cannot read
 * back. No error here holds a value.
 */

import { chmod, chown, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { exec } from "./exec";
import { sameValue } from "./secretcrypt";
import type { SecretSinkFormat } from "./types";

export type EnvLine = { kind: "pair"; key: string; value: string; exported: boolean; raw: string } | { kind: "other"; raw: string };

const PAIR = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const REST = /^\s*(#.*)?$/;
const RAW_OK = /^[A-Za-z0-9_./:@+,=-]*$/;

function parseValue(v: string): string | null {
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    if (end === -1 || !REST.test(v.slice(end + 1))) return null;
    return v.slice(1, end);
  }
  if (v.startsWith('"')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const c = v[i];
      if (c === "\\") {
        const n = v[i + 1];
        if (n === undefined) return null;
        out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
        i++;
      } else if (c === '"') {
        return REST.test(v.slice(i + 1)) ? out : null;
      } else {
        out += c;
      }
    }
    return null;
  }
  return v.replace(/\s+#.*$/, "").trimEnd();
}

/** `newline`: the text ends in one (an empty file counts, so a first key
 *  gets one) */
export function parseDotenv(text: string): { lines: EnvLine[]; newline: boolean } | { error: string } {
  if (text === "") return { lines: [], newline: true };
  const parts = text.split("\n");
  const newline = text.endsWith("\n");
  if (newline) parts.pop();
  const lines: EnvLine[] = [];
  for (const [i, raw] of parts.entries()) {
    const t = raw.trim();
    if (t === "" || t.startsWith("#")) {
      lines.push({ kind: "other", raw });
      continue;
    }
    const m = PAIR.exec(raw);
    const value = m ? parseValue((m[3] ?? "").replace(/\r$/, "")) : null;
    if (!m || value === null) return { error: `line ${i + 1} is not KEY=value, a comment or blank` };
    lines.push({ kind: "pair", key: m[2] ?? "", value, exported: !!m[1], raw });
  }
  return { lines, newline };
}

/** A value as one dotenv line keeps it: bare when safe, single quotes when
 *  it has no quote or newline, double quotes otherwise. A value that would
 *  need double quotes and holds `$` is refused: readers differ on whether
 *  `$` interpolates there. */
export function quoteDotenv(v: string): string | { error: string } {
  if (RAW_OK.test(v)) return v;
  if (!v.includes("'") && !v.includes("\n") && !v.includes("\r")) return `'${v}'`;
  if (v.includes("$")) return { error: "the value has a quote or newline and a $, which no dotenv quoting keeps literal for every reader" };
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** wrapped, since a file's own top-level "error" key must not read as a failure */
function parseJsonObject(text: string): { obj: Record<string, unknown> } | { error: string } {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? { obj: v } : { error: "the file is JSON but not an object" };
  } catch {
    return { error: "the file is not JSON" };
  }
}

/** the values at `keys`, undefined where a key is absent */
export function readKeys(text: string, format: SecretSinkFormat, keys: readonly string[]): { values: Record<string, string | undefined> } | { error: string } {
  const values: Record<string, string | undefined> = {};
  if (format === "dotenv") {
    const p = parseDotenv(text);
    if ("error" in p) return p;
    for (const k of keys) {
      // the last line of a key wins, as compose reads it
      const hit = p.lines.filter((l): l is Extract<EnvLine, { kind: "pair" }> => l.kind === "pair" && l.key === k).pop();
      values[k] = hit?.value;
    }
    return { values };
  }
  const parsed = parseJsonObject(text);
  if ("error" in parsed) return parsed;
  const obj = parsed.obj;
  for (const k of keys) {
    let at: unknown = obj;
    for (const seg of k.split(".")) at = isObj(at) ? at[seg] : undefined;
    if (at !== undefined && typeof at !== "string") return { error: `${k} holds something other than a string` };
    values[k] = at;
  }
  return { values };
}

/** The file with `updates` written in; `text` null is a new file. */
export function applyKeys(text: string | null, format: SecretSinkFormat, updates: Record<string, string>): { text: string } | { error: string } {
  if (format === "dotenv") {
    const p = parseDotenv(text ?? "");
    if ("error" in p) return p;
    const quoted: Record<string, string> = {};
    for (const [k, v] of Object.entries(updates)) {
      const q = quoteDotenv(v);
      if (typeof q !== "string") return { error: `${k}: ${q.error}` };
      quoted[k] = q;
    }
    const seen = new Set<string>();
    // a line canopy does not manage goes back exactly as it was read
    const lines = p.lines.map((l) => {
      const q = l.kind === "pair" ? quoted[l.key] : undefined;
      if (l.kind === "other" || q === undefined) return l.raw;
      seen.add(l.key);
      return `${l.exported ? "export " : ""}${l.key}=${q}`;
    });
    for (const [k, q] of Object.entries(quoted)) if (!seen.has(k)) lines.push(`${k}=${q}`);
    return { text: lines.join("\n") + (p.newline ? "\n" : "") };
  }
  const parsed = parseJsonObject(text ?? "{}");
  if ("error" in parsed) return parsed;
  const obj = parsed.obj;
  for (const [k, v] of Object.entries(updates)) {
    const segs = k.split(".");
    let at: Record<string, unknown> = obj;
    for (const seg of segs.slice(0, -1)) {
      const next = at[seg];
      if (next === undefined) at = at[seg] = {};
      else if (isObj(next)) at = next;
      else return { error: `${k} runs through ${seg}, which is not an object` };
    }
    at[segs[segs.length - 1] ?? k] = v;
  }
  if (text === null) return { text: JSON.stringify(obj, null, "  ") + "\n" };
  // splice each value into the text, so every byte canopy does not manage
  // (key order, number spelling, escapes, layout) stays as it was
  let out = text;
  for (const [k, v] of Object.entries(updates)) out = spliceJson(out, k.split("."), v);
  return { text: out };
}

type JNode = { kind: "obj"; open: number; close: number; members: { key: string; keyStart: number; value: JNode }[] } | { kind: "other"; start: number; end: number };

/** Where each value sits in a JSON text that JSON.parse already accepted. */
function jsonTree(text: string): JNode {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text.charAt(i))) i++;
  };
  const str = (): string => {
    const s = i++;
    while (text.charAt(i) !== '"') i += text.charAt(i) === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(s, i)) as string;
  };
  const value = (): JNode => {
    ws();
    const start = i;
    const c = text.charAt(i);
    if (c === "{") {
      i++;
      const members: { key: string; keyStart: number; value: JNode }[] = [];
      ws();
      while (text.charAt(i) !== "}") {
        ws();
        const keyStart = i;
        const key = str();
        ws();
        i++;
        members.push({ key, keyStart, value: value() });
        ws();
        if (text.charAt(i) === ",") i++;
        ws();
      }
      return { kind: "obj", open: start, close: i++, members };
    }
    if (c === "[") {
      i++;
      ws();
      while (text.charAt(i) !== "]") {
        value();
        ws();
        if (text.charAt(i) === ",") i++;
        ws();
      }
      i++;
      return { kind: "other", start, end: i };
    }
    if (c === '"') {
      str();
      return { kind: "other", start, end: i };
    }
    while (i < text.length && !",}] \t\n\r".includes(text.charAt(i))) i++;
    return { kind: "other", start, end: i };
  };
  return value();
}

const startOf = (n: JNode): number => (n.kind === "obj" ? n.open : n.start);
const endOf = (n: JNode): number => (n.kind === "obj" ? n.close + 1 : n.end);

/** `text` with the string `v` at `path`, made where it is missing; the
 *  caller has checked that the path runs through objects only */
function spliceJson(text: string, path: string[], v: string): string {
  let node = jsonTree(text);
  for (let n = 0; n < path.length; n++) {
    if (node.kind !== "obj") return text;
    const seg = path[n] ?? "";
    const hit = node.members.filter((m) => m.key === seg).pop();
    if (hit && n === path.length - 1) return text.slice(0, startOf(hit.value)) + JSON.stringify(v) + text.slice(endOf(hit.value));
    if (hit) {
      node = hit.value;
      continue;
    }
    let val: unknown = v;
    for (const s of path.slice(n + 1).reverse()) val = { [s]: val };
    const member = `${JSON.stringify(seg)}: ${JSON.stringify(val)}`;
    const first = node.members[0];
    const last = node.members[node.members.length - 1];
    if (!first || !last) return text.slice(0, node.open + 1) + member + text.slice(node.open + 1);
    const at = endOf(last.value);
    return `${text.slice(0, at)},${text.slice(node.open + 1, first.keyStart)}${member}${text.slice(at)}`;
  }
  return text;
}

/** What the owner does with one sink key. `applied` is the rotation stamp
 *  it last wrote there, undefined when it never has. */
export function decideKey(applied: string | undefined, rotated: string, file: string | undefined, value: string): "same" | "write" | "drift" {
  if (file !== undefined && sameValue(file, value)) return "same";
  if (file === undefined) return "write";
  // only a newer stamp than the one written: an older one is a file put back
  if (applied !== undefined && applied < rotated) return "write";
  return "drift";
}

const code = (err: unknown): unknown => (typeof err === "object" && err !== null && "code" in err ? (err as { code: unknown }).code : undefined);

/** the file's text, null when it does not exist; a symlink is refused */
export async function readSinkFile(path: string): Promise<{ text: string | null } | { error: string }> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return { error: `${path} is a symlink; canopy writes only plain files` };
    return { text: await readFile(path, "utf8") };
  } catch (err) {
    if (code(err) === "ENOENT") return { text: null };
    return { error: `${path} cannot be read (${String(code(err) ?? "error")})` };
  }
}

let writes = 0;

/** Temp file in the same folder at 0600, the old file's owner (or the
 *  folder's, for a new file) when this runs as root, renamed over. */
export async function writeSinkFile(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  let owner: { uid: number; gid: number };
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) throw new Error(`${path} is a symlink; canopy writes only plain files`);
    owner = { uid: s.uid, gid: s.gid };
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
    const d = await stat(dir);
    owner = { uid: d.uid, gid: d.gid };
  }
  const tmp = join(dir, `.${basename(path)}.canopy-${process.pid}-${++writes}`);
  await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
  try {
    await chmod(tmp, 0o600);
    if (process.getuid?.() === 0) await chown(tmp, owner.uid, owner.gid);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Why a sink may not live at `path`: inside a scanned repo where git does
 *  not ignore it (a tracked file is never ignored). Null when it may. */
export async function repoRefusal(path: string, repoRoots: readonly string[]): Promise<string | null> {
  const root = repoRoots
    .filter((r) => path.startsWith(r.endsWith("/") ? r : `${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const r = await exec(["git", "-C", root, "check-ignore", "-q", path.slice(root.replace(/\/$/, "").length + 1)], { timeoutMs: 10_000 });
  if (r.code === 0) return null;
  return `${path} is inside the repo ${root} and git does not ignore it there`;
}
