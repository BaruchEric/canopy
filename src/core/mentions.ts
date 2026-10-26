/**
 * What a prompt box offers after `/` or `$`: the slash commands and skills
 * Claude Code lists for a repo, and Codex's skills, read off the folders the
 * agents read themselves, wherever the repo lives (over ssh for a remote
 * one). Files (`@`) come from finder.ts. The CLI's own init message names
 * every command, the terminal-only ones with the rest, and only once a turn
 * has begun, so the folders are read instead. Tested in mentions.test.ts.
 */
import { onHost } from "./exec";
import { FinderError } from "./finder";
import { parseLocator, tildeQuote } from "./host";
import type { Harness, Mention } from "./types";

/** how much of a file the scan hands back: its frontmatter and a first line */
export const HEAD_BYTES = 3000;

/** the scan's shell functions, for here and over ssh. A record is kind,
 *  source and name on three lines, then the file's head, NUL-ended. */
const SCAN_FUNCTIONS = [
  `emit() { printf '%s\\n%s\\n%s\\n' "$1" "$2" "$3"; head -c ${HEAD_BYTES} "$4" 2>/dev/null; printf '\\0'; }`,
  "cmds() {",
  '  [ -d "$1" ] || return 0',
  `  find -L "$1" -maxdepth 3 -type f -name '*.md' 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do`,
  '    r=${f#"$1"/}; emit command "$2" "${r%.md}" "$f"',
  "  done",
  "}",
  "skills() {",
  '  [ -d "$1" ] || return 0',
  `  find -L "$1" -mindepth 2 -maxdepth 2 -type f -name SKILL.md 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do`,
  '    d=${f%/SKILL.md}; emit skill "$2" "${d##*/}" "$f"',
  "  done",
  "}",
];

/** The folders pass: the user's and the repo's commands and skills for
 *  each agent, then the plugins' manifest and the user settings whole, for
 *  the plugin pass to read. $1 is the home to read, the shell's own when
 *  empty. Exit 3: no repo folder. */
export function scanCommand(root: string, home = ""): string[] {
  const script = [
    ...SCAN_FUNCTIONS,
    `R=$(cd ${tildeQuote(root)} 2>/dev/null && pwd -P) || exit 3`,
    'H=${1:-$HOME}',
    'cmds "$H/.claude/commands" user',
    'skills "$H/.claude/skills" user',
    'cmds "$R/.claude/commands" project',
    'skills "$R/.claude/skills" project',
    'skills "$H/.codex/skills" codex-user',
    'skills "$H/.agents/skills" codex-user',
    'skills "$R/.codex/skills" codex-project',
    'skills "$R/.agents/skills" codex-project',
    'm="$H/.claude/plugins/installed_plugins.json"',
    `[ -f "$m" ] && { printf 'plugins\\n-\\n-\\n'; cat "$m"; printf '\\0'; }`,
    's="$H/.claude/settings.json"',
    `[ -f "$s" ] && { printf 'settings\\n-\\n-\\n'; cat "$s"; printf '\\0'; }`,
    "exit 0",
  ].join("\n");
  return ["sh", "-c", script, "sh", home];
}

/** The plugin pass: each plugin's commands and skills, from name and path
 *  pairs on the command line. */
export function pluginCommand(plugins: readonly PluginDir[]): string[] {
  const script = [
    ...SCAN_FUNCTIONS,
    'while [ $# -ge 2 ]; do',
    '  n=$1; p=$2; shift 2',
    '  cmds "$p/commands" "plugin:$n"',
    '  skills "$p/skills" "plugin:$n"',
    "done",
  ].join("\n");
  return ["sh", "-c", script, "sh", ...plugins.flatMap((p) => [p.name, p.path])];
}

/** one record of the scan's output */
export interface ScanRecord {
  kind: string;
  from: string;
  name: string;
  head: string;
}

export function parseScan(out: string): ScanRecord[] {
  const records: ScanRecord[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const a = rec.indexOf("\n");
    const b = a < 0 ? -1 : rec.indexOf("\n", a + 1);
    const c = b < 0 ? -1 : rec.indexOf("\n", b + 1);
    if (c < 0) continue;
    records.push({ kind: rec.slice(0, a), from: rec.slice(a + 1, b), name: rec.slice(b + 1, c), head: rec.slice(c + 1) });
  }
  return records;
}

const unquote = (v: string): string => {
  const q = v[0];
  return (q === '"' || q === "'") && v.length > 1 && v.endsWith(q) ? v.slice(1, -1) : v;
};

/** The `name` and `description` of a file's YAML frontmatter, read as the
 *  agents write them: one line, quoted or not, or a folded (`>-`) or
 *  literal (`|`) block on the indented lines after, joined into one line. */
export function frontmatter(head: string): { name: string | null; description: string | null } {
  const none = { name: null, description: null };
  if (!head.startsWith("---")) return none;
  const end = head.indexOf("\n---", 3);
  const body = end < 0 ? head.slice(3) : head.slice(3, end);
  const fields: Record<string, string> = {};
  let key: string | null = null;
  let acc: string[] = [];
  const flush = () => {
    if (key) fields[key] = acc.join(" ").replace(/\s+/g, " ").trim();
  };
  for (const line of body.split("\n")) {
    const [, k = "", rest = ""] = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line) ?? [];
    if (k) {
      flush();
      key = k;
      const v = rest.trim();
      acc = v === ">-" || v === ">" || v === "|" || v === "|-" ? [] : [unquote(v)];
    } else if (key && /^\s+\S/.test(line)) {
      acc.push(line.trim());
    }
  }
  flush();
  return { name: fields["name"] || null, description: fields["description"] || null };
}

/** A command file's first line of text past its frontmatter, as its
 *  description when it gives none. */
export function firstLine(head: string): string {
  let body = head;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    body = end < 0 ? "" : body.slice(end + 4);
  }
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) return "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** the mentions the records name, in the scan's order */
export function mentionsOf(records: readonly ScanRecord[]): Mention[] {
  const out: Mention[] = [];
  for (const r of records) {
    if (r.kind !== "command" && r.kind !== "skill") continue;
    const codex = r.from.startsWith("codex-");
    const harness: Harness = codex ? "codex" : "claude";
    const from = codex ? r.from.slice("codex-".length) : r.from;
    const plugin = from.startsWith("plugin:") ? from.slice("plugin:".length) : null;
    const parts = r.name.split("/");
    const leaf = parts.at(-1) ?? "";
    if (!leaf) continue;
    const name = plugin ? `${plugin}:${leaf}` : leaf;
    const fm = frontmatter(r.head);
    if (r.kind === "command") {
      // a subfolder sorts a command and shows beside it; the name stays the file's
      const folder = parts.slice(0, -1).join("/");
      out.push({ name, kind: "command", harness, from: folder ? `${from}:${folder}` : from, description: fm.description ?? firstLine(r.head) });
    } else {
      // the folder names a skill; what its SKILL.md calls it shows beside it
      const alias = fm.name && fm.name !== leaf ? fm.name : null;
      out.push({ name, kind: "skill", harness, from, description: fm.description ?? "", ...(alias ? { alias } : {}) });
    }
  }
  return out;
}

/** an installed plugin's name and folder */
export interface PluginDir {
  name: string;
  path: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const jsonOf = (text: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
};

/** The plugins Claude Code loads: every one in the manifest, less those the
 *  settings (or the manifest itself) switch off. The manifest keys a plugin
 *  as `name@marketplace` with one install per scope. */
export function enabledPlugins(manifest: string, settings: string): PluginDir[] {
  const m = jsonOf(manifest);
  const s = jsonOf(settings);
  const installed = isObj(m["plugins"]) ? m["plugins"] : {};
  const onBySettings = isObj(s["enabledPlugins"]) ? s["enabledPlugins"] : {};
  const onByManifest = isObj(m["enabledPlugins"]) ? m["enabledPlugins"] : {};
  const out: PluginDir[] = [];
  for (const [key, installs] of Object.entries(installed)) {
    const on = onBySettings[key] ?? onByManifest[key] ?? true;
    if (on === false) continue;
    const list = Array.isArray(installs) ? installs : [installs];
    const path = list.map((i: unknown) => (isObj(i) ? i["installPath"] : null)).find((p): p is string => typeof p === "string" && p !== "");
    if (!path) continue;
    const at = key.indexOf("@");
    out.push({ name: at > 0 ? key.slice(0, at) : key, path });
  }
  return out;
}

/** The CLI's own commands a headless run takes as a message (the agent
 *  reads the rest, like /model or /rename, as nothing). */
export const BUILTIN_MENTIONS: readonly Mention[] = [
  { name: "compact", kind: "builtin", harness: "claude", from: "builtin", description: "Summarize the conversation so far and go on from the summary" },
  { name: "clear", kind: "builtin", harness: "claude", from: "builtin", description: "Forget the conversation so far" },
  { name: "init", kind: "builtin", harness: "claude", from: "builtin", description: "Write a CLAUDE.md for this repo" },
  { name: "code-review", kind: "builtin", harness: "claude", from: "builtin", description: "Review the current diff for bugs" },
  { name: "simplify", kind: "builtin", harness: "claude", from: "builtin", description: "Review the changed code for reuse and simplification, then apply the fixes" },
  { name: "security-review", kind: "builtin", harness: "claude", from: "builtin", description: "Review the current diff for security problems" },
];

const FROM_RANK = (from: string): number => (from.startsWith("project") ? 0 : from.startsWith("user") ? 1 : from === "builtin" ? 2 : 3);

/** The repo's own first, then the user's, the CLI's, the plugins', by name
 *  within; one row per name for an agent, as the CLI lists them, so a
 *  repo's skill hides the user's of the same name. */
export function sortMentions(words: readonly Mention[]): Mention[] {
  const sorted = [...words].sort((a, b) => FROM_RANK(a.from) - FROM_RANK(b.from) || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  return sorted.filter((w) => {
    const key = `${w.harness} ${w.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const textOf = (records: readonly ScanRecord[], kind: string): string => records.find((r) => r.kind === kind)?.head ?? "";

/** Every mention for a repo, read where it lives: the folders pass, then
 *  the plugin pass for the plugins the manifest and settings enable, then
 *  the CLI's own commands. `home` is for tests; the host's own otherwise. */
export async function scanMentions(repoPath: string, home = ""): Promise<Mention[]> {
  const { host, path } = parseLocator(repoPath);
  const r = await onHost(host, scanCommand(path, home), { timeoutMs: 30_000 });
  if (r.code === 3) throw new FinderError(404, `no folder at ${path}`);
  if (r.code === 255 && host) throw new FinderError(502, `ssh ${host}: ${r.stderr.trim() || "connection failed"}`);
  if (r.code !== 0) throw new FinderError(500, r.stderr.trim() || "could not read the agent's commands");
  const records = parseScan(r.stdout);
  const words = mentionsOf(records);
  const plugins = enabledPlugins(textOf(records, "plugins"), textOf(records, "settings"));
  if (plugins.length > 0) {
    const p = await onHost(host, pluginCommand(plugins), { timeoutMs: 30_000 });
    if (p.code === 0) words.push(...mentionsOf(parseScan(p.stdout)));
  }
  return sortMentions([...words, ...builtinMentions()]);
}

/** how long one repo's list is good for */
export const MENTIONS_TTL = 20_000;

const cache = new Map<string, { at: number; got: Promise<Mention[]> }>();

/** the CLI's own command names, as a run's init message last listed them */
const cliCommands = new Map<Harness, ReadonlySet<string>>();

/** What a run's init message listed as the CLI's commands: from then on
 *  the built-ins offered are those among them, and the held lists go when
 *  the set changed. The list itself is not taken as the source, since it
 *  mixes in the terminal's own (/model, /rename) and comes only once a
 *  turn has begun. */
export function noteCliCommands(harness: Harness, names: readonly string[]): void {
  const next = new Set(names);
  const prev = cliCommands.get(harness);
  if (prev && prev.size === next.size && [...next].every((n) => prev.has(n))) return;
  cliCommands.set(harness, next);
  cache.clear();
}

/** The built-ins to offer: all of them until a run's init has said which
 *  the CLI has, then those it named. */
export function builtinMentions(): Mention[] {
  return BUILTIN_MENTIONS.filter((w) => cliCommands.get(w.harness)?.has(w.name) ?? true);
}

/** `scanMentions`, held for `MENTIONS_TTL` per repo so a menu that opens on
 *  every keystroke reads the folders once. A failed read is not held. */
export function listMentions(repoPath: string): Promise<Mention[]> {
  const now = Date.now();
  const hit = cache.get(repoPath);
  if (hit && now - hit.at < MENTIONS_TTL) return hit.got;
  const got = scanMentions(repoPath).catch((err: unknown) => {
    cache.delete(repoPath);
    throw err;
  });
  cache.set(repoPath, { at: now, got });
  return got;
}
