import { useState } from "react";
import { isSeedId } from "../../../src/core/sprout";
import { isRunActive, type CoordTask, type Run } from "../../../src/core/types";
import { canStartCards, cardCounts, cardStatus, parentCard, type CoordEdit, type CoordView } from "../coord";
import { ciChip, prLine } from "../prs";
import { backendOf, plainOf } from "../registry";
import { idText, landingAll, prsAll, useStore } from "../store";

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
 * repo, note and state, an edit form and remove while it is proposed, and
 * once it started, its child's newest step, landing word or PR and a link
 * to the child's sheet. "start these" shows while any card is proposed.
 * Showing only its head, the list stays mounted, so an open edit form
 * keeps what was typed. `error` is the sheet's, for the phone's cards
 * view, where the timeline that shows it is gone.
 */
export function CoordTasks({ run, act, layout, error = null }: { run: Run; act: Act; layout: CoordLayout; error?: string | null }) {
  const coordStart = useStore((s) => s.coordStart);
  const tasks = run.tasks ?? [];
  const active = isRunActive(run);
  if (tasks.length === 0 && !active) return null;
  const headOnly = layout.kind === "phone" ? layout.view === "chat" : layout.folded;
  const fill = layout.kind === "phone" && layout.view === "cards";
  return (
    <section className={`coord-tasks${layout.kind === "phone" ? " phone" : ""}${fill ? " fill" : ""}`} aria-label="The coordinator's cards">
      <div className="coord-head">
        <span className="coord-count">{tasks.length ? cardCounts(tasks) : "No cards yet. The coordinator proposes them here."}</span>
        <span className="spacer" />
        {canStartCards(run) && (
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

function CoordCard({ run, task, act }: { run: Run; task: CoordTask; act: Act }) {
  const child = useStore((s) => (task.run ? s.runs[task.run] : undefined));
  const landing = useStore((s) => landingAll(s));
  const prs = useStore((s) => prsAll(s));
  const showRun = useStore((s) => s.showRun);
  const coordRemove = useStore((s) => s.coordRemove);
  const [editing, setEditing] = useState(false);
  const status = cardStatus(task, child, landing, prs);
  const chip = status.pr ? ciChip(status.pr) : null;
  const editable = task.state === "proposed" && isRunActive(run);

  return (
    <li className="coord-card">
      <div className="coord-card-head">
        <span className="coord-title">{task.title}</span>
        <span className={`coord-chip ${status.tone}`}>{status.word}</span>
      </div>
      <div className="facts">
        <span className="branch">{idText(task.repo)}</span>
        <span className="branch">{ACTION_WORD[task.action]}</span>
      </div>
      {editing && editable ? (
        <CardForm run={run} task={task} act={act} onDone={() => setEditing(false)} />
      ) : (
        <p className="coord-note">{task.note}</p>
      )}
      {status.line && <p className={task.state === "failed" ? "coord-line err" : "coord-line"}>{status.line}</p>}
      {(status.pr || (editable && !editing) || child) && (
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
              <button type="button" className="mini" onClick={() => setEditing(true)}>
                edit
              </button>
              <button type="button" className="mini" title="Take this card out of the plan" onClick={() => void act(() => coordRemove(run.id, task.id))}>
                remove
              </button>
            </>
          )}
          {child && (
            <button type="button" className="mini" title="Open the branch run this card started" onClick={() => showRun(child.id)}>
              open its run
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** A proposed card's edit form: only what changed is sent. */
function CardForm({ run, task, act, onDone }: { run: Run; task: CoordTask; act: Act; onDone: () => void }) {
  const coordPlanEdit = useStore((s) => s.coordPlanEdit);
  // the coordinator's backend's own checkouts, the only repos a card may name
  const backend = backendOf(run.id);
  const repos = useStore((s) => s.repos);
  const choices = repos.filter((r) => backendOf(r.id) === backend && !r.host && !r.forge && !isSeedId(r.id));
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note);
  const [repo, setRepo] = useState(task.repo);
  const [action, setAction] = useState<CoordTask["action"]>(task.action);
  const [busy, setBusy] = useState(false);

  const change: CoordEdit = {
    ...(title.trim() !== task.title ? { title: title.trim() } : {}),
    ...(note.trim() !== task.note ? { note: note.trim() } : {}),
    ...(repo !== task.repo ? { repo } : {}),
    ...(action !== task.action ? { action } : {}),
  };
  const changed = Object.keys(change).length > 0;
  const ok = title.trim().length > 0 && note.trim().length > 0;

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

  return (
    <div className="coord-form">
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
      </div>
      <textarea
        className="plan-note"
        rows={5}
        value={note}
        maxLength={NOTE_MAX}
        aria-label="What the run is told"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
        }}
      />
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
  if (!run.parent) return null;
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
