import { expect, test } from "bun:test";
import { benchOneAt, restSize } from "./media";

test("restSize: the keyboard coming up keeps the height from before it", () => {
  const tall = { w: 840, h: 760 };
  expect(restSize(tall, { w: 840, h: 420 }, true)).toEqual(tall);
});

test("restSize: anything else is the window's own size", () => {
  const tall = { w: 840, h: 760 };
  // the first measure
  expect(restSize(null, { w: 840, h: 420 }, true)).toEqual({ w: 840, h: 420 });
  // nothing typing: the window really got shorter
  expect(restSize(tall, { w: 840, h: 420 }, false)).toEqual({ w: 840, h: 420 });
  // turned on its side
  expect(restSize(tall, { w: 760, h: 400 }, true)).toEqual({ w: 760, h: 400 });
  // the keyboard going down, or a taller window
  expect(restSize({ w: 840, h: 420 }, tall, true)).toEqual(tall);
});

test("benchOneAt: a phone's width or a short window", () => {
  expect(benchOneAt({ w: 760, h: 900 })).toBe(true);
  expect(benchOneAt({ w: 1200, h: 480 })).toBe(true);
  expect(benchOneAt({ w: 840, h: 760 })).toBe(false);
});
