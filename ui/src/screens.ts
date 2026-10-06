/**
 * Sizes kept per kind of screen and per kind of window. A browser that
 * moves between a laptop's own screen and a 7680px monitor, or a page
 * opened on a phone and on a tablet, wants a different panel width, shell
 * height and font on each; a section popped out into a small window of its
 * own wants a different zoom from the same section in the main window. So
 * every dragged or zoomed size is stored under the slot it was set in as
 * well as flat. Reading goes down a chain of slots, the closest first: this
 * window kind on this screen, then this screen (an ultra HD screen then the
 * wide screens' slot, which it was before it had one), then the flat copy,
 * the last size set anywhere. Pure but for `screenNow` and `windowNow`,
 * tested in screens.test.ts.
 *
 * Storage is this browser's own, so every slot is already per device.
 */

import { parseRoute } from "./routes";

export type ScreenClass = "phone" | "pad" | "laptop" | "desktop" | "wide" | "ultra";

/** each class and the longest side, in CSS px, it runs up to */
export const SCREEN_CLASSES: readonly { cls: ScreenClass; upTo: number; word: string }[] = [
  { cls: "phone", upTo: 1000, word: "phone" },
  { cls: "pad", upTo: 1400, word: "tablet" },
  { cls: "laptop", upTo: 2000, word: "laptop" },
  { cls: "desktop", upTo: 3200, word: "desktop" },
  { cls: "wide", upTo: 3800, word: "wide screen" },
  { cls: "ultra", upTo: Infinity, word: "ultra HD screen" },
];

/** The class of a screen `w` by `h` CSS px, by its longer side, so a phone
 *  or a tablet turned on its side keeps its sizes. */
export function screenClass(w: number, h: number): ScreenClass {
  const long = Math.max(w, h);
  return SCREEN_CLASSES.find((c) => long < c.upTo)?.cls ?? "ultra";
}

export const screenWord = (cls: ScreenClass): string => SCREEN_CLASSES.find((c) => c.cls === cls)?.word ?? cls;

/** a class's slot read when it has none of its own: ultra screens counted
 *  as wide ones before they were a class */
const FALLS_TO: Partial<Record<ScreenClass, ScreenClass>> = { ultra: "wide" };

export interface Screen {
  cls: ScreenClass;
  w: number;
  h: number;
}

/** the screen this page is on now; null where there is none (under test) */
export function screenNow(): Screen | null {
  if (typeof window === "undefined" || typeof window.screen === "undefined") return null;
  const { width: w, height: h } = window.screen;
  if (!(w > 0 && h > 0)) return null;
  return { cls: screenClass(w, h), w, h };
}

/** What a window is for, which is its layout: the whole grove, one repo's
 *  panel, one section of it, or one shell. */
export type WindowKind = "main" | "solo" | "section" | "shell";

const WINDOW_WORD: Record<WindowKind, string> = {
  main: "main window",
  solo: "repo window",
  section: "section window",
  shell: "shell window",
};

export const windowWord = (kind: WindowKind): string => WINDOW_WORD[kind];

/** the kind of window a route (routes.ts) makes */
export function windowKindOf(route: { solo: boolean; shell: boolean; section: string | null }): WindowKind {
  if (route.section !== null) return "section";
  if (route.shell) return "shell";
  if (route.solo) return "solo";
  return "main";
}

/** The slots a window reads, the closest first. The main window's own slot
 *  is the screen's, so slots written before window kinds keep working; any
 *  other window has one of its own in front of it. */
export function screenSlots(cls: ScreenClass | null, kind: WindowKind): string[] {
  if (!cls) return [];
  const out: string[] = kind === "main" ? [] : [`${cls}.${kind}`];
  out.push(cls);
  const under = FALLS_TO[cls];
  if (under) out.push(under);
  return out;
}

/** the kind of window this page is; the main window where there is none */
export function windowNow(): WindowKind {
  if (typeof window === "undefined" || typeof window.location === "undefined") return "main";
  return windowKindOf(parseRoute(window.location.search));
}

/** the slots this page reads and writes, as it stands now */
export const slotsNow = (): string[] => screenSlots(screenNow()?.cls ?? null, windowNow());

/** whether this page writes its sizes to the flat copy as well as its
 *  slot: the main window does, a pop-out keeps them to its own slot */
export const writesFlat = (): boolean => windowNow() === "main";

/** where what this window sets is kept, in words: "laptop, section window" */
export function keptForNow(): string | null {
  const screen = screenNow();
  return screen ? `${screenWord(screen.cls)}, ${windowWord(windowNow())}` : null;
}

type Stored = Record<string, unknown>;

const isRecord = (v: unknown): v is Stored => !!v && typeof v === "object" && !Array.isArray(v);

/** the slot a stored object keeps under `key`, empty when it has none */
function slotOf(stored: Stored, key: string): Stored {
  const screens = stored.screens;
  const slot = isRecord(screens) ? screens[key] : undefined;
  return isRecord(slot) ? slot : {};
}

/** `saved` with the sizes kept in `slots` laid over its flat ones, the
 *  first slot that has a key winning; only `keys` are taken from a slot,
 *  so a hand-edited slot cannot reach anything else. Unchanged with no
 *  slots. */
export function withScreen<T extends Stored>(saved: T, slots: readonly string[], keys: readonly string[]): T {
  if (slots.length === 0) return saved;
  const over: Stored = {};
  for (const slot of [...slots].reverse()) {
    const kept = slotOf(saved, slot);
    for (const k of keys) if (k in kept) over[k] = kept[k];
  }
  return { ...saved, ...over };
}

/** What to store: `stored` with `patch` written flat, and the part of it
 *  under `keys` written into `slot` too. With `flat` false (a pop-out
 *  window) that part goes into the slot alone, so what a pop-out sizes
 *  never reaches the main window, nor a screen that falls back to the flat
 *  copy. Every other slot stays as it was. Without a slot everything goes
 *  flat. */
export function putScreen(stored: Stored, patch: Stored, slot: string | null, keys: readonly string[], flat = true): Stored {
  const out: Stored = { ...stored };
  for (const [k, v] of Object.entries(patch)) if (flat || !slot || !keys.includes(k)) out[k] = v;
  if (!slot) return out;
  const sized: Stored = {};
  for (const k of keys) if (k in patch) sized[k] = patch[k];
  if (Object.keys(sized).length === 0) return out;
  const screens = isRecord(stored.screens) ? stored.screens : {};
  out.screens = { ...screens, [slot]: { ...slotOf(stored, slot), ...sized } };
  return out;
}
