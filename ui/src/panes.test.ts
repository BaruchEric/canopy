import { describe, expect, test } from "bun:test";
import { parsePaneMsg, poppedOf, unclaimed, without } from "./panes";

describe("pane messages", () => {
  test("parses the five kinds and refuses anything else", () => {
    expect(parsePaneMsg({ type: "hello", id: "a" })).toEqual({ type: "hello", id: "a" });
    expect(parsePaneMsg({ type: "close", id: "a" })).toEqual({ type: "close", id: "a" });
    expect(parsePaneMsg({ type: "close" })).toBeNull();
    expect(parsePaneMsg({ type: "close", id: 7 })).toBeNull();
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
  test("popped ids no window answered for", () => {
    expect(unclaimed({ a: 0, b: 2 }, new Set(["b"]))).toEqual(["a"]);
  });
  test("a slot forgotten, the rest kept", () => {
    expect(without({ a: 0, b: 2 }, "a")).toEqual({ b: 2 });
    expect(without({ b: 2 }, "a")).toEqual({ b: 2 });
    // nothing to forget is no change at all
    const popped = { b: 2 };
    expect(without(popped, "a")).toBe(popped);
  });
});

describe("the saved popped slots", () => {
  test("only a plain object of finite slots", () => {
    expect(poppedOf({ a: 0, b: 2 })).toEqual({ a: 0, b: 2 });
    // an array would read as panels "0" and "1"
    expect(poppedOf([1, 2])).toEqual({});
    expect(poppedOf({ a: "1", b: Number.NaN, c: Infinity, d: 3 })).toEqual({ d: 3 });
    expect(poppedOf({ a: -4, b: 2.6 })).toEqual({ a: 0, b: 2 });
    expect(poppedOf(null)).toEqual({});
    expect(poppedOf("a")).toEqual({});
    expect(poppedOf(undefined)).toEqual({});
  });
});
