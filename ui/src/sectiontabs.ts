/**
 * A card's sections as tabs in a shell window (FR-030). Any section of a
 * repo's card (changes, files, history and the rest) can leave the card and
 * sit as a tab beside the shells: in the card's own shell section, in the
 * strip and the sessions view, or in a shell window of its own. A section
 * tabbed anywhere is gone from its card until its tab closes.
 *
 * A tab is kept by an id no shell can have (`sec:`), so the split groups
 * (splitpanes.ts) hold it as a pane next to shells. The tabs are a setting
 * kept per kind of screen, as the split groups are. Pure and browser-safe,
 * tested in sectiontabs.test.ts.
 */

import type { Repo } from "../../src/core/types";
import { SECTION_KEYS, SECTION_WORD, isSectionKey, type SectionKey } from "./surface";

/** the shell windows a section can be a tab in: a card's shell section,
 *  the strip (which the sessions view shows too), or a shell window */
export const SECTION_PLACES = ["panel", "strip", "window"] as const;
export type SectionPlace = (typeof SECTION_PLACES)[number];

export interface SectionTab {
  /** `sec:<place>:<key>:<repo id>`, never a shell's */
  id: string;
  repoId: string;
  key: SectionKey;
  place: SectionPlace;
}

/** the most section tabs one browser keeps */
const MOST = 64;
const PREFIX = "sec:";

export const sectionTabId = (place: SectionPlace, key: SectionKey, repoId: string): string => `${PREFIX}${place}:${key}:${repoId}`;

export const isSectionTabId = (id: string): boolean => id.startsWith(PREFIX);

export const isSectionTab = (t: { id: string }): t is SectionTab => isSectionTabId(t.id);

/** Whether a section has anything to show for `repo`, as PanelSection
 *  decides: a branch run, the files, the tasks and the agents work on the
 *  backend's own disk, the spec only once scanned, the preview only on the
 *  checkout's own backend. */
export function sectionApplies(k: SectionKey, repo: Pick<Repo, "forge" | "spec" | "host">): boolean {
  switch (k) {
    case "landing":
    case "files":
    case "tasks":
    case "agents":
      return !repo.forge;
    case "spec":
      return repo.spec !== undefined;
    case "preview":
      return !repo.host;
    default:
      return true;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The saved tabs read back: each checked, a section in one place only
 *  (the first kept), the id made again from its parts. */
export function sectionTabsOf(v: unknown): SectionTab[] {
  if (!Array.isArray(v)) return [];
  const out: SectionTab[] = [];
  for (const t of v) {
    if (out.length >= MOST) break;
    if (!isRecord(t)) continue;
    const { repoId, key, place } = t;
    if (typeof repoId !== "string" || !repoId || repoId.length > 1000 || !isSectionKey(key)) continue;
    const at = SECTION_PLACES.find((p) => p === place);
    if (!at || out.some((x) => x.repoId === repoId && x.key === key)) continue;
    out.push({ id: sectionTabId(at, key, repoId), repoId, key, place: at });
  }
  return out;
}

/** `key` of `repoId` as a tab at `place`, at the end of the row; out of
 *  any other place it was a tab in */
export function addSectionTab(tabs: readonly SectionTab[], place: SectionPlace, repoId: string, key: SectionKey): SectionTab[] {
  const rest = tabs.filter((t) => !(t.repoId === repoId && t.key === key));
  return [...rest, { id: sectionTabId(place, key, repoId), repoId, key, place }].slice(-MOST);
}

/** the tab `id` closed: its section is back in its card */
export const dropSectionTab = (tabs: readonly SectionTab[], id: string): SectionTab[] => tabs.filter((t) => t.id !== id);

/** the tabs at `place`, for `repoId` alone when given */
export const sectionTabsAt = (tabs: readonly SectionTab[], place: SectionPlace, repoId?: string): SectionTab[] =>
  tabs.filter((t) => t.place === place && (repoId === undefined || t.repoId === repoId));

/** the sections of `repoId` that are tabs somewhere, so out of its card */
export const tabbedKeys = (tabs: readonly SectionTab[], repoId: string): ReadonlySet<SectionKey> =>
  new Set(tabs.filter((t) => t.repoId === repoId).map((t) => t.key));

/** the sections of `repo` a tab menu offers as a new tab: the ones with
 *  something to show there that are not a tab yet and not hidden in every
 *  panel, in the panel's order */
export function tabbableKeys(
  tabs: readonly SectionTab[],
  repo: Pick<Repo, "id" | "forge" | "spec" | "host">,
  order: readonly SectionKey[] = SECTION_KEYS,
  hidden: readonly SectionKey[] = [],
): SectionKey[] {
  const taken = tabbedKeys(tabs, repo.id);
  return order.filter((k) => !taken.has(k) && !hidden.includes(k) && sectionApplies(k, repo));
}

/** what a section tab says: the section, and its repo's name where the row
 *  holds more than one repo */
export const sectionTabLabel = (t: SectionTab, repoName?: string): string => (repoName ? `${SECTION_WORD[t.key]} · ${repoName}` : SECTION_WORD[t.key]);
