import type { KitCell, KitCellState, KitInfo, KitMachineView, KitMcpView } from "../../src/core/types";
import type { SecretAct } from "../../src/core/secretwire";

export interface KitFilter { agent: string | null; machine: string | null; problems: boolean; text: string }

export const GLYPH: Record<KitCellState, string> = {
  ok: "●", missing: "○", drift: "≠", foreign: "◆", local: "·", off: "", "no-source": "∅", noagent: "–", away: "?",
  "not-allowed": "⊘", "stale-allowance": "⊘", "no-sink": "◌", adoptable: "◇", unsupported: "×", "phase-3": "…", unresolved: "∅",
};

export const PROBLEM: ReadonlySet<KitCellState> = new Set([
  "missing", "drift", "foreign", "no-source", "away", "not-allowed", "stale-allowance", "no-sink", "adoptable", "unresolved",
]);

export function mergeKit(byBackend: Record<string, KitInfo>) {
  const cells: KitCell[] = [];
  const machines: KitMachineView[] = [];
  const errors: { backend: string; error: string }[] = [];
  for (const [backend, info] of Object.entries(byBackend)) {
    if (!info.ok) { errors.push({ backend, error: info.error ?? "kit not read" }); continue; }
    cells.push(...info.cells);
    machines.push(...info.machines);
  }
  return { cells, machines, errors };
}

export function columns(cells: KitCell[]): { machine: string; agent: string }[] {
  const seen = new Map<string, { machine: string; agent: string }>();
  for (const c of cells) seen.set(`${c.machine}\t${c.agent}`, { machine: c.machine, agent: c.agent });
  return [...seen.values()].sort((a, b) =>
    a.machine.localeCompare(b.machine) || (a.agent === "claude" ? -1 : b.agent === "claude" ? 1 : a.agent.localeCompare(b.agent)));
}

export const isServer = (c: KitCell): boolean => c.kind === "mcp";

export function rows(cells: KitCell[], f: KitFilter): string[] {
  const keep = cells.filter((c) =>
    !isServer(c) &&
    c.skill !== "*" &&
    (!f.agent || c.agent === f.agent) &&
    (!f.machine || c.machine === f.machine) &&
    (!f.problems || PROBLEM.has(c.state)) &&
    (!f.text || c.skill.includes(f.text.toLowerCase())));
  return [...new Set(keep.map((c) => c.skill))].sort();
}

export const cellAt = (cells: KitCell[], skill: string, machine: string, agent: string): KitCell | null =>
  cells.find((c) => !isServer(c) && c.skill === skill && c.machine === machine && c.agent === agent) ?? null;

export function serverRows(cells: KitCell[], f: KitFilter): string[] {
  const keep = cells.filter((c) =>
    isServer(c) &&
    (!f.agent || c.agent === f.agent) &&
    (!f.machine || c.machine === f.machine) &&
    (!f.problems || PROBLEM.has(c.state)) &&
    (!f.text || c.skill.includes(f.text.toLowerCase())));
  return [...new Set(keep.map((c) => c.skill))].sort();
}

export const serverAt = (cells: KitCell[], name: string, machine: string, agent: string): KitCell | null =>
  cells.find((c) => isServer(c) && c.skill === name && c.machine === machine && c.agent === agent) ?? null;

/** a column's servers that adopt all would take */
export const adoptableIn = (cells: KitCell[], machine: string, agent: string): string[] =>
  cells.filter((c) => isServer(c) && c.machine === machine && c.agent === agent && c.state === "adoptable").map((c) => c.skill).sort();

/** the servers with secrets, once each: every backend reads the same kit.json */
export function mcpViewsOf(byBackend: Record<string, KitInfo>): KitMcpView[] {
  const out = new Map<string, KitMcpView>();
  for (const info of Object.values(byBackend)) for (const v of info.mcp ?? []) if (!out.has(v.name)) out.set(v.name, v);
  return [...out.values()];
}

/** each machine's home, from the backend that owns it; a machine not seen yet blocks the allow */
export function homesFor(v: KitMcpView, machines: KitMachineView[]): { homes: Record<string, string> } | { missing: string[] } {
  const homes: Record<string, string> = {};
  const missing: string[] = [];
  for (const m of v.machines) {
    const home = machines.find((x) => x.machine === m)?.home;
    if (home) homes[m] = home;
    else missing.push(m);
  }
  return missing.length > 0 ? { missing } : { homes };
}

export const allowAct = (v: KitMcpView, homes: Record<string, string>): SecretAct =>
  ({ a: "mcp-allow", server: v.name, hash: v.hash, def: v.def, env: v.env, headers: v.headers, homes });

/** the sheet a server cell or header opens */
export type KitSheet =
  | { kind: "adopt"; machine: string; agent: string; names: string[] }
  | { kind: "restore"; machine: string; agent: string; name: string }
  | { kind: "allow"; name: string };

/** one key per sheet, so React mounts a fresh one for another server or column */
export const sheetKey = (s: KitSheet): string =>
  s.kind === "allow" ? `allow/${s.name}` : s.kind === "adopt" ? `adopt/${s.machine}/${s.agent}/${s.names.join(",")}` : `restore/${s.machine}/${s.agent}/${s.name}`;

/** what a server cell opens; an allow needs the kit's view of the server */
export function sheetFor(cell: KitCell | null, name: string, hasView: boolean): KitSheet | null {
  if (!cell) return null;
  if (cell.state === "adoptable") return { kind: "adopt", machine: cell.machine, agent: cell.agent, names: [name] };
  if (cell.restore) return { kind: "restore", machine: cell.machine, agent: cell.agent, name };
  if ((cell.state === "not-allowed" || cell.state === "stale-allowance") && hasView) return { kind: "allow", name };
  return null;
}
