import { describe, expect, test } from "bun:test";
import {
  changed,
  closedIn,
  closedSectionsOf,
  pruneByRepo,
  sectionsFor,
  toggleIn,
  unfoldIn,
} from "./store";
import type { Repo } from "../../src/core/types";

describe("closedSectionsOf", () => {
  test("a layout from before the launch section folds it", () => {
    expect(closedSectionsOf(["search", "history", "claude"], ["search", "history", "claude"])).toEqual([
      "search",
      "history",
      "claude",
      "launch",
    ]);
  });
  test("a section the reader unfolded stays unfolded once the layout knows it", () => {
    const saved = ["search", "history", "claude"];
    expect(closedSectionsOf(saved, ["search", "history", "claude", "launch"])).toBe(saved);
  });
  test("a stored fold is not doubled", () => {
    expect(closedSectionsOf(["launch"], [])).toEqual(["launch", "search", "history", "claude"]);
  });
});

describe("per-repo folds", () => {
  test("a repo nobody has touched folds the defaults", () => {
    expect(sectionsFor({}, "a")).toEqual(["search", "history", "claude", "launch"]);
    expect(closedIn({ closedSections: {} }, "a", "history")).toBe(true);
    expect(closedIn({ closedSections: {} }, "a", "changes")).toBe(false);
  });
  test("a toggle touches one repo and leaves the rest alone", () => {
    const one = toggleIn({}, "a", "history");
    expect(sectionsFor(one, "a")).toEqual(["search", "claude", "launch"]);
    expect(sectionsFor(one, "b")).toEqual(["search", "history", "claude", "launch"]);
    const two = toggleIn(one, "a", "changes");
    expect(closedIn({ closedSections: two }, "a", "changes")).toBe(true);
    expect(closedIn({ closedSections: two }, "b", "changes")).toBe(false);
  });
  test("unfolding hands back the same object when nothing is folded", () => {
    const closed = { a: ["search"] };
    expect(unfoldIn(closed, "a", "history")).toBe(closed);
    expect(sectionsFor(unfoldIn(closed, "a", "search"), "a")).toEqual([]);
    expect(sectionsFor(unfoldIn({}, "b", "launch"), "b")).toEqual(["search", "history", "claude"]);
  });
});

describe("changed", () => {
  test("names only the fields whose value moved", () => {
    const arr = ["x"];
    expect(changed({ a: 1, b: arr, c: null }, { a: 1, b: arr, c: null })).toEqual({});
    expect(changed({ a: 2, b: ["x"], c: null }, { a: 1, b: arr, c: null })).toEqual({ a: 2, b: ["x"] });
  });
});

describe("pruneByRepo", () => {
  const repos = [{ id: "a" }, { id: "b" }] as Repo[];
  test("drops the entries whose repo left the scan", () => {
    expect(pruneByRepo({ a: 1, gone: 2 }, repos)).toEqual({ a: 1 });
  });
  test("is the same object when every entry still has a repo", () => {
    const map = { a: ["search"], b: [] };
    expect(pruneByRepo(map, repos)).toBe(map);
  });
});
