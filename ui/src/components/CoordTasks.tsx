import { useEffect, useRef, useState } from "react";
import { isSeedId } from "../../../src/core/sprout";
import { isRunActive, type CoordTask, type Run } from "../../../src/core/types";
import { canStartCards, cardCarries, cardCounts, cardDraft, cardEdit, cardStatus, parentCard, type CardDraft, type CoordView, chainWords } from "../coord";
import { groupReviews } from "../groups";
import { loadoutLabel, loadoutsFor } from "../loadouts";
import { ciChip, prLine } from "../prs";
import { backendOf, plainOf } from "../registry";
import { idText, landingAll, prsAll, useStore } from "../store";
import { useMentions } from "./Mentions";

/** a run-sheet write: its error shows in the sheet, and `propagate` throws
 *  it on so the caller can keep its form open */
type Act = (fn: () => Promise<void>, propagate?: boolean) => Promise<void>;

const ACTION_WORD: Record<CoordTask["action"], string> = {
  propose: "plan, then build",
  ask: "ask",
};

/** The limits the server holds a card to (core/coordinator.ts). */
const TITLE_MAX = 120;
const NOTE_MAX = 4000;

/** How the cards block sits in the sheet. On a phone the sheet shows the
 *  cards or the chat, and the block's head switches between them; wider,
 *  the block sits under the timeline and folds to its head. */
export type CoordLayout =
  | { kind: "phone"; view: CoordView; onView: (view: CoordView) => void }
  | { kind: "wide"; folded: boolean; onFold: (folded: boolean) => void };

const VIEWS: readonly CoordView[] = ["cards", "chat"];

/**
 * A coordinator's cards (FR-010), above its composer: each card's title,
 * repo, note and state, what it carries (its loadout, workflow and the
 * cards it waits for), an edit form and remove while it is proposed or
 * queued, start on a proposed one, and once it started, its child's newest
 * step, landing word or PR and a link to the child's sheet, or to its flow's
 * for a card that runs a workflow as a flow. The head holds
 * or resumes the goal while the coordinator is going, and "start these"
 * shows while any card is proposed. Showing only its head, the list stays
 * mounted, so an open edit form keeps what was typed. `error` is the
 * sheet's, for the phone's cards view, where the timeline that shows it is
 * gone.
 */
export function CoordTasks({ run, act, layout, error = null }: { run: Run; act: Act; layout: CoordLayout; error?: string | null }) {
  const coordStart = useStore((s) => s.coordStart);
  const tasks = run.tasks ?? [];
  const active = !run.kept && isRunActive(run);
  if (tasks.length === 0 && !active) return null;
  const headOnly = layout.kind === "phone" ? layout.view === "chat" : layout.folded;
  const fill = layout.kind === "phone" && layout.view === "cards";
  return (
    <section className={`coord-tasks${layout.kind === "phone" ? " phone" : ""}${fill ? " fill" : ""}`} aria-label="The coordinator's cards">
      <div className="coord-head">
        <span className="coord-count">{tasks.length ? cardCounts(tasks) : "No cards yet. The coordinator proposes them here."}</span>
        {active && run.held && (
          <span className="coord-chip lichen" title="No card starts until you resume; cards already running go on">
            held
          </span>
        )}
        <span className="spacer" />
        {active && <HoldButton run={run} act={act} />}
        {!run.kept && canStartCards(run) && (
          <button
            type="button"
            className="mini strong"
            title="Every proposed card joins the queue; at most 3 run at once, each a branch run in its repo"
            onClick={() => void act(() => coordStart(run.id))}
          >
            start these
          </button>
        )}
        {layout.kind === "phone" ? (
          <div className="coord-views" role="group" aria-label="Show">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                className={`mini${layout.view === v ? " on" : ""}`}
                aria-pressed={layout.view === v}
                onClick={() => layout.onView(v)}
              >
                {v}
              </button>
            ))}
          </div>
        ) : (
          tasks.length > 0 && (
            <button
              type="button"
              className="mini"
              aria-expanded={!layout.folded}
              aria-controls={`coord-list-${run.id}`}
              title={layout.folded ? "Show the cards" : "Fold the cards to this line, for more of the chat"}
              onClick={() => layout.onFold(!layout.folded)}
            >
              {layout.folded ? "show cards" : "hide cards"}
            </button>
          )
        )}
      </div>
      {tasks.length > 0 && (
        <ol className="coord-list" id={`coord-list-${run.id}`} hidden={headOnly}>
          {tasks.map((t) => (
            <CoordCard key={t.id} run={run} task={t} act={act} />
          ))}
        </ol>
      )}
      {error && !headOnly && <p className="note err">{error}</p>}
    </section>
  );
}

/** The head's hold or resume. Hook-free, so a test can press it: the store
 *  is read as it is pressed. */
export function HoldButton({ run, act }: { run: Run; act: Act }) {
  const held = run.held === true;
  return (
    <button
      type="button"
      className="mini"
      title={held ? "Let cards start again as slots free" : "Start no more cards until you resume; cards already running go on"}
      onClick={() => void act(() => useStore.getState().coordHold(run.id, !held))}
    >
      {held ? "resume" : "hold"}
    </button>
  );
}

/** A proposed card's own start: it joins the queue ahead of the rest.
 *  Hook-free like HoldButton. */
export function StartButton({ run, task, act }: { run: Run; task: CoordTask; act: Act }) {
  return (
    <button
      type="button"
      className="mini"
      title={run.held ? "Queue this card alone; it starts once you resume" : "Queue this card alone, ahead of the rest; it starts as soon as a slot frees"}
      onClick={() => void act(() => useStore.getState().coordStart(run.id, [task.id]))}
    >
      start
    </button>
  );
}

/** A card's way to its flow: the flow sheet, by the card's `flow`, which
 *  `qRun` qualified with the coordinator's backend. Hook-free like
 *  HoldButton. */
export function FlowButton({ task }: { task: CoordTask }) {
  const id = task.flow;
  if (!id) return null;
  return (
    <button type="button" className="mini" title="Open the flow this card runs its workflow in" onClick={() => useStore.getState().showFlow(id)}>
      open its flow
    </button>
  );
}

function CoordCard({ run, task, act }: { run: Run; task: CoordTask; act: Act }) {
  const child = useStore((s) => (task.run ? s.runs[task.run] : undefined));
  const flow = useStore((s) => (task.flow ? s.flows[task.flow] : undefined));
  const landing = useStore((s) => landingAll(s));
  const prs = useStore((s) => prsAll(s));
  const showRun = useStore((s) => s.showRun);
  const showGroup = useStore((s) => s.showGroup);
  const coordRemove = useStore((s) => s.coordRemove);
  const [editing, setEditing] = useState(false);
  const group = task.group ? landing.groups?.find((g) => g.id === task.group) : undefined;
  const status = cardStatus(task, child, landing, prs, group, flow);
  const chip = status.pr ? ciChip(status.pr) : null;
  const live = !run.kept && isRunActive(run);
  // a queued card still changes its loadout and after, or goes
  const editable = live && (task.state === "proposed" || task.state === "queued");
  const startable = live && task.state === "proposed";
  const carries = cardCarries(task);

  return (
    <li className="coord-card">
      <div className="coord-card-head">
        <span className="coord-title">{task.title}</span>
        <span className={`coord-chip ${status.tone}`}>{status.word}</span>
      </div>
      <div className="facts">
        <span className="branch">{idText(task.repo)}</span>
        <span className="branch">{ACTION_WORD[task.action]}</span>
        {task.times !== undefined && task.times > 1 && <span className="branch">best of {task.times}</span>}
        {carries.loadout && (
          <span className="branch" title={carries.loadout.title}>
            {carries.loadout.word}
          </span>
        )}
        {carries.workflow && (
          <span className="branch" title={`runs the workflow ${carries.workflow}${task.workflowRepo ? ", the repo's own," : ""} as a flow`}>
            {carries.workflow}
          </span>
        )}
        {carries.after && (
          <span className="branch" title={`starts once ${(task.after ?? []).join(", ")} landed`}>
            {carries.after}
          </span>
        )}
      </div>
      {/* a proposed card's form edits its note; a queued card's keeps it in view */}
      {!(editing && editable && task.state === "proposed") && <p className="coord-note">{task.note}</p>}
      {editing && editable && <CardForm run={run} task={task} act={act} onDone={() => setEditing(false)} />}
      {status.line && <p className={task.state === "failed" ? "coord-line err" : "coord-line"}>{status.line}</p>}
      {(status.pr || (editable && !editing) || child || group || task.flow) && (
        <div className="coord-actions">
          {status.pr && (
            <a className="run-pr-link" href={status.pr.url} target="_blank" rel="noreferrer" title={`${status.pr.slug} #${status.pr.number}`}>
              {prLine(status.pr)}
            </a>
          )}
          {chip && <span className={`coord-chip ${chip.tone}`}>{chip.text}</span>}
          <span className="spacer" />
          {editable && !editing && (
            <>
              <button type="button" className="mini" title={startable ? "Change what this card says and carries" : "Change its loadout or the cards it waits for"} onClick={() => setEditing(true)}>
                edit
              </button>
              <button type="button" className="mini" title="Take this card out of the plan" onClick={() => void act(() => coordRemove(run.id, task.id))}>
                remove
              </button>
              {startable && <StartButton run={run} task={task} act={act} />}
            </>
          )}
          {child && (
            <button type="button" className="mini" title="Open the branch run this card started" onClick={() => showRun(child.id)}>
              open its run
            </button>
          )}
          <FlowButton task={task} />
          {group && (
            <button type="button" className="mini" title="Open the group this card started" onClick={() => showGroup(group.id)}>
              open the group
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** the workflow select's value: its source and name, "" for none */
const flowKey = (w: CardDraft["workflow"]): string => (w ? `${w.fromRepo ? "repo" : "shared"}:${w.name}` : "");
const flowOf = (key: string): CardDraft["workflow"] => {
  const at = key.indexOf(":");
  return at < 0 ? null : { name: key.slice(at + 1), fromRepo: key.slice(0, at) === "repo" };
};
const flowLabel = (w: NonNullable<CardDraft["workflow"]>): string => (w.fromRepo ? `${w.name} (the repo's)` : w.name);

/** A card's edit form: only what changed is sent (`cardEdit`). A proposed
 *  card changes in every field; a queued one only its loadout and after.
 *  The workflows are the card's repo's, read as the form opens. */
export function CardForm({ run, task, act, onDone }: { run: Run; task: CoordTask; act: Act; onDone: () => void }) {
  const coordPlanEdit = useStore((s) => s.coordPlanEdit);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  // the coordinator's backend's own checkouts, the only repos a card may name
  const backend = backendOf(run.id);
  const repos = useStore((s) => s.repos);
  const kitLoadouts = useStore((s) => s.kit[backend]?.loadouts?.loadouts);
  const choices = repos.filter((r) => backendOf(r.id) === backend && !r.host && !r.forge && !isSeedId(r.id));
  const proposed = task.state === "proposed";
  const first = cardDraft(task);
  const [title, setTitle] = useState(first.title);
  const [note, setNote] = useState(first.note);
  const [repo, setRepo] = useState(first.repo);
  const [action, setAction] = useState<CoordTask["action"]>(first.action);
  const [times, setTimes] = useState(first.times);
  const [loadout, setLoadout] = useState(first.loadout);
  const [workflow, setWorkflow] = useState(first.workflow);
  const [after, setAfter] = useState(first.after);
  const [busy, setBusy] = useState(false);
  const noteBox = useRef<HTMLTextAreaElement>(null);
  // the card's repo's files at @; the child run's harness is the repo's
  // routing's, not known here, so no commands
  const mentions = useMentions({ box: noteBox, text: note, setText: setNote, repoId: repo, side: "below" });
  const entries = useStore((s) => (proposed ? s.workflows[repo] : undefined));
  useEffect(() => {
    // an older backend, or a repo it cannot read, offers no workflow beyond the card's own
    if (proposed) loadWorkflows(repo).catch(() => {});
  }, [proposed, repo, loadWorkflows]);

  const flows = (entries ?? []).flatMap((e) => (e.ok && e.workflow.listed !== false ? [{ name: e.workflow.name, fromRepo: e.workflow.source === "repo" }] : []));
  if (workflow && !flows.some((w) => flowKey(w) === flowKey(workflow))) flows.unshift(workflow);
  // plan, then build needs Claude Code, and so does every step of a card's flow
  const offered = loadoutsFor(action, kitLoadouts).filter((l) => !workflow || l.harness === "claude");
  const change = cardEdit(task, { title, note, repo, action, times, loadout, workflow, after });
  const changed = Object.keys(change).length > 0;
  const ok = !proposed || (title.trim().length > 0 && note.trim().length > 0);

  const save = async () => {
    if (!changed) {
      onDone();
      return;
    }
    if (!ok || busy) return;
    setBusy(true);
    try {
      await act(() => coordPlanEdit(run.id, task.id, change), true);
      onDone();
    } catch {
      // the sheet shows the error; the form keeps what was typed
    } finally {
      setBusy(false);
    }
  };

  const loadoutPick = (
    <select className="settings-input" value={loadout} aria-label="Loadout" title="A named set of model, effort, skills and servers from kit.json. Another one replaces any field you changed" onChange={(e) => setLoadout(e.target.value)}>
      <option value="">no loadout</option>
      {loadout && !offered.some((l) => l.name === loadout) && <option value={loadout}>{loadout}</option>}
      {offered.map((l) => (
        <option key={l.name} value={l.name} title={l.note}>
          {loadoutLabel(l)}
        </option>
      ))}
    </select>
  );
  const afterBox = (
    <input
      type="text"
      className="settings-input"
      value={after}
      placeholder="after: card ids"
      aria-label="After"
      title="The cards this one waits for, until each has landed, by id"
      onChange={(e) => setAfter(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
      }}
    />
  );

  return (
    <div className="coord-form">
      {proposed && (
        <>
          <input
            type="text"
            className="settings-input"
            value={title}
            maxLength={TITLE_MAX}
            aria-label="Card title"
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="coord-form-row">
            <select className="settings-input" value={repo} aria-label="Repo" onChange={(e) => setRepo(e.target.value)}>
              {!choices.some((r) => r.id === task.repo) && <option value={task.repo}>{plainOf(task.repo)}</option>}
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
            <select
              className="settings-input"
              value={times}
              aria-label="How many tries"
              disabled={workflow !== null}
              title={workflow ? "A card with a workflow starts one run" : "2 or 3 starts that many runs of this note and lands the best one"}
              onChange={(e) => setTimes(Number(e.target.value))}
            >
              <option value={1}>one try</option>
              <option value={2}>best of 2</option>
              <option value={3}>best of 3</option>
            </select>
          </div>
        </>
      )}
      <div className="coord-form-row">
        {loadoutPick}
        {proposed && (
          <select
            className="settings-input"
            value={flowKey(workflow)}
            aria-label="Workflow"
            disabled={times > 1}
            title={times > 1 ? "A best of starts single runs; one try runs a workflow" : "Run one of the repo's workflows as a flow, in place of a single run"}
            onChange={(e) => setWorkflow(flowOf(e.target.value))}
          >
            <option value="">no workflow</option>
            {flows.map((w) => (
              <option key={flowKey(w)} value={flowKey(w)}>
                {flowLabel(w)}
              </option>
            ))}
          </select>
        )}
        {afterBox}
      </div>
      {proposed && (
        <>
          <textarea
            ref={noteBox}
            className="plan-note"
            rows={5}
            value={note}
            maxLength={NOTE_MAX}
            aria-label="What the run is told"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (mentions.onKeyDown(e)) return;
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
            }}
          />
          {mentions.menu}
        </>
      )}
      <div className="coord-actions">
        <span className="spacer" />
        <button type="button" className="mini" onClick={onDone}>
          cancel
        </button>
        <button type="button" className="mini strong" disabled={busy || (changed && !ok)} title="⌘↩" onClick={() => void save()}>
          {busy ? "saving…" : "save"}
        </button>
      </div>
    </div>
  );
}

/** A child's line: the coordinator that started it and the card's title,
 *  with a link back to the coordinator's sheet while the page has it. */
export function ParentLine({ run }: { run: Run }) {
  const parent = useStore((s) => (run.parent ? s.runs[run.parent] : undefined));
  const showRun = useStore((s) => s.showRun);
  const group = useStore(s => landingAll(s).groups?.find(g => g.id === (run.group ?? run.branch?.group)));
  const showGroup = useStore(s => s.showGroup);
  if (group) return <div className="run-parent"><span className="run-parent-text">{groupReviews(group).some((review) => review.run === run.id) ? "reviewing best of" : "one of"} {group.expectedMembers}</span><span className="spacer" /><button type="button" className="mini" onClick={() => showGroup(group.id)}>open the group</button></div>;
  if (!run.parent) return null;
  // a coordinator's card starts at depth 0; a run's child has a depth (FR-038)
  if (run.depth) {
    return (
      <div className="run-parent">
        <span className="run-parent-text">{chainWords(run, parent)}</span>
        <span className="spacer" />
        {parent && (
          <button type="button" className="mini" title="Open the run that started this one" onClick={() => showRun(parent.id)}>
            open the parent
          </button>
        )}
      </div>
    );
  }
  const card = parentCard(parent, run.id);
  return (
    <div className="run-parent">
      <span className="run-parent-text">
        started by coordinator{card ? <>: <b>{card.title}</b></> : ""}
      </span>
      <span className="spacer" />
      {parent && (
        <button type="button" className="mini" title="Open the coordinator's chat and cards" onClick={() => showRun(parent.id)}>
          open the coordinator
        </button>
      )}
    </div>
  );
}
