/** Quick notes and reminders, the server half (FR-020;
 *  docs/superpowers/specs/2026-11-02-notes-design.md): the file, the routes
 *  under /api/notes, the `notes` event, and the delivery of a reminder that
 *  came due. The rules are `core/notes.ts`.
 *
 *  The file is `<config dir>/notes.json`, one array, read again before every
 *  write and written whole through a temp file and a rename, so two servers
 *  on one config dir during a redeploy's overlap keep each other's notes.
 *  Every change broadcasts the whole list. `remind` runs from the triggers'
 *  tick on the server holding the flows lock (server/index.ts), so a
 *  reminder is delivered by one server only. Bun-only (fs). */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWhen } from "../core/cron";
import { isNoteId, mintNoteId, noteText, parseNotes, remindDue, type QuickNote, type QuickNotesInfo } from "../core/notes";
import { configDir } from "../core/store";
import type { Repo, ServerEvent } from "../core/types";

export const notesFile = (dir: string = configDir()): string => join(dir, "notes.json");

export interface NotesDeps {
  broadcast: (ev: ServerEvent) => void;
  /** a note's repo, by id or absolute path; the note keeps the id */
  repo: (ref: string) => Repo | undefined;
  dir?: string;
  now?: () => number;
  mintId?: () => string;
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** a refusal the routes answer with its status */
class NoteRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class NotesHub {
  private notes: readonly QuickNote[] = [];
  /** the writes, one after another, each on a fresh read of the file */
  private serial: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private deps: NotesDeps) {}

  private get file(): string {
    return notesFile(this.deps.dir);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async read(): Promise<readonly QuickNote[]> {
    try {
      const v: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return parseNotes(v);
    } catch {
      // no file yet, or one that is not JSON: no notes
      return [];
    }
  }

  private async write(notes: readonly QuickNote[]): Promise<void> {
    const dir = this.deps.dir ?? configDir();
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** the list as last read; the file is read once, then kept in step by the writes */
  async list(): Promise<readonly QuickNote[]> {
    if (!this.loaded) {
      await this.serial;
      if (!this.loaded) {
        this.notes = await this.read();
        this.loaded = true;
      }
    }
    return this.notes;
  }

  info(): QuickNotesInfo {
    return { notes: [...this.notes] };
  }

  private publish(): void {
    this.deps.broadcast({ type: "notes", notes: [...this.notes] });
  }

  /** One change: the file read again, `fn` applied, the result written and
   *  broadcast when it differs. `fn` returns null to change nothing. */
  private change(fn: (notes: readonly QuickNote[]) => readonly QuickNote[] | null): Promise<void> {
    const next = this.serial.then(async () => {
      const fresh = await this.read();
      const out = fn(fresh);
      this.loaded = true;
      if (out === null || out === fresh) {
        this.notes = fresh;
        return;
      }
      await this.write(out);
      this.notes = out;
      this.publish();
    });
    this.serial = next.catch((err) => console.error(`notes: ${errText(err)}`));
    return next;
  }

  /** the time a body names: unix ms as given, or a time as typed read on
   *  this server's clock (`in 30m`, `14:00`, an ISO date and time) */
  private whenOf(at: unknown): number {
    const now = this.now();
    if (typeof at === "number") {
      if (!Number.isFinite(at) || at <= now) throw new NoteRefusal(400, "at must be a time in the future, in unix ms");
      return at;
    }
    if (typeof at !== "string" || !at.trim()) throw new NoteRefusal(400, "at must be a time: in 30m, 14:00, or a date and time");
    const when = parseWhen(at, now);
    if (typeof when !== "number") throw new NoteRefusal(400, when.error);
    return when;
  }

  private repoOf(ref: unknown): string {
    if (typeof ref !== "string" || !ref.trim()) throw new NoteRefusal(400, "repo must be a repo id or path");
    const repo = this.deps.repo(ref.trim());
    if (!repo) throw new NoteRefusal(404, `no repo ${ref.trim()} on this backend`);
    return repo.id;
  }

  async add(body: Record<string, unknown>): Promise<QuickNote> {
    const text = typeof body["text"] === "string" ? noteText(body["text"]) : "";
    if (!text) throw new NoteRefusal(400, "text is required");
    const note: QuickNote = { id: (this.deps.mintId ?? mintNoteId)(), text, createdAt: this.now() };
    if (body["repo"] !== undefined && body["repo"] !== null) note.repoId = this.repoOf(body["repo"]);
    if (body["at"] !== undefined && body["at"] !== null) note.due = this.whenOf(body["at"]);
    await this.change((notes) => [...notes, note]);
    return note;
  }

  /** text, repo and time by id; `repo: null` and `at: null` clear them. A
   *  moved time clears the delivery mark, so the reminder comes back once more. */
  async edit(body: Record<string, unknown>): Promise<QuickNote> {
    const id = body["id"];
    if (!isNoteId(id)) throw new NoteRefusal(400, "id must be a note id");
    const text = body["text"] === undefined ? undefined : typeof body["text"] === "string" ? noteText(body["text"]) : "";
    if (text === "") throw new NoteRefusal(400, "text cannot be empty");
    const repoId = body["repo"] === undefined ? undefined : body["repo"] === null ? null : this.repoOf(body["repo"]);
    const due = body["at"] === undefined ? undefined : body["at"] === null ? null : this.whenOf(body["at"]);
    let out: QuickNote | undefined;
    await this.change((notes) => {
      const cur = notes.find((n) => n.id === id);
      if (!cur) return null;
      const next: QuickNote = { ...cur };
      if (text !== undefined) next.text = text;
      if (repoId === null) delete next.repoId;
      else if (repoId !== undefined) next.repoId = repoId;
      if (due === null) {
        delete next.due;
        delete next.remindedAt;
      } else if (due !== undefined && due !== cur.due) {
        next.due = due;
        delete next.remindedAt;
      }
      out = next;
      return notes.map((n) => (n.id === id ? next : n));
    });
    if (!out) throw new NoteRefusal(404, "no note by that id");
    return out;
  }

  async done(id: unknown): Promise<QuickNote> {
    if (!isNoteId(id)) throw new NoteRefusal(400, "id must be a note id");
    let out: QuickNote | undefined;
    await this.change((notes) => {
      const cur = notes.find((n) => n.id === id);
      if (!cur) return null;
      if (cur.doneAt !== undefined) {
        out = cur;
        return null;
      }
      out = { ...cur, doneAt: this.now() };
      const next = out;
      return notes.map((n) => (n.id === id ? next : n));
    });
    if (!out) throw new NoteRefusal(404, "no note by that id");
    return out;
  }

  async remove(id: unknown): Promise<void> {
    if (!isNoteId(id)) throw new NoteRefusal(400, "id must be a note id");
    let found = false;
    await this.change((notes) => {
      found = notes.some((n) => n.id === id);
      return found ? notes.filter((n) => n.id !== id) : null;
    });
    if (!found) throw new NoteRefusal(404, "no note by that id");
  }

  /** the reminders whose time has come, each delivered once: marked in the
   *  file and broadcast, which the inbox reads as a row */
  async remind(now: number = this.now()): Promise<QuickNote[]> {
    let delivered: QuickNote[] = [];
    await this.change((notes) => {
      const r = remindDue(notes, now);
      delivered = r.delivered;
      return r.notes === notes ? null : r.notes;
    });
    return delivered;
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/notes" && !path.startsWith("/api/notes/")) return null;
    try {
      if (req.method === "GET" && path === "/api/notes") {
        await this.list();
        return json(this.info());
      }
      if (req.method === "POST" && path === "/api/notes") return json(await this.add(await this.body(req)));
      if (req.method === "POST" && path === "/api/notes/edit") return json(await this.edit(await this.body(req)));
      if (req.method === "POST" && path === "/api/notes/done") return json(await this.done((await this.body(req))["id"]));
      if (req.method === "DELETE" && path === "/api/notes") {
        await this.remove(url.searchParams.get("id"));
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof NoteRefusal) return json({ error: err.message }, err.status);
      return json({ error: errText(err) }, 500);
    }
  }

  private async body(req: Request): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await req.json();
      return isRecord(body) ? body : {};
    } catch {
      return {};
    }
  }
}
