import { describe, expect, test } from "bun:test";
import { listenPanes, parsePaneMsg, poppedOf, unclaimed, without, type PaneDock, type PaneLine, type PaneMsg } from "./panes";

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

/** the main window's side, on a stand-in channel and dock, with waits short
 *  enough to sleep through */
function rig(popped: Record<string, number> = {}) {
  const did: string[] = [];
  const sent: PaneMsg[] = [];
  let hear: (data: unknown) => void = () => {};
  const line: PaneLine = { listen: (fn) => (hear = fn), postMessage: (m) => sent.push(m), close: () => did.push("closed") };
  const dock: PaneDock = {
    popped: () => popped,
    heardHello: (id) => did.push(`hello ${id}`),
    returnPanel: (id) => did.push(`return ${id}`),
    forgetPopped: (id) => did.push(`forget ${id}`),
  };
  const stop = listenPanes(line, dock, { bye: 10, who: 30 });
  return { did, sent, hear: (data: unknown) => hear(data), stop };
}

describe("the main window's pane listener", () => {
  test("asks who is out there as it starts, and takes back a popped panel no window answers for", async () => {
    const r = rig({ a: 0, b: 1 });
    expect(r.sent).toEqual([{ type: "who" }]);
    r.hear({ type: "hello", id: "a" });
    await Bun.sleep(50);
    expect(r.did).toEqual(["hello a", "return b"]);
    r.stop();
  });

  test("hello claims, return and close act at once, and a bye waits for a reload's hello", async () => {
    const r = rig();
    r.hear({ type: "return", id: "a" });
    r.hear({ type: "close", id: "b" });
    r.hear({ type: "bye", id: "c" });
    r.hear({ type: "hello", id: "c" });
    r.hear({ type: "bye", id: "d" });
    r.hear({ type: "who" });
    r.hear({ type: "nuke", id: "e" });
    await Bun.sleep(25);
    expect(r.did).toEqual(["return a", "forget b", "hello c", "return d"]);
    r.stop();
  });

  test("stopping clears every wait and closes the channel", async () => {
    const r = rig({ a: 0 });
    r.hear({ type: "bye", id: "b" });
    r.stop();
    await Bun.sleep(50);
    expect(r.did).toEqual(["closed"]);
  });
});
