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

export const SORT_MODES = [
  "recent",
  "folder",
  "activity",
  "name",
  "user",
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
import type { ShellPlace } from "../../src/core/types";

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
  /** the shells' font size in px, what a pinch on a shell sets */
  termFont: number;
}

export const DEFAULT_SETTINGS: Settings = {
  sort: "recent",
  openIn: "dock",
  terminal: "window",
  shell: "auto",
  theme: "system",
  density: "cozy",
  forge: "missing",
  fileCols: [...FILE_COLS],
  fileSort: { col: "time", dir: "desc" },
  fileView: "list",
  helper: null,
  device: "",
  termFont: TERM_FONT.size,
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
      fileCols: colOrder(saved.fileCols),
      fileSort: fileSort(saved.fileSort),
      fileView: pick(FILE_VIEWS, saved.fileView, DEFAULT_SETTINGS.fileView),
      helper: typeof saved.helper === "string" && /^[\w.-]{1,64}$/.test(saved.helper) ? saved.helper : null,
      device: typeof saved.device === "string" ? saved.device.slice(0, 40) : "",
      termFont: termFontSize(saved.termFont, DEFAULT_SETTINGS.termFont),
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
