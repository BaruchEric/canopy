/**
 * What a shell leaves behind, so a machine going down does not take it with
 * the tmux server. While `keepShells` is on, the backend snapshots every
 * shell it holds every `KEEP_EVERY`: one JSON record and one capped capture
 * of the pane per shell, under `shells/` in the config dir, which is the
 * volume the shells container shares, so a reboot finds them. A record whose
 * session is still live is not offered; the ones left over are what the
 * browser is offered to restore, into a new session under the same id with
 * the old history ahead of it and a banner saying so.
 *
 * This restores the terminal, not the processes that were in it. For a shell
 * that had an agent running, `continueLine` is the line canopy offers to run
 * in the restored shell, which picks the conversation back up rather than
 * resuming a process that is gone.
 *
 * Everything but the four fs calls at the end is pure and tested.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { continueArgv, type AgentEnv } from "./harness";
import { shellLine, shellQuote } from "./host";
import { configDir } from "./store";
import { isTermId, termPlace } from "./term";
import type { AgentKind, AgentSettings, KeptShell } from "./types";

/** how often a held shell's history is written out */
export const KEEP_EVERY = 60_000;
/** lines of history kept per shell, the same depth a new client is handed */
export const KEEP_LINES = 2000;
/** and the cap that really binds: colored, wrapped lines are not small */
export const KEEP_BYTES = 256 * 1024;
/** how long a record is offered before it is dropped */
export const KEEP_DAYS = 7;

const SHELL_COMMANDS = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login"];

/** whether a pane's command is a shell at its prompt, which runs no agent */
export const isShellCommand = (command: string): boolean => {
  const name = command.trim().toLowerCase().replace(/^-/, "");
  return name === "" || SHELL_COMMANDS.includes(name);
};

/** The harness an argv is, off its program and, for an interpreter, its
 *  script: a bun- or npm-installed codex runs as `node …/@openai/codex/bin/
 *  codex.js`, a claude as `claude` or its package's `cli.js`. Only the first
 *  two words count, so an editor opened on `/tmp/codex/notes` is no agent. */
function argvAgent(argv: readonly string[]): AgentKind | null {
  for (const w of argv.slice(0, 2)) {
    if (/\/@openai\/codex\//.test(w) || /(^|\/)codex(\.js)?$/.test(w)) return "codex";
    if (/\/@anthropic-ai\/claude-code\//.test(w) || /(^|\/)claude$/.test(w)) return "claude";
  }
  return null;
}

/**
 * The agent running in a pane, off what tmux says about it and, when that
 * is not enough, the argv of the processes under the pane. No one field is
 * dependable alone, and each was measured rather than assumed: Claude Code
 * sets its process title to its own version on a Mac, so
 * `pane_current_command` reads `2.1.278` and the pane title `claude agents`,
 * and reads `claude` with the title `✳ Claude Code` on Linux; a bun-installed
 * codex reports `node` and titles the pane after the folder, so only its
 * argv tells. A plain shell reports its own name, which is what rules out a
 * shell sitting in a folder called `claude-history` from looking like an
 * agent.
 */
export function agentIn(command: string, title: string, argvs: readonly (readonly string[])[] = []): AgentKind | null {
  if (isShellCommand(command)) return null;
  const name = command.trim().toLowerCase().replace(/^-/, "");
  const head = title.trim().toLowerCase().replace(/^✳\s*/, "");
  if (name.startsWith("claude") || head.startsWith("claude")) return "claude";
  if (name.startsWith("codex") || head.startsWith("codex")) return "codex";
  // Claude Code's process title is its version, and nothing else canopy
  // starts in a shell looks like one
  if (/^\d+\.\d+\.\d+/.test(name)) return "claude";
  for (const argv of argvs) {
    const found = argvAgent(argv);
    if (found) return found;
  }
  return null;
}

/** What canopy offers to run in a restored shell to pick the work back up:
 *  `claude --continue` or `codex resume --last`, both of which take the
 *  folder's most recent conversation. With `settings` of the same harness
 *  (the repo's route) their flags ride along, else only what the harness
 *  always takes; null for a shell that had no agent in it. */
export const continueLine = (agent: AgentKind | null, settings?: AgentSettings, env: AgentEnv = {}): string | null =>
  agent ? shellLine(continueArgv(agent, settings, env)) : null;

/** the line that opens a restored shell's history, so nobody mistakes it for
 *  a shell that never stopped */
export const restoredBanner = (when: string): string => `\x1b[2m[restored by canopy] what this shell had until ${when}\x1b[0m`;

/**
 * What a restored session runs instead of the shell: print the banner, print
 * what the lost shell had, drop the file, then become the shell. The replay
 * goes through the pane itself, so it lands in tmux's own history and every
 * client that ever attaches gets it the way it gets any other history. The
 * alternative, holding the text in the server and sending it ahead of each
 * attach, has to decide when to stop, and there is no good answer: the first
 * client attaching at its own size already resizes the pane and scrolls
 * lines into the history that would have been the signal.
 */
export function replayCommand(file: string, banner: string, shell: string[]): string[] {
  const script = [
    `printf '%s\\n' ${shellQuote(banner)}`,
    `cat ${shellQuote(file)} 2>/dev/null`,
    `rm -f ${shellQuote(file)}`,
    `exec ${shell.map(shellQuote).join(" ")}`,
  ].join("; ");
  return ["sh", "-c", script];
}

/** the last `lines` of a capture, and never more than `bytes` of it */
export function clip(text: string, lines = KEEP_LINES, bytes = KEEP_BYTES): string {
  const rows = text.replace(/\n$/, "").split("\n");
  let kept = rows.slice(Math.max(0, rows.length - lines)).join("\n");
  while (Buffer.byteLength(kept, "utf8") > bytes) {
    const cut = kept.indexOf("\n");
    if (cut === -1) return kept.slice(-bytes);
    kept = kept.slice(cut + 1);
  }
  return kept;
}

/** how many lines a capture holds, which is what a record reports */
export const countLines = (text: string): number => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

/** a record off its file, or null for one that is not a record at all */
export function parseKept(raw: string): KeptShell | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const repoId = typeof o.repoId === "string" ? o.repoId : "";
  const path = typeof o.path === "string" ? o.path : "";
  if (!isTermId(id) || !repoId || !path) return null;
  const num = (x: unknown, fallback: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
  const agent = o.agent === "claude" || o.agent === "codex" ? o.agent : null;
  const savedAt = num(o.savedAt, 0);
  return {
    id,
    repoId,
    path,
    place: termPlace(typeof o.place === "string" ? o.place : undefined),
    startedAt: num(o.startedAt, savedAt),
    savedAt,
    lines: Math.max(0, Math.trunc(num(o.lines, 0))),
    agent,
  };
}

/** the kept shells worth offering: the ones no live session answers for,
 *  newest first */
export function lostShells(kept: KeptShell[], live: Iterable<string>): KeptShell[] {
  const held = new Set(live);
  return kept.filter((k) => !held.has(k.id)).sort((a, b) => b.savedAt - a.savedAt);
}

/** the ids past the retention window, which a sweep drops */
export function expiredShells(kept: KeptShell[], now: number, days = KEEP_DAYS): string[] {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return kept.filter((k) => k.savedAt < cutoff).map((k) => k.id);
}

/* ---------- Bun-only: the records on disk ---------- */

export const keepDir = (): string => join(configDir(), "shells");

const recordPath = (id: string): string => join(keepDir(), `${id}.json`);
const historyPath = (id: string): string => join(keepDir(), `${id}.txt`);

/** one shell's record and history, written 0600 in a dir only the user can
 *  read: this is whatever the shell printed, which is nobody else's */
export async function writeKept(rec: KeptShell, history: string): Promise<void> {
  await mkdir(keepDir(), { recursive: true, mode: 0o700 });
  await writeFile(recordPath(rec.id), JSON.stringify(rec), { mode: 0o600 });
  await writeFile(historyPath(rec.id), history, { mode: 0o600 });
}

/** what a kept shell had on its screen, or nothing when it has no history */
export async function readKeptHistory(id: string): Promise<string> {
  if (!isTermId(id)) return "";
  try {
    return await readFile(historyPath(id), "utf8");
  } catch {
    return "";
  }
}

/** every record on disk; anything unreadable is left out rather than fatal */
export async function listKept(): Promise<KeptShell[]> {
  let names: string[];
  try {
    names = await readdir(keepDir());
  } catch {
    return [];
  }
  const kept: KeptShell[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = parseKept(await readFile(join(keepDir(), name), "utf8"));
      if (rec) kept.push(rec);
    } catch {
      // a record being read while it is written; the next list has it
    }
  }
  return kept.sort((a, b) => b.savedAt - a.savedAt);
}

/** A copy of what a kept shell had, for the restored session to print and
 *  delete; the record itself is forgotten as the shell comes back, so the
 *  replay cannot read the original. Null when there was no history. */
export async function replayFile(id: string, history: string): Promise<string | null> {
  if (!isTermId(id) || history === "") return null;
  const path = join(keepDir(), `${id}.replay.txt`);
  await mkdir(keepDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, history, { mode: 0o600 });
  return path;
}

/** drops a shell's record and its history */
export async function forgetKept(id: string): Promise<void> {
  if (!isTermId(id)) return;
  await rm(recordPath(id), { force: true }).catch(() => {});
  await rm(historyPath(id), { force: true }).catch(() => {});
  await rm(join(keepDir(), `${id}.replay.txt`), { force: true }).catch(() => {});
}
