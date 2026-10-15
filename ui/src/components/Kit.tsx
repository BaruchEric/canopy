import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { GLYPH, PROBLEM, adoptableIn, allowAct, cellAt, columns, homesFor, mcpViewsOf, mergeKit, rows, serverAt, serverRows, sheetFor, sheetKey, type KitFilter, type KitSheet } from "../kit";
import { errorText, gateHere, hostOf, isGateClosed, readersOf, writerOf } from "../secrets";
import type { KitApplyResult, KitMachineView, KitMcpPreview, KitMcpView } from "../../../src/core/types";
import type { SecretAct } from "../../../src/core/secretwire";

/** which backend reaches a machine: the one whose info lists it */
function ownerOf(byBackend: Record<string, { machines: KitMachineView[] }>, machine: string): string | null {
  for (const [b, info] of Object.entries(byBackend)) if (info.machines.some((m) => m.machine === machine)) return b;
  return null;
}

function outcome(machine: string, r: KitApplyResult): string {
  const [first] = r.failed;
  return first ? `${machine}: ${r.failed.length} failed, first: ${first.why}` : `${machine}: ${r.done.length} done`;
}

const shown = (e: Record<string, unknown> | null): string => (e ? JSON.stringify(e, null, 2) : "(none)");

const pairs = (m: Record<string, string>): string => Object.entries(m).map(([k, n]) => `${k} from ${n}`).join(", ");

/** Adopt one server or a column's: each hand-made entry beside what the
 *  kit would write, masked by the server, then one confirm. */
function AdoptSheet({ backend, machine, agent, names, onDone }: { backend: string; machine: string; agent: string; names: string[]; onDone: (msg: string) => void }) {
  const key = names.join(",");
  const [previews, setPreviews] = useState<Record<string, KitMcpPreview | { error: string }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    for (const n of key.split(",")) {
      api.kitPreview(backend, machine, agent, n).then(
        (p) => live && setPreviews((x) => ({ ...x, [n]: p })),
        (e: unknown) => live && setPreviews((x) => ({ ...x, [n]: { error: errorText(e) } })),
      );
    }
    return () => {
      live = false;
    };
  }, [backend, machine, agent, key]);
  // adopt waits until every entry it takes has been shown
  const ready = names.every((n) => { const p = previews[n]; return p !== undefined && !("error" in p); });
  const go = async () => {
    setBusy(true);
    try {
      onDone(outcome(machine, await api.kitAdopt(backend, machine, agent, names)));
    } catch (e) {
      onDone(`${machine}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-sheet">
      <h4>Adopt {names.length === 1 ? names[0] : `${names.length} servers`} for {agent} on {machine}</h4>
      <p className="kit-note">Canopy keeps each hand-made entry, so put back restores it. Values are hidden here.</p>
      {names.map((n) => {
        const p = previews[n];
        if (p && "error" in p) return <p key={n} className="kit-error">{n}: {p.error}</p>;
        return (
          <div key={n} className="kit-compare">
            <div>
              <span className="kit-note">{n} now{p ? ` (${p.state}${p.why ? `: ${p.why}` : ""})` : ""}</span>
              <pre>{p ? shown(p.have) : "loading…"}</pre>
            </div>
            <div>
              <span className="kit-note">what the kit writes</span>
              <pre>{p ? shown(p.want) : "loading…"}</pre>
            </div>
          </div>
        );
      })}
      <div className="kit-line">
        <button type="button" className="mini" disabled={busy || !ready} onClick={() => void go()}>adopt</button>
        <button type="button" className="mini" onClick={() => onDone("")}>cancel</button>
      </div>
    </div>
  );
}

function RestoreSheet({ backend, machine, agent, name, onDone }: { backend: string; machine: string; agent: string; name: string; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onDone(outcome(machine, await api.kitRestore(backend, machine, agent, name)));
    } catch (e) {
      onDone(`${machine}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-sheet">
      <h4>Put back the hand-made {name} for {agent} on {machine}?</h4>
      <p className="kit-note">The kit stops managing it here until you adopt it again.</p>
      <div className="kit-line">
        <button type="button" className="mini" disabled={busy} onClick={() => void go()}>put back</button>
        <button type="button" className="mini" onClick={() => onDone("")}>cancel</button>
      </div>
    </div>
  );
}

/** One gated allowance for every machine, sent to the secrets service
 *  from the gate page with an open passkey session. */
function AllowSheet({ view, machines, onDone }: { view: KitMcpView; machines: KitMachineView[]; onDone: (msg: string) => void }) {
  const all = useStore((s) => s.secrets);
  const order = useStore((s) => s.backendOrder);
  const writer = writerOf(all, order);
  const info = writer ? all[writer] : undefined;
  const here = gateHere(info, window.location.origin);
  const homes = homesFor(view, machines);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (act: SecretAct, done: string) => {
    if (!writer) return;
    setBusy(true);
    setError(null);
    try {
      await api.secretsAct(writer, act);
      // the act answers once Forgejo has the commit, so a pull now brings each reader's cells up to date
      for (const b of readersOf(all, order)) void api.secretsPull(b).catch(() => {});
      onDone(done);
    } catch (e) {
      setError(isGateClosed(e) ? "the passkey session has ended; open it again in the secrets view" : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-sheet">
      <h4>Allow {view.name} its secrets</h4>
      <dl className="secrets-facts">
        <dt>runs</dt>
        <dd><code>{view.def.command !== null ? [view.def.command, ...view.def.args].join(" ") : view.def.url}</code></dd>
        <dt>definition</dt>
        <dd><code>{view.hash.slice(0, 16)}</code></dd>
        {Object.keys(view.env).length > 0 && (
          <>
            <dt>env</dt>
            <dd>{pairs(view.env)}</dd>
          </>
        )}
        {Object.keys(view.headers).length > 0 && (
          <>
            <dt>headers</dt>
            <dd>{pairs(view.headers)}</dd>
          </>
        )}
        <dt>machines</dt>
        <dd>{view.machines.join(", ") || "none"}{view.later.length > 0 ? `; ${view.later.join(", ")} waits for secrets phase 3` : ""}</dd>
      </dl>
      <p className="kit-note">One allowance covers every machine and makes each one's env sink. Editing the command, args, url or the names voids it.</p>
      {!writer || !info ? (
        <p className="kit-error">No backend on this page is the secret store's writer (the mini), so nothing here can allow a server.</p>
      ) : !here ? (
        hostOf(info.gate) !== "" ? (
          <p className="kit-note">Allowing needs the passkey gate: <a href={new URL("/?view=kit", info.gate).toString()}>open the kit on the gate page</a>.</p>
        ) : (
          <p className="kit-error">Allowing needs the passkey gate, and the store names no gate page.</p>
        )
      ) : !info.session ? (
        <p className="kit-note">Open the passkey session in <a href="/?view=secrets">the secrets view</a> first.</p>
      ) : "missing" in homes ? (
        <p className="kit-error">No home known yet for {homes.missing.join(", ")}; rescan.</p>
      ) : (
        <div className="kit-line">
          <button type="button" className="mini" disabled={busy} onClick={() => void run(allowAct(view, homes.homes), `${view.name}: allowed`)}>allow</button>
          {sure ? (
            <>
              <span className="kit-error">Revoke takes the allow entries and the env sinks out.</span>
              <button type="button" className="mini" disabled={busy} onClick={() => void run({ a: "mcp-revoke", server: view.name }, `${view.name}: revoked`)}>revoke</button>
              <button type="button" className="mini" onClick={() => setSure(false)}>keep it</button>
            </>
          ) : (
            <button type="button" className="mini" disabled={busy} onClick={() => setSure(true)}>revoke…</button>
          )}
        </div>
      )}
      {error && <p className="kit-error">{error}</p>}
      <div className="kit-line">
        <button type="button" className="mini" onClick={() => onDone("")}>close</button>
      </div>
    </div>
  );
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
  const serverNames = useMemo(() => serverRows(merged.cells, f), [merged, f]);
  const views = useMemo(() => mcpViewsOf(byBackend), [byBackend]);
  const [sheet, setSheet] = useState<KitSheet | null>(null);
  // a sheet closes only itself, so one that answers late leaves a newer sheet open
  const closer = (key: string) => (msg: string) => {
    setSheet((s) => (s && sheetKey(s) === key ? null : s));
    if (msg) setSaid(msg);
  };
  const sheetOwner = sheet && sheet.kind !== "allow" ? ownerOf(byBackend, sheet.machine) : null;
  const sheetView = sheet?.kind === "allow" ? views.find((v) => v.name === sheet.name) : undefined;

  async function apply(machine: string) {
    const b = ownerOf(byBackend, machine);
    if (!b) return;
    setBusy(machine);
    try {
      setSaid(outcome(machine, await api.kitApply(b, machine)));
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
              <tr key={`skill/${skill}`}>
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
        {serverNames.length > 0 && (
          <table className="kit-grid kit-servers">
            <thead>
              <tr>
                <th>MCP servers</th>
                {cols.map((col) => {
                  const n = adoptableIn(merged.cells, col.machine, col.agent);
                  return (
                    <th key={`mcp/${col.machine}/${col.agent}`} title={`${col.agent} on ${col.machine}`}>
                      {col.machine}<br />{col.agent}
                      {n.length > 0 && (
                        <><br /><button type="button" className="mini" onClick={() => setSheet({ kind: "adopt", machine: col.machine, agent: col.agent, names: n })}>adopt all ({n.length})</button></>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {serverNames.map((name) => (
                <tr key={`mcp/${name}`}>
                  <th scope="row">
                    {name}
                    {views.some((v) => v.name === name) && (
                      <button type="button" className="mini kit-allow" onClick={() => setSheet({ kind: "allow", name })}>allow…</button>
                    )}
                  </th>
                  {cols.map((col) => {
                    const cell = serverAt(merged.cells, name, col.machine, col.agent);
                    const state = cell?.state ?? "off";
                    const hasView = views.some((v) => v.name === name);
                    const open = sheetFor(cell, name, hasView);
                    const noView = !hasView && (state === "not-allowed" || state === "stale-allowance") ? " (no backend on this page gives its definition, so it cannot be allowed here)" : "";
                    return (
                      <td key={`mcp/${col.machine}/${col.agent}`} className={`kit-cell kit-${state}${PROBLEM.has(state) ? " kit-problem" : ""}`}
                        title={cell ? `${state}${cell.why ? `: ${cell.why}` : ""}${cell.restore ? " (put back available)" : ""}${noView}` : ""}>
                        {open ? <button type="button" className="kit-cell-button" onClick={() => setSheet(open)}>{GLYPH[state]}</button> : GLYPH[state]}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {sheet?.kind === "adopt" && sheetOwner && (
        <AdoptSheet key={sheetKey(sheet)} backend={sheetOwner} machine={sheet.machine} agent={sheet.agent} names={sheet.names} onDone={closer(sheetKey(sheet))} />
      )}
      {sheet?.kind === "restore" && sheetOwner && (
        <RestoreSheet key={sheetKey(sheet)} backend={sheetOwner} machine={sheet.machine} agent={sheet.agent} name={sheet.name} onDone={closer(sheetKey(sheet))} />
      )}
      {sheet?.kind === "allow" && sheetView && <AllowSheet key={sheetKey(sheet)} view={sheetView} machines={merged.machines} onDone={closer(sheetKey(sheet))} />}
    </main>
  );
}
