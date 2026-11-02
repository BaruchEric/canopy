/**
 * The keyboard ring (FR-023): j and k move it through the repo cards and
 * the tree's rows, the trigger rows and the inbox rows; Space peeks at the
 * ringed item's run and Enter goes in. The place is a key, `<kind>:<id>`,
 * kept in the store (`kbFocus`, with `kbRing` while it shows), so a list
 * that reorders or remounts under an SSE update leaves it where it was. The
 * lists are read from the page by components/KbFocus.tsx; this half is pure
 * and tested (kbfocus.test.ts). Design:
 * docs/superpowers/specs/2026-11-02-keyboard-focus-design.md.
 */

export type KbKind = "repo" | "trigger" | "inbox";

/** what the ring is on: a repo by its id, a trigger row by `triggerKbId`,
 *  an inbox row by its item's key */
export interface KbTarget {
  kind: KbKind;
  id: string;
}

const KINDS: readonly string[] = ["repo", "trigger", "inbox"] satisfies KbKind[];

export const kbKey = (kind: KbKind, id: string): string => `${kind}:${id}`;

/** A key's kind and id, split at the first colon, since ids hold colons
 *  of their own; null for anything else. */
export function parseKb(key: string): KbTarget | null {
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) return null;
  const kind = key.slice(0, i);
  return KINDS.includes(kind) ? { kind: kind as KbKind, id: key.slice(i + 1) } : null;
}

/** What the ring is on, or null while it is hidden. FR-024's ⌘K and
 *  FR-025's copy keys act on this. */
export function ringOf(s: { kbFocus: string | null; kbRing: boolean }): KbTarget | null {
  return s.kbRing && s.kbFocus ? parseKb(s.kbFocus) : null;
}

/** a trigger row's id: its backend's name and its event's id, which has no
 *  colon of its own */
export const triggerKbId = (backend: string, eventId: string): string => `${backend}:${eventId}`;

/** a trigger row's id read back, split at the last colon */
export function triggerOf(id: string): { backend: string; eventId: string } | null {
  const i = id.lastIndexOf(":");
  return i > 0 && i < id.length - 1 ? { backend: id.slice(0, i), eventId: id.slice(i + 1) } : null;
}

/** Keys once each, in their first order: a repo's tree row and its card
 *  are one item. */
export const uniqueKeys = (keys: Iterable<string>): string[] => [...new Set(keys)];

const clamp = (i: number, n: number): number => Math.max(0, Math.min(n - 1, i));

/** The key nearest `at` in `before` that `keys` still lists, looking `dir`
 *  first and then the other way; null when `before` never had `at` or
 *  nothing of it is left. */
function neighbour(keys: readonly string[], at: string, before: readonly string[], dir: 1 | -1): string | null {
  const from = before.indexOf(at);
  if (from < 0) return null;
  const listed = new Set(keys);
  for (const d of [dir, -dir]) {
    for (let i = from + d; i >= 0 && i < before.length; i += d) {
      const k = before[i];
      if (k !== undefined && listed.has(k)) return k;
    }
  }
  return null;
}

/**
 * Where a press moves the ring: `delta` items on from `at` in `keys`, held
 * at both ends. From no place, or one this list never had, the first item.
 * From a place that left the list, the first step lands on its neighbour
 * still listed in the press's direction, read from `before` (the list as
 * it was while the place was in it), else on the nearest the other way.
 */
export function stepKb(keys: readonly string[], at: string | null, delta: number, before: readonly string[] = []): string | null {
  if (keys.length === 0) return null;
  const first = keys[0] ?? null;
  if (at === null) return first;
  const i = keys.indexOf(at);
  if (i >= 0) return keys[clamp(i + delta, keys.length)] ?? null;
  const dir = delta < 0 ? -1 : 1;
  const landed = neighbour(keys, at, before, dir);
  if (landed === null) return first;
  const rest = delta === 0 ? 0 : delta - dir;
  return keys[clamp(keys.indexOf(landed) + rest, keys.length)] ?? null;
}

/** The place once the list changed: `at` while it is listed, else the item
 *  that took its place (the next one still listed in `before`'s order,
 *  else the one before it), else null. */
export function keepKb(keys: readonly string[], at: string | null, before: readonly string[]): string | null {
  if (at === null) return null;
  if (keys.includes(at)) return at;
  return neighbour(keys, at, before, 1);
}

/** a part of the page with a list of its own */
export type KbZone = "repos" | "dock" | "triggers";

/** Each zone's roots on the page: the tree (its column or the drawer) and
 *  the grid, which list the same repos in the same order; the dock, where
 *  "waiting on you" lists the inbox; the triggers view. */
export const KB_ZONES: Record<KbZone, string> = {
  repos: "#sidebar, main.main",
  dock: ".dock",
  triggers: ".trigger-view",
};

/** the zone a view walks when the one last pressed in has nothing */
export function homeZone(view: string): KbZone | null {
  return view === "git" ? "repos" : view === "triggers" ? "triggers" : null;
}

/** what a test or the page asks `closest` of: an Element, or a stand-in */
export interface Closest {
  closest(selector: string): unknown;
}

/** what types: letters and Space are its own */
export const TYPES_INTO =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, .term-screen, [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"]';

/** what moves with the arrows: widgets that step through their options,
 *  and a focusable box that scrolls (a log, a diff) */
export const OWN_ARROWS =
  '[role="slider"], [role="spinbutton"], [role="radiogroup"], [role="radio"], [role="tablist"], [role="tab"], [role="option"], [role="menuitem"], [role="tree"], [role="grid"], [tabindex]:not([data-kb])';

/** a control that Space and Enter press for themselves while it holds the
 *  DOM's focus */
export const PRESSES = 'button, a[href], summary, label, [role="button"], [role="checkbox"], [role="link"], [tabindex]:not([tabindex="-1"])';

export type RingPress = "j" | "k" | "ArrowDown" | "ArrowUp" | " " | "Enter";

/** Whether the ring takes a press made at `target` (the key event's
 *  target, the element holding DOM focus): never from what types, the
 *  arrows never from what moves with them, Space and Enter never from a
 *  control that presses for itself. */
export function ringTakes(press: RingPress, target: Closest | null): boolean {
  if (!target) return true;
  if (target.closest(TYPES_INTO)) return false;
  if (press === "ArrowDown" || press === "ArrowUp") return !target.closest(OWN_ARROWS);
  if (press === " " || press === "Enter") return !target.closest(PRESSES);
  return true;
}
