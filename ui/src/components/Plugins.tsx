/** The plugins view (FR-064): every agent plugin on every machine, its MCP
 *  servers, and install, update, turn on or off and remove through the
 *  agent's own CLI on that machine. Marketplaces and a searchable catalog
 *  sit in their own sheets. Data comes with the kit's info. */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { errorText } from "../secrets";
import { opText } from "../../../src/core/plugins";
import {
  CATALOG_CHIPS, PLUGIN_GLYPH, PLUGIN_PROBLEM, cellOf, cellOps, declaredOnly, isFolder, marketGap, mergePlugins, opLabel, pluginColumns, pluginRows,
  readsPlugins, routeOf, serversOf, type PluginColumn, type PluginFilter, type PluginMachine,
} from "../plugins";
import type { PluginAgent, PluginCatalog, PluginOp, PluginOpRequest } from "../../../src/core/types";

type Sheet = { kind: "plugin"; id: string } | { kind: "catalog" } | { kind: "markets" };

/** an op waiting on a person: a remove to confirm, or a command the marketplace declares */
type Pending =
  | { kind: "sure"; m: PluginMachine; req: Omit<PluginOpRequest, "machine">; what: string }
  | { kind: "command"; m: PluginMachine; req: Omit<PluginOpRequest, "machine">; what: string; command: string; sha256: string };

const colKey = (c: PluginColumn): string => `${c.machine}/${c.agent}`;

/** runs ops one at a time from the page and holds what waits on a person */
function useOps(ms: readonly PluginMachine[], say: (msg: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const send = async (m: PluginMachine, req: Omit<PluginOpRequest, "machine">, what: string, onOk?: () => void) => {
    setBusy(`${m.machine}/${req.op}/${what}`);
    setPending(null);
    try {
      const r = await api.kitPluginOp(m.backend, { ...req, machine: m.machine });
      if (r.outcome === "confirm") setPending({ kind: "command", m, req, what, command: r.command, sha256: r.sha256 });
      else say(`${m.machine}: ${opText(req.op, what)}: ${r.outcome === "ok" ? "done" : "failed"}. ${r.message}`);
      if (r.outcome === "ok") onOk?.();
    } catch (e) {
      say(`${m.machine}: ${opText(req.op, what)}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };
  /** a remove asks first; everything else runs on the click */
  const run = (m: PluginMachine, req: Omit<PluginOpRequest, "machine">, what: string, onOk?: () => void) => {
    if (req.op === "uninstall" || req.op === "market-remove") setPending({ kind: "sure", m, req, what });
    else void send(m, req, what, onOk);
  };
  const confirm = () => {
    if (!pending) return;
    void send(pending.m, pending.kind === "command" ? { ...pending.req, accept: pending.sha256 } : pending.req, pending.what);
  };
  return { busy, pending, run, confirm, cancel: () => setPending(null), ms };
}

type Ops = ReturnType<typeof useOps>;

/** one op's button, on the machine it runs on: a machine that reads the
 *  shared settings.json sends an edit to the machine that commits dotclaude */
function OpButton({ ops, m, req, what, onOk }: { ops: Ops; m: PluginMachine; req: Omit<PluginOpRequest, "machine">; what: string; onOk?: () => void }) {
  const r = routeOf(ops.ms, m, req);
  if ("why" in r) return null;
  const label = `${opLabel(req.op)}${r.moved ? ` on ${r.machine.machine}` : ""}`;
  const title = r.moved ? `${m.machine} reads dotclaude's shared settings.json; this runs on ${r.machine.machine}, and ${m.machine} follows once dotclaude is committed and pulled` : undefined;
  return (
    <button type="button" className="mini" disabled={ops.busy !== null} title={title} onClick={() => ops.run(r.machine, req, what, onOk)}>{label}</button>
  );
}

/** the reasons a cell offers fewer ops than its state has, once each */
function refusals(ops: Ops, m: PluginMachine, agent: PluginAgent, list: PluginOp[], id: string): string[] {
  const out = new Set<string>();
  for (const op of list) {
    const r = routeOf(ops.ms, m, { agent, op, id });
    if ("why" in r) out.add(r.why);
  }
  return [...out];
}

function PendingBox({ ops }: { ops: Ops }) {
  const p = ops.pending;
  if (!p) return null;
  return (
    <div className="kit-sheet plugin-pending">
      {p.kind === "sure" ? (
        <p className="kit-error">{opText(p.req.op, p.what)} on {p.m.machine}?{p.req.op === "uninstall" && p.req.agent === "claude" && p.m.shared ? " It drops the plugin from dotclaude's shared settings.json, so the other machines on it stop turning it on once that is committed." : ""}</p>
      ) : (
        <>
          <p className="kit-error">The marketplace declares a command for {p.what}. {p.req.agent} runs it on {p.m.machine} once you accept it. Read it first:</p>
          <pre className="kit-command">{p.command}</pre>
        </>
      )}
      <div className="kit-line">
        <button type="button" className="mini" disabled={ops.busy !== null} onClick={ops.confirm}>{p.kind === "sure" ? opLabel(p.req.op).replace("…", "") : "accept and run"}</button>
        <button type="button" className="mini" onClick={ops.cancel}>cancel</button>
      </div>
    </div>
  );
}

function PluginSheet({ id, ops, cols, onClose }: { id: string; ops: Ops; cols: PluginColumn[]; onClose: () => void }) {
  const servers = Object.entries(serversOf(ops.ms, id));
  // claude's details from the first machine it is installed on
  const from = cols.find((c) => c.agent === "claude" && cellOf(ops.ms, c, id).plugin !== null);
  const fromM = from ? ops.ms.find((m) => m.machine === from.machine) : undefined;
  const [details, setDetails] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDetails(null);
    if (fromM) {
      api.kitPluginDetails(fromM.backend, fromM.machine, "claude", id).then(
        (d) => live && setDetails(d.text),
        (e: unknown) => live && setDetails(`no details: ${errorText(e)}`),
      );
    }
    return () => {
      live = false;
    };
  }, [fromM?.backend, fromM?.machine, id]);
  return (
    <div className="kit-sheet">
      <h4>{id}</h4>
      {servers.length > 0 && (
        <dl className="secrets-facts">
          {servers.map(([name, line]) => (
            <div key={name} className="plugin-server">
              <dt>{name}</dt>
              <dd><code>{line || "(no command)"}</code></dd>
            </div>
          ))}
        </dl>
      )}
      <ul className="plugin-where">
        {cols.map((c) => {
          const m = ops.ms.find((x) => x.machine === c.machine);
          if (!m) return null;
          const cell = cellOf(ops.ms, c, id);
          const list = cellOps(cell, c.agent);
          const missing = marketGap(ops.ms, c, cell, id);
          const notes = [...(cell.plugin?.errors ?? []), ...(cell.plugin?.notes ?? [])];
          return (
            <li key={colKey(c)}>
              <div className="kit-line">
                <span className={`plugin-glyph plugin-${cell.state}${PLUGIN_PROBLEM.has(cell.state) ? " kit-problem" : ""}`}>{PLUGIN_GLYPH[cell.state] || "·"}</span>
                <strong>{c.machine}</strong>
                <span className="kit-note">{c.agent}</span>
                <span className="kit-note">{cell.state === "none" ? "not installed" : cell.state}{cell.plugin?.version ? ` ${cell.plugin.version}` : ""}</span>
                {missing ? (
                  missing.source && !isFolder(missing.source) ? (
                    <OpButton ops={ops} m={m} req={{ agent: c.agent, op: "market-add", source: missing.source }} what={missing.name} />
                  ) : null
                ) : list.map((op) => <OpButton key={op} ops={ops} m={m} req={{ agent: c.agent, op, id }} what={id} />)}
              </div>
              {missing && (
                <p className="kit-note">
                  Its marketplace {missing.name} is not added to {c.agent} on {c.machine}
                  {missing.source ? (isFolder(missing.source) ? `; settings.json names a folder, ${missing.source}, which is another machine's` : `; add it from ${missing.source}, then install`) : ""}.
                </p>
              )}
              {cell.why && cell.state !== "none" && cell.state !== "off" && <p className="kit-note">{cell.why}</p>}
              {notes.map((n) => <p key={n} className="kit-note">{n}</p>)}
              {refusals(ops, m, c.agent, list, id).map((w) => <p key={w} className="kit-note">{w}</p>)}
            </li>
          );
        })}
      </ul>
      {from && (
        <details className="plugin-details">
          <summary>what it holds and costs, from {from.machine}</summary>
          <pre className="kit-command">{details ?? "loading…"}</pre>
        </details>
      )}
      <p className="kit-note">A change takes effect in a session started after it.</p>
      <div className="kit-line">
        <button type="button" className="mini" onClick={onClose}>close</button>
      </div>
    </div>
  );
}

function CatalogSheet({ ops, cols, onClose }: { ops: Ops; cols: PluginColumn[]; onClose: () => void }) {
  const [target, setTarget] = useState(cols[0] ? colKey(cols[0]) : "");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(30);
  const [res, setRes] = useState<PluginCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  // the refresh button reads the catalog again once; later searches use the backend's copy
  const usedFresh = useRef(0);
  const col = cols.find((c) => colKey(c) === target);
  const m = col ? ops.ms.find((x) => x.machine === col.machine) : undefined;
  // a new install marks the result once the kit's event lands
  const at = m?.at ?? 0;
  useEffect(() => {
    if (!col || !m) return;
    let live = true;
    setError(null);
    const t = setTimeout(() => {
      const again = fresh !== usedFresh.current;
      usedFresh.current = fresh;
      api.kitPluginCatalog(m.backend, m.machine, col.agent, q, limit, again).then(
        (r) => live && setRes(r),
        (e: unknown) => live && setError(errorText(e)),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [m?.backend, m?.machine, col?.agent, q, limit, fresh, at]);
  return (
    <div className="kit-sheet">
      <h4>Add a plugin</h4>
      <div className="kit-line">
        <select className="settings-input" value={target} onChange={(e) => { setTarget(e.target.value); setRes(null); }} aria-label="machine and agent">
          {cols.map((c) => <option key={colKey(c)} value={colKey(c)}>{c.machine} · {c.agent}</option>)}
        </select>
        <input className="settings-input kit-search" placeholder="search the marketplaces" value={q} onChange={(e) => { setQ(e.target.value); setLimit(30); }} />
        <button type="button" className="mini" title="read the catalog again" onClick={() => setFresh((n) => n + 1)}>refresh</button>
      </div>
      <div className="chips">
        {CATALOG_CHIPS.map((c) => (
          <button key={c.label} type="button" className={`chip${q === c.q ? " on" : ""}`} onClick={() => { setQ(q === c.q ? "" : c.q); setLimit(30); }}>{c.label}</button>
        ))}
      </div>
      {error && <p className="kit-error">{error}</p>}
      {!res && !error && <p className="kit-note">reading {col ? `${col.agent}'s marketplaces on ${col.machine}` : "the catalog"}…</p>}
      {res && col && m && (
        <>
          <p className="kit-note">{res.total} {res.total === 1 ? "plugin" : "plugins"}{q ? ` ${res.total === 1 ? "matches" : "match"} ${q}` : ""} in {col.agent}'s marketplaces on {col.machine}</p>
          <ul className="plugin-catalog">
            {res.entries.map((e) => (
              <li key={e.id}>
                <div className="kit-line">
                  <strong>{e.name}</strong>
                  <span className="kit-note">@{e.marketplace}{e.version ? ` ${e.version}` : ""}{e.installs !== null ? `, ${e.installs.toLocaleString()} installs` : ""}</span>
                  {e.installed ? <span className="kit-ok">installed</span> : <OpButton ops={ops} m={m} req={{ agent: col.agent, op: "install", id: e.id }} what={e.id} />}
                </div>
                {e.description && <p className="kit-note">{e.description}</p>}
              </li>
            ))}
          </ul>
          {res.total > res.entries.length && <button type="button" className="mini" onClick={() => setLimit((n) => n + 30)}>show more</button>}
        </>
      )}
      <div className="kit-line">
        <button type="button" className="mini" onClick={onClose}>close</button>
      </div>
    </div>
  );
}

function MarketsSheet({ ops, cols, onClose }: { ops: Ops; cols: PluginColumn[]; onClose: () => void }) {
  const [target, setTarget] = useState(cols[0] ? colKey(cols[0]) : "");
  const [source, setSource] = useState("");
  const col = cols.find((c) => colKey(c) === target);
  const tm = col ? ops.ms.find((x) => x.machine === col.machine) : undefined;
  return (
    <div className="kit-sheet">
      <h4>Marketplaces</h4>
      <div className="kit-line">
        <select className="settings-input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="machine and agent">
          {cols.map((c) => <option key={colKey(c)} value={colKey(c)}>{c.machine} · {c.agent}</option>)}
        </select>
        <input className="settings-input kit-search" placeholder="owner/repo, a git url or a path" value={source} onChange={(e) => setSource(e.target.value)} />
        {tm && col && source.trim() && <OpButton ops={ops} m={tm} req={{ agent: col.agent, op: "market-add", source: source.trim() }} what={source.trim()} onOk={() => setSource("")} />}
      </div>
      <p className="kit-note">A marketplace runs what its plugins declare, so add only one you trust.</p>
      {cols.map((c) => {
        const m = ops.ms.find((x) => x.machine === c.machine);
        const a = m?.agents.find((x) => x.agent === c.agent);
        if (!m || !a) return null;
        const extra = c.agent === "claude" ? declaredOnly(a) : [];
        return (
          <div key={colKey(c)} className="plugin-markets">
            <h5>{c.machine} · {c.agent}</h5>
            <ul>
              {a.markets.map((mk) => (
                <li key={mk.name} className="kit-line">
                  <strong>{mk.name}</strong>
                  <code className="kit-note">{mk.source}</code>
                  <OpButton ops={ops} m={m} req={{ agent: c.agent, op: "market-update", name: mk.name }} what={mk.name} />
                  <OpButton ops={ops} m={m} req={{ agent: c.agent, op: "market-remove", name: mk.name }} what={mk.name} />
                </li>
              ))}
              {extra.map((mk) => (
                <li key={`declared/${mk.name}`} className="kit-line">
                  <strong>{mk.name}</strong>
                  <span className="kit-problem">settings.json declares it, not added here</span>
                  {mk.source && !isFolder(mk.source) ? (
                    <OpButton ops={ops} m={m} req={{ agent: c.agent, op: "market-add", source: mk.source }} what={mk.name} />
                  ) : (
                    <span className="kit-note">its source is a folder on another machine, {mk.source || "unnamed"}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="kit-line">
        <button type="button" className="mini" onClick={onClose}>close</button>
      </div>
    </div>
  );
}

export function PluginsView() {
  const byBackend = useStore((s) => s.kit);
  const ms = useMemo(() => mergePlugins(byBackend), [byBackend]);
  const [f, setF] = useState<PluginFilter>({ agent: null, machine: null, problems: false, text: "" });
  const cols = useMemo(() => pluginColumns(ms, f), [ms, f]);
  const allCols = useMemo(() => pluginColumns(ms, { agent: null, machine: null }), [ms]);
  const ids = useMemo(() => pluginRows(ms, cols, f), [ms, cols, f]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const ops = useOps(ms, setSaid);
  const agents = [...new Set(allCols.map((c) => c.agent))];

  async function rescan() {
    setScanning(true);
    try {
      await Promise.all(Object.entries(byBackend).filter(([, i]) => i.plugins !== undefined).map(([b]) => api.kitScan(b)));
    } finally {
      setScanning(false);
    }
  }

  if (!readsPlugins(byBackend)) {
    return (
      <main className="kit-view plugins-view">
        <p className="kit-note">No backend on this page reads plugins yet. kit.json's <code>plugins</code> names the agents (claude, codex) whose plugins the kit manages, on the machines their targets name.</p>
      </main>
    );
  }

  return (
    <main className="kit-view plugins-view">
      <div className="kit-bar">
        <input className="settings-input kit-search" placeholder="filter plugins or servers" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        <select className="settings-input" value={f.agent ?? ""} onChange={(e) => setF({ ...f, agent: agents.find((a) => a === e.target.value) ?? null })} aria-label="agent">
          <option value="">every agent</option>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="settings-input" value={f.machine ?? ""} onChange={(e) => setF({ ...f, machine: e.target.value || null })} aria-label="machine">
          <option value="">every machine</option>
          {ms.map((m) => <option key={m.machine} value={m.machine}>{m.machine}</option>)}
        </select>
        <label className="kit-toggle">
          <input type="checkbox" checked={f.problems} onChange={(e) => setF({ ...f, problems: e.target.checked })} /> only problems
        </label>
        <button type="button" className="mini" onClick={() => setSheet({ kind: "catalog" })} disabled={allCols.length === 0}>add a plugin…</button>
        <button type="button" className="mini" onClick={() => setSheet({ kind: "markets" })} disabled={allCols.length === 0}>marketplaces…</button>
        <button type="button" className="mini" disabled={scanning} onClick={() => void rescan()}>{scanning ? "scanning…" : "rescan"}</button>
        {said && <span className="kit-said">{said}</span>}
      </div>
      <div className="kit-machines">
        {ms.filter((m) => !f.machine || m.machine === f.machine).map((m) => (
          <div key={m.machine} className="kit-machine">
            <strong>{m.machine}</strong>
            {m.away ? <span className="kit-away">away: {m.away}</span> : (
              <span className="kit-note">
                {[
                  m.shared ? (m.commits ? "commits dotclaude's shared settings.json" : "follows dotclaude's shared settings.json") : "its own settings.json",
                  ...(m.settingsDirty && m.shared ? ["settings.json changed, not committed"] : []),
                  ...m.agents.filter((a) => a.error).map((a) => `${a.agent}: ${a.error}`),
                ].join("; ")}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="kit-scroll">
        {ids.length === 0 ? <p className="kit-note">{f.text || f.problems ? "No plugin matches." : "No plugins installed on the machines read."}</p> : (
          <table className="kit-grid plugins-grid">
            <thead>
              <tr>
                <th>plugin</th>
                {cols.map((c) => <th key={colKey(c)} title={`${c.agent} on ${c.machine}`}>{c.machine}<br />{c.agent}</th>)}
              </tr>
            </thead>
            <tbody>
              {ids.map((id) => {
                const servers = Object.keys(serversOf(ms, id));
                return (
                  <tr key={id}>
                    <th scope="row">
                      <button type="button" className="kit-cell-button plugin-name" onClick={() => setSheet({ kind: "plugin", id })}>{id}</button>
                      {servers.length > 0 && <span className="plugin-servers" title="the MCP servers it brings">{servers.join(", ")}</span>}
                    </th>
                    {cols.map((c) => {
                      const cell = cellOf(ms, c, id);
                      return (
                        <td key={colKey(c)} className={`kit-cell plugin-${cell.state}${PLUGIN_PROBLEM.has(cell.state) ? " kit-problem" : ""}`}
                          title={`${cell.state === "none" ? "not installed" : cell.state}${cell.why ? `: ${cell.why}` : ""}`}>
                          <button type="button" className="kit-cell-button" aria-label={`${id} on ${c.machine} ${c.agent}: ${cell.state}`} onClick={() => setSheet({ kind: "plugin", id })}>
                            {PLUGIN_GLYPH[cell.state] || "·"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="kit-note plugin-legend">● on · ◐ off · ○ turned on in settings.json, not installed · ! fails to load</p>
      <PendingBox ops={ops} />
      {sheet?.kind === "plugin" && <PluginSheet key={sheet.id} id={sheet.id} ops={ops} cols={allCols} onClose={() => setSheet(null)} />}
      {sheet?.kind === "catalog" && <CatalogSheet ops={ops} cols={allCols} onClose={() => setSheet(null)} />}
      {sheet?.kind === "markets" && <MarketsSheet ops={ops} cols={allCols} onClose={() => setSheet(null)} />}
    </main>
  );
}
