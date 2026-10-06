# The movable dock, phase B: groups and splits. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Gate:** start this plan only after Eric says go. Phase A must have shipped first.

**Goal:** the dock becomes columns of cells, where each cell is a tabbed group of panels. A dragged tab can join another cell, split one above or below, or start a new column to the left or right. Columns resize sideways and cells resize up and down. Today's "side by side" and "as tabs" become two arrangements of the same model, and no panel ever reloads.

**Architecture:**
- A pure model in `ui/src/grid.ts`: `DockLayout { columns: DockColumn[] }`. A `DockColumn` is `{ id, width, cells }` and a `DockCell` is `{ id, panels, active, share }`.
- The model has its operations (`place`, `moveTo`, `resizeColumn`, `resizeSeam`), `dropZone`, and `gridOf`, which turns the model into one CSS grid.
- `Dock` keeps every `RepoPanel` as a flat keyed child of `.dock`, rendered in `stableOrder`, and gives each one a `grid-area`.
- Tab strips and seams are separate elements placed in the same grid, which can be re-created freely.
- `panels` stays the flat open set, derived from the layout, so nothing outside the dock changes.

**Tech stack:** React 19 + zustand, CSS grid, pointer events with `setPointerCapture`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-kilo-borrowings-design.md`, section "The movable dock", the first rule and phase B.

## Global constraints

- **A panel is never reparented or moved in the DOM.** Every arrangement is grid placement over the same keyed children of `.dock`.
- TypeScript `"strict": true`. No `any`, no `as` casts on untrusted data (a saved layout from localStorage is untrusted), no non-null `!`.
- Gates: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`.
- No drag-and-drop or split-pane library.
- Motion only under `prefers-reduced-motion: no-preference`. No CSS `zoom` on an ancestor of an xterm.
- Below `PHONE`: one panel at a time, no drag, no splits. The phone dock is unchanged.
- Every UI task ends with a real browser check on a scratch server, with playwright-cli and a resize.
- Commit per task, never amend, no backticks in commit messages. Unslop for comments and copy.

## Review focus

1. **A drag that ends over an iframe or a terminal.** Without the shield, the iframe swallows `pointerup` and the drag never ends. The shield covers the dock from the first move past the slop until release or cancel. Task 6.
2. **A saved layout that no longer matches the open panels.** It names closed ids, misses open ones, has shares that do not sum to 1, or is not an object at all. `place` and `normalizeLayout` repair each case. Tasks 1 and 4.
3. **The last panel leaving a cell or a column.** The empty cell goes, its share passes to its neighbors, and an empty column goes. The active panel moves the way `nextActive` already decides. Task 1.
4. **Shares that round badly.** Three cells at 1/3 each still give a grid whose row tracks line up across columns. `gridOf` merges boundaries closer than 0.001. Task 2.
5. **Switching "side by side" and "as tabs" with a split layout open.** Each switch regroups everything into the named arrangement and loses no panel. Undo is switching back, which gives a flat arrangement, not the old split one; the gear says so. Task 4.

---

## File structure

| File | What changes |
|---|---|
| `ui/src/grid.ts`, `ui/src/grid.test.ts` (new, pure) | the model, `place`, `moveTo`, `regroup`, `resizeColumn`, `resizeSeam`, `activate`, `panelsOf`, `normalizeLayout`, `dropZone`, `gridOf` |
| `ui/src/store.ts` | `dockLayout` in `Layout` and `SCREEN_LAYOUT`; migration from `panelWidths`, `dockWidth` and `openIn`; `openPanel`, `closePanel`, `movePanel`, `popOut` and `returnPanel` go through `place`; new `dropPanel`, `resizeColumn`, `resizeSeam` |
| `ui/src/components/Dock.tsx` | the grid render, cell strips, seams, the pointer drag with shield and preview, gear entries |
| `ui/src/styles.css` | `.dock.grid`, `.cell-strip`, `.seam-col`, `.seam-row`, `.drag-shield`, `.drop-preview` |
| `docs/architecture.md` | "Layout and motion", "ui/" |

---

## Task 1: the model and its operations

**Files:**
- Create: `ui/src/grid.ts`, `ui/src/grid.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DockCell { id: string; panels: string[]; active: string; share: number }
export interface DockColumn { id: string; width: number; cells: DockCell[] }
export interface DockLayout { columns: DockColumn[] }
export type Zone = "center" | "above" | "below" | "left" | "right";
export type Arrangement = "columns" | "tabs";

export function panelsOf(l: DockLayout): string[];
export function place(l: DockLayout, open: readonly string[], active: string | null, into: Arrangement, newWidth: number): DockLayout;
export function moveTo(l: DockLayout, id: string, target: { cell: string; zone: Zone }, newWidth: number): DockLayout;
export function regroup(l: DockLayout, into: Arrangement, width: number): DockLayout;
export function resizeColumn(l: DockLayout, column: string, px: number, min: number, max: number): DockLayout;
export function resizeSeam(l: DockLayout, column: string, index: number, at: number): DockLayout;
export function activate(l: DockLayout, id: string): DockLayout;
export function cellOf(l: DockLayout, id: string): DockCell | undefined;
```

Ids for new cells and columns come from a counter in the function: `c${n}`, where `n` is one more than the highest numeric suffix in the layout. Generating them that way keeps the functions pure and the tests deterministic.

- [ ] **Step 1: Write the failing tests**, `ui/src/grid.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { activate, cellOf, moveTo, panelsOf, place, regroup, resizeSeam } from "./grid";
import type { DockLayout } from "./grid";

const W = 440;
const empty: DockLayout = { columns: [] };
const cols = (l: DockLayout) => l.columns.map((c) => c.cells.map((x) => x.panels));

describe("placing the open panels", () => {
  test("side by side: a new panel is a new column", () => {
    const l = place(empty, ["a", "b"], "b", "columns", W);
    expect(cols(l)).toEqual([[["a"]], [["b"]]]);
  });
  test("as tabs: a new panel joins the active cell", () => {
    const l = place(place(empty, ["a"], "a", "tabs", W), ["a", "b"], "b", "tabs", W);
    expect(cols(l)).toEqual([[["a", "b"]]]);
    expect(cellOf(l, "b")?.active).toBe("b");
  });
  test("a closed panel leaves; an emptied cell and column go, shares refilled", () => {
    let l = place(empty, ["a", "b"], "a", "columns", W);
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    expect(cols(l)).toEqual([[["a"], ["b"]]]);
    l = place(l, ["a"], "a", "columns", W);
    expect(cols(l)).toEqual([[["a"]]]);
    expect(l.columns[0]?.cells[0]?.share).toBe(1);
  });
  test("the flat order reads columns left to right, cells top to bottom, tabs in order", () => {
    let l = place(empty, ["a", "b", "c"], "a", "columns", W);
    l = moveTo(l, "c", { cell: cellOf(l, "a")?.id ?? "", zone: "center" }, W);
    expect(panelsOf(l)).toEqual(["a", "c", "b"]);
  });
});

describe("moving a panel", () => {
  const three = () => place(empty, ["a", "b", "c"], "a", "columns", W);
  test("center joins the cell as its active tab", () => {
    const l = three();
    const m = moveTo(l, "c", { cell: cellOf(l, "a")?.id ?? "", zone: "center" }, W);
    expect(cols(m)).toEqual([[["a", "c"]], [["b"]]]);
    expect(cellOf(m, "c")?.active).toBe("c");
  });
  test("below splits the target cell in half", () => {
    const l = three();
    const m = moveTo(l, "c", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    expect(cols(m)).toEqual([[["a"], ["c"]], [["b"]]]);
    expect(m.columns[0]?.cells.map((c) => c.share)).toEqual([0.5, 0.5]);
  });
  test("left and right make a new column beside the target's", () => {
    const l = three();
    expect(cols(moveTo(l, "c", { cell: cellOf(l, "a")?.id ?? "", zone: "left" }, W))).toEqual([[["c"]], [["a"]], [["b"]]]);
    expect(cols(moveTo(l, "a", { cell: cellOf(l, "c")?.id ?? "", zone: "right" }, W))).toEqual([[["b"]], [["c"]], [["a"]]]);
  });
  test("dropping a lone panel on its own cell changes nothing", () => {
    const l = three();
    expect(moveTo(l, "a", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W)).toEqual(l);
  });
  test("an unknown id or cell changes nothing", () => {
    const l = three();
    expect(moveTo(l, "zzz", { cell: cellOf(l, "a")?.id ?? "", zone: "center" }, W)).toEqual(l);
    expect(moveTo(l, "a", { cell: "nope", zone: "center" }, W)).toEqual(l);
  });
});

describe("regroup, seams and the active tab", () => {
  test("regroup to tabs puts everything in one cell, and back to columns one each", () => {
    const l = place(empty, ["a", "b"], "a", "columns", W);
    expect(cols(regroup(l, "tabs", W))).toEqual([[["a", "b"]]]);
    expect(cols(regroup(regroup(l, "tabs", W), "columns", W))).toEqual([[["a"]], [["b"]]]);
  });
  test("a seam moves within limits", () => {
    let l = place(empty, ["a", "b"], "a", "columns", W);
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    const col = l.columns[0]?.id ?? "";
    expect(resizeSeam(l, col, 0, 0.7).columns[0]?.cells.map((c) => c.share)).toEqual([0.7, 0.3]);
    expect(resizeSeam(l, col, 0, 0.99).columns[0]?.cells.map((c) => Math.round(c.share * 100) / 100)).toEqual([0.9, 0.1]);
  });
  test("activate shows the panel in its cell", () => {
    const l = place(place(empty, ["a"], "a", "tabs", W), ["a", "b"], "b", "tabs", W);
    expect(cellOf(activate(l, "a"), "a")?.active).toBe("a");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/grid.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement** `ui/src/grid.ts`, with these rules:

- `newId(l)` returns `c${max+1}` over every column and cell id.
- `prune(l)` does four things:
  1. Drops cells with no panels.
  2. Drops columns with no cells.
  3. Renormalizes each column's shares to sum to 1, scaling the survivors.
  4. Fixes each cell's `active` to one of its panels. A stale one becomes `nextActive(oldPanels, gone, active)` from `dock.ts`, else the first panel.
- `remove(l, id)` takes `id` out of its cell's `panels` and then calls `prune`.
- `place`:
  1. Remove every id not in `open`.
  2. For each id in `open` that the layout lacks, add it. With `columns`, that is a new column of width `newWidth` holding one cell `{ panels: [id], active: id, share: 1 }`. With `tabs`, it joins the cell holding `active`, else the last cell of the last column, else a first column. That cell's `active` becomes the id.
  3. Finally `activate(l, active)` when `active` is open.
- `moveTo`:
  - Return `l` unchanged when the id or the cell is missing.
  - Return it unchanged when the target is the id's own cell with only that panel (any zone).
  - Return it unchanged when the zone is `center` on its own cell.
  - Otherwise, remember the target cell's column and index *before* removing the id, since removal can renumber nothing but can drop the source column.
  - Remove the id, find the target again by id, then:
    - `center`: push the id and make it `active`;
    - `above` or `below`: halve the target's share and insert `{ id: newId, panels: [id], active: id, share: half }` before or after it;
    - `left` or `right`: insert a new column of width `newWidth` before or after the target's column.
- `regroup(l, "tabs", width)` is one column of `width` with one cell holding `panelsOf(l)`. `regroup(l, "columns", width)` gives each panel its own column. The old column widths are reused by position where they exist.
- `resizeSeam(l, column, index, at)` moves the boundary between cells `index` and `index + 1`. `at` is a fraction of the column's height from the top. Clamp so no cell is under 0.1, and leave the other cells' shares alone.
- `resizeColumn` clamps `px` to `[min, max]`.

Return new objects throughout and never mutate the input. The tests check the input is unchanged where it matters.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/grid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/grid.ts ui/src/grid.test.ts
git commit -m "feat(dock): a model of columns and tabbed cells"
```

---

## Task 2: the grid the model becomes

**Files:**
- Modify: `ui/src/grid.ts`, `ui/src/grid.test.ts`

**Interfaces:**
- Produces:

```ts
export interface GridPlan {
  /** grid-template-columns: a 6px seam then the column, per column */
  columns: string;
  /** grid-template-rows: the union of every column's cell boundaries, in fr */
  rows: string;
  /** each open panel's grid-area, whether it is its cell's active one, and whether its cell shows a strip */
  panels: Record<string, { area: string; shown: boolean; strip: boolean }>;
  strips: { cell: string; area: string; panels: string[]; active: string }[];
  colSeams: { column: string; area: string }[];
  rowSeams: { column: string; index: number; area: string }[];
}
export function gridOf(l: DockLayout): GridPlan;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { gridOf } from "./grid";

describe("the grid", () => {
  test("two side-by-side panels: one row, a seam before each column", () => {
    const g = gridOf(place(empty, ["a", "b"], "a", "columns", 440));
    expect(g.columns).toBe("6px 440px 6px 440px");
    expect(g.rows).toBe("1000fr");
    expect(g.panels["a"]).toEqual({ area: "1 / 2 / 2 / 3", shown: true, strip: false });
    expect(g.panels["b"]?.area).toBe("1 / 4 / 2 / 5");
    expect(g.colSeams.map((s) => s.area)).toEqual(["1 / 1 / 2 / 2", "1 / 3 / 2 / 4"]);
  });
  test("a split column and a whole one share row lines", () => {
    let l = place(empty, ["a", "b", "c"], "a", "columns", 440);
    l = moveTo(l, "c", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, 440);
    const g = gridOf(l);
    expect(g.rows).toBe("500fr 500fr");
    expect(g.panels["a"]?.area).toBe("1 / 2 / 2 / 3");
    expect(g.panels["c"]?.area).toBe("2 / 2 / 3 / 3");
    expect(g.panels["b"]?.area).toBe("1 / 4 / 3 / 5");
    expect(g.rowSeams).toEqual([{ column: l.columns[0]?.id ?? "", index: 0, area: "2 / 2 / 3 / 3" }]);
  });
  test("thirds against halves line up without slivers", () => {
    let l = place(empty, ["a", "b", "c", "d", "e"], "a", "columns", 300);
    const first = cellOf(l, "a")?.id ?? "";
    l = moveTo(l, "b", { cell: first, zone: "below" }, 300);
    l = moveTo(l, "c", { cell: cellOf(l, "b")?.id ?? "", zone: "below" }, 300);
    l = resizeSeam(l, l.columns[0]?.id ?? "", 0, 1 / 3);
    l = resizeSeam(l, l.columns[0]?.id ?? "", 1, 2 / 3);
    l = moveTo(l, "e", { cell: cellOf(l, "d")?.id ?? "", zone: "below" }, 300);
    const g = gridOf(l);
    // boundaries 1/3, 1/2, 2/3: four rows, none under 0.001
    expect(g.rows.split(" ").length).toBe(4);
  });
  test("a tabbed cell shows its strip and hides all but its active panel", () => {
    const l = place(place(empty, ["a"], "a", "tabs", 440), ["a", "b"], "b", "tabs", 440);
    const g = gridOf(l);
    expect(g.panels["a"]).toMatchObject({ shown: false, strip: true });
    expect(g.panels["b"]).toMatchObject({ shown: true, strip: true });
    expect(g.strips).toEqual([{ cell: l.columns[0]?.cells[0]?.id ?? "", area: "1 / 2 / 2 / 3", panels: ["a", "b"], active: "b" }]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/grid.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `gridOf`:**

1. Gather every column's boundaries as cumulative shares, including 0 and 1. Sort them and merge any two closer than 0.001.
2. Row tracks are `Math.round((b[i+1] - b[i]) * 1000) + "fr"`.
3. A cell's row start is `indexOf(nearest boundary to its top) + 1` and its row end is `indexOf(nearest boundary to its bottom) + 1`.
4. Column `i`'s seam is at grid column `2i + 1` and its body at `2i + 2`.
5. Areas are written `rowStart / colStart / rowEnd / colEnd`.
6. Strips appear only for cells with more than one panel. A cell with one panel shows no strip, so it looks like today's side-by-side panel.
7. Row seams sit in the body column at the lower cell's area. CSS puts them at the top edge, `align-self: start` with a −3px margin.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/grid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/grid.ts ui/src/grid.test.ts
git commit -m "feat(dock): turn the layout into one CSS grid"
```

---

## Task 3: where a drop lands

**Files:**
- Modify: `ui/src/grid.ts`, `ui/src/grid.test.ts`

**Interfaces:**
- Produces: `dropZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone` and `EDGE = 0.25`.

- [ ] **Step 1: Write the failing tests**

```ts
import { dropZone } from "./grid";

describe("drop zones", () => {
  const r = { left: 0, top: 0, width: 400, height: 800 };
  test("the middle joins as a tab", () => expect(dropZone(r, 200, 400)).toBe("center"));
  test("near an edge splits toward it", () => {
    expect(dropZone(r, 200, 780)).toBe("below");
    expect(dropZone(r, 200, 20)).toBe("above");
    expect(dropZone(r, 10, 400)).toBe("left");
    expect(dropZone(r, 390, 400)).toBe("right");
  });
  test("a corner goes to the nearer edge", () => {
    expect(dropZone(r, 20, 790)).toBe("below");
    expect(dropZone(r, 5, 700)).toBe("left");
  });
  test("outside the rect clamps to the nearest edge", () => expect(dropZone(r, -50, 400)).toBe("left"));
});
```

The corner cases compare edge distances as fractions of each side: (20, 790) is 0.05 from the left and 0.0125 from the bottom.

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/grid.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** how near an edge, as a fraction of that side, a drop must be to split */
export const EDGE = 0.25;

export function dropZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const fx = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  const fy = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
  const edges: [Zone, number][] = [["left", fx], ["right", 1 - fx], ["above", fy], ["below", 1 - fy]];
  const [zone, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return d < EDGE ? zone : "center";
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/grid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/grid.ts ui/src/grid.test.ts
git commit -m "feat(dock): which edge a dropped tab splits toward"
```

---

## Task 4: the store keeps the layout

**Files:**
- Modify: `ui/src/store.ts` (`Layout`, `SCREEN_LAYOUT`, `layoutOf`, the loader, `openPanel` :1884, `showPanel` :1890, `closePanel` :1913, `movePanel`, `popOut`, `returnPanel`, `setPanelWidth`, `setDockWidth`, the `openIn` setting's effect)
- Modify: `ui/src/grid.ts` (`normalizeLayout`, `fromLegacy`)
- Test: `ui/src/grid.test.ts`, `ui/src/store.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - `normalizeLayout(v: unknown): DockLayout | null`.
  - `fromLegacy(panels: readonly string[], active: string | null, widths: Record<string, number>, dockWidth: number, into: Arrangement): DockLayout`.
  - Store: `dockLayout: DockLayout`, plus `dropPanel(id, cell, zone)`, `resizeColumn(column, px)` and `resizeSeam(column, index, at)`.
  - Invariant: `panels` equals `panelsOf(dockLayout)` after every action.

- [ ] **Step 1: Write the failing tests**

`grid.test.ts`:

```ts
import { fromLegacy, normalizeLayout } from "./grid";

test("a saved layout is repaired or refused", () => {
  expect(normalizeLayout("x")).toBeNull();
  expect(normalizeLayout({ columns: "x" })).toBeNull();
  const fixed = normalizeLayout({ columns: [{ id: "c1", width: 400, cells: [{ id: "c2", panels: ["a", 7], active: "zzz", share: 3 }] }] });
  expect(fixed?.columns[0]?.cells[0]).toEqual({ id: "c2", panels: ["a"], active: "a", share: 1 });
});

test("legacy widths and mode become a layout", () => {
  expect(cols(fromLegacy(["a", "b"], "b", { a: 500 }, 600, "columns"))).toEqual([[["a"]], [["b"]]]);
  expect(fromLegacy(["a", "b"], "b", { a: 500 }, 600, "columns").columns.map((c) => c.width)).toEqual([500, 440]);
  expect(fromLegacy(["a", "b"], "b", {}, 600, "tabs").columns[0]?.width).toBe(600);
});
```

`store.test.ts`:

```ts
test("panels always mirror the layout", () => {
  const st = useStore.getState();
  useStore.setState({ panels: [], dockLayout: { columns: [] } });
  st.openPanel("a");
  st.openPanel("b");
  const cell = cellOf(useStore.getState().dockLayout, "a")?.id ?? "";
  useStore.getState().dropPanel("b", cell, "below");
  expect(useStore.getState().panels).toEqual(panelsOf(useStore.getState().dockLayout));
  useStore.getState().closePanel("a");
  expect(useStore.getState().panels).toEqual(["b"]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/grid.test.ts ui/src/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **`normalizeLayout`** keeps:
  - columns with string `id`s and finite widths (default 440);
  - cells with string ids and string panels;
  - a `share` that is a finite positive number.
  It drops repeated panel ids after the first, then runs `prune` from Task 1, which refixes `active` and renormalizes shares.
- **`fromLegacy`** is `place({ columns: [] }, panels, active, into, PANEL.initial)`, then sets each one-panel column's width from `widths[id]`. In tabs mode the single column's width is `dockWidth`.
- **`dockLayout` in the store.**
  - It goes into `Layout`, `layoutOf` and `SCREEN_LAYOUT`.
  - On load: when the saved `dockLayout` is null after normalization, build it with `fromLegacy(saved.panels, saved.activePanel, saved.panelWidths, saved.dockWidth, settings.openIn === "tabs" ? "tabs" : "columns")`.
  - After loading, always run `place(layout, panels, activePanel, ...)`, so a layout from another screen class matches this window's open set.
- **Every action that changes the open set** computes the new layout first and sets `panels: panelsOf(layout)` in the same `set`. That covers `openPanel`, `closePanel`, `popOut`, `returnPanel` and the scan's pruning of gone repos (find where `panels` is pruned now).
  - `showPanel` and `activePanel` map to `activate`.
  - `movePanel(id, to)` from phase A stays for the keyboard: it moves the id to the cell holding `panels[to]`, as `center`.
- **The `openIn` setting.** Flipping it calls `regroup(layout, openIn === "tabs" ? "tabs" : "columns", width)`. The gear entries keep their labels and gain the title "puts every open panel in this arrangement".
- **Old fields.** `panelWidths` and `dockWidth` stay readable for one release, for the migration, and are no longer written. Mark them in their comments as read only for the migration from before phase B.
- **Dockless windows** strip `dockLayout` from their patch, as they strip `panels`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/`
Expected: PASS, the old dock and store tests included. Old tests that assert `panelWidths` writes change to assert the column width in `dockLayout`; adjust them in this task.

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(dock): the store keeps the dock as columns of cells"
```

---

## Task 5: render the grid

**Files:**
- Modify: `ui/src/components/Dock.tsx` (`Dock`, `DockTabs` becomes `CellStrip`, the resizers)
- Modify: `ui/src/components/Resizer.tsx` (a horizontal direction, if it has none)
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: `gridOf`, the store actions from Task 4.

- [ ] **Step 1: Implement**

`Dock`:
- Compute `const g = useMemo(() => gridOf(layout), [layout])`.
- Render `<div className="dock grid" style={{ gridTemplateColumns: g.columns, gridTemplateRows: g.rows }}>`.
- Inside it, render `stableOrder(panels)` as `<RepoPanel key={id} id={id} area={g.panels[id]?.area} hidden={!g.panels[id]?.shown} strip={g.panels[id]?.strip} />`.
- Then the strips, then the seams, in any order. They carry no state worth keeping.
- `RepoPanel` sets `style.gridArea = area` and the class `has-strip` when `strip` is true.
- `.dock.tabbed`, the CSS `order` rules from phase A and the per-panel `Resizer` pairs go, replaced by:
  - **Column seams.** A `Resizer` placed at `colSeam.area` that writes `--col-w-<id>` live and calls `resizeColumn` on release. Its `target` is the dock and its `cssVar` is the column's own variable. `g.columns` then reads `var(--col-w-<id>, <width>px)` for each column, so a drag updates the track live without a render.
  - **Row seams.** A new `RowSeam` placed at `rowSeam.area` with `align-self: start`. Its pointer drag reads the column's height from the dock's `getBoundingClientRect()` and the grid's row positions, and calls `resizeSeam(column, index, at)` on release. During the drag, live feedback writes the dock's `grid-template-rows` straight onto the element. Release commits it through the store and the next render takes over.
- `CellStrip` is today's `DockTabs` markup, keyed by cell. It renders `strip.panels` with `strip.active` selected and is placed at `strip.area` with `align-self: start`.

`styles.css`:

```css
.dock.grid { display: grid; overflow: auto; }
.dock.grid > .panel { width: auto; min-width: 0; min-height: 0; }
.dock.grid > .panel.has-strip { padding-top: var(--strip-h, 34px); }
.dock.grid > .cell-strip { align-self: start; z-index: 1; block-size: var(--strip-h, 34px); }
.dock.grid > .seam-row { align-self: start; block-size: 6px; margin-block-start: -3px; cursor: row-resize; z-index: 2; }
```

Keep the carousel rules from phase A working. A grid wider than the dock scrolls sideways the same way, and `scroll-snap-align` moves onto the column seams.

- [ ] **Step 2: Gates, then the browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then:
1. With three panels side by side, check that it looks like phase A.
2. Flip to tabs and back, and check that no preview reloads (the iframe's navigation entry stays the same).
3. Resize a column, then reload, and check that the width is kept.
4. With a split made through the store from the console (`useStore.getState().dropPanel(...)`), drag the row seam and reload, and check that it is kept.
5. Resize the window to 1100px and 760px, and check that the grid does not overflow the page sideways outside the carousel.

- [ ] **Step 3: Commit**

```bash
git add ui/src
git commit -m "feat(dock): panels placed on one grid of columns and cells"
```

---

## Task 6: dragging tabs between cells

**Files:**
- Modify: `ui/src/components/Dock.tsx` (`CellStrip` tabs, the panel head, a `DragLayer`)
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: `dropZone`, `dropPanel`, `PAN_SLOP` (phase A).

- [ ] **Step 1: Implement**

Use pointer events, not HTML5 drag and drop, which cannot cross iframes reliably. Phase A's HTML5 reorder on heads and tabs is replaced by this one path.
- **`pointerdown`** on a tab or a panel head's background records `{ id, x0, y0 }`.
- **The first `pointermove` past `PAN_SLOP`:**
  - call `setPointerCapture`;
  - mount the `DragLayer`, a `.drag-shield` absolutely covering `.dock`, transparent, `z-index` above panels;
  - show a small ghost of the tab's label following the pointer.
- **Each move:**
  - find the cell under the pointer with `document.elementsFromPoint`, filtered to `.panel` elements, which carry `data-cell` from the grid plan;
  - read that panel's rect;
  - compute `dropZone(rect, x, y)`;
  - position a `.drop-preview` over the half or whole of that rect the zone means.
- **`pointerup`:** when there is a target, call `dropPanel(id, cell, zone)`. Then unmount the layer.
- **`pointercancel` and Escape:** unmount without moving.

On the keyboard, the panel gear's layout entries gain:
- "split below the panel on the left" and "move to a new column", which run `dropPanel` with the computed targets;
- "join the cell on the left" (`center` on the previous column's first cell).

Phase A's Alt+Shift+Arrow moves stay as they are.

Phones get no pointer drag and no split entries.

`styles.css`:

```css
.drag-shield { position: absolute; inset: 0; z-index: 5; cursor: grabbing; }
.drop-preview { position: fixed; pointer-events: none; z-index: 6; border: 2px solid var(--sky); background: color-mix(in srgb, var(--sky) 12%, transparent); border-radius: 4px; }
@media (prefers-reduced-motion: no-preference) {
  .drop-preview { transition: left 80ms ease-out, top 80ms ease-out, width 80ms ease-out, height 80ms ease-out; }
}
```

`.dock` needs `position: relative` for the shield. Check that this does not break the carousel's sticky elements.

- [ ] **Step 2: Gates, then the browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then, at 1440px with four panels, one with a live preview and one with a running shell:
1. Drag the shell panel's head over the preview panel's lower quarter and release. Check that a split forms below it, the preview's navigation entry is the same one, and the shell keeps its scrollback.
2. Drag a tab to the right edge of the last column. Check that a new column forms.
3. Drag a tab into the middle of another cell. Check that it joins as a tab.
4. Start a drag over the preview and release over the preview. Check that the drag ends, so the shield worked.
5. Press Escape mid-drag. Check that nothing moves.
6. At 390px, check that nothing drags.

- [ ] **Step 3: Commit**

```bash
git add ui/src
git commit -m "feat(dock): drag a tab into a cell, beside it or under it"
```

---

## Task 7: a full pass and the architecture note

**Files:**
- Modify: `docs/architecture.md`, sections "Layout and motion" and "ui/"

- [ ] **Step 1:** Run `~/.claude/skills/verify-build/clean-rebuild.sh rebuild`, then `verify "dockLayout"`.

- [ ] **Step 2: One end-to-end pass.**
1. Build a two-column layout with a split and a tabbed cell.
2. Pop one panel out and back. It returns to its old flat slot through `place`, as a new column in side-by-side mode or a tab in tabs mode; write down which.
3. Turn the carousel on and pan it.
4. Take one panel full screen.
5. Reload and check that the layout is kept.
6. Move the window to a smaller screen class with a resize to 1100px. Check that its own saved arrangement, or a fresh flat one, shows.
7. Resize back and check that the first arrangement returns.

- [ ] **Step 3: Write the notes.** Cover:
  - The model.
  - `gridOf` and its boundary merging.
  - That panels stay flat keyed children placed by `grid-area`.
  - The strips and seams as free elements.
  - The pointer drag with the shield.
  - `dockLayout` per screen class.
  - The migration from `panelWidths`, `dockWidth` and `openIn`.
  - That `panels` is always `panelsOf(dockLayout)`.

- [ ] **Step 4: Gates**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: the movable dock, phase B"
```
