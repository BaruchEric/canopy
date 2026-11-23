/**
 * The equip sheet (FR-065): a not-yet-started card's loadout and what Eric
 * changes on top of it, model, effort, provider, skills and servers. It
 * sends a whole `CardEquip` (`equipFrom`), the loadout's name plus only the
 * fields that differ, so the server replaces the card's equip with it. A
 * Codex loadout takes model, effort and provider only. `none` takes no
 * loadout at all, not even the one the card would inherit (FR-069). Layout
 * follows the Equip mockup.
 */
import { useEffect, useRef, useState } from "react";
import { HARNESS } from "../../../src/core/harness";
import { DEFAULT_PROVIDER, NO_LOADOUT, type CardEquip, type CoordTask, type Loadout, type LoadoutDefault, type Mention, type Run } from "../../../src/core/types";
import { api } from "../api";
import { equipFrom, fromWord, loadoutsFor, providersFor, serversHere, skillRows } from "../loadouts";
import { backendOf } from "../registry";
import { useStore } from "../store";

interface Picks {
  model: string;
  effort: string;
  skills: string[];
  mcp: string[];
  /** "" keeps the loadout's provider; `default` is the login */
  provider: string;
}

/** the loadout's own values, with the card's saved overrides on top when it
 *  was saved against that loadout */
function picksOf(l: Loadout, saved: CardEquip | undefined): Picks {
  const mine = saved?.loadout === l.name ? saved : undefined;
  return { model: mine?.model ?? l.model, effort: mine?.effort ?? l.effort, skills: [...(mine?.skills ?? l.skills)], mcp: [...(mine?.mcp ?? l.mcp)], provider: mine?.provider ?? "" };
}

const flip = (list: readonly string[], name: string): string[] => (list.includes(name) ? list.filter((x) => x !== name) : [...list, name]);

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function EquipSheet({ run, task, onDone }: { run: Run; task: CoordTask; onDone: () => void }) {
  const backend = backendOf(run.id);
  const info = useStore((s) => s.kit[backend]?.loadouts);
  const coordPlanEdit = useStore((s) => s.coordPlanEdit);
  // every step of a card's flow needs Claude Code, as plan, then build does;
  // a project card starts no run, so it takes no loadout
  const offered = task.action === "project" ? [] : loadoutsFor(task.workflow ? "propose" : task.action, info?.loadouts);
  const first = offered.find((l) => l.name === task.equip?.loadout) ?? offered[0];
  const [name, setName] = useState<string | undefined>(task.equip?.loadout === NO_LOADOUT ? NO_LOADOUT : first?.name);
  const none = name === NO_LOADOUT;
  const loadout = none ? undefined : (offered.find((l) => l.name === name) ?? first);
  // what the card takes left bare, asked of its backend when kit.json has defaults
  const hasDefaults = info?.defaults !== undefined;
  const [inherited, setInherited] = useState<LoadoutDefault | null>(null);
  // whether Eric picked a loadout or none here, so the inherited one never overrides that
  const picked = useRef(false);
  const [picks, setPicks] = useState<Picks | null>(() => (first ? picksOf(first, task.equip) : null));
  const [words, setWords] = useState<Mention[] | null>(null);
  const [wordsError, setWordsError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.mentions(task.repo).then(
      (list) => live && setWords(list),
      (err: unknown) => live && setWordsError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [task.repo]);

  useEffect(() => {
    if (!hasDefaults || task.action === "project") return;
    let live = true;
    api.loadoutResolve(task.repo, task.workflow ? "workflow" : task.action).then((d) => {
      if (!live) return;
      setInherited(d);
      // a bare card's sheet opens on the loadout it would take, so cancel leaves what it showed
      const l = !task.equip && d.name ? offered.find((x) => x.name === d.name) : undefined;
      if (l && !picked.current) {
        setName(l.name);
        setPicks(picksOf(l, undefined));
      }
    }, () => {});
    return () => {
      live = false;
    };
  }, [task.repo, task.action, task.workflow, hasDefaults]);

  const bare = inherited?.name ? `Left bare, this card takes ${inherited.name}, ${fromWord(inherited)}.` : null;

  const noneApply = async () => {
    setBusy(true);
    setError(null);
    try {
      await coordPlanEdit(run.id, task.id, { equip: { loadout: NO_LOADOUT } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (none) {
    return (
      <aside className="mgr-equip" aria-label={`Equip ${task.id}`}>
        <Head task={task} />
        <div className="mgr-equip-body">
          <section aria-label="loadout">
            <h3>loadout</h3>
            <div className="mgr-equip-row">
              {offered.map((l) => (
                <button key={l.name} type="button" className="mgr-equip-pick" aria-pressed={false} onClick={() => { picked.current = true; setName(l.name); setPicks(picksOf(l, task.equip)); }}>
                  {l.name}
                </button>
              ))}
              <button type="button" className="mgr-equip-pick" aria-pressed={true}>
                none
              </button>
            </div>
            <p className="mgr-equip-note">No loadout: the worker starts as the repo's route says, with every skill and server it has.{inherited?.name ? ` Without none, the card would take ${inherited.name}, ${fromWord(inherited)}.` : ""}</p>
          </section>
        </div>
        <div className="mgr-equip-foot">
          <p className="mgr-equip-summary">no loadout</p>
          {error && <p className="note err">{error}</p>}
          <div className="mgr-equip-row">
            <button type="button" className="mini strong" disabled={busy} onClick={() => void noneApply()}>
              apply to {task.id}
            </button>
            <button type="button" className="mini" onClick={onDone}>
              cancel
            </button>
          </div>
        </div>
      </aside>
    );
  }

  if (!loadout || !picks) {
    return (
      <aside className="mgr-equip" aria-label={`Equip ${task.id}`}>
        <Head task={task} />
        <p className="mgr-equip-note">This backend has no loadouts for this kind of card. Add them to kit.json.</p>
        <div className="mgr-equip-foot">
          <button type="button" className="mini" onClick={onDone}>
            cancel
          </button>
        </div>
      </aside>
    );
  }

  const ownSettings = loadout.harness !== "claude";
  const table = HARNESS[loadout.harness];
  const models = table.models.includes(picks.model) ? table.models : [...table.models, picks.model];
  const efforts = table.efforts.includes(picks.effort as (typeof table.efforts)[number]) ? table.efforts : [...table.efforts, picks.effort as (typeof table.efforts)[number]];
  const skills = skillRows(words ?? [], q, picks.skills, info?.base ?? []);
  const servers = info?.servers ?? [];
  const here = serversHere(picks.mcp, servers);
  const saved: Picks = { ...picks, mcp: here };
  const equip = equipFrom(loadout, saved);
  const changed = Object.keys(equip).length > 1;
  const providers = providersFor(loadout.harness, info?.providers);
  const providerWord = picks.provider === DEFAULT_PROVIDER ? "the login" : picks.provider || loadout.provider || "";
  const summary = [
    loadout.name,
    picks.model !== "default" ? picks.model : "",
    picks.effort !== "default" ? `effort ${picks.effort}` : "",
    providerWord ? `on ${providerWord}` : "",
    ownSettings ? "" : count(picks.skills.length, "skill"),
    ownSettings ? "" : count(here.length, "server"),
  ].filter(Boolean).join(", ");

  const choose = (l: Loadout) => {
    picked.current = true;
    setName(l.name);
    setPicks(picksOf(l, task.equip));
  };
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await coordPlanEdit(run.id, task.id, { equip });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <aside className="mgr-equip" aria-label={`Equip ${task.id}`}>
      <Head task={task} />
      <div className="mgr-equip-body">
        <section aria-label="loadout">
          <h3>loadout</h3>
          <div className="mgr-equip-row">
            {offered.map((l) => (
              <button key={l.name} type="button" className="mgr-equip-pick" aria-pressed={l.name === loadout.name} onClick={() => choose(l)}>
                {l.name}
              </button>
            ))}
            <button type="button" className="mgr-equip-pick" aria-pressed={false} title="No loadout, not even the one the card would inherit" onClick={() => { picked.current = true; setName(NO_LOADOUT); }}>
              none
            </button>
          </div>
          <p className="mgr-equip-note">{changed ? `Changed from ${loadout.name}. ` : ""}{loadout.note || `The ${loadout.name} loadout.`}{bare ? ` ${bare}` : ""}</p>
        </section>

        <section aria-label="model and effort">
          <h3>model</h3>
          <Segment values={models} on={picks.model} pick={(model) => setPicks({ ...picks, model })} />
          <h3>effort</h3>
          <Segment values={efforts} on={picks.effort} pick={(effort) => setPicks({ ...picks, effort })} />
          {loadout.harness !== "antigravity" && <>
          <h3>provider</h3>
          <div className="mgr-equip-seg">
            <button type="button" aria-pressed={picks.provider === "" || picks.provider === loadout.provider} title={loadout.provider ? "The loadout's provider" : "The provider the repo's route names, if any"} onClick={() => setPicks({ ...picks, provider: "" })}>
              {loadout.provider ?? "the route's"}
            </button>
            <button type="button" aria-pressed={picks.provider === DEFAULT_PROVIDER} title={`${loadout.harness === "codex" ? "Codex" : "Claude Code"}'s own login, with no provider`} onClick={() => setPicks({ ...picks, provider: DEFAULT_PROVIDER })}>
              login
            </button>
            {providers.filter((p) => p.id !== loadout.provider).map((p) => (
              <button key={p.id} type="button" disabled={!p.usable} aria-pressed={picks.provider === p.id} title={p.why || undefined} onClick={() => setPicks({ ...picks, provider: p.id })}>
                {p.id}
              </button>
            ))}
          </div>
          </>}
        </section>

        <section aria-label="skills">
          <h3>
            skills <span className="mgr-equip-count">{ownSettings ? 0 : picks.skills.length}</span>
          </h3>
          {ownSettings ? (
            <p className="mgr-equip-note">{loadout.harness === "codex" ? "A Codex" : "An Antigravity"} worker takes model and effort only.</p>
          ) : (
            <>
              <p className="mgr-equip-note">Only the checked skills load, plus the base skills of the kit. Every other skill stays off for this worker.</p>
              <input type="search" className="mgr-equip-find" aria-label="find a skill" placeholder="find a skill" value={q} onChange={(e) => setQ(e.target.value)} />
              {wordsError && <p className="note err">{wordsError}</p>}
              {words === null && !wordsError && <p className="mgr-equip-note">Reading the skills on this machine.</p>}
              {skills.map((w) => (
                <label key={w.name} className={`mgr-equip-opt${w.locked ? " off" : ""}`} title={w.locked ? "The kit or the loadout turns this skill on" : undefined}>
                  <input type="checkbox" value={w.name} disabled={w.locked} checked={w.on} onChange={() => setPicks({ ...picks, skills: flip(picks.skills, w.name) })} />
                  <span>
                    <span className="mgr-equip-name">{w.name}</span>
                    <span className="mgr-equip-line mgr-equip-desc" title={w.description}>
                      {w.description}
                    </span>
                    {w.plugin && <span className="mgr-equip-line">{w.plugin}</span>}
                  </span>
                </label>
              ))}
              {words !== null && skills.length === 0 && <p className="mgr-equip-note">No skill on this machine matches that.</p>}
            </>
          )}
        </section>

        <section aria-label="servers">
          <h3>
            servers <span className="mgr-equip-count">{ownSettings ? 0 : here.length}</span>
          </h3>
          {ownSettings ? (
            <p className="mgr-equip-note">{loadout.harness === "codex" ? "A Codex" : "An Antigravity"} worker takes model and effort only.</p>
          ) : servers.length === 0 ? (
            <p className="mgr-equip-note">The kit lists no servers a card can take.</p>
          ) : (
            servers.map((s) => (
              <label key={s.name} className={`mgr-equip-opt${s.here ? "" : " off"}`}>
                <input type="checkbox" value={s.name} disabled={!s.here} checked={s.here && picks.mcp.includes(s.name)} onChange={() => setPicks({ ...picks, mcp: flip(picks.mcp, s.name) })} />
                <span>
                  <span className="mgr-equip-name">{s.name}</span>
                  {!s.here && <span className="mgr-equip-line">not on {backend}</span>}
                </span>
              </label>
            ))
          )}
        </section>
      </div>
      <div className="mgr-equip-foot">
        <p className="mgr-equip-summary">{summary}</p>
        {error && <p className="note err">{error}</p>}
        <div className="mgr-equip-row">
          <button type="button" className="mini strong" disabled={busy} onClick={() => void apply()}>
            apply to {task.id}
          </button>
          <button type="button" className="mini" onClick={onDone}>
            cancel
          </button>
        </div>
      </div>
    </aside>
  );
}

function Head({ task }: { task: CoordTask }) {
  return (
    <header className="mgr-equip-head">
      <h2>
        Equip <span className="mgr-equip-name">{task.id}</span>
      </h2>
      <p>
        {task.repo}: {task.title}
      </p>
      <p className="mgr-equip-note">{`A ${task.state === "proposed" ? "proposed" : "queued"} card takes the change when it starts. A worker that has started keeps what it started with.`}</p>
    </header>
  );
}

function Segment({ values, on, pick }: { values: readonly string[]; on: string; pick: (v: string) => void }) {
  return (
    <div className="mgr-equip-seg">
      {values.map((v) => (
        <button key={v} type="button" onClick={() => pick(v)} aria-pressed={v === on}>
          {v}
        </button>
      ))}
    </div>
  );
}
