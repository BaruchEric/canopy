import { describe, expect, test } from "bun:test";
import { putScreen, screenClass, screenSlots, windowKindOf, withScreen, withoutOldScale } from "./screens";
import { ZOOM_STOPS } from "./surface";

describe("screenClass", () => {
  test("goes by the longer side, so turning a screen keeps its class", () => {
    expect(screenClass(390, 844)).toBe("phone");
    expect(screenClass(844, 390)).toBe("phone");
    expect(screenClass(1024, 1366)).toBe("pad");
    expect(screenClass(1728, 1117)).toBe("laptop");
    expect(screenClass(2560, 1440)).toBe("desktop");
    expect(screenClass(3440, 1440)).toBe("wide");
  });
  test("4K and up at their own size are ultra HD", () => {
    expect(screenClass(3840, 2160)).toBe("ultra");
    expect(screenClass(5120, 2880)).toBe("ultra");
    expect(screenClass(7680, 2160)).toBe("ultra");
  });
});

describe("windowKindOf", () => {
  test("names the window a route makes", () => {
    expect(windowKindOf({ solo: false, shell: false, section: null })).toBe("main");
    expect(windowKindOf({ solo: true, shell: false, section: null })).toBe("solo");
    expect(windowKindOf({ solo: false, shell: true, section: null })).toBe("shell");
    expect(windowKindOf({ solo: false, shell: false, section: "changes" })).toBe("section");
  });
});

describe("screenSlots", () => {
  test("the main window reads its screen's slot, the one slots had before window kinds", () => {
    expect(screenSlots("laptop", "main")).toEqual(["laptop"]);
  });
  test("any other window reads its own slot first, then the screen's", () => {
    expect(screenSlots("phone", "section")).toEqual(["phone.section", "phone"]);
  });
  test("an ultra HD screen falls back to the wide one's slot it used to share", () => {
    expect(screenSlots("ultra", "main")).toEqual(["ultra", "wide"]);
    expect(screenSlots("ultra", "solo")).toEqual(["ultra.solo", "ultra", "wide"]);
  });
  test("no screen, no slots", () => {
    expect(screenSlots(null, "main")).toEqual([]);
  });
});

describe("withScreen", () => {
  const keys = ["dockWidth", "termHeight"];
  test("lays the class's sizes over the flat ones", () => {
    const saved = { dockWidth: 440, termHeight: 300, panels: ["a"], screens: { wide: { dockWidth: 1800 } } };
    expect(withScreen(saved, ["wide"], keys)).toMatchObject({ dockWidth: 1800, termHeight: 300, panels: ["a"] });
  });
  test("a class with no slot reads the flat sizes", () => {
    const saved = { dockWidth: 440, screens: { wide: { dockWidth: 1800 } } };
    expect(withScreen(saved, ["laptop"], keys).dockWidth).toBe(440);
  });
  test("the closest slot wins, and each key falls through to the next slot that has it", () => {
    const saved = {
      dockWidth: 440,
      termHeight: 300,
      screens: { "laptop.section": { dockWidth: 600 }, laptop: { dockWidth: 900, termHeight: 250 } },
    };
    expect(withScreen(saved, ["laptop.section", "laptop"], keys)).toMatchObject({ dockWidth: 600, termHeight: 250 });
  });
  test("an ultra HD screen with no slot of its own takes the wide one's", () => {
    const saved = { dockWidth: 440, screens: { wide: { dockWidth: 1800 } } };
    expect(withScreen(saved, screenSlots("ultra", "main"), keys).dockWidth).toBe(1800);
  });
  test("only the sized keys come from a slot", () => {
    const saved = { panels: ["a"], screens: { wide: { panels: ["evil"] } } };
    expect(withScreen(saved, ["wide"], keys).panels).toEqual(["a"]);
  });
  test("no slots, or a broken slot, leaves the object as it was", () => {
    const saved = { dockWidth: 440, screens: { wide: 7 } };
    expect(withScreen(saved, [], keys)).toBe(saved);
    expect(withScreen(saved, ["wide"], keys).dockWidth).toBe(440);
  });
});

describe("putScreen", () => {
  const keys = ["dockWidth", "termHeight"];
  test("writes flat, and the sized part into the slot too", () => {
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
  test("a pop-out window writes its own slot and leaves the main window's alone", () => {
    const stored = { screens: { laptop: { dockWidth: 900 } } };
    const out = putScreen(stored, { dockWidth: 300 }, "laptop.section", keys);
    expect(out.screens).toEqual({ laptop: { dockWidth: 900 }, "laptop.section": { dockWidth: 300 } });
    expect(withScreen(out, screenSlots("laptop", "main"), keys).dockWidth).toBe(900);
  });
  test("a pop-out's sizes go into its slot alone, so the flat copy keeps the main window's", () => {
    const stored = { dockWidth: 900, panels: ["a"] };
    const out = putScreen(stored, { dockWidth: 300, panels: ["b"] }, "laptop.section", keys, false);
    expect(out).toEqual({ dockWidth: 900, panels: ["b"], screens: { "laptop.section": { dockWidth: 300 } } });
    expect(withScreen(out, screenSlots("laptop", "main"), keys).dockWidth).toBe(900);
    expect(withScreen(out, screenSlots("laptop", "section"), keys).dockWidth).toBe(300);
  });
  test("a patch with no sizes, or no slot, touches no slot", () => {
    const stored = { screens: { wide: { dockWidth: 1 } } };
    expect(putScreen(stored, { panels: [] }, "wide", keys).screens).toBe(stored.screens);
    expect(putScreen({}, { dockWidth: 2 }, null, keys)).toEqual({ dockWidth: 2 });
  });
});

describe("withoutOldScale", () => {
  test("takes an ultra screen's type scale out of its saved zooms, to the nearest stop", () => {
    const stored = {
      screens: { ultra: { zoom: { board: 1.5, changes: 1.25, claude: 0.8 }, popZooms: { "sheet run": 2 }, termFont: 24 } },
    };
    const out = withoutOldScale(stored, ZOOM_STOPS);
    expect(out.screens).toEqual({
      ultra: { zoom: { board: 1.25, changes: 1, claude: 0.67 }, popZooms: { "sheet run": 1.5 }, termFont: 24 },
    });
  });
  test("reaches every window of a scaled class, and no other class", () => {
    const stored = {
      screens: {
        "ultra.solo": { zoom: { history: 1.5 } },
        wide: { zoom: { history: 1.1 } },
        laptop: { zoom: { history: 1.5 } },
      },
    };
    expect(withoutOldScale(stored, ZOOM_STOPS).screens).toEqual({
      "ultra.solo": { zoom: { history: 1.25 } },
      wide: { zoom: { history: 1 } },
      laptop: { zoom: { history: 1.5 } },
    });
  });
  test("leaves the flat copy alone, which any screen may have written", () => {
    expect(withoutOldScale({ zoom: { board: 1.5 } }, ZOOM_STOPS).zoom).toEqual({ board: 1.5 });
  });
  test("runs once, so a zoom picked afterwards stays as picked", () => {
    const once = withoutOldScale({ screens: { ultra: { zoom: { board: 1.5 } } } }, ZOOM_STOPS);
    expect(once.uiScaled).toBe(true);
    expect(withoutOldScale(once, ZOOM_STOPS)).toBe(once);
  });
});
