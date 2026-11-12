/** The plugins view's pure side (FR-064): every backend's machines merged,
 *  a row per plugin, a column per machine and agent, and what each cell
 *  offers. The server refuses what core/plugins.ts refuses; the page asks
 *  the same function first, so it never offers a button that would 409. */
import { refusal } from "../../src/core/plugins";
import type { KitInfo, PluginAgent, PluginAgentSeen, PluginMachineSeen, PluginOp, PluginOpRequest, PluginSeen } from "../../src/core/types";

/** a machine as the page holds it: with the backend that reaches it */
export type PluginMachine = PluginMachineSeen & { backend: string };

export interface PluginColumn { machine: string; agent: PluginAgent }

export type PluginCellState = "on" | "off" | "wanted" | "broken" | "none" | "noagent";

export interface PluginCell { state: PluginCellState; plugin: PluginSeen | null; why: string }

export const PLUGIN_GLYPH: Record<PluginCellState, string> = { on: "●", off: "◐", wanted: "○", broken: "!", none: "", noagent: "–" };

export const PLUGIN_PROBLEM: ReadonlySet<PluginCellState> = new Set(["wanted", "broken"]);

export interface PluginFilter { agent: PluginAgent | null; machine: string | null; problems: boolean; text: string }

/** every backend's machines; a machine two backends both report is the first's */
export function mergePlugins(byBackend: Record<string, KitInfo>): PluginMachine[] {
  const out: PluginMachine[] = [];
  for (const [backend, info] of Object.entries(byBackend)) {
    for (const m of info.plugins ?? []) if (!out.some((x) => x.machine === m.machine)) out.push({ ...m, backend });
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine));
}

/** whether any backend on the page reads plugins at all (kit.json's `plugins`) */
export const readsPlugins = (byBackend: Record<string, KitInfo>): boolean => Object.values(byBackend).some((i) => i.plugins !== undefined);

/** a column per machine that was read and each agent read there, claude first */
export function pluginColumns(ms: readonly PluginMachine[], f: Pick<PluginFilter, "agent" | "machine">): PluginColumn[] {
  return ms.flatMap((m) =>
    m.away || (f.machine && m.machine !== f.machine) ? [] : m.agents.filter((a) => !f.agent || a.agent === f.agent).map((a) => ({ machine: m.machine, agent: a.agent })));
}

const agentOf = (m: PluginMachine | undefined, agent: PluginAgent): PluginAgentSeen | undefined => m?.agents.find((a) => a.agent === agent);

export function cellOf(ms: readonly PluginMachine[], col: PluginColumn, id: string): PluginCell {
  const m = ms.find((x) => x.machine === col.machine);
  if (m?.away) return { state: "noagent", plugin: null, why: `away: ${m.away}` };
  const a = agentOf(m, col.agent);
  if (!a || !a.path) return { state: "noagent", plugin: null, why: a?.error ?? `${col.agent} is not read on ${col.machine}` };
  const p = a.plugins.find((x) => x.id === id);
  if (p) {
    if (p.errors.length > 0) return { state: "broken", plugin: p, why: p.errors[0] ?? "" };
    return p.enabled ? { state: "on", plugin: p, why: "" } : { state: "off", plugin: p, why: "turned off" };
  }
  if (a.declared[id] === true) return { state: "wanted", plugin: null, why: "settings.json turns it on, and it is not installed here" };
  return { state: "none", plugin: null, why: "" };
}

/** every plugin installed in a column, or turned on by a settings.json there, filtered */
export function pluginRows(ms: readonly PluginMachine[], cols: readonly PluginColumn[], f: PluginFilter): string[] {
  const ids = new Set<string>();
  for (const c of cols) {
    const a = agentOf(ms.find((m) => m.machine === c.machine), c.agent);
    for (const p of a?.plugins ?? []) ids.add(p.id);
    for (const [id, on] of Object.entries(a?.declared ?? {})) if (on) ids.add(id);
  }
  const text = f.text.toLowerCase();
  return [...ids].filter((id) =>
    (!text || id.toLowerCase().includes(text) || Object.keys(serversOf(ms, id)).some((s) => s.toLowerCase().includes(text))) &&
    (!f.problems || cols.some((c) => PLUGIN_PROBLEM.has(cellOf(ms, c, id).state)))).sort();
}

/** the MCP servers a plugin brings, from wherever it is installed */
export function serversOf(ms: readonly PluginMachine[], id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of ms) for (const a of m.agents) for (const p of a.plugins) if (p.id === id) Object.assign(out, p.servers);
  return out;
}

export const committersOf = (ms: readonly PluginMachine[]): string[] => ms.filter((m) => m.commits).map((m) => m.machine);

/** The machine an op actually runs on. A machine on dotclaude's shared
 *  settings.json that does not commit it refuses an edit there; the same
 *  op then runs on the machine that commits, which every other one follows
 *  by pull. null: the op runs nowhere on this page, with the reason. */
export function routeOf(ms: readonly PluginMachine[], m: PluginMachine, req: Omit<PluginOpRequest, "machine">):
  { machine: PluginMachine; moved: boolean } | { why: string } {
  const committers = committersOf(ms);
  const why = refusal(m, req, committers);
  if (!why) return { machine: m, moved: false };
  if (!(m.shared && !m.commits)) return { why };
  const w = ms.find((x) => x.commits && x.shared && !x.away && refusal(x, req, committers) === null);
  return w ? { machine: w, moved: true } : { why };
}

/** the ops a cell offers, in order */
export function cellOps(cell: PluginCell, agent: PluginAgent): PluginOp[] {
  switch (cell.state) {
    case "on": return agent === "claude" ? ["disable", "update", "uninstall"] : ["uninstall"];
    case "off": return agent === "claude" ? ["enable", "update", "uninstall"] : ["uninstall"];
    case "broken": return agent === "claude" ? [cell.plugin?.enabled ? "disable" : "enable", "update", "uninstall"] : ["uninstall"];
    case "wanted":
    case "none":
      return ["install"];
    case "noagent":
      return [];
  }
}

/** A plugin's marketplace that is not added here, with what settings.json
 *  says it comes from. A marketplace counts as added when the agent lists
 *  it or has a plugin from it installed: neither CLI lists every one it
 *  installs from (claude's synced, codex's openai-curated-remote). */
export function missingMarket(ms: readonly PluginMachine[], col: PluginColumn, id: string): { name: string; source: string } | null {
  const a = agentOf(ms.find((m) => m.machine === col.machine), col.agent);
  const name = id.split("@")[1] ?? "";
  if (!a || a.markets.some((x) => x.name === name) || a.plugins.some((p) => p.id.split("@")[1] === name)) return null;
  return { name, source: a.declaredMarkets[name] ?? "" };
}

/** the marketplace a not-installed cell's install needs and the machine lacks */
export function marketGap(ms: readonly PluginMachine[], col: PluginColumn, cell: PluginCell, id: string): { name: string; source: string } | null {
  return cell.state === "wanted" || cell.state === "none" ? missingMarket(ms, col, id) : null;
}

/** a source that is a folder on some machine, not one a marketplace add can fetch here */
export const isFolder = (source: string): boolean => source.startsWith("/") || source.startsWith("~") || source.startsWith(".");

/** the marketplaces settings.json declares that this machine has not added */
export function declaredOnly(a: PluginAgentSeen): { name: string; source: string }[] {
  return Object.entries(a.declaredMarkets).filter(([name]) => !a.markets.some((x) => x.name === name)).map(([name, source]) => ({ name, source }));
}

/** an op as a button says it */
export function opLabel(op: PluginOp): string {
  switch (op) {
    case "install": return "install";
    case "uninstall": return "remove…";
    case "update": return "update";
    case "enable": return "turn on";
    case "disable": return "turn off";
    case "market-add": return "add";
    case "market-remove": return "remove…";
    case "market-update": return "update";
  }
}

/** quick searches for the catalog: the kinds of plugin people look for */
export const CATALOG_CHIPS: readonly { label: string; q: string }[] = [
  { label: "memory", q: "memory" },
  { label: "templates", q: "template" },
  { label: "connectors", q: "connect" },
  { label: "MCP servers", q: "mcp" },
  { label: "review", q: "review" },
  { label: "design", q: "design" },
];
