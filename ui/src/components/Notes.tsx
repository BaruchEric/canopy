/**
 * Quick notes and reminders (FR-020): the top bar's ✎ chip and its popup,
 * a card's word on its open notes, and the popup's body, which a tab in a
 * shell window (FR-030) and a card in the dock (FR-047) draw as well. The
 * form adds a note on the picked repo's backend (else home) with its time
 * as typed; each open note has done and delete. A reminder that came due
 * is the inbox's row (Inbox.tsx), not this list's.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { dueWord, openNotes as openOnly, sortNotes, type QuickNote } from "../../../src/core/notes";
import { HANGS_RIGHT, leavesPop, useFitPop } from "../pop";
import { POPUP_WORD } from "../sectiontabs";
import { useStore, type CanopyState } from "../store";
import { escapeCloses, keepKeys } from "../surface";
import { useNow } from "./Inbox";
import { PopGrip, type PopSpec } from "./PopGrip";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** every shown backend's notes, as one list */
const allNotes = (s: CanopyState): QuickNote[] => Object.values(s.quickNotes).flat();

const NOTES_POP: PopSpec = { name: "notes", anchor: HANGS_RIGHT, tab: { kind: "popup", ref: "notes", label: POPUP_WORD.notes } };

/** "in 5m" ahead of time; "now" or "5m ago" once it has come, in rust until the note is done */
function DueWord({ note, now }: { note: QuickNote; now: number }) {
  if (note.due === undefined) return null;
  const late = note.due <= now;
  return (
    <span className={`note-due${late ? " late" : ""}`} title={new Date(note.due).toLocaleString()}>
      {late && note.remindedAt !== undefined ? "in the inbox" : dueWord(note.due, now)}
    </span>
  );
}

function NoteRow({ note, now, busy, onDone, onDelete }: { note: QuickNote; now: number; busy: boolean; onDone?: () => void; onDelete: () => void }) {
  const repoName = useStore((s) => (note.repoId ? s.repos.find((r) => r.id === note.repoId)?.name : undefined));
  const done = note.doneAt !== undefined;
  return (
    <li className={`note-row${done ? " done" : ""}`}>
      <p className="note-text">{note.text}</p>
      <span className="note-meta">
        {repoName && <span className="note-repo">{repoName}</span>}
        {done ? <span className="dim">done</span> : <DueWord note={note} now={now} />}
      </span>
      <span className="note-actions">
        {onDone && (
          <button type="button" className="mini" disabled={busy} title="Done: it leaves the open notes and the inbox" onClick={onDone}>
            ✓
          </button>
        )}
        <button type="button" className="mini" disabled={busy} title="Delete the note" onClick={onDelete}>
          ✕
        </button>
      </span>
    </li>
  );
}

/**
 * The popup's body: a form (text, a repo picked from the repos the page
 * knows, a remind-at as typed: in 30m, 14:00, a date and time), the open
 * notes with their repo and due word, and the done ones folded away.
 * `onDone` is unused here; a popover stays open after an add, so the next
 * note can follow.
 */
export function NotesPopBody({ onDone: _onDone }: { onDone?: () => void } = {}) {
  const notes = useStore(useShallow(allNotes));
  const repos = useStore((s) => s.repos);
  const { addQuickNote, doneQuickNote, deleteQuickNote } = useStore.getState();
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const now = useNow(true, 15_000);
  const textRef = useRef<HTMLInputElement>(null);

  const open = sortNotes(openOnly(notes));
  const done = notes.filter((n) => n.doneAt !== undefined).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const picks = [...repos].sort((a, b) => a.name.localeCompare(b.name));

  const act = (go: () => Promise<unknown>, then?: () => void) => {
    setBusy(true);
    setError("");
    go()
      .then(() => then?.())
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    act(() => addQuickNote({ text: body, ...(repo ? { repo } : {}), ...(at.trim() ? { at: at.trim() } : {}) }), () => {
      setText("");
      setAt("");
      textRef.current?.focus();
    });
  };

  return (
    <>
      <form className="settings-row note-form" onSubmit={add}>
        <input
          ref={textRef}
          className="settings-input note-form-text"
          placeholder="a note, or something to be reminded of"
          aria-label="QuickNote"
          value={text}
          disabled={busy}
          maxLength={600}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keepKeys}
        />
        <select className="settings-input" aria-label="Repo" value={repo} disabled={busy} onChange={(e) => setRepo(e.target.value)}>
          <option value="">no repo</option>
          {picks.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <input
          className="settings-input note-form-at"
          placeholder="remind: in 30m, 14:00"
          aria-label="Remind at"
          title="When it comes back: in 30m, in 2h, 14:00, or a date and time; blank for a plain note"
          value={at}
          disabled={busy}
          onChange={(e) => setAt(e.target.value)}
          onKeyDown={keepKeys}
        />
        <button type="submit" className="mini strong" disabled={busy || !text.trim()}>
          add
        </button>
        {error && <p className="settings-hint error">{error}</p>}
      </form>
      <section className="settings-row">
        {open.length === 0 ? (
          <p className="settings-hint">No open notes.</p>
        ) : (
          <ul className="note-list">
            {open.map((n) => (
              <NoteRow key={n.id} note={n} now={now} busy={busy} onDone={() => act(() => doneQuickNote(n.id))} onDelete={() => act(() => deleteQuickNote(n.id))} />
            ))}
          </ul>
        )}
      </section>
      {done.length > 0 && (
        <details className="settings-row note-done">
          <summary className="settings-hint">{done.length === 1 ? "1 done" : `${done.length} done`}</summary>
          <ul className="note-list">
            {done.slice(0, 20).map((n) => (
              <NoteRow key={n.id} note={n} now={now} busy={busy} onDelete={() => act(() => deleteQuickNote(n.id))} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** The top bar's ✎ n: the open notes, in a popover with the form. Always
 *  shown, since the chip is how a note is added. */
export function NotesChip() {
  const count = useStore((s) => openOnly(allNotes(s)).length);
  const open = useStore((s) => s.quickNotesOpen);
  const { openQuickNotes, closeQuickNotes } = useStore.getState();
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      // the gear's menu sits in a portal outside the popup; a click in it stays in
      if (e.target instanceof Element && e.target.closest(".gear-pop")) return;
      if (leavesPop(e.target, ref)) closeQuickNotes();
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => closeQuickNotes());
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closeQuickNotes]);

  return (
    <div className="settings notes-chip" ref={ref}>
      <button
        type="button"
        className={`mini${open ? " on" : ""}`}
        aria-label={`Notes, ${count} open`}
        aria-expanded={open}
        title={count === 0 ? "Notes and reminders" : `${count} open ${count === 1 ? "note" : "notes"}`}
        onClick={() => (open ? closeQuickNotes() : openQuickNotes())}
      >
        <span className="chip-icon" aria-hidden="true">✎</span> {count || ""}
      </button>
      {open && (
        <div className="settings-pop notes-pop" role="dialog" aria-label="Notes">
          <NotesPopBody onDone={closeQuickNotes} />
          <PopGrip {...NOTES_POP} gear />
        </div>
      )}
    </div>
  );
}

/** a card's word on its open notes: ✎ n, which opens the notes popup; nothing when it has none */
export function NoteChip({ repoId }: { repoId: string }) {
  const count = useStore((s) => openOnly(allNotes(s)).filter((n) => n.repoId === repoId).length);
  const openQuickNotes = useStore((s) => s.openQuickNotes);
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="run-chip note-chip"
      title={`${count} open ${count === 1 ? "note" : "notes"} on this repo`}
      onClick={(e) => {
        e.stopPropagation();
        openQuickNotes();
      }}
      onAuxClick={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      ✎ {count}
    </button>
  );
}
