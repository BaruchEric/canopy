/**
 * The only code that writes an agent's MCP config (phase 2 spec, "Writing
 * the agents' config"). Codex's config.toml is spliced as text, so every
 * byte outside canopy's marked tables stays, and written in place, since
 * ~/.codex is a bind mount on the mini. Claude's servers go through its
 * own CLI, since Claude Code rewrites ~/.claude.json many times a session
 * and on the mini it is a single-file bind mount. Nothing here logs, and
 * an error passes through `scrub` before it leaves.
 */

import { firstLine, type onHost } from "./exec";
import type { KitMcpEntry } from "./types";

export const MARKER = "# canopy-kit: managed";

/** under ~/.claude: what canopy wrote, and what adopt replaced (KitMcpOwned) */
export const OWNED_FILE = ".canopy-kit-mcp.json";

export interface McpIO {
  run: typeof onHost;
  host: string | null;
  env?: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** a [table] header's dotted path with its quotes taken off; null for any other line */
function tomlPath(line: string): string[] | null {
  const m = /^\s*\[([^[\]]*)\]\s*(#.*)?$/.exec(line);
  if (!m) return null;
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  const s = m[1] ?? "";
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    const p = re.exec(s);
    if (!p) return null;
    out.push(p[1] !== undefined ? (JSON.parse(`"${p[1]}"`) as string) : (p[2] ?? p[3] ?? ""));
    at = re.lastIndex;
    if (p[4] === "") break;
  }
  return out;
}

const under = (p: string[] | null, name: string): boolean => !!p && p.length >= 2 && p[0] === "mcp_servers" && p[1] === name;

/** The servers config.toml defines; null when it does not parse. Bun's
 *  own TOML parser, so the parse error's text (which can quote a line)
 *  never leaves this function. */
export function codexServers(text: string): Record<string, KitMcpEntry> | null {
  try {
    const m = (Bun.TOML.parse(text) as Record<string, unknown>)["mcp_servers"];
    return isObj(m) ? (Object.fromEntries(Object.entries(m).filter(([, v]) => isObj(v))) as Record<string, KitMcpEntry>) : {};
  } catch {
    return null;
  }
}

/** Where a [mcp_servers.<name>] table that starts its body at `from` ends:
 *  at the next marker, array table or table not under it, with the blank
 *  lines before that left outside. */
function tableEnd(lines: string[], from: number, name: string): number {
  let j = from;
  for (; j < lines.length; j++) {
    const l = lines[j] ?? "";
    if (l.trim() === MARKER || /^\s*\[\[/.test(l)) break;
    const p = tomlPath(l);
    if (p && !under(p, name)) break;
  }
  while (j > from && (lines[j - 1] ?? "").trim() === "") j--;
  return j;
}

/** Canopy's tables: the marker line, its [mcp_servers.<name>] header, and
 *  every line up to the next table not under it. Line-based, so a table
 *  header inside a multi-line string would end a block early; canopy
 *  writes no multi-line strings, and the parse check after each splice
 *  catches a broken result. */
export function codexBlocks(text: string): { name: string; start: number; end: number }[] {
  const lines = text.split("\n");
  const out: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== MARKER) continue;
    const head = tomlPath(lines[i + 1] ?? "");
    if (!head || head.length !== 2 || head[0] !== "mcp_servers") continue;
    const name = head[1] ?? "";
    const end = tableEnd(lines, i + 2, name);
    out.push({ name, start: i, end });
    i = end - 1;
  }
  return out;
}

/** a hand-made [mcp_servers.<name>] and its subtables, when they sit together */
function foreignRegion(lines: string[], name: string): { start: number; end: number } | { error: string } | null {
  const start = lines.findIndex((l) => {
    const p = tomlPath(l);
    return under(p, name) && p?.length === 2;
  });
  if (start < 0) return null;
  const end = tableEnd(lines, start + 1, name);
  if (lines.slice(end).some((l) => under(tomlPath(l), name))) return { error: `config.toml splits [mcp_servers.${name}] across the file; adopt it by hand` };
  return { start, end };
}

const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function tomlValue(v: unknown): string {
  // a JSON string is a TOML basic string, but for DEL, which TOML wants escaped
  if (typeof v === "string") return JSON.stringify(v).replace(/\u007f/g, "\\u007f");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (isObj(v)) return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
  throw new Error("config.toml takes strings, numbers, booleans, lists and tables");
}

/** one server as TOML: its own table, env and headers as inline tables */
export const codexTable = (name: string, entry: KitMcpEntry, marked = true): string =>
  [...(marked ? [MARKER] : []), `[mcp_servers.${tomlKey(name)}]`, ...Object.entries(entry).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)].join("\n");

const append = (text: string, table: string): string[] => {
  const body = text.replace(/\n+$/, "");
  return [...(body === "" ? [] : [body, ""]), ...table.split("\n"), ""];
};

/** The next config.toml. "kit" sets (or, with null, removes) canopy's own
 *  table; "adopt" turns a hand-made one into canopy's in place; "restore"
 *  turns canopy's back into a plain table holding `entry`. */
export function spliceCodex(text: string, name: string, entry: KitMcpEntry | null, how: "kit" | "adopt" | "restore" = "kit"): { text: string } | { error: string } {
  const have = codexServers(text);
  if (have === null) return { error: "config.toml does not parse; left as it is" };
  const lines = text.split("\n");
  const b = codexBlocks(text).find((x) => x.name === name);
  let next: string[];
  if (how === "adopt") {
    if (b || !entry) return { error: `[mcp_servers.${name}] is canopy's already` };
    const r = foreignRegion(lines, name);
    if (!r) return { error: `config.toml has no [mcp_servers.${name}] to adopt` };
    if ("error" in r) return r;
    next = [...lines.slice(0, r.start), ...codexTable(name, entry).split("\n"), ...lines.slice(r.end)];
  } else if (how === "restore") {
    if (!entry) return { error: `nothing to put back for ${name}` };
    if (b) next = [...lines.slice(0, b.start), ...codexTable(name, entry, false).split("\n"), ...lines.slice(b.end)];
    else if (name in have) return { error: `config.toml has a [mcp_servers.${name}] canopy did not write; it is back already` };
    else next = append(text, codexTable(name, entry, false));
  } else if (b) {
    if (entry) next = [...lines.slice(0, b.start), ...codexTable(name, entry).split("\n"), ...lines.slice(b.end)];
    else {
      next = [...lines.slice(0, b.start), ...lines.slice(b.end)];
      // the blank line the append put before the block goes with it
      if (b.start > 0 && next[b.start - 1] === "" && (next[b.start] === "" || next[b.start] === undefined)) next.splice(b.start - 1, 1);
    }
  } else {
    if (!entry) return { text };
    if (name in have) return { error: `config.toml has a [mcp_servers.${name}] canopy did not write; adopt it instead` };
    next = append(text, codexTable(name, entry));
  }
  const out = next.join("\n");
  if (codexServers(out) === null) return { error: "the change would leave config.toml unparseable; left as it is" };
  return { text: out };
}

/** Prints "<mtime> <size> <crc>", GNU stat first, then BSD's, and cksum's
 *  CRC, since mtime is in seconds and a same-size rewrite within the second
 *  would pass on the first two alone. Nothing for a missing file, and "?"
 *  for a part it cannot read, so an unreadable file never stamps as missing. */
export const STAT_FN = `st() {
  [ -e "$1" ] || return 0
  st_m=$(stat -c '%Y %s' "$1" 2>/dev/null || stat -f '%m %z' "$1" 2>/dev/null) || st_m='?'
  st_c=$(cksum < "$1" 2>/dev/null) || st_c='?'
  printf '%s %s\\n' "$st_m" "\${st_c%% *}"
}`;

/** args: the file and the stamp the scan saw ("" for a missing file); the
 *  new text on stdin. Staged beside the file, then copied over it with
 *  cat, so the inode (and a bind mount of it) stays. */
const INPLACE_SCRIPT = `${STAT_FN}
f=$1; want=$2
tmp="$f.canopy-$$"
umask 077
cat > "$tmp" || { rm -f "$tmp"; echo "could not stage the new text"; exit 0; }
if [ "$(st "$f")" != "$want" ]; then rm -f "$tmp"; echo moved; exit 0; fi
cat "$tmp" > "$f" && rm -f "$tmp" && echo ok
`;

export async function inplaceWrite(io: McpIO, path: string, stamp: string, text: string): Promise<string | null> {
  const r = await io.run(io.host, ["sh", "-c", INPLACE_SCRIPT, "kit-write", path, stamp], { env: io.env, input: text, timeoutMs: 30_000 });
  const said = r.stdout.trim();
  if (said === "ok") return null;
  if (said === "moved") return "config.toml changed since the scan; rescan and apply again";
  return said || firstLine(r.stderr) || `the write exited ${r.code}`;
}

/** the strings in an entry that could be values: env and header values, a url, long args */
function sensitive(e: KitMcpEntry | null): string[] {
  if (!e) return [];
  const out: string[] = [];
  for (const k of ["env", "headers", "http_headers"]) {
    const v = e[k];
    if (isObj(v)) for (const x of Object.values(v)) if (typeof x === "string" && x.length >= 4) out.push(x);
  }
  if (typeof e["url"] === "string") out.push(e["url"]);
  if (Array.isArray(e["args"])) for (const a of e["args"]) if (typeof a === "string" && a.length >= 16) out.push(a);
  return out;
}

/** an error line with every such string taken out, since a CLI may echo what it was given */
export const scrub = (text: string, entries: (KitMcpEntry | null)[]): string =>
  entries.flatMap(sensitive).sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join("•••"), text);

/** `claude mcp add-json` refuses a name that exists (claude 2.1.296 exits 1
 *  with "MCP server <name> already exists in user config", seen on the mini
 *  and the Mac), so an old entry is removed first and put back when the add
 *  fails. The put back sends the old entry, which may be a hand-made one
 *  holding a literal value, through argv: add-json has no stdin form. */
export async function claudeSet(io: McpIO, claude: string, name: string, entry: KitMcpEntry, old: KitMcpEntry | null): Promise<string | null> {
  const cli = (args: string[]) => io.run(io.host, [claude, "mcp", ...args], { env: io.env, timeoutMs: 60_000 });
  if (old) {
    const r = await cli(["remove", "--scope", "user", name]);
    if (r.code !== 0) return scrub(firstLine(r.stderr), [old]) || `claude mcp remove exited ${r.code}`;
  }
  const r = await cli(["add-json", "--scope", "user", name, JSON.stringify(entry)]);
  if (r.code === 0) return null;
  const why = scrub(firstLine(r.stderr), [entry, old]) || `claude mcp add-json exited ${r.code}`;
  if (old) await cli(["add-json", "--scope", "user", name, JSON.stringify(old)]);
  return why;
}

export async function claudeRemove(io: McpIO, claude: string, name: string, old: KitMcpEntry | null): Promise<string | null> {
  const r = await io.run(io.host, [claude, "mcp", "remove", "--scope", "user", name], { env: io.env, timeoutMs: 60_000 });
  return r.code === 0 ? null : scrub(firstLine(r.stderr), [old]) || `claude mcp remove exited ${r.code}`;
}
