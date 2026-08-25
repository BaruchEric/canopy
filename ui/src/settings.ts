/** Per-browser preferences. These never touch the server: they describe how
 *  this window shows the grove, not the grove itself. */

export const SORT_MODES = [
  "folder",
  "activity",
  "recent",
  "name",
  "user",
] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const OPEN_TARGETS = ["dock", "tab", "window"] as const;
export type OpenTarget = (typeof OPEN_TARGETS)[number];

export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const DENSITIES = ["cozy", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export interface Settings {
  /** how the tree and the grid are grouped */
  sort: SortMode;
  /** where a clicked repo opens */
  openIn: OpenTarget;
  theme: Theme;
  density: Density;
}

export const DEFAULT_SETTINGS: Settings = {
  sort: "folder",
  openIn: "dock",
  theme: "system",
  density: "cozy",
};

const KEY = "canopy.settings";

function pick<T extends string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    // Every field is validated against its list: a value written by an older
    // build or edited by hand must not put the UI in a state it cannot render.
    return {
      sort: pick(SORT_MODES, saved.sort, DEFAULT_SETTINGS.sort),
      openIn: pick(OPEN_TARGETS, saved.openIn, DEFAULT_SETTINGS.openIn),
      theme: pick(THEMES, saved.theme, DEFAULT_SETTINGS.theme),
      density: pick(DENSITIES, saved.density, DEFAULT_SETTINGS.density),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage can be disabled outright; the choice just won't survive a reload
  }
}
