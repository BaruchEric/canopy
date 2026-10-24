/**
 * Split panes in the sessions view (FR-026): a tab split right or down into
 * panes, each a strip shell of its own, as Orca's terminal tabs do. A group
 * is a tree of two or more panes; a tab in no group is a pane alone. The
 * groups are a per-browser setting (`sessionSplits`), kept by tab id, so a
 * closed tab drops out of its group when the groups are next read. Pure and
 * tested (splitpanes.test.ts); `components/Sessions.tsx` lays them out.
 */

/** One pane, holding a strip shell by its tab id, or two side by side
 *  ("row") or stacked ("col"), the first taking `at` of the room. */
export type PaneTree = { pane: string } | { dir: "row" | "col"; at: number; a: PaneTree; b: PaneTree };

/** the side of a pane another lands on */
export type Edge = "left" | "right" | "top" | "bottom";

/** a part of the main pane, in fractions of it */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line between two parts of a split, which the mouse drags: the split's
 *  own box, which way it splits and where. `path` finds the split again
 *  (`a` and `b` from the top). */
export interface Seam {
  path: string;
  dir: "row" | "col";
  box: Box;
  at: number;
}

/** the least share either side of a seam keeps */
export const AT_MIN = 0.1;
export const AT_MAX = 0.9;
/** how deep a saved tree may go before it is not read back */
const DEPTH_MAX = 12;

const clampAt = (n: number) => Math.min(AT_MAX, Math.max(AT_MIN, n));

/** the tab ids of a tree's panes, left to right and top to bottom */
export function paneIds(t: PaneTree): string[] {
  return "pane" in t ? [t.pane] : [...paneIds(t.a), ...paneIds(t.b)];
}

export const hasPane = (t: PaneTree, id: string): boolean => ("pane" in t ? t.pane === id : hasPane(t.a, id) || hasPane(t.b, id));

/** `other` beside `id`, on its `edge`; the two share `id`'s room evenly */
export function splitPane(t: PaneTree, id: string, other: string, edge: Edge): PaneTree {
  if ("pane" in t) {
    if (t.pane !== id) return t;
    const dir = edge === "left" || edge === "right" ? "row" : "col";
    const first = edge === "left" || edge === "top";
    return { dir, at: 0.5, a: first ? { pane: other } : t, b: first ? t : { pane: other } };
  }
  return { ...t, a: splitPane(t.a, id, other, edge), b: splitPane(t.b, id, other, edge) };
}

/** the tree without `id`'s pane, its sibling taking the room; null when it
 *  was the only pane */
export function dropPane(t: PaneTree, id: string): PaneTree | null {
  if ("pane" in t) return t.pane === id ? null : t;
  const a = dropPane(t.a, id);
  const b = dropPane(t.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/** the tree with only the panes `keep` passes */
export function prunePanes(t: PaneTree, keep: (id: string) => boolean): PaneTree | null {
  if ("pane" in t) return keep(t.pane) ? t : null;
  const a = prunePanes(t.a, keep);
  const b = prunePanes(t.b, keep);
  if (!a) return b;
  if (!b) return a;
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/** where each pane sits, in fractions of the whole */
export function boxesOf(t: PaneTree, box: Box = { x: 0, y: 0, w: 1, h: 1 }): Record<string, Box> {
  if ("pane" in t) return { [t.pane]: box };
  const [a, b] = halves(t, box);
  return { ...boxesOf(t.a, a), ...boxesOf(t.b, b) };
}

function halves(t: Extract<PaneTree, { dir: string }>, box: Box): [Box, Box] {
  if (t.dir === "row") {
    const w = box.w * t.at;
    return [
      { ...box, w },
      { ...box, x: box.x + w, w: box.w - w },
    ];
  }
  const h = box.h * t.at;
  return [
    { ...box, h },
    { ...box, y: box.y + h, h: box.h - h },
  ];
}

/** every split's seam, outermost first */
export function seamsOf(t: PaneTree, box: Box = { x: 0, y: 0, w: 1, h: 1 }, path = ""): Seam[] {
  if ("pane" in t) return [];
  const [a, b] = halves(t, box);
  return [{ path, dir: t.dir, box, at: t.at }, ...seamsOf(t.a, a, `${path}a`), ...seamsOf(t.b, b, `${path}b`)];
}

/** the split at `path` moved to `at`, held between AT_MIN and AT_MAX */
export function setAt(t: PaneTree, path: string, at: number): PaneTree {
  if ("pane" in t) return t;
  if (path === "") return { ...t, at: clampAt(at) };
  return path[0] === "a" ? { ...t, a: setAt(t.a, path.slice(1), at) } : { ...t, b: setAt(t.b, path.slice(1), at) };
}

/** Where a seam goes for a pointer at `px` (client px along the seam's
 *  axis), given the main pane's own start and length in px. */
export function atFrom(seam: Seam, px: number, start: number, length: number): number {
  const from = seam.dir === "row" ? seam.box.x : seam.box.y;
  const span = seam.dir === "row" ? seam.box.w : seam.box.h;
  if (length <= 0 || span <= 0) return seam.at;
  return clampAt((px - start - from * length) / (span * length));
}

/** The edge of a pane a point is nearest, the point in fractions of the
 *  pane (0 to 1 each way). The halves are cut on the diagonals, so every
 *  point lands on one. */
export function edgeAt(fx: number, fy: number): Edge {
  const d: [Edge, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  return d.reduce((best, e) => (e[1] < best[1] ? e : best))[0];
}

/** the part of a pane's box another pane would take dropped on `edge` */
export function dropBox(box: Box, edge: Edge): Box {
  switch (edge) {
    case "left":
      return { ...box, w: box.w / 2 };
    case "right":
      return { ...box, x: box.x + box.w / 2, w: box.w / 2 };
    case "top":
      return { ...box, h: box.h / 2 };
    case "bottom":
      return { ...box, y: box.y + box.h / 2, h: box.h / 2 };
  }
}

/** the pane to focus once `id` leaves: the nearest one of its sibling */
export function neighbourOf(t: PaneTree, id: string): string | null {
  if ("pane" in t) return null;
  if ("pane" in t.a && t.a.pane === id) return paneIds(t.b)[0] ?? null;
  if ("pane" in t.b && t.b.pane === id) return paneIds(t.a).at(-1) ?? null;
  return hasPane(t.a, id) ? neighbourOf(t.a, id) : hasPane(t.b, id) ? neighbourOf(t.b, id) : null;
}

/** the group holding `id`, or undefined */
export const groupOf = (groups: readonly PaneTree[], id: string): PaneTree | undefined => groups.find((g) => hasPane(g, id));

/** the groups with only the tabs still open, a group left with one pane
 *  gone */
export function pruneGroups(groups: readonly PaneTree[], live: ReadonlySet<string>): PaneTree[] {
  const out: PaneTree[] = [];
  for (const g of groups) {
    const t = prunePanes(g, (id) => live.has(id));
    if (t && !("pane" in t)) out.push(t);
  }
  return out;
}

/** `id` out of its group, which goes when one pane is left */
export function leaveGroup(groups: readonly PaneTree[], id: string): PaneTree[] {
  const out: PaneTree[] = [];
  for (const g of groups) {
    const t = hasPane(g, id) ? dropPane(g, id) : g;
    if (t && !("pane" in t)) out.push(t);
  }
  return out;
}

/** `id` on `beside`'s `edge`: in `beside`'s group, or a new group of the
 *  two. `id` leaves any group it was in first. */
export function splitIn(groups: readonly PaneTree[], beside: string, id: string, edge: Edge): PaneTree[] {
  if (beside === id) return [...groups];
  const rest = leaveGroup(groups, id);
  const i = rest.findIndex((g) => hasPane(g, beside));
  if (i < 0) return [...rest, splitPane({ pane: beside }, beside, id, edge)];
  return rest.map((g, j) => (j === i ? splitPane(g, beside, id, edge) : g));
}

/** The tab row: a tab in no group as itself, a group as its first tab in
 *  the row's order, and how many panes each group's tab stands for. */
export function rowOf<T extends { id: string }>(tabs: readonly T[], groups: readonly PaneTree[]): { row: T[]; panes: Record<string, number> } {
  const row: T[] = [];
  const panes: Record<string, number> = {};
  const seen = new Set<PaneTree>();
  for (const t of tabs) {
    const g = groupOf(groups, t.id);
    if (!g) row.push(t);
    else if (!seen.has(g)) {
      seen.add(g);
      row.push(t);
      panes[t.id] = paneIds(g).length;
    }
  }
  return { row, panes };
}

/** the tab in the row that stands for `id`: its group's, or its own */
export function headOf<T extends { id: string }>(row: readonly T[], groups: readonly PaneTree[], id: string | null): string | null {
  if (!id) return null;
  const g = groupOf(groups, id);
  if (!g) return id;
  return row.find((t) => hasPane(g, t.id))?.id ?? id;
}

function treeOf(v: unknown, seen: Set<string>, depth: number): PaneTree | null {
  if (depth > DEPTH_MAX || typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.pane === "string") {
    if (!o.pane || seen.has(o.pane)) return null;
    seen.add(o.pane);
    return { pane: o.pane };
  }
  if ((o.dir !== "row" && o.dir !== "col") || typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  const a = treeOf(o.a, seen, depth + 1);
  const b = treeOf(o.b, seen, depth + 1);
  if (!a || !b) return null;
  return { dir: o.dir, at: clampAt(o.at), a, b };
}

/** the saved groups read back: whole trees of two or more panes, no tab in
 *  two of them, anything else dropped */
export function splitsOf(v: unknown): PaneTree[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: PaneTree[] = [];
  for (const g of v) {
    const t = treeOf(g, seen, 0);
    if (t && !("pane" in t)) out.push(t);
  }
  return out;
}
