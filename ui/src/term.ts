/** The shell tabs a window holds and how they find their shells again,
 *  plus the terminal's type and the height a shell needs to show a number
 *  of lines of it. Both the xterm in TermDock.tsx and the store's default
 *  shell height read from here, so they agree on what a row is. */

import type { Repo, ShellPlace, TermInfo } from "../../src/core/types";

/** One shell tab, in the strip along the bottom or in its repo's panel. */
export interface TermTab {
  /** the shell's name on the server too: a tab back from the layout finds
   *  its shell by it */
  id: string;
  repoId: string;
  /** the repo's name, what the tab says */
  name: string;
  /** the repo's locator; the socket lands there */
  path: string;
  /** the repo's panel, or the strip along the bottom */
  place: ShellPlace;
  /** set once the shell has exited, with its code */
  exit?: number | null;
  /** bumped when a shell is started again under the tab's name (a restore
   *  over a tab whose shell had gone), so the view starts over rather than
   *  keeping the ended one, which never reconnects */
  gen?: number;
}

/** what a tab's view is keyed by: its name, and its generation once it has one */
export const viewKey = (t: TermTab): string => (t.gen ? `${t.id}:${t.gen}` : t.id);

/** A name for a new shell: 32 hex digits of this window's randomness. The
 *  server files the pty under it, and the layout keeps the tab under it, so
 *  a reload finds the same shell. */
export function termId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const isPlace = (v: unknown): v is ShellPlace => v === "panel" || v === "strip";

/** The tabs a saved layout holds, minus anything malformed and the ones
 *  whose shell had already exited: they said so on screen once. */
export function loadTermTabs(v: unknown): TermTab[] {
  if (!Array.isArray(v)) return [];
  const out: TermTab[] = [];
  for (const t of v) {
    if (!t || typeof t !== "object") continue;
    const { id, repoId, name, path, place, exit } = t as Record<string, unknown>;
    if (typeof id !== "string" || typeof repoId !== "string" || typeof name !== "string") continue;
    if (typeof path !== "string" || !isPlace(place) || exit !== undefined) continue;
    out.push({ id, repoId, name, path, place });
  }
  return out;
}

/**
 * The tabs a window shows once it knows what the server holds: the saved
 * tabs whose shell is still there, in their order, then every shell nobody
 * saved (opened in a window since closed, or under a layout since lost), a
 * tab where it was opened, so no live shell is ever out of sight. A saved
 * tab whose shell is gone is dropped: it exited, or the server restarted
 * and took every shell with it. A shell at a repo the scan no longer has
 * cannot be shown (its socket names the repo) and is left alone, and so is
 * one this browser hid (`hidden`): it runs on, and the shells picker has it.
 * An untabbed panel shell whose repo's panel is not in `panels` (the loaded
 * layout's, not adopted here either) is left alone too: closing a panel
 * with a shell in it must not reopen that panel on the next load, on this
 * device or any other. A strip shell has no such gate. Saved tabs are
 * unaffected either way: a saved panel tab is kept even where the panel is
 * not (yet) in `panels`.
 */
export function reconcileTerms(
  saved: TermTab[],
  live: TermInfo[],
  repos: Repo[],
  panels: readonly string[] = [],
  hidden: ReadonlySet<string> = new Set(),
): TermTab[] {
  const held = new Set(live.map((t) => t.id));
  const repoOf = (id: string) => repos.find((r) => r.id === id);
  const out = saved.filter((t) => held.has(t.id) && repoOf(t.repoId));
  const seen = new Set(out.map((t) => t.id));
  for (const t of live) {
    if (seen.has(t.id) || hidden.has(t.id)) continue;
    if (t.place === "panel" && !panels.includes(t.repoId)) continue;
    const repo = repoOf(t.repoId);
    if (!repo) continue;
    out.push({ id: t.id, repoId: repo.id, name: repo.name, path: repo.path, place: t.place });
  }
  return out;
}

/** The tabs after the server said what it holds now: every tab this window
 *  has stays (one whose shell ended is marked by its own socket's exit
 *  frame and closed by hand, as before), and a held shell no tab names gets
 *  one: in the strip, or in its repo's panel when that panel is open here.
 *  A panel shell whose panel is closed waits for the panel to open, so a
 *  shell opened on another device does not pop panels open on this one
 *  (nor does a reload: see `reconcileTerms`, which applies the same rule
 *  at load). A shell this window ended (`ended`) is never taken back: the
 *  list that follows a closed tab's socket can reach here before the
 *  server has heard the end, and adopting it would open a socket that
 *  starts a new shell under the closed name. */
export function adoptTerms(
  tabs: TermTab[],
  live: TermInfo[],
  repos: Repo[],
  panels: string[],
  ended: ReadonlySet<string> = new Set(),
): TermTab[] {
  const seen = new Set(tabs.map((t) => t.id));
  let out = tabs;
  for (const t of live) {
    if (seen.has(t.id) || ended.has(t.id)) continue;
    if (t.place === "panel" && !panels.includes(t.repoId)) continue;
    const repo = repos.find((r) => r.id === t.repoId);
    if (!repo) continue;
    if (out === tabs) out = [...tabs];
    out.push({ id: t.id, repoId: repo.id, name: repo.name, path: repo.path, place: t.place });
  }
  return out;
}

/** The shells this browser hid that are still running: a hidden name whose
 *  shell ended has nothing left to hide. The same array when none went, so
 *  a list that changes nothing here is not a layout change. */
export function pruneHidden(hidden: string[], live: TermInfo[]): string[] {
  const held = new Set(live.map((t) => t.id));
  const kept = hidden.filter((id) => held.has(id));
  return kept.length === hidden.length ? hidden : kept;
}

/** Which set of shells a tab sits in: the strip, or one repo's panel. The
 *  key of the set brought to the front. */
export const shellSet = (t: { place: ShellPlace; repoId: string }): string =>
  t.place === "strip" ? "strip" : `panel:${t.repoId}`;

/** `front` while a tab still sits in that set, else null, so a set that
 *  empties does not come back to the front with its next shell. */
export const keepFront = (front: string | null, tabs: TermTab[]): string | null =>
  front !== null && tabs.some((t) => shellSet(t) === front) ? front : null;

/** A running shell outside the set in front, which the front box lists so
 *  it can be brought there instead. */
export interface OtherShell {
  id: string;
  repoId: string;
  /** the repo's name, numbered when the repo has more than one */
  label: string;
  /** whether this window has a tab on it; the rest run for other devices */
  tabbed: boolean;
  /** the devices with a socket on it, from the backend's list */
  viewers: string[];
}

/** Every running shell but the ones in `set`: this window's tabs first, in
 *  the order opened, then the shells the backend holds that no tab here
 *  names, for repos in the scan. An exited tab has nothing to bring. `word`
 *  names the machine a repo is on, appended to the label so two repos with
 *  the same name on different backends still read apart; the default names
 *  none, which is what a single-backend page passes. */
export function otherShells(
  set: string,
  tabs: TermTab[],
  live: TermInfo[],
  repos: Repo[],
  word: (id: string) => string = () => "",
): OtherShell[] {
  const viewers = new Map(live.map((t) => [t.id, t.viewers]));
  const out: Omit<OtherShell, "label">[] = [];
  for (const t of tabs) {
    if (t.exit !== undefined || shellSet(t) === set) continue;
    out.push({ id: t.id, repoId: t.repoId, tabbed: true, viewers: viewers.get(t.id) ?? [] });
  }
  const tabbed = new Set(tabs.map((t) => t.id));
  for (const t of live) {
    if (tabbed.has(t.id) || shellSet(t) === set || !repos.some((r) => r.id === t.repoId)) continue;
    out.push({ id: t.id, repoId: t.repoId, tabbed: false, viewers: t.viewers });
  }
  const count = new Map<string, number>();
  for (const o of out) count.set(o.repoId, (count.get(o.repoId) ?? 0) + 1);
  const seen = new Map<string, number>();
  return out.map((o) => {
    const name = repos.find((r) => r.id === o.repoId)?.name ?? o.repoId;
    const n = (seen.get(o.repoId) ?? 0) + 1;
    seen.set(o.repoId, n);
    const base = (count.get(o.repoId) ?? 0) > 1 ? `${name} ${n}` : name;
    const w = word(o.repoId);
    return { ...o, label: w ? `${base} · ${w}` : base };
  });
}

/** The strip tab that shows once `id` leaves it: the one after it, else the
 *  one before, the way a browser's tab strip does; `active` when that was
 *  not the one showing. */
export function nextStripTab(tabs: TermTab[], id: string, active: string | null): string | null {
  if (active !== id) return active;
  const i = tabs.findIndex((t) => t.id === id);
  const rest = tabs.filter((t) => t.id !== id && t.place === "strip");
  const j = tabs.slice(0, Math.max(0, i)).filter((t) => t.place === "strip").length;
  return (rest[j] ?? rest[j - 1])?.id ?? null;
}

export const TERM_FONT = {
  family: '"Berkeley Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  size: 12.5,
  lineHeight: 1.2,
};

/** the lines a panel shell opens at */
export const PANEL_TERM_ROWS = 5;

/** the `.term-screen` box's vertical padding (styles.css), plus slack so the
 *  fit addon's floor never rounds the last row away */
const TERM_PAD = 10 + 3;

/** what a row measures when nothing here can measure the font */
const FALLBACK_CELL = 18;

let cell: number | null = null;

/** One row's height in css px, worked out the way xterm 6 does: the font's
 *  ascent plus descent off a canvas, to device px, times the line height,
 *  floored, back to css px. Measured once; the font never changes. */
export function cellHeight(): number {
  if (cell !== null) return cell;
  cell = FALLBACK_CELL;
  try {
    const ctx = new OffscreenCanvas(100, 100).getContext("2d");
    if (ctx) {
      ctx.font = `${TERM_FONT.size}px ${TERM_FONT.family}`;
      const m = ctx.measureText("W");
      const glyph = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
      const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
      const device = Math.floor(Math.ceil(glyph * dpr) * TERM_FONT.lineHeight);
      if (Number.isFinite(device) && device > 0) cell = device / dpr;
    }
  } catch {
    // no canvas here (tests, an old browser): the fallback stands
  }
  return cell;
}

/** the px a shell's body takes to show `rows` lines */
export function rowsPx(rows: number, cellPx = cellHeight()): number {
  return Math.ceil(rows * cellPx + TERM_PAD);
}

/** A shell brought to the front: its floating box's size in css px. */
export interface FocusSize {
  w: number;
  h: number;
}

/** the smallest a focused shell's box goes */
export const FOCUS_MIN: FocusSize = { w: 360, h: 200 };

/** the room a focused shell leaves at each edge of the window at its biggest */
export const FOCUS_GAP = 8;

/** One side held between the least usable size and the window less a gap
 *  each side; a window smaller than the least gets the least. */
const fitSide = (px: number, min: number, view: number): number =>
  Math.round(Math.max(min, Math.min(px, view - 2 * FOCUS_GAP)));

/** A focused shell's size after its corner is dragged `dx`, `dy` from where
 *  it started at `start`. The box stays centred, so the corner moving by the
 *  drag means both sides do and the box grows by twice it. */
export function focusResize(start: FocusSize, dx: number, dy: number, view: FocusSize): FocusSize {
  return {
    w: fitSide(start.w + 2 * dx, FOCUS_MIN.w, view.w),
    h: fitSide(start.h + 2 * dy, FOCUS_MIN.h, view.h),
  };
}

/** A focused size off a saved layout: null (the default, which follows the
 *  window) for anything that is not two finite numbers, else at least the
 *  least. The window's own cap is the stylesheet's, since it moves. */
export function loadFocusSize(v: unknown): FocusSize | null {
  if (!v || typeof v !== "object") return null;
  const { w, h } = v as Record<string, unknown>;
  if (typeof w !== "number" || typeof h !== "number") return null;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w: Math.round(Math.max(FOCUS_MIN.w, w)), h: Math.round(Math.max(FOCUS_MIN.h, h)) };
}
