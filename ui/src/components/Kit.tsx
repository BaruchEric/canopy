import { useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { GLYPH, PROBLEM, cellAt, columns, mergeKit, rows, type KitFilter } from "../kit";
import type { KitMachineView } from "../../../src/core/types";

/** which backend reaches a machine: the one whose info lists it */
function ownerOf(byBackend: Record<string, { machines: KitMachineView[] }>, machine: string): string | null {
  for (const [b, info] of Object.entries(byBackend)) if (info.machines.some((m) => m.machine === machine)) return b;
  return null;
}

export function KitView() {
  const byBackend = useStore((s) => s.kit);
  const [f, setF] = useState<KitFilter>({ agent: null, machine: null, problems: false, text: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const merged = useMemo(() => mergeKit(byBackend), [byBackend]);
  const cols = useMemo(() => columns(merged.cells).filter((c) => (!f.agent || c.agent === f.agent) && (!f.machine || c.machine === f.machine)), [merged, f]);
  const skillRows = useMemo(() => rows(merged.cells, f), [merged, f]);
  const machines = [...new Set(cols.map((c) => c.machine))];
  const agents = [...new Set(columns(merged.cells).map((c) => c.agent))];

  async function apply(machine: string) {
    const b = ownerOf(byBackend, machine);
    if (!b) return;
    setBusy(machine);
    try {
      const r = await api.kitApply(b, machine);
      setSaid(r.failed.length ? `${machine}: ${r.failed.length} failed, first: ${r.failed[0]!.why}` : `${machine}: ${r.done.length} done`);
    } catch (err) {
      setSaid(`${machine}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function rescan() {
    setBusy("*");
    try { await Promise.all(Object.keys(byBackend).map((b) => api.kitScan(b))); } finally { setBusy(null); }
  }

  return (
    <main className="kit-view">
      <div className="kit-bar">
        <input className="settings-input kit-search" placeholder="filter skills" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        <select className="settings-input" value={f.agent ?? ""} onChange={(e) => setF({ ...f, agent: e.target.value || null })}>
          <option value="">every agent</option>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="settings-input" value={f.machine ?? ""} onChange={(e) => setF({ ...f, machine: e.target.value || null })}>
          <option value="">every machine</option>
          {[...new Set(columns(merged.cells).map((c) => c.machine))].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="kit-toggle">
          <input type="checkbox" checked={f.problems} onChange={(e) => setF({ ...f, problems: e.target.checked })} /> only problems
        </label>
        <button type="button" className="mini" disabled={busy !== null} onClick={() => void rescan()}>rescan</button>
        {said && <span className="kit-said">{said}</span>}
      </div>
      {merged.errors.map((e) => <div key={e.backend} className="kit-error">{e.backend}: {e.error}</div>)}
      <div className="kit-machines">
        {machines.map((name) => {
          const m = merged.machines.find((x) => x.machine === name);
          const s = m?.seen.store;
          return (
            <div key={name} className="kit-machine">
              <strong>{name}</strong>{" "}
              {m?.seen.away ? <span className="kit-away">away: {m.seen.away}</span>
                : s ? <span>{s.branch}{s.behind ? `, ${s.behind} behind` : ""}{s.ahead ? `, ${s.ahead} ahead` : ""}{s.dirty ? `, ${s.dirty} changed` : ""}</span> : null}
              {m && m.plan.length > 0 && !m.seen.away && (
                <button type="button" className="mini" disabled={busy !== null} onClick={() => void apply(name)}>
                  apply all here ({m.plan.length})
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="kit-scroll">
        <table className="kit-grid">
          <thead>
            <tr>
              <th />
              {cols.map((c) => <th key={`${c.machine}/${c.agent}`} title={`${c.agent} on ${c.machine}`}>{c.machine}<br />{c.agent}</th>)}
            </tr>
          </thead>
          <tbody>
            {skillRows.map((skill) => (
              <tr key={skill}>
                <th scope="row">{skill}</th>
                {cols.map((col) => {
                  const cell = cellAt(merged.cells, skill, col.machine, col.agent)
                    ?? cellAt(merged.cells, "*", col.machine, col.agent);
                  const state = cell?.state ?? "off";
                  return (
                    <td key={`${col.machine}/${col.agent}`} className={`kit-cell kit-${state}${PROBLEM.has(state) ? " kit-problem" : ""}`}
                      title={cell ? `${state}${cell.why ? `: ${cell.why}` : ""}` : ""}>
                      {GLYPH[state]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
