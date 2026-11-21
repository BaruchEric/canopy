/**
 * What a repo's map section shows: Floorplan's map (FR-070) or Archify's
 * diagrams (FR-071), remembered per repo in this browser. Tested in
 * mapkind.test.ts.
 */

export type MapKind = "floorplan" | "archify";

/** where each repo's choice is kept (localStorage), by repo id */
export const MAP_KIND_KEY = "canopy.mapKind";

/** the most repos the memory keeps; the oldest go first */
const KEEP = 200;

const isKind = (v: unknown): v is MapKind => v === "floorplan" || v === "archify";

/** The saved choices, read leniently: anything that is not one is dropped. */
export function parseMapKinds(raw: string | null): Record<string, MapKind> {
  if (!raw) return {};
  try {
    const got: unknown = JSON.parse(raw);
    if (typeof got !== "object" || got === null || Array.isArray(got)) return {};
    return Object.fromEntries(Object.entries(got).filter((e): e is [string, MapKind] => isKind(e[1])));
  } catch {
    return {};
  }
}

/** The choices with one repo's set and moved last; Floorplan, the default,
 *  is not kept. At most KEEP repos. */
export function withMapKind(kinds: Record<string, MapKind>, id: string, kind: MapKind): Record<string, MapKind> {
  const rest = Object.entries(kinds).filter(([k]) => k !== id);
  const all: [string, MapKind][] = kind === "floorplan" ? rest : [...rest, [id, kind]];
  return Object.fromEntries(all.slice(-KEEP));
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** a repo's choice in this browser, Floorplan when none was made */
export function loadMapKind(id: string): MapKind {
  try {
    return parseMapKinds(storage()?.getItem(MAP_KIND_KEY) ?? null)[id] ?? "floorplan";
  } catch {
    return "floorplan";
  }
}

/** keeps a repo's choice; a browser that will not store it forgets it */
export function saveMapKind(id: string, kind: MapKind): void {
  try {
    const s = storage();
    s?.setItem(MAP_KIND_KEY, JSON.stringify(withMapKind(parseMapKinds(s.getItem(MAP_KIND_KEY)), id, kind)));
  } catch {
    // private mode or a full store: the choice lasts this page only
  }
}
