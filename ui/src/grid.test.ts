import { describe, expect, test } from "bun:test";
import { activate, cellOf, clipBox, columnOf, cssId, dropTarget, dropZone, fromLegacy, gearDrops, gridOf, gridTemplate, moveCell, moveColumn, moveTo, moveWithin, normalizeLayout, panelsOf, placements, place, regroup, rename, resizeColumn, resizeSeam, rowsTemplate, seamDrag, seamLabel, seamRange, seamStart, stepPanel, stripDrop, zoneRect } from "./grid";
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
  test("a closed active tab hands the cell to its neighbor", () => {
    let l = place(empty, ["a", "b", "c"], "b", "tabs", W);
    l = place(l, ["a", "c"], "a", "tabs", W);
    expect(cols(l)).toEqual([[["a", "c"]]]);
    const closing = place(place(empty, ["a", "b", "c"], "a", "tabs", W), ["a", "b", "c"], "b", "tabs", W);
    const after = place(closing, ["a", "c"], null, "tabs", W);
    expect(cellOf(after, "a")?.active).toBe("c");
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
  test("a drop that rebuilds the same arrangement gives back the layout itself", () => {
    const l = place(empty, ["a", "b"], "a", "columns", W);
    // beside its neighbour, on the side it already is
    expect(moveTo(l, "a", { cell: cellOf(l, "b")?.id ?? "", zone: "left" }, W)).toBe(l);
    expect(moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "right" }, W)).toBe(l);
    // over the cell below, in a stack whose seam the user moved
    const stack = resizeSeam(moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W), l.columns[0]?.id ?? "", 0, 0.7);
    expect(stack.columns[0]?.cells.map((x) => x.share)).toEqual([0.7, 0.3]);
    expect(moveTo(stack, "a", { cell: cellOf(stack, "b")?.id ?? "", zone: "above" }, W)).toBe(stack);
    expect(moveTo(stack, "b", { cell: cellOf(stack, "a")?.id ?? "", zone: "below" }, W)).toBe(stack);
    expect(dropTarget(stack, "a", { cell: cellOf(stack, "b")?.id ?? "", rect: { left: 0, top: 0, width: 400, height: 800 } }, 200, 10)).toBeNull();
  });
  test("an unknown id or cell changes nothing", () => {
    const l = three();
    expect(moveTo(l, "zzz", { cell: cellOf(l, "a")?.id ?? "", zone: "center" }, W)).toEqual(l);
    expect(moveTo(l, "a", { cell: "nope", zone: "center" }, W)).toEqual(l);
  });
  test("the input layout is never mutated", () => {
    const l = three();
    const before = JSON.stringify(l);
    moveTo(l, "c", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    regroup(l, "tabs", W);
    activate(l, "b");
    rename(l, "a", "z");
    expect(JSON.stringify(l)).toBe(before);
  });
  test("moveWithin joins a cell at a tab index, and reorders inside one", () => {
    let l = place(empty, ["a", "b", "c"], "a", "tabs", W);
    const cell = cellOf(l, "a")?.id ?? "";
    l = moveWithin(l, "c", cell, 0);
    expect(cols(l)).toEqual([[["c", "a", "b"]]]);
    expect(cellOf(l, "c")?.active).toBe("c");
    const sep = place(empty, ["a", "b"], "a", "columns", W);
    const joined = moveWithin(sep, "b", cellOf(sep, "a")?.id ?? "", 99);
    expect(cols(joined)).toEqual([[["a", "b"]]]);
  });
  test("moveWithin to the place a showing tab already has is the same layout", () => {
    const l = place(empty, ["a", "b", "c"], "c", "tabs", W);
    const cell = cellOf(l, "a")?.id ?? "";
    expect(moveWithin(l, "c", cell, 2)).toBe(l);
    expect(moveWithin(l, "c", cell, 99)).toBe(l);
    // the same place but not showing yet still changes: it shows
    expect(moveWithin(l, "a", cell, 0)).not.toBe(l);
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
    expect(resizeSeam(l, col, 0, 0.01).columns[0]?.cells.map((c) => c.share)).toEqual([0.1, 0.9]);
  });
  test("a column width is clamped", () => {
    const l = place(empty, ["a"], "a", "columns", W);
    const col = l.columns[0]?.id ?? "";
    expect(resizeColumn(l, col, 9000, 240, 2400).columns[0]?.width).toBe(2400);
    expect(resizeColumn(l, col, 10, 240, 2400).columns[0]?.width).toBe(240);
    expect(resizeColumn(l, col, 500, 240, 2400).columns[0]?.width).toBe(500);
  });
  test("a column held at its width, or at its limit, is the same layout", () => {
    const l = place(empty, ["a"], "a", "columns", W);
    const col = l.columns[0]?.id ?? "";
    expect(resizeColumn(l, col, W, 240, 2400)).toBe(l);
    const wide = resizeColumn(l, col, 9000, 240, 2400);
    expect(resizeColumn(wide, col, 9500, 240, 2400)).toBe(wide);
  });
  test("activate shows the panel in its cell", () => {
    const l = place(place(empty, ["a"], "a", "tabs", W), ["a", "b"], "b", "tabs", W);
    expect(cellOf(activate(l, "a"), "a")?.active).toBe("a");
  });
  test("rename swaps an id in place, keeping active; ids with slashes stay opaque", () => {
    const l = place(empty, ["a/x:1", "b"], "a/x:1", "tabs", W);
    const r = rename(l, "a/x:1", "q/y:2");
    expect(panelsOf(r)).toEqual(["q/y:2", "b"]);
    expect(cellOf(r, "q/y:2")?.active).toBe("q/y:2");
    expect(rename(l, "nope", "z")).toEqual(l);
  });
});

describe("the grid", () => {
  test("two side-by-side panels: one row, a seam before each column", () => {
    const l = place(empty, ["a", "b"], "a", "columns", 440);
    const g = gridOf(l);
    expect(g.columns).toBe("6px 440px 6px 440px");
    expect(g.rows).toBe("1000fr");
    expect(g.panels["a"]).toEqual({ area: "1 / 2 / 2 / 3", shown: true, strip: false, cell: cellOf(l, "a")?.id ?? "" });
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

describe("resizing rejects bad input", () => {
  const l = place(empty, ["a", "b"], "a", "columns", 440);
  const col = l.columns[0]?.id ?? "";
  test("a non-finite seam or width changes nothing", () => {
    expect(resizeColumn(l, col, Number.NaN, 200, 800)).toBe(l);
    expect(resizeColumn(l, col, Number.POSITIVE_INFINITY, 200, 800)).toBe(l);
    const split = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, 440);
    const c = split.columns[0]?.id ?? "";
    expect(resizeSeam(split, c, 0, Number.NaN)).toBe(split);
    expect(resizeSeam(split, c, 0, Number.POSITIVE_INFINITY)).toBe(split);
  });
  test("resizing an unknown column returns the layout itself", () => {
    expect(resizeColumn(l, "nope", 500, 200, 800)).toBe(l);
  });
});

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

describe("a pointer drop", () => {
  const r = { left: 440, top: 0, width: 400, height: 800 };
  const two = place(empty, ["a", "b"], "a", "columns", W);
  const cell = (l: DockLayout, id: string) => cellOf(l, id)?.id ?? "";
  test("nothing under the pointer is no drop", () => {
    expect(dropTarget(two, "a", null, 600, 700)).toBeNull();
  });
  test("another cell's lower quarter splits below it, its middle joins it", () => {
    const hit = { cell: cell(two, "b"), rect: r };
    expect(dropTarget(two, "a", hit, 640, 700)).toEqual({ cell: cell(two, "b"), zone: "below" });
    expect(dropTarget(two, "a", hit, 640, 400)).toEqual({ cell: cell(two, "b"), zone: "center" });
    expect(dropTarget(two, "a", hit, 830, 400)).toEqual({ cell: cell(two, "b"), zone: "right" });
  });
  test("a lone panel over its own cell, or any over its own middle, is no drop", () => {
    const own = { cell: cell(two, "a"), rect: r };
    expect(dropTarget(two, "a", own, 640, 700)).toBeNull();
    expect(dropTarget(two, "a", own, 640, 400)).toBeNull();
    const tabs = moveTo(two, "b", { cell: cell(two, "a"), zone: "center" }, W);
    const both = { cell: cell(tabs, "a"), rect: r };
    expect(dropTarget(tabs, "b", both, 640, 400)).toBeNull();
    // a tab over its own cell's edge leaves the cell for a split of it
    expect(dropTarget(tabs, "b", both, 640, 790)).toEqual({ cell: cell(tabs, "a"), zone: "below" });
  });
  test("a panel the layout does not hold is no drop", () => {
    expect(dropTarget(two, "zzz", { cell: cell(two, "b"), rect: r }, 640, 700)).toBeNull();
  });
  test("the preview covers the half an edge means, or all of the cell", () => {
    expect(zoneRect(r, "center")).toEqual(r);
    expect(zoneRect(r, "below")).toEqual({ left: 440, top: 400, width: 400, height: 400 });
    expect(zoneRect(r, "above")).toEqual({ left: 440, top: 0, width: 400, height: 400 });
    expect(zoneRect(r, "left")).toEqual({ left: 440, top: 0, width: 200, height: 800 });
    expect(zoneRect(r, "right")).toEqual({ left: 640, top: 0, width: 200, height: 800 });
  });
  test("a rect whose fields are getters, as a DOMRect's are, keeps them in the middle", () => {
    class Rect {
      get left() { return 440; }
      get top() { return 0; }
      get width() { return 400; }
      get height() { return 800; }
    }
    expect(zoneRect(new Rect(), "center")).toEqual(r);
  });
});

describe("a drop on a tab strip", () => {
  const cell = (l: DockLayout, id: string) => cellOf(l, id)?.id ?? "";
  // one cell of a, b, c as tabs, each tab 100px wide from x = 0, a showing
  const tabs = activate(place(empty, ["a", "b", "c"], "a", "tabs", W), "a");
  const boxes = [
    { id: "a", left: 0, width: 100 },
    { id: "b", left: 100, width: 100 },
    { id: "c", left: 200, width: 100 },
  ];
  test("a tab dragged along its own strip reorders at the gap under the pointer", () => {
    const one = cell(tabs, "a");
    expect(stripDrop(tabs, "a", one, 160, boxes)).toEqual({ cell: one, index: 1, at: 200 });
    expect(stripDrop(tabs, "a", one, 290, boxes)).toEqual({ cell: one, index: 2, at: 300 });
    expect(stripDrop(tabs, "c", one, 10, boxes)).toEqual({ cell: one, index: 0, at: 0 });
    expect(stripDrop(tabs, "c", one, 120, boxes)).toEqual({ cell: one, index: 1, at: 100 });
    const moved = moveWithin(tabs, "a", one, 2);
    expect(cols(moved)).toEqual([[["b", "c", "a"]]]);
  });
  test("back at its own place, on either side of it, is no drop", () => {
    const one = cell(tabs, "a");
    expect(stripDrop(tabs, "a", one, 40, boxes)).toBeNull();
    expect(stripDrop(tabs, "a", one, 140, boxes)).toBeNull();
    // a tab not showing, too: letting it go there must not even show it
    expect(stripDrop(tabs, "b", one, 60, boxes)).toBeNull();
    expect(stripDrop(tabs, "b", one, 120, boxes)).toBeNull();
    expect(stripDrop(tabs, "b", one, 180, boxes)).toBeNull();
    expect(stripDrop(tabs, "b", one, 240, boxes)).toBeNull();
    expect(stripDrop(tabs, "b", one, 260, boxes)).toEqual({ cell: one, index: 2, at: 300 });
  });
  test("the tabs may come in any order; their places decide", () => {
    const one = cell(tabs, "a");
    expect(stripDrop(tabs, "a", one, 160, [...boxes].reverse())).toEqual({ cell: one, index: 1, at: 200 });
  });
  test("a panel from another cell joins the strip's cell at the gap", () => {
    const two = place(tabs, ["a", "b", "c", "d"], "d", "columns", W);
    expect(cols(two)).toEqual([[["a", "b", "c"]], [["d"]]]);
    const one = cell(two, "a");
    const drop = stripDrop(two, "d", one, 150, boxes);
    expect(drop).toEqual({ cell: one, index: 1, at: 100 });
    expect(cols(moveWithin(two, "d", one, drop?.index ?? -1))).toEqual([[["a", "d", "b", "c"]]]);
    expect(stripDrop(two, "d", one, 999, boxes)).toEqual({ cell: one, index: 3, at: 300 });
  });
  test("a cell or a panel the layout does not hold is no drop", () => {
    expect(stripDrop(tabs, "a", "c999", 160, boxes)).toBeNull();
    expect(stripDrop(tabs, "zzz", cell(tabs, "a"), 160, boxes)).toBeNull();
  });
  test("tabs drawn for panels the cell does not hold are passed over", () => {
    const one = cell(tabs, "a");
    const extra = [...boxes, { id: "zzz", left: 300, width: 100 }];
    expect(stripDrop(tabs, "a", one, 390, extra)).toEqual({ cell: one, index: 2, at: 300 });
  });
});

describe("the gear's layout moves", () => {
  const three = place(empty, ["a", "b", "c"], "a", "columns", W);
  const cell = (l: DockLayout, id: string) => cellOf(l, id)?.id ?? "";
  test("the first column has nothing on its left", () => {
    const g = gearDrops(three, "a");
    expect(g.splitLeft).toBeNull();
    expect(g.joinLeft).toBeNull();
  });
  test("split below the panel on the left, and join the cell on the left", () => {
    const g = gearDrops(three, "c");
    expect(g.splitLeft).toEqual({ cell: cell(three, "b"), zone: "below" });
    expect(g.joinLeft).toEqual({ cell: cell(three, "b"), zone: "center" });
    const split = moveTo(three, "c", g.splitLeft ?? { cell: "", zone: "center" }, W);
    expect(cols(split)).toEqual([[["a"]], [["b"], ["c"]]]);
    const joined = moveTo(three, "c", g.joinLeft ?? { cell: "", zone: "center" }, W);
    expect(cols(joined)).toEqual([[["a"]], [["b", "c"]]]);
  });
  test("split below goes under the last cell of a stacked column", () => {
    const stack = moveTo(three, "b", { cell: cell(three, "a"), zone: "below" }, W);
    const g = gearDrops(stack, "c");
    expect(g.splitLeft).toEqual({ cell: cell(stack, "b"), zone: "below" });
    expect(g.joinLeft).toEqual({ cell: cell(stack, "a"), zone: "center" });
  });
  test("a column of its own cannot move to a new one", () => {
    expect(gearDrops(three, "b").newColumn).toBeNull();
  });
  test("the bottom of a stack moves to a new column beside its own", () => {
    const stack = moveTo(three, "b", { cell: cell(three, "a"), zone: "below" }, W);
    const t = gearDrops(stack, "b").newColumn;
    expect(t).not.toBeNull();
    expect(cols(moveTo(stack, "b", t ?? { cell: "", zone: "center" }, W))).toEqual([[["a"]], [["b"]], [["c"]]]);
  });
  test("a tab moves out of its cell to a new column beside it", () => {
    const tabs = moveTo(three, "b", { cell: cell(three, "a"), zone: "center" }, W);
    const t = gearDrops(tabs, "b").newColumn;
    expect(t).not.toBeNull();
    expect(cols(moveTo(tabs, "b", t ?? { cell: "", zone: "center" }, W))).toEqual([[["a"]], [["b"]], [["c"]]]);
  });
  test("a panel the layout does not hold has no moves", () => {
    expect(gearDrops(three, "zzz")).toEqual({ splitLeft: null, newColumn: null, joinLeft: null });
  });
});

describe("a move one place left or right", () => {
  const four = place(empty, ["a", "b", "c", "d"], "a", "columns", W);
  const cell = (l: DockLayout, id: string) => cellOf(l, id)?.id ?? "";
  // [a, b] over [c], then [d]
  const tabs = moveTo(four, "b", { cell: cell(four, "a"), zone: "center" }, W);
  const stack = moveTo(tabs, "c", { cell: cell(tabs, "a"), zone: "below" }, W);
  test("an edge tab of a stacked cell goes nowhere, and its siblings never come along", () => {
    expect(cols(stack)).toEqual([[["a", "b"], ["c"]], [["d"]]]);
    expect(stepPanel(stack, "b", 2)).toBeNull();
    // [c] over [a, b]: a's left neighbour is the cell above it
    const above = moveCell(stack, cell(stack, "c"), 0);
    expect(cols(above)).toEqual([[["c"], ["a", "b"]], [["d"]]]);
    expect(stepPanel(above, "a", 0)).toBeNull();
  });
  test("a tab inside its cell reorders, the showing tab kept", () => {
    const moved = stepPanel(stack, "b", 0);
    expect(cols(moved ?? empty)).toEqual([[["b", "a"], ["c"]], [["d"]]]);
    expect(cellOf(moved ?? empty, "a")?.active).toBe(cellOf(stack, "a")?.active);
  });
  test("a lone column moves as a column, a single-tab cell up or down its column", () => {
    expect(cols(stepPanel(four, "c", 1) ?? empty)).toEqual([[["a"]], [["c"]], [["b"]], [["d"]]]);
    expect(cols(stepPanel(stack, "c", 1) ?? empty)).toEqual([[["c"], ["a", "b"]], [["d"]]]);
  });
  test("the top cell of a stack moved toward another column, or a panel moved onto itself, is no move", () => {
    const split = moveTo(four, "c", { cell: cell(four, "b"), zone: "below" }, W);
    expect(cols(split)).toEqual([[["a"]], [["b"], ["c"]], [["d"]]]);
    expect(stepPanel(split, "b", 0)).toBeNull();
    expect(stepPanel(split, "c", 3)).toBeNull();
    expect(stepPanel(four, "a", -1)).toBeNull();
    expect(stepPanel(four, "zzz", 0)).toBeNull();
  });
});

describe("saved layouts", () => {
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

  test("ids that are not c and a number, or repeat, are issued again", () => {
    const l = normalizeLayout({
      columns: [
        { id: "--x;", width: 400, cells: [{ id: "c1", panels: ["a"], active: "a", share: 1 }] },
        { id: "c1", width: 400, cells: [{ id: "c9999999", panels: ["b"], active: "b", share: 1 }] },
      ],
    });
    const ids = l?.columns.flatMap((c) => [c.id, ...c.cells.map((x) => x.id)]) ?? [];
    expect(ids.every((id) => /^c\d{1,6}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(4);
    expect(cols(l ?? empty)).toEqual([[["a"]], [["b"]]]);
  });

  test("a panel saved twice keeps its first place; bad entries and empty cells go", () => {
    const l = normalizeLayout({
      columns: [
        { id: "c1", width: 400, cells: [{ id: "c2", panels: ["a", "b"], active: "b", share: 1 }] },
        "junk",
        { id: "c3", width: "wide", cells: [{ id: "c4", panels: ["b"], active: "b", share: 1 }, { id: "c5", panels: ["c"], active: "c", share: 1 }, null] },
        { id: "c6", width: 400, cells: [{ id: "c7", panels: [], active: "", share: 1 }] },
      ],
    });
    expect(cols(l ?? empty)).toEqual([[["a", "b"]], [["c"]]]);
    expect(l?.columns[1]?.width).toBe(440);
    expect(l?.columns[1]?.cells[0]?.share).toBe(1);
  });

  test("shares become finite and positive, sum to 1 per column, and none is a sliver", () => {
    const l = normalizeLayout({
      columns: [
        {
          id: "c1",
          width: 400,
          cells: [
            { id: "c2", panels: ["a"], active: "a", share: -2 },
            { id: "c3", panels: ["b"], active: "b", share: Number.NaN },
            { id: "c4", panels: ["c"], active: "c", share: 1e-9 },
            { id: "c5", panels: ["d"], active: "d", share: 2 },
          ],
        },
      ],
    });
    const shares = l?.columns[0]?.cells.map((x) => x.share) ?? [];
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0.1);
    expect(shares.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
  });
});

test("a column with more cells than the floor allows shares equally", () => {
  const cells = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 2}`, panels: [`p${i}`], active: `p${i}`, share: i === 0 ? 100 : 1 }));
  const l = normalizeLayout({ columns: [{ id: "c1", width: 400, cells }] });
  const shares = l?.columns[0]?.cells.map((x) => x.share) ?? [];
  expect(shares).toHaveLength(12);
  for (const x of shares) expect(x).toBeCloseTo(1 / 12, 5);
});

describe("moves that keep sizes", () => {
  test("a column moves whole, with its width", () => {
    let l = place(empty, ["a", "b", "c"], "a", "columns", W);
    l = resizeColumn(l, l.columns[2]?.id ?? "", 600, 200, 800);
    const moved = moveColumn(l, l.columns[2]?.id ?? "", 0);
    expect(cols(moved)).toEqual([[["c"]], [["a"]], [["b"]]]);
    expect(moved.columns[0]?.width).toBe(600);
    expect(moveColumn(l, l.columns[0]?.id ?? "", 0)).toBe(l);
    expect(moveColumn(l, "nope", 1)).toBe(l);
  });

  test("a cell moves up or down its column, with its share", () => {
    let l = place(empty, ["a", "b"], "a", "columns", W);
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    l = resizeSeam(l, l.columns[0]?.id ?? "", 0, 0.7);
    const moved = moveCell(l, cellOf(l, "b")?.id ?? "", 0);
    expect(cols(moved)).toEqual([[["b"], ["a"]]]);
    expect(moved.columns[0]?.cells.map((x) => x.share)).toEqual([0.3, 0.7]);
    expect(moveCell(l, cellOf(l, "a")?.id ?? "", 0)).toBe(l);
  });

  test("activating the tab already showing is no change", () => {
    const l = place(empty, ["a", "b"], "a", "tabs", W);
    expect(activate(l, "a")).toBe(l);
    expect(cellOf(activate(l, "b"), "a")?.active).toBe("b");
  });

  test("a new column takes the width asked for that panel", () => {
    const l = place(empty, ["a", "b"], "a", "columns", (id) => (id === "b" ? 520 : W));
    expect(l.columns.map((c) => c.width)).toEqual([440, 520]);
    expect(columnOf(l, "b")?.width).toBe(520);
    expect(columnOf(l, "zzz")).toBeUndefined();
  });
});

describe("the grid as the dock renders it", () => {
  test("an id becomes a custom property name that is safe, stable and its own", () => {
    for (const id of ["c1", "a/b", "a_b", "home:web/app", "x y", "\"};", ""]) expect(cssId(id)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cssId("a/b")).not.toBe(cssId("a_b"));
    expect(cssId("a/b")).not.toBe(cssId("a:b"));
    expect(cssId("home:web/app")).toBe(cssId("home:web/app"));
  });

  test("columns read their own variable, set from the layout; rows never force a scroll", () => {
    let l = place(empty, ["a", "b"], "a", "columns", (id) => (id === "b" ? 520 : W));
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    l = place(l, ["a", "b", "c"], "c", "columns", 600);
    const t = gridTemplate(l, gridOf(l));
    const [one, two] = l.columns.map((c) => `--col-w-${cssId(c.id)}`);
    expect(t.columns).toBe(`6px var(${one}, 440px) 6px var(${two}, 600px)`);
    expect(t.vars).toEqual({ [one ?? ""]: "440px", [two ?? ""]: "600px" });
    expect(t.rows).toBe("minmax(0, 500fr) minmax(0, 500fr)");
    expect(rowsTemplate("1000fr")).toBe("minmax(0, 1000fr)");
  });

  test("a row seam starts at its boundary and follows the pointer as a share of the height", () => {
    let l = place(empty, ["a", "b", "c"], "a", "columns", W);
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    l = moveTo(l, "c", { cell: cellOf(l, "b")?.id ?? "", zone: "below" }, W);
    const col = l.columns[0]?.id ?? "";
    expect(seamStart(l, col, 0)).toBeCloseTo(0.5);
    expect(seamStart(l, col, 1)).toBeCloseTo(0.75);
    expect(seamStart(l, col, 2)).toBeNull();
    expect(seamStart(l, "nope", 0)).toBeNull();
    expect(seamDrag(0.5, 100, 800)).toBeCloseTo(0.625);
    expect(seamDrag(0.5, -800, 800)).toBe(0);
    expect(seamDrag(0.5, 100, 0)).toBe(0.5);
  });

  test("a row seam's range stops short of each neighbouring boundary, and its reset splits the pair evenly", () => {
    let l = place(empty, ["a", "b", "c"], "a", "columns", W);
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    l = moveTo(l, "c", { cell: cellOf(l, "b")?.id ?? "", zone: "below" }, W);
    const col = l.columns[0]?.id ?? "";
    expect(seamRange(l, col, 0)).toEqual({ min: 0.1, max: 0.65, middle: 0.375 });
    expect(seamRange(l, col, 1)).toEqual({ min: 0.6, max: 0.9, middle: 0.75 });
    expect(seamRange(l, col, 2)).toBeNull();
    // each limit is where resizeSeam holds the boundary
    const range = seamRange(l, col, 0);
    expect(resizeSeam(l, col, 0, 0)).toEqual(resizeSeam(l, col, 0, range?.min ?? -1));
    expect(resizeSeam(l, col, 0, 1)).toEqual(resizeSeam(l, col, 0, range?.max ?? -1));
  });

  test("each panel's place: an area on the grid, or a CSS order in the flat phone dock", () => {
    let l = place(empty, ["a", "b", "c"], "a", "columns", W);
    l = moveTo(l, "c", { cell: cellOf(l, "a")?.id ?? "", zone: "center" }, W);
    const g = gridOf(l);
    const onGrid = placements(l, ["a", "b", "c", "z"], g);
    expect(onGrid.c).toEqual({ area: g.panels.c?.area, cell: g.panels.c?.cell, hidden: false, strip: true });
    expect(onGrid.a).toEqual({ area: g.panels.a?.area, cell: g.panels.a?.cell, hidden: true, strip: true });
    expect(onGrid.b).toEqual({ area: g.panels.b?.area, cell: g.panels.b?.cell, hidden: false, strip: false });
    // a panel the layout does not hold yet takes no room rather than auto-placing
    expect(onGrid.z).toEqual({ hidden: true, strip: false });
    // flat, side by side on a phone: every panel shows in the layout's order, no splits
    const flat = placements(l, ["a", "b", "c", "z"], null);
    expect(flat).toEqual({
      a: { order: 0, hidden: false, strip: false },
      c: { order: 1, hidden: false, strip: false },
      b: { order: 2, hidden: false, strip: false },
      z: { order: 3, hidden: false, strip: false },
    });
    // tabs on a phone: one strip of every panel, and only the one showing
    const tabs = placements(l, ["a", "b", "c", "z"], null, "b");
    expect(tabs).toEqual({
      a: { order: 0, hidden: true, strip: true },
      c: { order: 1, hidden: true, strip: true },
      b: { order: 2, hidden: false, strip: true },
      z: { order: 3, hidden: true, strip: true },
    });
  });

  test("a lone column under the carousel fills the dock", () => {
    const l = place(empty, ["a", "b"], "a", "tabs", W);
    const t = gridTemplate(l, gridOf(l), true);
    expect(t.columns).toBe("0 minmax(0, 1fr)");
    expect(gridTemplate(l, gridOf(l)).columns).toBe(`6px var(--col-w-${cssId(l.columns[0]?.id ?? "")}, 440px)`);
  });

  test("a seam moved nowhere, or past its limit, is the same layout", () => {
    let l = place(empty, ["a", "b"], "a", "columns", W);
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    const col = l.columns[0]?.id ?? "";
    expect(resizeSeam(l, col, 0, 0.5)).toBe(l);
    const low = resizeSeam(l, col, 0, 0.1);
    expect(resizeSeam(low, col, 0, 0.08)).toBe(low);
    expect(resizeSeam(l, col, 0, 0.6)).not.toBe(l);
  });

  test("a row seam is named after the cells it sits between", () => {
    let l = place(empty, ["a", "b", "c"], "a", "columns", W);
    l = moveTo(l, "b", { cell: cellOf(l, "a")?.id ?? "", zone: "below" }, W);
    l = moveTo(l, "c", { cell: cellOf(l, "b")?.id ?? "", zone: "center" }, W);
    const col = l.columns[0]?.id ?? "";
    const name = (id: string) => id.toUpperCase();
    expect(seamLabel(l, col, 0, name)).toBe("Height of A and C");
    expect(seamLabel(l, "nope", 0, name)).toBe("Height of the cells above and below");
  });
});

describe("clipBox", () => {
  const view = { left: 590, top: 80, width: 849, height: 820 };

  test("a preview reaching past the dock's left edge is cut at it", () => {
    expect(clipBox({ left: 554, top: 100, width: 440, height: 400 }, view)).toEqual({ left: 590, top: 100, width: 404, height: 400 });
  });

  test("a preview inside the dock is left as it is", () => {
    expect(clipBox({ left: 700, top: 100, width: 200, height: 300 }, view)).toEqual({ left: 700, top: 100, width: 200, height: 300 });
  });

  test("a preview the dock does not show at all is none", () => {
    expect(clipBox({ left: 560, top: 100, width: 3, height: 30 }, view)).toBeNull();
  });
});
