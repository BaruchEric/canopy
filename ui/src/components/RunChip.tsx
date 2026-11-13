import { groupWord } from "../groups";
import { landingAll, useStore } from "../store";
import { keepKeys } from "../surface";
import { flowWord } from "../flows";
import { AGENT_NAME, harnessOf, ranUnchanged, runWord } from "../runs";
import type { Flow, Run } from "../../../src/core/types";

/** One word about a repo's run, on the card and in the panel. Clicking it
 *  opens the console; the finished states stay until the run is dismissed. */
export function RunChip({ run, long = false }: { run: Run; long?: boolean }) {
  const showRun = useStore((s) => s.showRun);
  const group = useStore(s => landingAll(s).groups?.find(g => g.id === (run.group ?? run.branch?.group)));
  const showGroup = useStore(s => s.showGroup);
  const harness = harnessOf(run);
  // A commit or push that left git status exactly as it was is not a
  // success the card can show, so the chip says so instead of "done".
  const noChange = ranUnchanged(run);
  const text = runWord(run, long);
  return (
    <button
      type="button"
      className={`run-chip st-${group ? group.state === "needs-you" || group.state === "picked" ? "waiting" : ["working", "scoring", "reviewing"].includes(group.state) ? "working" : "done" : run.status}${noChange ? " no-change" : ""}`}
      title={group ? "Show the branch group" : `Show the run (${AGENT_NAME[harness]})${run.equip ? `\nloadout ${run.equip.loadout}` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (group) showGroup(group.id);
        else showRun(run.id);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      <span className="dot" />
      {group ? `best of ${group.expectedMembers}: ${groupWord(group)}` : text}
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
      onKeyDown={keepKeys}
    >
      <span className="dot" />
      {flowWord(flow, long)}
    </button>
  );
}
