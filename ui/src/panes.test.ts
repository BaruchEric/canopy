import { describe, expect, test } from "bun:test";
import { parsePaneMsg, restorePanel, unclaimed, without } from "./panes";

describe("pane messages", () => {
  test("parses the four kinds and refuses anything else", () => {
    expect(parsePaneMsg({ type: "hello", id: "a" })).toEqual({ type: "hello", id: "a" });
    expect(parsePaneMsg({ type: "bye", id: "a" })).toEqual({ type: "bye", id: "a" });
    expect(parsePaneMsg({ type: "return", id: "a" })).toEqual({ type: "return", id: "a" });
    expect(parsePaneMsg({ type: "who" })).toEqual({ type: "who" });
    expect(parsePaneMsg({ type: "hello" })).toBeNull();
    expect(parsePaneMsg({ type: "hello", id: 3 })).toBeNull();
    expect(parsePaneMsg({ type: "hello", id: "" })).toBeNull();
    expect(parsePaneMsg({ type: "nuke", id: "a" })).toBeNull();
    expect(parsePaneMsg("hello")).toBeNull();
    expect(parsePaneMsg(null)).toBeNull();
  });
});

describe("putting a panel back", () => {
  test("at its old slot, clamped, once", () => {
    expect(restorePanel(["a", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(restorePanel(["a"], "b", 9)).toEqual(["a", "b"]);
    expect(restorePanel(["a", "b"], "b", 0)).toEqual(["a", "b"]);
  });
  test("popped ids no window answered for", () => {
    expect(unclaimed({ a: 0, b: 2 }, new Set(["b"]))).toEqual(["a"]);
  });
  test("a slot forgotten, the rest kept", () => {
    expect(without({ a: 0, b: 2 }, "a")).toEqual({ b: 2 });
    expect(without({ b: 2 }, "a")).toEqual({ b: 2 });
  });
});
