/** The work item model, carried between runs by the branch name and commit
 *  trailer. Items live under `<configDir>/work/`; this module stays pure and
 *  browser-safe so the page can share its types and helpers. */

import type { LandState, RunBranchState } from "./types";

export const WORK_ID = /^w-[a-z2-7]{8}$/;
export const NOTE_CHARS = 600;
export const NOTES_MAX = 40;
export const TITLE_CHARS = 120;
export const WORK_TRAILER = "Canopy-Work";
export const WORK_STATES = ["open", "working", "review", "landed", "dropped"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export type WorkFrom =
  | { kind: "note" }
  | { kind: "issue"; service: string; key: string; link?: string }
  | { kind: "coordinator"; run: string; card: string }
  | { kind: "trigger"; event: string };

export interface WorkNote {
  at: number;
  /** `canopy` for a hub's line, the caller's label for one from the page or the CLI */
  by: string;
  text: string;
}

export interface WorkItem {
  /** `w-` and 8 lowercase base32 characters, minted by canopy */
  id: string;
  title: string;
  /** repo ids on this backend */
  repos: string[];
  state: WorkState;
  from: WorkFrom;
  /** everything that served it, newest last */
  runs: string[];
  /** `RunBranch.origin` */
  branches: string[];
  prs: { number: number; url: string }[];
  /** `TriggerEvent.id` */
  events: string[];
  /** oldest first */
  notes: WorkNote[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  /** why it was dropped */
  reason?: string;
}

export interface WorkInfo {
  items: WorkItem[];
  /** compacted items (plan 3); 0 until then */
  archived: number;
}

/** what a branch start says about the item it mints */
export interface WorkStart {
  title: string;
  from: WorkFrom;
}

/** what the server knows of an item's runs and branches, for its state */
export interface WorkFacts {
  /** any of its runs is active */
  active: boolean;
  /** each branch a landing record names; a landed or merged one is gone from here, so the hub closes the item first */
  branches: { state: RunBranchState; land?: LandState; pr?: "open" | "merged" | "closed" }[];
}

/** how the other hubs reach the ledger; `WorkHub` implements it */
export interface WorkSink {
  /** a `by: canopy` line */
  note(id: string, text: string): void;
  /** the item's end, with the line that says how */
  close(id: string, state: "landed" | "dropped", text: string): void;
  /** a PR or trigger event that now serves the item; kept once */
  link(id: string, ref: { pr: { number: number; url: string } } | { event: string }): void;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `w-` and 8 base32 characters from 5 random bytes; uses global crypto by default. */
export function mintId(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(5);
  if (bytes.length !== 5) throw new Error("work id entropy must be five bytes");
  let encoded = "";
  for (let i = 0; i < 8; i++) {
    const bit = i * 5;
    const byte = Math.floor(bit / 8);
    const offset = bit % 8;
    const window = ((bytes[byte] ?? 0) << 8) | (bytes[byte + 1] ?? 0);
    encoded += BASE32[(window >>> (11 - offset)) & 31];
  }
  return `w-${encoded}`;
}

export const isWorkId = (v: unknown): v is string => typeof v === "string" && WORK_ID.test(v);

/** A branch name's middle part from the run's note: lower case words joined
 *  by dashes, at most 32 characters, "run" when nothing is left. */
export function branchSlug(note: string): string {
  const s = note
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return s || "run";
}

export const workBranchName = (id: string, note: string): string => `run/${id}-${branchSlug(note)}`;

/** The id a `run/<id>-<slug>` branch carries, else null. */
export function workIdOf(branch: string | null | undefined): string | null {
  const match = /^run\/(w-[a-z2-7]{8})-[a-z0-9-]+$/.exec(branch ?? "");
  return match?.[1] ?? null;
}

/** The note's first non-empty line, whitespace folded and cut to TITLE_CHARS. */
export function titleOf(note: string): string {
  const first = note.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first?.trim().replace(/\s+/g, " ").slice(0, TITLE_CHARS) || "untitled work";
}

/** A short description of where an item came from. */
export function fromWord(from: WorkFrom): string {
  switch (from.kind) {
    case "note":
      return "a note";
    case "issue":
      return `${from.service} issue ${from.key}`;
    case "coordinator":
      return `coordinator ${from.run}, card ${from.card}`;
    case "trigger":
      return `trigger event ${from.event}`;
    default: {
      const exhaustive: never = from;
      return exhaustive;
    }
  }
}

export const trailerLine = (id: string): string => `${WORK_TRAILER}: ${id}`;

/** The id of the last whole `Canopy-Work: <id>` line in a commit message. */
export function trailerOf(message: string): string | null {
  const lines = message.split(/\r?\n/).reverse();
  for (const line of lines) {
    const match = /^Canopy-Work: (w-[a-z2-7]{8})$/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

/** Appends a trimmed note and folds the oldest notes once the limit is crossed. */
export function addNote(notes: readonly WorkNote[], note: WorkNote): WorkNote[] {
  const text = note.text.trim().slice(0, NOTE_CHARS);
  if (!text) return [...notes];
  const appended = [...notes, { ...note, text }];
  if (appended.length <= NOTES_MAX) return appended;

  const foldCount = appended.length - NOTES_MAX + 1;
  const folded = appended.slice(0, foldCount);
  const retained = appended.slice(foldCount);
  const earlier = folded
    .map((item) => item.text.replace(/^earlier: /, "").slice(0, 80))
    .join(" · ");
  const first = folded[0];
  const last = folded.at(-1);
  if (!first || !last) return appended;
  const foldedNote: WorkNote = {
    at: last.at,
    by: "canopy",
    text: `earlier: ${earlier}`.slice(0, NOTE_CHARS),
  };
  return [foldedNote, ...retained];
}

/** Derives the current state from the item's open/closed marker and server facts. */
export function stateOf(item: Pick<WorkItem, "state" | "closedAt">, facts: WorkFacts): WorkState {
  if (item.closedAt !== undefined) return item.state;
  if (facts.branches.some((branch) => branch.land === "landed" || branch.pr === "merged")) return "landed";
  if (facts.active || facts.branches.some((branch) => branch.state === "working")) return "working";
  if (facts.branches.some((branch) => branch.state === "ready" || branch.state === "stopped" || branch.land !== undefined || branch.pr === "open")) return "review";
  return "open";
}
