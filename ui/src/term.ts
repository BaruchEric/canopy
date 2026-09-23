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
 */
export function reconcileTerms(
  saved: TermTab[],
  live: TermInfo[],
  repos: Repo[],
  hidden: ReadonlySet<string> = new Set(),
): TermTab[] {
  const held = new Set(live.map((t) => t.id));
  const repoOf = (id: string) => repos.find((r) => r.id === id);
  const out = saved.filter((t) => held.has(t.id) && repoOf(t.repoId));
  const seen = new Set(out.map((t) => t.id));
  for (const t of live) {
    if (seen.has(t.id) || hidden.has(t.id)) continue;
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
 *  A panel shell whose panel is closed waits for the panel to open or the
 *  next load, so a shell opened on another device does not pop panels
 *  open on this one. A shell this window ended (`ended`) is never taken
 *  back: the list that follows a closed tab's socket can reach here before
 *  the server has heard the end, and adopting it would open a socket that
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

/** the `.term-view` box's vertical padding (styles.css), plus slack so the
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
