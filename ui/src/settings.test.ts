import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, INBOX_TEXT, inboxTextOf, levelOf, loadSettings, saveSettings, shellPlace } from "./settings";

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
    // a blob saved before the setting existed hides archived repos
    expect(loadSettings().hideArchived).toBe(true);
    store.set("canopy.settings", JSON.stringify({ hideArchived: false }));
    expect(loadSettings().hideArchived).toBe(false);
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
        frontZoom: { panel: 1, feed: "x" },
        sectionOrder: ["claude", "changes"],
        sectionsHidden: ["peers", "bogus"],
      }),
    );
    const s = loadSettings();
    expect(s.zoom).toEqual({ panel: 1.25, feed: 2 });
    expect(s.frontZoom).toEqual({ panel: 1 });
    expect(s.sectionOrder).toEqual(["claude", "agents", "changes", "tasks", "search", "history", "peers", "preview", "launch"]);
    expect(s.sectionsHidden).toEqual(["peers"]);
    store.set("canopy.settings", JSON.stringify({ zoom: "big", sectionOrder: 4 }));
    expect(loadSettings().zoom).toEqual({});
    expect(loadSettings().sectionOrder[0]).toBe("changes");
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});

describe("the inbox's view", () => {
  test("zoom, command text size, wrap and fold survive a reload, repaired", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    store.set("canopy.settings", "{}");
    expect(loadSettings()).toMatchObject({ inboxText: INBOX_TEXT.size, inboxWrap: true, inboxFold: true });
    store.set("canopy.settings", JSON.stringify({ zoom: { inbox: 1.25 }, inboxText: 40, inboxWrap: false, inboxFold: "no" }));
    expect(loadSettings()).toMatchObject({ zoom: { inbox: 1.25 }, inboxText: INBOX_TEXT.max, inboxWrap: false, inboxFold: true });
    saveSettings({ ...loadSettings(), inboxText: 10.6, inboxFold: false });
    expect(loadSettings()).toMatchObject({ inboxText: 11, inboxFold: false });
    expect(inboxTextOf("big")).toBe(INBOX_TEXT.size);
    expect(inboxTextOf(2)).toBe(INBOX_TEXT.min);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});

describe("the bench's seams", () => {
  test("survive a reload, repaired", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    store.set("canopy.settings", JSON.stringify({ benchRail: 520, benchDock: 0.6, benchSplit: 9 }));
    const s = loadSettings();
    expect(s.benchRail).toBe(520);
    expect(s.benchDock).toBe(0.6);
    expect(s.benchSplit).toBe(0.85);
    store.set("canopy.settings", JSON.stringify({ benchRail: "wide" }));
    const d = loadSettings();
    expect(d.benchRail).toBeNull();
    expect(d.benchDock).toBe(0.4);
    expect(d.benchSplit).toBe(0.45);
  });
});

describe("sizes per screen", () => {
  test("each kind of screen keeps its own, and a new one starts from the last", () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown; window?: unknown };
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const on = (width: number, height: number) => (g.window = { screen: { width, height } });
    try {
      on(1728, 1117);
      saveSettings({ ...DEFAULT_SETTINGS, previewHeight: 500, theme: "dark" });
      on(7680, 2160);
      // never sized here: the last size set anywhere
      expect(loadSettings().previewHeight).toBe(500);
      saveSettings({ ...loadSettings(), previewHeight: 1400 });
      on(1728, 1117);
      expect(loadSettings().previewHeight).toBe(500);
      expect(loadSettings().theme).toBe("dark");
      on(7680, 2160);
      expect(loadSettings().previewHeight).toBe(1400);
      // a gear's choices go the same way, a setting of the whole page does not
      saveSettings({ ...loadSettings(), zoom: { changes: 1.5 }, openIn: "tabs", sectionsHidden: ["peers"], theme: "light" });
      on(390, 844);
      saveSettings({ ...loadSettings(), zoom: { changes: 0.8 }, openIn: "dock" });
      on(7680, 2160);
      expect(loadSettings()).toMatchObject({ zoom: { changes: 1.5 }, openIn: "tabs", sectionsHidden: ["peers"], theme: "light" });
      on(844, 390);
      expect(loadSettings()).toMatchObject({ zoom: { changes: 0.8 }, openIn: "dock", theme: "light" });
    } finally {
      delete g.window;
    }
  });
});

describe("the backends a page remembers", () => {
  test("the cached registry and the hidden names survive a reload, repaired", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    store.set(
      "canopy.settings",
      JSON.stringify({
        backends: [
          { name: "mac", tailnet: "http://mac.test:7850" },
          { name: "mini", public: "https://canopy.example.com" },
          { name: "gpd", tailnet: "not a url" },
          { name: "old", public: "http://not-https.test" },
          { name: "Bad Name", tailnet: "http://x.test" },
          { name: "mac", tailnet: "http://again.test" },
          { name: "bare" },
          "junk",
        ],
        hiddenBackends: ["mini", 3, "mini"],
      }),
    );
    const s = loadSettings();
    expect(s.backends).toEqual([
      { name: "mac", tailnet: "http://mac.test:7850" },
      { name: "mini", public: "https://canopy.example.com" },
    ]);
    expect(s.hiddenBackends).toEqual(["mini"]);
    store.set("canopy.settings", "{}");
    expect(loadSettings().backends).toEqual([]);
    expect(loadSettings().hiddenBackends).toEqual([]);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});

describe("levelOf", () => {
  test("a browser with saved settings from before levels stays on advanced, tour done", () => {
    expect(levelOf({ sort: "recent" })).toEqual({ level: "advanced", onboarded: true });
  });
  test("a saved level and tour flag are kept", () => {
    expect(levelOf({ level: "intermediate", onboarded: false })).toEqual({ level: "intermediate", onboarded: false });
  });
  test("a bad level falls back to advanced, a bad flag to done", () => {
    expect(levelOf({ level: "expert", onboarded: "yes" })).toEqual({ level: "advanced", onboarded: true });
  });
});

describe("a fresh browser", () => {
  test("starts on intermediate with the tour to come", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    const s = loadSettings();
    expect(s.level).toBe("intermediate");
    expect(s.onboarded).toBe(false);
  });
});

describe("a browser from before levels that never saved a setting", () => {
  test("keeps the advanced panel when it has a saved layout", () => {
    const store = new Map<string, string>([["canopy.layout", "{}"]]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {},
    };
    const s = loadSettings();
    expect(s.level).toBe("advanced");
    expect(s.onboarded).toBe(true);
  });
});
