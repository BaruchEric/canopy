/**
 * Sink files: the dotenv and JSON files a secret is written into on the
 * machine that owns them. A write touches only the keys it manages, goes
 * through a temp file in the same folder, and refuses what it cannot read
 * back. A file somebody keeps by hand is the one exception (`notes`): its
 * lines canopy cannot read go back byte for byte. No error here holds a
 * value.
 */

import { chmod, chown, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { exec } from "./exec";
import { sameValue } from "./secretcrypt";
import { mcpEnvPath } from "./secretfile";
import type { SecretSinkFormat } from "./types";

export type EnvLine = { kind: "pair"; key: string; value: string; exported: boolean; raw: string } | { kind: "other"; raw: string };

const PAIR = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
/** a line that seems to set a key in a form parseLine does not read: a
 *  label with a colon, a value with words after its quote, a CRLF ending */
const SETS = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/;
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

/** one line as a pair, a comment or a blank; null for anything else */
function parseLine(raw: string): EnvLine | null {
  const t = raw.trim();
  if (t === "" || t.startsWith("#")) return { kind: "other", raw };
  const m = PAIR.exec(raw);
  const value = m ? parseValue((m[3] ?? "").replace(/\r$/, "")) : null;
  return m && value !== null ? { kind: "pair", key: m[2] ?? "", value, exported: !!m[1], raw } : null;
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
    const line = parseLine(raw);
    if (!line) return { error: `line ${i + 1} is not KEY=value, a comment or blank` };
    lines.push(line);
  }
  return { lines, newline };
}

/** A dotenv file somebody keeps by hand, line by line. Pairs, comments and
 *  blanks come back as parseDotenv gives them. A line that is none of those
 *  (a note, a label with a hyphen, a value that runs over several lines) is
 *  kept as it is, and `skipped` holds its number. `unread` maps a key to
 *  the line that seems to set it in a form this cannot read (SETS), and
 *  `open` is the line of a quote that never closes. */
function looseLines(text: string): { lines: EnvLine[]; newline: boolean; skipped: number[]; unread: Map<string, number>; open: number | null } {
  const lines: EnvLine[] = [];
  const skipped: number[] = [];
  const unread = new Map<string, number>();
  const newline = text === "" || text.endsWith("\n");
  const parts = text === "" ? [] : text.split("\n");
  if (text !== "" && newline) parts.pop();
  // the quote a value opened and has not closed yet: its later lines are part of it, never pairs
  let open: { quote: string; line: number } | null = null;
  for (const [i, raw] of parts.entries()) {
    if (open !== null) {
      skipped.push(i + 1);
      lines.push({ kind: "other", raw });
      if (closes(raw, 0, open.quote)) open = null;
      continue;
    }
    const line = parseLine(raw);
    if (line) {
      lines.push(line);
      continue;
    }
    skipped.push(i + 1);
    lines.push({ kind: "other", raw });
    const set = SETS.exec(raw)?.[1];
    if (set !== undefined) unread.set(set, i + 1);
    const v = PAIR.exec(raw)?.[3] ?? "";
    const q = v.charAt(0);
    if ((q === '"' || q === "'") && !closes(v, 1, q)) open = { quote: q, line: i + 1 };
  }
  return { lines, newline, skipped, unread, open: open?.line ?? null };
}

/** The pairs of a dotenv file somebody keeps by hand, and the numbers of
 *  the lines that are none of KEY=value, a comment or blank. The import
 *  reads through this. */
export function looseDotenv(text: string): { pairs: { key: string; value: string }[]; skipped: number[] } {
  const l = looseLines(text);
  return { pairs: l.lines.flatMap((x) => (x.kind === "pair" ? [{ key: x.key, value: x.value }] : [])), skipped: l.skipped };
}

/** A sink file's lines. Strict by default: one line that is not KEY=value,
 *  a comment or blank refuses the file, as compose would. With `notes` (a
 *  file somebody keeps by hand, on a machine that is not the writer) such a
 *  line is carried as it is, and the file is refused only where a write
 *  could go wrong: a quote that never closes, or one of `keys` set on a
 *  line this cannot read, where a new line for it would leave the file
 *  with two answers. */
function sinkLines(text: string, notes: boolean, keys: readonly string[]): { lines: EnvLine[]; newline: boolean } | { error: string } {
  if (!notes) return parseDotenv(text);
  const l = looseLines(text);
  if (l.open !== null) return { error: `line ${l.open} opens a quote that never closes` };
  for (const k of keys) {
    const n = l.unread.get(k);
    if (n !== undefined) return { error: `line ${n} sets ${k} in a form canopy cannot read` };
  }
  return { lines: l.lines, newline: l.newline };
}

/** whether `v`, read from `from`, holds the quote that ends a value; a
 *  backslash guards the next character inside double quotes */
function closes(v: string, from: number, quote: string): boolean {
  for (let i = from; i < v.length; i++) {
    if (quote === '"' && v[i] === "\\") i++;
    else if (v[i] === quote) return true;
  }
  return false;
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

/** the values at `keys`, undefined where a key is absent; `notes` reads a
 *  dotenv file around the lines it cannot read (sinkLines) */
export function readKeys(text: string, format: SecretSinkFormat, keys: readonly string[], notes = false): { values: Record<string, string | undefined> } | { error: string } {
  const values: Record<string, string | undefined> = {};
  if (format === "dotenv") {
    const p = sinkLines(text, notes, keys);
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

/** The file with `updates` written in; `text` null is a new file. With
 *  `notes` a dotenv line this cannot read goes back byte for byte. */
export function applyKeys(text: string | null, format: SecretSinkFormat, updates: Record<string, string>, notes = false): { text: string } | { error: string } {
  if (format === "dotenv") {
    const p = sinkLines(text ?? "", notes, Object.keys(updates));
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

/** the one folder a sink write makes when it is missing: ~/.claude/mcp-env */
export const MCP_ENV_DIR = "mcp-env";

/** a missing mcp-env folder, made 0700 and owned like its parent (~/.claude) */
async function makeMcpEnv(dir: string): Promise<void> {
  const parent = await stat(dirname(dir));
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  if (process.getuid?.() === 0) await chown(dir, parent.uid, parent.gid);
}

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
    let d = await stat(dir).catch((e: unknown) => (code(e) === "ENOENT" && basename(dir) === MCP_ENV_DIR ? null : Promise.reject(e)));
    if (!d) {
      await makeMcpEnv(dir);
      d = await stat(dir);
    }
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

/** Whether dotclaude ignores a server's env file on this machine: the
 *  accident guard before an mcp-allow (phase 2 plan, call 5). */
export const mcpIgnoreRefusal = (home: string, server: string): Promise<string | null> =>
  repoRefusal(mcpEnvPath(home, server), [join(home, ".claude")]);
