import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resumeArgv, type AgentEnv } from "./harness";
import { shellLine } from "./host";
import { mapPool } from "./search";
import { DEFAULT_AGENT, type AgentSession, type AgentSettings, type Harness } from "./types";

/*
 * Agent conversations on this machine, so one started in any shell, on any
 * device, can be picked back up in another. Claude Code keeps each one as
 * `<session id>.jsonl` under `~/.claude/projects/<folder>/`, the folder
 * being the working directory with every character that is not a letter or
 * digit turned into `-`. Codex keeps a rollout per session under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/`, filed by day rather than by folder,
 * with the folder in its first line. Only the head of a file is read: the
 * first prompt and any summary are near the top, and a long conversation
 * runs to megabytes.
 */

/** how many conversations a repo's list offers, newest first */
export const SESSION_LIMIT = 20;

/** how much of each file is read for its first prompt */
const HEAD_BYTES = 64 * 1024;

/** how long a prompt line may run before it is clipped */
const PROMPT_CHARS = 160;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** whether `v` is a session id (a lowercase uuid; both harnesses use one) */
export const isSessionId = (v: unknown): v is string => typeof v === "string" && SESSION_ID.test(v);

/** where Claude Code keeps its state: `$CLAUDE_CONFIG_DIR`, else `~/.claude` */
export const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** the projects folder Claude Code files a working directory's sessions under */
export const projectFolder = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

/** the text of a user message, or null for one that is a tool result,
 *  a slash command or harness chatter rather than something typed */
function typed(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const t = (part as { text?: unknown }).text;
        if (typeof t === "string") {
          text = t;
          break;
        }
      }
    }
  }
  if (text === null) return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line || line.startsWith("<") || line.startsWith("Caveat:")) return null;
  return line;
}

const clipPrompt = (s: string): string => (s.length > PROMPT_CHARS ? `${s.slice(0, PROMPT_CHARS - 1)}…` : s);

/** What the head of one session file says: its first typed prompt, a
 *  summary line if Claude Code wrote one, and the branch it was on. The
 *  last line of the head may be cut mid-record and is skipped when it does
 *  not parse. */
export function parseSessionHead(text: string): Pick<AgentSession, "prompt" | "summary" | "branch"> {
  let prompt: string | null = null;
  let summary: string | null = null;
  let branch: string | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type === "summary" && typeof rec.summary === "string" && !summary) summary = rec.summary;
    if (!branch && typeof rec.gitBranch === "string" && rec.gitBranch) branch = rec.gitBranch;
    if (!prompt && rec.type === "user" && rec.isMeta !== true) prompt = typed(rec.message);
    if (prompt && summary && branch) break;
  }
  return {
    prompt: prompt ? clipPrompt(prompt) : null,
    summary: summary ? clipPrompt(summary) : null,
    branch,
  };
}

/** The settings' harness picking the conversation back up with the repo's
 *  flags: `claude … --resume <id>`, `codex resume … <id>`. */
export const resumeLine = (session: string, agent: AgentSettings = DEFAULT_AGENT, env: AgentEnv = {}): string =>
  shellLine(resumeArgv(agent, session, env));

async function head(file: string, bytes = HEAD_BYTES): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = new Uint8Array(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return new TextDecoder().decode(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** The Claude Code conversations started in `path` on this machine, newest
 *  first, at most `limit`. A folder Claude Code has never run in has none. */
export async function claudeSessions(path: string, limit = SESSION_LIMIT, home = claudeHome()): Promise<AgentSession[]> {
  const dir = join(home, "projects", projectFolder(path));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith(".jsonl") && isSessionId(n.slice(0, -6)))
      .map(async (n) => {
        const s = await stat(join(dir, n)).catch(() => null);
        return s?.isFile() && s.size > 0 ? { id: n.slice(0, -6), at: s.mtimeMs, size: s.size } : null;
      }),
  );
  const newest = files.filter((f): f is NonNullable<typeof f> => f !== null).sort((a, b) => b.at - a.at);
  const out: AgentSession[] = [];
  for (const f of newest) {
    if (out.length >= limit) break;
    const text = await head(join(dir, `${f.id}.jsonl`)).catch(() => "");
    const facts = parseSessionHead(text);
    // a file with nothing typed in it is a session that never started
    // (opened and quit), which there is nothing to resume
    if (!facts.prompt && !facts.summary) continue;
    out.push({ harness: "claude", id: f.id, at: f.at, size: f.size, ...facts });
  }
  return out;
}

/** whether `session` is one of the conversations started in `path` */
export async function hasClaudeSession(path: string, session: string, home = claudeHome()): Promise<boolean> {
  if (!isSessionId(session)) return false;
  const s = await stat(join(home, "projects", projectFolder(path), `${session}.jsonl`)).catch(() => null);
  return s?.isFile() ?? false;
}

/* ---------- codex: rollouts filed by day ---------- */

/** where Codex keeps its state: `$CODEX_HOME`, else `~/.codex` */
export const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");

/** how far back a repo's codex sessions are looked for */
export const CODEX_DAYS = 30;

/** Codex writes its whole system prompt into the first line, which runs to
 *  tens of kilobytes, and the first typed prompt can sit past a hundred
 *  more; the folder check needs only the first line, the prompt this much. */
const CODEX_META_BYTES = 64 * 1024;
const CODEX_HEAD_BYTES = 256 * 1024;

const ROLLOUT = /^rollout-.+\.jsonl$/;

/** rollouts read at once: a month of them can run to hundreds, and one
 *  open file each at a time would run into the process's limit (EMFILE) */
const CODEX_READS = 16;

/** What a rollout's first line (`session_meta`) says, or null for a file
 *  that is not a session canopy offers: unreadable, not a session, or a
 *  subagent's (codex's own reviewer runs), which nobody resumes. */
export interface CodexMeta {
  id: string;
  cwd: string;
  /** "cli", "vscode", "exec" */
  source: string;
  branch: string | null;
}

export function parseCodexMeta(line: string): CodexMeta | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (rec.type !== "session_meta" || !rec.payload || typeof rec.payload !== "object") return null;
  const p = rec.payload as Record<string, unknown>;
  if (!isSessionId(p.id) || typeof p.cwd !== "string" || !p.cwd) return null;
  const source = p.source;
  if (source && typeof source === "object" && "subagent" in source) return null;
  const git = p.git && typeof p.git === "object" ? (p.git as Record<string, unknown>) : null;
  return {
    id: p.id,
    cwd: p.cwd,
    source: typeof source === "string" ? source : "other",
    branch: git && typeof git.branch === "string" && git.branch ? git.branch : null,
  };
}

/** The first thing typed into a codex session, from the lines after its
 *  meta: a `user_message` event, or a user message item that is not one of
 *  the harness's own `<environment_context>`-style blocks. Also whether it
 *  has any turn at all, since a session opened and quit has only its meta.
 *  A last line cut mid-record is skipped. */
export function parseCodexHead(text: string): { prompt: string | null; turns: boolean } {
  let turns = false;
  const lines = text.split("\n");
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const p = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : null;
    if (!p) continue;
    if (rec.type === "response_item" || rec.type === "event_msg") turns = true;
    let text: string | null = null;
    if (rec.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") text = p.message;
    if (rec.type === "response_item" && p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      for (const part of p.content) {
        const t = part && typeof part === "object" ? (part as { type?: unknown; text?: unknown }) : null;
        if (t && (t.type === "input_text" || t.type === "text") && typeof t.text === "string") {
          text = t.text;
          break;
        }
      }
    }
    if (text === null) continue;
    const line = text.replace(/\s+/g, " ").trim();
    if (!line || line.startsWith("<")) continue;
    return { prompt: clipPrompt(line), turns: true };
  }
  return { prompt: null, turns };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The day folders a rollout from the last `days` days is filed under,
 *  newest first, by the local calendar codex files them by. */
export function codexDayDirs(now: Date, days = CODEX_DAYS): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`);
  }
  return out;
}

/** What each rollout said, kept by path and trusted while its mtime holds:
 *  a session's first line never changes, and the prompt is read once. A
 *  read that failed (EACCES, EMFILE) is not kept: it says nothing about the
 *  file, which is read again next time. */
interface CodexSeen {
  mtime: number;
  size: number;
  meta: CodexMeta | null;
  /** read only for a session in a folder someone asked about */
  head?: { prompt: string | null; turns: boolean };
}
const codexSeen = new Map<string, CodexSeen>();

async function codexFile(file: string): Promise<CodexSeen | null> {
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return null;
  const was = codexSeen.get(file);
  if (was && was.mtime === s.mtimeMs && was.size === s.size) return was;
  let chunk: string;
  try {
    chunk = await head(file, CODEX_META_BYTES);
    // a first line past the small read gets one bigger read, then is given up on
    if (chunk && !chunk.includes("\n")) chunk = await head(file, CODEX_HEAD_BYTES);
  } catch {
    return null;
  }
  const seen: CodexSeen = { mtime: s.mtimeMs, size: s.size, meta: parseCodexMeta(chunk.split("\n")[0] ?? "") };
  codexSeen.set(file, seen);
  return seen;
}

/** The Codex sessions started in `path` on this machine in the last
 *  `CODEX_DAYS`, newest first, at most `limit`; a subagent's and one with
 *  nothing typed in it are left out. */
export async function codexSessions(path: string, limit = SESSION_LIMIT, home = codexHome(), now = new Date()): Promise<AgentSession[]> {
  const mine = await codexRollouts(path, home, now);
  const out: AgentSession[] = [];
  for (const { file, s } of mine) {
    if (out.length >= limit) break;
    if (!s.head) {
      const text = await head(file, CODEX_HEAD_BYTES).catch(() => null);
      // unreadable now: left out this time and read again the next
      if (text === null) continue;
      s.head = parseCodexHead(text);
    }
    if (!s.head.prompt && !s.head.turns) continue;
    out.push({ harness: "codex", id: s.meta.id, at: s.mtime, size: s.size, prompt: s.head.prompt, summary: null, branch: s.meta.branch });
  }
  return out;
}

/** Every rollout of the last `CODEX_DAYS` whose session started in `path`,
 *  newest write first. */
async function codexRollouts(path: string, home: string, now: Date): Promise<{ file: string; s: CodexSeen & { meta: CodexMeta } }[]> {
  const root = join(home, "sessions");
  const files: string[] = [];
  for (const day of codexDayDirs(now)) {
    const dir = join(root, day);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) if (ROLLOUT.test(n)) files.push(join(dir, n));
  }
  const seen = await mapPool(files, CODEX_READS, async (file) => ({ file, s: await codexFile(file) }));
  return seen
    .filter((x): x is { file: string; s: CodexSeen & { meta: CodexMeta } } => x.s?.meta?.cwd === path)
    .sort((a, b) => b.s.mtime - a.s.mtime);
}

/** whether `session` is one of the codex sessions started in `path` */
export async function hasCodexSession(path: string, session: string, home = codexHome(), now = new Date()): Promise<boolean> {
  if (!isSessionId(session)) return false;
  return (await codexSessions(path, Number.POSITIVE_INFINITY, home, now)).some((s) => s.id === session);
}

/** Both harnesses' conversations at `path`, newest first, at most `limit`. */
export async function agentSessions(path: string, limit = SESSION_LIMIT): Promise<AgentSession[]> {
  const [c, x] = await Promise.all([claudeSessions(path, limit), codexSessions(path, limit)]);
  return [...c, ...x].sort((a, b) => b.at - a.at).slice(0, limit);
}

/** whether `session` is a conversation of `harness` started in `path` */
export const hasAgentSession = (harness: Harness, path: string, session: string): Promise<boolean> =>
  harness === "codex" ? hasCodexSession(path, session) : hasClaudeSession(path, session);

/**
 * The file the newest conversation of `harness` in `path` is kept in on
 * this machine, what a hand-off names for the other harness to read: the
 * newest `~/.claude/projects/<folder>/*.jsonl` with anything typed in it,
 * or the newest codex rollout whose session started in `path`. Null when
 * there is none.
 */
export async function newestTranscript(
  harness: Harness,
  path: string,
  homes: { claude?: string; codex?: string } = {},
  now = new Date(),
): Promise<string | null> {
  if (harness === "codex") {
    const [newest] = await codexRollouts(path, homes.codex ?? codexHome(), now);
    return newest?.file ?? null;
  }
  const home = homes.claude ?? claudeHome();
  const [newest] = await claudeSessions(path, 1, home);
  return newest ? join(home, "projects", projectFolder(path), `${newest.id}.jsonl`) : null;
}
