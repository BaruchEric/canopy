/** The landing queue's model, pure and browser-safe: entries, the states
 *  they move through, and the words a list shows for them. The server's
 *  loop (`server/landing.ts`) does the git and the gates and feeds each
 *  outcome back through `advance`.
 *
 *  One queue per repo. For each entry in order: rebase onto the main
 *  checkout's HEAD, run `setup` when the rebase changed a lockfile, run the
 *  gates one at a time, then fast-forward main. A conflict, a red gate, or
 *  main moving under it three times sends the entry back to its run. */

import type { LandEntry, LandingRun, LandState } from "./types";

/** how many times main may move under one entry before it is sent back */
export const MAX_TRIES = 3;
/** the characters of a red gate's output an entry keeps */
export const TAIL_CHARS = 4000;
/** landed entries kept for the list, per repo */
export const KEEP_LANDED = 10;

export const SENT_BACK: ReadonlySet<LandState> = new Set(["conflict", "red", "moved"]);
/** the states the loop is working an entry through */
export const WORKING: ReadonlySet<LandState> = new Set(["rebasing", "setup", "gate", "landing"]);

/** In the queue: waiting its turn, being worked, or holding its place. */
export const inQueue = (e: Pick<LandEntry, "state">): boolean => e.state === "queued" || e.state === "waiting" || WORKING.has(e.state);
export const sentBack = (e: Pick<LandEntry, "state">): boolean => SENT_BACK.has(e.state);

export type LandEvent =
  | { t: "begin" }
  | { t: "conflict"; files: string[] }
  /** rebased; `setup` when the lockfile changed and the repo has a setup line */
  | { t: "rebased"; setup: boolean; first: string | null; noGates: boolean }
  | { t: "set-up"; first: string | null }
  | { t: "red"; gate: string; output: string }
  | { t: "gate-ok"; next: string | null }
  | { t: "moved" }
  | { t: "busy"; files: string[] }
  | { t: "hold"; why: string }
  | { t: "landed"; head: string };

/** The last `TAIL_CHARS` characters of a gate's output. */
export const tail = (output: string): string => (output.length > TAIL_CHARS ? output.slice(-TAIL_CHARS) : output);

/** One entry's next state after an outcome. Fields that belonged to the
 *  last state (gate, reason, files) are dropped unless the event sets them. */
export function advance(e: LandEntry, ev: LandEvent, now: number): LandEntry {
  const { gate: _g, reason: _r, files: _f, ...base } = e;
  const next = (state: LandState, extra: Partial<LandEntry> = {}): LandEntry => ({ ...base, state, updatedAt: now, ...extra });
  switch (ev.t) {
    case "begin":
      return next("rebasing");
    case "conflict":
      return next("conflict", { reason: `conflicts with ${e.target} in ${ev.files.join(", ")}`, files: ev.files });
    case "rebased": {
      const flag = ev.noGates ? { noGates: true as const } : {};
      if (ev.setup) return next("setup", flag);
      return ev.first ? next("gate", { ...flag, gate: ev.first }) : next("landing", flag);
    }
    case "set-up":
      return ev.first ? next("gate", { gate: ev.first }) : next("landing");
    case "red":
      return next("red", { gate: ev.gate, reason: tail(ev.output) });
    case "gate-ok":
      return ev.next ? next("gate", { gate: ev.next }) : next("landing");
    case "moved": {
      const tries = e.tries + 1;
      return tries >= MAX_TRIES
        ? next("moved", { tries, reason: `${e.target} kept moving while the gates ran (${tries} times)` })
        : next("rebasing", { tries });
    }
    case "busy":
      return next("waiting", { reason: `main checkout busy: ${ev.files.join(", ")}`, files: ev.files });
    case "hold":
      return next("waiting", { reason: ev.why });
    case "landed":
      return next("landed", { head: ev.head, landedAt: now });
  }
}

/** A new entry for a branch run, at the end of its repo's queue. */
export function entryFor(run: LandingRun, now: number): LandEntry {
  return {
    id: run.id,
    repoId: run.repoId,
    repoPath: run.repoPath,
    branch: run.branch,
    target: run.target,
    dir: run.dir,
    note: run.note,
    state: "queued",
    tries: 0,
    queuedAt: now,
    updatedAt: now,
  };
}

export class LandError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** Puts a ready run at the end of the queue: a new entry, or one that was
 *  sent back rejoining. Refused while it is already queued or landed. */
export function enqueue(entries: readonly LandEntry[], run: LandingRun, now: number): LandEntry[] {
  if (run.state !== "ready") throw new LandError(`only a ready run lands; this one is ${run.state}`);
  const had = entries.find((e) => e.id === run.id);
  if (had && inQueue(had)) throw new LandError("it is in the queue already");
  if (had?.state === "landed") throw new LandError("it has landed already");
  return [...entries.filter((e) => e.id !== run.id), entryFor(run, now)];
}

/** The entry the loop takes next in one repo: the first queued one in
 *  order. Waiting entries keep their place but are passed over. */
export function nextEntry(entries: readonly LandEntry[], repoId: string): LandEntry | undefined {
  return byOrder(entries.filter((e) => e.repoId === repoId && e.state === "queued"))[0];
}

/** Waiting entries go back to queued at their old place, for another look. */
export const retryWaiting = (entries: readonly LandEntry[], repoId: string, now: number): LandEntry[] =>
  entries.map((e) => (e.repoId === repoId && e.state === "waiting" ? { ...stripReason(e), state: "queued" as const, updatedAt: now } : e));

/** Every queued entry in a repo holds with the same reason: the checkout
 *  is not on the branch they land on, or the gates file is broken. */
export const holdAll = (entries: readonly LandEntry[], repoId: string, why: string, now: number): LandEntry[] =>
  entries.map((e) => (e.repoId === repoId && e.state === "queued" ? advance(e, { t: "hold", why }, now) : e));

/** Entries a restart cut off mid-turn start their turn again. */
export const restartWorking = (entries: readonly LandEntry[], now: number): LandEntry[] =>
  entries.map((e) => (WORKING.has(e.state) ? { ...stripReason(e), state: "queued" as const, updatedAt: now } : e));

/** Landed entries past the newest `KEEP_LANDED` per repo are dropped. */
export function pruneLanded(entries: readonly LandEntry[]): LandEntry[] {
  const keep = new Set<string>();
  const byRepo = new Map<string, LandEntry[]>();
  for (const e of entries) if (e.state === "landed") byRepo.set(e.repoId, [...(byRepo.get(e.repoId) ?? []), e]);
  for (const list of byRepo.values()) {
    for (const e of list.sort((a, b) => (b.landedAt ?? 0) - (a.landedAt ?? 0)).slice(0, KEEP_LANDED)) keep.add(e.id);
  }
  return entries.filter((e) => e.state !== "landed" || keep.has(e.id));
}

const stripReason = (e: LandEntry): LandEntry => {
  const { reason: _r, files: _f, gate: _g, ...rest } = e;
  return rest;
};

const byOrder = <T extends Pick<LandEntry, "queuedAt" | "id">>(list: T[]): T[] =>
  [...list].sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));

/** A repo's queue in order: the entries in it, not the sent back or landed. */
export const queueOf = (entries: readonly LandEntry[], repoId: string): LandEntry[] =>
  byOrder(entries.filter((e) => e.repoId === repoId && inQueue(e)));

const ORDINAL = ["1st", "2nd", "3rd"];
const ordinal = (n: number): string => ORDINAL[n - 1] ?? `${n}th`;

/** An entry's state in a few words: "queued 2nd", "gate: test", "landed". */
export function landWord(e: LandEntry, entries: readonly LandEntry[]): string {
  switch (e.state) {
    case "queued": {
      const pos = queueOf(entries, e.repoId).findIndex((x) => x.id === e.id) + 1;
      return pos > 0 ? `queued ${ordinal(pos)}` : "queued";
    }
    case "gate":
      return `gate: ${e.gate ?? "?"}`;
    case "setup":
      return "setting up";
    case "landing":
      return "landing";
    case "red":
      return `red: ${e.gate ?? "gate"}`;
    case "moved":
      return "main kept moving";
    default:
      return e.state;
  }
}

/** How many entries a repo has in its queue and sent back, for the card chip. */
export function landCounts(entries: readonly LandEntry[], repoId: string): { queued: number; back: number } {
  let queued = 0;
  let back = 0;
  for (const e of entries) {
    if (e.repoId !== repoId) continue;
    if (inQueue(e)) queued++;
    else if (sentBack(e)) back++;
  }
  return { queued, back };
}

/** The message a "fix it" run starts with: the reason the entry came back. */
export function fixPrompt(e: LandEntry): string {
  const head = `canopy's landing queue sent this branch (${e.branch}) back`;
  switch (e.state) {
    case "conflict":
      return `${head}: rebasing it onto ${e.target} conflicts in ${(e.files ?? []).join(", ")}. Rebase it onto ${e.target} yourself, resolve the conflicts, run the checks, and commit. Do not push.`;
    case "red":
      return `${head}: the ${e.gate ?? ""} gate failed after a rebase onto ${e.target}. The end of its output:\n\n${e.reason ?? ""}\n\nRebase onto ${e.target}, fix what failed, run that gate again, and commit. Do not push.`;
    case "moved":
      return `${head}: ${e.target} kept moving while its gates ran. Rebase it onto ${e.target}, run the checks, and commit. Do not push.`;
    default:
      return `${head}. Look at why, fix it, and commit. Do not push.`;
  }
}
