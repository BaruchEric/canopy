/** A beat per event a backend sends, for the top bar's live light. Kept out
 *  of the store on purpose: a store field bumped on every event would wake
 *  every selector on the page for a light that only toggles a class. */
const listeners = new Set<() => void>();

export function beat(): void {
  for (const fn of listeners) fn();
}

/** Calls `fn` on every beat until the returned function is called. */
export function onBeat(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
