import { describe, expect, test } from "bun:test";
import { dragStep } from "./drag";

const move = (dx: number, dy: number, buttons = 1) => ({ type: "move", dx, dy, buttons }) as const;

describe("a panel drag's steps", () => {
  test("under the slop a press stays a click", () => {
    expect(dragStep("pressed", move(3, 2), 6)).toEqual({ phase: "pressed", effect: "none" });
    expect(dragStep("pressed", { type: "up" }, 6)).toEqual({ phase: "ended", effect: "none" });
  });
  test("past the slop it starts, then tracks", () => {
    expect(dragStep("pressed", move(6, 0), 6)).toEqual({ phase: "dragging", effect: "start" });
    expect(dragStep("dragging", move(40, 0), 6)).toEqual({ phase: "dragging", effect: "track" });
  });
  test("letting go drops and is no click", () => {
    expect(dragStep("dragging", { type: "up" }, 6)).toEqual({ phase: "ended", effect: "drop", swallow: true });
  });
  test("a move with no button held means the release was missed: it cancels", () => {
    expect(dragStep("pressed", move(20, 0, 0), 6)).toEqual({ phase: "ended", effect: "cancel" });
    expect(dragStep("dragging", move(20, 0, 0), 6)).toEqual({ phase: "ended", effect: "cancel" });
    expect(dragStep("cancelled", move(20, 0, 0), 6)).toEqual({ phase: "ended", effect: "cancel" });
    // another button held alone is no left button
    expect(dragStep("dragging", move(20, 0, 2), 6)).toEqual({ phase: "ended", effect: "cancel" });
  });
  test("a lost pointer, a lost capture, a blur or a context menu cancels from any phase", () => {
    for (const phase of ["pressed", "dragging", "cancelled"] as const) {
      expect(dragStep(phase, { type: "cancel" }, 6)).toEqual({ phase: "ended", effect: "cancel" });
    }
  });
  test("Escape mid-drag hides the layer and keeps the release from being a click", () => {
    expect(dragStep("dragging", { type: "escape" }, 6)).toEqual({ phase: "cancelled", effect: "hide" });
    expect(dragStep("cancelled", move(80, 0), 6)).toEqual({ phase: "cancelled", effect: "none" });
    expect(dragStep("cancelled", { type: "escape" }, 6)).toEqual({ phase: "cancelled", effect: "none" });
    expect(dragStep("cancelled", { type: "up" }, 6)).toEqual({ phase: "ended", effect: "none", swallow: true });
  });
  test("Escape under the slop only lets the press go", () => {
    expect(dragStep("pressed", { type: "escape" }, 6)).toEqual({ phase: "ended", effect: "cancel" });
  });
  test("a touch starts on a hold alone, and a finger that moves first is scrolling", () => {
    expect(dragStep("pressed", { type: "hold" }, 6, true)).toEqual({ phase: "dragging", effect: "start" });
    expect(dragStep("pressed", move(3, 0), 6, true)).toEqual({ phase: "pressed", effect: "none" });
    expect(dragStep("pressed", move(10, 0), 6, true)).toEqual({ phase: "ended", effect: "cancel" });
    expect(dragStep("dragging", move(40, 0), 6, true)).toEqual({ phase: "dragging", effect: "track" });
    expect(dragStep("pressed", { type: "up" }, 6, true)).toEqual({ phase: "ended", effect: "none" });
  });
  test("a hold after the drag began changes nothing", () => {
    expect(dragStep("dragging", { type: "hold" }, 6, true)).toEqual({ phase: "dragging", effect: "none" });
    expect(dragStep("cancelled", { type: "hold" }, 6, true)).toEqual({ phase: "cancelled", effect: "none" });
  });
});
