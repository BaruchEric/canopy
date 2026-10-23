import { useState } from "react";
import type { Repo } from "../../../src/core/types";
import { takesNotes } from "../reviewnotes";
import { useStore } from "../store";

/** what a send did, in words for the panel's note */
const SENT: Record<"said" | "pasted" | "started", string> = {
  said: "review notes sent to the agent's chat",
  started: "review notes sent: a new chat started with them",
  pasted: "review notes pasted into the agent's shell: press Enter there to send them",
};

/** The repo panel's "review notes · N" strip, shown while the repo has
 *  notes left on its diffs: sends them all to the repo's agent, or clears
 *  them. The outcome goes to the panel's own note (`onNote`), since a send
 *  that works empties the strip and takes it away. */
export function ReviewNotesStrip({ repo, onNote }: { repo: Repo; onNote: (kind: "ok" | "err", text: string) => void }) {
  const count = useStore((s) => s.reviewNotes[repo.id]?.length ?? 0);
  const sendNotes = useStore((s) => s.sendNotes);
  const clearNotes = useStore((s) => s.clearNotes);
  const [busy, setBusy] = useState(false);
  if (count === 0) return null;
  const send = () => {
    setBusy(true);
    sendNotes(repo.id)
      .then((how) => onNote("ok", SENT[how]))
      .catch((err: unknown) => onNote("err", String(err instanceof Error ? err.message : err)))
      .finally(() => setBusy(false));
  };
  const agent = takesNotes(repo);
  return (
    <div className="review-strip" role="group" aria-label="Review notes">
      <span className="review-strip-label">
        review notes · <span className="review-strip-n">{count}</span>
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="mini strong"
        disabled={busy || !agent}
        title={agent ? "Send every note to this repo's agent in one message" : "This repo has no agent here to take them"}
        onClick={send}
      >
        {busy ? <span className="shimmer">sending…</span> : "send to agent"}
      </button>
      <button type="button" className="mini" disabled={busy} title="Drop every note on this repo" onClick={() => clearNotes(repo.id)}>
        clear
      </button>
    </div>
  );
}
