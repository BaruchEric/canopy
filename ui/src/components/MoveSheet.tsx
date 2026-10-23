import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Harness, MoveCheck, MovePlan, TermInfo } from "../../../src/core/types";
import { api } from "../api";
import { backendOf, qual } from "../registry";
import { closeUndoes, MOVE_STEPS, offersResume, runMove, statusOf, type MoveOutcome, type MoveStep } from "../move";
import { cardOf, useStore } from "../store";
import { termId, type TermTab } from "../term";
import { CENTERED } from "../pop";
import { PopGrip } from "./PopGrip";

const STEP_TEXT: Record<MoveStep, string> = {
  check: "the target can take it",
  stop: "the agent quit here, its work saved",
  transcript: "the conversation read",
  load: "work and conversation loaded there",
  clean: "this tree cleaned, this shell closed",
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const ago = (ms: number): string => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Wraps a landing so it runs once at most: the success path, the clean
 *  retry, the close and the sheet going away all land the same tab. */
export function landOnce(land: (info: TermInfo) => void): (info: TermInfo) => void {
  let done = false;
  return (info) => {
    if (done) return;
    done = true;
    land(info);
  };
}

/** what a move started with, kept while its sheet is open: the stop quits
 *  the agent, so the shell's harness and session go away mid-move, and the
 *  tab row this button sits on may come to show another shell */
interface Moving {
  tab: TermTab;
  toRepoId: string;
  harness: Harness;
  session: string | null;
}

/** "move to <backend>": shown while an agent runs in the shell and the repo
 *  is checked out on another backend the page shows */
export function MoveButton({ tab, harness, session }: { tab: TermTab; harness: Harness | null; session: string | null }) {
  const card = useStore((s) => cardOf(s, tab.repoId));
  const [moving, setMoving] = useState<Moving | null>(null);
  const [picking, setPicking] = useState(false);
  const here = backendOf(tab.repoId);
  const targets = (card?.checkouts ?? []).filter((c) => backendOf(c.id) !== here && !c.forge && !c.host);
  const [only] = targets;
  const open = (toRepoId: string) => {
    if (!harness) return;
    setPicking(false);
    setMoving({ tab, toRepoId, harness, session });
  };
  return (
    <>
      {harness && only && (
        <button
          type="button"
          className="term-new term-word"
          title="Carry this conversation and the uncommitted work to the same repo on another machine"
          onClick={() => (targets.length === 1 ? open(only.id) : setPicking((p) => !p))}
        >
          {targets.length === 1 ? `move to ${backendOf(only.id)}` : "move to…"}
        </button>
      )}
      {harness && picking && targets.length > 1 && (
        <span className="move-pick" role="menu">
          {targets.map((t) => (
            <button key={t.id} type="button" role="menuitem" className="mini" onClick={() => open(t.id)}>
              {backendOf(t.id)}
            </button>
          ))}
        </span>
      )}
      {moving && createPortal(<MoveSheet {...moving} close={() => setMoving(null)} />, document.body)}
    </>
  );
}

function MoveSheet({ tab, harness, session, toRepoId, close }: Moving & { close: () => void }) {
  const from = backendOf(tab.repoId);
  const to = backendOf(toRepoId);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [step, setStep] = useState<MoveStep | null>(null);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  /** what "resume here" came to: null before it ran */
  const [undone, setUndone] = useState<"resumed" | "nothing" | "failed" | null>(null);
  const [land] = useState(() => landOnce((info) => useStore.getState().landMove(tab.id, tab.repoId, toRepoId, info)));
  // the tab row may stop showing this sheet's button (the shell exits, say)
  // while a failed clean waits: the term already loaded there lands then
  const loaded = useRef<TermInfo | null>(null);
  /** this try's move id, which the source's later calls name, and the
   *  shell name the target loads under, both minted once per go */
  const run = useRef<{ move: string; target: string } | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (loaded.current) land(loaded.current);
    };
  }, [land]);

  useEffect(() => {
    let live = true;
    (async () => {
      const p = await api.movePlan(tab.id, session, harness);
      if (!live) return;
      setPlan(p);
      const c = await api.moveCheck(toRepoId, { from, branch: p.branch, head: p.head, transcriptBytes: p.transcriptBytes, session: p.session, harness: p.harness });
      if (live) setCheck(c);
    })().catch((err: unknown) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [tab.id, toRepoId, from, session, harness]);

  const running = step !== null && outcome === null;
  const failed = outcome && !outcome.ok ? outcome : null;
  // a failed clean leaves the session running on the target: its tab lands
  // when the sheet closes, so the sheet stays up to retry the clean
  const landed: TermInfo | null = failed?.loaded ?? null;
  // the load's answer never came: the target may run the session already
  const unknown = failed?.unknown === true;
  // stopped and not loaded: the source holds a move record until undone
  const unresumed = failed !== null && offersResume(failed) && undone === null;

  /** "resume here": the source forgets the move and resumes its agent if
   *  it had quit. Closing the sheet runs it too (but not after a load that
   *  may have run), so no record is left to refuse the next move from this
   *  shell. */
  const undo = async (closing: boolean) => {
    const move = run.current?.move;
    if (!move) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.moveUndo(tab.id, move);
      if (closing || r.resumed) {
        close();
        return;
      }
      setUndone("nothing");
    } catch (err) {
      setError(errText(err));
      // a close that could not undo closes on the next try, not never
      if (closing) setUndone("failed");
    }
    setBusy(false);
  };

  const finish = () => {
    if (running || busy) return;
    if (failed && closeUndoes(failed) && undone === null) {
      void undo(true);
      return;
    }
    if (landed) land(landed);
    close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const go = async () => {
    if (!plan) return;
    setError(null);
    const move = termId();
    // one name for every load of this try, so a retry finds what an earlier
    // load whose answer was lost started instead of starting a second shell
    const target = qual(to, termId());
    run.current = { move, target };
    const result = await runMove(
      {
        check: () => api.moveCheck(toRepoId, { from, branch: plan.branch, head: plan.head, transcriptBytes: plan.transcriptBytes, session: plan.session, harness: plan.harness }),
        stop: () => api.moveOut(tab.id, plan.session, plan.harness, move),
        transcript: (out) => api.moveTranscript(tab.id, out.session, move),
        load: (out, blob) => api.moveIn(toRepoId, out, blob, from, target, tab.place),
        clean: async () => {
          await api.moveFinish(tab.id, move);
        },
      },
      setStep,
    );
    if (result.ok) {
      land(result.term);
      close();
      return;
    }
    loaded.current = result.loaded;
    // gone while the steps ran: nothing is left to show the failure on, so
    // it does what closing would have
    if (!mounted.current) {
      if (result.loaded) land(result.loaded);
      else if (closeUndoes(result)) void api.moveUndo(tab.id, move).catch(() => {});
      return;
    }
    setOutcome(result);
  };

  const retryClean = async () => {
    const move = run.current?.move;
    if (!landed || !move) return;
    setBusy(true);
    setError(null);
    try {
      await api.moveFinish(tab.id, move);
      land(landed);
      close();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  /** "check again" after a load with no answer: the same shell name again,
   *  which the target answers with the shell it holds or by starting it */
  const checkAgain = async () => {
    const r = run.current;
    if (!failed?.unknown || !failed.carried || !r) return;
    setBusy(true);
    setError(null);
    let info: TermInfo;
    try {
      info = await api.moveIn(toRepoId, failed.carried.out, failed.carried.transcript, from, r.target, tab.place);
    } catch (err) {
      // an answer this time: the target did not take it, so the way back
      // is the undo again; no answer still leaves it unknown
      if (statusOf(err) !== null) setOutcome({ ...failed, unknown: false, error: errText(err) });
      else setError(errText(err));
      setBusy(false);
      return;
    }
    loaded.current = info;
    try {
      await api.moveFinish(tab.id, r.move);
    } catch (err) {
      setStep("clean");
      setOutcome({ ...failed, step: "clean", unknown: false, loaded: info, error: errText(err) });
      setBusy(false);
      return;
    }
    land(info);
    close();
  };

  const at = step ? MOVE_STEPS.indexOf(step) : -1;
  return (
    <div className="sheet-back" onPointerDown={(e) => e.target === e.currentTarget && finish()}>
      <div className="sheet move-sheet" role="dialog" aria-modal="true" aria-label={`Move to ${to}`}>
        <header className="sheet-head">
          <div>
            <div className="eyebrow">
              {from} → {to}
            </div>
            <h2 className="sheet-title">move this session</h2>
          </div>
          <button type="button" className="mini close" onClick={finish} disabled={running || busy} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="sheet-body">
          {!plan && !error && <p className="sheet-empty">reading the session…</p>}
          {plan && (
            <>
              <p className="move-prompt">
                {plan.prompt ? `"${plan.prompt}"` : "no prompt yet"}{" "}
                <span className="move-meta">
                  · {plan.harness} · last active {ago(plan.at)}
                </span>
              </p>
              <p className="move-meta">
                to {check?.path ?? "…"} on {to}, branch {plan.branch}
              </p>
              <p className="move-meta">
                {plan.changed === 0 ? "no uncommitted changes" : `${plan.changed} uncommitted ${plan.changed === 1 ? "file" : "files"}`}
                {plan.changed > 0 && (
                  <button type="button" className="mini" onClick={() => setShowFiles((v) => !v)}>
                    {showFiles ? "hide" : "show"}
                  </button>
                )}
              </p>
              {showFiles && (
                <ul className="move-files">
                  {plan.files.map((f) => (
                    <li key={f.path} className={`move-file ${f.change}`}>
                      {f.path}
                      {f.change !== "modified" && <span className="move-change">{f.change === "added" ? "new" : f.change === "renamed" ? `renamed from ${f.from ?? "?"}` : "deleted"}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {plan.ignored > 0 && (
                <p className="move-meta">
                  {plan.ignored} gitignored {plan.ignored === 1 ? "entry stays" : "entries stay"} here (.env and the like)
                </p>
              )}
              {check && !check.ok && !step && <p className="note err">{check.reason ?? `${to} cannot take it`}</p>}
              {check?.existing && <p className="move-meta">{to} has an earlier copy of this conversation; it is replaced only if this one continues it</p>}
            </>
          )}
          {step && (
            <ol className="move-steps">
              {MOVE_STEPS.map((s, i) => {
                const state = failed?.step === s ? "failed" : i < at || outcome?.ok ? "done" : i === at ? "now" : "todo";
                return (
                  <li key={s} className={`move-step ${state}`}>
                    {STEP_TEXT[s]}
                  </li>
                );
              })}
            </ol>
          )}
          {failed && <p className="note err">{failed.error}</p>}
          {landed && <p className="move-meta">the session already runs on {to}; this tree still has the work</p>}
          {unknown && undone === null && (
            <p className="move-meta">
              {to} never answered the load, so it may already run the session. Check again first: resuming here while it runs there would split the conversation.
            </p>
          )}
          {undone === "nothing" && <p className="move-meta">nothing needed resuming here</p>}
          {error && <p className="note err">{error}</p>}
        </div>
        <footer className="sheet-foot">
          <span className="spacer" />
          {unknown && undone === null && (
            <button type="button" className="mini" disabled={busy} onClick={() => void checkAgain()}>
              check again
            </button>
          )}
          {unresumed && (
            <button type="button" className="mini" disabled={busy} onClick={() => void undo(false)}>
              {unknown ? "resume here anyway" : "resume here"}
            </button>
          )}
          {landed && (
            <button type="button" className="mini" disabled={busy} onClick={() => void retryClean()}>
              clean source
            </button>
          )}
          {!step && (
            <button type="button" className="mini strong" disabled={!check?.ok} onClick={() => void go()}>
              move
            </button>
          )}
        </footer>
        <PopGrip name="sheet move" anchor={CENTERED} gap={24} />
      </div>
    </div>
  );
}
