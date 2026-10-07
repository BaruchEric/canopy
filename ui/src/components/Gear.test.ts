import { expect, test } from "bun:test";
import { menuSpot } from "./Gear";

const button = { right: 1000, top: 40, bottom: 64 };
const view = { w: 1400, h: 900 };

test("a menu hangs off its button's right edge by its own width, below it", () => {
  expect(menuSpot(button, 300, 256, view)).toEqual({ top: 70, left: 744 });
  // the workspace gear is wider, so its run lines are not cut short
  expect(menuSpot(button, 300, 288, view)).toEqual({ top: 70, left: 712 });
});

test("it stays 8px inside the window, and goes above a button too low for it", () => {
  expect(menuSpot({ right: 1398, top: 40, bottom: 64 }, 300, 288, view).left).toBe(1104);
  expect(menuSpot({ right: 100, top: 40, bottom: 64 }, 300, 288, view).left).toBe(8);
  expect(menuSpot({ right: 1000, top: 800, bottom: 824 }, 300, 288, view).top).toBe(494);
});
