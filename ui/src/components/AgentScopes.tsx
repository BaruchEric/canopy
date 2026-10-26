import { useEffect, useId, useMemo, useState } from "react";
import { describeAgent, withHarness } from "../../../src/core/agent";
import { isAgentScopeName, resolveAgent } from "../../../src/core/route";
import type { AgentPick, AgentRoutes, AgentScope, Harness } from "../../../src/core/types";
import { fromWord, withScopePick } from "../agents";
import { api } from "../api";
import { backendOf } from "../registry";
import { useStore } from "../store";
import { PickEditor } from "./AgentForm";

/** Named routes use the same resolver as launches. A repo selection edits
 *  that repo's named routes and previews their actual inherited settings. */
export function AgentScopes({ backend, routes, has }: { backend: string; routes: AgentRoutes; has: readonly Harness[] }) {
  const allRepos = useStore((s) => s.repos);
  const repos = useMemo(() => allRepos.filter((r) => backendOf(r.id) === backend && !r.forge), [allRepos, backend]);
  const setScope = useStore((s) => s.setAgentScope);
  const setAgent = useStore((s) => s.setAgent);
  const [target, setTarget] = useState("");
  const repo = repos.find((r) => r.id === target);
  const [name, setName] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const preview = repo ?? repos[0];
  useEffect(() => {
    let live = true;
    setAvailable([]);
    setAdded([]);
    setError(null);
    if (preview) api.workflows(preview.id).then((entries) => {
      if (live) setAvailable(entries.flatMap((e) => e.ok ? [e.workflow.name] : []));
    }, (e: unknown) => { if (live) setError(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [preview?.id, backend]);
  const local = repo ? routes.repos[repo.path] ?? {} : undefined;
  const names = [...new Set([...available, ...added, ...Object.keys(routes.workflows ?? {}), ...Object.keys(local?.workflows ?? {})])].sort();
  const save = async (scope: AgentScope, pick: AgentPick | null) => {
    setError(null);
    setSaving(true);
    try {
      if (repo) await setAgent(repo.id, withScopePick(routes.repos[repo.path] ?? {}, scope, pick));
      else await setScope(backend, scope, pick);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };
  const row = (scope: AgentScope) => {
    const key = scope.kind === "workflow" ? "workflows" : "tasks";
    const effective = resolveAgent(routes, preview?.path ?? "", scope.kind === "workflow" ? "flow" : "job", undefined, scope);
    const pick = repo ? local?.[key]?.[scope.name] : routes[key]?.[scope.name];
    const propose = scope.kind === "task" && scope.name === "propose";
    return <li key={`${scope.kind}-${scope.name}`} className="agents-row">
      <h4 className="panel-label">{scope.name}</h4>
      <PickEditor label={`Route for ${scope.kind} ${scope.name}`} slot={scope.kind === "workflow" ? "flow" : "job"} pick={pick} routes={routes} has={has} machine={backend}
        allowed={propose ? ["claude"] : undefined}
        inherit={repo ? "inherit workflow/task and broader defaults" : "inherit repo and work-type defaults"}
        seed={propose ? withHarness(effective.settings, "claude") : effective.settings} onChange={(p) => void save(scope, p)} />
      <p className="settings-hint">Effective{preview ? ` for ${preview.name}` : ""}: {effective.settings.harness} · {describeAgent(effective.settings, false)} · {fromWord(effective)}</p>
      {(effective.skipped ?? []).map((s, i) => <p key={i} className="settings-hint warn">{s.why}; using the next route.</p>)}
      {!has.includes(effective.settings.harness) && <p className="settings-hint warn">{effective.settings.harness} is not installed on {backend}.</p>}
      {propose && effective.settings.harness !== "claude" && <p role="alert" className="settings-hint warn">Plan, then build requires Claude Code. Set this task to a Claude profile or custom Claude settings before launching it.</p>}
    </li>;
  };
  return <section className="agents-section" aria-label="Workflow and task routing">
    <h3 className="panel-label">workflow and task routing</h3>
    <label className="settings-line" htmlFor={`${id}-repo`}>Apply named routes to</label>
    <select id={`${id}-repo`} className="settings-input" value={repo?.id ?? ""} onChange={(e) => setTarget(e.target.value)}>
      <option value="">system on {backend}</option>
      {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
    <p className="settings-hint">Launch or step pick → repo workflow/task → system workflow/task → repo role → repo → work type → system default. Inherit removes just this override.</p>
    <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <h4 className="panel-label">workflows</h4>
      <ul className="agents-list">{names.map((name) => row({ kind: "workflow", name }))}</ul>
      <div className="agents-add">
        <input className="settings-input" aria-label="Workflow name to route" value={name} placeholder="workflow name" onChange={(e) => setName(e.target.value)} />
        <button className="mini" type="button" disabled={!isAgentScopeName(name.trim())} onClick={() => { setAdded([...added, name.trim()]); setName(""); }}>add workflow route</button>
      </div>
      <h4 className="panel-label">agent tasks</h4>
      <ul className="agents-list">{["ask", "propose"].map((name) => row({ kind: "task", name }))}</ul>
      <p className="settings-hint">ask runs a task you describe; propose plans, then builds with Claude Code. Development commands in the Tasks panel run their configured shell command.</p>
    </fieldset>
    {error && <p role="alert" className="settings-hint error">{error}</p>}
  </section>;
}
