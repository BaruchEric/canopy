/** The model's half of a run's name (FR-073): one question to the user's
 *  own `claude`, on its smallest model, with no tools, hooks, MCP servers
 *  or session kept, from a folder that holds no CLAUDE.md. It goes through
 *  the installed binary and the user's login, as every run does, never an
 *  API key. Needs Bun (spawn); `runname.ts` is the pure half. */

import { tmpdir } from "node:os";
import { exec, type ExecOptions, type ExecResult } from "./exec";
import { HARNESS } from "./harness";
import { NAME_SYSTEM, nameFromModel, namePrompt } from "./runname";

/** how long the namer gets; a run keeps the name cut from its words past it */
export const NAME_TIMEOUT = 30_000;
/** the alias of Claude's smallest model, which names a task in a few seconds */
export const NAME_MODEL = "haiku";
/** namers at once, and how many more may wait their turn; a start past
 *  both keeps its words' name */
export const NAMERS_AT_ONCE = 2;
export const NAMERS_WAITING = 8;

/** `claude` argv after the binary. `--tools ""` leaves it nothing to do the
 *  task with, should the task's words tell it to. */
export function nameArgs(prompt: string): string[] {
  return [
    "-p",
    prompt,
    "--model",
    NAME_MODEL,
    "--system-prompt",
    NAME_SYSTEM,
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "text",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
  ];
}

/** `run` and `which` stand in for exec and Bun.which in tests. */
export interface NamerOpts {
  run?: (argv: string[], opts?: ExecOptions) => Promise<ExecResult>;
  which?: (bin: string) => string | null;
  timeoutMs?: number;
}

/** A name for a run's first message from the user's `claude`, or null when
 *  it is not installed, fails, runs out of time or answers with no name. */
export async function modelName(text: string, o: NamerOpts = {}): Promise<string | null> {
  if (!text.trim()) return null;
  const bin = (o.which ?? Bun.which)(HARNESS.claude.binary);
  if (!bin) return null;
  try {
    const r = await (o.run ?? exec)([bin, ...nameArgs(namePrompt(text))], { cwd: tmpdir(), timeoutMs: o.timeoutMs ?? NAME_TIMEOUT });
    return r.code === 0 ? nameFromModel(r.stdout) : null;
  } catch {
    return null;
  }
}

/** `modelName` behind a short queue, so a burst of starts (a schedule
 *  firing on every repo) spawns `NAMERS_AT_ONCE` namers and not one each. */
export function makeNamer(o: NamerOpts = {}): (text: string) => Promise<string | null> {
  let going = 0;
  const waiting: (() => void)[] = [];
  return async (text) => {
    if (going >= NAMERS_AT_ONCE) {
      if (waiting.length >= NAMERS_WAITING) return null;
      // woken holding the place of the namer that finished
      await new Promise<void>((go) => waiting.push(go));
    } else going += 1;
    try {
      return await modelName(text, o);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else going -= 1;
    }
  };
}
