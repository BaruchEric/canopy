import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { anchorOf, noteOn, parseDiff, type DiffLine, type Note } from "../reviewnotes";
import { useStore } from "../store";

/** where a diff's notes belong: the repo, the file, and "working tree" or
 *  the commit it was read from */
export type NoteAt = { repoId: string; path: string; where: string };

/** Paints a diff. With `note`, each line that has a number takes review
 *  notes (NotedDiff); without it, the plain read-only view. */
export function DiffView({ diff, note }: { diff: string; note?: NoteAt }) {
  if (!diff.trim()) return <p className="diff-empty">No textual changes.</p>;
  if (note) return <NotedDiff diff={diff} at={note} />;
  const lines = diff.split("\n");
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = "ctx";
        if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
        else if (line.startsWith("@@")) cls = "hunk";
        else if (line.startsWith("+")) cls = "add";
        else if (line.startsWith("-")) cls = "del";
        else if (line.startsWith("diff ") || line.startsWith("index "))
          cls = "meta";
        return (
          <span key={i} className={`dl ${cls}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

/** a stable empty list, so the store selector does not hand back a new one each render */
const NONE: Note[] = [];

/** One saved note under its line; `at` names the line too, for a note whose
 *  line this diff no longer shows. */
function NoteLine({ n, at, onRemove }: { n: Note; at?: boolean; onRemove: () => void }) {
  return (
    <span className="dl-note">
      <span className="dl-note-text">
        {at && <span className="dl-note-at">{`${n.side === "old" ? "removed line" : "line"} ${n.line}: ${n.snippet}`}</span>}
        {n.text}
      </span>
      <button type="button" className="mini dl-note-x" title="Remove this note" aria-label={`Remove the note on line ${n.line}`} onClick={onRemove}>
        remove
      </button>
    </span>
  );
}

/** The diff with a gutter button on every numbered line: it opens a box
 *  under the line (Cmd or Ctrl with Enter saves, Escape cancels), and saved
 *  notes show under the first line they sit on (`noteOn`). Notes whose line
 *  is gone, after an edit moved it, gather at the foot so they can still be
 *  read and removed. */
function NotedDiff({ diff, at }: { diff: string; at: NoteAt }) {
  const all = useStore((s) => s.reviewNotes[at.repoId] ?? NONE);
  const addNote = useStore((s) => s.addNote);
  const removeNote = useStore((s) => s.removeNote);
  return <NotedLines diff={diff} at={at} all={all} addNote={addNote} removeNote={removeNote} />;
}

/** NotedDiff's body, given the repo's notes and the two writes rather than
 *  the store, so a test can render it on the server (where a store hook
 *  reads the initial state) */
export function NotedLines({
  diff,
  at,
  all,
  addNote,
  removeNote,
}: {
  diff: string;
  at: NoteAt;
  all: readonly Note[];
  addNote: (note: Omit<Note, "id">) => void;
  removeNote: (repoId: string, id: string) => void;
}) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const { under, gone } = useMemo(() => {
    const under = new Map<number, Note[]>();
    const gone: Note[] = [];
    for (const n of all) {
      if (n.path !== at.path || n.where !== at.where) continue;
      const i = lines.findIndex((l) => noteOn(n, l));
      if (i < 0) gone.push(n);
      else under.set(i, [...(under.get(i) ?? []), n]);
    }
    return { under, gone };
  }, [all, lines, at.path, at.where]);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const gutters = useRef(new Map<number, HTMLButtonElement>());

  // the focus goes back to the line's button, so the keyboard keeps its place
  const refocus = (i: number) => requestAnimationFrame(() => gutters.current.get(i)?.focus());
  const close = (i: number) => {
    setEditing(null);
    setDraft("");
    refocus(i);
  };
  const save = (i: number, l: DiffLine) => {
    const a = anchorOf(l);
    const text = draft.trim();
    if (a && text) addNote({ ...at, ...a, snippet: l.text, text });
    close(i);
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>, i: number, l: DiffLine) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save(i, l);
    } else if (e.key === "Escape") {
      // the box's, not the panel's or the page's
      e.preventDefault();
      e.stopPropagation();
      close(i);
    }
  };

  return (
    <pre className="diff noted">
      {lines.map((l, i) => {
        const a = anchorOf(l);
        const here = under.get(i);
        const where = a ? `${a.side === "old" ? "removed line" : "line"} ${a.line}` : "";
        return (
          <Fragment key={i}>
            <span className={`dl ${l.kind}`}>
              {a ? (
                <button
                  type="button"
                  className={`dl-gut${here ? " has" : ""}`}
                  ref={(el) => {
                    if (el) gutters.current.set(i, el);
                    else gutters.current.delete(i);
                  }}
                  aria-label={`Leave a note on ${where}`}
                  aria-expanded={editing === i}
                  title="Leave a review note on this line"
                  onClick={() => {
                    setEditing(editing === i ? null : i);
                    setDraft("");
                  }}
                >
                  {here ? "●" : "+"}
                </button>
              ) : (
                <span className="dl-gut" aria-hidden="true" />
              )}
              {l.text}
              {"\n"}
            </span>
            {here?.map((n) => (
              <NoteLine
                key={n.id}
                n={n}
                onRemove={() => {
                  removeNote(at.repoId, n.id);
                  refocus(i);
                }}
              />
            ))}
            {editing === i && (
              <span className="dl-edit">
                <textarea
                  autoFocus
                  rows={2}
                  value={draft}
                  placeholder="what the agent should do about this line"
                  aria-label={`Note on ${where}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => keys(e, i, l)}
                />
                <span className="dl-edit-row">
                  <button type="button" className="mini strong" disabled={!draft.trim()} onClick={() => save(i, l)}>
                    save
                  </button>
                  <button type="button" className="mini" onClick={() => close(i)}>
                    cancel
                  </button>
                  <span className="dl-hint">⌘ or Ctrl + Enter saves · Esc cancels</span>
                </span>
              </span>
            )}
          </Fragment>
        );
      })}
      {gone.length > 0 && (
        <span className="dl-gone">
          <span className="dl-gone-head">notes on lines this diff no longer shows</span>
          {gone.map((n) => (
            <NoteLine key={n.id} n={n} at onRemove={() => removeNote(at.repoId, n.id)} />
          ))}
        </span>
      )}
    </pre>
  );
}
