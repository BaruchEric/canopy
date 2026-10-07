import { describe, expect, test } from "bun:test";
import { enterFull, fullWord, leaveFull, lockEscape, unlockKeys } from "./fullscreen";

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

describe("holding Escape in full screen", () => {
  test("locks Escape where the browser can, and says whether it did", async () => {
    const asked: (string[] | undefined)[] = [];
    expect(await lockEscape({ keyboard: { lock: async (keys) => void asked.push(keys), unlock: () => {} } })).toBe(true);
    expect(asked).toEqual([["Escape"]]);
  });
  test("without keyboard.lock nothing changes", async () => {
    expect(await lockEscape({})).toBe(false);
    expect(await lockEscape({ keyboard: {} })).toBe(false);
    expect(await lockEscape(undefined)).toBe(false);
  });
  test("a refused lock resolves false instead of throwing", async () => {
    expect(await lockEscape({ keyboard: { lock: () => Promise.reject(new Error("not full screen")) } })).toBe(false);
  });
  test("unlocks where it can", () => {
    let unlocks = 0;
    unlockKeys({ keyboard: { unlock: () => void unlocks++ } });
    unlockKeys({});
    unlockKeys(undefined);
    expect(unlocks).toBe(1);
  });
  test("leaving full screen lets go of the keys, even when the browser already left", () => {
    let unlocks = 0;
    const nav = { keyboard: { unlock: () => void unlocks++ } };
    leaveFull({ fullscreenElement: null, exitFullscreen: async () => {} }, nav);
    leaveFull({ fullscreenElement: {} as Element, exitFullscreen: async () => {} }, nav);
    expect(unlocks).toBe(2);
  });
});
