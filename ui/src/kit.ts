import type { KitAction, KitCell, KitCellState, KitInfo, KitMachineView, KitMcpView } from "../../src/core/types";
import type { SecretAct } from "../../src/core/secretwire";

export interface KitFilter { agent: string | null; machine: string | null; problems: boolean; text: string }

export const GLYPH: Record<KitCellState, string> = {
  ok: "●", missing: "○", drift: "≠", foreign: "◆", local: "·", off: "", "no-source": "∅", noagent: "–", away: "?",
  "not-allowed": "⊘", "stale-allowance": "⊘", "no-sink": "◌", adoptable: "◇", unsupported: "×", unresolved: "∅",
  "check-failed": "!", "no-install": "∅",
};

export const PROBLEM: ReadonlySet<KitCellState> = new Set([
  "missing", "drift", "foreign", "no-source", "away", "not-allowed", "stale-allowance", "no-sink", "adoptable", "unresolved",
  "check-failed", "no-install",
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

/** a tool's cell is its machine's, with no agent, so it makes no column */
export const isTool = (c: KitCell): boolean => c.kind === "tool";
const isSkill = (c: KitCell): boolean => c.kind === undefined;

export function columns(cells: KitCell[]): { machine: string; agent: string }[] {
  const seen = new Map<string, { machine: string; agent: string }>();
  for (const c of cells) if (!isTool(c)) seen.set(`${c.machine}\t${c.agent}`, { machine: c.machine, agent: c.agent });
  return [...seen.values()].sort((a, b) =>
    a.machine.localeCompare(b.machine) || (a.agent === "claude" ? -1 : b.agent === "claude" ? 1 : a.agent.localeCompare(b.agent)));
}

export const isServer = (c: KitCell): boolean => c.kind === "mcp";

export function rows(cells: KitCell[], f: KitFilter): string[] {
  const keep = cells.filter((c) =>
    isSkill(c) &&
    c.skill !== "*" &&
    (!f.agent || c.agent === f.agent) &&
    (!f.machine || c.machine === f.machine) &&
    (!f.problems || PROBLEM.has(c.state)) &&
    (!f.text || c.skill.includes(f.text.toLowerCase())));
  return [...new Set(keep.map((c) => c.skill))].sort();
}

export const cellAt = (cells: KitCell[], skill: string, machine: string, agent: string): KitCell | null =>
  cells.find((c) => isSkill(c) && c.skill === skill && c.machine === machine && c.agent === agent) ?? null;

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

/** tool names, filtered like the rest; a tool belongs to no agent, so the agent filter leaves it be */
export function toolRows(cells: KitCell[], f: KitFilter): string[] {
  const keep = cells.filter((c) =>
    isTool(c) &&
    (!f.machine || c.machine === f.machine) &&
    (!f.problems || PROBLEM.has(c.state)) &&
    (!f.text || c.skill.includes(f.text.toLowerCase())));
  return [...new Set(keep.map((c) => c.skill))].sort();
}

export const toolAt = (cells: KitCell[], name: string, machine: string): KitCell | null =>
  cells.find((c) => isTool(c) && c.skill === name && c.machine === machine) ?? null;

/** each machine once, in column order, with how many columns it spans */
export function machineSpans(cols: { machine: string }[]): { machine: string; span: number }[] {
  const out: { machine: string; span: number }[] = [];
  for (const c of cols) {
    const last = out.at(-1);
    if (last?.machine === c.machine) last.span++;
    else out.push({ machine: c.machine, span: 1 });
  }
  return out;
}

/** What one cell's own apply button sends: the plan's actions for that
 *  cell, after its agent's mkdir when the plan has one. A store cell whose
 *  fix is the pull gets the pull alone. Empty: the cell has no button. */
export function cellActions(m: KitMachineView | undefined, cell: KitCell | null): KitAction[] {
  if (!m || !cell || m.seen.away || isTool(cell)) return [];
  const mine = (a: KitAction) => "name" in a && a.agent === cell.agent && a.name === cell.skill;
  if (isServer(cell)) return m.plan.filter((a) => (a.kind === "mcp-set" || a.kind === "mcp-remove") && mine(a));
  const own = m.plan.filter((a) => (a.kind === "link" || a.kind === "relink" || a.kind === "remove") && mine(a));
  if (own.length === 0) {
    const pull = m.plan.find((a) => a.kind === "pull");
    return pull && cell.agent === m.seen.targets[0]?.agent && cell.state === "missing" ? [pull] : [];
  }
  const mkdir = m.plan.find((a) => a.kind === "mkdir" && a.agent === cell.agent);
  return mkdir ? [mkdir, ...own] : own;
}

/** an action in words, for a cell's sheet */
export function actionText(a: KitAction): string {
  switch (a.kind) {
    case "pull": return "pull dotclaude";
    case "mkdir": return `make ${a.agent}'s skills dir`;
    case "link": return `link ${a.name} to ${a.link}`;
    case "relink": return `point ${a.name} at ${a.link}`;
    case "remove": return `remove the link ${a.name}`;
    case "mcp-set": return `write ${a.name}`;
    case "mcp-remove": return `remove ${a.name}`;
    default: return `${a.kind} ${a.name}`;
  }
}

/** a column's servers that adopt all would take */
export const adoptableIn = (cells: KitCell[], machine: string, agent: string): string[] =>
  cells.filter((c) => isServer(c) && c.machine === machine && c.agent === agent && c.state === "adoptable").map((c) => c.skill).sort();

/** a server with secrets as the allow sheet takes it; `split` names the
 *  backends when they hash it apart (one has not pulled dotclaude) */
export type KitMcpPick = KitMcpView & { split?: string[] };

/** the servers with secrets, once each. Every backend should read the same
 *  kit.json; when their hashes differ, the allowance would fit only some
 *  of them, so the view carries the backends and the sheet blocks. */
export function mcpViewsOf(byBackend: Record<string, KitInfo>): KitMcpPick[] {
  const out = new Map<string, KitMcpPick>();
  const by = new Map<string, Map<string, string>>();
  for (const [backend, info] of Object.entries(byBackend)) {
    for (const v of info.mcp ?? []) {
      if (!out.has(v.name)) out.set(v.name, v);
      by.set(v.name, (by.get(v.name) ?? new Map<string, string>()).set(backend, v.hash));
    }
  }
  return [...out.values()].map((v) => {
    const hashes = by.get(v.name) ?? new Map<string, string>();
    return new Set(hashes.values()).size > 1 ? { ...v, split: [...hashes.keys()].sort() } : v;
  });
}

/** each machine's home, from the backend that owns it; a machine not seen
 *  yet, or seen by a backend too old to report its home, blocks the allow */
export function homesFor(v: KitMcpView, machines: KitMachineView[]): { homes: Record<string, string> } | { why: string } {
  const homes: Record<string, string> = {};
  const unseen: string[] = [];
  const old: string[] = [];
  for (const m of v.machines) {
    const view = machines.find((x) => x.machine === m);
    if (view?.home) homes[m] = view.home;
    else (view ? old : unseen).push(m);
  }
  const why = [
    ...(old.length > 0 ? [`The backend for ${old.join(", ")} reports no home, so it runs an older canopy; update it to the new build, then allow.`] : []),
    ...(unseen.length > 0 ? [`No home known yet for ${unseen.join(", ")}; rescan.`] : []),
  ];
  return why.length > 0 ? { why: why.join(" ") } : { homes };
}

export const allowAct = (v: KitMcpView, homes: Record<string, string>): SecretAct =>
  ({ a: "mcp-allow", server: v.name, hash: v.hash, def: v.def, env: v.env, headers: v.headers, homes });

/** the sheet a cell or a server header opens */
export type KitSheet =
  | { kind: "adopt"; machine: string; agent: string; names: string[] }
  | { kind: "restore"; machine: string; agent: string; name: string }
  | { kind: "allow"; name: string }
  /** one cell's apply, and for a skill its adopt and put back */
  | { kind: "cell"; of: "skill" | "mcp"; machine: string; agent: string; name: string }
  | { kind: "tool"; machine: string; name: string };

/** one key per sheet, so React mounts a fresh one for another server or column */
export function sheetKey(s: KitSheet): string {
  switch (s.kind) {
    case "allow": return `allow/${s.name}`;
    case "adopt": return `adopt/${s.machine}/${s.agent}/${s.names.join(",")}`;
    case "restore": return `restore/${s.machine}/${s.agent}/${s.name}`;
    case "cell": return `cell/${s.of}/${s.machine}/${s.agent}/${s.name}`;
    case "tool": return `tool/${s.machine}/${s.name}`;
  }
}

/** a skill cell opens its sheet when there is something to do there */
export function skillSheetFor(cell: KitCell | null, actions: KitAction[]): KitSheet | null {
  if (!cell || (cell.state !== "adoptable" && !cell.restore && actions.length === 0)) return null;
  return { kind: "cell", of: "skill", machine: cell.machine, agent: cell.agent, name: cell.skill };
}

/** a missing tool with an install line opens its sheet: an install, or a sudo line to copy */
export const toolSheetFor = (cell: KitCell | null): KitSheet | null =>
  cell?.state === "missing" && cell.install ? { kind: "tool", machine: cell.machine, name: cell.skill } : null;

/** what a server cell opens; an allow needs the kit's view of the server */
export function sheetFor(cell: KitCell | null, name: string, hasView: boolean): KitSheet | null {
  if (!cell) return null;
  if (cell.state === "adoptable") return { kind: "adopt", machine: cell.machine, agent: cell.agent, names: [name] };
  if (cell.restore) return { kind: "restore", machine: cell.machine, agent: cell.agent, name };
  if ((cell.state === "not-allowed" || cell.state === "stale-allowance") && hasView) return { kind: "allow", name };
  return null;
}

/** a server cell's sheet: adopt, put back or allow first, then its own apply */
export const serverSheetFor = (cell: KitCell | null, name: string, hasView: boolean, actions: KitAction[]): KitSheet | null =>
  sheetFor(cell, name, hasView) ?? (cell && actions.length > 0 ? { kind: "cell", of: "mcp", machine: cell.machine, agent: cell.agent, name } : null);
