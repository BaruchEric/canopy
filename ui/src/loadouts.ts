// How the page words a loadout (FR-065): the plan sheet's pick and the
// title of a run that started with one. Pure and browser-safe.
import { baseCovers } from "../../src/core/loadout";
import type { CardEquip, Loadout, Mention, RunAction, RunEquip } from "../../src/core/types";

/** The loadouts the plan sheet offers for an action: plan, then build needs
 *  Claude Code, so a propose is offered no codex loadout. */
export function loadoutsFor(action: RunAction, loadouts: readonly Loadout[] | undefined): readonly Loadout[] {
  if (!loadouts) return [];
  return action === "propose" ? loadouts.filter((l) => l.harness === "claude") : loadouts;
}

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

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

/** What a card stores for the picks on the equip sheet: the loadout's name
 *  and only the fields that differ from the loadout's own values (skills and
 *  servers compared as sets), so a loadout edited later still shows through. */
export function equipFrom(
  loadout: Loadout,
  picks: { model: string; effort: string; skills: readonly string[]; mcp: readonly string[] },
): CardEquip {
  const out: CardEquip = { loadout: loadout.name };
  if (picks.model !== loadout.model) out.model = picks.model;
  if (picks.effort !== loadout.effort) out.effort = picks.effort as CardEquip["effort"];
  if (!sameSet(picks.skills, loadout.skills)) out.skills = [...picks.skills];
  if (!sameSet(picks.mcp, loadout.mcp)) out.mcp = [...picks.mcp];
  return out;
}

/** "superpowers" out of a skill's `plugin:superpowers` origin, null for a user skill */
export const pluginOf = (w: Mention): string | null => (w.plugin && w.from.startsWith("plugin:") ? w.from.slice("plugin:".length) : null);

/** The sentence under a plugin's skill: plugins turn on and off whole. */
export const pluginLine = (w: Mention): string | null => {
  const plugin = pluginOf(w);
  return plugin ? `Checking it turns on the whole ${plugin} plugin.` : null;
};

export interface SkillRow {
  name: string;
  description: string;
  /** the sentence about its plugin, or null for a user skill */
  plugin: string | null;
  on: boolean;
  /** on because `loadoutBase` or a `plugin:*` pick covers it: it cannot be unchecked here */
  locked: boolean;
}

/** The skill rows the sheet draws: Claude's skills matching the find box, by
 *  name. A skill the kit's base or a `plugin:*` pick covers reads on and is
 *  locked, since the server keeps it on whatever the card lists. */
export function skillRows(words: readonly Mention[], q: string, picked: readonly string[], base: readonly string[]): SkillRow[] {
  const find = q.trim().toLowerCase();
  return words
    .filter((w) => w.kind === "skill" && w.harness === "claude")
    .filter((w) => !find || `${w.name} ${w.description}`.toLowerCase().includes(find))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((w) => {
      const locked = baseCovers(base, w.name) || picked.some((p) => p !== w.name && baseCovers([p], w.name));
      return { name: w.name, description: w.description, plugin: pluginLine(w), on: locked || picked.includes(w.name), locked };
    });
}

/** The loadout's servers this backend can run; a server it refuses is not saved or counted. */
export const serversHere = (mcp: readonly string[], servers: readonly { name: string; here: boolean }[]): string[] =>
  mcp.filter((m) => !servers.some((s) => s.name === m && !s.here));
