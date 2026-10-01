import { describe, expect, test } from "bun:test";
import { putScreen, screenClass, withScreen } from "./screens";

describe("screenClass", () => {
  test("goes by the longer side, so turning a screen keeps its class", () => {
    expect(screenClass(390, 844)).toBe("phone");
    expect(screenClass(844, 390)).toBe("phone");
    expect(screenClass(1024, 1366)).toBe("pad");
    expect(screenClass(1728, 1117)).toBe("laptop");
    expect(screenClass(2560, 1440)).toBe("desktop");
    expect(screenClass(7680, 2160)).toBe("wide");
  });
});

describe("withScreen", () => {
  const keys = ["dockWidth", "termHeight"];
  test("lays the class's sizes over the flat ones", () => {
    const saved = { dockWidth: 440, termHeight: 300, panels: ["a"], screens: { wide: { dockWidth: 1800 } } };
    expect(withScreen(saved, "wide", keys)).toMatchObject({ dockWidth: 1800, termHeight: 300, panels: ["a"] });
  });
  test("a class with no slot reads the flat sizes", () => {
    const saved = { dockWidth: 440, screens: { wide: { dockWidth: 1800 } } };
    expect(withScreen(saved, "laptop", keys).dockWidth).toBe(440);
  });
  test("only the sized keys come from a slot", () => {
    const saved = { panels: ["a"], screens: { wide: { panels: ["evil"] } } };
    expect(withScreen(saved, "wide", keys).panels).toEqual(["a"]);
  });
  test("no class, or a broken slot, leaves the object as it was", () => {
    const saved = { dockWidth: 440, screens: { wide: 7 } };
    expect(withScreen(saved, null, keys)).toBe(saved);
    expect(withScreen(saved, "wide", keys).dockWidth).toBe(440);
  });
});

describe("putScreen", () => {
  const keys = ["dockWidth", "termHeight"];
  test("writes flat, and the sized part into the class's slot too", () => {
    const stored = { dockWidth: 440, screens: { phone: { termHeight: 200 } } };
    expect(putScreen(stored, { dockWidth: 900, panels: ["a"] }, "wide", keys)).toEqual({
      dockWidth: 900,
      panels: ["a"],
      screens: { phone: { termHeight: 200 }, wide: { dockWidth: 900 } },
    });
  });
  test("keeps what the slot already had", () => {
    const stored = { screens: { wide: { termHeight: 500 } } };
    expect(putScreen(stored, { dockWidth: 900 }, "wide", keys).screens).toEqual({ wide: { termHeight: 500, dockWidth: 900 } });
  });
  test("a patch with no sizes, or no class, touches no slot", () => {
    const stored = { screens: { wide: { dockWidth: 1 } } };
    expect(putScreen(stored, { panels: [] }, "wide", keys).screens).toBe(stored.screens);
    expect(putScreen({}, { dockWidth: 2 }, null, keys)).toEqual({ dockWidth: 2 });
  });
});
