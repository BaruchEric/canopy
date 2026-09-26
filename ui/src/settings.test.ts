import { describe, expect, test } from "bun:test";
import { loadSettings, shellPlace } from "./settings";

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

describe("loadSettings", () => {
  test("the changes list's columns and sort survive a reload, repaired", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    store.set(
      "canopy.settings",
      JSON.stringify({
        fileCols: ["time", "file"],
        fileSort: { col: "file", dir: "sideways" },
        fileView: "folders",
      }),
    );
    const s = loadSettings();
    expect(s.fileCols).toEqual(["time", "file", "mark"]);
    expect(s.fileSort).toEqual({ col: "file", dir: "desc" });
    expect(s.fileView).toBe("folders");
    store.set("canopy.settings", "{}");
    expect(loadSettings().fileSort).toEqual({ col: "time", dir: "desc" });
    expect(loadSettings().fileView).toBe("list");
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  test("zoom, section order and hidden sections survive a reload, repaired", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    store.set(
      "canopy.settings",
      JSON.stringify({
        zoom: { panel: 1.25, feed: 40, nope: 2 },
        sectionOrder: ["claude", "changes"],
        sectionsHidden: ["peers", "bogus"],
      }),
    );
    const s = loadSettings();
    expect(s.zoom).toEqual({ panel: 1.25, feed: 2 });
    expect(s.sectionOrder).toEqual(["claude", "changes", "search", "history", "peers", "preview", "launch"]);
    expect(s.sectionsHidden).toEqual(["peers"]);
    store.set("canopy.settings", JSON.stringify({ zoom: "big", sectionOrder: 4 }));
    expect(loadSettings().zoom).toEqual({});
    expect(loadSettings().sectionOrder[0]).toBe("changes");
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
