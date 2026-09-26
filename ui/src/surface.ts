/** What every gear works over: the kinds of surface, their zoom, how a
 *  panel's sections are ordered and which are hidden, and how a surface
 *  sits. Pure, so the settings loader and the tests share it. */

/** a panel's sections, in the order a panel shows them by default; the
 *  shells are not here, since they are the panel's footer */
export const SECTION_KEYS = ["changes", "search", "history", "peers", "preview", "launch", "claude"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_WORD: Record<SectionKey, string> = {
  changes: "changes",
  search: "search",
  history: "history",
  peers: "peers",
  preview: "preview",
  launch: "launch",
  claude: "claude",
};

export const isSectionKey = (v: unknown): v is SectionKey =>
  typeof v === "string" && (SECTION_KEYS as readonly string[]).includes(v);

/** the surfaces with a zoom of their own; the shells zoom through the
 *  terminal's font size instead, since css zoom on an xterm puts its mouse
 *  and selection off by the factor */
export const ZOOM_KINDS = ["panel", ...SECTION_KEYS, "feed"] as const;
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
 *  zoom of 1 left out, since that is what no entry means */
export function normalizeZooms(v: unknown): Zooms {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Zooms = {};
  for (const [k, z] of Object.entries(v)) {
    if (!(ZOOM_KINDS as readonly string[]).includes(k)) continue;
    if (typeof z !== "number" || !Number.isFinite(z)) continue;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (Math.abs(clamped - 1) > 0.001) out[k as ZoomKind] = clamped;
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
