import { describe, expect, test } from "bun:test";
import { LAYOUT_BOUNDS, PRESETS } from "../../src/core/screenlayouts";
import { draftOf, fieldsOf, neverArranged } from "./screenprofiles";
import { PANEL, SIDEBAR } from "./store";
import { ZOOM_MAX, ZOOM_MIN } from "./surface";
import { TERM_FONT_MAX, TERM_FONT_MIN } from "./touch";

describe("LAYOUT_BOUNDS", () => {
  test("holds a profile to the page's own bounds", () => {
    const bounds: Record<keyof typeof LAYOUT_BOUNDS, { min: number; max: number }> = LAYOUT_BOUNDS;
    expect(bounds).toEqual({
      sidebarWidth: { min: SIDEBAR.min, max: SIDEBAR.max },
      columnWidth: { min: PANEL.min, max: PANEL.max },
      panelZoom: { min: ZOOM_MIN, max: ZOOM_MAX },
      termFont: { min: TERM_FONT_MIN, max: TERM_FONT_MAX },
    });
  });
});

describe("the Settings form's draft", () => {
  test("every preset goes through the form and back unchanged", () => {
    for (const p of PRESETS) {
      expect(fieldsOf(draftOf(p))).toEqual({
        profile: { name: p.name, device: p.device, width: p.width, height: p.height, ...(p.dpr !== undefined ? { dpr: p.dpr } : {}), layout: p.layout },
      });
    }
  });
  test("an empty field leaves the value alone, and text that is not a number is refused", () => {
    const d = draftOf({ name: "desk", width: 2560, height: 1440, layout: { carousel: false, sectionsHidden: ["peers", "launch"] } });
    expect(d.carousel).toBe("off");
    expect(d.feedOpen).toBe("");
    expect(d.sectionsHidden).toBe("peers, launch");
    expect(fieldsOf(d)).toEqual({ profile: { name: "desk", device: "", width: 2560, height: 1440, layout: { carousel: false, sectionsHidden: ["peers", "launch"] } } });
    expect("error" in fieldsOf({ ...d, width: "wide" })).toBe(true);
    expect("error" in fieldsOf({ ...d, columnWidth: "a lot" })).toBe(true);
    expect("error" in fieldsOf({ ...d, name: "  " })).toBe(true);
  });
});

describe("neverArranged", () => {
  test("a slot with no dock layout of its own is fresh", () => {
    expect(neverArranged(null, "ultra")).toBe(true);
    expect(neverArranged({ dockLayout: { columns: [] } }, "ultra")).toBe(true);
    expect(neverArranged({ screens: { laptop: { dockLayout: { columns: [] } } } }, "ultra")).toBe(true);
    // sizes kept there without a dock layout still leave it fresh
    expect(neverArranged({ screens: { ultra: { sidebarWidth: 300 } } }, "ultra")).toBe(true);
  });
  test("a slot that kept a dock layout, any at all, is not", () => {
    expect(neverArranged({ screens: { ultra: { dockLayout: { columns: [] } } } }, "ultra")).toBe(false);
    expect(neverArranged({ screens: { ultra: { dockLayout: "junk" } } }, "ultra")).toBe(false);
  });
  test("without a slot nothing applies on its own", () => {
    expect(neverArranged(null, undefined)).toBe(false);
  });
});
