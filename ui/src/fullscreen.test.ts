import { describe, expect, test } from "bun:test";
import { enterFull, fullWord, leaveFull } from "./fullscreen";

describe("full screen", () => {
  test("the word says what the browser can do", () => {
    expect(fullWord(true)).toBe("full screen");
    expect(fullWord(false)).toBe("fill the window");
  });
  test("an unsupported browser never calls requestFullscreen", async () => {
    let called = false;
    const doc = { fullscreenEnabled: false, documentElement: { requestFullscreen: async () => void (called = true) } };
    expect(await enterFull(doc)).toBe(false);
    expect(called).toBe(false);
  });
  test("a refused request resolves false instead of throwing", async () => {
    const doc = { fullscreenEnabled: true, documentElement: { requestFullscreen: () => Promise.reject(new Error("no gesture")) } };
    expect(await enterFull(doc)).toBe(false);
  });
  test("a granted request resolves true", async () => {
    const doc = { fullscreenEnabled: true, documentElement: { requestFullscreen: async () => {} } };
    expect(await enterFull(doc)).toBe(true);
  });
});

describe("leaving full screen", () => {
  test("exits only while something is full screen", () => {
    let exits = 0;
    const exitFullscreen = async () => void exits++;
    leaveFull({ fullscreenElement: null, exitFullscreen });
    expect(exits).toBe(0);
    leaveFull({ fullscreenElement: {} as Element, exitFullscreen });
    expect(exits).toBe(1);
  });
  test("a refused exit does not throw", () => {
    leaveFull({ fullscreenElement: {} as Element, exitFullscreen: () => Promise.reject(new Error("no")) });
  });
});
