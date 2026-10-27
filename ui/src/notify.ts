import type { Run, RunStatus } from "../../src/core/types";
import type { InboxItem } from "./inbox";
import type { FailedRow, TurnRow } from "./waiting";

/** One system notification: `key` is also its tag, so a second one for the
 *  same thing replaces the first instead of stacking. */
export interface Note {
  key: string;
  title: string;
  body: string;
  /** the repo whose panel a click opens, when there is one */
  repoId: string | null;
  groupId?: string;
}

/** What the page last saw: everything waiting on the human by key, and
 *  each run's status, so a run that finished is told from one that was
 *  already done. */
export interface Snapshot {
  waiting: Record<string, Note>;
  runs: Record<string, { status: RunStatus; note: Note }>;
}

export interface SnapshotInput {
  turns: readonly TurnRow[];
  inbox: readonly InboxItem[];
  failed: readonly FailedRow[];
  runs: readonly Run[];
}

/** One line at most, short enough for a notification's body. */
const line = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 159)}…` : one;
};

/** The waiting keys are namespaced by list, since an inbox item and a turn
 *  row can share an id (a run on a prompt, then the same run's turn). A
 *  failed run's key is its failed row's, which `transitions` relies on. */
export function snapshot(input: SnapshotInput, nameOf: (repoId: string) => string): Snapshot {
  const waiting: Record<string, Note> = {};
  const named = (id: string | null, fallback: string) => (id ? nameOf(id) || fallback : fallback);
  for (const i of input.inbox) {
    const key = `inbox:${i.key}`;
    waiting[key] = { key, title: `Waiting on you · ${i.repo || i.who || "canopy"}`, body: line(i.title), repoId: i.repoId, ...(i.source === "group" ? { groupId: i.id } : {}) };
  }
  for (const t of input.turns) {
    const key = `turn:${t.kind}:${t.id}`;
    const who = t.kind !== "agent" ? named(t.repoId, "a chat") : t.name || named(t.repoId, "an agent");
    waiting[key] = { key, title: `Your turn · ${who}`, body: line(t.what) || "waiting for you", repoId: t.repoId || null, ...(t.kind === "group" ? { groupId: t.id } : {}) };
  }
  for (const f of input.failed) {
    const key = `failed:${f.kind}:${f.id}`;
    const who = f.kind === "ranger" || f.kind === "health" ? f.name : named(f.repoId, f.kind);
    waiting[key] = { key, title: `Failed · ${who}`, body: line(f.what), repoId: f.repoId || null };
  }
  const runs: Snapshot["runs"] = {};
  for (const r of input.runs) {
    const key = `done:${r.id}`;
    runs[r.id] = { status: r.status, note: { key, title: `Done · ${named(r.repoId, "a run")}`, body: line(r.action), repoId: r.repoId || null } };
  }
  return { waiting, runs };
}

/** What changed for the worse or the finished between two snapshots: every
 *  waiting item that was not there before, and every run that went from
 *  working to done. A run that failed is already a new failed row, and a
 *  chat that finished its turn a new turn row, so neither is told twice. */
export function transitions(prev: Snapshot, next: Snapshot): Note[] {
  const out: Note[] = [];
  for (const [key, note] of Object.entries(next.waiting)) if (!(key in prev.waiting)) out.push(note);
  for (const [id, r] of Object.entries(next.runs)) {
    if (r.status === "done" && prev.runs[id]?.status === "working") out.push(r.note);
  }
  return out;
}

/** How long after the page loads, or any backend connects, drops or comes
 *  back, a change only re-seeds the snapshot. Those land as a run of
 *  wholesale reads (runs, asks, the registry, sprouts), each its own state
 *  change, and none of what they bring is news. */
export const QUIET = 10_000;

/** The notifier's own state between store changes. `conns` is a signature
 *  of the page's load and every backend's connection state. */
export interface Watch {
  snap: Snapshot;
  conns: string;
  quietUntil: number;
}

/** The burst guard: the first state, and any state whose connection
 *  signature differs from the last (a backend connecting, a stream that
 *  dropped and resynced), seed the snapshot and open a quiet window; inside
 *  it the snapshot follows along and nothing fires. Only after it do
 *  incremental changes turn into notes. */
export function watch(prev: Watch | null, snap: Snapshot, conns: string, now: number): { watch: Watch; notes: Note[] } {
  if (!prev || prev.conns !== conns) return { watch: { snap, conns, quietUntil: now + QUIET }, notes: [] };
  const next = { ...prev, snap };
  if (now < prev.quietUntil) return { watch: next, notes: [] };
  return { watch: next, notes: transitions(prev.snap, snap) };
}

/** a page title with how many things wait on the human in front */
export const titled = (base: string, n: number): string => (n > 0 ? `(${n}) ${base}` : base);
