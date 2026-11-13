// How the page words a loadout (FR-065): the plan sheet's pick and the
// title of a run that started with one. Pure and browser-safe.
import type { Loadout, RunEquip } from "../../src/core/types";

/** The name, then in parentheses the harness when it is not claude and the
 *  model and effort when they are not `default`. */
export function loadoutLabel(l: Loadout): string {
  const bits = [l.harness !== "claude" ? l.harness : "", l.model !== "default" ? l.model : "", l.effort !== "default" ? l.effort : ""].filter(Boolean);
  return bits.length > 0 ? `${l.name} (${bits.join(", ")})` : l.name;
}

/** What a run started with, one line each, for a title. */
export function equipTitle(e: RunEquip): string {
  const set = [e.model !== "default" ? e.model : "", e.effort !== "default" ? e.effort : ""].filter(Boolean);
  return [
    `loadout ${e.loadout}`,
    set.length > 0 ? set.join(", ") : "",
    e.skills.length > 0 ? `skills: ${e.skills.join(", ")}` : "",
    e.mcp.length > 0 ? `servers: ${e.mcp.join(", ")}` : "",
    e.off > 0 ? `${e.off} skills off` : "",
    e.pluginsOff && e.pluginsOff.length > 0 ? `plugins off: ${e.pluginsOff.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}
