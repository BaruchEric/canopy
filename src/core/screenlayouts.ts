/**
 * Screen layout profiles: the recommended presets, one per common screen
 * size up to a 7680x2160 double-wide, the layout each recommends, how a
 * profile is checked, and which profile fits a screen. Pure and
 * browser-safe: the server checks and keeps profiles with it, and the page
 * matches and applies them. Tested in screenlayouts.test.ts.
 */

import type { ScreenLayout, ScreenProfile } from "./types";

/** The bounds a layout's values are held to, the page's own (SIDEBAR and
 *  PANEL in ui/src/store.ts, ZOOM_MIN and ZOOM_MAX in ui/src/surface.ts,
 *  TERM_FONT_MIN and TERM_FONT_MAX in ui/src/touch.ts, which this file
 *  cannot import; ui/src/screenprofiles.test.ts holds them equal). */
export const LAYOUT_BOUNDS = {
  sidebarWidth: { min: 180, max: 560 },
  columnWidth: { min: 240, max: 2400 },
  panelZoom: { min: 0.5, max: 2 },
  termFont: { min: 8, max: 24 },
} as const;

/** the widths the page turns at, in CSS px (ui/src/media.ts), and the room
 *  the cards keep beside the dock (`--cards-min` in styles.css) */
const PHONE = 760;
const NARROW = 1100;
const CARDS_MIN = 320;
const SEAM = 6;
/** the width a dock column is laid out around when the room is shared */
const COLUMN_TARGET = 560;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** The layout recommended for a screen `w` by `h` CSS px. A phone gets the
 *  dock as tabs and no tree (it is a drawer there). Below NARROW the tree
 *  is a drawer too. Otherwise the tree takes about an eighth of the width,
 *  and the dock what the cards leave: room for two columns or more keeps
 *  the cards and splits it, less than that turns the carousel on, so the
 *  dock takes the cards' room and scrolls a column at a time. A screen
 *  1400 px tall or more keeps the event feed up. */
export function recommendLayout(w: number, h: number): ScreenLayout {
  if (w < PHONE) return { arrange: "tabs", carousel: false, sidebarOpen: false, feedOpen: false };
  const tree = w >= NARROW;
  const sidebarWidth = clamp(Math.round((w * 0.12) / 8) * 8, 220, 320);
  const side = tree ? sidebarWidth + SEAM : 0;
  const beside = w - side - CARDS_MIN;
  const shared = Math.floor(beside / COLUMN_TARGET);
  const carousel = shared < 2;
  const room = carousel ? w - side : beside;
  const columns = Math.max(1, Math.floor(room / COLUMN_TARGET));
  const columnWidth = clamp(Math.floor((room - SEAM * columns) / columns), 440, 1200);
  return {
    arrange: "columns",
    carousel,
    sidebarOpen: tree,
    ...(tree ? { sidebarWidth } : {}),
    columnWidth,
    feedOpen: h >= 1400,
  };
}

/** the presets: physical size, pixel ratio, name, and the device it suits */
const STEPS: readonly (readonly [number, number, number, string, string])[] = [
  [1179, 2556, 3, "phone", "phone"],
  [1640, 2360, 2, "tablet", "tablet"],
  [1280, 800, 1, "1280×800", "small laptop"],
  [1440, 900, 1, "1440×900", "laptop"],
  [1920, 1080, 1, "full HD", "monitor"],
  [1920, 1200, 1, "1920×1200", "monitor"],
  [2560, 1440, 1, "QHD", "monitor"],
  [2560, 1600, 2, "13-inch laptop", "MacBook Air 13"],
  [3024, 1964, 2, "14-inch laptop", "MacBook Pro 14"],
  [3456, 2234, 2, "16-inch laptop", "MacBook Pro 16"],
  [3440, 1440, 1, "ultrawide", "34-inch ultrawide"],
  [3840, 1600, 1, "wide ultrawide", "38-inch ultrawide"],
  [3840, 2160, 1.5, "4K", "4K monitor"],
  [5120, 1440, 1, "super ultrawide", "49-inch super ultrawide"],
  [5120, 2160, 1, "5K2K", "40-inch 5K2K"],
  [7680, 2160, 1, "dual 4K", "57-inch dual 4K"],
];

/** a preset's id: its physical size */
const presetId = (w: number, h: number): string => `preset-${w}x${h}`;

/** The recommended presets, each laid out for its room in CSS px. */
export const PRESETS: readonly ScreenProfile[] = STEPS.map(([w, h, dpr, name, device]) => ({
  id: presetId(w, h),
  name,
  device,
  width: w,
  height: h,
  dpr,
  layout: recommendLayout(Math.round(w / dpr), Math.round(h / dpr)),
  builtin: true,
}));

export const isPresetId = (id: string): boolean => PRESETS.some((p) => p.id === id);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const inRange = (v: unknown, b: { min: number; max: number }): v is number => typeof v === "number" && Number.isFinite(v) && v >= b.min && v <= b.max;

/** A layout's values checked one by one: an unknown key is left out, a
 *  known one with a bad value is an error. */
export function parseLayout(raw: unknown): { layout: ScreenLayout } | { error: string } {
  if (raw === undefined) return { layout: {} };
  if (!isRecord(raw)) return { error: "layout must be an object" };
  const out: ScreenLayout = {};
  const r = raw;
  if (r["arrange"] !== undefined) {
    if (r["arrange"] !== "columns" && r["arrange"] !== "tabs") return { error: "arrange is columns or tabs" };
    out.arrange = r["arrange"];
  }
  for (const k of ["carousel", "sidebarOpen", "feedOpen"] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "boolean") return { error: `${k} is true or false` };
    out[k] = r[k];
  }
  for (const k of ["sidebarWidth", "columnWidth", "panelZoom", "termFont"] as const) {
    if (r[k] === undefined) continue;
    const b = LAYOUT_BOUNDS[k];
    if (!inRange(r[k], b)) return { error: `${k} is a number from ${b.min} to ${b.max}` };
    out[k] = k === "sidebarWidth" || k === "columnWidth" ? Math.round(r[k]) : r[k];
  }
  if (r["level"] !== undefined) {
    if (r["level"] !== "intermediate" && r["level"] !== "advanced") return { error: "level is intermediate or advanced" };
    out.level = r["level"];
  }
  if (r["sectionsHidden"] !== undefined) {
    const v: unknown = r["sectionsHidden"];
    const names: unknown[] = Array.isArray(v) && v.length <= 20 ? v : [""];
    const keys = names.filter((k): k is string => typeof k === "string" && /^[a-z]{1,20}$/.test(k));
    if (keys.length !== names.length) return { error: "sectionsHidden is a list of section names" };
    out.sectionsHidden = [...new Set(keys)];
  }
  return { layout: out };
}

/** what a profile is, less what the server gives it: its id and whether it is a preset */
export type ProfileFields = Omit<ScreenProfile, "id" | "builtin" | "edited">;

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length <= max ? v.trim() : null);

/** A profile from a request, checked: a name, a device (may be empty), an
 *  optional model, a physical size in whole px, an optional pixel ratio,
 *  and a layout. */
export function parseProfile(raw: unknown): { profile: ProfileFields } | { error: string } {
  if (!isRecord(raw)) return { error: "a profile is an object" };
  const name = text(raw["name"], 60);
  if (!name) return { error: "a profile needs a name, at most 60 characters" };
  const device = raw["device"] === undefined ? "" : text(raw["device"], 60);
  if (device === null) return { error: "device is text, at most 60 characters" };
  const model = raw["model"] === undefined || raw["model"] === "" ? undefined : text(raw["model"], 80);
  if (model === null) return { error: "model is text, at most 80 characters" };
  const size = { min: 200, max: 20000 };
  const width = raw["width"];
  const height = raw["height"];
  if (!inRange(width, size) || !inRange(height, size) || !Number.isInteger(width) || !Number.isInteger(height)) {
    return { error: `width and height are whole physical pixels from ${size.min} to ${size.max}` };
  }
  const dpr = raw["dpr"];
  if (dpr !== undefined && !inRange(dpr, { min: 0.5, max: 5 })) return { error: "dpr is a number from 0.5 to 5" };
  const layout = parseLayout(raw["layout"]);
  if ("error" in layout) return layout;
  return {
    profile: {
      name,
      device,
      ...(model ? { model } : {}),
      width,
      height,
      ...(dpr !== undefined ? { dpr } : {}),
      layout: layout.layout,
    },
  };
}

/** what the page knows of the screen it is on */
export interface ScreenHere {
  /** the name this device goes by (the user's, else a guess) */
  device?: string;
  /** the model it names itself, where it does */
  model?: string;
  /** physical px */
  width: number;
  height: number;
}

/** how a profile was picked for a screen */
export type MatchHow = "device" | "exact" | "nearest";

export interface ProfileMatch {
  profile: ScreenProfile;
  how: MatchHow;
}

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/** within a percent: a browser zoom moves the ratio and the CSS size in
 *  step, and their product only rounds */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(2, b * 0.01);

/** the same size either way up */
export const sameSize = (p: { width: number; height: number }, w: number, h: number): boolean =>
  (near(p.width, w) && near(p.height, h)) || (near(p.width, h) && near(p.height, w));

/** the user's own first, then the presets, each in their order */
const ownFirst = (ps: readonly ScreenProfile[]): ScreenProfile[] => [...ps.filter((p) => !p.builtin), ...ps.filter((p) => p.builtin)];

/** how far a size is from another, by the shape and then the area */
function distance(p: { width: number; height: number }, w: number, h: number): number {
  const shape = (a: number, b: number) => Math.log(Math.max(a, b) / Math.min(a, b));
  return Math.abs(shape(p.width, p.height) - shape(w, h)) * 4 + Math.abs(Math.log((p.width * p.height) / (w * h)));
}

/** The profile for a screen: one whose device or model is this device's,
 *  the same size first among them; else one of exactly this physical size;
 *  else the preset nearest by shape and then area. The user's own come
 *  before the presets at each step. Null with nothing to pick from. */
export function matchProfile(profiles: readonly ScreenProfile[], here: ScreenHere): ProfileMatch | null {
  const all = ownFirst(profiles);
  const device = norm(here.device);
  const model = norm(here.model);
  const named = all.filter((p) => (device !== "" && norm(p.device) === device) || (model !== "" && norm(p.model) === model));
  const byName = named.find((p) => sameSize(p, here.width, here.height)) ?? named[0];
  if (byName) return { profile: byName, how: "device" };
  const exact = all.find((p) => sameSize(p, here.width, here.height));
  if (exact) return { profile: exact, how: "exact" };
  let best: ScreenProfile | null = null;
  let bestAt = Infinity;
  for (const p of all) {
    if (!p.builtin) continue;
    const d = distance(p, here.width, here.height);
    if (d < bestAt) {
      best = p;
      bestAt = d;
    }
  }
  return best ? { profile: best, how: "nearest" } : null;
}
