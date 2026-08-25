import { useEffect, useRef, useState } from "react";
import { ACTIONS, EXPECTS_CHANGE, repoFacts } from "../../../src/core/actions";
import { useStore, type Sheet } from "../store";
import {
  isRunActive,
  type Repo,
  type Run,
  type RunAction,
  type RunAnswer,
  type RunPrompt,
  type RunQuestion,
  type RunStep,
} from "../../../src/core/types";

const STATUS_WORD: Record<Run["status"], string> = {
  working: "working",
  waiting: "waiting for you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Re-renders once a second while `on`, for the elapsed clock. */
function useTick(on: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
  return Date.now();
}

/* ---------- the modal frame ---------- */

export function RunSheet() {
  const sheet = useStore((s) => s.sheet);
  const close = useStore((s) => s.closeSheet);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    // Focus lands inside, so the keyboard user is in the dialog, not behind it.
    ref.current
      ?.querySelector<HTMLElement>("textarea, button:not(.close)")
      ?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, close]);

  if (!sheet) return null;
  return (
    <div className="sheet-back" onPointerDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true">
        <Body sheet={sheet} />
      </div>
    </div>
  );
}

function Body({ sheet }: { sheet: Sheet }) {
  const close = useStore((s) => s.closeSheet);
  const repo = useStore((s) =>
    s.repos.find((r) => r.id === (sheet.kind === "plan" ? sheet.repoId : s.runs[sheet.runId]?.repoId)),
  );
  const run = useStore((s) => (sheet.kind === "run" ? s.runs[sheet.runId] : undefined));

  if (sheet.kind === "plan") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <Plan repo={repo} action={sheet.action} />;
  }
  if (!run) return <Missing what="That run is gone." onClose={close} />;
  return <Console run={run} repo={repo} />;
}

function Missing({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <>
      <p className="sheet-empty">{what}</p>
      <footer className="sheet-foot">
        <span className="spacer" />
        <button type="button" className="mini" onClick={onClose}>
          close
        </button>
      </footer>
    </>
  );
}

/* ---------- pre-flight ---------- */

function Plan({ repo, action }: { repo: Repo; action: RunAction }) {
  const close = useStore((s) => s.closeSheet);
  const startRun = useStore((s) => s.startRun);
  const spec = ACTIONS[action];
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !busy && (!spec.noteRequired || note.trim().length > 0);

  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await startRun(repo.id, action, note);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude</div>
          <h2 className="sheet-title">
            {spec.verb} <span className="sheet-repo">{repo.id}</span>
          </h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body plan">
        <div className="facts">
          {repoFacts(repo).map((f) => (
            <span key={f} className="branch">
              {f}
            </span>
          ))}
        </div>
        <p className="blurb">{spec.blurb}</p>
        <textarea
          className="plan-note"
          rows={spec.noteRequired ? 5 : 3}
          placeholder={spec.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
          }}
          aria-label={spec.noteRequired ? "What Claude should do" : "Note for Claude"}
        />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">
          Claude asks before running anything that is not part of the job.
        </span>
        <button type="button" className="mini" onClick={close}>
          cancel
        </button>
        <button
          type="button"
          className="mini strong"
          disabled={!ready}
          title="⌘↩"
          onClick={() => void go()}
        >
          {busy ? "starting…" : spec.verb}
        </button>
      </footer>
    </>
  );
}

/* ---------- the console ---------- */

function Console({ run, repo }: { run: Run; repo: Repo | undefined }) {
  const close = useStore((s) => s.closeSheet);
  const stopRun = useStore((s) => s.stopRun);
  const dismissRun = useStore((s) => s.dismissRun);
  const answerRun = useStore((s) => s.answerRun);
  const active = isRunActive(run);
  const noChange =
    run.status === "done" && run.outcome === "unchanged" && EXPECTS_CHANGE[run.action];
  const now = useTick(active);
  const elapsed = (run.endedAt ?? now) - run.startedAt;
  const spec = ACTIONS[run.action];
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  // Follow the newest step unless the reader has scrolled up to study
  // something; a jump while they read would lose their place.
  useEffect(() => {
    const el = list.current;
    if (!el || !stuck.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run.steps.length, run.prompt, run.status]);

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  };

  // Claude's closing words arrive twice, as the last message and as the
  // result. The outcome box shows them once.
  const last = run.steps[run.steps.length - 1];
  const steps =
    run.result && last?.kind === "text" && last.text === run.result.text
      ? run.steps.slice(0, -1)
      : run.steps;

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude</div>
          <h2 className="sheet-title">
            {spec.verb} <span className="sheet-repo">{run.repoId}</span>
          </h2>
        </div>
        <span className={`status st-${run.status}${noChange ? " no-change" : ""}`}>
          <span className="dot" />
          {noChange ? "done, nothing changed" : STATUS_WORD[run.status]}
        </span>
        <span className="clock" title="elapsed">
          {mmss(elapsed)}
        </span>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>

      <div
        ref={list}
        className="sheet-body console"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {run.note && (
          <p className="run-note">
            <span className="eyebrow">your note</span>
            {run.note}
          </p>
        )}
        <ol className="steps">
          {steps.map((s) => (
            <Step key={s.id} step={s} />
          ))}
          {run.status === "working" && run.steps.length === 0 && (
            <li className="step k-note">
              <span className="node" />
              <span className="step-text">starting Claude Code in {repo?.path ?? run.repoId}…</span>
            </li>
          )}
          {run.status === "working" && run.steps.length > 0 && (
            <li className="step k-note thinking">
              <span className="node" />
              <span className="step-text">thinking…</span>
            </li>
          )}
        </ol>
        {run.prompt && (
          <Prompt
            prompt={run.prompt}
            onAnswer={(a) => void act(() => answerRun(run.id, run.prompt?.id ?? "", a))}
          />
        )}
        {run.result && run.status === "done" && (
          <div className={noChange ? "outcome warn" : "outcome ok"}>
            {noChange && (
              <p className="outcome-lead">
                git status is the same as before this run, so the card still shows the repo as it was.
              </p>
            )}
            <p>{run.result.text || "Done."}</p>
          </div>
        )}
        {run.status === "failed" && (
          <div className="outcome err">
            <p>{run.error ?? "The run failed."}</p>
            {run.result?.text && run.result.text !== run.error && <p>{run.result.text}</p>}
          </div>
        )}
        {run.status === "stopped" && <div className="outcome dim"><p>Stopped. Whatever Claude had already done stays done.</p></div>}
        {noChange && !active && (
          <p className="sheet-hint followup-hint">
            Reopen the ⋯ menu to start another run, or ask Claude in a terminal to handle it.
          </p>
        )}
        {error && <p className="note err">{error}</p>}
      </div>

      <footer className="sheet-foot">
        {run.result && (
          <span className="sheet-hint">
            {run.result.turns} turn{run.result.turns === 1 ? "" : "s"} ·{" "}
            {mmss(run.result.durationMs)} · ${run.result.costUsd.toFixed(2)}
          </span>
        )}
        <span className="spacer" />
        {active ? (
          <button type="button" className="mini" onClick={() => void act(() => stopRun(run.id))}>
            stop
          </button>
        ) : (
          <button type="button" className="mini" onClick={() => void act(() => dismissRun(run.id))}>
            dismiss
          </button>
        )}
        <button type="button" className="mini strong" onClick={close}>
          {active ? "hide" : "close"}
        </button>
      </footer>
    </>
  );
}

function Step({ step }: { step: RunStep }) {
  if (step.kind === "tool" && step.tool) {
    const t = step.tool;
    return (
      <li className={`step k-tool st-${t.status}`}>
        <span className="node" />
        <div className="step-body">
          <code className="step-title">{t.title}</code>
          {t.output && (
            <details className="step-out">
              <summary>{t.status === "error" ? "error" : "output"}</summary>
              <pre>{t.output}</pre>
            </details>
          )}
        </div>
      </li>
    );
  }
  return (
    <li className={`step k-${step.kind}`}>
      <span className="node" />
      <span className="step-text">{step.text}</span>
    </li>
  );
}

/* ---------- prompts: permission and questions ---------- */

function Prompt({
  prompt,
  onAnswer,
}: {
  prompt: RunPrompt;
  onAnswer: (a: RunAnswer) => void;
}) {
  if (prompt.kind === "permission") {
    return (
      <div className="ask">
        <div className="eyebrow">claude wants to run</div>
        <pre className="ask-detail">{prompt.detail}</pre>
        <div className="ask-row">
          <button type="button" className="mini strong" onClick={() => onAnswer({ kind: "allow" })}>
            allow
          </button>
          <button
            type="button"
            className="mini"
            title="Every later request in this run passes without asking"
            onClick={() => onAnswer({ kind: "allow-all" })}
          >
            allow all for this run
          </button>
          <span className="spacer" />
          <button type="button" className="mini" onClick={() => onAnswer({ kind: "deny" })}>
            deny
          </button>
        </div>
      </div>
    );
  }
  return <Questions questions={prompt.questions} onAnswer={(answers) => onAnswer({ kind: "answers", answers })} />;
}

function Questions({
  questions,
  onAnswer,
}: {
  questions: RunQuestion[];
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerFor = (q: RunQuestion): string => {
    const free = other[q.question]?.trim();
    const chosen = picked[q.question] ?? [];
    return [...chosen, ...(free ? [free] : [])].join(", ");
  };
  const complete = questions.every((q) => answerFor(q).length > 0);

  const toggle = (q: RunQuestion, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? []
          : [label];
      return { ...p, [q.question]: next };
    });

  const submit = () => {
    if (!complete) return;
    onAnswer(Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])));
  };

  return (
    <div className="ask">
      <div className="eyebrow">claude asks</div>
      {questions.map((q) => (
        <div key={q.question} className="question">
          <p className="q-text">
            {q.header && <span className="branch">{q.header}</span>}
            {q.question}
          </p>
          <div className="options" role={q.multiSelect ? "group" : "radiogroup"}>
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={on}
                  className={on ? "option on" : "option"}
                  onClick={() => toggle(q, o.label)}
                >
                  <span className="opt-label">{o.label}</span>
                  {o.description && <span className="opt-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            className="other"
            placeholder="something else…"
            value={other[q.question] ?? ""}
            onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-label={`Another answer to: ${q.question}`}
          />
        </div>
      ))}
      <div className="ask-row">
        <button type="button" className="mini strong" disabled={!complete} onClick={submit}>
          answer
        </button>
      </div>
    </div>
  );
}
