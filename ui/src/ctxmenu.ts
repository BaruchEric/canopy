/**
 * Right-click menus (FR-056), the pure half: what a right-click landed on,
 * whether canopy answers it at all, where the menu and its submenus go, the
 * pointer's path into a submenu, and the type-to-filter match. The page half
 * is components/ContextMenu.tsx (the one host) and ContextMenus.tsx (what
 * each kind of thing offers). Tested in ctxmenu.test.ts.
 *
 * A right-click is read off the clicked element's ancestors, innermost
 * first, each described as plain data (`CtxNode`), so this file never
 * touches the DOM and the tests need none.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** how close a menu comes to the window's edge, px */
export const EDGE = 8;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where a menu opened at a point goes: its corner on the point, flipped to
 * the point's left or above it where it would cross the far edge, then held
 * `EDGE` inside the window. `ox`/`oy` are the point inside the menu, which
 * the open grows from.
 */
export function placeAt(p: Point, size: Size, view: Size): { left: number; top: number; ox: number; oy: number } {
  let left = p.x;
  if (left + size.w > view.w - EDGE) left = p.x - size.w;
  left = clamp(left, EDGE, view.w - size.w - EDGE);
  let top = p.y;
  if (top + size.h > view.h - EDGE) top = p.y - size.h;
  top = clamp(top, EDGE, view.h - size.h - EDGE);
  return { left, top, ox: clamp(p.x - left, 0, size.w), oy: clamp(p.y - top, 0, size.h) };
}

/** a menu opened from the keyboard: under the element, as a dropdown */
export function placeUnder(r: Box, size: Size, view: Size): { left: number; top: number; ox: number; oy: number } {
  const below = r.bottom + 2;
  const top = below + size.h > view.h - EDGE ? clamp(r.top - 2 - size.h, EDGE, view.h - size.h - EDGE) : below;
  const left = clamp(r.left, EDGE, view.w - size.w - EDGE);
  return { left, top, ox: 0, oy: top < r.top ? size.h : 0 };
}

/**
 * A submenu beside the row that opened it: off the parent menu's right
 * edge, or its left where the right has no room, with its first row level
 * with the parent row (less the menu's top padding), held inside the window.
 */
export function placeSub(row: Box, parent: Box, size: Size, view: Size, pad = 4): { left: number; top: number; side: "right" | "left" } {
  const right = parent.right - 2;
  const side = right + size.w <= view.w - EDGE || parent.left - size.w + 2 < EDGE ? "right" : "left";
  const left = clamp(side === "right" ? right : parent.left - size.w + 2, EDGE, view.w - size.w - EDGE);
  const top = clamp(row.top - pad, EDGE, view.h - size.h - EDGE);
  return { left, top, side };
}

/** whether `p` lies in the triangle a, b, c (edges count) */
export function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const cross = (u: Point, v: Point, w: Point) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Whether a pointer that moved from `from` to `to` is on its way into an
 * open submenu: inside the triangle from where it was to the submenu's near
 * edge. Crossing a sibling row on that path leaves the submenu open, the
 * way a desktop menu forgives a diagonal.
 */
export function headingInto(from: Point, to: Point, sub: Box, side: "right" | "left"): boolean {
  const x = side === "right" ? sub.left : sub.right;
  if (side === "right" ? to.x < from.x : to.x > from.x) return false;
  return inTriangle(to, from, { x, y: sub.top - 6 }, { x, y: sub.bottom + 6 });
}

/**
 * The type-to-filter match: every character of the query in order, case
 * and accents aside, or null. Higher is better: a match at a word's start,
 * a run of characters in a row and an early first hit each count.
 */
export function fuzzy(text: string, query: string): number | null {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const t = fold(text);
  const q = fold(query).replace(/\s+/g, " ").trim();
  if (q === "") return 0;
  // a plain substring wins outright, earlier and at a word start better
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at + (at === 0 || /\W/.test(t[at - 1] ?? "") ? 200 : 0);
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += i === last + 1 ? 8 : 1;
    if (i === 0 || /\W/.test(t[i - 1] ?? "")) score += 6;
    last = i;
    from = i + 1;
  }
  return score - Math.min(t.indexOf(q.replace(/ /g, "")[0] ?? ""), 40) / 10;
}

/** What every row of a menu built from data has, whatever it does. */
interface CtxRow {
  /** unique in its menu; what the filter keys a hit by */
  id: string;
  label: string;
  /** a fact at the row's end: a count, where it goes, or `code` (a
   *  branch, a path) in the mono face */
  fact?: string | { code: string };
  /** a key that does the same, shown at the row's end */
  keys?: string;
  /** a glyph before the words: ★, a harness's mark */
  glyph?: string;
  /** a colour for the row: sky for live, rust for an ending */
  tone?: "sky" | "lichen" | "rust" | "moss";
  /** why it cannot run here: the row shows, dimmed, and does nothing */
  off?: string;
  title?: string;
}

/** One row of a menu built from data: it runs something, opens a link in
 *  a new tab, or opens rows of its own beside it. */
export type CtxItem =
  /** `stay` keeps the menu open after the run (a toggle) */
  | (CtxRow & { kind: "run"; run: () => unknown; stay?: true })
  | (CtxRow & { kind: "link"; href: string })
  | (CtxRow & { kind: "sub"; sub: CtxItem[] });

export interface CtxGroup {
  label?: string;
  items: CtxItem[];
}

/** A filter hit: the row, and the labels of the rows above it ("copy",
 *  then "branch"), which the results show as a path. */
export interface CtxHit {
  item: CtxItem;
  path: string[];
  score: number;
}

/** Every row of the groups, submenus' rows included, that matches the
 *  query, best first. A submenu's own row is never a hit: its rows are,
 *  matched with its label in front ("copy branch"). A dimmed row sorts
 *  after every live one. */
export function searchItems(groups: readonly CtxGroup[], query: string): CtxHit[] {
  const hits: CtxHit[] = [];
  const walk = (items: readonly CtxItem[], path: string[]) => {
    for (const item of items) {
      if (item.kind === "sub") {
        walk(item.sub, [...path, item.label]);
        continue;
      }
      const fact = typeof item.fact === "object" ? item.fact.code : (item.fact ?? "");
      const words = [...path, item.label, fact].join(" ");
      const score = fuzzy(words, query);
      if (score !== null) hits.push({ item, path, score: score + (item.off ? -500 : 0) });
    }
  };
  for (const g of groups) walk(g.items, []);
  return hits.sort((a, b) => b.score - a.score);
}

/**
 * Moves the active row by `delta` through `n` rows, skipping the ones
 * `skip` names (dimmed rows), wrapping at the ends; -1 (nothing active)
 * steps to the first or the last. Returns -1 when nothing can be active.
 */
export function stepActive(n: number, at: number, delta: number, skip: (i: number) => boolean = () => false): number {
  if (n <= 0) return -1;
  let i = at < 0 ? (delta > 0 ? -1 : n) : at;
  for (let k = 0; k < n; k++) {
    i = (((i + delta) % n) + n) % n;
    if (!skip(i)) return i;
  }
  return -1;
}

/** An element on the way up from what a right-click landed on. */
export interface CtxNode {
  tag: string;
  cls: readonly string[];
  attrs: Readonly<Record<string, string>>;
}

/** Why canopy leaves a right-click to the browser, or to what is under it. */
export type CtxSkip =
  /** Shift was held: the browser's own menu, always */
  | "shift"
  /** a text box: the browser's menu has its spelling and paste */
  | "typing"
  /** a shell: xterm's selection and canopy's shell rules (SPEC 2026-11-07) */
  | "shell"
  /** the Secrets view: nothing there is offered to copy */
  | "secrets"
  /** a picture, a video or a sound, whose menu saves it */
  | "media"
  /** marked `data-native-menu` by the thing itself */
  | "native"
  /** inside an open menu: swallowed, nothing opens on top */
  | "menu";

const TYPES = new Set(["input", "textarea", "select", "option"]);
const MEDIA = new Set(["img", "video", "audio", "picture", "canvas"]);

/** Whether canopy stays out of a right-click on `chain` (innermost first). */
export function ctxSkip(chain: readonly CtxNode[], shift: boolean): CtxSkip | null {
  if (shift) return "shift";
  const first = chain[0];
  if (first && MEDIA.has(first.tag)) return "media";
  for (const n of chain) {
    if (n.attrs["role"] === "menu" || n.cls.includes("ctx-menu")) return "menu";
    if (TYPES.has(n.tag)) return "typing";
    const editable = n.attrs["contenteditable"];
    if (editable !== undefined && editable !== "false") return "typing";
    if (n.cls.includes("term-view") || n.cls.includes("xterm")) return "shell";
    if (n.cls.includes("secrets-view")) return "secrets";
    if (n.attrs["data-native-menu"] !== undefined) return "native";
  }
  return null;
}

/** What a right-click is about, innermost first; a menu is built from them. */
export type CtxSubject =
  | { kind: "repo"; id: string }
  | { kind: "inbox"; key: string }
  | { kind: "trigger"; id: string }
  /** a panel's tab in a dock strip, by panel id */
  | { kind: "tab"; id: string }
  /** a repo panel, `head` when the click was on its head */
  | { kind: "panel"; id: string; head: boolean }
  /** a section of a repo panel, by key; `repo` from the panel around it */
  | { kind: "section"; key: string; repo: string | null }
  /** an agent's card on the board */
  | { kind: "agent"; id: string };

/** Every subject on the way up, innermost first, each kind once. */
export function ctxSubjects(chain: readonly CtxNode[]): CtxSubject[] {
  const out: CtxSubject[] = [];
  const seen = new Set<string>();
  const put = (s: CtxSubject) => {
    if (seen.has(s.kind)) return;
    seen.add(s.kind);
    out.push(s);
  };
  let head = false;
  chain.forEach((n, i) => {
    const kb = n.attrs["data-kb"];
    if (kb) {
      const c = kb.indexOf(":");
      const kind = kb.slice(0, c);
      const id = kb.slice(c + 1);
      if (c > 0 && id) {
        if (kind === "repo") put({ kind: "repo", id });
        else if (kind === "inbox") put({ kind: "inbox", key: id });
        else if (kind === "trigger") put({ kind: "trigger", id });
      }
    }
    if (n.cls.includes("panel-head")) head = true;
    const tab = n.attrs["data-id"];
    if (tab && n.cls.includes("dock-tab")) put({ kind: "tab", id: tab });
    const section = n.attrs["data-section"];
    if (section) {
      const panel = chain.slice(i + 1).find((m) => m.attrs["data-repo"] !== undefined);
      put({ kind: "section", key: section, repo: panel?.attrs["data-repo"] ?? null });
    }
    const repo = n.attrs["data-repo"];
    if (repo !== undefined && n.cls.includes("panel")) put({ kind: "panel", id: repo, head });
    const card = n.attrs["data-card"];
    if (card) put({ kind: "agent", id: card });
  });
  return out;
}

/** the link a right-click is on, if any: an `a` with an http(s) href */
export function ctxLink(chain: readonly CtxNode[]): string | null {
  for (const n of chain) {
    if (n.tag !== "a") continue;
    const href = n.attrs["href"];
    return href && /^https?:\/\//i.test(href) ? href : null;
  }
  return null;
}

/** Whether an element holds one fact worth copying whole: code, a branch,
 *  a path, or anything marked `data-copy`. */
export function isFact(n: CtxNode): boolean {
  if (n.attrs["data-copy"] !== undefined) return true;
  if (n.tag === "code" || n.tag === "kbd" || n.tag === "pre") return true;
  return n.cls.some((c) => c === "branch" || c === "root-path" || c === "trigger-id" || c === "id-label");
}

/** A fact's text as a menu row says it: one line, cut at `max`. */
export function factLabel(text: string, max = 28): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
