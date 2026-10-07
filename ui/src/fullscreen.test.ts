import { describe, expect, test } from "bun:test";
import { enterFull, fullWord } from "./fullscreen";

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
