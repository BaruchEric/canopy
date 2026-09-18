import { useState } from "react";
import { describeAgent, isDefaultAgent } from "../../../src/core/agent";
import { repoFacts } from "../../../src/core/actions";
import { isFlowActive, type Flow, type FlowStep, type Repo, type Verdict } from "../../../src/core/types";
import { flowWord, stepWord } from "../flows";
import { agentFor, useStore } from "../store";
import { Timeline } from "./RunSheet";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------- pre-flight for one repo ---------- */

export function FlowPlan({ repo, workflow }: { repo: Repo; workflow: string }) {
  const close = useStore((s) => s.closeSheet);
  const startFlow = useStore((s) => s.startFlow);
  const agent = useStore((s) => agentFor(s, repo));
  const verdictReady = useStore((s) => s.verdictReady);
  const entry = useStore((s) => s.workflows[repo.id]?.find((e) => e.ok && e.workflow.name === workflow));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!entry || !entry.ok) {
    return (
      <>
        <p className="sheet-empty">That workflow is gone from the menu.</p>
        <footer className="sheet-foot"><span className="spacer" /><button type="button" className="mini" onClick={close}>close</button></footer>
      </>
    );
  }
  const w = entry.workflow;
  const ready = !busy && (!w.noteRequired || note.trim().length > 0);
  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await startFlow(repo.id, w.name, note);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · {w.source === "bundled" ? "built in" : w.source === "user" ? "your workflow" : "this repo's workflow"}</div>
          <h2 className="sheet-title">{w.verb} <span className="sheet-repo">{repo.id}</span></h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <div className="sheet-body plan">
        <div className="facts">
          {repoFacts(repo).map((f) => <span key={f} className="branch">{f}</span>)}
          {!isDefaultAgent(agent) && <span className="branch" title="This repo's agent settings">{describeAgent(agent)}</span>}
        </div>
        <p className="blurb">{w.blurb}</p>
        <ol className="plan-steps">
          {w.steps.map((s) => (
            <li key={s.name}>
              <span className="plan-step-name">{s.name}</span>
              <span className="plan-step-meta">
                {s.body ? "" : "check only"}
                {s.check ? ` · check: ${s.check}` : ""}
                {s.gate !== "continue" ? ` · gate: ${s.gate}` : ""}
              </span>
            </li>
          ))}
        </ol>
        <textarea
          className="plan-note"
          rows={w.noteRequired ? 5 : 3}
          placeholder={w.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go(); }}
          aria-label={w.noteRequired ? "What Claude should do" : "Note for Claude"}
        />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">
          {w.steps.some((s) => s.gate === "verdict") && !verdictReady
            ? "No gateway key on the server, so verdict gates will ask you instead."
            : agent.yolo
              ? "Yolo is on for this repo: Claude runs without asking."
              : "Claude asks before running anything that is not part of the job."}
        </span>
        <button type="button" className="mini" onClick={close}>cancel</button>
        <button type="button" className="mini strong" disabled={!ready} title="⌘↩" onClick={() => void go()}>
          {busy ? "starting…" : w.verb}
        </button>
      </footer>
    </>
  );
}

/* ---------- the step strip ---------- */

export function StepStrip({ flow, shown, onPick }: { flow: Flow; shown: number; onPick: (i: number) => void }) {
  return (
    <ol className="step-strip" aria-label="Steps">
      {flow.steps.map((s, i) => (
        <li key={s.name}>
          <button
            type="button"
            className={`step-seg st-${s.status}${i === shown ? " shown" : ""}`}
            title={`${s.name}: ${stepWord(s)}`}
            aria-current={i === flow.current ? "step" : undefined}
            disabled={!s.runId && !s.check}
            onClick={() => onPick(i)}
          >
            <span className="dot" />
            {s.name}
          </button>
        </li>
      ))}
    </ol>
  );
}

/* ---------- the gate ---------- */

function VerdictBars({ verdict }: { verdict: Verdict }) {
  const rows: [string, number][] = [
    ["done", verdict.answers.outcome.probabilities?.["done"] ?? (verdict.answers.outcome.choice === "done" ? 1 : 0)],
    ["needs you", verdict.answers.needsYou.probability],
    ["off scope", verdict.answers.offScope.probability],
  ];
  return (
    <dl className="verdict-bars">
      {rows.map(([label, p]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><span className="bar" style={{ width: `${Math.round(p * 100)}%` }} /><span className="pct">{Math.round(p * 100)}%</span></dd>
        </div>
      ))}
    </dl>
  );
}

function Gate({ flow, step, onChoose }: { flow: Flow; step: FlowStep; onChoose: (c: "continue" | "retry" | "stop") => void }) {
  const last = flow.current + 1 >= flow.steps.length;
  return (
    <div className="gate">
      <p className="outcome-lead">{step.reason}</p>
      {step.summary && <p className="gate-summary">{step.summary}</p>}
      {step.check && (
        <details className="gate-check">
          <summary>check passed: {step.check.command}</summary>
          <pre>{step.check.output || "(no output)"}</pre>
        </details>
      )}
      {step.verdict && <VerdictBars verdict={step.verdict} />}
      <div className="gate-buttons">
        <button type="button" className="mini strong" onClick={() => onChoose("continue")}>
          {last ? "accept and finish" : `continue to ${flow.steps[flow.current + 1]?.name ?? "the next step"}`}
        </button>
        <button type="button" className="mini" onClick={() => onChoose("retry")}>retry this step</button>
        <button type="button" className="mini" onClick={() => onChoose("stop")}>stop here</button>
      </div>
    </div>
  );
}

/* ---------- the console ---------- */

export function FlowConsole({ flowId }: { flowId: string }) {
  const close = useStore((s) => s.closeSheet);
  const flow = useStore((s) => s.flows[flowId]);
  const repo = useStore((s) => s.repos.find((r) => r.id === flow?.repoId));
  const stopFlow = useStore((s) => s.stopFlow);
  const dismissFlow = useStore((s) => s.dismissFlow);
  const resumeFlow = useStore((s) => s.resumeFlow);
  const answerRun = useStore((s) => s.answerRun);
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read above the early return below: hooks must never be conditional, and
  // a gated flow's current step has no run to look up.
  const runId = flow?.steps[picked ?? flow.current]?.runId;
  const run = useStore((s) => (runId ? s.runs[runId] : undefined));
  if (!flow) {
    return (
      <>
        <p className="sheet-empty">That workflow run is gone.</p>
        <footer className="sheet-foot"><span className="spacer" /><button type="button" className="mini" onClick={close}>close</button></footer>
      </>
    );
  }
  const active = isFlowActive(flow);
  const shown = picked ?? flow.current;
  const step = flow.steps[shown];
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  };
  const elapsed = (flow.endedAt ?? Date.now()) - flow.startedAt;
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · workflow</div>
          <h2 className="sheet-title">{flow.verb} <span className="sheet-repo">{flow.repoId}</span></h2>
        </div>
        <span className={`status st-${flow.status === "gated" ? "waiting" : flow.status}`}>
          <span className="dot" />
          {flowWord(flow, true)}
        </span>
        <span className="clock" title="elapsed">{mmss(elapsed)}</span>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <StepStrip flow={flow} shown={shown} onPick={(i) => setPicked(i === flow.current ? null : i)} />
      {step && flow.status === "gated" && shown === flow.current ? (
        <div className="sheet-body console">
          <Gate flow={flow} step={step} onChoose={(c) => void act(() => resumeFlow(flow.id, c))} />
          {run && <Timeline run={run} repo={repo} error={null} onAnswer={() => {}} />}
        </div>
      ) : run ? (
        <Timeline run={run} repo={repo} error={error} onAnswer={(a) => void act(() => answerRun(run.id, run.prompt?.id ?? "", a))} />
      ) : (
        <div className="sheet-body console">
          {step?.check ? (
            <details className="gate-check" open>
              <summary>{step.status === "failed" ? "check failed" : "check"}: {step.check.command}</summary>
              <pre>{step.check.output || "(no output)"}</pre>
            </details>
          ) : (
            <p className="sheet-empty">{step ? stepWord(step) : "no step"}</p>
          )}
          {flow.status === "failed" && <div className="outcome err"><p>{flow.error ?? "The workflow failed."}</p></div>}
          {error && <p className="note err">{error}</p>}
        </div>
      )}
      <footer className="sheet-foot">
        <span className="sheet-hint">step {shown + 1} of {flow.steps.length}{step ? `: ${stepWord(step)}` : ""}</span>
        <span className="spacer" />
        {active ? (
          <button type="button" className="mini" onClick={() => void act(() => stopFlow(flow.id))}>stop</button>
        ) : (
          <button type="button" className="mini" onClick={() => void act(() => dismissFlow(flow.id))}>dismiss</button>
        )}
        <button type="button" className="mini strong" onClick={close}>{active ? "hide" : "close"}</button>
      </footer>
    </>
  );
}

export function FleetPlan({ workflow }: { workflow: string }) {
  return <p className="sheet-empty">fleet plan for {workflow}: task 10</p>;
}
export function FleetSheet({ fleetId }: { fleetId: string }) {
  return <p className="sheet-empty">fleet {fleetId}: task 10</p>;
}
