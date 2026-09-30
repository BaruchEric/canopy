import { useStore } from "../store";
import { flowWord } from "../flows";
import { AGENT_NAME, agentWord, harnessOf } from "../runs";
import type { Flow, Run } from "../../../src/core/types";

/** One word about a repo's run, on the card and in the panel. Clicking it
 *  opens the console; the finished states stay until the run is dismissed. */
export function RunChip({ run, long = false }: { run: Run; long?: boolean }) {
  const showRun = useStore((s) => s.showRun);
  const verb = run.verb;
  const harness = harnessOf(run);
  const who = agentWord(harness);
  // A commit or push that left git status exactly as it was is not a
  // success the card can show, so the chip says so instead of "done".
  const noChange = run.status === "done" && run.outcome === "unchanged" && run.expectsChange;
  const text = noChange
    ? long
      ? `${verb}: no change`
      : "no change"
    :
    run.status === "working"
      ? long
        ? `${who} is ${run.progress}`
        : `${run.progress}…`
      : run.status === "waiting"
        ? long
          ? `${verb}: ${who} needs you`
          : "needs you"
        : run.status === "idle"
          ? long
            ? "chat open, your turn"
            : "chat open"
        : run.status === "done"
          ? long
            ? `${verb} done`
            : "done"
          : run.status === "failed"
            ? long
              ? `${verb} failed`
              : "failed"
            : long
              ? `${verb} stopped`
              : "stopped";
  return (
    <button
      type="button"
      className={`run-chip st-${run.status}${noChange ? " no-change" : ""}`}
      title={`Show the run (${AGENT_NAME[harness]})`}
      onClick={(e) => {
        e.stopPropagation();
        showRun(run.id);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="dot" />
      {text}
    </button>
  );
}

/** The flow's word on a card or in the panel. Same colours as a run's. */
export function FlowChip({ flow, long = false }: { flow: Flow; long?: boolean }) {
  const showFlow = useStore((s) => s.showFlow);
  const status = flow.status === "gated" ? "waiting" : flow.status;
  const noChange = flow.status === "done" && flow.outcome === "unchanged";
  return (
    <button
      type="button"
      className={`run-chip st-${status}${noChange ? " no-change" : ""}`}
      title="Show the workflow"
      onClick={(e) => {
        e.stopPropagation();
        showFlow(flow.id);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="dot" />
      {flowWord(flow, long)}
    </button>
  );
}
