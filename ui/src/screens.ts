/**
 * Sizes kept per kind of screen. A browser that moves between a laptop's
 * own screen and a 7680px monitor, or a page opened on a phone and on a
 * tablet, wants a different panel width, shell height and font on each, so
 * every dragged or zoomed size is stored under the screen it was set on as
 * well as flat. A screen that has never been sized starts from the flat
 * copy, the last size set anywhere. Pure but for `screenNow`, tested in
 * screens.test.ts.
 */

export type ScreenClass = "phone" | "pad" | "laptop" | "desktop" | "wide";

/** each class and the longest side, in CSS px, it runs up to */
export const SCREEN_CLASSES: readonly { cls: ScreenClass; upTo: number; word: string }[] = [
  { cls: "phone", upTo: 1000, word: "phone" },
  { cls: "pad", upTo: 1400, word: "tablet" },
  { cls: "laptop", upTo: 2000, word: "laptop" },
  { cls: "desktop", upTo: 3200, word: "desktop" },
  { cls: "wide", upTo: Infinity, word: "wide screen" },
];

/** The class of a screen `w` by `h` CSS px, by its longer side, so a phone
 *  or a tablet turned on its side keeps its sizes. */
export function screenClass(w: number, h: number): ScreenClass {
  const long = Math.max(w, h);
  return SCREEN_CLASSES.find((c) => long < c.upTo)?.cls ?? "wide";
}

export const screenWord = (cls: ScreenClass): string => SCREEN_CLASSES.find((c) => c.cls === cls)?.word ?? cls;

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

type Stored = Record<string, unknown>;

const isRecord = (v: unknown): v is Stored => !!v && typeof v === "object" && !Array.isArray(v);

/** the slot a stored object keeps for one class, empty when it has none */
function slotOf(stored: Stored, cls: ScreenClass): Stored {
  const screens = stored.screens;
  const slot = isRecord(screens) ? screens[cls] : undefined;
  return isRecord(slot) ? slot : {};
}

/** `saved` with the sizes kept for `cls` laid over its flat ones; only
 *  `keys` are taken from the slot, so a hand-edited slot cannot reach
 *  anything else. Unchanged without a class. */
export function withScreen<T extends Stored>(saved: T, cls: ScreenClass | null, keys: readonly string[]): T {
  if (!cls) return saved;
  const slot = slotOf(saved, cls);
  const over: Stored = {};
  for (const k of keys) if (k in slot) over[k] = slot[k];
  return { ...saved, ...over };
}

/** What to store: `stored` with `patch` written flat, and the part of it
 *  under `keys` written into the slot for `cls` too. The other classes'
 *  slots stay as they were. */
export function putScreen(stored: Stored, patch: Stored, cls: ScreenClass | null, keys: readonly string[]): Stored {
  const out: Stored = { ...stored, ...patch };
  if (!cls) return out;
  const sized: Stored = {};
  for (const k of keys) if (k in patch) sized[k] = patch[k];
  if (Object.keys(sized).length === 0) return out;
  const screens = isRecord(stored.screens) ? stored.screens : {};
  out.screens = { ...screens, [cls]: { ...slotOf(stored, cls), ...sized } };
  return out;
}
