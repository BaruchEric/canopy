import { describe, expect, test } from "bun:test";
import { activate, cellOf, moveTo, moveWithin, panelsOf, place, regroup, rename, resizeColumn, resizeSeam } from "./grid";
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
