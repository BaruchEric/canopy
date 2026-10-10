import type { KeptShell } from "../../src/core/types";

/** The kept shells newest first, whichever backend each is on, so the
 *  shells a machine just lost sit above the week-old ones. */
export function newestFirst(kept: readonly KeptShell[]): KeptShell[] {
  return [...kept].sort((a, b) => b.savedAt - a.savedAt);
}

/** Each backend that holds a kept shell, with its count, in the order the
 *  shells first name it. */
export function keptByBackend(kept: readonly KeptShell[], owner: (id: string) => string): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const k of kept) {
    const b = owner(k.id);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

/** The picked shells still on offer, in the list's order: a shell restored,
 *  forgotten or ended elsewhere drops out of the pick. Kept and running
 *  shells both pick this way. */
export function stillPicked<T extends { id: string }>(list: readonly T[], picked: ReadonlySet<string>): T[] {
  return list.filter((k) => picked.has(k.id));
}

/** The running shells no device has a socket on: the ones most likely left
 *  behind, and the quick pick for ending them. */
export function unwatched<T extends { viewers: readonly string[] }>(list: readonly T[]): T[] {
  return list.filter((t) => t.viewers.length === 0);
}

/** One restore per picked shell. `resume` types the agent's continue only
 *  into a shell that had an agent; the rest restore plain. */
export function restorePlan(picked: readonly KeptShell[], resume: boolean): { id: string; resume: boolean }[] {
  return picked.map((k) => ({ id: k.id, resume: resume && k.agent !== null }));
}

/** Runs `act` on every id in turn, one at a time, and says how many failed
 *  and the first reason, or null when none did. */
export async function eachOf(ids: readonly string[], act: (id: string) => Promise<void>): Promise<string | null> {
  let failed = 0;
  let first = "";
  for (const id of ids) {
    try {
      await act(id);
    } catch (e) {
      failed += 1;
      if (!first) first = e instanceof Error ? e.message : String(e);
    }
  }
  if (failed === 0) return null;
  return ids.length === 1 ? first : `${failed} of ${ids.length} failed: ${first}`;
}
