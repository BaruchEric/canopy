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

/** The channel as the main window's listener uses it: a BroadcastChannel,
 *  or a stand-in in the tests. */
export interface PaneLine {
  /** hands every message's data to `hear` */
  listen(hear: (data: unknown) => void): void;
  postMessage(msg: PaneMsg): void;
  close(): void;
}

/** What the listener does to the dock: the store's actions. */
export interface PaneDock {
  popped(): Record<string, number>;
  heardHello(id: string): void;
  returnPanel(id: string): void;
  forgetPopped(id: string): void;
}

/** Pop out and back, the main window's side. A pop-out's hello takes its
 *  panel out of the dock, unless the user docked it again by hand
 *  (heardHello); its "back to the dock" puts the panel back at its slot,
 *  and so does its bye after `waits.bye`, since a reloading pop-out says
 *  bye and then hello again; its close forgets the slot. "who" is a loading
 *  main window's question for the pop-outs, so this window lets another's
 *  pass. Starting, it asks who is out there and after `waits.who` takes
 *  back every popped panel no window answered for. Returns what stops it. */
export function listenPanes(ch: PaneLine, dock: PaneDock, waits = { bye: BYE_WAIT_MS, who: WHO_WAIT_MS }): () => void {
  const claimed = new Set<string>();
  const byes = new Map<string, ReturnType<typeof setTimeout>>();
  ch.listen((data) => {
    const m = parsePaneMsg(data);
    if (!m || m.type === "who") return;
    clearTimeout(byes.get(m.id));
    byes.delete(m.id);
    if (m.type === "hello") {
      claimed.add(m.id);
      dock.heardHello(m.id);
      return;
    }
    claimed.delete(m.id);
    if (m.type === "return") dock.returnPanel(m.id);
    else if (m.type === "close") dock.forgetPopped(m.id);
    else {
      const back = () => {
        byes.delete(m.id);
        dock.returnPanel(m.id);
      };
      byes.set(m.id, setTimeout(back, waits.bye));
    }
  });
  // only the panels out when this window loaded: one it pops out itself
  // in the meantime has a window that is still saying hello
  const out = new Set(Object.keys(dock.popped()));
  ch.postMessage({ type: "who" });
  const who = setTimeout(() => {
    for (const id of unclaimed(dock.popped(), claimed)) {
      if (out.has(id)) dock.returnPanel(id);
    }
  }, waits.who);
  return () => {
    clearTimeout(who);
    for (const t of byes.values()) clearTimeout(t);
    ch.close();
  };
}

/** Says one thing on the channel from a window that does not stay to
 *  listen: a pop-out's "back to the dock" or its close. */
export function tellPanes(msg: PaneMsg) {
  if (typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(PANES_CHANNEL);
  ch.postMessage(msg);
  ch.close();
}
