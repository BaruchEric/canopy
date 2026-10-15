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
import type { KitAction, KitMcpAction, KitMcpEntry, KitMcpFormat, KitMcpSeen } from "./types";

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
 *  and comment lines before that left outside, since a comment there heads
 *  the next table. Canopy writes no comment inside its own tables but the
 *  marker, which is never one of these. */
function tableEnd(lines: string[], from: number, name: string): number {
  let j = from;
  for (; j < lines.length; j++) {
    const l = lines[j] ?? "";
    if (l.trim() === MARKER || /^\s*\[\[/.test(l)) break;
    const p = tomlPath(l);
    if (p && !under(p, name)) break;
  }
  for (; j > from; j--) {
    const l = (lines[j - 1] ?? "").trim();
    if (l !== "" && (!l.startsWith("#") || l === MARKER)) break;
  }
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
 *  cat, so the inode (and a bind mount of it) stays. A copy that fails
 *  may leave the file cut short, so the staged copy stays and is named. */
const INPLACE_SCRIPT = `${STAT_FN}
f=$1; want=$2
tmp="$f.canopy-$$"
umask 077
cat > "$tmp" || { rm -f "$tmp"; echo "could not stage the new text"; exit 0; }
if [ "$(st "$f")" != "$want" ]; then rm -f "$tmp"; echo moved; exit 0; fi
if cat "$tmp" > "$f"; then rm -f "$tmp"; echo ok; else printf 'staged %s\\n' "$tmp"; fi
`;

export async function inplaceWrite(io: McpIO, path: string, stamp: string, text: string): Promise<string | null> {
  const r = await io.run(io.host, ["sh", "-c", INPLACE_SCRIPT, "kit-write", path, stamp], { env: io.env, input: text, timeoutMs: 30_000 });
  const said = r.stdout.trim();
  if (said === "ok") return null;
  if (said === "moved") return "config.toml changed since the scan; rescan and apply again";
  if (said.startsWith("staged ")) return `config.toml was not written in full; the new text is in ${said.slice(7)}; copy it over config.toml to restore it`;
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
  // and each as it reads inside a JSON echo, quotes and backslashes escaped
  return out.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
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
  if (!old) return why;
  const back = await cli(["add-json", "--scope", "user", name, JSON.stringify(old)]);
  if (back.code === 0) return why;
  return `${why}; the old entry could not be put back: ${scrub(firstLine(back.stderr), [entry, old]) || `claude mcp add-json exited ${back.code}`}`;
}

export async function claudeRemove(io: McpIO, claude: string, name: string, old: KitMcpEntry | null): Promise<string | null> {
  const r = await io.run(io.host, [claude, "mcp", "remove", "--scope", "user", name], { env: io.env, timeoutMs: 60_000 });
  return r.code === 0 ? null : scrub(firstLine(r.stderr), [old]) || `claude mcp remove exited ${r.code}`;
}


/** writes ~/.claude/.canopy-kit-mcp.json from stdin, 0600. ~/.claude is a
 *  folder mount on the mini, not a single-file one, so a rename inside it
 *  is safe there and the file is never seen half written. The staged copy
 *  goes on any exit, since it can hold a kept entry's literal value. */
const OWNED_WRITE = `f=$1
tmp="$f.tmp-$$"
umask 077
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" && mv -f "$tmp" "$f" && chmod 600 "$f" && echo ok`;

type Failed = { action: KitAction; why: string };

const fileLabel = (format: KitMcpFormat): string => (format === "claude-json" ? "~/.claude.json" : "config.toml");

/** Carry out MCP actions on one machine. Claude's go one by one through
 *  its CLI; each Codex file is spliced in memory and written once, so a
 *  file that moved fails every action on it and changes nothing. A set or
 *  remove touches only what canopy wrote, an adopt only what it did not.
 *  The ownership file takes an adopt's kept entry before the adopt writes,
 *  and what was placed last, from what was done. It never leaves this
 *  machine: the result names actions only. */
export async function applyMcp(mcp: KitMcpSeen, home: string, actions: KitMcpAction[], entries: Record<string, KitMcpEntry>, formats: Record<string, KitMcpFormat>, io: McpIO): Promise<{ done: KitAction[]; failed: Failed[] }> {
  const done: KitAction[] = [];
  const failed: Failed[] = [];
  const placed: Record<string, string[]> = structuredClone(mcp.owned.placed);
  const adoptedFrom: KitMcpSeen["owned"]["adoptedFrom"] = structuredClone(mcp.owned.adoptedFrom);
  const codex = new Map<string, { text: string; actions: KitMcpAction[]; owned: (() => void)[] }>();
  const own = (agent: string, name: string, on: boolean) => {
    const p = (placed[agent] ??= []).filter((n) => n !== name);
    placed[agent] = on ? [...p, name].sort() : p;
  };
  const kept = () => Object.values(adoptedFrom).flatMap((x) => Object.values(x));
  /** the ownership file as it now stands in memory; null when written */
  const save = async (): Promise<string | null> => {
    const r = await io.run(io.host, ["sh", "-c", OWNED_WRITE, "kit-owned", `${home}/.claude/${OWNED_FILE}`], {
      env: io.env, input: `${JSON.stringify({ placed, adoptedFrom }, null, 2)}\n`, timeoutMs: 30_000,
    });
    return r.stdout.trim() === "ok" ? null : scrub(firstLine(r.stderr), [...Object.values(entries), ...kept()]) || `exited ${r.code}`;
  };
  /** An adopt keeps the hand-made entry on disk before it replaces it, so
   *  the worst a failure after that leaves is an entry kept but not placed,
   *  which put back still restores. When it cannot be kept, nothing changes. */
  const keep = async (a: KitMcpAction, entry: KitMcpEntry): Promise<string | null> => {
    const was = adoptedFrom[a.agent]?.[a.name];
    (adoptedFrom[a.agent] ??= {})[a.name] = entry;
    const why = await save();
    if (!why) return null;
    if (was) adoptedFrom[a.agent]![a.name] = was;
    else delete adoptedFrom[a.agent]![a.name];
    return `the hand-made entry could not be kept in ~/.claude/${OWNED_FILE}; left as it is: ${why}`;
  };

  // read as empty, the ownership file's next save would wipe what it records
  if (mcp.ownedError) return { done, failed: actions.map((action) => ({ action, why: mcp.ownedError ?? "" })) };
  for (const a of actions) {
    const file = mcp.files.find((f) => f.agent === a.agent);
    const format = formats[a.agent];
    if (!file || !format) {
      failed.push({ action: a, why: `${a.agent} has no MCP file here` });
      continue;
    }
    // "?" is STAT_FN's word for a part it could not read; such a file's
    // text read as empty, and writing from it would replace the file
    if (file.stamp.includes("?")) {
      failed.push({ action: a, why: `${fileLabel(format)} is not readable here; left as it is` });
      continue;
    }
    if (file.entries === null) {
      failed.push({ action: a, why: file.error ?? `${fileLabel(format)} does not parse` });
      continue;
    }
    const current = file.entries[a.name] ?? null;
    const mine = (mcp.owned.placed[a.agent] ?? []).includes(a.name);
    const want = entries[`${a.agent}/${a.name}`] ?? null;
    const before = adoptedFrom[a.agent]?.[a.name] ?? null;
    const refuse =
      (a.kind === "mcp-set" || a.kind === "mcp-adopt") && !want ? "nothing to write for it; rescan"
      : a.kind === "mcp-set" && current && !mine ? "a hand-made entry canopy did not write; adopt it instead"
      : a.kind === "mcp-remove" && current && !mine ? "a hand-made entry canopy did not write; left as it is"
      : a.kind === "mcp-adopt" && mine ? "canopy manages it already"
      : a.kind === "mcp-adopt" && !current ? "no hand-made entry to adopt; rescan"
      : a.kind === "mcp-restore" && !before ? "canopy keeps no hand-made entry for it"
      : null;
    if (refuse) {
      failed.push({ action: a, why: refuse });
      continue;
    }
    const record = () => {
      if (a.kind === "mcp-set") own(a.agent, a.name, true);
      else if (a.kind === "mcp-remove") own(a.agent, a.name, false);
      else if (a.kind === "mcp-adopt" && current) {
        own(a.agent, a.name, true);
        (adoptedFrom[a.agent] ??= {})[a.name] = current;
      } else if (a.kind === "mcp-restore") {
        own(a.agent, a.name, false);
        delete (adoptedFrom[a.agent] ??= {})[a.name];
      }
    };
    if (format === "claude-json") {
      if (!mcp.claude) {
        failed.push({ action: a, why: "no claude binary found here" });
        continue;
      }
      const notKept = a.kind === "mcp-adopt" && current ? await keep(a, current) : null;
      if (notKept) {
        failed.push({ action: a, why: notKept });
        continue;
      }
      // put back sends the kept entry, which may hold a literal value,
      // through add-json's argv; claudeSet scrubs what comes back
      const why =
        a.kind === "mcp-remove" ? (current ? await claudeRemove(io, mcp.claude, a.name, current) : null)
        : a.kind === "mcp-restore" ? await claudeSet(io, mcp.claude, a.name, before ?? {}, current)
        : await claudeSet(io, mcp.claude, a.name, want ?? {}, current);
      if (why) failed.push({ action: a, why });
      else {
        record();
        done.push(a);
      }
      continue;
    }
    const c = codex.get(file.path) ?? { text: file.text, actions: [], owned: [] };
    codex.set(file.path, c);
    const how = a.kind === "mcp-adopt" ? "adopt" : a.kind === "mcp-restore" ? "restore" : "kit";
    const next = spliceCodex(c.text, a.name, a.kind === "mcp-remove" ? null : a.kind === "mcp-restore" ? before : want, how);
    if ("error" in next) {
      failed.push({ action: a, why: next.error });
      continue;
    }
    const notKept = a.kind === "mcp-adopt" && current ? await keep(a, current) : null;
    if (notKept) {
      failed.push({ action: a, why: notKept });
      continue;
    }
    c.text = next.text;
    c.actions.push(a);
    c.owned.push(record);
  }

  for (const [path, c] of codex) {
    if (c.actions.length === 0) continue;
    const file = mcp.files.find((f) => f.path === path);
    const why = await inplaceWrite(io, path, file?.stamp ?? "", c.text);
    if (why) for (const a of c.actions) failed.push({ action: a, why });
    else {
      for (const r of c.owned) r();
      done.push(...c.actions);
    }
  }

  if (done.length > 0) {
    const not = await save();
    if (not) {
      const why = `written, but ~/.claude/${OWNED_FILE} was not: ${not}`;
      return { done: [], failed: [...failed, ...done.map((action) => ({ action, why }))] };
    }
  }
  return { done, failed };
}
