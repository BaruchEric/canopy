import { describe, expect, test } from "bun:test";
import { focusPanel, nextActive } from "./dock";

describe("focusPanel", () => {
  test("appends a new panel and shows it", () => {
    expect(focusPanel(["a", "b"], "c")).toEqual({
      panels: ["a", "b", "c"],
      activePanel: "c",
    });
  });
  test("an open panel keeps its place and comes forward", () => {
    expect(focusPanel(["a", "b", "c"], "a")).toEqual({
      panels: ["a", "b", "c"],
      activePanel: "a",
    });
  });
  test("never mutates the list it was given", () => {
    const panels = ["a"];
    focusPanel(panels, "b");
    expect(panels).toEqual(["a"]);
  });
});

describe("nextActive", () => {
  test("closing another tab leaves the showing one alone", () => {
    expect(nextActive(["a", "b", "c"], "a", "b")).toBe("b");
    expect(nextActive(["a", "b", "c"], "c", "b")).toBe("b");
  });
  test("closing the showing tab moves right", () => {
    expect(nextActive(["a", "b", "c"], "b", "b")).toBe("c");
    expect(nextActive(["a", "b", "c"], "a", "a")).toBe("b");
  });
  test("closing the last tab on the right moves left", () => {
    expect(nextActive(["a", "b", "c"], "c", "c")).toBe("b");
  });
  test("closing the only tab shows nothing", () => {
    expect(nextActive(["a"], "a", "a")).toBeNull();
    expect(nextActive([], "a", null)).toBeNull();
  });
  test("a stale active falls back to the first remaining tab", () => {
    expect(nextActive(["a", "b"], "b", "gone")).toBe("a");
    expect(nextActive(["a", "b"], "b", null)).toBe("a");
  });
  test("closing a tab that is not open changes nothing", () => {
    expect(nextActive(["a", "b"], "z", "b")).toBe("b");
    expect(nextActive(["a", "b"], "z", null)).toBe("a");
  });
});
