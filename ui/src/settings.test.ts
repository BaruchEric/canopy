import { describe, expect, test } from "bun:test";
import { shellPlace } from "./settings";

describe("shellPlace", () => {
  test("auto follows the panel", () => {
    expect(shellPlace("auto", { panelOpen: true, solo: false })).toBe("panel");
    expect(shellPlace("auto", { panelOpen: false, solo: false })).toBe("strip");
  });
  test("a named place is taken as it is", () => {
    expect(shellPlace("panel", { panelOpen: false, solo: false })).toBe("panel");
    expect(shellPlace("strip", { panelOpen: true, solo: false })).toBe("strip");
  });
  test("a solo window has no strip", () => {
    expect(shellPlace("strip", { panelOpen: false, solo: true })).toBe("panel");
    expect(shellPlace("auto", { panelOpen: false, solo: true })).toBe("panel");
  });
  test("a tab or a window is one whatever the window", () => {
    expect(shellPlace("tab", { panelOpen: true, solo: true })).toBe("tab");
    expect(shellPlace("window", { panelOpen: false, solo: false })).toBe("window");
  });
});
