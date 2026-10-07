// The dock's layout as a grid: columns hold cells, cells hold tabs. Pure
// functions over plain data, no React and no store. Panel ids are opaque
// strings (they may hold "/" and ":").
import { nextActive } from "./dock";

export interface DockCell { id: string; panels: string[]; active: string; share: number }
export interface DockColumn { id: string; width: number; cells: DockCell[] }
export interface DockLayout { columns: DockColumn[] }
export type Zone = "center" | "above" | "below" | "left" | "right";
export type Arrangement = "columns" | "tabs";

/** Width of a new column. The store's PANEL.initial reuses this. */
export const COLUMN_WIDTH = 440;
/** The smallest share a cell keeps when a seam is dragged. */
const MIN_SHARE = 0.1;

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Every panel id: columns left to right, cells top to bottom, tabs in order. */
export function panelsOf(l: DockLayout): string[] {
  return l.columns.flatMap((c) => c.cells.flatMap((x) => x.panels));
}

export function cellOf(l: DockLayout, id: string): DockCell | undefined {
  for (const c of l.columns) for (const x of c.cells) if (x.panels.includes(id)) return x;
  return undefined;
}

/** `c${n}`, one more than the highest numeric suffix of any column or cell id. */
function newId(l: DockLayout): string {
  let max = 0;
  const see = (id: string) => {
    const m = /^c(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const c of l.columns) {
    see(c.id);
    for (const x of c.cells) see(x.id);
  }
  return `c${max + 1}`;
}

/** Drops empty cells and columns, renormalizes shares to sum to 1, and
 *  points every cell's `active` at one of its panels. */
function prune(l: DockLayout): DockLayout {
  const columns: DockColumn[] = [];
  for (const col of l.columns) {
    const kept = col.cells.filter((x) => x.panels.length > 0);
    if (kept.length === 0) continue;
    const total = kept.reduce((s, x) => s + x.share, 0);
    const cells = kept.map((x) => ({
      ...x,
      panels: [...x.panels],
      active: x.panels.includes(x.active) ? x.active : (x.panels[0] ?? x.active),
      share: total > 0 ? round(x.share / total) : round(1 / kept.length),
    }));
    columns.push({ ...col, cells });
  }
  return { columns };
}

/** `id` out of its cell. A cell whose active tab left hands it on the way
 *  `nextActive` decides. */
function remove(l: DockLayout, id: string): DockLayout {
  return prune({
    columns: l.columns.map((col) => ({
      ...col,
      cells: col.cells.map((x) =>
        x.panels.includes(id)
          ? { ...x, panels: x.panels.filter((p) => p !== id), active: nextActive(x.panels, id, x.active) ?? x.active }
          : x,
      ),
    })),
  });
}

function mapCell(l: DockLayout, cell: string, fn: (x: DockCell) => DockCell): DockLayout {
  return { columns: l.columns.map((col) => ({ ...col, cells: col.cells.map((x) => (x.id === cell ? fn(x) : x)) })) };
}

export function activate(l: DockLayout, id: string): DockLayout {
  const own = cellOf(l, id);
  if (!own) return l;
  return mapCell(l, own.id, (x) => ({ ...x, active: id }));
}

/** Makes the layout hold exactly the `open` panels: closed ones leave, new
 *  ones become a column each or tabs in the active cell. */
export function place(l: DockLayout, open: readonly string[], active: string | null, into: Arrangement, newWidth: number): DockLayout {
  let out = l;
  for (const id of panelsOf(l)) if (!open.includes(id)) out = remove(out, id);
  const seen = new Set(panelsOf(out));
  for (const id of open) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (into === "columns") {
      const colId = newId(out);
      const cellId = newId({ columns: [...out.columns, { id: colId, width: newWidth, cells: [] }] });
      out = { columns: [...out.columns, { id: colId, width: newWidth, cells: [{ id: cellId, panels: [id], active: id, share: 1 }] }] };
      continue;
    }
    const target = (active !== null ? cellOf(out, active) : undefined) ?? out.columns.at(-1)?.cells.at(-1);
    if (target) {
      out = mapCell(out, target.id, (x) => ({ ...x, panels: [...x.panels, id], active: id }));
    } else {
      const colId = newId(out);
      const cellId = newId({ columns: [{ id: colId, width: newWidth, cells: [] }] });
      out = { columns: [{ id: colId, width: newWidth, cells: [{ id: cellId, panels: [id], active: id, share: 1 }] }] };
    }
  }
  return active !== null && seen.has(active) ? activate(out, active) : out;
}

export function moveTo(l: DockLayout, id: string, target: { cell: string; zone: Zone }, newWidth: number): DockLayout {
  const own = cellOf(l, id);
  const dest = l.columns.flatMap((c) => c.cells).find((x) => x.id === target.cell);
  if (!own || !dest) return l;
  if (own.id === dest.id && (own.panels.length === 1 || target.zone === "center")) return l;
  const out = remove(l, id);
  const colIdx = out.columns.findIndex((c) => c.cells.some((x) => x.id === target.cell));
  const col = out.columns[colIdx];
  if (!col) return l;
  if (target.zone === "center") {
    return mapCell(out, target.cell, (x) => ({ ...x, panels: [...x.panels, id], active: id }));
  }
  if (target.zone === "above" || target.zone === "below") {
    const at = col.cells.findIndex((x) => x.id === target.cell);
    const t = col.cells[at];
    if (!t) return l;
    const half = round(t.share / 2);
    const fresh: DockCell = { id: newId(out), panels: [id], active: id, share: half };
    const cells = col.cells.map((x) => (x.id === t.id ? { ...x, share: half } : x));
    cells.splice(target.zone === "above" ? at : at + 1, 0, fresh);
    return { columns: out.columns.map((c, i) => (i === colIdx ? { ...c, cells } : c)) };
  }
  const colId = newId(out);
  const cellId = newId({ columns: [...out.columns, { id: colId, width: newWidth, cells: [] }] });
  const fresh: DockColumn = { id: colId, width: newWidth, cells: [{ id: cellId, panels: [id], active: id, share: 1 }] };
  const columns = [...out.columns];
  columns.splice(target.zone === "left" ? colIdx : colIdx + 1, 0, fresh);
  return { columns };
}

/** `id` joins `cell` as a tab at `index` (clamped) and becomes its active
 *  tab. Inside its own cell this reorders. Not phase A's movePanel, which
 *  is the left/right move and tab reorder in store.ts. */
export function moveWithin(l: DockLayout, id: string, cell: string, index: number): DockLayout {
  const own = cellOf(l, id);
  if (!own || !l.columns.some((c) => c.cells.some((x) => x.id === cell))) return l;
  const out = own.id === cell ? l : remove(l, id);
  return mapCell(out, cell, (x) => {
    const rest = x.panels.filter((p) => p !== id);
    const at = Math.max(0, Math.min(index, rest.length));
    return { ...x, panels: [...rest.slice(0, at), id, ...rest.slice(at)], active: id };
  });
}

/** Every panel in one cell (tabs) or one column each (columns). Old column
 *  widths are reused by position. */
export function regroup(l: DockLayout, into: Arrangement, width: number): DockLayout {
  const ids = panelsOf(l);
  if (ids.length === 0) return l;
  const actives = l.columns.flatMap((c) => c.cells.map((x) => x.active));
  const first = actives.find((a) => ids.includes(a)) ?? ids[0] ?? "";
  if (into === "tabs") {
    return { columns: [{ id: "c1", width, cells: [{ id: "c2", panels: ids, active: first, share: 1 }] }] };
  }
  return {
    columns: ids.map((id, i) => ({
      id: `c${2 * i + 1}`,
      width: l.columns[i]?.width ?? width,
      cells: [{ id: `c${2 * i + 2}`, panels: [id], active: id, share: 1 }],
    })),
  };
}

export function resizeColumn(l: DockLayout, column: string, px: number, min: number, max: number): DockLayout {
  if (!Number.isFinite(px) || !l.columns.some((c) => c.id === column)) return l;
  const width = Math.max(min, Math.min(max, px));
  return { columns: l.columns.map((c) => (c.id === column ? { ...c, width } : c)) };
}

/** Moves the boundary between cells `index` and `index + 1` to `at`, a
 *  fraction of the column's height from the top. No cell drops under 0.1,
 *  and the other cells keep their shares. */
export function resizeSeam(l: DockLayout, column: string, index: number, at: number): DockLayout {
  const col = l.columns.find((c) => c.id === column);
  const a = col?.cells[index];
  const b = col?.cells[index + 1];
  if (!col || !a || !b || !Number.isFinite(at)) return l;
  const above = col.cells.slice(0, index).reduce((s, x) => s + x.share, 0);
  const pair = a.share + b.share;
  if (pair < 2 * MIN_SHARE) return l;
  const first = round(Math.max(MIN_SHARE, Math.min(pair - MIN_SHARE, at - above)));
  const second = round(pair - first);
  return {
    columns: l.columns.map((c) =>
      c.id === column ? { ...c, cells: c.cells.map((x, i) => (i === index ? { ...x, share: first } : i === index + 1 ? { ...x, share: second } : x)) } : c,
    ),
  };
}

/** Swaps one panel id for another in place (a checkout switch renames its
 *  panels). A missing `from`, or a `to` already present, changes nothing. */
export function rename(l: DockLayout, from: string, to: string): DockLayout {
  if (from === to || !cellOf(l, from) || cellOf(l, to)) return l;
  const sw = (p: string) => (p === from ? to : p);
  return {
    columns: l.columns.map((c) => ({
      ...c,
      cells: c.cells.map((x) => (x.panels.includes(from) ? { ...x, panels: x.panels.map(sw), active: sw(x.active) } : x)),
    })),
  };
}

export interface GridPlan {
  /** grid-template-columns: a 6px seam then the column, per column */
  columns: string;
  /** grid-template-rows: the union of every column's cell boundaries, in fr */
  rows: string;
  /** each open panel's grid-area, its cell id, whether it is its cell's active one, and whether its cell shows a strip */
  panels: Record<string, { area: string; cell: string; shown: boolean; strip: boolean }>;
  strips: { cell: string; area: string; panels: string[]; active: string }[];
  colSeams: { column: string; area: string }[];
  rowSeams: { column: string; index: number; area: string }[];
}

/** Boundaries closer than this are one line, so thirds against halves leave no sliver. */
const MERGE = 0.001;

export function gridOf(l: DockLayout): GridPlan {
  const raw = [0, 1];
  for (const col of l.columns) {
    let sum = 0;
    for (const x of col.cells) {
      sum += x.share;
      raw.push(Math.max(0, Math.min(1, sum)));
    }
  }
  raw.sort((a, b) => a - b);
  const bounds: number[] = [];
  for (const b of raw) {
    const last = bounds.at(-1);
    if (last === undefined || b - last >= MERGE) bounds.push(b);
  }
  // the nearest boundary's 1-based grid line
  const line = (v: number): number => {
    let best = 0;
    bounds.forEach((b, i) => {
      if (Math.abs(b - v) < Math.abs((bounds[best] ?? 0) - v)) best = i;
    });
    return best + 1;
  };
  const rows = bounds.slice(1).map((b, i) => `${Math.round((b - (bounds[i] ?? 0)) * 1000)}fr`);
  const plan: GridPlan = {
    columns: l.columns.map((c) => `6px ${c.width}px`).join(" "),
    rows: rows.join(" "),
    panels: {},
    strips: [],
    colSeams: [],
    rowSeams: [],
  };
  l.columns.forEach((col, i) => {
    const seamCol = 2 * i + 1;
    const bodyCol = 2 * i + 2;
    const end = line(1);
    plan.colSeams.push({ column: col.id, area: `1 / ${seamCol} / ${end} / ${bodyCol}` });
    let top = 0;
    col.cells.forEach((x, j) => {
      const start = line(top);
      top += x.share;
      const stop = j === col.cells.length - 1 ? end : line(top);
      const area = `${start} / ${bodyCol} / ${stop} / ${bodyCol + 1}`;
      const strip = x.panels.length > 1;
      for (const p of x.panels) plan.panels[p] = { area, cell: x.id, shown: p === x.active, strip };
      if (strip) plan.strips.push({ cell: x.id, area, panels: [...x.panels], active: x.active });
      if (j > 0) plan.rowSeams.push({ column: col.id, index: j - 1, area });
    });
  });
  return plan;
}

/** how near an edge, as a fraction of that side, a drop must be to split */
export const EDGE = 0.25;

/** Where a drop at (x, y) lands in a cell's rect: the nearest edge when
 *  within EDGE of it, else the middle. A point outside clamps to the rect. */
export function dropZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const fx = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  const fy = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
  const edges: [Zone, number][] = [["left", fx], ["right", 1 - fx], ["above", fy], ["below", 1 - fy]];
  const [zone, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return d < EDGE ? zone : "center";
}
