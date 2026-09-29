/** Per-browser preferences. These never touch the server: they describe how
 *  this window shows the grove, not the grove itself. */

import {
  FILE_COLS,
  FILE_VIEWS,
  SORT_DIRS,
  colOrder,
  type FileCol,
  type FileSort,
  type FileView,
} from "./files";
import { TERM_FONT } from "./term";
import { termFontSize } from "./touch";
import {
  SECTION_KEYS,
  normalizeTermFonts,
  normalizeZooms,
  sectionOrder,
  sectionsHidden,
  type SectionKey,
  type TermFonts,
  type Zooms,
} from "./surface";

export const SORT_MODES = [
  "recent",
  "folder",
  "activity",
  "name",
  "user",
  "favorites",
] as const;
export type SortMode = (typeof SORT_MODES)[number];

/** Where a click opens a repo: a panel beside the others in the dock, a tab
 *  in one dock panel (`tabs`), a browser tab, or a small browser window. */
export const OPEN_TARGETS = ["dock", "tabs", "tab", "window"] as const;
export type OpenTarget = (typeof OPEN_TARGETS)[number];

/** How the terminal openers (kitty, Terminal, the agent in either) place a
 *  repo: a new OS window, or a tab in the front window. */
export const TERMINAL_MODES = ["window", "tab"] as const;
export type TerminalMode = (typeof TERMINAL_MODES)[number];

/** Where a shell opened from a card lands: the repo's panel, the strip along
 *  the bottom, a browser tab or window of its own, or auto, which is the panel
 *  when the repo has one open and the strip otherwise. */
export const SHELL_TARGETS = ["auto", "panel", "strip", "tab", "window"] as const;
export type ShellTarget = (typeof SHELL_TARGETS)[number];

/** The two places a shell can live inside a window; the server keeps it
 *  with the shell, so a shell nobody saved comes back where it was. */
export type { ShellPlace } from "../../src/core/types";
import type { BackendEntry, ShellPlace } from "../../src/core/types";

/** Resolves the setting for one click. A solo window has no strip, so
 *  everything that would go there goes to the panel instead. */
export function shellPlace(
  target: ShellTarget,
  opts: { panelOpen: boolean; solo: boolean },
): ShellPlace | "tab" | "window" {
  if (target === "tab" || target === "window") return target;
  if (opts.solo) return "panel";
  if (target === "auto") return opts.panelOpen ? "panel" : "strip";
  return target;
}

export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const DENSITIES = ["cozy", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const FORGE_VIEWS = ["missing", "all"] as const;
/** "missing" keeps only the forge repos with no clone on this machine, which
 *  is the half a folder scan cannot already show. */
export type ForgeView = (typeof FORGE_VIEWS)[number];

export interface Settings {
  /** how the tree and the grid are grouped */
  sort: SortMode;
  /** where a clicked repo opens; `tabs` also lays the dock out as one
   *  tabbed panel instead of a row */
  openIn: OpenTarget;
  /** a window or a tab for kitty and Terminal */
  terminal: TerminalMode;
  /** where a shell in canopy lands */
  shell: ShellTarget;
  theme: Theme;
  density: Density;
  /** which of a forge's repos are worth a card */
  forge: ForgeView;
  /** leaves the repos archived in canopy off the board */
  hideArchived: boolean;
  /** the columns of a panel's changes list, left to right */
  fileCols: FileCol[];
  /** how that list is ordered */
  fileSort: FileSort;
  /** one flat list, or grouped under folder headings */
  fileView: FileView;
  /** the name of the `canopy helper` that is this browser's own machine,
   *  where the desktop openers run; null to adopt one by address, or none */
  helper: string | null;
  /** what this browser calls itself in the devices list; empty for the
   *  guess off the user agent */
  device: string;
  /** the shells' font size in px in place, what a pinch on a shell sets */
  termFont: number;
  /** the size filling a panel or window, in front, or in a window of its
   *  own, where it differs from in place; a spot with none uses that one */
  termFonts: TermFonts;
  /** each kind of surface's zoom, off its gear; a kind with none is at 1 */
  zoom: Zooms;
  /** each kind's zoom while brought to the front, where it differs from
   *  its zoom in place; a kind with none uses that one */
  frontZoom: Zooms;
  /** a panel's sections, top to bottom */
  sectionOrder: SectionKey[];
  /** the sections every panel leaves out */
  sectionsHidden: SectionKey[];
  /** the backends the home backend named last time, so the page can say
   *  which ones it knows before the answer comes */
  backends: BackendEntry[];
  /** the backends this browser leaves out; never the home one */
  hiddenBackends: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  sort: "recent",
  openIn: "dock",
  terminal: "window",
  shell: "auto",
  theme: "system",
  density: "cozy",
  forge: "missing",
  hideArchived: true,
  fileCols: [...FILE_COLS],
  fileSort: { col: "time", dir: "desc" },
  fileView: "list",
  helper: null,
  device: "",
  termFont: TERM_FONT.size,
  termFonts: {},
  zoom: {},
  frontZoom: {},
  sectionOrder: [...SECTION_KEYS],
  sectionsHidden: [],
  backends: [],
  hiddenBackends: [],
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

function fileSort(value: unknown): FileSort {
  const v = (typeof value === "object" && value !== null ? value : {}) as {
    col?: unknown;
    dir?: unknown;
  };
  return {
    col: pick(FILE_COLS, v.col, DEFAULT_SETTINGS.fileSort.col),
    dir: pick(SORT_DIRS, v.dir, DEFAULT_SETTINGS.fileSort.dir),
  };
}

/* The cached registry is held to the same rules as the server's config.
   Keep these in step with normalizeBackends in src/core/backends.ts, which
   the UI cannot import. */

/** a backend's name: a peer name, as the server's config requires */
const isBackendName = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v) && v !== "origin";

/** whether `v` is exactly an origin with one of the protocols given */
function isOrigin(v: unknown, protocols: readonly string[]): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return protocols.includes(u.protocol) && u.origin === v;
  } catch {
    return false;
  }
}

/** The cached registry, held to the server's own rules for its config: a
 *  peer name, `public` https, `tailnet` http or https, at least one of
 *  them, names unique with the first kept. */
function backendEntries(v: unknown): BackendEntry[] {
  if (!Array.isArray(v)) return [];
  const out: BackendEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = r["name"];
    if (!isBackendName(name) || out.some((b) => b.name === name)) continue;
    const entry: BackendEntry = { name };
    if (r["public"] !== undefined) {
      if (!isOrigin(r["public"], ["https:"])) continue;
      entry.public = r["public"];
    }
    if (r["tailnet"] !== undefined) {
      if (!isOrigin(r["tailnet"], ["http:", "https:"])) continue;
      entry.tailnet = r["tailnet"];
    }
    if (!entry.public && !entry.tailnet) continue;
    out.push(entry);
  }
  return out;
}

/** backend names, each once */
const backendNamesOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter(isBackendName).filter((n, i, all) => all.indexOf(n) === i) : [];

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
      terminal: pick(TERMINAL_MODES, saved.terminal, DEFAULT_SETTINGS.terminal),
      shell: pick(SHELL_TARGETS, saved.shell, DEFAULT_SETTINGS.shell),
      theme: pick(THEMES, saved.theme, DEFAULT_SETTINGS.theme),
      density: pick(DENSITIES, saved.density, DEFAULT_SETTINGS.density),
      forge: pick(FORGE_VIEWS, saved.forge, DEFAULT_SETTINGS.forge),
      hideArchived: typeof saved.hideArchived === "boolean" ? saved.hideArchived : DEFAULT_SETTINGS.hideArchived,
      fileCols: colOrder(saved.fileCols),
      fileSort: fileSort(saved.fileSort),
      fileView: pick(FILE_VIEWS, saved.fileView, DEFAULT_SETTINGS.fileView),
      helper: typeof saved.helper === "string" && /^[\w.-]{1,64}$/.test(saved.helper) ? saved.helper : null,
      device: typeof saved.device === "string" ? saved.device.slice(0, 40) : "",
      termFont: termFontSize(saved.termFont, DEFAULT_SETTINGS.termFont),
      termFonts: normalizeTermFonts(saved.termFonts),
      zoom: normalizeZooms(saved.zoom),
      frontZoom: normalizeZooms(saved.frontZoom, true),
      sectionOrder: sectionOrder(saved.sectionOrder),
      sectionsHidden: sectionsHidden(saved.sectionsHidden),
      backends: backendEntries(saved.backends),
      hiddenBackends: backendNamesOf(saved.hiddenBackends),
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
