/** Pop out and back: the main window and a panel's own window talk on one
 *  BroadcastChannel. A pop-out says hello when it shows a panel and bye
 *  when it goes; "return" asks the dock to take it back; "close" asks the
 *  dock to forget it (the panel's own close, in its window); "who" asks
 *  every pop-out to say hello again (a main window just loaded). Messages
 *  come from any same-origin page, so each one is checked. */

export const PANES_CHANNEL = "canopy:panes";
/** how long a loading main window waits for pop-outs to answer "who" */
export const WHO_WAIT_MS = 1500;
/** how long the dock waits on a bye before taking the panel back, so a
 *  reloading pop-out's hello can call it off */
export const BYE_WAIT_MS = 300;

export type PaneMsg =
  | { type: "hello"; id: string }
  | { type: "bye"; id: string }
  | { type: "return"; id: string }
  | { type: "close"; id: string }
  | { type: "who" };

export function parsePaneMsg(v: unknown): PaneMsg | null {
  if (!v || typeof v !== "object") return null;
  const type = "type" in v ? v.type : undefined;
  if (type === "who") return { type };
  const id = "id" in v ? v.id : undefined;
  if (typeof id !== "string" || !id) return null;
  if (type === "hello" || type === "bye" || type === "return" || type === "close") return { type, id };
  return null;
}

export const unclaimed = (popped: Record<string, number>, claimed: ReadonlySet<string>): string[] =>
  Object.keys(popped).filter((id) => !claimed.has(id));

/** the popped slots less `id`'s; the same object when it had none, so
 *  docking a panel that was never out is no change to save */
export const without = (popped: Record<string, number>, id: string): Record<string, number> =>
  Object.hasOwn(popped, id) ? Object.fromEntries(Object.entries(popped).filter(([k]) => k !== id)) : popped;

/** the popped slots a saved layout holds: a plain object of slots, each a
 *  whole number from 0. Anything else (an array, whose indexes would read
 *  as panels "0" and "1", or a slot that is not a finite number) is
 *  dropped, since the load sweep would bring each key back as a panel. */
export function poppedOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [id, slot] of Object.entries(v)) {
    if (typeof slot === "number" && Number.isFinite(slot)) out[id] = Math.max(0, Math.floor(slot));
  }
  return out;
}

/** Says one thing on the channel from a window that does not stay to
 *  listen: a pop-out's "back to the dock" or its close. */
export function tellPanes(msg: PaneMsg) {
  if (typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(PANES_CHANNEL);
  ch.postMessage(msg);
  ch.close();
}
