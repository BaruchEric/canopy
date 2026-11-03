/**
 * The page's quiet line: a short word on what a key just did or why it
 * could not ("copied branch: main", "the card has no PR link"), shown at
 * the foot of the window for a moment by components/Said.tsx. `say` keeps
 * the latest word and tells the listeners; the component decides how long
 * it shows. Pure and tested (said.test.ts).
 */

export interface Said {
  /** counts up, so the same words twice show twice */
  id: number;
  text: string;
  /** a failure, drawn in rust */
  bad: boolean;
}

let latest: Said | null = null;
let next = 1;
const listeners = new Set<() => void>();

/** Says `text`; `bad` for a failure. */
export function say(text: string, bad = false): Said {
  latest = { id: next++, text, bad };
  for (const l of listeners) l();
  return latest;
}

/** the latest word, or null before the first */
export const saidNow = (): Said | null => latest;

/** Hears each `say`; for `useSyncExternalStore`. */
export function onSaid(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** how long a word shows, ms */
export const SAID_MS = 2200;
