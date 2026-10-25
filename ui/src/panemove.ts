/**
 * A tab dragged from one shell window into another (FR-031): a card's
 * shells, the strip (and the sessions view, which shows it) or a shell
 * window of its own. Which moves a window takes, and what a section, chat
 * or popup tab is called once it lands, since a page tab's id names its
 * place. Pure and tested (panemove.test.ts); `components/SessionPanes.tsx`
 * carries the move out.
 */
import { addItemTab, addSectionTab, isItemTab, itemTabId, sectionTabId, type ItemTab, type PageTab, type SectionPlace, type SectionTab } from "./sectiontabs";
import type { TermTab } from "./term";

/** a shell window a tab can land in; a card's and a shell window's name
 *  their repo, since they show only its tabs */
export interface Spot {
  place: SectionPlace;
  repoId?: string;
}

/** what is being moved: a shell's tab, or a section, chat or popup tab */
export type Movable = { kind: "shell"; tab: TermTab } | { kind: "page"; tab: PageTab };

/** the tab `id` names among the shells and page tabs */
export function movableOf(terms: readonly TermTab[], sections: readonly SectionTab[], items: readonly ItemTab[], id: string): Movable | null {
  const shell = terms.find((t) => t.id === id);
  if (shell) return { kind: "shell", tab: shell };
  const page = sections.find((t) => t.id === id) ?? items.find((t) => t.id === id);
  return page ? { kind: "page", tab: page } : null;
}

/** where a tab sits now, in the same terms as a drop spot */
const spotOf = (m: Movable): Spot => ({ place: m.tab.place, ...(m.tab.repoId ? { repoId: m.tab.repoId } : {}) });

/** the window `to` already holds the tab */
const sameSpot = (m: Movable, to: Spot): boolean => {
  const at = spotOf(m);
  return at.place === to.place && (to.place === "strip" || at.repoId === to.repoId);
};

/**
 * Whether `to` takes `m` from another window. The strip takes any tab. A
 * card's shells take only their own repo's: a shell lives in its repo's
 * folder, and a section or a run belongs to its card. A popup has no repo,
 * so no card takes it. A shell window has one shell of its own, so it
 * takes only its repo's sections. A task's, the ranger's, a joined view's
 * and an ended shell are not moved at all.
 */
export function canMove(m: Movable, to: Spot): boolean {
  if (sameSpot(m, to)) return false;
  if (m.kind === "shell") {
    const t = m.tab;
    if (t.task !== undefined || t.ranger || t.joinOnly || t.exit !== undefined) return false;
    if (to.place === "strip") return true;
    return to.place === "panel" && to.repoId === t.repoId;
  }
  if (to.place === "strip") return true;
  if (to.place === "window") return !isItemTab(m.tab) && to.repoId === m.tab.repoId;
  return m.tab.repoId !== undefined && to.repoId === m.tab.repoId;
}

/** the id a tab has once it lands at `to` */
export function movedId(m: Movable, to: Spot): string {
  if (m.kind === "shell") return m.tab.id;
  const t = m.tab;
  return isItemTab(t) ? itemTabId(to.place, t.kind, t.ref) : sectionTabId(to.place, t.key, t.repoId);
}

/** the page tabs with `tab` at `to`, out of where it was */
export function movePage(sections: readonly SectionTab[], items: readonly ItemTab[], tab: PageTab, to: Spot): { sections: SectionTab[]; items: ItemTab[] } {
  if (isItemTab(tab)) {
    const { id: _, place: __, ...ref } = tab;
    return { sections: [...sections], items: addItemTab(items, to.place, ref) };
  }
  return { sections: addSectionTab(sections, to.place, tab.repoId, tab.key), items: [...items] };
}
