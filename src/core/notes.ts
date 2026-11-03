/**
 * Quick notes and reminders (FR-020; docs/superpowers/specs/2026-11-02-notes-design.md):
 * the record, the file's shape, and the pure rules on a list of notes. A
 * note is a line of text, on a repo or on its own, with an optional time it
 * comes back at; when that time has come it is delivered once to the inbox
 * (`remindedAt`) and stays there until it is done. Browser-safe: the UI
 * imports the types and the words; the server half is `server/notes.ts`.
 */

/** the most characters a note keeps */
export const QUICK_NOTE_CHARS = 600;

export interface QuickNote {
  /** `n-` and eight base32 characters */
  id: string;
  text: string;
  /** the repo it is about, by the backend's own id; absent for a note on its own */
  repoId?: string;
  /** when it comes back, unix ms; absent for a plain note */
  due?: number;
  createdAt: number;
  /** when the reminder reached the inbox; set once, cleared when `due` moves */
  remindedAt?: number;
  doneAt?: number;
}

/** `GET /api/notes` and the `notes` event: every note the backend keeps */
export interface QuickNotesInfo {
  notes: QuickNote[];
}

const NOTE_ID = /^n-[a-z2-7]{8}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export const isNoteId = (v: unknown): v is string => typeof v === "string" && NOTE_ID.test(v);

/** `n-` and 8 base32 characters from 5 random bytes, as the work ledger mints its ids */
export function mintNoteId(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(5);
  if (bytes.length !== 5) throw new Error("a note id takes five random bytes");
  let out = "";
  for (let i = 0; i < 8; i++) {
    const bit = i * 5;
    const byte = Math.floor(bit / 8);
    const offset = bit % 8;
    const window = ((bytes[byte] ?? 0) << 8) | (bytes[byte + 1] ?? 0);
    const index = (window >> (11 - offset)) & 31;
    out += BASE32[index];
  }
  return `n-${out}`;
}

/** a note's text as kept: trimmed, inner lines kept, capped at QUICK_NOTE_CHARS */
export const noteText = (text: string): string => text.trim().slice(0, QUICK_NOTE_CHARS);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const timeOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** one record of the file as a note, or null when it is not one */
export function parseNote(v: unknown): QuickNote | null {
  if (!isRecord(v) || !isNoteId(v["id"]) || typeof v["text"] !== "string") return null;
  const createdAt = timeOf(v["createdAt"]);
  if (createdAt === undefined) return null;
  const note: QuickNote = { id: v["id"], text: v["text"], createdAt };
  if (typeof v["repoId"] === "string" && v["repoId"]) note.repoId = v["repoId"];
  const due = timeOf(v["due"]);
  if (due !== undefined) note.due = due;
  const remindedAt = timeOf(v["remindedAt"]);
  if (remindedAt !== undefined) note.remindedAt = remindedAt;
  const doneAt = timeOf(v["doneAt"]);
  if (doneAt !== undefined) note.doneAt = doneAt;
  return note;
}

/** the file's array read back; a record that is not a note is dropped, never the file */
export function parseNotes(v: unknown): QuickNote[] {
  if (!Array.isArray(v)) return [];
  const out: QuickNote[] = [];
  for (const item of v) {
    const n = parseNote(item);
    if (n) out.push(n);
  }
  return out;
}

export const openNotes = (notes: readonly QuickNote[]): QuickNote[] => notes.filter((n) => n.doneAt === undefined);

/** reminders first, the soonest at the top; then plain notes, newest first */
export function sortNotes(notes: readonly QuickNote[]): QuickNote[] {
  return [...notes].sort((a, b) => {
    if (a.due !== undefined && b.due !== undefined) return a.due - b.due || b.createdAt - a.createdAt;
    if (a.due !== undefined) return -1;
    if (b.due !== undefined) return 1;
    return b.createdAt - a.createdAt;
  });
}

/** whether a reminder's time has come and it has not reached the inbox yet */
export const isDue = (n: QuickNote, now: number): boolean => n.due !== undefined && n.due <= now && n.remindedAt === undefined && n.doneAt === undefined;

/** The reminders that have come due marked delivered at `now`. The list is
 *  the same object when nothing came due, so a caller can skip the write. */
export function remindDue(notes: readonly QuickNote[], now: number): { notes: readonly QuickNote[]; delivered: QuickNote[] } {
  const delivered: QuickNote[] = [];
  const out = notes.map((n) => {
    if (!isDue(n, now)) return n;
    const next = { ...n, remindedAt: now };
    delivered.push(next);
    return next;
  });
  return delivered.length === 0 ? { notes, delivered } : { notes: out, delivered };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "in 5m", "in 1h 30m", "in 2d", "now", "5m ago", "1d ago": a reminder's time against now */
export function dueWord(due: number, now: number): string {
  const diff = due - now;
  const span = (ms: number): string => {
    if (ms >= DAY) return `${Math.floor(ms / DAY)}d`;
    if (ms >= HOUR) {
      const h = Math.floor(ms / HOUR);
      const m = Math.floor((ms % HOUR) / MIN);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return `${Math.max(1, Math.round(ms / MIN))}m`;
  };
  if (diff >= 0) return `in ${span(diff)}`;
  if (-diff < MIN) return "now";
  return `${span(-diff)} ago`;
}
