import type { KitCell, KitCellState, KitInfo, KitMachineView } from "../../src/core/types";

export interface KitFilter { agent: string | null; machine: string | null; problems: boolean; text: string }

export const GLYPH: Record<KitCellState, string> = {
  ok: "●", missing: "○", drift: "≠", foreign: "◆", local: "·", off: "", "no-source": "∅", noagent: "–", away: "?",
};

export const PROBLEM: ReadonlySet<KitCellState> = new Set(["missing", "drift", "foreign", "no-source", "away"]);

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

export function rows(cells: KitCell[], f: KitFilter): string[] {
  const keep = cells.filter((c) =>
    c.skill !== "*" &&
    (!f.agent || c.agent === f.agent) &&
    (!f.machine || c.machine === f.machine) &&
    (!f.problems || PROBLEM.has(c.state)) &&
    (!f.text || c.skill.includes(f.text.toLowerCase())));
  return [...new Set(keep.map((c) => c.skill))].sort();
}

export const cellAt = (cells: KitCell[], skill: string, machine: string, agent: string): KitCell | null =>
  cells.find((c) => c.skill === skill && c.machine === machine && c.agent === agent) ?? null;
