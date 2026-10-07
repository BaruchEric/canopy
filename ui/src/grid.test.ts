import { describe, expect, test } from "bun:test";
import { activate, cellOf, columnOf, dropZone, fromLegacy, gridOf, moveCell, moveColumn, moveTo, moveWithin, normalizeLayout, panelsOf, place, regroup, rename, resizeColumn, resizeSeam } from "./grid";
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
