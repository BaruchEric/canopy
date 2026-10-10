import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { claudeHome, codexHome, isSessionId, projectFolder } from "./sessions";
import type { Harness } from "./types";

/*
 * Moving an agent session to another machine: the transcript's working
 * folders rewritten from the source repo's path to the target's, and the
 * file put where the target's harness looks for it. Claude files a
 * conversation under the folder of its `cwd`; Codex by day, with `cwd` in
 * its `session_meta` line. Only `cwd` fields move: message text and tool
 * input keep the paths they had, since that is what was said.
 */

/** the largest transcript a move carries */
export const MOVE_MAX = 64 * 1024 * 1024;

/** a refusal with the HTTP status the route answers with */
export class MoveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MoveError";
  }
}

/** `cwd` from the source repo to the target's: the repo itself and
 *  anything under it; any other folder as it was */
export function movePath(cwd: string, from: string, to: string): string {
  if (cwd === from) return to;
  if (cwd.startsWith(`${from}/`)) return to + cwd.slice(from.length);
  return cwd;
}

/** the `cwd` values a record carries: Claude's top-level one, Codex's in its payload */
function cwdsOf(rec: unknown): string[] {
  if (!rec || typeof rec !== "object") return [];
  const out: string[] = [];
  const top = (rec as { cwd?: unknown }).cwd;
  if (typeof top === "string") out.push(top);
  const payload = (rec as { payload?: unknown }).payload;
  const inner = payload && typeof payload === "object" ? (payload as { cwd?: unknown }).cwd : undefined;
  if (typeof inner === "string") out.push(inner);
  return out;
}

/** Every line checked as JSON and its `cwd` fields moved, the rest of the
 *  line left byte for byte as it was. */
export function rewriteTranscript(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const trailing = lines.at(-1) === "";
  if (trailing) lines.pop();
  const out = lines.map((line, i) => {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new MoveError(400, `line ${i + 1} of the transcript is not JSON (cut off?)`);
    }
    let next = line;
    let changed = false;
    for (const cwd of new Set(cwdsOf(rec))) {
      const moved = movePath(cwd, from, to);
      if (moved === cwd) continue;
      next = next.split(`"cwd":${JSON.stringify(cwd)}`).join(`"cwd":${JSON.stringify(moved)}`);
      changed = true;
    }
    // the rewrite matched the compact form both harnesses write; a line in
    // any other shape would keep the old folder, so it fails loudly here
    if (changed && cwdsOf(JSON.parse(next)).some((c) => movePath(c, from, to) !== c)) {
      throw new MoveError(400, `line ${i + 1} of the transcript keeps a cwd the move could not rewrite`);
    }
    return next;
  });
  return out.join("\n") + (trailing ? "\n" : "");
}

/** a codex rollout's path under `sessions/`, its day folders and a file
 *  name ending in the session id */
const codexName = (name: string, session: string): boolean =>
  /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(name) && name.endsWith(`-${session}.jsonl`) && normalize(name) === name;

/** Writes the transcript where the target's harness finds it. An earlier
 *  copy is replaced only when it is a line-for-line prefix of this one (the
 *  same conversation, moved here before); otherwise the two have split. */
export async function placeTranscript(o: {
  harness: Harness;
  session: string;
  text: string;
  name: string;
  to: string;
  homes?: { claude?: string; codex?: string };
}): Promise<{ file: string; replaced: boolean }> {
  if (!isSessionId(o.session)) throw new MoveError(400, "session must be a session id");
  if (o.text.length > MOVE_MAX) throw new MoveError(413, "the transcript is over 64 MB");
  let file: string;
  if (o.harness === "codex") {
    if (!codexName(o.name, o.session)) throw new MoveError(400, "not a codex rollout name for that session");
    file = join(o.homes?.codex ?? codexHome(), "sessions", o.name);
  } else {
    file = join(o.homes?.claude ?? claudeHome(), "projects", projectFolder(o.to), `${o.session}.jsonl`);
  }
  const had = await readFile(file, "utf8").catch(() => null);
  if (had !== null && had !== o.text && !(o.text.startsWith(had) && (had === "" || had.endsWith("\n")))) {
    throw new MoveError(409, "this machine already has a different copy of that conversation");
  }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.moving-${process.pid}`;
  await writeFile(tmp, o.text);
  await rename(tmp, file);
  return { file, replaced: had !== null };
}

/** the size of a file, null when it is not there */
export const sizeOf = async (file: string): Promise<number | null> => (await stat(file).catch(() => null))?.size ?? null;
