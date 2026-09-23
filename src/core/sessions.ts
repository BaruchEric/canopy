import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "./agent";
import { shellLine } from "./host";
import { DEFAULT_AGENT, type AgentSettings, type ClaudeSession } from "./types";

/*
 * Claude Code conversations on this machine, so one started in any shell,
 * on any device, can be picked back up in another. Claude Code keeps each
 * one as `<session id>.jsonl` under `~/.claude/projects/<folder>/`, the
 * folder being the working directory with every character that is not a
 * letter or digit turned into `-`. Only the head of a file is read: the
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

/** whether `v` is a Claude Code session id (a lowercase uuid) */
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
export function parseSessionHead(text: string): Pick<ClaudeSession, "prompt" | "summary" | "branch"> {
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

/** `claude` with the repo's settings, picking the conversation back up */
export const resumeLine = (session: string, agent: AgentSettings = DEFAULT_AGENT): string =>
  shellLine(["claude", ...claudeArgs(agent), "--resume", session]);

async function head(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return new TextDecoder().decode(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** The Claude Code conversations started in `path` on this machine, newest
 *  first, at most `limit`. A folder Claude Code has never run in has none. */
export async function claudeSessions(path: string, limit = SESSION_LIMIT, home = claudeHome()): Promise<ClaudeSession[]> {
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
  const out: ClaudeSession[] = [];
  for (const f of newest) {
    if (out.length >= limit) break;
    const text = await head(join(dir, `${f.id}.jsonl`)).catch(() => "");
    const facts = parseSessionHead(text);
    // a file with nothing typed in it is a session that never started
    // (opened and quit), which there is nothing to resume
    if (!facts.prompt && !facts.summary) continue;
    out.push({ id: f.id, at: f.at, size: f.size, ...facts });
  }
  return out;
}

/** whether `session` is one of the conversations started in `path` */
export async function hasClaudeSession(path: string, session: string, home = claudeHome()): Promise<boolean> {
  if (!isSessionId(session)) return false;
  const s = await stat(join(home, "projects", projectFolder(path), `${session}.jsonl`)).catch(() => null);
  return s?.isFile() ?? false;
}
