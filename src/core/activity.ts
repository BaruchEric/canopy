import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEX_DAYS, claudeHome, codexDayDirs, codexHome, isSessionId, projectFolder } from "./sessions";
import type { ActivityEvent, AgentActivity, Harness } from "./types";

/*
 * What an agent did, read from its session's transcript on this machine:
 * the drill-down of a registry card (`GET /api/agents/activity`). Claude
 * Code keeps `~/.claude/projects/<folder>/<session>.jsonl`, a record per
 * message block, with its own title, last prompt and cost records beside
 * them; Codex keeps a rollout under `$CODEX_HOME/sessions/YYYY/MM/DD/`
 * whose name ends in the session id, with response items and events (and,
 * from 0.159, completed items that say some of the same things again).
 * A file is found by harness and session id alone, so a path from the page
 * never reaches the disk, and the same session reads whether the agent ran
 * on the host or in a container mounting the same home. A transcript runs to
 * megabytes, so it is read once and then only from where the last reading
 * stopped; the tally is pure (`feedLine`, `activityOf`) and tested.
 */

/** records further apart than this are a pause, not work */
export const ACTIVE_GAP = 5 * 60_000;
/** how many of the newest events a reading hands out */
export const ACTIVITY_EVENTS = 40;
/** how many tools and files a reading names */
const TOOLS_SHOWN = 12;
const FILES_KEPT = 30;
/** how long an event's line and the last prompt or reply may run */
const LINE_CHARS = 160;
const SAID_CHARS = 400;
/** the same words twice within this are one message said two ways (codex) */
const SAME_SPAN = 5_000;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A transcript read so far. Plain data with Maps and Sets, kept by the
 *  reader between readings and fed one line at a time. */
export interface Tally {
  harness: Harness;
  aiTitle: string | null;
  agentName: string | null;
  summary: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastPromptAt: number | null;
  /** Claude Code's own last-prompt record, for a file whose prompts were cut */
  promptHint: string | null;
  lastReply: string | null;
  lastReplyAt: number | null;
  firstAt: number | null;
  lastAt: number | null;
  activeMs: number;
  prompts: number;
  toolCalls: number;
  toolErrors: number;
  tools: Map<string, number>;
  /** the latest first, each once */
  files: string[];
  touched: Set<string>;
  /** Claude writes a message a record per block, each carrying the usage so
   *  far: the message in hand's latest, added in when the next one starts */
  tokens: Tokens;
  msgId: string | null;
  msgUsage: Tokens | null;
  /** Codex writes its running total; the latest stands */
  totals: Tokens | null;
  models: Set<string>;
  costUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  /** call ids to tool names, so a failed result can say whose it was */
  calls: Map<string, string>;
  events: ActivityEvent[];
}

export function newTally(harness: Harness): Tally {
  return {
    harness,
    aiTitle: null,
    agentName: null,
    summary: null,
    firstPrompt: null,
    lastPrompt: null,
    lastPromptAt: null,
    promptHint: null,
    lastReply: null,
    lastReplyAt: null,
    firstAt: null,
    lastAt: null,
    activeMs: 0,
    prompts: 0,
    toolCalls: 0,
    toolErrors: 0,
    tools: new Map(),
    files: [],
    touched: new Set(),
    tokens: { ...NO_TOKENS },
    msgId: null,
    msgUsage: null,
    totals: null,
    models: new Set(),
    costUsd: null,
    linesAdded: null,
    linesRemoved: null,
    calls: new Map(),
    events: [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function oneLine(s: string, max = LINE_CHARS): string {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

function time(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** words a person typed, or null for the harness's own: a tag-wrapped block
 *  (a slash command, its output, a reminder), Claude's caveat, a note that
 *  the turn was interrupted */
function typedLine(text: string): string | null {
  const l = text.replace(/\s+/g, " ").trim();
  if (!l || l.startsWith("<") || l.startsWith("Caveat:") || l.startsWith("[Request interrupted")) return null;
  return l;
}

/** the files an `apply_patch` names */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const f = m[1]?.trim();
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** a command's words as one line: codex's `bash -lc '<line>'` is its line */
function argvLine(argv: unknown[]): string {
  const words = argv.filter((w): w is string => typeof w === "string");
  if (words.length >= 3 && /^-l?c$/.test(words[1] ?? "")) return words.slice(2).join(" ");
  return words.join(" ");
}

/** One line for a tool call: the files of a patch, the command of a shell,
 *  the path of a file tool, the pattern, query or url of a search, else the
 *  tool's name. Codex 0.159's `exec` tool wraps its command in a script
 *  (`tools.exec_command({cmd:"…"})`), which is read for the `cmd`. */
export function toolText(name: string, input: unknown): string {
  if (typeof input === "string") {
    const files = patchFiles(input);
    if (files.length) return oneLine(files.join(", "));
    const cmd = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
    if (cmd?.[1] !== undefined) {
      try {
        return oneLine(JSON.parse(`"${cmd[1]}"`) as string);
      } catch {
        return oneLine(cmd[1]);
      }
    }
    // a script with no command in it (codex feeding a running one its input) says which call
    const fn = /\btools\.(\w+)\(/.exec(input);
    if (fn?.[1]) return fn[1];
    return oneLine(input) || name;
  }
  if (!isRecord(input)) return name;
  const patch = str(input.input) ?? str(input.patch);
  if (patch && patchFiles(patch).length) return oneLine(patchFiles(patch).join(", "));
  for (const k of ["command", "cmd"]) {
    const v = input[k];
    if (Array.isArray(v)) return oneLine(argvLine(v)) || name;
  }
  for (const k of ["command", "cmd", "file_path", "notebook_path", "pattern", "path", "query", "url", "description", "prompt", "skill"]) {
    const v = str(input[k]);
    if (v) return oneLine(v);
  }
  return name;
}

/** the files a tool call writes: a Claude file tool's path, a patch's files */
function filesOf(name: string, input: unknown): string[] {
  if (typeof input === "string") return patchFiles(input);
  if (!isRecord(input)) return [];
  if (EDIT_TOOLS.has(name)) {
    const f = str(input.file_path) ?? str(input.notebook_path);
    return f ? [f] : [];
  }
  const patch = str(input.input) ?? str(input.patch);
  return patch ? patchFiles(patch) : [];
}

/** text out of a content list: a string, or the first part with text */
function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (const part of content) if (isRecord(part) && typeof part.text === "string") return part.text;
  return null;
}

function stamp(t: Tally, at: number | null): void {
  if (at === null) return;
  t.firstAt ??= at;
  if (t.lastAt !== null && at > t.lastAt && at - t.lastAt <= ACTIVE_GAP) t.activeMs += at - t.lastAt;
  if (t.lastAt === null || at > t.lastAt) t.lastAt = at;
}

function push(t: Tally, ev: ActivityEvent): void {
  t.events.push(ev);
  if (t.events.length > ACTIVITY_EVENTS * 2) t.events.splice(0, t.events.length - ACTIVITY_EVENTS);
}

const near = (a: number | null, b: number | null): boolean => a === null || b === null || Math.abs(a - b) < SAME_SPAN;

function prompt(t: Tally, at: number | null, text: string): void {
  const line = typedLine(text);
  if (!line) return;
  const said = oneLine(line, SAID_CHARS);
  if (said === t.lastPrompt && near(at, t.lastPromptAt)) return;
  t.prompts++;
  t.firstPrompt ??= said;
  t.lastPrompt = said;
  t.lastPromptAt = at;
  push(t, { at, kind: "prompt", text: oneLine(line) });
}

function reply(t: Tally, at: number | null, text: string): void {
  if (!text.trim()) return;
  const said = oneLine(text, SAID_CHARS);
  if (said === t.lastReply && near(at, t.lastReplyAt)) return;
  t.lastReply = said;
  t.lastReplyAt = at;
  push(t, { at, kind: "reply", text: oneLine(text) });
}

function call(t: Tally, at: number | null, name: string, input: unknown, id: unknown): void {
  t.toolCalls++;
  t.tools.set(name, (t.tools.get(name) ?? 0) + 1);
  if (typeof id === "string" && id) t.calls.set(id, name);
  for (const f of filesOf(name, input)) {
    if (t.touched.has(f)) t.files = t.files.filter((x) => x !== f);
    t.touched.add(f);
    t.files.unshift(f);
  }
  if (t.files.length > FILES_KEPT) t.files.length = FILES_KEPT;
  push(t, { at, kind: "tool", tool: name, text: toolText(name, input) });
}

function model(t: Tally, v: unknown): void {
  const m = str(v);
  if (m && !m.startsWith("<")) t.models.add(m);
}

const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

function claudeUsage(u: unknown): Tokens | null {
  if (!isRecord(u)) return null;
  return {
    input: num(u.input_tokens) ?? 0,
    output: num(u.output_tokens) ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
  };
}

/** codex counts cached input inside its input; canopy keeps them apart */
function codexUsage(u: unknown): Tokens | null {
  if (!isRecord(u)) return null;
  const cached = num(u.cached_input_tokens) ?? 0;
  return {
    input: Math.max(0, (num(u.input_tokens) ?? 0) - cached),
    output: num(u.output_tokens) ?? 0,
    cacheRead: cached,
    cacheWrite: num(u.cache_write_input_tokens) ?? 0,
  };
}

function feedClaude(t: Tally, rec: Record<string, unknown>): void {
  switch (rec.type) {
    case "ai-title":
      t.aiTitle = str(rec.aiTitle) ?? t.aiTitle;
      return;
    case "agent-name":
      t.agentName = str(rec.agentName) ?? t.agentName;
      return;
    case "summary":
      t.summary = str(rec.summary) ?? t.summary;
      return;
    case "last-prompt":
      t.promptHint = str(rec.lastPrompt) ?? t.promptHint;
      return;
    case "cost-state":
      t.costUsd = num(rec.totalCostUSD) ?? t.costUsd;
      t.linesAdded = num(rec.totalLinesAdded) ?? t.linesAdded;
      t.linesRemoved = num(rec.totalLinesRemoved) ?? t.linesRemoved;
      return;
    case "user":
    case "assistant":
      break;
    default:
      return;
  }
  // an older Claude Code wrote a Task's subagent inline as a sidechain
  if (rec.isSidechain === true || !isRecord(rec.message)) return;
  const msg = rec.message;
  const at = time(rec.timestamp);
  stamp(t, at);
  if (rec.type === "user") {
    if (rec.isMeta === true) return;
    if (typeof msg.content === "string") {
      prompt(t, at, msg.content);
      return;
    }
    if (!Array.isArray(msg.content)) return;
    let typed = false;
    for (const part of msg.content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string" && !typed) {
        typed = true;
        prompt(t, at, part.text);
      } else if (part.type === "tool_result") {
        const id = typeof part.tool_use_id === "string" ? part.tool_use_id : "";
        const tool = t.calls.get(id);
        t.calls.delete(id);
        if (part.is_error !== true) continue;
        t.toolErrors++;
        const ev: ActivityEvent = { at, kind: "error", text: oneLine(textOf(part.content) ?? "") || "failed" };
        if (tool) ev.tool = tool;
        push(t, ev);
      }
    }
    return;
  }
  model(t, msg.model);
  const usage = claudeUsage(msg.usage);
  if (usage) {
    const id = typeof msg.id === "string" ? msg.id : null;
    if (id === null || id !== t.msgId) {
      if (t.msgUsage) t.tokens = addTokens(t.tokens, t.msgUsage);
      t.msgId = id;
    }
    t.msgUsage = usage;
  }
  if (!Array.isArray(msg.content)) return;
  for (const part of msg.content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") reply(t, at, part.text);
    else if (part.type === "tool_use" && typeof part.name === "string") call(t, at, part.name, part.input, part.id);
  }
}

function feedCodex(t: Tally, rec: Record<string, unknown>): void {
  const p = isRecord(rec.payload) ? rec.payload : null;
  if (!p) return;
  const at = time(rec.timestamp);
  if (rec.type === "turn_context") {
    model(t, p.model);
    return;
  }
  if (rec.type === "event_msg") {
    switch (p.type) {
      case "user_message":
        stamp(t, at);
        if (typeof p.message === "string") prompt(t, at, p.message);
        return;
      case "agent_message":
        stamp(t, at);
        if (typeof p.message === "string") reply(t, at, p.message);
        return;
      case "item_completed": {
        stamp(t, at);
        const item = isRecord(p.item) ? p.item : null;
        const text = item ? textOf(item.content) : null;
        if (text !== null && item?.type === "UserMessage") prompt(t, at, text);
        else if (text !== null && item?.type === "AgentMessage") reply(t, at, text);
        return;
      }
      case "token_count": {
        const info = isRecord(p.info) ? p.info : null;
        t.totals = (info && codexUsage(info.total_token_usage)) ?? t.totals;
        return;
      }
      case "thread_settings_applied":
        if (isRecord(p.thread_settings)) model(t, p.thread_settings.model);
        return;
      case "task_started":
      case "task_complete":
        stamp(t, at);
        return;
      default:
        return;
    }
  }
  if (rec.type !== "response_item") return;
  switch (p.type) {
    case "function_call": {
      stamp(t, at);
      let input: unknown = p.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          // a call whose arguments are not JSON is still a call; its text is its line
        }
      }
      call(t, at, str(p.name) ?? "function", input, p.call_id);
      return;
    }
    case "custom_tool_call":
      stamp(t, at);
      call(t, at, str(p.name) ?? "tool", p.input, p.call_id);
      return;
    case "local_shell_call":
      stamp(t, at);
      call(t, at, "shell", isRecord(p.action) ? p.action : null, p.call_id);
      return;
    case "web_search_call":
      stamp(t, at);
      call(t, at, "web_search", isRecord(p.action) ? p.action : null, null);
      return;
    default:
      return;
  }
}

/** One transcript line into the tally; a line that does not parse (the
 *  last one cut mid-write, a stray) says nothing. */
export function feedLine(t: Tally, line: string): void {
  if (!line.trim()) return;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(rec)) return;
  if (t.harness === "codex") feedCodex(t, rec);
  else feedClaude(t, rec);
}

/** What the tally says, as the page reads it. */
export function activityOf(t: Tally, session: string, bytes: number, writtenAt: number, subagents = 0): AgentActivity {
  const tokens = t.totals ?? (t.msgUsage ? addTokens(t.tokens, t.msgUsage) : { ...t.tokens });
  const title = t.aiTitle ?? t.agentName ?? t.summary;
  return {
    harness: t.harness,
    session,
    bytes,
    writtenAt,
    title: title ? oneLine(title) : null,
    firstPrompt: t.firstPrompt,
    lastPrompt: t.lastPrompt ?? (t.promptHint ? oneLine(t.promptHint, SAID_CHARS) : null),
    lastReply: t.lastReply,
    firstAt: t.firstAt,
    lastAt: t.lastAt,
    activeMs: t.activeMs,
    prompts: t.prompts,
    toolCalls: t.toolCalls,
    toolErrors: t.toolErrors,
    tools: [...t.tools]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, TOOLS_SHOWN),
    files: [...t.files],
    filesTouched: t.touched.size,
    tokens,
    models: [...t.models],
    costUsd: t.costUsd,
    linesAdded: t.linesAdded,
    linesRemoved: t.linesRemoved,
    subagents,
    events: t.events.slice(-ACTIVITY_EVENTS),
  };
}

/* ---------- the files ---------- */

export interface AgentHomes {
  claude?: string;
  codex?: string;
}

const isFile = async (f: string): Promise<boolean> => (await stat(f).catch(() => null))?.isFile() ?? false;

/** Where a session's transcript is on this machine: Claude Code's under the
 *  folder for `cwd` (the folder name is the path with every other character
 *  a `-`, so nothing in `cwd` climbs out), else under any project folder,
 *  since a long path gets a shortened name; Codex's by the id its rollout's
 *  name ends in, over the last `CODEX_DAYS`. Null when there is none. */
export async function findTranscript(harness: Harness, session: string, cwd: string, homes: AgentHomes = {}, now = new Date()): Promise<string | null> {
  if (!isSessionId(session)) return null;
  if (harness === "claude") {
    const projects = join(homes.claude ?? claudeHome(), "projects");
    const name = `${session}.jsonl`;
    if (cwd) {
      const f = join(projects, projectFolder(cwd), name);
      if (await isFile(f)) return f;
    }
    for (const d of await readdir(projects).catch(() => [] as string[])) {
      const f = join(projects, d, name);
      if (await isFile(f)) return f;
    }
    return null;
  }
  const root = join(homes.codex ?? codexHome(), "sessions");
  const tail = `-${session}.jsonl`;
  for (const day of codexDayDirs(now, CODEX_DAYS)) {
    const names = await readdir(join(root, day)).catch(() => [] as string[]);
    const hit = names.find((n) => n.startsWith("rollout-") && n.endsWith(tail));
    if (hit) return join(root, day, hit);
  }
  return null;
}

/** a Claude Code session's subagent transcripts, `<session>/subagents/*.jsonl` */
async function subagentsOf(file: string, session: string): Promise<number> {
  const names = await readdir(join(dirname(file), session, "subagents")).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".jsonl")).length;
}

/** a reading in hand: where it stopped and what it has said so far */
interface Held {
  file: string;
  offset: number;
  /** a record longer than a chunk is being passed over */
  skipping: boolean;
  tally: Tally;
}

/** how many sessions' readings are kept, the least lately asked dropped */
const HELD_MAX = 32;
/** how much is read at a time; a record past it (an image, a huge output)
 *  is passed over rather than held whole */
const CHUNK = 4 << 20;

const held = new Map<string, Held>();
const reading = new Map<string, Promise<unknown>>();

async function advance(h: Held, size: number): Promise<void> {
  const fh = await open(h.file, "r");
  const decoder = new TextDecoder();
  try {
    while (h.offset < size) {
      const len = Math.min(CHUNK, size - h.offset);
      const buf = new Uint8Array(len);
      const { bytesRead } = await fh.read(buf, 0, len, h.offset);
      const got = buf.subarray(0, bytesRead);
      const end = got.lastIndexOf(10);
      if (end < 0) {
        // the last line is still being written, or one record runs past a chunk
        if (bytesRead < CHUNK) return;
        h.offset += bytesRead;
        h.skipping = true;
        continue;
      }
      let start = 0;
      if (h.skipping) {
        start = got.indexOf(10) + 1;
        h.skipping = false;
      }
      for (const line of decoder.decode(got.subarray(start, end)).split("\n")) feedLine(h.tally, line);
      h.offset += end + 1;
    }
  } finally {
    await fh.close();
  }
}

async function readOnce(key: string, harness: Harness, session: string, cwd: string, homes: AgentHomes, now: Date): Promise<AgentActivity | null> {
  let h = held.get(key);
  let s = h ? await stat(h.file).catch(() => null) : null;
  if (!h || !s?.isFile()) {
    const file = await findTranscript(harness, session, cwd, homes, now);
    s = file ? await stat(file).catch(() => null) : null;
    if (!file || !s?.isFile()) {
      held.delete(key);
      return null;
    }
    h = { file, offset: 0, skipping: false, tally: newTally(harness) };
  }
  // a file shorter than where the last reading stopped was written anew
  if (s.size < h.offset) h = { file: h.file, offset: 0, skipping: false, tally: newTally(harness) };
  if (s.size > h.offset) await advance(h, s.size);
  held.delete(key);
  held.set(key, h);
  while (held.size > HELD_MAX) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
  const subagents = harness === "claude" ? await subagentsOf(h.file, session) : 0;
  return activityOf(h.tally, session, s.size, Math.round(s.mtimeMs), subagents);
}

/**
 * A session's activity on this machine, or null when its transcript is not
 * here. The first reading reads the whole file; later ones read on from
 * where it stopped, one at a time per session so two never feed the same
 * tally twice.
 */
export function readActivity(harness: Harness, session: string, cwd: string, homes: AgentHomes = {}, now = new Date()): Promise<AgentActivity | null> {
  if (!isSessionId(session)) return Promise.resolve(null);
  const home = harness === "codex" ? (homes.codex ?? codexHome()) : (homes.claude ?? claudeHome());
  const key = `${harness}\0${home}\0${session}`;
  const before = reading.get(key) ?? Promise.resolve();
  const run = before.then(() => readOnce(key, harness, session, cwd, homes, now));
  const settled = run.catch(() => undefined);
  reading.set(key, settled);
  void settled.then(() => {
    if (reading.get(key) === settled) reading.delete(key);
  });
  return run;
}
