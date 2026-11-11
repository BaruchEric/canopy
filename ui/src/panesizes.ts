/**
 * The sizes set at a pane's seam (FR-063). The page's big seams each have a
 * field of their own in the layout: the tree, the cards, a dock column, a
 * shell's height. Every other edge between two parts is one of these: a
 * name and the bounds of what a drag may set. Nothing is stored until a
 * drag sets it, so the stylesheet's own size stands until then, in ems or
 * as a share, and follows the screen class and the zoom. A set size is CSS
 * px, written to `--pane-<name>` on the part whose rules read it
 * (PaneSeam.tsx), and kept per kind of screen with the rest of the layout.
 * Pure; tested in panesizes.test.ts.
 */

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export const PANES = {
  /** a wide panel's summary column, beside its sections */
  lede: { min: 180, max: 960 },
  /** the files section's list, beside the file it shows */
  "finder-list": { min: 160, max: 1600 },
  /** the same list over the file, in a panel too narrow for both abreast */
  "finder-rows": { min: 72, max: 1600 },
  /** the sessions view's column of machines and agents */
  "sessions-side": { min: 200, max: 800 },
  /** the agents list under the machines in that column */
  "sessions-agents": { min: 72, max: 1600 },
  /** the agents board's rail, beside the agent in focus */
  "board-rail": { min: 200, max: 1200 },
  /** the list of sections down the left of Settings */
  "prefs-rail": { min: 140, max: 480 },
  /** the clipboard's list, beside the clip it shows */
  "clips-list": { min: 180, max: 1200 },
} as const satisfies Record<string, { min: number; max: number }>;

export type PaneKey = keyof typeof PANES;
/** the sizes set so far; a pane with no entry keeps the stylesheet's */
export type PaneSizes = Partial<Record<PaneKey, number>>;

export const isPane = (k: string): k is PaneKey => Object.hasOwn(PANES, k);

/** the custom property a pane's rules read its size from */
export const paneVar = (key: PaneKey): string => `--pane-${key}`;

/** Saved sizes, keeping the names known here and each size in its bounds.
 *  A name from a later build, or a size that is no number, is left out. */
export function paneSizesOf(saved: unknown): PaneSizes {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const out: PaneSizes = {};
  for (const [k, v] of Object.entries(saved)) {
    if (isPane(k) && typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(clamp(v, PANES[k].min, PANES[k].max));
  }
  return out;
}

/** `sizes` with `key` set to `px`, rounded and held in its bounds, or with
 *  no entry for null, which hands the pane back to the stylesheet. The same
 *  object when nothing changes, so a drag let go where it was saves nothing. */
export function withPane(sizes: PaneSizes, key: PaneKey, px: number | null): PaneSizes {
  if (px === null || !Number.isFinite(px)) {
    if (!(key in sizes)) return sizes;
    const { [key]: _, ...rest } = sizes;
    return rest;
  }
  const next = Math.round(clamp(px, PANES[key].min, PANES[key].max));
  return sizes[key] === next ? sizes : { ...sizes, [key]: next };
}

/** The most a pane may take in `room`, the px its container has left for
 *  it: never under the pane's own floor, which a container too small for
 *  both parts keeps. */
export function paneTop(key: PaneKey, room: number): number {
  const { min, max } = PANES[key];
  return Number.isFinite(room) ? clamp(Math.floor(room), min, max) : max;
}

/** What a pane shows for a size set at its seam: the size, held to what
 *  fits now. The setting itself is kept, and holds again once there is
 *  room for it. */
export function paneShown(key: PaneKey, chosen: number, room: number): number {
  return clamp(Math.round(chosen), PANES[key].min, paneTop(key, room));
}

/** What a drag or a key at a seam leaves set: `px` rounded and held between
 *  the pane's floor and what fits now. A drag let go where it started
 *  (`start`, the size it began at; null for a key) changes nothing, so a
 *  click on a seam never pins a size the stylesheet was choosing. */
export function paneChosen(key: PaneKey, px: number, { start, room, chosen }: { start: number | null; room: number; chosen: number | null }): number | null {
  if (start !== null && Math.round(px) === Math.round(start)) return chosen;
  return paneShown(key, px, room);
}
