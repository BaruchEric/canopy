/** `canopy clip` (FR-054): put text on canopy's clipboard from a shell, an
 *  agent or a script, so it shows on every page and device; list the clips
 *  every backend keeps; print one to stdout; pin, drop or clear them. Each
 *  is a call to the clipboard routes with the caller's token. The lines and
 *  the picking are pure (clips.test.ts). */

import { basename } from "node:path";
import { hostname } from "node:os";
import { agoWord, clipKind, clipLine, looksSecret, sortClips, type Clip, type ClipsInfo } from "../core/clips";
import { ask, backendTargets, errText, has, take, type Target } from "./health";

export const CLIP_USAGE = [
  'usage: canopy clip "<text>"            keep text on the clipboard; with no text, what stdin holds',
  "       canopy clip list [-n N] [--json]  the newest clips on every backend",
  "       canopy clip get [N | id]          print a clip's text, the newest by default (N counts from 1)",
  "       canopy clip pin <id> | unpin <id> | rm <id>",
  "       canopy clip clear                 drop every unpinned clip on the home backend",
  "  --backend URL asks only that address ($CANOPY_API, else 127.0.0.1:7850); --on NAME keeps one backend",
].join("\n");

const SUBS = new Set(["put", "list", "ls", "get", "pin", "unpin", "rm", "delete", "clear"]);

/** a clip with the backend that keeps it */
export interface HeldClip {
  clip: Clip;
  backend: string;
}

/** every backend's clips as one list, newest first; the same text on two
 *  backends shows once, the newest copy */
export function mergeHeld(lists: readonly { backend: string; clips: readonly Clip[] }[]): HeldClip[] {
  const all = lists.flatMap((l) => l.clips.map((clip) => ({ clip, backend: l.backend })));
  const order = sortClips(all.map((h) => h.clip));
  const seen = new Set<string>();
  const out: HeldClip[] = [];
  for (const c of order) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
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
    return `${String(i + 1).padStart(3)}${pin} ${h.clip.id}  ${agoWord(h.clip.at, now).padStart(3)}  ${where.padEnd(several ? 18 : 9)} ${clipKind(h.clip.text).padEnd(7)} ${clipLine(h.clip.text, 90)}`;
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

export async function clipCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const on = take(args, "--on");
  const n = take(args, "-n");
  const asJson = has(args, "--json");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const homeTarget: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(errText(err));
  const sub = args[0] !== undefined && SUBS.has(args[0]) ? args.shift() : undefined;
  const piped = !process.stdin.isTTY;

  const put = async (text: string) => {
    if (!text.trim()) return fail(CLIP_USAGE);
    if (looksSecret(text)) return fail("that looks like a key or a password; canopy's clipboard never keeps one");
    const c = await ask<Clip>(homeTarget, "POST", "/api/clips", { text, source: "cli", from: cliFrom(process.env, hostname()) }).catch(failed);
    console.log(`${c.id}  ${clipKind(c.text)}  ${clipLine(c.text, 70)}`);
  };

  // `canopy clip words…`, `canopy clip put words…`, or text on stdin
  if (sub === "put" || (sub === undefined && (args.length > 0 || piped))) {
    if (args.length > 0) return put(args.join(" "));
    return put(await Bun.stdin.text());
  }

  const read = async (): Promise<{ held: HeldClip[]; several: boolean }> => {
    const targets = await backendTargets(home, { given, on }, fail);
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
      // a backend without the id says so; the next may keep it
      if (!/no clip by that id/.test(errText(err))) return failed(err);
    }
  }
  return fail(`no clip ${id} on ${targets.map((t) => t.name).join(", ")}`);
}
