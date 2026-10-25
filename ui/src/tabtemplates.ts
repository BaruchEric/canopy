/**
 * Tab templates (FR-030): a screen layout profile's `tabs`, an arrangement
 * of the shell windows with no repo in it. `captureTabs` reads one from the
 * window as it stands (the first open card with sections as tabs, and the
 * strip's popups); `applyTabs` lands one on every open card, each card's
 * sections by name and "shell" as its first shell. Pure and browser-safe,
 * tested in tabtemplates.test.ts.
 */

import type { Repo, TabTemplate, TabTree } from "../../src/core/types";
import { POPUP_WORD, addItemTab, addSectionTab, isPopupName, sectionApplies, sectionTabId, type ItemTab, type SectionTab } from "./sectiontabs";
import { groupOf, leaveGroup, paneIds, type PaneTree } from "./splitpanes";
import { SECTION_WORD, isSectionKey } from "./surface";

/** the leaf that stands for a card's first shell */
export const SHELL_LEAF = "shell";

/** a card the template lands on: its repo, and its first shell in its panel */
export interface TabCard {
  repo: Pick<Repo, "id" | "forge" | "spec" | "host">;
  shell: string | null;
}

export interface TabState {
  sectionTabs: SectionTab[];
  itemTabs: ItemTab[];
  panelSplits: PaneTree[];
}

/** `t` with each leaf renamed by `f`, a leaf it returns null for gone */
function renamed(t: PaneTree, f: (pane: string) => string | null): PaneTree | null {
  if ("pane" in t) {
    const to = f(t.pane);
    return to ? { pane: to } : null;
  }
  const a = renamed(t.a, f);
  const b = renamed(t.b, f);
  if (!a) return b;
  if (!b) return a;
  return { ...t, a, b };
}

/** The window's tabs as a template: the sections the first card with any
 *  has as tabs beside its shells, the split holding them (its first shell
 *  as "shell", any other shell left out), and the popups in the strip. */
export function captureTabs(s: TabState, cards: readonly TabCard[]): TabTemplate {
  const strip = s.itemTabs.filter((t) => t.place === "strip" && t.kind === "popup").map((t) => t.ref);
  const card = cards.find((c) => s.sectionTabs.some((t) => t.place === "panel" && t.repoId === c.repo.id));
  if (!card) return { panel: [], strip };
  const mine = s.sectionTabs.filter((t) => t.place === "panel" && t.repoId === card.repo.id);
  const byId = new Map<string, string>(mine.map((t) => [t.id, t.key]));
  const group = mine.map((t) => groupOf(s.panelSplits, t.id)).find((g) => g !== undefined);
  let shellTaken = false;
  const split = group
    ? renamed(group, (id) => {
        const key = byId.get(id);
        if (key) return key;
        if (id === card.shell && !shellTaken) {
          shellTaken = true;
          return SHELL_LEAF;
        }
        return null;
      })
    : null;
  return { panel: mine.map((t) => t.key), ...(split && !("pane" in split) ? { split } : {}), strip };
}

/** what the strip had besides its popups, then the template's popups */
function stripPopups(items: readonly ItemTab[], names: readonly string[]): ItemTab[] {
  let out = items.filter((t) => !(t.place === "strip" && t.kind === "popup"));
  for (const n of names) if (isPopupName(n)) out = addItemTab(out, "strip", { kind: "popup", ref: n, label: POPUP_WORD[n] });
  return out;
}

/** The template landed on `cards`: each card's sections as tabs in its
 *  shells (what it had there goes back to the card), split with its first
 *  shell as the template says, and the strip's popups. A section a repo
 *  has nothing for, or a name the page does not know, is left out. */
export function applyTabs(t: TabTemplate, s: TabState, cards: readonly TabCard[]): TabState {
  let sectionTabs = s.sectionTabs;
  let panelSplits = s.panelSplits;
  if (t.panel) {
    const keys = t.panel.filter(isSectionKey);
    for (const { repo, shell } of cards) {
      const old = sectionTabs.filter((x) => x.place === "panel" && x.repoId === repo.id);
      for (const x of old) panelSplits = leaveGroup(panelSplits, x.id);
      sectionTabs = sectionTabs.filter((x) => !old.includes(x));
      const mine = keys.filter((k) => sectionApplies(k, repo));
      for (const k of mine) sectionTabs = addSectionTab(sectionTabs, "panel", repo.id, k);
      if (!t.split) continue;
      const tree = renamed(t.split, (leaf) => {
        if (leaf === SHELL_LEAF) return shell;
        return isSectionKey(leaf) && mine.includes(leaf) ? sectionTabId("panel", leaf, repo.id) : null;
      });
      if (!tree || "pane" in tree) continue;
      for (const id of paneIds(tree)) panelSplits = leaveGroup(panelSplits, id);
      panelSplits = [...panelSplits, tree];
    }
  }
  const itemTabs = t.strip ? stripPopups(s.itemTabs, t.strip) : s.itemTabs;
  return { sectionTabs, itemTabs, panelSplits };
}

/** a split in words: "changes | history / shell" */
function treeWords(t: TabTree | PaneTree): string {
  if ("pane" in t) return t.pane;
  const side = (x: TabTree | PaneTree) => ("pane" in x || x.dir === t.dir ? treeWords(x) : `(${treeWords(x)})`);
  return `${side(t.a)} ${t.dir === "row" ? "|" : "/"} ${side(t.b)}`;
}

/** A template in one line for a profile's row: "cards: changes | history /
 *  shell · strip: tasks", "no tabs" for an empty one. */
export function tabsWords(t: TabTemplate): string {
  const parts: string[] = [];
  const inSplit = new Set(t.split ? paneIds(t.split) : []);
  const loose = (t.panel ?? []).filter((k) => !inSplit.has(k)).map((k) => (isSectionKey(k) ? SECTION_WORD[k] : k));
  const cards = [t.split ? treeWords(t.split) : "", ...loose].filter(Boolean);
  if (cards.length > 0) parts.push(`cards: ${cards.join(", ")}`);
  if (t.strip && t.strip.length > 0) parts.push(`strip: ${t.strip.map((n) => (isPopupName(n) ? POPUP_WORD[n] : n)).join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "no tabs";
}

