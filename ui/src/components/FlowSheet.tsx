import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { describeAgent, isDefaultAgent } from "../../../src/core/agent";
import { repoFacts } from "../../../src/core/actions";
import { fleetSkipReason } from "../../../src/core/flow";
import { isFlowActive, type Fleet, type Flow, type FlowStep, type Repo, type Verdict } from "../../../src/core/types";
import { fleetCounts, flowWord, oldestParked, stepWord } from "../flows";
import { agentFor, idText, pickedIds, useStore } from "../store";
import { BackendWord } from "./IdLabel";
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
  const agent = useStore((s) => agentFor(s, repo, "flow"));
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
          <h2 className="sheet-title">{w.verb} <span className="sheet-repo">{idText(repo.id)}</span></h2>
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
          <h2 className="sheet-title">{flow.verb} <span className="sheet-repo">{idText(flow.repoId)}</span></h2>
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
          {error && <p className="note err">{error}</p>}
        </div>
      ) : run ? (
        <Timeline
          run={run}
          repo={repo}
          error={error}
          onAnswer={(a) => void act(() => answerRun(run.id, run.prompt?.id ?? "", a))}
          extra={
            <>
              {step?.check && (
                <details className="gate-check" open>
                  <summary>{step.status === "failed" ? "check failed" : "check"}: {step.check.command}</summary>
                  <pre>{step.check.output || "(no output)"}</pre>
                </details>
              )}
              {flow.status === "failed" && <div className="outcome err"><p>{flow.error ?? "The workflow failed."}</p></div>}
            </>
          }
        />
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
  const close = useStore((s) => s.closeSheet);
  const startFleet = useStore((s) => s.startFleet);
  const selected = useStore(useShallow(pickedIds));
  const repos = useStore(useShallow((s) => s.repos.filter((r) => selected.includes(r.id))));
  const entry = useStore((s) => Object.values(s.workflows).flat().find((e) => e.ok && e.workflow.name === workflow));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = entry && entry.ok ? entry.workflow : undefined;
  const rows = repos.map((r) => ({ repo: r, skipped: w ? fleetSkipReason(r, w) : null }));
  const running = rows.filter((r) => !r.skipped);
  const skipped = rows.filter((r) => r.skipped);
  const byReason = new Map<string, string[]>();
  for (const r of skipped) byReason.set(r.skipped ?? "", [...(byReason.get(r.skipped ?? "") ?? []), r.repo.name]);
  const ready = !busy && running.length > 0 && (!w?.noteRequired || note.trim().length > 0);
  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await startFleet(workflow, note);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · fleet</div>
          <h2 className="sheet-title">{w?.verb ?? workflow} <span className="sheet-repo">{running.length} of {repos.length} repos</span></h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <div className="sheet-body plan">
        {w && <p className="blurb">{w.blurb}</p>}
        <p className="fleet-list">{running.map((r) => r.repo.name).join(", ") || "nothing to run on"}</p>
        {[...byReason.entries()].map(([why, names]) => (
          <p key={why} className="fleet-skipped"><span className="eyebrow">skipped, {why}</span>{names.join(", ")}</p>
        ))}
        <textarea className="plan-note" rows={3} placeholder={w?.notePlaceholder ?? "anything Claude should know (optional)"} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note for Claude" />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">Three repos at a time. A workflow that stops to ask holds its place until you answer.</span>
        <button type="button" className="mini" onClick={close}>cancel</button>
        <button type="button" className="mini strong" disabled={!ready} onClick={() => void go()}>{busy ? "starting…" : `run on ${running.length}`}</button>
      </footer>
    </>
  );
}

export function FleetSheet({ fleetId }: { fleetId: string }) {
  const close = useStore((s) => s.closeSheet);
  const fleet = useStore((s) => s.fleets[fleetId]);
  const flows = useStore((s) => s.flows);
  const repos = useStore((s) => s.repos);
  const stopFleet = useStore((s) => s.stopFleet);
  const dismissFleet = useStore((s) => s.dismissFleet);
  const showFlow = useStore((s) => s.showFlow);
  const resumeFlow = useStore((s) => s.resumeFlow);
  const answerRun = useStore((s) => s.answerRun);
  const runs = useStore((s) => s.runs);
  const [error, setError] = useState<string | null>(null);
  if (!fleet) {
    return (
      <>
        <p className="sheet-empty">That fleet is gone.</p>
        <footer className="sheet-foot"><span className="spacer" /><button type="button" className="mini" onClick={close}>close</button></footer>
      </>
    );
  }
  const counts = fleetCounts(fleet, flows);
  const parked = oldestParked(fleet, flows);
  const parkedStep = parked?.steps[parked.current];
  const parkedRun = parkedStep?.runId ? runs[parkedStep.runId] : undefined;
  const working = fleet.status === "working";
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  };
  const name = (id: string) => repos.find((r) => r.id === id)?.name ?? idText(id);
  const word = (r: Fleet["repos"][number]): string => {
    if (r.skipped) return `skipped, ${r.skipped}`;
    const f = r.flowId ? flows[r.flowId] : undefined;
    if (!f) return "waiting its turn";
    return flowWord(f, true);
  };
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · fleet</div>
          <h2 className="sheet-title">{fleet.verb} <span className="sheet-repo">{fleet.repos.length} repos</span></h2>
        </div>
        <span className={`status st-${counts.needsYou ? "waiting" : working ? "working" : "done"}`}>
          <span className="dot" />
          {working
            ? `${counts.active} running, ${counts.pending} to go${counts.needsYou ? `, ${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you` : ""}`
            : `${counts.done} done, ${counts.failed} failed, ${counts.skipped} skipped`}
        </span>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <div className="sheet-body console">
        {parked && parkedStep && (
          <section className="fleet-needs">
            <p className="eyebrow">needs you: {name(parked.repoId)}</p>
            {parked.status === "gated" ? (
              <Gate flow={parked} step={parkedStep} onChoose={(c) => void act(() => resumeFlow(parked.id, c))} />
            ) : parkedRun?.prompt ? (
              <Timeline run={parkedRun} repo={repos.find((r) => r.id === parked.repoId)} error={null} onAnswer={(a) => void act(() => answerRun(parkedRun.id, parkedRun.prompt?.id ?? "", a))} />
            ) : null}
          </section>
        )}
        <ul className="fleet-rows">
          {fleet.repos.map((r) => {
            const f = r.flowId ? flows[r.flowId] : undefined;
            const st = r.skipped ? "skipped" : !f ? "pending" : f.status === "gated" ? "waiting" : f.status;
            const summary = f && !isFlowActive(f) ? (f.steps[f.current]?.summary ?? "").split(/(?<=\.)\s/)[0] : "";
            return (
              <li key={r.repoId} className={`fleet-row st-${st}`}>
                <button type="button" className="fleet-name" disabled={!f} onClick={() => f && showFlow(f.id)}>
                  <span className="dot" />
                  {name(r.repoId)}
                  {repos.some((rp) => rp.id === r.repoId) && <BackendWord id={r.repoId} />}
                </button>
                <span className="fleet-word">{word(r)}</span>
                {summary && <span className="fleet-summary">{summary}</span>}
              </li>
            );
          })}
        </ul>
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="spacer" />
        {working ? (
          <button type="button" className="mini" onClick={() => void act(() => stopFleet(fleet.id))}>stop all</button>
        ) : (
          <button type="button" className="mini" onClick={() => void act(() => dismissFleet(fleet.id))}>dismiss</button>
        )}
        <button type="button" className="mini strong" onClick={close}>{working ? "hide" : "close"}</button>
      </footer>
    </>
  );
}
