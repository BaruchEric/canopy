/**
 * What a press of the steer box's send does with what was typed: words
 * over the limit say why and stay in the box rather than vanish.
 */
import { describe, expect, test } from "bun:test";
import { STEER_MAX } from "../../../src/core/steer";
import { steerPress } from "./SteerBox";

describe("the steer box's send", () => {
  test("typed words go trimmed", () => {
    expect(steerPress("  carry on  ")).toEqual({ send: "carry on" });
  });

  test("a message over the limit says why, with its length, and sends nothing", () => {
    const long = "x".repeat(STEER_MAX + 5);
    expect(steerPress(long)).toEqual({ why: `a message is at most ${STEER_MAX} characters; this one is ${STEER_MAX + 5}` });
  });

  test("an empty box does nothing", () => {
    expect(steerPress("   ")).toBeNull();
  });
});
