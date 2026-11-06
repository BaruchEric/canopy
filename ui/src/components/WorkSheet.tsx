/** A work item's sheet (FR-037): every note, the box for a new one, close
 *  by hand and the markdown export; and the pieces the work view and the
 *  run sheet's block share with it. The model is pure `ui/src/work.ts`. */

import { useMemo, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { exportMarkdown, fromWord, type WorkItem, type WorkNote } from "../../../src/core/work";
import { backendOf, homeName, plainOf, qual } from "../registry";
import { copyText } from "../share";
import { useStore } from "../store";
import { ago } from "../util";
import { lastNotes, STATE_TONE } from "../work";

type Call = { kind: "idle" } | { kind: "busy" } | { kind: "failed"; error: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A repo's name as the tree shows it, by the page's id for it, else the id. */
export function useRepoNames(): (id: string) => string {
  // the list itself, a stable reference; a derived array here would be new on every read and never settle
  const repos = useStore((s) => s.repos);
  const names = useMemo(() => new Map(repos.map((r) => [r.id, r.name])), [repos]);
  return (id) => names.get(id) ?? plainOf(id);
}

/** the id with its backend when that is not home: what the eyebrow and the row's tail say */
export const whereWord = (backend: string, id: string): string => (backend === homeName() ? id : `${id} on ${backend}`);

/** The box under a row or a sheet: one line, Enter or the button sends it. */
function NoteBox({ id, compact }: { id: string; compact?: boolean }) {
  const noteWork = useStore((s) => s.noteWork);
  const [text, setText] = useState("");
  const [call, setCall] = useState<Call>({ kind: "idle" });
  const send = (e: FormEvent) => {
    e.preventDefault();
    const line = text.trim();
    if (!line || call.kind === "busy") return;
    setCall({ kind: "busy" });
    noteWork(id, line).then(
      () => {
        setText("");
        setCall({ kind: "idle" });
      },
      (err: unknown) => setCall({ kind: "failed", error: errText(err) }),
    );
  };
  return (
    <form className={`work-box${compact ? " compact" : ""}`} onSubmit={send}>
      <input type="text" value={text} placeholder="leave a note for whoever picks this up next" aria-label="A note on this work" onChange={(e) => setText(e.target.value)} disabled={call.kind === "busy"} />
      <button type="submit" className="mini" disabled={!text.trim() || call.kind === "busy"}>
        note
      </button>
      {call.kind === "failed" && <span className="work-err">{call.error}</span>}
    </form>
  );
}

function NoteLine({ note }: { note: WorkNote }) {
  return (
    <li className={`work-note by-${note.by === "canopy" ? "canopy" : note.by === "agent" ? "agent" : "person"}`}>
      <span className="work-note-by">{note.by}</span>
      <span className="work-note-text">{note.text}</span>
      <span className="work-note-when" title={new Date(note.at).toLocaleString()}>
        {ago(note.at / 1000)}
      </span>
    </li>
  );
}

/** The links a row and the sheet carry: the newest run, each PR, the
 *  branches and events as counts. */
export function Links({ backend, item }: { backend: string; item: WorkItem }) {
  const showRun = useStore((s) => s.showRun);
  const newest = item.runs.at(-1);
  return (
    <span className="work-links">
      {newest && (
        <button type="button" className="work-link" title={`Open the newest run, ${item.runs.length === 1 ? "its only one" : `one of ${item.runs.length}`}`} onClick={() => showRun(qual(backend, newest))}>
          {item.runs.length === 1 ? "run" : `${item.runs.length} runs`}
        </button>
      )}
      {item.branches.length > 0 && <span title={item.branches.join(", ")}>{item.branches.length === 1 ? "1 branch" : `${item.branches.length} branches`}</span>}
      {item.prs.map((pr) => (
        <a key={pr.number} className="work-link" href={pr.url} target="_blank" rel="noreferrer">
          PR #{pr.number}
        </a>
      ))}
      {item.events.length > 0 && <span title={item.events.join(", ")}>{item.events.length === 1 ? "1 event" : `${item.events.length} events`}</span>}
    </span>
  );
}

/** One item's sheet: its facts, every note, the box, close by hand and
 *  the markdown export, by the page's id for the item. */
export function WorkSheet({ id }: { id: string }) {
  const backend = backendOf(id);
  const plain = plainOf(id);
  const item = useStore((s) => s.work[backend]?.items.find((i) => i.id === plain));
  const { close, closeWork } = useStore(useShallow((s) => ({ close: s.closeSheet, closeWork: s.closeWork })));
  const nameOf = useRepoNames();
  const [call, setCall] = useState<Call>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  if (!item) {
    return (
      <>
        <p className="sheet-empty">That work item is not on this page: its backend may be offline, or the item was compacted.</p>
        <footer className="sheet-foot">
          <span className="spacer" />
          <button type="button" className="mini" onClick={close}>
            close
          </button>
        </footer>
      </>
    );
  }
  const open = item.closedAt === undefined;
  const end = (state: "landed" | "dropped") => {
    setCall({ kind: "busy" });
    closeWork(id, state).then(
      () => setCall({ kind: "idle" }),
      (err: unknown) => setCall({ kind: "failed", error: errText(err) }),
    );
  };
  const copy = () => {
    void copyText(exportMarkdown(item)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const from = fromWord(item.from);
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">work · {whereWord(backend, item.id)}</div>
          <h2 className="sheet-title">{item.title}</h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body work-sheet">
        <p className="work-facts">
          <span className={`work-state ${STATE_TONE[item.state]}`}>{item.state}</span>
          <span>{item.repos.map((r) => nameOf(qual(backend, r))).join(", ")}</span>
          <span>from {item.from.kind === "issue" && item.from.link ? <a href={item.from.link} target="_blank" rel="noreferrer">{from}</a> : from}</span>
          <span title={new Date(item.createdAt).toLocaleString()}>opened {ago(item.createdAt / 1000)}</span>
          {item.closedAt !== undefined && <span title={new Date(item.closedAt).toLocaleString()}>closed {ago(item.closedAt / 1000)}</span>}
          <Links backend={backend} item={item} />
        </p>
        {item.state === "dropped" && item.reason && <p className="work-needs">{item.reason}</p>}
        <h3 className="panel-label">Notes</h3>
        {item.notes.length === 0 ? (
          <p className="work-empty">None yet. The hubs write a line as the branch moves, and the agent leaves one under a ## Handoff heading when it ends.</p>
        ) : (
          <ul className="work-notes">
            {item.notes.map((note, index) => (
              <NoteLine key={`${note.at}-${index}`} note={note} />
            ))}
          </ul>
        )}
        <NoteBox id={id} />
        {call.kind === "failed" && <p className="work-err">{call.error}</p>}
      </div>
      <footer className="sheet-foot">
        <button type="button" className="mini" title="The item as markdown, for FEATURES.md or an issue" onClick={copy}>
          {copied ? "copied" : "copy as markdown"}
        </button>
        <span className="spacer" />
        {open && (
          <>
            <button type="button" className="mini" title="Mark it landed by hand; refused while a run on it is going" disabled={call.kind === "busy"} onClick={() => end("landed")}>
              landed
            </button>
            <button type="button" className="mini" title="Drop it by hand; refused while a run on it is going" disabled={call.kind === "busy"} onClick={() => end("dropped")}>
              drop
            </button>
          </>
        )}
        <button type="button" className="mini" onClick={close}>
          close
        </button>
      </footer>
    </>
  );
}

/** The two newest notes with the box, as the run sheet's block shows them. */
export function LastNotes({ item }: { item: WorkItem }) {
  const notes = lastNotes(item);
  if (notes.length === 0) return <p className="work-empty">no lines yet</p>;
  return (
    <ul className="work-notes">
      {notes.map((note, index) => (
        <NoteLine key={`${note.at}-${index}`} note={note} />
      ))}
    </ul>
  );
}

export { NoteBox };
