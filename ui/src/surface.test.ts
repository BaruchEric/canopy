import { describe, expect, test } from "bun:test";
import {
  SECTION_KEYS,
  escapeLeaves,
  triggerKeeps,
  captureName,
  flipMode,
  moveSection,
  frontZoomOf,
  normalizeTermFonts,
  normalizeZooms,
  sectionOrder,
  sectionsHidden,
  shellSpot,
  termFontIn,
  tidyLines,
  copiedWord,
  FULLSCREEN_NOTE,
  shellCopyOf,
  toggleHidden,
  withFrontZoom,
  withTermFont,
  withZoom,
  zoomOf,
  zoomStep,
  zoomWord,
} from "./surface";

describe("zoomStep", () => {
  test("walks the stops both ways", () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(zoomStep(1.25, 1)).toBe(1.5);
  });
  test("a value between stops goes to the nearest one that way", () => {
    expect(zoomStep(1.05, 1)).toBe(1.1);
    expect(zoomStep(1.05, -1)).toBe(1);
  });
  test("holds at the ends", () => {
    expect(zoomStep(2, 1)).toBe(2);
    expect(zoomStep(0.5, -1)).toBe(0.5);
  });
  test("reads as a percent", () => {
    expect(zoomWord(1.25)).toBe("125%");
    expect(zoomWord(0.67)).toBe("67%");
  });
});

describe("normalizeZooms", () => {
  test("keeps known kinds, clamps, drops 1 and junk", () => {
    expect(normalizeZooms({ panel: 1.25, changes: 9, feed: 1, bogus: 1.5, shell: 1.5, search: "x" })).toEqual({
      panel: 1.25,
      changes: 2,
    });
    expect(normalizeZooms(null)).toEqual({});
    expect(normalizeZooms([1.5])).toEqual({});
    expect(normalizeZooms({ panel: Number.NaN })).toEqual({});
  });
  test("withZoom sets and clears", () => {
    const z = withZoom({}, "history", 1.5);
    expect(zoomOf(z, "history")).toBe(1.5);
    expect(zoomOf(z, "panel")).toBe(1);
    expect(withZoom(z, "history", 1)).toEqual({});
  });
  test("keepOne keeps a front zoom of 1", () => {
    expect(normalizeZooms({ panel: 1, feed: 1.5 }, true)).toEqual({ panel: 1, feed: 1.5 });
  });
});

describe("front zoom", () => {
  test("follows the in-place zoom until set", () => {
    expect(frontZoomOf({}, { panel: 1.25 }, "panel")).toBe(1.25);
    expect(frontZoomOf({}, {}, "feed")).toBe(1);
    expect(frontZoomOf({ panel: 1 }, { panel: 1.25 }, "panel")).toBe(1);
  });
  test("withFrontZoom sets a differing zoom and clears one back at the in-place zoom", () => {
    const f = withFrontZoom({}, { panel: 1.25 }, "panel", 1);
    expect(f).toEqual({ panel: 1 });
    expect(withFrontZoom(f, { panel: 1.25 }, "panel", 1.25)).toEqual({});
    expect(withFrontZoom({}, {}, "changes", 1.5)).toEqual({ changes: 1.5 });
  });
});

describe("sectionOrder", () => {
  test("no saved order is the default", () => {
    expect(sectionOrder(undefined)).toEqual([...SECTION_KEYS]);
    expect(sectionOrder("nope")).toEqual([...SECTION_KEYS]);
  });
  test("keeps a saved order, dropping unknown and repeated keys", () => {
    const saved = ["claude", "changes", "claude", "wat", "search", "history", "peers", "preview", "launch"];
    expect(sectionOrder(saved)).toEqual(["claude", "agents", "changes", "tasks", "search", "history", "peers", "preview", "launch"]);
  });
  test("a key the saved order lacks lands after its default predecessor", () => {
    expect(sectionOrder(["history", "changes", "search", "claude"])).toEqual([
      "history",
      "peers",
      "preview",
      "launch",
      "changes",
      "tasks",
      "search",
      "claude",
      "agents",
    ]);
    // with no predecessor saved, it goes first
    expect(sectionOrder(["claude", "search"])[0]).toBe("changes");
  });
  test("moveSection swaps with a neighbour and holds at the ends", () => {
    const order = [...SECTION_KEYS];
    expect(moveSection(order, "tasks", -1).slice(0, 2)).toEqual(["tasks", "changes"]);
    expect(moveSection(order, "changes", -1)).toBe(order);
    expect(moveSection(order, "agents", 1)).toBe(order);
  });
});

describe("hidden sections", () => {
  test("loads known keys once", () => {
    expect(sectionsHidden(["peers", "peers", "x", 3])).toEqual(["peers"]);
    expect(sectionsHidden({})).toEqual([]);
  });
  test("toggles", () => {
    expect(toggleHidden([], "launch")).toEqual(["launch"]);
    expect(toggleHidden(["launch", "peers"], "launch")).toEqual(["peers"]);
  });
});

describe("the rest", () => {
  test("flipMode puts a surface back on a second pick", () => {
    expect(flipMode("normal", "full")).toBe("full");
    expect(flipMode("full", "full")).toBe("normal");
    expect(flipMode("full", "focus")).toBe("focus");
  });
  test("captureName slugs the label and stamps local time", () => {
    const at = new Date(2026, 8, 5, 7, 3, 9);
    expect(captureName("Changes · web-apps/ripe", at)).toBe("canopy-changes-web-apps-ripe-20260905-070309.png");
    expect(captureName("···", at)).toBe("canopy-surface-20260905-070309.png");
  });
  test("a shell's copy takes tmux's text, and says when it is the screen alone", () => {
    const buffer = () => "stale frames";
    expect(shellCopyOf({ text: "$ ls  \na\n\n", fullscreen: false }, buffer)).toBe("$ ls\na");
    expect(shellCopyOf({ text: "claude\n", fullscreen: true }, buffer)).toEqual({ text: "claude", note: FULLSCREEN_NOTE });
    // a plain pty, or tmux not answering in time: the browser's own buffer
    expect(shellCopyOf({ text: null, fullscreen: false }, buffer)).toBe("stale frames");
    expect(shellCopyOf(null, buffer)).toBe("stale frames");
  });
  test("a copy says how much it took", () => {
    expect(copiedWord("a\nb")).toBe("copied 2 lines");
    expect(copiedWord({ text: "a", note: "the screen only" })).toBe("copied 1 line · the screen only");
  });
  test("tidyLines trims the ends", () => {
    expect(tidyLines(["$ ls  ", "a b", "", "  ", ""])).toBe("$ ls\na b");
    expect(tidyLines([])).toBe("");
  });
});

describe("shell text size by spot", () => {
  test("shellSpot reads the mode, and a lone window in place", () => {
    expect(shellSpot("normal", false)).toBe("place");
    expect(shellSpot("normal", true)).toBe("window");
    expect(shellSpot("full", true)).toBe("full");
    expect(shellSpot("focus", false)).toBe("front");
  });
  test("termFontIn follows the in-place size until a spot has its own", () => {
    expect(termFontIn(13, {}, "front")).toBe(13);
    expect(termFontIn(13, { front: 18 }, "front")).toBe(18);
    expect(termFontIn(13, { front: 18 }, "place")).toBe(13);
    expect(termFontIn(13, { front: 18 }, "window")).toBe(13);
  });
  test("withTermFont sets a differing size and clears one back at the in-place size", () => {
    const f = withTermFont({}, 13, "window", 20);
    expect(f).toEqual({ window: 20 });
    expect(withTermFont(f, 13, "window", 13)).toEqual({});
  });
  test("normalizeTermFonts drops unknown spots, in place and junk, and clamps", () => {
    expect(normalizeTermFonts({ front: 18, place: 20, side: 12, full: "x", window: 99 })).toEqual({ front: 18, window: 24 });
    expect(normalizeTermFonts([12])).toEqual({});
    expect(normalizeTermFonts(null)).toEqual({});
  });
});

test("a saved order from before tasks gets them after changes", () => {
  expect(sectionOrder(["changes", "search", "history", "peers", "preview", "launch", "claude"])).toEqual([...SECTION_KEYS]);
});

describe("Escape leaving a surface", () => {
  /** a stand-in target inside whatever `inside` matches */
  const at = (...inside: string[]) => ({
    closest: (sel: string) => (sel.split(",").some((part) => inside.some((m) => part.trim() === m)) ? {} : null),
  });
  test("a shell, a menu or a sheet keeps its own Escape", () => {
    expect(escapeLeaves(at(".term-screen"), false)).toBe(false);
    expect(escapeLeaves(at(".menu"), false)).toBe(false);
    expect(escapeLeaves(at(".sheet"), false)).toBe(false);
    expect(escapeLeaves(at(), false)).toBe(true);
    expect(escapeLeaves(null, false)).toBe(true);
  });
  test("a text field keeps it only while Escape is the page's in full screen", () => {
    expect(escapeLeaves(at("textarea"), false)).toBe(true);
    expect(escapeLeaves(at("textarea"), true)).toBe(false);
    expect(escapeLeaves(at("input"), true)).toBe(false);
    expect(escapeLeaves(at('[contenteditable]:not([contenteditable="false"])'), true)).toBe(false);
    expect(escapeLeaves(at(".xterm"), true)).toBe(false);
    expect(escapeLeaves(at("button"), true)).toBe(true);
  });
});

describe("what a menu's button keeps from what holds it", () => {
  test("every key while the menu is open, and every key but Escape while it is shut", () => {
    expect(triggerKeeps("Enter", false)).toBe(true);
    expect(triggerKeeps(" ", true)).toBe(true);
    expect(triggerKeeps("Escape", true)).toBe(true);
    // a full-screen panel's Escape must reach the page from the gear's button
    expect(triggerKeeps("Escape", false)).toBe(false);
  });
});
