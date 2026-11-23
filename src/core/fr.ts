/**
 * Feature numbers (FR-076). A repo's feature list is its FEATURES.md, where
 * every entry is `### FR-NNN · Title` and a number is never used twice. The
 * old rule for a new one was "the highest in the file plus one", which
 * breaks as soon as two sessions work in two worktrees: each reads its own
 * copy, and on 2026-11-22 three of them took FR-073 the same afternoon.
 *
 * So a number is reserved before it is written anywhere. A reservation is a
 * git ref, `refs/canopy/fr/NNN`, on a commit with no files whose message
 * says what the number is for. git makes a ref only when none is there, so
 * two sessions in one repo cannot both get it, whichever worktree they sit
 * in, and a push that would replace a ref is refused, so two machines
 * cannot either.
 *
 * This file is the pure half: the names, how a list reads, the next number,
 * and a reservation's words. The git half is cli/fr.ts. Tested in
 * fr.test.ts.
 */

/** the list, at a repo's root */
export const FR_FILE = "FEATURES.md";

/** where reservations live in a repo's refs, one ref per number */
export const FR_REFS = "refs/canopy/fr";

/** a number as git and the list write it: three digits, more when it needs them */
const padded = (n: number): string => String(n).padStart(3, "0");

/** `FR-076` */
export const frId = (n: number): string => `FR-${padded(n)}`;

/** `refs/canopy/fr/076` */
export const frRef = (n: number): string => `${FR_REFS}/${padded(n)}`;

/** The number a reservation's ref holds, or null for a ref that is not one. */
export function frOfRef(ref: string): number | null {
  const m = /^refs\/canopy\/fr\/(\d{1,6})$/.exec(ref);
  return m?.[1] ? Number(m[1]) : null;
}

/** The numbers a list gives entries to, in the file's order: one per
 *  `### FR-NNN` heading. A number that is only mentioned is not here. */
export function frEntries(text: string): number[] {
  return [...text.matchAll(/^###[ \t]+FR-(\d{1,6})\b/gm)].map((m) => Number(m[1]));
}

/** The numbers two entries share, lowest first. */
export function frDuplicates(text: string): number[] {
  const seen = new Set<number>();
  const twice = new Set<number>();
  for (const n of frEntries(text)) (seen.has(n) ? twice : seen).add(n);
  return [...twice].sort((a, b) => a - b);
}

/** The highest number a text names anywhere, a heading or not, since a
 *  number quoted in an entry's body is taken too. 0 when it names none. */
export function frHighest(text: string): number {
  let top = 0;
  for (const m of text.matchAll(/\bFR-(\d{1,6})\b/g)) top = Math.max(top, Number(m[1]));
  return top;
}

/** The next free number: one past the highest that any copy of the list
 *  names or any reservation holds. */
export function frNext(texts: readonly string[], reserved: readonly number[]): number {
  return Math.max(0, ...texts.map(frHighest), ...reserved) + 1;
}

/** Who holds a reservation and what for. */
export interface FrHolder {
  /** what the number is for, as the session said it; may be empty */
  title: string;
  /** the session's handle, such as `claude-f0351f` or a person's name */
  by: string;
  /** the branch it was reserved on */
  branch: string;
  /** canopy's name for the backend it was reserved on, when it ran on one */
  backend: string;
}

/** one line: no line break may cut a field short */
const oneLine = (v: string, max: number): string => v.replace(/\s+/g, " ").trim().slice(0, max);

/** A reservation's commit message: the id and the title, then who holds
 *  it. `nonce` is any text no other reservation has: two sessions that
 *  reserve the same number in the same second with the same words would
 *  otherwise write the same commit, and origin would take both pushes. */
export function frMessage(n: number, holder: FrHolder, nonce: string): string {
  const title = oneLine(holder.title, 200);
  return [`${frId(n)}${title ? ` ${title}` : ""}`, "", `by: ${oneLine(holder.by, 80)}`, `branch: ${oneLine(holder.branch, 200)}`, `backend: ${oneLine(holder.backend, 80)}`, `nonce: ${oneLine(nonce, 80)}`, ""].join("\n");
}

/** What a reservation's commit message says. A message canopy did not
 *  write reads as empty fields. */
export function parseFrMessage(message: string): FrHolder {
  const [first = "", ...rest] = message.split("\n");
  const field = (name: string): string => rest.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? "";
  return { title: first.replace(/^FR-\d+\s*/, "").trim(), by: field("by"), branch: field("branch"), backend: field("backend") };
}

export type FrWhere = "shared" | "here" | "clash";

/** One reservation as `canopy fr` lists it. */
export interface FrReservation {
  n: number;
  id: string;
  holder: FrHolder;
  /** when it was made, unix ms */
  at: number;
  /** `shared`: origin holds the same ref. `here`: only this machine knows,
   *  since it was made while origin did not answer or the repo has none.
   *  `clash`: origin gave the number to another session while this one was
   *  made offline, so this one must take a new number. */
  where: FrWhere;
  /** the default branch's list has an entry with this number, so the
   *  reservation has done its job */
  listed: boolean;
}

/** One reservation in a line. */
export function frLine(r: FrReservation, ago: (ms: number) => string): string {
  const who = [r.holder.by, r.holder.branch && `on ${r.holder.branch}`, r.holder.backend && `(${r.holder.backend})`].filter(Boolean).join(" ");
  const where = r.where === "here" ? "this machine only" : r.where === "clash" ? "origin gave this number to another session: take a new one" : "";
  const state = [r.listed ? "in the list" : "", where].filter(Boolean).join(", ");
  return `${r.id}  ${r.holder.title || "(no title)"}${who ? `  · ${who}` : ""}  · ${ago(r.at)}${state ? `  · ${state}` : ""}`;
}
