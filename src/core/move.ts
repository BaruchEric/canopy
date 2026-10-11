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

/** the record with only its own cwd fields moved (top-level and payload) */
function moveCwds(rec: unknown, from: string, to: string): unknown {
  if (!rec || typeof rec !== "object") return rec;
  const out: Record<string, unknown> = { ...(rec as Record<string, unknown>) };
  if (typeof out.cwd === "string") out.cwd = movePath(out.cwd, from, to);
  const payload = out.payload;
  if (payload && typeof payload === "object" && typeof (payload as { cwd?: unknown }).cwd === "string") {
    const p = payload as Record<string, unknown> & { cwd: string };
    out.payload = { ...p, cwd: movePath(p.cwd, from, to) };
  }
  return out;
}

/** Every line checked as JSON and its own `cwd` fields moved. A line is
 *  edited in place when that gives exactly the right record, so the rest
 *  stays byte for byte; otherwise it is written out again. */
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
    // move the first `"cwd":<old>` in the line; when the result is not
    // exactly the record with only its own cwd fields moved (the first hit
    // was a nested key, odd spacing, escaping), write the record out again
    let next = line;
    let moves = false;
    for (const cwd of new Set(cwdsOf(rec))) {
      const moved = movePath(cwd, from, to);
      if (moved === cwd) continue;
      moves = true;
      const key = `"cwd":${JSON.stringify(cwd)}`;
      const at = next.indexOf(key);
      if (at >= 0) next = next.slice(0, at) + `"cwd":${JSON.stringify(moved)}` + next.slice(at + key.length);
    }
    if (moves) {
      const want = moveCwds(rec, from, to);
      if (!Bun.deepEquals(JSON.parse(next), want, true)) next = JSON.stringify(want);
    }
    return next;
  });
  return out.join("\n") + (trailing ? "\n" : "");
}

/** a codex rollout's path under `sessions/`, its day folders and a file
 *  name ending in the session id */
const codexName = (name: string, session: string): boolean =>
  /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(name) && name.endsWith(`-${session}.jsonl`) && normalize(name) === name;

/** what placeTranscript takes: the moved text and where it goes */
export interface PlaceTranscript {
  harness: Harness;
  session: string;
  text: string;
  name: string;
  to: string;
  homes?: { claude?: string; codex?: string };
}

const SPLIT = "this machine already has a different copy of that conversation";

/** where the transcript goes, what is there now, and whether the two have
 *  split: an earlier copy may be replaced only when it is a line-for-line
 *  prefix of this one (the same conversation, moved here before) */
async function placing(o: PlaceTranscript): Promise<{ file: string; had: string | null; split: boolean }> {
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
  const split = had !== null && had !== o.text && !(o.text.startsWith(had) && (had === "" || had.endsWith("\n")));
  return { file, had, split };
}

/** Why placeTranscript would refuse this transcript, or null when it would
 *  write it; writes nothing. A move asks before it lands any work, so a
 *  refusal leaves the target as it was. Throws as placeTranscript does for
 *  a bad session id, size or codex name. */
export async function transcriptConflict(o: PlaceTranscript): Promise<string | null> {
  return (await placing(o)).split ? SPLIT : null;
}

/** Writes the transcript where the target's harness finds it, refusing a
 *  copy that has split from this one (see placing). */
export async function placeTranscript(o: PlaceTranscript): Promise<{ file: string; replaced: boolean }> {
  const { file, had, split } = await placing(o);
  if (split) throw new MoveError(409, SPLIT);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.moving-${process.pid}`;
  await writeFile(tmp, o.text);
  await rename(tmp, file);
  return { file, replaced: had !== null };
}

/** the size of a file, null when it is not there */
export const sizeOf = async (file: string): Promise<number | null> => (await stat(file).catch(() => null))?.size ?? null;

/** what a stop needs of a pane: keys in, and which agent runs there now */
export interface PaneDriver {
  keys(keys: string[], literal?: boolean): Promise<void>;
  agent(): Promise<Harness | null>;
}

/** the command each harness quits on */
export const QUIT: Record<Harness, string> = { claude: "/exit", codex: "/quit" };

/** Quits the agent in a pane the way a person would: Escape (stops a turn
 *  in progress, nothing at an idle prompt), the quit command, then Enter on
 *  its own, since Codex swallows an Enter sent with the text. True once the
 *  pane is back at its shell; false if it is not within `waitMs`. */
export async function endAgent(pane: PaneDriver, harness: Harness, o: { waitMs?: number; beatMs?: number } = {}): Promise<boolean> {
  const waitMs = o.waitMs ?? 20_000;
  const beat = o.beatMs ?? 300;
  const now = await pane.agent();
  if (now === null) return true;
  if (now !== harness) throw new MoveError(409, `${now} runs in that shell, not ${harness}`);
  await pane.keys(["Escape"]);
  await Bun.sleep(beat);
  await pane.keys([QUIT[harness]], true);
  await Bun.sleep(beat);
  await pane.keys(["Enter"]);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if ((await pane.agent()) === null) return true;
    await Bun.sleep(beat);
  }
  return false;
}
