/**
 * Every mounted gear, by the surface it sets (FR-056): a right-click on a
 * panel, a section, the shells, the feed or a view offers that surface's
 * gear menu, read from here rather than built a second time. A gear
 * registers as it mounts against the nearest surface around its button and
 * says when its groups change, so an open menu shows a zoom's new level.
 * No React and no store; components/Gear.tsx registers, the context menu
 * reads.
 */
import type { GearGroup } from "./components/Gear";

/** The elements a gear sets, closest first. A section's gear is the
 *  section's, a panel head's the panel's, the strip's the shells'. */
export const GEAR_ROOTS = [
  "[data-section]",
  ".panel-shells",
  ".termdock",
  ".shell-solo",
  ".panel",
  ".feed",
  ".sidebar",
  "main.main",
  ".agents-view",
  ".incubator-view",
  ".library-view",
  ".sheet",
  ".settings-pop",
].join(", ");

export interface GearReg {
  /** the gear's own name as of its last render: "changes at canopy",
   *  "the event feed" */
  label: () => string;
  /** its groups as of its last render */
  groups: () => GearGroup[];
}

const byRoot = new Map<Element, GearReg[]>();
const listeners = new Set<() => void>();

/** Registers a gear against `root`; returns its release. */
export function registerGear(root: Element, reg: GearReg): () => void {
  const list = byRoot.get(root) ?? [];
  list.push(reg);
  byRoot.set(root, list);
  return () => {
    const now = byRoot.get(root)?.filter((r) => r !== reg) ?? [];
    if (now.length) byRoot.set(root, now);
    else byRoot.delete(root);
  };
}

/** The gear of the nearest surface around `el` that has one, with that
 *  surface, or null. */
export function gearAround(el: Element): { root: Element; reg: GearReg } | null {
  for (let at = el.closest(GEAR_ROOTS); at; at = at.parentElement?.closest(GEAR_ROOTS) ?? null) {
    const reg = byRoot.get(at)?.[0];
    if (reg) return { root: at, reg };
  }
  return null;
}

/** A gear's groups changed; an open menu showing them draws again. */
export function gearChanged(): void {
  for (const l of listeners) l();
}

export function onGearChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
