import { useEffect, useRef, useState } from "react";
import { isSeedId } from "../../../src/core/sprout";
import { isRunActive } from "../../../src/core/types";
import { api } from "../api";
import {
  FIX_WATCH,
  fixedNote,
  fixPrompt,
  freshFailure,
  repairConfirmed,
  repairStatusSnapshot,
  repairTurnIdentity,
  type FixMove,
  type RepairStatus,
} from "../fixit";
import { backendOf } from "../registry";
import { activeRunFor, useStore } from "../store";

/** what failed: a move, git's answer and when it came (the mount, unless
 *  the caller kept it), or a prompt read when pressed (a failed task's,
 *  whose log is fetched then) */
type What = { move: FixMove; text: string; at?: number } | { ask: () => Promise<string> };
type RepairAttempt = { runId: string; before: RepairStatus | null; previousTurn: string | null };

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
 *  when the run failed, stopped or was dismissed. A fresh rescan after a
 *  new successful turn must show the failed status move changing to done
 *  before `onDone` gets the words for it. A seed's agents run through the
 *  incubator, so a seed gets none. */
export function AgentFix({ repoId, short, onDone, ...what }: { repoId: string; short?: boolean; onDone?: (text: string) => void } & What) {
  const openChat = useStore((s) => s.openChat);
  const showRun = useStore((s) => s.showRun);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const run = useStore((s) => (runId ? s.runs[runId] : undefined));
  const [attempt, setAttempt] = useState<RepairAttempt | null>(null);
  const attemptRef = useRef<RepairAttempt | null>(null);
  const checkedTurns = useRef(new Set<string>());
  const checkingTurns = useRef(new Set<string>());
  const mountedRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const [mounted] = useState(() => Date.now());
  const seed = isSeedId(repoId);

  const go = () => {
    const beforeState = useStore.getState();
    const previousRun = activeRunFor(beforeState, repoId);
    const previousTurn = previousRun ? repairTurnIdentity(previousRun) : null;
    const before = "move" in what ? repairStatusSnapshot(beforeState.repos.find((repo) => repo.id === repoId)?.status) : null;
    // A retry supersedes any rescan still completing for the prior attempt.
    attemptRef.current = null;
    setAttempt(null);
    setBusy(true);
    setErr(null);
    const prompt = "ask" in what ? what.ask() : Promise.resolve(fixPrompt(what.move, what.text));
    prompt
      .then((p) => openChat(repoId, p))
      .then(() => {
        const current = activeRunFor(useStore.getState(), repoId);
        const next = current ? { runId: current.id, before, previousTurn } : null;
        attemptRef.current = next;
        setAttempt(next);
        setRunId(current?.id ?? null);
      })
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
  const currentAttempt = attempt?.runId === run?.id ? attempt : null;
  const turn = currentAttempt && run ? repairTurnIdentity(run) : null;
  const completionKey = turn && turn !== currentAttempt?.previousTurn ? `${run?.id}\0${turn}` : null;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (seed || !completionKey || !turn || !run || !currentAttempt || !move) return;
    if (checkedTurns.current.has(completionKey) || checkingTurns.current.has(completionKey)) return;
    checkingTurns.current.add(completionKey);
    // GET /api/tree is cached. POST /api/rescan runs a new scan, and the
    // baseline makes an already-clear cached status insufficient evidence.
    void api
      .rescan(backendOf(repoId))
      .then(({ repos }) => {
        checkedTurns.current.add(completionKey);
        if (!mountedRef.current || attemptRef.current !== currentAttempt) return;
        const latest = useStore.getState().runs[currentAttempt.runId];
        if (!latest || repairTurnIdentity(latest) !== turn) return;
        const freshStatus = repos.find((repo) => repo.id === repoId)?.status ?? null;
        if (repairConfirmed(move, latest, currentAttempt.before, freshStatus, currentAttempt.previousTurn)) {
          onDoneRef.current?.(fixedNote(move));
        }
      })
      .catch(() => {})
      .finally(() => checkingTurns.current.delete(completionKey));
  }, [completionKey, currentAttempt, move, repoId, run, seed, turn]);

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
