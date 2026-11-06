/** Agent routing, the agents view's routing tab and a settings section:
 *  profiles, roles, repo overrides, the effective table, and the broker's
 *  guard rules. */
import { useEffect, useMemo, useState } from "react";
import { describeAgent } from "../../../src/core/agent";
import { HARNESS } from "../../../src/core/harness";
import { DEFAULT_PROFILE, hasProfile, isProfileName, isProfilePick, profileOf, resolveAgent, roleRefusal, roleTakes } from "../../../src/core/route";
import { AGENT_ROLES, DEFAULT_AGENT, type AgentRole, type AgentRoutes, type GuardsInfo, type Harness, type RepoAgent } from "../../../src/core/types";
import { describeGuard, guardHit, normalizeGuards, parseGuardRule } from "../../../src/core/guards";
import { api } from "../api";
import { effectiveRows, missingProfiles, overrideRows, profileNames, profileUses, ROLE_LABEL, ROLE_TITLE, withPick } from "../agents";
import { backendOf } from "../registry";
import { connOf, useStore } from "../store";
import { AgentSettingsForm, EffectiveTable, PickEditor } from "./AgentForm";
import { AgentScopes } from "./AgentScopes";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

export function Routing({ scope, routes, has, routing }: { scope: string; routes: AgentRoutes; has: readonly Harness[]; routing: boolean }) {
  const missing = missingProfiles(routes);
  if (!routing) {
    // an older backend keeps plain settings per repo, and nothing else
    return (
      <>
        <p className="settings-hint warn agents-warn">
          {scope} runs a canopy older than agent routing: it keeps one set of Claude settings per repo, and has no profiles, roles or per-role
          picks to edit. Update it for those.
        </p>
        <Overrides scope={scope} routes={routes} has={has} legacy />
        <Effective scope={scope} routes={routes} has={has} />
        <Guards />
      </>
    );
  }
  return (
    <>
      <p className="blurb agents-blurb">
        System defaults and routes are saved on {scope} and shared by every browser connected to it. A start uses the first matching
        route: launch or workflow step, repo workflow/task, system workflow/task, repo role, repo, work type, then the default profile. A pick naming a profile that is gone is passed over, and the
        effective table says so.
      </p>
      {missing.length > 0 && (
        <p className="settings-hint warn agents-warn">
          Routes naming a profile that is gone, which fall through to the next layer: {missing.join("; ")}
        </p>
      )}
      <Profiles scope={scope} routes={routes} has={has} />
      <Roles scope={scope} routes={routes} has={has} />
      <AgentScopes key={scope} backend={scope} routes={routes} has={has} />
      <Overrides scope={scope} routes={routes} has={has} />
      <Effective scope={scope} routes={routes} has={has} />
      <Guards />
    </>
  );
}

/* ---------- guards: commands a yolo agent must ask a person before running ---------- */

/**
 * The broker's guard rules, tailnet-wide (the home backend's broker, not
 * the backend picked above): a shell command that hits one waits for a
 * person in the inbox whatever the agent's permission mode, and is denied
 * when no one answers. Editable with this device's answer key; a box tries
 * a command against the rules as the hook would.
 */
function Guards() {
  const ready = useStore((s) => s.asksReady);
  const key = useStore((s) => s.answerKey);
  const [info, setInfo] = useState<GuardsInfo | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [add, setAdd] = useState("");
  const [trial, setTrial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    api
      .guards()
      .then((g) => {
        if (!live) return;
        setInfo(g);
        setDraft(g.rules);
      })
      .catch((err: unknown) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [ready]);
  if (!ready) return null;
  const canEdit = info?.canEdit === true && key !== null;
  const dirty = info !== null && JSON.stringify(draft) !== JSON.stringify(info.rules);
  const valid = draft.filter((r) => parseGuardRule(r).ok);
  const hit = trial.trim() ? guardHit(valid.map((r) => r.trim()), trial) : null;
  const addRule = () => {
    const p = parseGuardRule(add);
    if (!p.ok) {
      setError(p.error);
      return;
    }
    setError(null);
    if (!draft.includes(p.rule.text)) setDraft([...draft, p.rule.text]);
    setAdd("");
  };
  const save = () => {
    const n = normalizeGuards(draft);
    if ("error" in n) {
      setError(n.error);
      return;
    }
    setSaving(true);
    setError(null);
    api
      .setGuards(n.rules, key ?? "")
      .then((g) => {
        setInfo(g);
        setDraft(g.rules);
      })
      .catch((err: unknown) => setError(errText(err)))
      .finally(() => setSaving(false));
  };
  return (
    <section className="agents-section" aria-label="Guards">
      <h3 className="panel-label">guards</h3>
      <p className="settings-hint">
        Shell commands no agent runs without asking you, whatever its permission mode, on every machine with the tailchan hooks. A hit waits in
        the inbox (? in the top bar) and is denied if nobody answers. Claude's rule syntax: <code>Bash(git push --force:*)</code> for a prefix,{" "}
        <code>Bash(rm -rf *)</code> for a pattern, <code>Bash(make deploy)</code> for one command.
      </p>
      {!info && !error && <p className="settings-hint">Reading the rules…</p>}
      {info && !canEdit && <p className="settings-hint warn">Read-only on this device: add your answer key in Settings to edit them.</p>}
      {info && draft.length === 0 && <p className="settings-hint">No guards: nothing a yolo agent runs waits for you.</p>}
      <ul className="agents-list guard-list">
        {draft.map((rule, i) => {
          const p = parseGuardRule(rule);
          return (
            <li key={i} className="agents-row guard-row">
              <input
                className="settings-input guard-input"
                value={rule}
                readOnly={!canEdit}
                aria-label={`Guard rule ${i + 1}`}
                spellCheck={false}
                onChange={(e) => setDraft(draft.map((r, j) => (j === i ? e.target.value : r)))}
              />
              <span className={p.ok ? (p.rule.inert ? "settings-hint warn" : "settings-hint") : "settings-hint error"}>
                {p.ok ? describeGuard(p.rule) : p.error}
              </span>
              {canEdit && (
                <button type="button" className="mini" aria-label={`Remove ${rule}`} onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                  remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <div className="agents-add">
          <input
            className="settings-input"
            placeholder="Bash(git push --force:*)"
            value={add}
            spellCheck={false}
            aria-label="A new guard rule"
            onChange={(e) => setAdd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addRule();
            }}
          />
          <button type="button" className="mini" disabled={!add.trim()} onClick={addRule}>
            add guard
          </button>
          {dirty && (
            <>
              <button type="button" className="mini strong" disabled={saving} onClick={save}>
                {saving ? "saving…" : "save guards"}
              </button>
              <button type="button" className="mini" disabled={saving} onClick={() => info && setDraft(info.rules)}>
                revert
              </button>
            </>
          )}
        </div>
      )}
      {info && (
        <div className="agents-add">
          <input
            className="settings-input"
            placeholder="try a command: git push --force origin main"
            value={trial}
            spellCheck={false}
            aria-label="A command to try against the guards"
            onChange={(e) => setTrial(e.target.value)}
          />
          {trial.trim() && <span className={hit ? "settings-hint warn" : "settings-hint"}>{hit ? `waits for you: ${hit}` : "runs without asking"}</span>}
        </div>
      )}
      {error && <p className="settings-hint error">{error}</p>}
    </section>
  );
}

/* ---------- profiles ---------- */

function Profiles({ scope, routes, has }: { scope: string; routes: AgentRoutes; has: readonly Harness[] }) {
  const setProfile = useStore((s) => s.setProfile);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  };
  const add = () => {
    const n = name.trim();
    if (!isProfileName(n)) {
      setError("A profile's name is lowercase letters, digits, - and _, up to 32.");
      return;
    }
    if (hasProfile(routes.profiles, n)) {
      setEditing(n);
      setName("");
      return;
    }
    void act(async () => {
      await setProfile(scope, n, { ...DEFAULT_AGENT });
      setEditing(n);
      setName("");
    });
  };
  return (
    <section className="agents-section" aria-label="Profiles">
      <h3 className="panel-label">profiles</h3>
      <p className="settings-hint">Named settings a route points at: change one and every route on it follows. Edit default to set this system's agent, model, effort, provider and permissions.</p>
      <ul className="agents-list">
        {profileNames(routes).map((n) => {
          const p = routes.profiles[n]!;
          const uses = profileUses(routes, n);
          const open = editing === n;
          return (
            <li key={n} className={open ? "agents-row open" : "agents-row"}>
              <div className="agents-row-head">
                <span className={`harness-glyph h-${p.harness}`} title={HARNESS[p.harness].label}>
                  {HARNESS[p.harness].glyph}
                </span>
                <span className="agents-name">{n}</span>
                <span className="agents-line">
                  {HARNESS[p.harness].label} · {describeAgent(p, false)}
                  {!has.includes(p.harness) && <span className="effective-flag"> not installed here</span>}
                </span>
                <span className="agents-fact">{n === DEFAULT_PROFILE ? "the default" : uses ? `${uses} route${uses === 1 ? "" : "s"}` : "unused"}</span>
                <button type="button" className="mini" onClick={() => setEditing(open ? null : n)}>
                  {open ? "done" : "edit"}
                </button>
                {n === DEFAULT_PROFILE ? (
                  <button type="button" className="mini" title="Back to claude as built in" onClick={() => void act(() => setProfile(scope, n, null))}>
                    reset
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mini"
                    onClick={() => {
                      if (uses && !window.confirm(`${uses} route${uses === 1 ? "" : "s"} point at ${n}; they will fall through to the next layer. Delete it?`)) return;
                      void act(() => setProfile(scope, n, null));
                    }}
                  >
                    delete
                  </button>
                )}
              </div>
              {open && <AgentSettingsForm value={p} has={has} machine={scope} onChange={(next) => void act(() => setProfile(scope, n, next))} />}
            </li>
          );
        })}
      </ul>
      <div className="agents-add">
        <input
          type="text"
          className="settings-input"
          placeholder="new profile: deep, review…"
          value={name}
          aria-label="New profile name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" className="mini" disabled={!name.trim()} onClick={add}>
          add profile
        </button>
      </div>
      {error && <p className="settings-hint error">{error}</p>}
    </section>
  );
}

/* ---------- roles ---------- */

function Roles({ scope, routes, has }: { scope: string; routes: AgentRoutes; has: readonly Harness[] }) {
  const setRole = useStore((s) => s.setRole);
  // the coordinate role is read only where the backend runs coordinators
  const coordHere = useStore((s) => connOf(s, scope).about?.coordinator === true);
  const [error, setError] = useState<string | null>(null);
  const choose = async (role: AgentRole, pick: Parameters<typeof setRole>[2]) => {
    setError(null);
    try { await setRole(scope, role, pick); } catch (err) { setError(errText(err)); }
  };
  return (
    <section className="agents-section" aria-label="Roles">
      <h3 className="panel-label">roles</h3>
      <p className="settings-hint">The route for each kind of work, where a repo has no pick of its own.</p>
      <ul className="agents-list">
        {AGENT_ROLES.map((role) => {
          const pick = routes.roles[role];
          const named = pick && isProfilePick(pick) ? profileOf(routes.profiles, pick.profile) : undefined;
          const passed = named && !roleTakes(role, named.harness) ? roleRefusal(role, named.harness) : null;
          return (
            <li key={role} className="agents-row">
              <div className="agents-row-head">
                <span className="agents-name" title={ROLE_TITLE[role]}>
                  {ROLE_LABEL[role]}
                </span>
                <PickEditor slot={role} pick={pick} routes={routes} has={has} machine={scope} inherit="inherit system default"
                  seed={resolveAgent(routes, "", role).settings} onChange={(p) => void choose(role, p)} />
              </div>
              {passed && <p className="settings-hint warn">{passed}; it is passed over.</p>}
              {role === "coordinate" && !coordHere && <p className="settings-hint">{scope} has no coordinator runner, so this route is not used there.</p>}
            </li>
          );
        })}
      </ul>
      {error && <p className="settings-hint error">{error}</p>}
    </section>
  );
}

/* ---------- repo overrides ---------- */

function Overrides({ scope, routes, has, legacy = false }: { scope: string; routes: AgentRoutes; has: readonly Harness[]; legacy?: boolean }) {
  const allRepos = useStore((s) => s.repos);
  const setAgent = useStore((s) => s.setAgent);
  const repos = useMemo(() => allRepos.filter((r) => backendOf(r.id) === scope && !r.forge), [allRepos, scope]);
  const [adding, setAdding] = useState<string[]>([]);
  const [find, setFind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rows = overrideRows(routes, repos);
  const shown = [...rows, ...adding.filter((p) => !rows.some((r) => r.path === p)).map((path) => ({ path, repo: repos.find((r) => r.path === path) ?? null }))];
  const save = async (id: string, next: RepoAgent) => {
    setError(null);
    try {
      await setAgent(id, next);
    } catch (err) {
      setError(errText(err));
    }
  };
  const add = () => {
    const q = find.trim().toLowerCase();
    const hit = repos.find((r) => r.name.toLowerCase() === q) ?? repos.find((r) => r.name.toLowerCase().includes(q));
    if (!hit) {
      setError(`No repo on ${scope} matches "${find.trim()}".`);
      return;
    }
    setError(null);
    setAdding((a) => (a.includes(hit.path) ? a : [...a, hit.path]));
    setFind("");
  };
  return (
    <section className="agents-section" aria-label="Repo overrides">
      <h3 className="panel-label">repo overrides</h3>
      <p className="settings-hint">A repo's own picks beat the role routes: a pick for the whole repo, and picks per role that beat that.</p>
      {shown.length === 0 && <p className="settings-hint">No repo overrides the routes.</p>}
      <ul className="agents-list">
        {shown.map(({ path, repo }) => {
          const current = routes.repos[path] ?? {};
          return (
            <li key={path} className="agents-row">
              <div className="agents-row-head">
                <span className="agents-name" title={path}>
                  {repo?.name ?? path}
                </span>
                {!repo && <span className="agents-fact">not in the scan</span>}
                <button
                  type="button"
                  className="mini"
                  disabled={!repo || !routes.repos[path]}
                  onClick={() => {
                    if (repo) void save(repo.id, {});
                    setAdding((a) => a.filter((p) => p !== path));
                  }}
                >
                  reset
                </button>
              </div>
              {repo && (
                <div className="override-grid">
                  {(legacy ? (["all"] as const) : (["all", ...AGENT_ROLES] as const)).map((slot) => (
                    <div key={slot} className="override-slot">
                      <span className="override-label" title={slot === "all" ? "Every role at once" : ROLE_TITLE[slot]}>
                        {slot === "all" ? "whole repo" : ROLE_LABEL[slot]}
                      </span>
                      <PickEditor
                        slot={slot}
                        pick={slot === "all" ? current.all : current.roles?.[slot]}
                        routes={routes}
                        has={has}
                        machine={scope}
                        inherit="inherit"
                        seed={resolveAgent(routes, path, slot === "all" ? "shell" : slot).settings}
                        onChange={(p) => void save(repo.id, withPick(current, slot, p))}
                        compact
                        profiles={!legacy}
                      />
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="agents-add">
        <input
          type="search"
          className="settings-input"
          list="agents-repos"
          placeholder="add an override: a repo's name"
          value={find}
          aria-label="Repo to add an override for"
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <datalist id="agents-repos">
          {repos.map((r) => (
            <option key={r.id} value={r.name} />
          ))}
        </datalist>
        <button type="button" className="mini" disabled={!find.trim()} onClick={add}>
          add override
        </button>
      </div>
      <p className="settings-hint">Settings of a repo's own are edited from its ⋯ menu, agent routing…, which opens this row with the full form.</p>
      {error && <p className="settings-hint error">{error}</p>}
    </section>
  );
}

/* ---------- effective ---------- */

function Effective({ scope, routes, has }: { scope: string; routes: AgentRoutes; has: readonly Harness[] }) {
  const allRepos = useStore((s) => s.repos);
  const editAgent = useStore((s) => s.editAgent);
  const repos = useMemo(
    () => allRepos.filter((r) => backendOf(r.id) === scope && !r.forge).sort((a, b) => a.name.localeCompare(b.name)),
    [allRepos, scope],
  );
  const [id, setId] = useState("");
  const repo = repos.find((r) => r.id === id) ?? repos[0];
  const rows = useMemo(() => (repo ? effectiveRows(routes, repo.path, has) : []), [routes, repo, has]);
  return (
    <section className="agents-section" aria-label="Effective routing">
      <h3 className="panel-label">effective</h3>
      {!repo ? (
        <p className="settings-hint">No repo on {scope} to show.</p>
      ) : (
        <>
          <div className="agents-add">
            <select className="settings-input" value={repo.id} aria-label="Repo" onChange={(e) => setId(e.target.value)}>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button type="button" className="mini" onClick={() => editAgent(repo.id)}>
              its override…
            </button>
          </div>
          <EffectiveTable rows={rows} />
        </>
      )}
    </section>
  );
}
