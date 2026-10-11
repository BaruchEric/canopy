import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Harness, MoveCheck, MovePlan, TermInfo } from "../../../src/core/types";
import { api } from "../api";
import { backendOf, qual } from "../registry";
import { MOVE_STEPS, runMove, type MoveOutcome, type MoveStep } from "../move";
import { cardOf, useStore } from "../store";
import { termId, type TermTab } from "../term";

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

/** what a move started with, kept while its sheet is open: the stop quits
 *  the agent, so the shell's harness and session go away mid-move */
interface Moving {
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
    setMoving({ toRepoId, harness, session });
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
      {moving && createPortal(<MoveSheet tab={tab} {...moving} close={() => setMoving(null)} />, document.body)}
    </>
  );
}

function MoveSheet({ tab, harness, session, toRepoId, close }: Moving & { tab: TermTab; close: () => void }) {
  const landMove = useStore((s) => s.landMove);
  const from = backendOf(tab.repoId);
  const to = backendOf(toRepoId);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [step, setStep] = useState<MoveStep | null>(null);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);
  const [busy, setBusy] = useState(false);

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

  const finish = () => {
    if (running || busy) return;
    if (landed) landMove(tab.id, tab.repoId, toRepoId, landed);
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
    const result = await runMove(
      {
        check: () => api.moveCheck(toRepoId, { from, branch: plan.branch, head: plan.head, transcriptBytes: plan.transcriptBytes, session: plan.session, harness: plan.harness }),
        stop: () => api.moveOut(tab.id, plan.session, plan.harness),
        transcript: (out) => api.moveTranscript(tab.id, out.session),
        load: (out, blob) => api.moveIn(toRepoId, out, blob, from, qual(to, termId()), tab.place),
        clean: async () => {
          await api.moveFinish(tab.id);
        },
      },
      setStep,
    );
    setOutcome(result);
    if (result.ok) {
      landMove(tab.id, tab.repoId, toRepoId, result.term);
      close();
    }
  };

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.moveUndo(tab.id);
      close();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  const retryClean = async () => {
    if (!landed) return;
    setBusy(true);
    setError(null);
    try {
      await api.moveFinish(tab.id);
      landMove(tab.id, tab.repoId, toRepoId, landed);
      close();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
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
                    <li key={f}>{f}</li>
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
          {error && <p className="note err">{error}</p>}
        </div>
        <footer className="sheet-foot">
          <span className="spacer" />
          {failed && failed.stopped && !failed.loaded && (
            <button type="button" className="mini" disabled={busy} onClick={() => void undo()}>
              resume here
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
      </div>
    </div>
  );
}
