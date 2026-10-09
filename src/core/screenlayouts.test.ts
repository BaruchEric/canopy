import { describe, expect, test } from "bun:test";
import { PRESETS, isPresetId, matchProfile, parseLayout, parseProfile, recommendLayout, sameSize } from "./screenlayouts";
import type { ScreenProfile } from "./types";

describe("recommendLayout", () => {
  test("a phone gets tabs and no tree", () => {
    expect(recommendLayout(393, 852)).toEqual({ arrange: "tabs", carousel: false, sidebarOpen: false, feedOpen: false });
  });
  test("a small laptop turns the carousel on, the dock one wide column", () => {
    expect(recommendLayout(1280, 800)).toEqual({ arrange: "columns", carousel: true, sidebarOpen: true, sidebarWidth: 220, columnWidth: 1048, feedOpen: false });
  });
  test("full HD keeps the cards and splits the rest in two", () => {
    expect(recommendLayout(1920, 1080)).toEqual({ arrange: "columns", carousel: false, sidebarOpen: true, sidebarWidth: 232, columnWidth: 675, feedOpen: false });
  });
  test("a 7680 double-wide gets a dozen columns, the widest tree and the feed", () => {
    expect(recommendLayout(7680, 2160)).toEqual({ arrange: "columns", carousel: false, sidebarOpen: true, sidebarWidth: 320, columnWidth: 580, feedOpen: true });
  });
  test("below the narrow width the tree is a drawer, so it is not opened", () => {
    expect(recommendLayout(1000, 1300).sidebarOpen).toBe(false);
  });
});

describe("PRESETS", () => {
  test("every size step up to 7680x2160, a phone and a tablet", () => {
    const sizes = PRESETS.map((p) => `${p.width}x${p.height}`);
    for (const s of ["1280x800", "1440x900", "1920x1080", "1920x1200", "2560x1440", "2560x1600", "3024x1964", "3440x1440", "3840x1600", "3840x2160", "5120x1440", "5120x2160", "7680x2160"]) {
      expect(sizes).toContain(s);
    }
    expect(PRESETS.some((p) => p.name === "phone")).toBe(true);
    expect(PRESETS.some((p) => p.name === "tablet")).toBe(true);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });
  test("each one's layout is the one its CSS room recommends, and checks out", () => {
    for (const p of PRESETS) {
      expect(p.builtin).toBe(true);
      expect(isPresetId(p.id)).toBe(true);
      expect(p.layout).toEqual(recommendLayout(Math.round(p.width / (p.dpr ?? 1)), Math.round(p.height / (p.dpr ?? 1))));
      expect(parseProfile(p)).toEqual({ profile: { name: p.name, device: p.device, width: p.width, height: p.height, dpr: p.dpr ?? 1, layout: p.layout } });
    }
  });
});

describe("parseProfile", () => {
  const ok = { name: " desk ", device: "Studio Display", width: 5120, height: 2880, dpr: 2, layout: { arrange: "tabs", panelZoom: 1.25, sectionsHidden: ["peers", "peers"], extra: 1 } };
  test("trims the words, keeps the known layout values once, and drops unknown keys", () => {
    expect(parseProfile(ok)).toEqual({
      profile: { name: "desk", device: "Studio Display", width: 5120, height: 2880, dpr: 2, layout: { arrange: "tabs", panelZoom: 1.25, sectionsHidden: ["peers"] } },
    });
    // the model is optional, and an empty one is none
    expect(parseProfile({ ...ok, model: "" })).toEqual(parseProfile(ok));
    expect(parseProfile({ ...ok, model: "DELL U4025QW" })).toMatchObject({ profile: { model: "DELL U4025QW" } });
  });
  test("refuses what the page could not apply", () => {
    for (const bad of [
      { ...ok, name: "" },
      { ...ok, name: "x".repeat(61) },
      { ...ok, width: 0 },
      { ...ok, height: 1200.5 },
      { ...ok, dpr: 9 },
      { ...ok, layout: { arrange: "rows" } },
      { ...ok, layout: { columnWidth: 100 } },
      { ...ok, layout: { termFont: 40 } },
      { ...ok, layout: { carousel: "yes" } },
      { ...ok, layout: { level: "expert" } },
      { ...ok, layout: { sectionsHidden: ["Peers!"] } },
      { ...ok, layout: [] },
      null,
    ]) {
      expect("error" in parseProfile(bad)).toBe(true);
    }
  });
  test("an absent layout is an empty one", () => {
    expect(parseLayout(undefined)).toEqual({ layout: {} });
  });
});

describe("matchProfile", () => {
  const own = (id: string, device: string, width: number, height: number, model?: string): ScreenProfile => ({
    id,
    name: id,
    device,
    width,
    height,
    ...(model ? { model } : {}),
    layout: {},
  });
  test("the device's name first, the same size first among them", () => {
    const profiles = [...PRESETS, own("p-a", "MacBook Pro 16", 3024, 1964), own("p-b", "macbook pro 16", 3456, 2234)];
    const m = matchProfile(profiles, { device: "MacBook Pro 16", width: 3456, height: 2234 });
    expect([m?.profile.id, m?.how]).toEqual(["p-b", "device"]);
    // a preset named for the device counts too, after the user's own
    expect(matchProfile(PRESETS, { device: "MacBook Pro 14", width: 100, height: 100 })?.profile.id).toBe("preset-3024x1964");
  });
  test("a monitor's model names it as well as its device", () => {
    const profiles = [...PRESETS, own("p-m", "", 5120, 2160, "LG 40WP95C")];
    expect(matchProfile(profiles, { model: "lg 40wp95c", width: 1, height: 1 })?.profile.id).toBe("p-m");
  });
  test("then the exact physical size, either way up and through a browser zoom's rounding", () => {
    const m = matchProfile(PRESETS, { width: 2560, height: 1440 });
    expect([m?.profile.id, m?.how]).toEqual(["preset-2560x1440", "exact"]);
    expect(matchProfile(PRESETS, { width: 2556, height: 1179 })?.profile.id).toBe("preset-1179x2556");
    expect(matchProfile(PRESETS, { width: 7682, height: 2159 })?.profile.id).toBe("preset-7680x2160");
    expect(sameSize({ width: 1920, height: 1080 }, 1940, 1080)).toBe(false);
  });
  test("then the nearest preset by shape, then area", () => {
    // 32:9 at a size no preset has goes to a 32:9 one
    const m = matchProfile(PRESETS, { width: 3840, height: 1080 });
    expect([m?.profile.id, m?.how]).toEqual(["preset-5120x1440", "nearest"]);
    // 16:10 a little over 1920x1200
    expect(matchProfile(PRESETS, { width: 2048, height: 1280 })?.profile.id).toBe("preset-1920x1200");
    // a user's own profile is never the nearest, only an exact or named one
    expect(matchProfile([own("p-x", "", 3800, 1070)], { width: 3840, height: 1080 })).toBeNull();
  });
});
