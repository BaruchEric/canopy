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

export function columnOf(l: DockLayout, id: string): DockColumn | undefined {
  return l.columns.find((c) => c.cells.some((x) => x.panels.includes(id)));
}

/** A new column's width: one for every panel, or each panel's own. */
export type NewWidth = number | ((id: string) => number);
const widthFor = (w: NewWidth, id: string): number => (typeof w === "number" ? w : w(id));

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
  if (!own || own.active === id) return l;
  return mapCell(l, own.id, (x) => ({ ...x, active: id }));
}

/** Makes the layout hold exactly the `open` panels: closed ones leave, new
 *  ones become a column each or tabs in the active cell. */
export function place(l: DockLayout, open: readonly string[], active: string | null, into: Arrangement, newWidth: NewWidth): DockLayout {
  let out = l;
  for (const id of panelsOf(l)) if (!open.includes(id)) out = remove(out, id);
  const seen = new Set(panelsOf(out));
  for (const id of open) {
    if (seen.has(id)) continue;
    seen.add(id);
    const width = widthFor(newWidth, id);
    if (into === "columns") {
      const colId = newId(out);
      const cellId = newId({ columns: [...out.columns, { id: colId, width, cells: [] }] });
      out = { columns: [...out.columns, { id: colId, width, cells: [{ id: cellId, panels: [id], active: id, share: 1 }] }] };
      continue;
    }
    const target = (active !== null ? cellOf(out, active) : undefined) ?? out.columns.at(-1)?.cells.at(-1);
    if (target) {
      out = mapCell(out, target.id, (x) => ({ ...x, panels: [...x.panels, id], active: id }));
    } else {
      const colId = newId(out);
      const cellId = newId({ columns: [{ id: colId, width, cells: [] }] });
      out = { columns: [{ id: colId, width, cells: [{ id: cellId, panels: [id], active: id, share: 1 }] }] };
    }
  }
  return active !== null && seen.has(active) ? activate(out, active) : out;
}

/** Whether two layouts group the same panels the same way: the same
 *  columns of the same cells of the same tabs, in order. */
function sameShape(a: DockLayout, b: DockLayout): boolean {
  return (
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => {
      const d = b.columns[i];
      return (
        d !== undefined &&
        c.cells.length === d.cells.length &&
        c.cells.every((x, j) => {
          const y = d.cells[j];
          return y !== undefined && x.panels.length === y.panels.length && x.panels.every((p, k) => p === y.panels[k]);
        })
      );
    })
  );
}

/** `id` into `target`: a tab of the cell (center), a new cell above or
 *  below it, or a new column left or right of its column. A move that
 *  would rebuild the arrangement it started from (beside a neighbour on
 *  the side it already is) gives back `l` itself, its shares and ids kept. */
export function moveTo(l: DockLayout, id: string, target: { cell: string; zone: Zone }, newWidth: number): DockLayout {
  const out = moveToShape(l, id, target, newWidth);
  return out !== l && sameShape(l, out) ? l : out;
}

function moveToShape(l: DockLayout, id: string, target: { cell: string; zone: Zone }, newWidth: number): DockLayout {
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
 *  tab. Inside its own cell this reorders; the showing tab moved to where
 *  it already is gives back `l` itself. Not phase A's movePanel, which is
 *  the left/right move and tab reorder in store.ts. */
export function moveWithin(l: DockLayout, id: string, cell: string, index: number): DockLayout {
  const own = cellOf(l, id);
  if (!own || !l.columns.some((c) => c.cells.some((x) => x.id === cell))) return l;
  const stay = Math.max(0, Math.min(index, own.panels.length - 1));
  if (own.id === cell && own.active === id && own.panels[stay] === id) return l;
  const out = own.id === cell ? l : remove(l, id);
  return mapCell(out, cell, (x) => {
    const rest = x.panels.filter((p) => p !== id);
    const at = Math.max(0, Math.min(index, rest.length));
    return { ...x, panels: [...rest.slice(0, at), id, ...rest.slice(at)], active: id };
  });
}

/** A whole column to index `index` (clamped), its width and cells with it. */
export function moveColumn(l: DockLayout, column: string, index: number): DockLayout {
  const from = l.columns.findIndex((c) => c.id === column);
  const col = l.columns[from];
  if (!col || !Number.isFinite(index)) return l;
  const at = Math.max(0, Math.min(l.columns.length - 1, index));
  if (at === from) return l;
  const columns = l.columns.filter((c) => c.id !== column);
  columns.splice(at, 0, col);
  return { columns };
}

/** A cell to index `index` (clamped) of its own column, its share with it. */
export function moveCell(l: DockLayout, cell: string, index: number): DockLayout {
  const col = l.columns.find((c) => c.cells.some((x) => x.id === cell));
  const from = col?.cells.findIndex((x) => x.id === cell) ?? -1;
  const own = col?.cells[from];
  if (!col || !own || !Number.isFinite(index)) return l;
  const at = Math.max(0, Math.min(col.cells.length - 1, index));
  if (at === from) return l;
  const cells = col.cells.filter((x) => x.id !== cell);
  cells.splice(at, 0, own);
  return { columns: l.columns.map((c) => (c.id === col.id ? { ...c, cells } : c)) };
}

/** Panel `id` one step along the flat order (`panelsOf`), toward index
 *  `to`, the move keys' and the gear's left and right; null where that
 *  changes nothing, so the gear can grey the entry out. The panel at `to`
 *  is where it heads: a tab among its cell's tabs reorders (the showing
 *  tab kept), a lone column moves as a column, a tab heading out of its
 *  cell of tabs goes no further than the cell's edge (its siblings never
 *  move with it), and a cell of one panel in a stack moves up or down its
 *  column. */
export function stepPanel(l: DockLayout, id: string, to: number): DockLayout | null {
  const panels = panelsOf(l);
  const from = panels.indexOf(id);
  const own = cellOf(l, id);
  const col = columnOf(l, id);
  const target = panels[Math.max(0, Math.min(panels.length - 1, to))];
  if (from === -1 || !own || !col || target === undefined || target === id) return null;
  const toward = to < from ? 0 : Number.MAX_SAFE_INTEGER;
  const at = own.panels.indexOf(id);
  let out: DockLayout;
  if (own.panels.includes(target)) {
    out = activate(moveWithin(l, id, own.id, own.panels.indexOf(target)), own.active);
  } else if (col.cells.length === 1 && own.panels.length === 1) {
    out = moveColumn(l, col.id, l.columns.findIndex((c) => c.id === columnOf(l, target)?.id));
  } else if (own.panels.length > 1) {
    if (toward === 0 ? at === 0 : at === own.panels.length - 1) return null;
    out = activate(moveWithin(l, id, own.id, toward), own.active);
  } else if (col.cells.some((x) => x.panels.includes(target))) {
    out = moveCell(l, own.id, col.cells.findIndex((x) => x.panels.includes(target)));
  } else {
    out = moveCell(l, own.id, toward);
  }
  return out === l ? null : out;
}

/** Every panel in one cell (tabs) or one column each (columns). Old column
 *  widths are reused by position, which is all this pure op can see; the
 *  store's `arrangeDock` overrides them, keeping each width by panel id
 *  through `panelWidths`. */
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

/** A column's width to `px`, clamped to [min, max]. A width that stays
 *  what it was (held at its limit, say) gives back `l` itself. */
export function resizeColumn(l: DockLayout, column: string, px: number, min: number, max: number): DockLayout {
  const col = l.columns.find((c) => c.id === column);
  if (!Number.isFinite(px) || !col) return l;
  const width = Math.max(min, Math.min(max, px));
  if (width === col.width) return l;
  return { columns: l.columns.map((c) => (c.id === column ? { ...c, width } : c)) };
}

/** Moves the boundary between cells `index` and `index + 1` to `at`, a
 *  fraction of the column's height from the top. No cell drops under 0.1,
 *  and the other cells keep their shares. A boundary that stays put
 *  (moved nowhere, or held at its limit) gives back `l` itself. */
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
  if (first === a.share && second === b.share) return l;
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

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** the ids a saved layout may keep: they become CSS custom property names */
const SAFE_ID = /^c\d{1,6}$/;

/** A layout read back from storage, repaired: entries of the wrong shape
 *  go, a panel saved twice keeps its first place, widths and shares are
 *  finite and positive (shares summing to 1 in each column, none a
 *  sliver), and ids that are not `c` and a number, or repeat, are issued
 *  again. Null when it is not a layout at all. */
export function normalizeLayout(v: unknown): DockLayout | null {
  if (!isRecord(v) || !Array.isArray(v.columns)) return null;
  const seen = new Set<string>();
  const raw: DockColumn[] = [];
  for (const c of v.columns) {
    if (!isRecord(c) || !Array.isArray(c.cells)) continue;
    const cells: DockCell[] = [];
    for (const x of c.cells) {
      if (!isRecord(x) || !Array.isArray(x.panels)) continue;
      const panels: string[] = [];
      for (const p of x.panels) {
        if (typeof p !== "string" || seen.has(p)) continue;
        seen.add(p);
        panels.push(p);
      }
      const share = typeof x.share === "number" && Number.isFinite(x.share) && x.share > 0 ? x.share : 1;
      cells.push({ id: typeof x.id === "string" ? x.id : "", panels, active: typeof x.active === "string" ? x.active : "", share });
    }
    const width = typeof c.width === "number" && Number.isFinite(c.width) && c.width > 0 ? c.width : COLUMN_WIDTH;
    raw.push({ id: typeof c.id === "string" ? c.id : "", width, cells });
  }
  // no cell under MIN_SHARE, so none is a sliver gridOf merges away
  let out = prune({ columns: raw });
  out = {
    columns: out.columns.map((c) => {
      const shares = floored(c.cells.map((x) => x.share));
      return { ...c, cells: c.cells.map((x, i) => ({ ...x, share: shares[i] ?? x.share })) };
    }),
  };
  // ids: the safe ones keep their first use, every other is issued again
  const used = new Set<string>();
  const keep = (id: string): string => {
    if (!SAFE_ID.test(id) || used.has(id)) return "";
    used.add(id);
    return id;
  };
  out = { columns: out.columns.map((c) => ({ ...c, id: keep(c.id), cells: c.cells.map((x) => ({ ...x, id: keep(x.id) })) })) };
  const columns: DockColumn[] = [];
  for (const c of out.columns) {
    const colId = c.id || newId({ columns: [...out.columns, ...columns] });
    const col: DockColumn = { ...c, id: colId, cells: [] };
    columns.push(col);
    for (const x of c.cells) col.cells.push({ ...x, id: x.id || newId({ columns: [...out.columns, ...columns] }) });
  }
  return { columns };
}

/** Shares summing to 1 with none under MIN_SHARE: the cells that would
 *  fall under it are held at it and the rest share what is left, until
 *  none falls under. A column with more cells than the floor allows
 *  shares equally. */
function floored(shares: readonly number[]): number[] {
  const n = shares.length;
  if (n * MIN_SHARE >= 1) return shares.map(() => round(1 / n));
  const held = new Set<number>();
  for (;;) {
    const free = shares.reduce((sum, x, i) => (held.has(i) ? sum : sum + x), 0);
    const room = 1 - held.size * MIN_SHARE;
    const out = shares.map((x, i) => (held.has(i) ? MIN_SHARE : free > 0 ? (x / free) * room : room / (n - held.size)));
    let more = false;
    out.forEach((x, i) => {
      if (!held.has(i) && x < MIN_SHARE) {
        held.add(i);
        more = true;
      }
    });
    if (!more) return out.map(round);
  }
}

/** The first layout for a dock saved before there were layouts: its open
 *  panels placed in order, each column at the panel's own old width, or
 *  as tabs at the tabbed dock's old width. */
export function fromLegacy(
  panels: readonly string[],
  active: string | null,
  widths: Record<string, number>,
  dockWidth: number,
  into: Arrangement,
): DockLayout {
  const l = place({ columns: [] }, panels, active, into, (id) => widths[id] ?? COLUMN_WIDTH);
  return into === "tabs" ? { columns: l.columns.map((c) => ({ ...c, width: dockWidth })) } : l;
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

export interface Box { left: number; top: number; width: number; height: number }
export interface Drop { cell: string; zone: Zone }

/** Where panel `id`, dragged to (x, y) over `hit` (the cell under the
 *  pointer and its rect), would land; null with no cell under it, or where
 *  letting go would change nothing (a lone panel over its own cell, any
 *  panel over its own cell's middle). */
export function dropTarget(l: DockLayout, id: string, hit: { cell: string; rect: Box } | null, x: number, y: number): Drop | null {
  if (!hit) return null;
  const t = { cell: hit.cell, zone: dropZone(hit.rect, x, y) };
  return moveTo(l, id, t, COLUMN_WIDTH) === l ? null : t;
}

/** a strip tab's place across the page, for `stripDrop` */
export interface TabBox { id: string; left: number; width: number }
/** A drop on a cell's tab strip: a tab of `cell` at `index` (`moveWithin`'s
 *  index, among the cell's other tabs), and `at`, the x of the gap it goes
 *  in, where the insertion mark is drawn. */
export interface StripDrop { cell: string; index: number; at: number }

/** Where panel `id`, dragged to x over the tab strip of `cell` whose tabs
 *  are drawn at `tabs`, would land: in the gap before the first of the
 *  cell's other tabs whose middle is at or right of x, or after the last.
 *  Null where letting go would change nothing (back at its own place in
 *  its own strip, showing or not) or with no such cell or panel. A strip
 *  drop never splits. */
export function stripDrop(l: DockLayout, id: string, cell: string, x: number, tabs: readonly TabBox[]): StripDrop | null {
  const dest = l.columns.flatMap((c) => c.cells).find((c) => c.id === cell);
  const own = cellOf(l, id);
  if (!dest || !own) return null;
  const others = tabs.filter((t) => t.id !== id && dest.panels.includes(t.id)).sort((a, b) => a.left - b.left);
  const last = others[others.length - 1];
  if (!last) return null;
  const before = others.find((t) => t.left + t.width / 2 >= x);
  const rest = dest.panels.filter((p) => p !== id);
  const index = before ? rest.indexOf(before.id) : rest.length;
  if (own.id === cell && own.panels.indexOf(id) === index) return null;
  if (moveWithin(l, id, cell, index) === l) return null;
  return { cell, index, at: before ? before.left : last.left + last.width };
}

/** `b` cut to what `view` shows, or null when none of it shows: a drop's
 *  preview stays inside the dock when its cell is scrolled partly out. */
export function clipBox(b: Box, view: Box): Box | null {
  const left = Math.max(b.left, view.left);
  const top = Math.max(b.top, view.top);
  const right = Math.min(b.left + b.width, view.left + view.width);
  const bottom = Math.min(b.top + b.height, view.top + view.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/** The part of a cell's rect a drop in `zone` takes: the half toward an
 *  edge, or all of it for the middle. */
export function zoneRect(r: Box, zone: Zone): Box {
  const w = r.width / 2;
  const h = r.height / 2;
  switch (zone) {
    case "center":
      // fields by name: a DOMRect's are getters, which a spread drops
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    case "above":
      return { left: r.left, top: r.top, width: r.width, height: h };
    case "below":
      return { left: r.left, top: r.top + h, width: r.width, height: h };
    case "left":
      return { left: r.left, top: r.top, width: w, height: r.height };
    case "right":
      return { left: r.left + w, top: r.top, width: w, height: r.height };
  }
}

/** The panel gear's layout moves for `id`, each a drop or null where it
 *  has none: under the last cell of the column on its left, a column of
 *  its own just right of its column, and a tab of the first cell of the
 *  column on its left. */
export function gearDrops(l: DockLayout, id: string): { splitLeft: Drop | null; newColumn: Drop | null; joinLeft: Drop | null } {
  const at = l.columns.findIndex((c) => c.cells.some((x) => x.panels.includes(id)));
  const col = l.columns[at];
  const own = cellOf(l, id);
  if (!col || !own) return { splitLeft: null, newColumn: null, joinLeft: null };
  const left = l.columns[at - 1];
  const last = left?.cells.at(-1);
  const first = left?.cells[0];
  // a right drop on any cell of the column makes the column after it; on
  // its own cell only when other tabs keep that cell
  const beside = col.cells.find((x) => x.id !== own.id) ?? (own.panels.length > 1 ? own : undefined);
  return {
    splitLeft: last ? { cell: last.id, zone: "below" } : null,
    newColumn: beside ? { cell: beside.id, zone: "right" } : null,
    joinLeft: first ? { cell: first.id, zone: "center" } : null,
  };
}

/** An id as part of a CSS custom property name: every character outside
 *  [A-Za-z0-9_-] becomes "_", and a hash of the whole id follows, so two
 *  ids that differ only in those characters never share a name. */
export function cssId(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return `${id.replace(/[^A-Za-z0-9_-]/g, "_")}-${h.toString(36)}`;
}

/** the custom property a column's live width is written to */
export const columnVar = (column: string): string => `--col-w-${cssId(column)}`;

/** gridOf's rows as tracks that may shrink to nothing, so the rows always
 *  fit the dock's height and it never scrolls up and down */
export function rowsTemplate(rows: string): string {
  return rows
    .split(" ")
    .filter((r) => r !== "")
    .map((r) => `minmax(0, ${r})`)
    .join(" ");
}

/** The dock's grid templates. Each column reads its own variable, and
 *  `vars` sets every one from the layout, so a seam's live write is
 *  replaced by the next render rather than outliving a width change. With
 *  `fill` (a lone column under the carousel) the column takes the whole
 *  dock and its seam no room. */
export function gridTemplate(l: DockLayout, plan: GridPlan, fill = false): { columns: string; rows: string; vars: Record<string, string> } {
  const vars: Record<string, string> = {};
  for (const c of l.columns) vars[columnVar(c.id)] = `${c.width}px`;
  return {
    columns: fill ? "0 minmax(0, 1fr)" : l.columns.map((c) => `6px var(${columnVar(c.id)}, ${c.width}px)`).join(" "),
    rows: rowsTemplate(plan.rows),
    vars,
  };
}

/** Where the seam under cell `index` of `column` sits, a fraction of the
 *  column's height from the top; null when there is no such seam. */
export function seamStart(l: DockLayout, column: string, index: number): number | null {
  const col = l.columns.find((c) => c.id === column);
  if (!col || index < 0 || index >= col.cells.length - 1) return null;
  return col.cells.slice(0, index + 1).reduce((s, x) => s + x.share, 0);
}

/** How far the seam under cell `index` of `column` can go, as fractions of
 *  the column's height from the top: MIN_SHARE short of the boundary above
 *  the pair and of the one below it, which is where `resizeSeam` holds it,
 *  and the pair's midpoint, its reset. Null when there is no such seam. */
export function seamRange(l: DockLayout, column: string, index: number): { min: number; max: number; middle: number } | null {
  const cells = l.columns.find((c) => c.id === column)?.cells;
  const a = cells?.[index];
  const b = cells?.[index + 1];
  if (!cells || !a || !b) return null;
  const above = cells.slice(0, index).reduce((s, x) => s + x.share, 0);
  const pair = a.share + b.share;
  // a pair too small to move has its one place, where the seam is now
  if (pair < 2 * MIN_SHARE) {
    const at = round(above + a.share);
    return { min: at, max: at, middle: at };
  }
  return { min: round(above + MIN_SHARE), max: round(above + pair - MIN_SHARE), middle: round(above + pair / 2) };
}

/** A row seam's accessible name: the showing panels of the two cells it
 *  sits between, through `name`. */
export function seamLabel(l: DockLayout, column: string, index: number, name: (id: string) => string): string {
  const cells = l.columns.find((c) => c.id === column)?.cells;
  const above = cells?.[index]?.active;
  const below = cells?.[index + 1]?.active;
  return above && below ? `Height of ${name(above)} and ${name(below)}` : "Height of the cells above and below";
}

/** A seam dragged `dy` px down a column `height` px tall, from `start`.
 *  Every column spans the dock's full height, so that is the dock's. */
export function seamDrag(start: number, dy: number, height: number): number {
  if (!(height > 0) || !Number.isFinite(dy)) return start;
  return Math.max(0, Math.min(1, start + dy / height));
}

export interface Placement { area?: string; cell?: string; order?: number; hidden: boolean; strip: boolean }

/** Where each open panel goes: its grid area with `plan`, or, with none
 *  (a phone, or no layout yet), a CSS order in the flat dock, in the
 *  layout's order and any it does not hold after them: every panel
 *  showing, or with `showing` (tabs on a phone) that one alone, the rest
 *  tabs of the one strip. A panel the plan does not hold takes no room
 *  rather than auto-placing. */
export function placements(l: DockLayout, open: readonly string[], plan: GridPlan | null, showing?: string): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  if (plan) {
    for (const id of open) {
      const p = plan.panels[id];
      out[id] = p ? { area: p.area, cell: p.cell, hidden: !p.shown, strip: p.strip } : { hidden: true, strip: false };
    }
    return out;
  }
  const laid = panelsOf(l).filter((id) => open.includes(id));
  const order = [...laid, ...open.filter((id) => !laid.includes(id))];
  const tabs = showing !== undefined;
  for (const id of open) out[id] = { order: order.indexOf(id), hidden: tabs && id !== showing, strip: tabs };
  return out;
}
