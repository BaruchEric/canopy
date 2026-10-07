/** What every gear works over: the kinds of surface, their zoom, how a
 *  panel's sections are ordered and which are hidden, and how a surface
 *  sits. Pure, so the settings loader and the tests share it. */

import { termFontSize } from "./touch";

/** a panel's sections, in the order a panel shows them by default; the
 *  shells are not here, since they are the panel's footer */
export const SECTION_KEYS = ["changes", "tasks", "search", "history", "peers", "preview", "launch", "claude", "agents"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_WORD: Record<SectionKey, string> = {
  changes: "changes",
  tasks: "tasks",
  search: "search",
  history: "history",
  peers: "peers",
  preview: "preview",
  launch: "launch",
  claude: "claude",
  agents: "agents",
};

export const isSectionKey = (v: unknown): v is SectionKey =>
  typeof v === "string" && (SECTION_KEYS as readonly string[]).includes(v);

/** the surfaces with a zoom of their own; the shells zoom through the
 *  terminal's font size instead, since css zoom on an xterm puts its mouse
 *  and selection off by the factor */
export const ZOOM_KINDS = ["panel", ...SECTION_KEYS, "feed", "inbox", "sidebar", "board", "agents", "incubator", "library"] as const;
export type ZoomKind = (typeof ZOOM_KINDS)[number];
export type Zooms = Partial<Record<ZoomKind, number>>;

/** the stops a zoom steps through, the ones a browser's own zoom uses */
export const ZOOM_STOPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const ZOOM_MIN = ZOOM_STOPS[0];
export const ZOOM_MAX = ZOOM_STOPS[ZOOM_STOPS.length - 1] ?? 2;

/** The next stop up or down from `z`; a value between stops goes to the
 *  nearest one that way, and the ends hold. */
export function zoomStep(z: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STOPS.find((s) => s > z + 0.001) ?? ZOOM_MAX;
  return [...ZOOM_STOPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN;
}

export const zoomWord = (z: number): string => `${Math.round(z * 100)}%`;

/** a saved zoom map with anything unknown or out of range dropped, and a
 *  zoom of 1 left out, since that is what no entry means; `keepOne` keeps
 *  it, for the front zooms, where no entry means the in-place zoom */
export function normalizeZooms(v: unknown, keepOne = false): Zooms {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Zooms = {};
  for (const [k, z] of Object.entries(v)) {
    if (!(ZOOM_KINDS as readonly string[]).includes(k)) continue;
    if (typeof z !== "number" || !Number.isFinite(z)) continue;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (keepOne || Math.abs(clamped - 1) > 0.001) out[k as ZoomKind] = clamped;
  }
  return out;
}

export const zoomOf = (zooms: Zooms, kind: ZoomKind): number => zooms[kind] ?? 1;

/** `zooms` with `kind` at `z`; back at 1 the entry goes */
export function withZoom(zooms: Zooms, kind: ZoomKind, z: number): Zooms {
  const next = { ...zooms };
  if (Math.abs(z - 1) < 0.001) delete next[kind];
  else next[kind] = z;
  return next;
}

/** A kind's zoom while brought to the front: its own when one was set
 *  there, else the zoom it has in place. */
export const frontZoomOf = (front: Zooms, zooms: Zooms, kind: ZoomKind): number =>
  front[kind] ?? zoomOf(zooms, kind);

/** `front` with `kind` at `z`; back at the in-place zoom the entry goes,
 *  so the front follows the in-place zoom again */
export function withFrontZoom(front: Zooms, zooms: Zooms, kind: ZoomKind, z: number): Zooms {
  const next = { ...front };
  if (Math.abs(z - zoomOf(zooms, kind)) < 0.001) delete next[kind];
  else next[kind] = z;
  return next;
}

/** A saved section order made whole: the known keys it names, once each,
 *  then every key it does not name placed after the one it follows by
 *  default, so a section added later lands where it would have. */
export function sectionOrder(v: unknown): SectionKey[] {
  const out: SectionKey[] = [];
  if (Array.isArray(v)) for (const k of v) if (isSectionKey(k) && !out.includes(k)) out.push(k);
  SECTION_KEYS.forEach((k, i) => {
    if (out.includes(k)) return;
    const before = SECTION_KEYS.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, k);
  });
  return out;
}

/** a saved hidden list: the known keys, once each */
export function sectionsHidden(v: unknown): SectionKey[] {
  if (!Array.isArray(v)) return [];
  const out: SectionKey[] = [];
  for (const k of v) if (isSectionKey(k) && !out.includes(k)) out.push(k);
  return out;
}

/** `order` with `key` one place earlier (-1) or later (1); the same array at an end */
export function moveSection(order: SectionKey[], key: SectionKey, by: 1 | -1): SectionKey[] {
  const i = order.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  next[i] = order[j] as SectionKey;
  next[j] = key;
  return next;
}

/** `hidden` with `key` shown or hidden */
export const toggleHidden = (hidden: SectionKey[], key: SectionKey): SectionKey[] =>
  hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];

/** How a surface sits: in its place, taking the whole of what holds it, or
 *  brought to the front over the dimmed page. */
export type SurfaceMode = "normal" | "full" | "focus";

/** the mode after picking `m`: the same one again puts the surface back */
export const flipMode = (mode: SurfaceMode, m: SurfaceMode): SurfaceMode => (mode === m ? "normal" : m);

/** Where a shell shows, each with a text size of its own: in place, filling
 *  its panel or window, in front, or in a window (tab or popup) of its own. */
export const SHELL_SPOTS = ["place", "full", "front", "window"] as const;
export type ShellSpot = (typeof SHELL_SPOTS)[number];

/** the sizes set away from in place; a spot with none uses that one */
export type TermFonts = Partial<Record<Exclude<ShellSpot, "place">, number>>;

export const SPOT_WORD: Record<ShellSpot, string> = {
  place: "in place",
  full: "filling",
  front: "in front",
  window: "this window",
};

/** the spot a set of shells in `mode` is in; `lone` for a window that
 *  shows one panel, section or shell */
export function shellSpot(mode: SurfaceMode, lone: boolean): ShellSpot {
  if (mode === "full") return "full";
  if (mode === "focus") return "front";
  return lone ? "window" : "place";
}

/** the text size at `spot`: its own when one was set, else the in-place `base` */
export const termFontIn = (base: number, fonts: TermFonts, spot: ShellSpot): number =>
  spot === "place" ? base : (fonts[spot] ?? base);

/** `fonts` with `spot` (not in place) at `px`; back at `base` the entry
 *  goes, so the spot follows the in-place size again */
export function withTermFont(fonts: TermFonts, base: number, spot: Exclude<ShellSpot, "place">, px: number): TermFonts {
  const next = { ...fonts };
  if (px === base) delete next[spot];
  else next[spot] = px;
  return next;
}

/** a saved map of sizes with unknown spots and junk dropped */
export function normalizeTermFonts(v: unknown): TermFonts {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: TermFonts = {};
  for (const [k, px] of Object.entries(v)) {
    if (k === "place" || !(SHELL_SPOTS as readonly string[]).includes(k)) continue;
    if (typeof px !== "number" || !Number.isFinite(px)) continue;
    out[k as Exclude<ShellSpot, "place">] = termFontSize(px, px);
  }
  return out;
}

/** A file name for a capture: the surface's words slugged, then the local
 *  date and time, so a folder of them sorts by when. */
export function captureName(label: string, at: Date): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "surface";
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `canopy-${slug}-${day}-${time}.png`;
}

/** Text lines with the trailing blank ones dropped and each line's
 *  trailing spaces trimmed: what a copy of a terminal screen should hold. */
export function tidyLines(lines: string[]): string {
  const out = lines.map((l) => l.replace(/\s+$/, ""));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** what a copy hands the clipboard: the text, and a word on what it left
 *  out when that is worth saying */
export type CopyOut = string | { text: string; note: string };

/** said when a shell's copy is only its screen */
export const FULLSCREEN_NOTE = "the screen only: /copy in Claude copies its reply";

/** A shell's copy from what the server's tmux says of it. tmux's own text
 *  is clean where the browser's buffer is not: tmux draws a full-screen
 *  program on the browser terminal's normal screen, so every redraw pushes
 *  a stale frame into its scrollback. Null text (a plain pty, or no answer)
 *  falls back to the buffer, which is right there. */
export function shellCopyOf(got: { text: string | null; fullscreen: boolean } | null, buffer: () => string): CopyOut {
  if (!got || got.text === null) return buffer();
  const text = tidyLines(got.text.split("\n"));
  return got.fullscreen ? { text, note: FULLSCREEN_NOTE } : text;
}

/** the gear's word after a copy */
export function copiedWord(out: CopyOut): string {
  const text = typeof out === "string" ? out : out.text;
  const n = text.split("\n").length;
  const said = `copied ${n} line${n === 1 ? "" : "s"}`;
  return typeof out === "string" ? said : `${said} · ${out.note}`;
}

/** Whether a menu's button keeps `key` from what holds it (a card that opens
 *  on Enter, say). An Escape while its menu is shut goes on, so a panel in
 *  full screen hears it with the focus on its gear; while the menu is open,
 *  the menu's own Escape closes it first. */
export const triggerKeeps = (key: string, open: boolean): boolean => open || buttonKeeps(key);

/** Whether a button on a card or a panel head (a star, say) keeps `key`
 *  from what holds it: every key but Escape, which goes on to the page's
 *  layers, so a panel filling the window leaves with the focus on it. */
export const buttonKeeps = (key: string): boolean => key !== "Escape";

/** A button's onKeyDown on a card or a panel head that opens on Enter:
 *  keeps every key from it but Escape (`buttonKeeps`). */
export function keepKeys(e: { key: string; stopPropagation(): void }): void {
  if (buttonKeeps(e.key)) e.stopPropagation();
}

/** A popover's window listener for Escape: closes it and takes the key
 *  (`preventDefault`), so a surface under it whose listener runs later
 *  stays, as `LAYER_ABOVE` keeps one whose listener runs first. */
export function escapeCloses(e: { key: string; preventDefault(): void }, close: () => void): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  close();
}

/** what keeps its own Escape: a shell, an open menu, a sheet */
const OWN_ESCAPE = ".term-screen, .xterm, .menu, .sheet";
/** a text field, which keeps Escape too while the page holds it in full
 *  screen (there a press in the commit box must not end full screen) */
const TEXT_ESCAPE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** what sits over every surface and takes Escape first while it is up: a
 *  run sheet, a top-bar popover, a menu, the repo tree's drawer. Not the
 *  guided panel's tour, a coach mark with no Escape of its own. */
export const LAYER_ABOVE = '[role="dialog"]:not(.tour), [role="menu"], .sidebar.drawer';

/** Whether an Escape at `target` steps a surface back to normal. `typing`
 *  adds text fields to what keeps it: a panel in full screen with Escape
 *  locked (`lockEscape`), where a single Escape anywhere else leaves.
 *  `above` is a layer up over the surface (`LAYER_ABOVE`), which keeps it
 *  wherever the focus is, a button behind a sheet included: one Escape
 *  closes one layer. */
export function escapeLeaves(target: { closest(sel: string): unknown } | null, typing: boolean, above = false): boolean {
  if (above) return false;
  if (!target) return true;
  if (target.closest(OWN_ESCAPE)) return false;
  return !(typing && target.closest(TEXT_ESCAPE));
}
