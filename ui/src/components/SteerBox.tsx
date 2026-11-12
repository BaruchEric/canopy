import { useRef, useState } from "react";
import { steerWords } from "../../../src/core/steer";
import { DictateButton } from "./Dictate";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** what a send from the box said back */
type SteerNote = { kind: "sent" | "error"; text: string };

/** Where a steer box's words go and what it says about them. */
export interface SteerTarget {
  /** the box's words while nothing is typed */
  placeholder: string;
  /** the box's name for a screen reader */
  label: string;
  /** the send button's hover */
  sendTitle: string;
  /** the line under the box once a send went through */
  sent: string;
  send: (words: string) => Promise<unknown>;
  /** Escape into a terminal, with its button's hover; none where there is
   *  no terminal (a DM) */
  escape?: { title: string; send: () => Promise<unknown> };
  /** why nothing can be sent now (it waits on a choice), shown in the box */
  closed?: string;
}

/**
 * A one-line box for a person's words to something at work (FR-066): an
 * agent's or a task's terminal, typed in with Enter, or a DM. Enter sends,
 * shift-Enter breaks a line, and "esc" sends Escape where there is a
 * terminal. It never takes the keyboard on its own, so a board's or a
 * panel's keys stay theirs, and its clicks and keys stop here.
 */
export function SteerBox({ target }: { target: SteerTarget }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SteerNote | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const typed = text.trim().length > 0;
  const closed = target.closed !== undefined;

  const run = async (act: () => Promise<unknown>, sent: string, clear: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      await act();
      if (clear) setText("");
      setNote({ kind: "sent", text: sent });
    } catch (e) {
      setNote({ kind: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    const said = steerWords(text);
    if (!said.ok || busy || closed) return;
    void run(() => target.send(said.words), target.sent, true);
  };
  const escape = target.escape;

  return (
    <div className="composer steer-bar" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="mention-host">
        <textarea
          ref={box}
          className="composer-box"
          rows={1}
          placeholder={target.closed ?? target.placeholder}
          value={text}
          disabled={closed}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          aria-label={target.label}
          data-mic
        />
        {note && <span className={note.kind === "error" ? "steer-note err" : "steer-note"}>{note.text}</span>}
      </div>
      <DictateButton target={box} />
      {escape && (
        <button type="button" className="mini" disabled={busy} title={escape.title} onClick={() => void run(escape.send, "Escape sent", false)}>
          esc
        </button>
      )}
      <button type="button" className="mini strong" disabled={busy || closed || !typed} title={target.sendTitle} onClick={send}>
        send
      </button>
    </div>
  );
}
