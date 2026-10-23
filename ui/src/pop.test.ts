import { describe, expect, test } from "bun:test";
import { CENTERED, HANGS_LEFT, HANGS_RIGHT, POP_MIN, fitShift, gripSize, popRoom, popSizesOf, popZoomsOf } from "./pop";

describe("fitShift", () => {
  test("a box inside the window stays put", () => {
    expect(fitShift(100, 440, 1600)).toBe(0);
  });
  test("a box off the left edge moves right to the gap", () => {
    expect(fitShift(-291, 49, 1100)).toBe(299);
  });
  test("a box off the right edge moves left to the gap", () => {
    expect(fitShift(300, 640, 600)).toBe(-48);
  });
  test("a box wider than the window keeps its left edge in view", () => {
    expect(fitShift(-100, 500, 390)).toBe(108);
  });
});

describe("popSizesOf", () => {
  test("keeps whole px and drops anything that is not a size", () => {
    expect(popSizesOf({ inbox: { w: 512.6, h: 400 }, bad: { w: "wide", h: 3 }, gone: null })).toEqual({ inbox: { w: 513, h: 400 } });
  });
  test("a size under the minimum comes up to it", () => {
    expect(popSizesOf({ chan: { w: 10, h: -4 } })).toEqual({ chan: POP_MIN });
  });
  test("anything but an object is no sizes", () => {
    expect(popSizesOf([1, 2])).toEqual({});
    expect(popSizesOf("big")).toEqual({});
  });
});

describe("popRoom", () => {
  const view = { w: 1600, h: 1000 };
  test("a sheet centered in the window takes it all but the gap on each side", () => {
    expect(popRoom({ left: 480, right: 1120, top: 200, bottom: 800 }, view, CENTERED, 24)).toEqual({ w: 1552, h: 952 });
  });
  test("a popover hanging off the right grows left to the gap and down to the bottom", () => {
    expect(popRoom({ left: 900, right: 1240, top: 60, bottom: 400 }, view, HANGS_RIGHT, 8)).toEqual({ w: 1232, h: 932 });
  });
  test("one hanging off the left grows right", () => {
    expect(popRoom({ left: 200, right: 560, top: 60, bottom: 400 }, view, HANGS_LEFT, 8)).toEqual({ w: 1392, h: 932 });
  });
  test("never less than the minimum", () => {
    expect(popRoom({ left: 0, right: 100, top: 990, bottom: 1000 }, view, HANGS_RIGHT, 8)).toEqual(POP_MIN);
  });
});

describe("gripSize", () => {
  const room = { w: 1200, h: 900 };
  const start = { w: 640, h: 500 };
  test("a centered sheet grows twice the drag, so its corner keeps up", () => {
    expect(gripSize(start, 50, 20, CENTERED, room)).toEqual({ w: 740, h: 540 });
  });
  test("a popover hanging off the right widens as the grip goes left", () => {
    expect(gripSize(start, -60, 30, HANGS_RIGHT, room)).toEqual({ w: 700, h: 530 });
  });
  test("one hanging off the left widens as it goes right", () => {
    expect(gripSize(start, 60, 30, HANGS_LEFT, room)).toEqual({ w: 700, h: 530 });
  });
  test("held to the room and to the minimum", () => {
    expect(gripSize(start, 2000, 2000, HANGS_LEFT, room)).toEqual(room);
    expect(gripSize(start, -2000, -2000, HANGS_LEFT, room)).toEqual(POP_MIN);
  });
});

describe("popZoomsOf", () => {
  test("keeps a zoom in range and leaves out 1, which no entry means", () => {
    expect(popZoomsOf({ inbox: 1.25, "sheet run": 1, chan: "big" })).toEqual({ inbox: 1.25 });
  });
  test("a zoom out of range comes back to its end", () => {
    expect(popZoomsOf({ a: 9, b: 0.1 })).toEqual({ a: 2, b: 0.5 });
  });
  test("anything but an object is no zooms", () => {
    expect(popZoomsOf(null)).toEqual({});
  });
});

