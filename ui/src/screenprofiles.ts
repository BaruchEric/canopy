/**
 * The page's side of screen layout profiles (src/core/screenlayouts.ts):
 * the screen it is on in physical px and the names it goes by, what
 * the browser will say of the screen's model, and whether a screen's slot
 * has ever been arranged, which is what lets a profile apply on its own.
 * Pure but for the browser reads, each guarded; tested in
 * screenprofiles.test.ts.
 */

import { deviceName } from "../../src/core/presence";
import { parseProfile, type ProfileFields, type ScreenHere } from "../../src/core/screenlayouts";
import type { ScreenLayout } from "../../src/core/types";

/** the screen this page is on, in physical px; null where there is none */
export function physicalNow(): { width: number; height: number; dpr: number } | null {
  if (typeof window === "undefined" || typeof window.screen === "undefined") return null;
  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const { width, height } = window.screen;
  if (!(width > 0 && height > 0)) return null;
  return { width: Math.round(width * dpr), height: Math.round(height * dpr), dpr };
}

/** the name this device goes by: Settings' "this device", else the guess
 *  the devices list makes off the user agent */
export function deviceHere(named: string): string {
  if (named.trim()) return named.trim();
  return typeof navigator === "undefined" ? "" : deviceName(navigator.userAgent);
}

/** What this page knows of its screen, for matchProfile: its physical size
 *  and the device's name (Settings' own, else the one guessed off the user
 *  agent) and model, where known. Null with no screen. */
export function screenHere(device: string, model = ""): ScreenHere | null {
  const at = physicalNow();
  if (!at) return null;
  return { width: at.width, height: at.height, ...(device.trim() ? { device: device.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) };
}

/** a yes-or-no a profile may leave alone: "" leaves it */
export type Tri = "" | "on" | "off";

/** A profile as the Settings form holds it: every field text, a value a
 *  layout leaves alone empty. */
export interface Draft {
  name: string;
  device: string;
  model: string;
  width: string;
  height: string;
  dpr: string;
  arrange: "" | "columns" | "tabs";
  carousel: Tri;
  sidebarOpen: Tri;
  sidebarWidth: string;
  columnWidth: string;
  panelZoom: string;
  termFont: string;
  level: "" | "intermediate" | "advanced";
  sectionsHidden: string;
  feedOpen: Tri;
}

const tri = (v: boolean | undefined): Tri => (v === undefined ? "" : v ? "on" : "off");
const num = (v: number | undefined): string => (v === undefined ? "" : String(v));

/** the form's copy of a profile, or of a layout for a new one */
export function draftOf(p: { name?: string; device?: string; model?: string; width?: number; height?: number; dpr?: number; layout: ScreenLayout }): Draft {
  const l = p.layout;
  return {
    name: p.name ?? "",
    device: p.device ?? "",
    model: p.model ?? "",
    width: num(p.width),
    height: num(p.height),
    dpr: num(p.dpr),
    arrange: l.arrange ?? "",
    carousel: tri(l.carousel),
    sidebarOpen: tri(l.sidebarOpen),
    sidebarWidth: num(l.sidebarWidth),
    columnWidth: num(l.columnWidth),
    panelZoom: num(l.panelZoom),
    termFont: num(l.termFont),
    level: l.level ?? "",
    sectionsHidden: (l.sectionsHidden ?? []).join(", "),
    feedOpen: tri(l.feedOpen),
  };
}

/** the form's draft as the server takes it, checked by parseProfile
 *  (src/core/screenlayouts.ts) the same as there; text that is not a
 *  number goes through as text, so the check names it */
export function fieldsOf(d: Draft): { profile: ProfileFields } | { error: string } {
  const n = (s: string): number | string | undefined => (s.trim() === "" ? undefined : Number.isFinite(Number(s)) ? Number(s) : s.trim());
  const b = (t: Tri): boolean | undefined => (t === "" ? undefined : t === "on");
  const layout: Record<string, unknown> = {
    arrange: d.arrange || undefined,
    carousel: b(d.carousel),
    sidebarOpen: b(d.sidebarOpen),
    sidebarWidth: n(d.sidebarWidth),
    columnWidth: n(d.columnWidth),
    panelZoom: n(d.panelZoom),
    termFont: n(d.termFont),
    level: d.level || undefined,
    sectionsHidden: d.sectionsHidden.trim() === "" ? undefined : d.sectionsHidden.split(/[\s,]+/).filter(Boolean),
    feedOpen: b(d.feedOpen),
  };
  for (const k of Object.keys(layout)) if (layout[k] === undefined) delete layout[k];
  return parseProfile({
    name: d.name,
    device: d.device,
    model: d.model,
    width: n(d.width),
    height: n(d.height),
    ...(d.dpr.trim() ? { dpr: n(d.dpr) } : {}),
    layout,
  });
}

/** Whether the stored layout has never arranged the dock under `slot`: it
 *  keeps no dock layout there. Any other value, a hand-edited one
 *  included, counts as arranged, so a profile never lands over it. */
export function neverArranged(stored: unknown, slot: string | undefined): boolean {
  if (slot === undefined) return false;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!record(stored)) return true;
  const screens = stored.screens;
  const kept = record(screens) ? screens[slot] : undefined;
  return !record(kept) || kept.dockLayout === undefined;
}

// Chrome's Window Management API and User-Agent Client Hints, which this
// TS's DOM types do not have yet, read through narrow checks.
type Fn = (...a: unknown[]) => unknown;

/** a field of something a browser API handed back, undefined when absent */
function field(v: unknown, key: string): unknown {
  if (!v || typeof v !== "object" || !(key in v)) return undefined;
  // through the prototype too: these APIs are getters and methods there
  const out: unknown = Reflect.get(v, key);
  return out;
}

const hasFn = <K extends string>(v: unknown, key: K): v is Record<K, Fn> => typeof field(v, key) === "function";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** What the browser says of this screen: the label Chrome's Window
 *  Management API gives it (the monitor's model name; asks for permission
 *  the first time unless `ask` is false, when it reads only once granted),
 *  else the model User-Agent Client Hints name (a phone's). Empty where
 *  neither says anything. */
export async function detectModel(ask: boolean): Promise<string> {
  if (typeof window === "undefined") return "";
  try {
    const w: unknown = window;
    if (hasFn(w, "getScreenDetails")) {
      let allowed = ask;
      const perms: unknown = navigator.permissions;
      if (!ask && hasFn(perms, "query")) {
        // "window-management" is not in this TS's PermissionName yet
        allowed = field(await perms.query({ name: "window-management" }), "state") === "granted";
      }
      if (allowed) {
        const label = text(field(field(await w.getScreenDetails(), "currentScreen"), "label"));
        if (label) return label;
      }
    }
  } catch {
    // refused, or a browser without the permission's name
  }
  try {
    const ua = field(navigator, "userAgentData");
    if (hasFn(ua, "getHighEntropyValues")) {
      const model = text(field(await ua.getHighEntropyValues(["model"]), "model"));
      if (model) return model;
    }
  } catch {
    // not given
  }
  return "";
}

