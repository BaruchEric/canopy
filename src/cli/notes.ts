/** `canopy note` (FR-020): jot a note or set a reminder on a backend, list
 *  the open ones, mark one done or delete it. Each is a call to the notes
 *  routes with the caller's token; the time is read on the backend's clock. */

import { dueWord, openNotes, sortNotes, type QuickNote, type QuickNotesInfo } from "../core/notes";
import { ask, errText, has, take, type Target } from "./health";

export const NOTE_USAGE = [
  'usage: canopy note add "<text>" [--repo <id or path>] [--at <time>] [--backend URL]',
  "       canopy note list [--all] [--backend URL]",
  "       canopy note done <id> [--backend URL]",
  "       canopy note delete <id> [--backend URL]",
].join("\n");

/** The body `add` posts: the text, the repo when given, the time as typed
 *  (`in 30m`, `14:00`, `2026-11-03 09:00`), for the backend to read. */
export function addBody(text: string, repo: string | undefined, at: string | undefined): { text: string; repo?: string; at?: string } {
  return { text, ...(repo !== undefined ? { repo } : {}), ...(at !== undefined ? { at } : {}) };
}

/** `id  when  repo  text`, reminders first and the soonest at the top, as
 *  the popup lists them; with `all`, the done ones after, marked done. */
export function noteLines(notes: readonly QuickNote[], now: number, all = false, repoName: (id: string) => string = (id) => id): string[] {
  const open = sortNotes(openNotes(notes));
  const done = all ? notes.filter((n) => n.doneAt !== undefined).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)) : [];
  const line = (n: QuickNote, word: string) => `${n.id}  ${word.padEnd(9)} ${(n.repoId ? repoName(n.repoId) : "").padEnd(16)} ${n.text.replace(/\s+/g, " ")}`;
  return [
    ...open.map((n) => line(n, n.due === undefined ? "" : n.remindedAt !== undefined && n.due <= now ? "in inbox" : dueWord(n.due, now))),
    ...done.map((n) => line(n, "done")),
  ];
}

export async function noteCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const repo = take(args, "--repo");
  const at = take(args, "--at");
  const all = has(args, "--all");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const target: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(errText(err));
  const [sub, ...rest] = args;

  if (sub === "add") {
    const text = rest.join(" ").trim();
    if (!text) return fail(NOTE_USAGE);
    const n = await ask<QuickNote>(target, "POST", "/api/notes", addBody(text, repo, at)).catch(failed);
    console.log(`${n.id}${n.due !== undefined ? `  reminds ${dueWord(n.due, Date.now())} (${new Date(n.due).toLocaleString()})` : ""}`);
    return;
  }
  if (repo !== undefined || at !== undefined) return fail(NOTE_USAGE);
  if (sub === undefined || sub === "list") {
    if (rest.length > 0) return fail(NOTE_USAGE);
    const info = await ask<QuickNotesInfo>(target, "GET", "/api/notes").catch(failed);
    const lines = noteLines(info.notes, Date.now(), all);
    if (lines.length === 0) return console.log(all ? "no notes" : "no open notes");
    for (const line of lines) console.log(line);
    return;
  }
  if (sub === "done" || sub === "delete" || sub === "rm") {
    const [id, ...more] = rest;
    if (!id || more.length > 0 || all) return fail(NOTE_USAGE);
    if (sub === "done") {
      const n = await ask<QuickNote>(target, "POST", "/api/notes/done", { id }).catch(failed);
      console.log(`done: ${n.text.replace(/\s+/g, " ")}`);
      return;
    }
    await ask<{ ok: true }>(target, "DELETE", `/api/notes?id=${encodeURIComponent(id)}`).catch(failed);
    console.log(`deleted ${id}`);
    return;
  }
  return fail(NOTE_USAGE);
}
