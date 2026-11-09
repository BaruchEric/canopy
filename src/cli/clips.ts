/** `canopy clip` (FR-054): put text or a file on canopy's clipboard from a
 *  shell, an agent or a script, so it shows on every page and device; list
 *  the clips every backend keeps; print one to stdout or save it; pin, drop
 *  or clear them. Each is a call to the clipboard routes with the caller's
 *  token. A pipe that is not text (a NUL byte, or not UTF-8) goes as a file
 *  named by its first bytes. The lines and the picking are pure
 *  (clips.test.ts). */

import { basename } from "node:path";
import { hostname } from "node:os";
import { agoWord, clipKey, clipLine, kindOf, looksSecret, looksSecretFile, sizeWord, sniffType, sortClips, textHead, CLIP_FILE_MAX, type Clip, type ClipsInfo } from "../core/clips";
import { callerHeaders } from "./api";
import { ask, backendTargets, errText, has, take, Unreachable, type Target } from "./health";

export const CLIP_USAGE = [
  'usage: canopy clip "<text>"            keep text on the clipboard; with no text, what stdin holds (a picture piped in goes as a file)',
  "       canopy clip --file <path>         keep a file: a picture, a PDF, anything up to 25 MB",
  "       canopy clip list [-n N] [--json]  the newest clips on every backend",
  "       canopy clip get [N | id] [-o path]  print a clip's text, or save a file's bytes (N counts from 1; the newest by default)",
  "       canopy clip pin <id> | unpin <id> | rm <id>",
  "       canopy clip clear                 drop every unpinned clip on the home backend",
  "  --backend URL asks only that address ($CANOPY_API, else 127.0.0.1:7850); --on NAME keeps one backend",
].join("\n");

const SUBS = new Set(["put", "list", "ls", "get", "pin", "unpin", "rm", "delete", "clear"]);

/** The words of `canopy clip <text…>` and `canopy clip put <text…>` as they
 *  were typed, once --backend and --on are out: a text that has begun owns
 *  every word after it, so `canopy clip git log -n 5` keeps "-n 5" and never
 *  reads it as clip's own -n. Null for every other form: a sub-command, a
 *  flag first, or `put --file <path>`, whose flags are clip's. */
export function clipWords(args: readonly string[]): string[] | null {
  const [first, ...rest] = args;
  if (first === "put") return rest[0] === "--file" || rest[0] === "-f" ? null : rest;
  return first !== undefined && !SUBS.has(first) && !first.startsWith("-") ? [...args] : null;
}

/** a clip with the backend that keeps it */
export interface HeldClip {
  clip: Clip;
  backend: string;
}

/** every backend's clips as one list, newest first; the same text, or the
 *  same file, on two backends shows once, the newest copy */
export function mergeHeld(lists: readonly { backend: string; clips: readonly Clip[] }[]): HeldClip[] {
  const all = lists.flatMap((l) => l.clips.map((clip) => ({ clip, backend: l.backend })));
  const order = sortClips(all.map((h) => h.clip));
  const seen = new Set<string>();
  const out: HeldClip[] = [];
  for (const c of order) {
    if (seen.has(clipKey(c))) continue;
    seen.add(clipKey(c));
    const held = all.find((h) => h.clip === c);
    if (held) out.push(held);
  }
  return out;
}

/** `n  id  when  source  kind  text`, newest first; the backend after the
 *  source when there are several */
export function clipLines(held: readonly HeldClip[], now: number, several: boolean): string[] {
  return held.map((h, i) => {
    const pin = h.clip.pinned ? "*" : " ";
    const where = several ? `${h.clip.source}@${h.backend}` : h.clip.source;
    const what = h.clip.file ? `${clipLine(h.clip.file.name, 80)}  ${sizeWord(h.clip.file.size)}` : clipLine(h.clip.text, 90);
    return `${String(i + 1).padStart(3)}${pin} ${h.clip.id}  ${agoWord(h.clip.at, now).padStart(3)}  ${where.padEnd(several ? 18 : 9)} ${kindOf(h.clip).padEnd(7)} ${what}`;
  });
}

/** the clip a reference names: a count from 1 in the list, or an id; the newest with none */
export function pickHeld(held: readonly HeldClip[], ref: string | undefined): HeldClip | undefined {
  if (ref === undefined) return held[0];
  if (/^\d+$/.test(ref)) return held[Number(ref) - 1];
  return held.find((h) => h.clip.id === ref);
}

/** what a clip from here says it came from: the canopy shell's repo, else this machine */
export function cliFrom(env: Record<string, string | undefined>, host: string): string {
  const repo = env["CANOPY_REPO"];
  const where = repo ? basename(repo.replace(/\/+$/, "")) : host;
  return env["CANOPY_RUN"] ? `${where} (run)` : where;
}

/** a file's bytes sent to the home backend as a clip */
async function sendFile(home: string, bytes: Uint8Array, name: string, type: string, from: string): Promise<Clip> {
  const q = new URLSearchParams({ name, source: "cli", from });
  const res = await fetch(`${home}/api/clips/file?${q}`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
    headers: callerHeaders(home, undefined, { "content-type": type }),
    body: bytes,
  });
  const out = (await res.json().catch(() => ({}))) as Clip & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `${home} answered ${res.status}`);
  return out;
}

/** a kept file's bytes from the backend that keeps it */
async function fetchFile(t: Target, id: string): Promise<Uint8Array> {
  const tried: string[] = [];
  for (const url of t.urls) {
    let res: Response;
    try {
      res = await fetch(`${url}/api/clips/file?id=${encodeURIComponent(id)}`, { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: callerHeaders(url) });
    } catch (err) {
      tried.push(`${url}: ${errText(err)}`);
      continue;
    }
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    const out = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(out.error ?? `${t.name} answered ${res.status}`);
  }
  throw new Error(`${t.name} did not answer: ${tried.join("; ")}`);
}

export async function clipCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const on = take(args, "--on");
  // a text's own words are never clip's flags
  const typed = clipWords(args);
  const n = typed ? undefined : take(args, "-n");
  const filePath = typed ? undefined : (take(args, "--file") ?? take(args, "-f"));
  const outPath = typed ? undefined : take(args, "-o");
  const asJson = typed ? false : has(args, "--json");
  const home = (given ??process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const homeTarget: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(errText(err));
  const sub = typed ? "put" : args[0] !== undefined && SUBS.has(args[0]) ? args.shift() : undefined;
  const piped = !process.stdin.isTTY;

  const put = async (text: string) => {
    if (!text.trim()) return fail(CLIP_USAGE);
    if (looksSecret(text)) return fail("that looks like a key or a password; canopy's clipboard never keeps one");
    const c = await ask<Clip>(homeTarget, "POST", "/api/clips", { text, source: "cli", from: cliFrom(process.env, hostname()) }).catch(failed);
    console.log(`${c.id}  ${kindOf(c)}  ${clipLine(c.text, 70)}`);
  };

  const putFile = async (bytes: Uint8Array, name: string, type: string) => {
    if (bytes.byteLength === 0) return fail("the file is empty");
    if (bytes.byteLength > CLIP_FILE_MAX) return fail(`a file on the clipboard is at most ${sizeWord(CLIP_FILE_MAX)}; that one is ${sizeWord(bytes.byteLength)}`);
    if (looksSecretFile(name)) return fail("that file looks like a key or a password; canopy's clipboard never keeps one");
    const c = await sendFile(home, bytes, name, type, cliFrom(process.env, hostname())).catch(failed);
    console.log(`${c.id}  ${kindOf(c)}  ${c.file?.name ?? c.text}  ${sizeWord(c.file?.size ?? bytes.byteLength)}`);
  };

  if (filePath !== undefined) {
    if (sub !== undefined && sub !== "put") return fail(CLIP_USAGE);
    if (args.length > 0) return fail(CLIP_USAGE);
    const f = Bun.file(filePath);
    if (!(await f.exists())) return fail(`no file at ${filePath}`);
    return putFile(new Uint8Array(await f.arrayBuffer()), basename(filePath), f.type || "application/octet-stream");
  }

  // `canopy clip words…`, `canopy clip put words…`, or what stdin holds:
  // text as text, anything else (a picture piped in) as a file
  if (sub === "put" || (sub === undefined && (args.length > 0 || piped))) {
    const words = typed ?? args;
    if (words.length > 0) return put(words.join(" "));
    const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
    if (textHead(bytes) !== null) return put(new TextDecoder().decode(bytes));
    const sniffed = sniffType(bytes);
    return putFile(bytes, `clip.${sniffed?.ext ?? "bin"}`, sniffed?.type ?? "application/octet-stream");
  }

  let targetsBy = new Map<string, Target>();
  const read = async (): Promise<{ held: HeldClip[]; several: boolean }> => {
    const targets = await backendTargets(home, { given, on }, fail);
    targetsBy = new Map(targets.map((t) => [t.name, t]));
    const lists = await Promise.all(
      targets.map(async (t) => ({ backend: t.name, clips: (await ask<ClipsInfo>(t, "GET", "/api/clips").catch(() => null))?.clips ?? null })),
    );
    const got = lists.filter((l): l is { backend: string; clips: Clip[] } => l.clips !== null);
    if (got.length === 0) return fail("no backend answered with its clips (an older backend has none)");
    return { held: mergeHeld(got), several: got.length > 1 };
  };

  if (sub === undefined || sub === "list" || sub === "ls") {
    if (args.length > 0) return fail(CLIP_USAGE);
    const { held, several } = await read();
    const count = n === undefined ? 20 : Number(n);
    if (!Number.isInteger(count) || count < 1) return fail("-n takes a whole number from 1");
    const shown = held.slice(0, count);
    if (asJson) return console.log(JSON.stringify(shown, null, 2));
    if (shown.length === 0) return console.log("no clips");
    for (const line of clipLines(shown, Date.now(), several)) console.log(line);
    return;
  }

  if (sub === "get") {
    if (args.length > 1) return fail(CLIP_USAGE);
    const { held } = await read();
    const h = pickHeld(held, args[0]);
    if (!h) return fail(args[0] === undefined ? "no clips" : `no clip ${args[0]}`);
    if (h.clip.file) {
      const file = h.clip.file;
      if (outPath === undefined && process.stdout.isTTY) return fail(`${h.clip.id} is a file (${file.name}, ${sizeWord(file.size)}); save it with -o ${file.name}, or send it on: canopy clip get ${h.clip.id} > ${file.name}`);
      const t = targetsBy.get(h.backend);
      if (!t) return fail(`no backend ${h.backend}`);
      const bytes = await fetchFile(t, h.clip.id).catch(failed);
      if (outPath === undefined) {
        process.stdout.write(bytes);
        return;
      }
      await Bun.write(outPath, bytes);
      console.log(`saved ${file.name} (${sizeWord(bytes.byteLength)}) to ${outPath}`);
      return;
    }
    if (outPath !== undefined) {
      await Bun.write(outPath, h.clip.text);
      console.log(`saved ${h.clip.id} to ${outPath}`);
      return;
    }
    // as it was copied, with no newline added, so `canopy clip get | pbcopy` is exact
    process.stdout.write(h.clip.text);
    return;
  }

  if (sub === "clear") {
    if (args.length > 0) return fail(CLIP_USAGE);
    const r = await ask<{ gone: string[] }>(homeTarget, "POST", "/api/clips/clear").catch(failed);
    console.log(r.gone.length === 1 ? "dropped 1 clip" : `dropped ${r.gone.length} clips`);
    return;
  }

  // pin, unpin and rm go to whichever backend keeps the id
  const [id, ...more] = args;
  if (!id || more.length > 0) return fail(CLIP_USAGE);
  const targets = await backendTargets(home, { given, on }, fail);
  const without: string[] = [];
  const trouble: string[] = [];
  for (const t of targets) {
    try {
      if (sub === "rm" || sub === "delete") {
        await ask<{ ok: true }>(t, "DELETE", `/api/clips?id=${encodeURIComponent(id)}`);
        console.log(`dropped ${id}`);
      } else {
        const c = await ask<Clip>(t, "POST", "/api/clips/pin", { id, pinned: sub === "pin" });
        console.log(`${c.pinned ? "pinned" : "unpinned"} ${c.id}`);
      }
      return;
    } catch (err) {
      // a backend without the id says so; the next may keep it. So may the
      // next after one that does not answer or has no clipboard: what went
      // wrong there is said once every backend was asked
      if (/no clip by that id/.test(errText(err))) without.push(t.name);
      else trouble.push(err instanceof Unreachable ? `${t.name} did not answer: ${err.message}` : `${t.name}: ${errText(err)}`);
    }
  }
  return fail([...(without.length > 0 ? [`no clip ${id} on ${without.join(", ")}`] : []), ...trouble].join("; "));
}
