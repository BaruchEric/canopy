/** A Claude transcript cut at a step, for a fork (FR-043 plan 3). Claude
 *  Code files a session as `~/.claude/projects/<cwd slug>/<id>.jsonl`, one
 *  JSON object per line with `uuid`, `parentUuid`, `sessionId` and `type`;
 *  the messages are the `user` and `assistant` lines among many of the
 *  CLI's own (`attachment`, `queue-operation`, `api-request`, `summary`,
 *  ...). A prefix of the file resumes cleanly under a new session id, a
 *  dangling tool call at its end read by the CLI as interrupted (probe P3,
 *  2026-11-02). The cut is pure; placing the copy needs node. */

import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describeTool } from "./actions";
import { claudeHome, projectFolder } from "./sessions";
import type { RunStep } from "./types";

type Line = Record<string, unknown>;

const isRecord = (v: unknown): v is Line => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Line, k: string): string => (typeof o[k] === "string" ? o[k] : "");

/** the message blocks of a transcript line, when it is a message */
function blocks(line: Line): Line[] {
  const message = line["message"];
  if (!isRecord(message)) return [];
  const content = message["content"];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

const REDACTED = /<redacted:[^>]*>/;

/** Whether a message's words are a step's: the same, or, for a kept run's
 *  step with a secret redacted out of it, the words around each redaction
 *  found in order. */
export function sameWords(stepText: string, text: string): boolean {
  if (text === stepText) return true;
  if (!REDACTED.test(stepText)) return false;
  let from = 0;
  for (const part of stepText.split(new RegExp(REDACTED.source, "g"))) {
    if (!part) continue;
    const at = text.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** whether a transcript block is the step: the same words for a text step,
 *  the same tool and title (as canopy folds it, from the input and the
 *  run's folder) for a tool step; `loose` matches a tool by name alone */
function matches(block: Line, step: RunStep, cwd: string, loose: boolean): boolean {
  const kind = str(block, "type");
  if (step.kind === "text") return kind === "text" && sameWords(step.text ?? "", str(block, "text").trim());
  if (step.kind !== "tool" || !step.tool || kind !== "tool_use" || str(block, "name") !== step.tool.name) return false;
  if (loose) return true;
  const input = isRecord(block["input"]) ? block["input"] : {};
  return sameWords(step.tool.title, describeTool(step.tool.name, input, cwd));
}

/** whether two steps would match the same transcript lines */
const same = (a: RunStep, b: RunStep): boolean =>
  a.kind === b.kind && (a.kind === "text" ? a.text === b.text : a.tool?.name === b.tool?.name && a.tool?.title === b.tool?.title);

/** a transcript's lines parsed, a line that is not a JSON object as null */
function parse(lines: readonly string[]): (Line | null)[] {
  return lines.map((raw) => {
    try {
      const v: unknown = JSON.parse(raw);
      return isRecord(v) ? v : null;
    } catch {
      return null;
    }
  });
}

/** The transcript's lines up to and including `step`'s, with a tool step's
 *  result when the file has it, every `sessionId` rewritten to `newId` and
 *  a summary of a later message dropped; null when no line is the step.
 *  `before` are the run's steps ahead of `step`: among several lines that
 *  read the same, the one picked is the k-th, k being how many of those
 *  steps read the same too. A subagent's step (`parent` set) is looked for
 *  among the sidechain lines, the main thread's among the rest. */
export function cutTranscript(lines: readonly string[], step: RunStep, cwd: string, newId: string, before: readonly RunStep[] = []): string[] | null {
  const parsed = parse(lines);
  const side = step.parent !== undefined;
  const candidates = (loose: boolean): number[] =>
    parsed.flatMap((line, i) =>
      line && str(line, "type") === "assistant" && (line["isSidechain"] === true) === side && blocks(line).some((b) => matches(b, step, cwd, loose)) ? [i] : []);
  let found = candidates(false);
  if (!found.length && step.kind === "tool") found = candidates(true);
  const last = found[found.length - 1];
  if (last === undefined) return null;
  const k = before.filter((s) => same(s, step)).length;
  const at = found[k] ?? last;
  let end = at;
  // a tool step's result is the user line that answers its call, a few lines on
  const line = parsed[at];
  if (step.kind === "tool" && line) {
    const call = blocks(line).find((b) => str(b, "type") === "tool_use" && matches(b, step, cwd, true));
    const callId = call ? str(call, "id") : "";
    if (callId) {
      const result = parsed.findIndex((l, i) => i > at && l !== null && str(l, "type") === "user" && blocks(l).some((b) => str(b, "type") === "tool_result" && str(b, "tool_use_id") === callId));
      if (result > at) end = result;
    }
  }
  const kept = parsed.slice(0, end + 1);
  const uuids = new Set(kept.flatMap((l) => (l ? [str(l, "uuid")] : [])));
  const out: string[] = [];
  kept.forEach((l, i) => {
    if (!l) {
      // a line that is not JSON goes through as it is, as the CLI would see it
      out.push(lines[i] ?? "");
      return;
    }
    if (str(l, "type") === "summary" && str(l, "leafUuid") && !uuids.has(str(l, "leafUuid"))) return;
    out.push(JSON.stringify("sessionId" in l ? { ...l, sessionId: newId } : l));
  });
  return out;
}

/** where Claude Code files `session` for a session that worked in `cwd` */
export const transcriptPath = (cwd: string, session: string, home = claudeHome()): string =>
  join(home, "projects", projectFolder(cwd), `${session}.jsonl`);

/** A folder's path with every symlink resolved, as the CLI's own cwd
 *  spells it (a process started through a symlink sees the real path, so
 *  that is the slug the transcript is filed under): the path itself when
 *  it exists, else its nearest existing ancestor resolved with the rest
 *  joined back on, for a worktree that is gone. */
export async function realDir(path: string): Promise<string> {
  const real = await realpath(path).catch(() => null);
  if (real !== null) return real;
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await realDir(parent), basename(path));
}

/** The transcript files `session` may be under for a session that worked
 *  in `cwd`: under the path's own slug and under its real path's, when
 *  they differ. */
export async function transcriptPaths(cwd: string, session: string, home = claudeHome()): Promise<string[]> {
  const real = await realDir(cwd);
  return [...new Set([transcriptPath(cwd, session, home), transcriptPath(real, session, home)])];
}

/** The transcript's lines, or null when there is no such file. */
export async function readTranscript(file: string): Promise<string[] | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  return text === null ? null : text.split("\n").filter((l) => l.length > 0);
}

/** Writes a cut transcript where the CLI looks for a session of the fork's
 *  worktree: under that folder's real path's slug, as `<id>.jsonl`, mode
 *  0600 like the CLI's own. Answers the file's path, for `removeCut` once
 *  the run ends. */
export async function placeCut(cwd: string, id: string, lines: readonly string[], home = claudeHome()): Promise<string> {
  const real = await realDir(cwd);
  const file = transcriptPath(real, id, home);
  await mkdir(join(home, "projects", projectFolder(real)), { recursive: true });
  await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

/** Removes a placed cut; nothing when it is gone already. */
export const removeCut = (file: string): Promise<void> => rm(file, { force: true });
