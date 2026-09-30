import { useMemo, useState } from "react";
import { describeAgent } from "../../../src/core/agent";
import { HARNESS } from "../../../src/core/harness";
import { DEFAULT_PROFILE, isProfileName, isProfilePick, resolveAgent, roleRefusal, roleTakes } from "../../../src/core/route";
import { AGENT_ROLES, DEFAULT_AGENT, HARNESSES, type AgentRole, type AgentRoutes, type Harness, type RepoAgent } from "../../../src/core/types";
import {
  effectiveRows,
  harnessesOf,
  missingProfiles,
  overrideRows,
  pickLine,
  profileNames,
  profileUses,
  ROLE_LABEL,
  ROLE_TITLE,
  withPick,
} from "../agents";
import { backendOf } from "../registry";
import { connOf, multi, routesOf, useStore } from "../store";
import { AgentSettingsForm, EffectiveTable, PickEditor } from "./AgentForm";
import { Seg } from "./Seg";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

const TABS = [{ value: "routing", label: "routing", title: "Which agent starts for what: profiles, roles and repo overrides" }] as const;

/**
 * The agents view: a fourth view beside git, library and ports. Its one tab
 * for now is routing (the registry of every running agent comes later):
 * the profiles a route can name, the route per role, the repos that
 * override them, and any repo's effective table. Routes are the backend's
 * own; on a board with several, the picker at the top says whose are shown.
 */
export function AgentsView() {
  const home = useStore((s) => s.home);
  const order = useStore((s) => s.backendOrder);
  const isMulti = useStore(multi);
  const [picked, setPicked] = useState<string | null>(null);
  const scope = picked && order.includes(picked) ? picked : home;
  const routes = useStore((s) => routesOf(s, scope));
  const has = useStore((s) => harnessesOf(connOf(s, scope).backend));
  const [tab, setTab] = useState<"routing">("routing");

  return (
    <section className="agents-view" aria-label="Agents">
      <div className="agents-bar">
        <Seg label="Agents view" value={tab} options={TABS} onChange={setTab} />
        {isMulti && (
          <Seg
            label="Backend"
            value={scope}
            options={order.map((b) => ({ value: b, label: b, title: `The routes ${b} keeps` }))}
            onChange={setPicked}
          />
        )}
        <span className="agents-has" title="The harnesses this backend has installed">
          {HARNESSES.map((h) => (
            <span key={h} className={has.includes(h) ? `harness-chip h-${h}` : "harness-chip off"}>
              {HARNESS[h].glyph} {HARNESS[h].label}
              {has.includes(h) ? "" : " · not installed"}
            </span>
          ))}
        </span>
      </div>
      <div className="agents-body">
        <Routing scope={scope} routes={routes} has={has} />
      </div>
    </section>
  );
}

function Routing({ scope, routes, has }: { scope: string; routes: AgentRoutes; has: readonly Harness[] }) {
  const missing = missingProfiles(routes);
  return (
    <>
      <p className="blurb agents-blurb">
        A start resolves through these, the first that answers winning: a pick at launch, the repo's pick for the role, the repo's whole
        pick, the role's route, the default profile, then claude as built in. Only shells may be codex for now; a codex pick anywhere else is
        passed over, and the effective table says so.
      </p>
      {missing.length > 0 && (
        <p className="settings-hint warn agents-warn">
          Routes naming a profile that is gone, which fall through to the next layer: {missing.join("; ")}
        </p>
      )}
      <Profiles scope={scope} routes={routes} has={has} />
      <Roles scope={scope} routes={routes} has={has} />
      <Overrides scope={scope} routes={routes} has={has} />
      <Effective scope={scope} routes={routes} has={has} />
    </>
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
    if (n in routes.profiles) {
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
      <p className="settings-hint">Named settings a route points at: change one and every route on it follows. default is the backend's own.</p>
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

function Roles({ scope, routes }: { scope: string; routes: AgentRoutes; has: readonly Harness[] }) {
  const setRole = useStore((s) => s.setRole);
  const [error, setError] = useState<string | null>(null);
  const choose = async (role: AgentRole, value: string) => {
    setError(null);
    try {
      if (value === "") await setRole(scope, role, null);
      else if (value.startsWith("profile:")) await setRole(scope, role, { profile: value.slice("profile:".length) });
    } catch (err) {
      setError(errText(err));
    }
  };
  return (
    <section className="agents-section" aria-label="Roles">
      <h3 className="panel-label">roles</h3>
      <p className="settings-hint">The route for each kind of work, where a repo has no pick of its own.</p>
      <ul className="agents-list">
        {AGENT_ROLES.map((role) => {
          const pick = routes.roles[role];
          const value = !pick ? "" : isProfilePick(pick) ? `profile:${pick.profile}` : "custom";
          const named = pick && isProfilePick(pick) ? routes.profiles[pick.profile] : undefined;
          const passed = named && !roleTakes(role, named.harness) ? roleRefusal(role, named.harness) : null;
          return (
            <li key={role} className="agents-row">
              <div className="agents-row-head">
                <span className="agents-name" title={ROLE_TITLE[role]}>
                  {ROLE_LABEL[role]}
                </span>
                <select className="settings-input pick-select" value={value} aria-label={`Route for ${ROLE_LABEL[role]}`} onChange={(e) => void choose(role, e.target.value)}>
                  <option value="">default profile</option>
                  {profileNames(routes).map((n) => (
                    <option key={n} value={`profile:${n}`}>
                      {HARNESS[routes.profiles[n]!.harness].glyph} {n}
                    </option>
                  ))}
                  {pick && isProfilePick(pick) && !(pick.profile in routes.profiles) && (
                    <option value={`profile:${pick.profile}`}>{pick.profile} (gone: falls through)</option>
                  )}
                  {pick && !isProfilePick(pick) && <option value="custom">{pickLine(pick)} (its own settings)</option>}
                </select>
              </div>
              {passed && <p className="settings-hint warn">{passed}; it is passed over.</p>}
            </li>
          );
        })}
      </ul>
      {error && <p className="settings-hint error">{error}</p>}
    </section>
  );
}

/* ---------- repo overrides ---------- */

function Overrides({ scope, routes, has }: { scope: string; routes: AgentRoutes; has: readonly Harness[] }) {
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
                  {(["all", ...AGENT_ROLES] as const).map((slot) => (
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
