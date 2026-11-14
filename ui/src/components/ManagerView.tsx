/**
 * The manager's top view (`?view=manager&run=<coordinator id>`, FR-065):
 * one coordinator's goal from above. The goal's head with hold, add a task
 * and end goal; a ring per card in waves by `after`, the manager's first;
 * what waits on Eric, each item answered in place; a lane per worker with
 * its steps, what it carries and its actions; and the manager's chat,
 * which can speak to one worker instead. `managerRows` (manager.ts) works
 * the rows out; this file draws them and wires the store's actions.
 *
 * Wide, the rings run across the top over a main column beside the chat; a
 * tablet stacks them with the chat last (styles.css); a phone puts what
 * waits on Eric first, the rings in a strip that scrolls sideways, then the
 * workers or the chat.
 */
import { Fragment, useEffect, useMemo, useState, type MouseEvent } from "react";
import { runRepoName } from "../goals";
import { isGoalAnchor } from "../../../src/core/coordinator";
import { isSeedId } from "../../../src/core/sprout";
import type { CoordTask, Loadout, Run } from "../../../src/core/types";
import { durationWord } from "../agentcards";
import { cardCounts } from "../coord";
import { gateButtons, gateWords } from "../flows";
import { scopeOffers } from "../inbox";
import { needsApproval, sentBack } from "../landing";
import { chatAim, goalText, liveCoordinators, managerRows, type Goal, type Lane, type Need, type Ring, type SayTarget, type Tone } from "../manager";
import { PHONE, useMedia } from "../media";
import { backendOf, isHome, plainOf } from "../registry";
import { managerHere, managerNew, managerUrl, openManager } from "../routes";
import { harnessOf } from "../runs";
import { connOf, idParts, idText, landingAll, prsAll, recordsIn, useStore, type CanopyState } from "../store";
import { HoldButton } from "./CoordTasks";
import { EquipSheet } from "./EquipSheet";
import { GoalComposer } from "./GoalComposer";
import { RunPromptForm } from "./Prompts";
import { useNow } from "./Registry";
import { RunPane } from "./RunSheet";

/** a write from the page: its error shows under the head, and `propagate`
 *  throws it on so a form keeps what was typed */
type Act = (fn: () => Promise<void>, propagate?: boolean) => Promise<void>;

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

const NO_LOADOUTS: readonly Loadout[] = [];

/** the address's query; a test or a server render may have no location */
const search = (): string => (typeof location === "undefined" ? "" : location.search);

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The limits the server holds a card to (core/coordinator.ts), as CoordTasks' form. */
const TITLE_MAX = 120;
const NOTE_MAX = 4000;

/**
 * The view: the goal the address names, or the goals going to pick from
 * under the new goal's box. With no goal named and one going, that one
 * opens and the address names it, once every backend has sent its runs or
 * is known to be away, unless the address asks for a new goal (`new=1`). A goal
 * the page does not hold is called ended only when its backend's runs are
 * in; while they are on their way, or the backend is offline, asks for a
 * sign-in or is hidden, the view says that instead. One the page holds
 * that ended still shows its rows, whose landings may yet wait on Eric.
 */
export function ManagerView() {
  const [runId, setRunId] = useState(() => managerHere(search()));
  // the address asks for a new goal: the box is focused and the one goal going does not open
  const [fresh, setFresh] = useState(() => managerNew(search()));
  useEffect(() => {
    const pop = () => {
      setRunId(managerHere(search()));
      setFresh(managerNew(search()));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const runs = useStore((s) => s.runs);
  const live = useMemo(() => liveCoordinators(runs), [runs]);
  const named = runId ? runs[runId] : undefined;
  const coord = named?.action === "coordinate" ? named : undefined;
  const on = runId === null ? "" : idParts(runId)[0];
  // where the named run's backend stands, read only while the page lacks the run
  const where = useStore((s) => (runId !== null && !s.runs[runId] ? reachOf(s, on) : "here"));
  // the backends still sending their runs, and those kept from this page
  // before any came, as words; one that dropped after loading still lists
  // the goals it last sent, so it is not called missing
  const waiting = useStore((s) => s.backendOrder.filter((b) => reachOf(s, b) === "loading").join(" "));
  const away = useStore((s) => s.backendOrder.filter((b) => isAway(reachOf(s, b)) && !recordsIn(s, b)).join(" "));
  const onlyId = runId === null && !fresh && waiting === "" && live.length === 1 ? live[0]?.id : undefined;
  useEffect(() => {
    if (!onlyId) return;
    history.replaceState(null, "", managerUrl(onlyId));
    setRunId(onlyId);
  }, [onlyId]);
  const shown = coord ?? (onlyId ? runs[onlyId] : undefined);
  if (shown) return <GoalView key={shown.id} coord={shown} />;
  const why: Why = runId === null ? "none" : named ? "not a goal" : where === "here" ? "ended" : where;
  // a backend the heading names already is not named again below it
  const others = (words: string): string[] => words.split(" ").filter((b) => b !== "" && (why === "none" || b !== on));
  return <GoalPicker live={live} why={why} on={on} waiting={others(waiting)} away={others(away)} fresh={fresh} />;
}

/** Where a backend stands for this view: its runs in ("here"), on their
 *  way, kept from this page (offline, asking for a sign-in, or behind the
 *  browser's local network permission), or hidden. A backend that drops
 *  after loading counts as away, so a goal it held waits for it rather than
 *  reading as ended. */
type Reach = "here" | "loading" | "offline" | "signin" | "permission" | "hidden";

function reachOf(s: CanopyState, b: string): Reach {
  if (b !== s.home && !s.backendOrder.includes(b)) return "hidden";
  const state = connOf(s, b).status.state;
  if (state === "offline" || state === "signin" || state === "permission") return state;
  if (recordsIn(s, b)) return "here";
  // canopy's own caller check refused this page's token: the backend
  // answered, so it reads online, and its runs wait on a sign-in
  const auth = s.authByBackend[b];
  return auth && (auth.needed || (auth.mode === "enforce" && auth.you === "none")) ? "signin" : "loading";
}

const isAway = (r: Reach): boolean => r === "offline" || r === "signin" || r === "permission";

/** Why the picker shows instead of a goal. */
type Why = "none" | "ended" | "not a goal" | Exclude<Reach, "here">;

/** What the picker says of a goal whose backend it is waiting for, after
 *  "This goal is on <backend>, ". */
const WAIT_WORDS: Record<Exclude<Reach, "here">, string> = {
  loading: "which is still sending its runs.",
  offline: "which is not answering; its page waits for it.",
  signin: "which asks you to sign in; its page waits for that.",
  permission: "which this browser cannot reach until you allow local network access.",
  hidden: "which this page hides.",
};

/** backend names as a phrase: "a", "a and b", "a, b and c" */
const names = (list: readonly string[]): string => (list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/** a link that opens a goal (or the new goal's box) in place, and in a new tab when asked to */
function follow(e: MouseEvent, runId: string | null, opts?: { new?: true }): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openManager(runId, opts);
}

function GoalPicker({ live, why, on, waiting, away, fresh }: { live: Run[]; why: Why; on: string; waiting: string[]; away: string[]; fresh: boolean }) {
  const now = useNow();
  const phone = useMedia(PHONE);
  const heading = why === "ended" ? "This goal has ended" : why === "none" || why === "not a goal" || why === "hidden" ? "Pick a goal" : `Waiting for ${on}`;
  return (
    <main className={`mgr-view mgr-pick${phone ? " phone" : ""}`}>
      <h1 className="mgr-goal-text">{heading}</h1>
      {why === "ended" && <p className="mgr-sub">canopy no longer holds that coordinator. The goals going now are below.</p>}
      {why === "not a goal" && <p className="mgr-sub">That run is not a coordinator.</p>}
      {why !== "none" && why !== "ended" && why !== "not a goal" && (
        <p className="mgr-sub">
          This goal is on {on}, {WAIT_WORDS[why]}
        </p>
      )}
      {waiting.length > 0 && <p className="mgr-sub">Looking for goals on {names(waiting)}…</p>}
      {away.length > 0 && (
        <p className="mgr-sub">
          Goals on {names(away)} are not listed until this page reaches {away.length === 1 ? "it" : "them"}.
        </p>
      )}
      <GoalComposer autoFocus={fresh} />
      {live.length === 0 ? (
        waiting.length === 0 && <p className="mgr-empty">No coordinator is running.</p>
      ) : (
        <ul className="mgr-goals">
          {live.map((c) => (
            <li key={c.id}>
              <a className="mgr-goal-row" href={managerUrl(c.id)} onClick={(e) => follow(e, c.id)}>
                <span className="mgr-goal-name">{goalText(c)}</span>
                <span className="mgr-goal-facts">
                  {(c.tasks ?? []).length > 0 ? cardCounts(c.tasks ?? []) : "no cards yet"} · started {durationWord(now - c.startedAt)} ago
                  {isHome(c.id) ? "" : ` · on ${backendOf(c.id)}`}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

type PhoneView = "workers" | "chat";
const PHONE_VIEWS: readonly PhoneView[] = ["workers", "chat"];

/** a lane's element id, for a ring to bring it into view */
const laneDom = (cardId: string): string => `mgr-lane-${cardId}`;

function GoalView({ coord }: { coord: Run }) {
  const phone = useMedia(PHONE);
  const runs = useStore((s) => s.runs);
  const flows = useStore((s) => s.flows);
  const landing = useStore(landingAll);
  const prs = useStore(prsAll);
  const loadouts = useStore((s) => s.kit[backendOf(coord.id)]?.loadouts?.loadouts) ?? NO_LOADOUTS;
  const rows = useMemo(() => managerRows(coord, { runs, flows, landing, prs, loadouts }), [coord, runs, flows, landing, prs, loadouts]);
  // the ring and lane picked: a card's id, or "manager" for the chat
  const [picked, setPicked] = useState<string | null>(null);
  // the card whose equip sheet is open
  const [equipping, setEquipping] = useState<string | null>(null);
  const [view, setView] = useState<PhoneView>("workers");
  const [error, setError] = useState<string | null>(null);
  const act: Act = async (fn, propagate = false) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
      if (propagate) throw err;
    }
  };
  const pick = (id: string) => {
    setPicked(id);
    if (phone) setView(id === "manager" ? "chat" : "workers");
    // once the phone's switch has drawn it
    requestAnimationFrame(() => document.getElementById(id === "manager" ? "mgr-chat" : laneDom(id))?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const head = <GoalHead coord={coord} goal={rows.goal} act={act} />;
  const err = error && (
    <p className="note err mgr-error" role="alert">
      {error}
    </p>
  );
  const needs = <Needs coord={coord} needs={rows.needs} act={act} />;
  const rings = <Rings tasks={coord.tasks ?? []} rings={rows.rings} picked={picked} onPick={pick} />;
  const workers = <Workers coord={coord} lanes={rows.lanes} picked={picked} equipping={equipping} onEquip={setEquipping} onPick={setPicked} act={act} hidden={phone && view !== "workers"} />;
  // keyed by the goal: a card id like t1 names a different card in each goal
  const chat = <Chat key={coord.id} coord={coord} lanes={rows.lanes} on={picked === "manager"} hidden={phone && view !== "chat"} />;
  const equipTask = equipping ? (coord.tasks ?? []).find((t) => t.id === equipping) : undefined;
  const equipLane = equipTask ? rows.lanes.find((l) => l.id === equipTask.id) : undefined;
  const sheet = equipTask && equipLane?.canEquip ? <EquipSheet key={equipTask.id} run={coord} task={equipTask} onDone={() => setEquipping(null)} /> : null;
  if (phone) {
    return (
      <main className="mgr-view phone">
        {head}
        {err}
        {needs}
        {rings}
        <div className="mgr-switch" role="group" aria-label="Show">
          {PHONE_VIEWS.map((v) => (
            <button key={v} type="button" className={`mini${view === v ? " on" : ""}`} aria-pressed={view === v} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
        {workers}
        {chat}
        {sheet}
      </main>
    );
  }
  return (
    <main className="mgr-view">
      {head}
      {err}
      {rings}
      <div className="mgr-cols">
        <div className="mgr-main">
          {needs}
          {workers}
        </div>
        {chat}
      </div>
      {sheet}
    </main>
  );
}

/* ---------- the goal's head ---------- */

function GoalHead({ coord, goal, act }: { coord: Run; goal: Goal; act: Act }) {
  const now = useNow();
  const stopRun = useStore((s) => s.stopRun);
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState(false);
  // a second press soon after ends the goal; otherwise the button goes back
  useEffect(() => {
    if (!ending) return;
    const t = setTimeout(() => setEnding(false), 4000);
    return () => clearTimeout(t);
  }, [ending]);
  const going = !goal.ended;
  return (
    <header className="mgr-head">
      <div className="mgr-goal">
        <h1 className="mgr-goal-text" title={goal.text}>
          {goal.text}
        </h1>
        <p className="mgr-facts">
          <span>
            manager on {goal.model ?? "the default model"}
            {goal.effort ? `, ${goal.effort} effort` : ""}
          </span>
          {!isHome(coord.id) && <span>on {backendOf(coord.id)}</span>}
          <span>started {durationWord(now - goal.startedAt)} ago</span>
          <span className="sky">{goal.working} working</span>
          <span className="lichen">
            {goal.waiting} {goal.waiting === 1 ? "waits" : "wait"} on you
          </span>
        </p>
        {isGoalAnchor(coord.repoId) && <p className="mgr-top">goal from the top</p>}
      </div>
      {going && (
        <div className="mgr-head-acts">
          <HoldButton run={coord} act={act} />
          <button type="button" className="mini" aria-expanded={adding} title="Put a card of your own in this goal's plan" onClick={() => setAdding(!adding)}>
            add a task
          </button>
          <a className="mini" href={managerUrl(null, { new: true })} title="Start another goal from the top" onClick={(e) => follow(e, null, { new: true })}>
            new goal
          </a>
          <button
            type="button"
            className={`mini mgr-end${ending ? " on" : ""}`}
            title={ending ? "Stops the coordinator; its cards already running go on" : "Stop the coordinator. A second press ends it"}
            onClick={() => (ending ? void act(() => stopRun(coord.id)) : setEnding(true))}
            onBlur={() => setEnding(false)}
          >
            {ending ? "press again to end" : "end goal"}
          </button>
        </div>
      )}
      {going && goal.held && <p className="mgr-held">Held. Running workers go on, and no new card starts until you resume.</p>}
      {goal.ended && (
        <p className="mgr-ended">
          This goal has ended.{" "}
          <a href={managerUrl(null)} onClick={(e) => follow(e, null)}>
            the goals going
          </a>
        </p>
      )}
      {going && adding && <AddTask coord={coord} act={act} onDone={() => setAdding(false)} />}
    </header>
  );
}

/** A card of Eric's own for the plan (`coordAdd`): a title, a repo of the
 *  coordinator's backend's own checkouts, what the run is told and what it
 *  does. It joins as proposed, like the manager's. */
function AddTask({ coord, act, onDone }: { coord: Run; act: Act; onDone: () => void }) {
  const coordAdd = useStore((s) => s.coordAdd);
  const repos = useStore((s) => s.repos);
  const backend = backendOf(coord.id);
  const choices = useMemo(() => repos.filter((r) => backendOf(r.id) === backend && !r.host && !r.forge && !isSeedId(r.id)), [repos, backend]);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState(() => (choices.some((r) => r.id === coord.repoId) ? coord.repoId : (choices[0]?.id ?? "")));
  const [note, setNote] = useState("");
  const [action, setAction] = useState<CoordTask["action"]>("ask");
  const [busy, setBusy] = useState(false);
  const ok = title.trim() !== "" && note.trim() !== "" && repo !== "";
  const add = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      await act(() => coordAdd(coord.id, { title: title.trim(), repo, note: note.trim(), action }), true);
      onDone();
    } catch {
      // the error shows under the head; the form keeps what was typed
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mgr-add coord-form">
      <input type="text" className="settings-input" value={title} maxLength={TITLE_MAX} placeholder="title" aria-label="Card title" onChange={(e) => setTitle(e.target.value)} />
      <div className="coord-form-row">
        <select className="settings-input" value={repo} aria-label="Repo" onChange={(e) => setRepo(e.target.value)}>
          {repo === "" && <option value="">pick a repo</option>}
          {choices.map((r) => (
            <option key={r.id} value={r.id}>
              {plainOf(r.id)}
            </option>
          ))}
        </select>
        <select className="settings-input" value={action} aria-label="What the run does" onChange={(e) => setAction(e.target.value === "propose" ? "propose" : "ask")}>
          <option value="ask">ask</option>
          <option value="propose">plan, then build</option>
        </select>
      </div>
      <textarea
        className="plan-note"
        rows={4}
        value={note}
        maxLength={NOTE_MAX}
        placeholder="what the run is told; it sees nothing else"
        aria-label="What the run is told"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add();
        }}
      />
      <div className="coord-actions">
        <span className="spacer" />
        <button type="button" className="mini" onClick={onDone}>
          cancel
        </button>
        <button type="button" className="mini strong" disabled={!ok || busy} title="⌘↩" onClick={() => void add()}>
          {busy ? "adding…" : "add"}
        </button>
      </div>
    </div>
  );
}

/* ---------- the rings ---------- */

const R = 42;
const GAP = 4;

/** One arc of a ring of `n`, clockwise from the top: its share of the
 *  circle less a 4 degree gap, on a 100 by 100 box. */
export function arcPath(i: number, n: number): string {
  const share = 360 / n;
  const from = i * share;
  const to = from + share - Math.min(GAP, share / 2);
  const at = (deg: number): string => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(50 + R * Math.cos(a)).toFixed(2)} ${(50 + R * Math.sin(a)).toFixed(2)}`;
  };
  return `M ${at(from)} A ${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${at(to)}`;
}

/** "after t1, t2": what a wave's cards wait for among the goal's cards */
function afterWords(rings: readonly Ring[], tasks: readonly CoordTask[]): string {
  const here = new Set(tasks.map((t) => t.id));
  const ids = new Set(rings.flatMap((r) => tasks.find((t) => t.id === r.id)?.after ?? []).filter((id) => here.has(id)));
  return ids.size > 0 ? `after ${[...ids].join(", ")}` : "";
}

/** The manager's ring, then the cards' in waves by `after`, each wave
 *  after a line naming what it waits for. A ring picks its lane. */
function Rings({ tasks, rings, picked, onPick }: { tasks: readonly CoordTask[]; rings: readonly Ring[]; picked: string | null; onPick: (id: string) => void }) {
  const [manager, ...cards] = rings;
  const waves = [...new Set(cards.map((r) => r.wave))].sort((a, b) => a - b).map((wave) => ({ wave, rings: cards.filter((r) => r.wave === wave) }));
  return (
    <section className="mgr-rings" aria-label="rings">
      <div className="mgr-ring-row">
        {manager && <RingButton ring={manager} on={picked === manager.id} onPick={onPick} />}
        {waves.map(({ wave, rings: these }) => (
          <Fragment key={wave}>
            {wave === 0 ? <span className="mgr-wave" aria-hidden="true" /> : <span className="mgr-wave">{afterWords(these, tasks)}</span>}
            {these.map((r) => (
              <RingButton key={r.id} ring={r} on={picked === r.id} onPick={onPick} />
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function RingButton({ ring, on, onPick }: { ring: Ring; on: boolean; onPick: (id: string) => void }) {
  const where = ring.repo ? idText(ring.repo) : "the goal";
  return (
    <button type="button" className={`mgr-ring ${ring.tone}${on ? " on" : ""}`} aria-pressed={on} aria-label={`${ring.id}, ${where}, ${ring.word}`} title={ring.title} onClick={() => onPick(ring.id)}>
      <span className="mgr-dial">
        <svg className="mgr-arcs" viewBox="0 0 100 100" aria-hidden="true">
          {ring.arcs.length === 0 ? (
            <circle className="mgr-arc hair" cx="50" cy="50" r={R} />
          ) : (
            ring.arcs.map((a, i) => <path key={`${i}:${a.label}`} className={`mgr-arc ${a.tone}`} d={arcPath(i, ring.arcs.length)} />)
          )}
        </svg>
        <span className="mgr-at">{ring.at ?? ""}</span>
      </span>
      <span className="mgr-ring-id">{ring.id}</span>
      <span className="mgr-ring-repo">{ring.repo ? plainOf(ring.repo) : "the goal"}</span>
      <span className={`mgr-word ${ring.tone}`}>{ring.word}</span>
      <span className="mgr-ring-model">{ring.model ?? "default model"}</span>
    </button>
  );
}

/* ---------- needs you ---------- */

function Needs({ coord, needs, act }: { coord: Run; needs: readonly Need[]; act: Act }) {
  return (
    <section className="mgr-needs" aria-label="needs you">
      <h2 className="mgr-h">
        needs you <span className="mgr-count">{needs.length}</span>
      </h2>
      {needs.length === 0 ? (
        <p className="mgr-empty">Nothing waits on you.</p>
      ) : (
        <ul className="mgr-need-list">
          {needs.map((n) => (
            <li key={n.key} className="mgr-need">
              <div className="mgr-need-text">
                <span className="mgr-who">{n.who}</span>
                <span className="mgr-what">{n.what}</span>
                {/* a prompt's form says it whole */}
                {n.kind !== "prompt" && n.detail && <p className="mgr-detail">{n.detail}</p>}
              </div>
              {n.kind === "prompt" ? (
                <PromptAnswer need={n} act={act} />
              ) : n.kind === "gate" ? (
                <GateAnswer need={n} act={act} />
              ) : n.kind === "landing" ? (
                <LandingAnswer need={n} act={act} />
              ) : (
                <div className="mgr-need-acts">
                  <button type="button" className="mini strong" title="Every proposed card joins the queue; at most 3 run at once" onClick={() => void act(() => useStore.getState().coordStart(coord.id))}>
                    start these
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A worker's or the manager's prompt, answered as its run sheet answers it. */
function PromptAnswer({ need, act }: { need: Need; act: Act }) {
  const run = useStore((s) => (need.runId ? s.runs[need.runId] : undefined));
  const repo = useStore((s) => s.repos.find((r) => r.id === run?.repoId));
  const repoWord = useStore((s) => (run ? runRepoName(s.repos, run.repoId) : ""));
  const answerRun = useStore((s) => s.answerRun);
  const prompt = need.prompt;
  if (!run || !prompt) return null;
  const local = repo && !repo.host ? repo : undefined;
  return (
    <RunPromptForm
      key={prompt.id}
      prompt={prompt}
      harness={harnessOf(run)}
      repoId={run.repoId}
      onAnswer={(a, promptId) => void act(() => answerRun(run.id, promptId, a))}
      {...(local ? { root: local.path } : {})}
      scopes={scopeOffers({ ...(run.flowStep ? { flowStep: run.flowStep } : {}), repo: repoWord, ...(local ? { repoPath: local.path } : {}) })}
    />
  );
}

/** A card's flow parked at a gate: the gate's own buttons, and stop here. */
function GateAnswer({ need, act }: { need: Need; act: Act }) {
  const flow = useStore((s) => (need.flowId ? s.flows[need.flowId] : undefined));
  const resumeFlow = useStore((s) => s.resumeFlow);
  if (!flow) return null;
  return (
    <div className="mgr-need-acts">
      {gateButtons(gateWords(flow)).map((b) => (
        <button key={b.choice} type="button" className={b.strong ? "mini strong" : "mini"} title={b.title} onClick={() => void act(() => resumeFlow(flow.id, b.choice))}>
          {b.word}
        </button>
      ))}
      <button type="button" className="mini" onClick={() => void act(() => resumeFlow(flow.id, "stop"))}>
        stop here
      </button>
    </div>
  );
}

/** A card's branch the queue leaves to Eric, told apart by what the queue
 *  holds of it: a ready one lands (through the approve sheet when its
 *  sort wants a look) or goes back with a note as a follow-up run; one sent
 *  back is fixed; one waiting on the judge lands anyway. Drop stays in the
 *  landing view. One action at a time, as the landing view's buttons: a
 *  double tap on a phone sends one request. */
function LandingAnswer({ need, act }: { need: Need; act: Act }) {
  const landing = useStore(landingAll);
  const landRun = useStore((s) => s.landRun);
  const showApprove = useStore((s) => s.showApprove);
  const fixLanding = useStore((s) => s.fixLanding);
  const followUp = useStore((s) => s.followUp);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  // the action going: "land", "fix" or "send"
  const [busy, setBusy] = useState<string | null>(null);
  const id = need.landingId;
  if (!id) return null;
  const rec = landing.runs.find((r) => r.id === id);
  const entry = landing.entries.find((e) => e.id === id);
  const once = async (key: string, fn: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(key);
    try {
      await act(fn);
    } finally {
      setBusy(null);
    }
  };
  if (need.canLand) {
    const send = async () => {
      const words = note.trim();
      if (!words || busy !== null) return;
      setBusy("send");
      try {
        await act(() => followUp(id, words), true);
        setSending(false);
        setNote("");
      } catch {
        // the error shows under the head; the note stays
      } finally {
        setBusy(null);
      }
    };
    return (
      <>
        <div className="mgr-need-acts">
          {rec && needsApproval(rec) ? (
            <button type="button" className="mini strong" disabled={busy !== null} title="Open its sensitive files and their diffs, then approve and land" onClick={() => showApprove(id)}>
              look and land
            </button>
          ) : (
            <button type="button" className="mini strong" disabled={busy !== null} title="Rebase onto its target, run the gates, fast-forward the target" onClick={() => void once("land", () => landRun(id))}>
              {busy === "land" ? "queueing…" : "land"}
            </button>
          )}
          <button type="button" className={sending ? "mini on" : "mini"} aria-expanded={sending} title="Start a run on its branch with your note" onClick={() => setSending(!sending)}>
            send back
          </button>
        </div>
        {sending && (
          <div className="mgr-say">
            <textarea
              className="plan-note"
              rows={2}
              value={note}
              placeholder="what to change; a run on its branch starts with this"
              aria-label="What to change"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <button type="button" className="mini strong" disabled={!note.trim() || busy !== null} title="⌘↩" onClick={() => void send()}>
              {busy === "send" ? "sending…" : "send it back"}
            </button>
          </div>
        )}
      </>
    );
  }
  if (entry && sentBack(entry)) {
    return (
      <div className="mgr-need-acts">
        <button type="button" className="mini strong" disabled={busy !== null} title="Continue the run on its branch with the reason as its next message" onClick={() => void once("fix", () => fixLanding(id))}>
          {busy === "fix" ? "starting…" : "fix it"}
        </button>
      </div>
    );
  }
  if (entry?.state === "judge") {
    return (
      <div className="mgr-need-acts">
        <button type="button" className="mini strong" disabled={busy !== null} title="Land it with its judge scenarios left out; its command scenarios ran and passed" onClick={() => void once("land", () => landRun(id, undefined, true))}>
          {busy === "land" ? "queueing…" : "land anyway"}
        </button>
      </div>
    );
  }
  return null;
}

/* ---------- the workers ---------- */

/** a lane's steps in the flow sheet's strip, by the step state each tone stands for */
const TONE_STEP: Record<Tone, string> = { sky: "st-running", lichen: "st-gated", moss: "st-passed", rust: "st-failed", hair: "st-pending" };

/** Where a worker's words go: into the run at work, or a follow-up run on
 *  its settled branch. Hook-free, so a send reads the store as it goes. */
function sayWith(say: SayTarget, text: string): Promise<void> {
  const s = useStore.getState();
  switch (say.kind) {
    case "steer":
      return s.sayRun(say.runId, text);
    case "followup":
      return s.followUp(say.landingId, text);
    case "none":
      return Promise.reject(new Error(say.why));
  }
}

function sayHint(lane: Lane): string {
  switch (lane.say.kind) {
    case "steer":
      return `say to ${lane.id}; it reads this at its next step`;
    case "followup":
      return `say to ${lane.id}; a run on its branch starts with this`;
    case "none":
      return `${lane.id} takes no words now: ${lane.say.why}`;
  }
}

function Workers({
  coord,
  lanes,
  picked,
  equipping,
  onEquip,
  onPick,
  act,
  hidden,
}: {
  coord: Run;
  lanes: readonly Lane[];
  picked: string | null;
  equipping: string | null;
  onEquip: (cardId: string | null) => void;
  onPick: (cardId: string) => void;
  act: Act;
  hidden: boolean;
}) {
  return (
    <section className="mgr-workers" aria-label="workers" hidden={hidden}>
      <h2 className="mgr-h">
        workers <span className="mgr-count">{lanes.length}</span>
      </h2>
      {lanes.length === 0 && <p className="mgr-empty">No cards yet. The manager proposes them as it plans.</p>}
      {lanes.map((l) => (
        <LaneRow key={l.id} coord={coord} lane={l} on={picked === l.id} equipping={equipping === l.id} onEquip={onEquip} onPick={onPick} act={act} />
      ))}
    </section>
  );
}

function LaneRow({ coord, lane, on, equipping, onEquip, onPick, act }: { coord: Run; lane: Lane; on: boolean; equipping: boolean; onEquip: (cardId: string | null) => void; onPick: (cardId: string) => void; act: Act }) {
  const now = useNow();
  const endedAt = useStore((s) => (lane.flowId ? s.flows[lane.flowId]?.endedAt : lane.runId ? s.runs[lane.runId]?.endedAt : undefined));
  const flowStopped = useStore((s) => (lane.flowId ? s.flows[lane.flowId]?.status === "stopped" : false));
  const [saying, setSaying] = useState(false);
  const { runId, flowId } = lane;
  const stop = () => {
    const s = useStore.getState();
    return flowId ? s.stopFlow(flowId) : runId ? s.stopRun(runId) : Promise.resolve();
  };
  // a stopped flow is picked up; a stopped run follows up on its branch with no words
  const resume = () => {
    const s = useStore.getState();
    if (flowId && flowStopped) return s.pickUpFlow(flowId);
    return lane.say.kind === "followup" ? s.followUp(lane.say.landingId) : Promise.resolve();
  };
  const open = () => {
    const s = useStore.getState();
    if (flowId) s.showFlow(flowId);
    else if (runId) s.showRun(runId);
  };
  return (
    <article className={`mgr-lane${on ? " on" : ""}`} id={laneDom(lane.id)} aria-label={`${lane.id}: ${lane.title}`}>
      <div className="mgr-lane-head">
        <span className={`mgr-dot ${lane.tone}`} aria-hidden="true" />
        <span className="mgr-lane-id">{lane.id}</span>
        <button type="button" className="mgr-lane-title" onClick={() => onPick(lane.id)}>
          {lane.title}
        </button>
        <span className={`mgr-word ${lane.tone}`}>{lane.word}</span>
        <span className="mgr-lane-facts">
          <span className="mono" title={idText(lane.repo)}>
            {plainOf(lane.repo)}
          </span>
          {lane.branch && <span className="mono">{lane.branch}</span>}
          {lane.startedAt !== null && <span>{durationWord((endedAt ?? now) - lane.startedAt)}</span>}
        </span>
      </div>
      {lane.live && <p className="mgr-live">{lane.live}</p>}
      {lane.steps.length > 0 && (
        <ol className="step-strip mgr-steps" aria-label="Steps">
          {lane.steps.map((s, i) => (
            <li key={`${i}:${s.label}`}>
              <span className={`step-seg ${TONE_STEP[s.tone]}`} title={s.label}>
                <span className="dot" />
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="mgr-lane-foot">
        <span className="mgr-chips" title={lane.equipTitle || undefined}>
          <span className="mgr-chip">
            {lane.model ?? "default model"}
            {lane.effort ? `, ${lane.effort} effort` : ""}
          </span>
          <span className="mgr-chip">{plural(lane.skills, "skill")}</span>
          <span className="mgr-chip">{plural(lane.servers, "server")}</span>
          {lane.files && (
            <span className="mgr-chip mgr-files" title={lane.files}>
              {lane.files}
            </span>
          )}
          {lane.loadout && (
            <span className="mgr-loadout">
              loadout <span className="mono">{lane.loadout}</span>
            </span>
          )}
        </span>
        <span className="mgr-acts">
          <button type="button" className="mini" aria-expanded={saying} onClick={() => setSaying(!saying)}>
            say
          </button>
          {lane.canEquip && (
            <button type="button" className="mini" aria-pressed={equipping} title="Pick its loadout, model, effort, skills and servers before it starts" onClick={() => onEquip(equipping ? null : lane.id)}>
              equip
            </button>
          )}
          {lane.canStop && (
            <button type="button" className="mini" title={flowId ? "Stop its flow; pick it up again later" : "Stop its run; its branch stays"} onClick={() => void act(stop)}>
              stop
            </button>
          )}
          {lane.canResume && (
            <button type="button" className="mini" title={flowId && flowStopped ? "Pick its flow up where it stopped" : "Start a run on its branch where this one stopped"} onClick={() => void act(resume)}>
              resume
            </button>
          )}
          {lane.canStartNow && (
            <button type="button" className="mini" title="Queue this card alone, ahead of the rest" onClick={() => void act(() => useStore.getState().coordStart(coord.id, [lane.id]))}>
              start now
            </button>
          )}
          {(runId || flowId) && (
            <button type="button" className="mini" title={flowId ? "Open its flow" : "Open its run"} onClick={open}>
              open run
            </button>
          )}
        </span>
      </div>
      {saying && <SayBox lane={lane} act={act} onDone={() => setSaying(false)} />}
    </article>
  );
}

/** A lane's say box: the words go where the lane's say target says, and a
 *  lane that takes none shows why in the box it disables. */
function SayBox({ lane, act, onDone }: { lane: Lane; act: Act; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const say = lane.say;
  const shut = say.kind === "none";
  const send = async () => {
    const words = text.trim();
    if (!words || busy || shut) return;
    setBusy(true);
    try {
      await act(() => sayWith(say, words), true);
      setText("");
      onDone();
    } catch {
      // the error shows under the head; the words stay
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mgr-say">
      <textarea
        className="plan-note"
        rows={2}
        value={text}
        disabled={shut}
        placeholder={sayHint(lane)}
        aria-label={`Say to ${lane.id}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
        }}
      />
      <button type="button" className="mini strong" disabled={shut || !text.trim() || busy} title="⌘↩" onClick={() => void send()}>
        {busy ? "sending…" : "send"}
      </button>
    </div>
  );
}

/* ---------- the manager's chat ---------- */

/** The coordinator's chat, with a switch for whom the box speaks to: the
 *  manager, or one worker that takes words now (its lane's say target). A
 *  picked worker that stops taking words stays picked and refuses the send
 *  with why (`chatAim`), so a draft never goes to the manager unasked. */
function Chat({ coord, lanes, on, hidden }: { coord: Run; lanes: readonly Lane[]; on: boolean; hidden: boolean }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === coord.repoId));
  const [to, setTo] = useState("");
  const { options, lane, shut } = chatAim(lanes, to);
  return (
    <aside className={`mgr-chat${on ? " on" : ""}`} id="mgr-chat" aria-label="manager chat" hidden={hidden}>
      <div className="mgr-chat-head">
        <h2 className="mgr-h">manager</h2>
        {options.length > 0 && (
          <label className="mgr-to">
            to
            <select className="settings-input" value={lane ? lane.id : ""} aria-label="Whom the box speaks to" onChange={(e) => setTo(e.target.value)}>
              <option value="">the manager</option>
              {options.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.id}: {l.title}
                  {l.say.kind === "none" ? " (takes no words now)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {shut && (
        <p className="note err mgr-chat-shut" role="status">
          {shut}
        </p>
      )}
      <RunPane run={coord} repo={repo} {...(lane ? { onSend: (text: string) => (shut ? Promise.reject(new Error(shut)) : sayWith(lane.say, text)), hint: shut ?? sayHint(lane) } : {})} />
    </aside>
  );
}
