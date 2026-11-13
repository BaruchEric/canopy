/**
 * The equip sheet (FR-065): a not-yet-started card's loadout and what Eric
 * changes on top of it, model, effort, skills and servers. It sends a whole
 * `CardEquip` (`equipFrom`), the loadout's name plus only the fields that
 * differ, so the server replaces the card's equip with it. A Codex loadout
 * takes model and effort only. Layout follows the Equip mockup.
 */
import { useEffect, useState } from "react";
import { HARNESS } from "../../../src/core/harness";
import type { CardEquip, CoordTask, Loadout, Mention, Run } from "../../../src/core/types";
import { api } from "../api";
import { equipFrom, loadoutsFor } from "../loadouts";
import { backendOf } from "../registry";
import { useStore } from "../store";

interface Picks {
  model: string;
  effort: string;
  skills: string[];
  mcp: string[];
}

/** the loadout's own values, with the card's saved overrides on top when it
 *  was saved against that loadout */
function picksOf(l: Loadout, saved: CardEquip | undefined): Picks {
  const mine = saved?.loadout === l.name ? saved : undefined;
  return { model: mine?.model ?? l.model, effort: mine?.effort ?? l.effort, skills: [...(mine?.skills ?? l.skills)], mcp: [...(mine?.mcp ?? l.mcp)] };
}

const flip = (list: readonly string[], name: string): string[] => (list.includes(name) ? list.filter((x) => x !== name) : [...list, name]);

/** "superpowers" out of a skill's `plugin:superpowers` origin */
const pluginOf = (w: Mention): string | null => (w.plugin && w.from.startsWith("plugin:") ? w.from.slice("plugin:".length) : null);

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function EquipSheet({ run, task, onDone }: { run: Run; task: CoordTask; onDone: () => void }) {
  const backend = backendOf(run.id);
  const info = useStore((s) => s.kit[backend]?.loadouts);
  const coordPlanEdit = useStore((s) => s.coordPlanEdit);
  const offered = loadoutsFor(task.action, info?.loadouts);
  const first = offered.find((l) => l.name === task.equip?.loadout) ?? offered[0];
  const [name, setName] = useState<string | undefined>(first?.name);
  const loadout = offered.find((l) => l.name === name) ?? first;
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

  const codex = loadout.harness === "codex";
  const table = HARNESS[loadout.harness];
  const models = table.models.includes(picks.model) ? table.models : [...table.models, picks.model];
  const efforts = table.efforts.includes(picks.effort as (typeof table.efforts)[number]) ? table.efforts : [...table.efforts, picks.effort as (typeof table.efforts)[number]];
  const skills = (words ?? [])
    .filter((w) => w.kind === "skill" && w.harness === "claude")
    .filter((w) => !q.trim() || `${w.name} ${w.description}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const servers = info?.servers ?? [];
  const equip = equipFrom(loadout, picks);
  const changed = Object.keys(equip).length > 1;
  const summary = [
    loadout.name,
    picks.model !== "default" ? picks.model : "",
    picks.effort !== "default" ? `effort ${picks.effort}` : "",
    codex ? "" : count(picks.skills.length, "skill"),
    codex ? "" : count(picks.mcp.length, "server"),
  ].filter(Boolean).join(", ");

  const choose = (l: Loadout) => {
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
          </div>
          <p className="mgr-equip-note">{changed ? `Changed from ${loadout.name}. ` : ""}{loadout.note || `The ${loadout.name} loadout.`}</p>
        </section>

        <section aria-label="model and effort">
          <h3>model</h3>
          <Segment values={models} on={picks.model} pick={(model) => setPicks({ ...picks, model })} />
          <h3>effort</h3>
          <Segment values={efforts} on={picks.effort} pick={(effort) => setPicks({ ...picks, effort })} />
        </section>

        <section aria-label="skills">
          <h3>
            skills <span className="mgr-equip-count">{codex ? 0 : picks.skills.length}</span>
          </h3>
          {codex ? (
            <p className="mgr-equip-note">A Codex worker takes model and effort only.</p>
          ) : (
            <>
              <p className="mgr-equip-note">Only the checked skills load, plus the base skills of the kit. Every other skill stays off for this worker.</p>
              <input type="search" className="mgr-equip-find" aria-label="find a skill" placeholder="find a skill" value={q} onChange={(e) => setQ(e.target.value)} />
              {wordsError && <p className="note err">{wordsError}</p>}
              {words === null && !wordsError && <p className="mgr-equip-note">Reading the skills on this machine.</p>}
              {skills.map((w) => {
                const plugin = pluginOf(w);
                return (
                  <label key={w.name} className="mgr-equip-opt">
                    <input type="checkbox" value={w.name} checked={picks.skills.includes(w.name)} onChange={() => setPicks({ ...picks, skills: flip(picks.skills, w.name) })} />
                    <span>
                      <span className="mgr-equip-name">{w.name}</span>
                      <span className="mgr-equip-line">{w.description}</span>
                      {plugin && <span className="mgr-equip-line">Checking it turns on the whole {plugin} plugin.</span>}
                    </span>
                  </label>
                );
              })}
              {words !== null && skills.length === 0 && <p className="mgr-equip-note">No skill on this machine matches that.</p>}
            </>
          )}
        </section>

        <section aria-label="servers">
          <h3>
            servers <span className="mgr-equip-count">{codex ? 0 : picks.mcp.length}</span>
          </h3>
          {codex ? (
            <p className="mgr-equip-note">A Codex worker takes model and effort only.</p>
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
      <p className="mgr-equip-note">A queued card takes the change when it starts. A worker that has started keeps what it started with.</p>
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
