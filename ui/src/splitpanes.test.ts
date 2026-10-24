import { describe, expect, test } from "bun:test";
import {
  AT_MAX,
  AT_MIN,
  atFrom,
  boxesOf,
  dropBox,
  dropPane,
  edgeAt,
  headOf,
  leaveGroup,
  neighbourOf,
  paneIds,
  pruneGroups,
  rowOf,
  seamsOf,
  setAt,
  splitIn,
  splitPane,
  splitsOf,
  type PaneTree,
} from "./splitpanes";

const pane = (id: string): PaneTree => ({ pane: id });
// a | (b over c)
const three: PaneTree = { dir: "row", at: 0.5, a: pane("a"), b: { dir: "col", at: 0.5, a: pane("b"), b: pane("c") } };

describe("splitPane", () => {
  test("right and down put the new pane after", () => {
    expect(splitPane(pane("a"), "a", "b", "right")).toEqual({ dir: "row", at: 0.5, a: pane("a"), b: pane("b") });
    expect(splitPane(pane("a"), "a", "b", "bottom")).toEqual({ dir: "col", at: 0.5, a: pane("a"), b: pane("b") });
  });

  test("left and top put it before", () => {
    expect(splitPane(pane("a"), "a", "b", "left")).toEqual({ dir: "row", at: 0.5, a: pane("b"), b: pane("a") });
    expect(splitPane(pane("a"), "a", "b", "top")).toEqual({ dir: "col", at: 0.5, a: pane("b"), b: pane("a") });
  });

  test("splits only the pane named, deep in a tree", () => {
    expect(paneIds(splitPane(three, "c", "d", "right"))).toEqual(["a", "b", "c", "d"]);
    expect(paneIds(splitPane(three, "x", "d", "right"))).toEqual(["a", "b", "c"]);
  });
});

describe("dropPane", () => {
  test("the sibling takes the room", () => {
    expect(dropPane(three, "a")).toEqual({ dir: "col", at: 0.5, a: pane("b"), b: pane("c") });
    expect(dropPane(three, "c")).toEqual({ dir: "row", at: 0.5, a: pane("a"), b: pane("b") });
  });

  test("the last pane leaves nothing", () => {
    expect(dropPane(pane("a"), "a")).toBeNull();
  });

  test("a pane not there leaves the same tree", () => {
    expect(dropPane(three, "x")).toBe(three);
  });
});

describe("boxesOf and seamsOf", () => {
  test("each pane's part of the whole", () => {
    const tree = setAt(three, "", 0.25);
    expect(boxesOf(tree)).toEqual({
      a: { x: 0, y: 0, w: 0.25, h: 1 },
      b: { x: 0.25, y: 0, w: 0.75, h: 0.5 },
      c: { x: 0.25, y: 0.5, w: 0.75, h: 0.5 },
    });
  });

  test("a seam per split, outermost first, with a path back to it", () => {
    const seams = seamsOf(three);
    expect(seams.map((s) => [s.path, s.dir])).toEqual([
      ["", "row"],
      ["b", "col"],
    ]);
    expect(seams[1]?.box).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  test("a single pane has no seams", () => {
    expect(seamsOf(pane("a"))).toEqual([]);
  });
});

describe("setAt and atFrom", () => {
  test("setAt finds the split by path and holds it in bounds", () => {
    const moved = setAt(three, "b", 0.7);
    expect(moved).toMatchObject({ b: { at: 0.7 } });
    expect(setAt(three, "", 0)).toMatchObject({ at: AT_MIN });
    expect(setAt(three, "", 2)).toMatchObject({ at: AT_MAX });
  });

  test("atFrom reads the pointer inside the seam's own split", () => {
    const [outer, inner] = seamsOf(three);
    if (!outer || !inner) throw new Error("no seams");
    // the main pane from 100 px, 800 px long
    expect(atFrom(outer, 300, 100, 800)).toBe(0.25);
    // the inner split runs the right half, from x 0.5
    expect(atFrom({ ...inner, dir: "row" }, 100 + 400 + 100, 100, 800)).toBe(0.25);
    expect(atFrom(outer, 0, 100, 800)).toBe(AT_MIN);
    expect(atFrom(outer, 300, 100, 0)).toBe(outer.at);
  });
});

describe("edgeAt and dropBox", () => {
  test("the nearest edge, cut on the diagonals", () => {
    expect(edgeAt(0.1, 0.5)).toBe("left");
    expect(edgeAt(0.9, 0.5)).toBe("right");
    expect(edgeAt(0.5, 0.1)).toBe("top");
    expect(edgeAt(0.5, 0.9)).toBe("bottom");
    expect(edgeAt(0.8, 0.3)).toBe("right");
  });

  test("the half a drop would take", () => {
    const box = { x: 0.5, y: 0, w: 0.5, h: 1 };
    expect(dropBox(box, "right")).toEqual({ x: 0.75, y: 0, w: 0.25, h: 1 });
    expect(dropBox(box, "bottom")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});

describe("neighbourOf", () => {
  test("the nearest pane on the other side of its split", () => {
    expect(neighbourOf(three, "a")).toBe("b");
    expect(neighbourOf(three, "b")).toBe("c");
    expect(neighbourOf(three, "c")).toBe("b");
    expect(neighbourOf(pane("a"), "a")).toBeNull();
  });
});

describe("groups", () => {
  test("splitIn makes a group of two, then grows it", () => {
    const one = splitIn([], "a", "b", "right");
    expect(one).toEqual([{ dir: "row", at: 0.5, a: pane("a"), b: pane("b") }]);
    const two = splitIn(one, "b", "c", "bottom");
    expect(two.length).toBe(1);
    expect(paneIds(two[0] ?? pane("?"))).toEqual(["a", "b", "c"]);
  });

  test("splitIn moves a pane between groups, and inside its own", () => {
    const groups = [...splitIn([], "a", "b", "right"), ...splitIn([], "c", "d", "right")];
    const moved = splitIn(groups, "c", "b", "left");
    // a is alone again, so its group is gone
    expect(moved.map(paneIds)).toEqual([["b", "c", "d"]]);
    const inside = splitIn([three], "a", "c", "bottom");
    expect(inside.map(paneIds)).toEqual([["a", "c", "b"]]);
  });

  test("splitIn beside itself changes nothing", () => {
    expect(splitIn([three], "a", "a", "right")).toEqual([three]);
  });

  test("leaveGroup drops the pane and a group left alone", () => {
    expect(leaveGroup([three], "b").map(paneIds)).toEqual([["a", "c"]]);
    expect(leaveGroup(splitIn([], "a", "b", "right"), "a")).toEqual([]);
  });

  test("pruneGroups keeps the open tabs only", () => {
    expect(pruneGroups([three], new Set(["a", "c"])).map(paneIds)).toEqual([["a", "c"]]);
    expect(pruneGroups([three], new Set(["a"]))).toEqual([]);
  });

  test("rowOf shows a group as its first tab in the row", () => {
    const tabs = [{ id: "c" }, { id: "x" }, { id: "a" }, { id: "b" }];
    const { row, panes } = rowOf(tabs, [three]);
    expect(row.map((t) => t.id)).toEqual(["c", "x"]);
    expect(panes).toEqual({ c: 3 });
    expect(headOf(row, [three], "b")).toBe("c");
    expect(headOf(row, [three], "x")).toBe("x");
    expect(headOf(row, [three], null)).toBeNull();
  });
});

describe("splitsOf", () => {
  test("reads back whole groups", () => {
    expect(splitsOf([three])).toEqual([three]);
  });

  test("drops junk, lone panes and a tab in two groups", () => {
    const again = { dir: "col", at: 0.5, a: pane("a"), b: pane("z") };
    expect(splitsOf([three, again])).toEqual([three]);
    expect(splitsOf([pane("a"), { dir: "diag", at: 0.5, a: pane("a"), b: pane("b") }, null, 3])).toEqual([]);
    expect(splitsOf("nope")).toEqual([]);
  });

  test("holds a saved share in bounds", () => {
    expect(splitsOf([{ dir: "row", at: 5, a: pane("a"), b: pane("b") }])).toEqual([{ dir: "row", at: AT_MAX, a: pane("a"), b: pane("b") }]);
  });
});
