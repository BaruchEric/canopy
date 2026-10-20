import { useEffect, useState } from "react";
import { isSeedId } from "../../../src/core/sprout";
import { isRunActive } from "../../../src/core/types";
import { FIX_WATCH, fixedNote, fixPrompt, freshFailure, moveDone, type FixMove } from "../fixit";
import { activeRunFor, useStore } from "../store";

/** what failed: a move, git's answer and when it came (the mount, unless
 *  the caller kept it), or a prompt read when pressed (a failed task's,
 *  whose log is fetched then) */
type What = { move: FixMove; text: string; at?: number } | { ask: () => Promise<string> };

/** the failures already handed over unasked, so a remount starts nothing */
const handed = new Set<string>();

/** The agent's side of a failed move or task. A move the user pressed is
 *  theirs to supervise: a fresh failure (`freshFailure`) goes to a chat on
 *  the repo by itself, told what was pressed and what came back
 *  (`fixPrompt`). A failed task waits for "fix with the agent" (`short`
 *  words it "fix", for a task row with little room), since a task fails
 *  without anyone pressing anything (`taskFixPrompt`). An idle chat there
 *  takes it as its next turn; a run still busy refuses, and the refusal
 *  shows beside the button. Once handed over, the note follows the run
 *  (`FIX_WATCH`) with a way back to the chat, and offers the button again
 *  when the run failed, stopped or was dismissed. When the repo's status
 *  shows the move finished (`moveDone`), `onDone` gets the words for it,
 *  for the note to stop showing a failure that is no longer one. A seed's
 *  agents run through the incubator, so a seed gets none. */
export function AgentFix({ repoId, short, onDone, ...what }: { repoId: string; short?: boolean; onDone?: (text: string) => void } & What) {
  const openChat = useStore((s) => s.openChat);
  const showRun = useStore((s) => s.showRun);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const run = useStore((s) => (runId ? s.runs[runId] : undefined));
  const status = useStore((s) => s.repos.find((r) => r.id === repoId)?.status);
  const [mounted] = useState(() => Date.now());
  const seed = isSeedId(repoId);

  const go = () => {
    setBusy(true);
    setErr(null);
    const prompt = "ask" in what ? what.ask() : Promise.resolve(fixPrompt(what.move, what.text));
    prompt
      .then((p) => openChat(repoId, p))
      .then(() => setRunId(activeRunFor(useStore.getState(), repoId)?.id ?? null))
      .catch((e: unknown) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };

  const at = "move" in what ? (what.at ?? mounted) : null;
  const key = "move" in what ? `${repoId}\0${what.move}\0${at}` : null;
  useEffect(() => {
    if (seed || key === null || at === null || handed.has(key) || !freshFailure(at, Date.now())) return;
    handed.add(key);
    go();
    // once per failure: `key` names it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const move = "move" in what ? what.move : null;
  const done = run !== undefined && move !== null && !!status && moveDone(move, status) === true;
  useEffect(() => {
    if (done && move) onDone?.(fixedNote(move));
  }, [done, move, onDone]);

  if (seed) return null;
  const again = !run || (!isRunActive(run) && run.status !== "done");
  return (
    <>
      {run && <span className="note-why">{FIX_WATCH[run.status]}</span>}
      {run && (
        <button type="button" className="mini note-act" title="Open the chat the failure went to" onClick={() => showRun(run.id)}>
          open chat
        </button>
      )}
      {again && (
        <button
          type="button"
          className="mini note-act"
          disabled={busy}
          title="Fix with the agent: start a chat on this repo with what failed, to find the cause and fix it"
          onClick={go}
        >
          {busy ? "starting…" : short ? "fix" : "fix with the agent"}
        </button>
      )}
      {err && <span className="note-why">{err}</span>}
    </>
  );
}
