import { useEffect, useRef, useState } from "react";
import { HARNESS } from "../../../src/core/harness";
import { harnessesOf } from "../agents";
import { runsAgent } from "../agentsend";
import { annotationsPrompt, type Annotation } from "../designmode";
import { agentCandidates } from "../guided";
import { LIVE, typeInto } from "../liveTerms";
import { backendOf } from "../registry";
import { copyText } from "../share";
import { connOf, useStore } from "../store";
import type { TermTab } from "../term";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** what each way of sending to the repo's agent says it did */
export const PICK_SAID = {
  said: "Sent to the agent's chat.",
  pasted: "Pasted into the agent's shell: press Enter there to send it.",
  started: "Started a chat with the agent.",
} as const;

/** the server's cut on a new shell's first prompt (PROMPT_MAX in
 *  server/index.ts): longer notes go to a chat or a running agent */
const SHELL_PROMPT_MAX = 6000;

const shellName = (t: TermTab) => `${t.label ?? t.name} (${t.place})`;

/**
 * The notes left in design mode, waiting to go out together (FR-027): each
 * numbered as the page marks its element, with what it asks for, the
 * picture it is on when it is on one (FR-029), and a way to drop it.
 * "send" picks who gets them: the repo's agent as the picker
 * always chose it, an agent already running in one of the repo's shells
 * here, a new chat, or a new shell with either harness. "copy all" puts the
 * same prompt on the clipboard.
 */
export function PickNotes({
  repoId,
  notes,
  pageUrl,
  onRemove,
  onClear,
  onSent,
  say,
}: {
  repoId: string;
  notes: readonly Annotation[];
  pageUrl: string;
  onRemove: (i: number) => void;
  onClear: () => void;
  /** the notes went out; the list empties */
  onSent: (said: string) => void;
  say: (text: string, bad: boolean) => void;
}) {
  const terms = useStore((s) => s.terms);
  const sendToAgent = useStore((s) => s.sendToAgent);
  const startRun = useStore((s) => s.startRun);
  const openTerm = useStore((s) => s.openTerm);
  const showTerm = useStore((s) => s.showTerm);
  const has = useStore((s) => harnessesOf(connOf(s, backendOf(repoId)).backend));
  const [menu, setMenu] = useState(false);
  // the repo's shells with an agent running and a view here; null while asked
  const [shells, setShells] = useState<TermTab[] | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const text = annotationsPrompt(notes, pageUrl);
  const long = text.length > SHELL_PROMPT_MAX;

  useEffect(() => {
    if (!menu) return;
    let live = true;
    setShells(null);
    const ids = agentCandidates(null, terms, repoId).filter((id) => LIVE.has(id));
    void Promise.all(ids.map(async (id) => ((await runsAgent(id)) ? id : null))).then((got) => {
      if (!live) return;
      const on = new Set(got.filter((id): id is string => id !== null));
      setShells(ids.flatMap((id) => terms.filter((t) => t.id === id && on.has(id))));
    });
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node && box.current?.contains(e.target))) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      live = false;
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [menu, terms, repoId]);

  const send = (how: () => Promise<string>) => {
    setMenu(false);
    setBusy(true);
    how()
      .then(onSent)
      .catch((e: unknown) => say(errText(e), true))
      .finally(() => setBusy(false));
  };
  const count = `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;

  return (
    <div className="preview-notes" ref={box} role="region" aria-label="Notes for the agent">
      <ol className="preview-notes-list">
        {notes.map((a, i) => (
          <li key={i}>
            <span className="preview-notes-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className={`preview-notes-intent ${a.intent}`}>{a.intent}</span>
            {a.clip?.thumb && <img className="preview-notes-thumb" src={a.clip.thumb} alt={`The picture note ${i + 1} is on`} />}
            <span className="preview-notes-text" title={`${a.pick?.selector ?? `a picture, ${a.clip?.kind ?? ""}`}\n${a.note}`}>
              {a.note}
            </span>
            <button type="button" className="mini" title="Drop this note" aria-label={`Drop note ${i + 1}`} onClick={() => onRemove(i)}>
              ✕
            </button>
          </li>
        ))}
      </ol>
      <div className="preview-pick-row">
        <span className="preview-notes-count">{count} ready</span>
        <button type="button" className="mini" aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={() => setMenu((m) => !m)}>
          send ▾
        </button>
        <button
          type="button"
          className="mini"
          title="Copy the prompt these notes make"
          onClick={() =>
            copyText(text).then(
              () => say(`Copied ${count}.`, false),
              (e: unknown) => say(errText(e), true),
            )
          }
        >
          copy all
        </button>
        <button type="button" className="mini" onClick={onClear}>
          clear
        </button>
      </div>
      {menu && (
        <div className="preview-notes-menu" role="menu" aria-label={`Send ${count} to`}>
          <button type="button" role="menuitem" title="A run going on the repo, else an agent in one of its shells, else a new chat" onClick={() => send(async () => PICK_SAID[await sendToAgent(repoId, text)])}>
            the repo's agent
          </button>
          {shells === null ? (
            <p className="preview-notes-hint">looking for agents in shells…</p>
          ) : (
            shells.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                title="Pasted, not sent: press Enter there"
                onClick={() =>
                  send(async () => {
                    if (!typeInto(t.id, text)) throw new Error(`${shellName(t)} has no view here any more`);
                    showTerm(t.id);
                    return `Pasted into ${shellName(t)}: press Enter there to send it.`;
                  })
                }
              >
                the agent in {shellName(t)}
              </button>
            ))
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              send(async () => {
                await startRun(repoId, "chat", text);
                return PICK_SAID.started;
              })
            }
          >
            a new chat
          </button>
          {has.map((h) => (
            <button
              key={h}
              type="button"
              role="menuitem"
              disabled={long}
              title={long ? `Too long for a new shell's first prompt (${SHELL_PROMPT_MAX} characters): send to a chat` : `A new shell at the repo with ${HARNESS[h].label}, started on these notes`}
              onClick={() =>
                send(async () => {
                  openTerm(repoId, "panel", "agent", text, { harness: h });
                  return `Started ${HARNESS[h].label} in a new shell on the notes.`;
                })
              }
            >
              a new {HARNESS[h].label} shell
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
