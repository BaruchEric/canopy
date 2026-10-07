/** Pop out and back: the main window and a panel's own window talk on one
 *  BroadcastChannel. A pop-out says hello when it shows a panel and bye
 *  when it goes; "return" asks the dock to take it back; "who" asks every
 *  pop-out to say hello again (a main window just loaded). Messages come
 *  from any same-origin page, so each one is checked. */

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
  | { type: "who" };

export function parsePaneMsg(v: unknown): PaneMsg | null {
  if (!v || typeof v !== "object") return null;
  const type = "type" in v ? v.type : undefined;
  if (type === "who") return { type };
  const id = "id" in v ? v.id : undefined;
  if (typeof id !== "string" || !id) return null;
  if (type === "hello" || type === "bye" || type === "return") return { type, id };
  return null;
}

export function restorePanel(panels: readonly string[], id: string, slot: number): string[] {
  if (panels.includes(id)) return [...panels];
  const at = Math.max(0, Math.min(panels.length, slot));
  return [...panels.slice(0, at), id, ...panels.slice(at)];
}

export const unclaimed = (popped: Record<string, number>, claimed: ReadonlySet<string>): string[] =>
  Object.keys(popped).filter((id) => !claimed.has(id));

/** the popped slots less `id`'s */
export const without = (popped: Record<string, number>, id: string): Record<string, number> =>
  Object.fromEntries(Object.entries(popped).filter(([k]) => k !== id));

/** Says one thing on the channel from a window that does not stay to
 *  listen: a pop-out's "back to the dock". */
export function tellPanes(msg: PaneMsg) {
  if (typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(PANES_CHANNEL);
  ch.postMessage(msg);
  ch.close();
}
