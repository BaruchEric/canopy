import { useEffect, useState, type ReactNode } from "react";
import type { StepNode } from "../runs";
import { useStore } from "../store";
import { foldKey, foldWords, stepInFlight, type Fold } from "../turnfold";

/** One fold of the intermediate level's timeline (FR-079): a turn's commands
 *  and tool calls as one line, "worked for 40s · 12 steps". A click opens it
 *  and the steps follow as the advanced timeline draws them; a second click
 *  folds them away. While the turn is live the line counts the seconds and
 *  names the step in flight. `renderStep` is the timeline's own `Step`, so
 *  an opened fold is the advanced timeline, one line longer. Which folds
 *  are open is the page's, by run, so one stays open when its sheet closes
 *  and opens again, and wherever else the run's timeline shows. */
export function TurnFold({ runId, fold, renderStep }: { runId: string; fold: Fold; renderStep: (n: StepNode) => ReactNode }) {
  const key = foldKey(runId, fold.id);
  const open = useStore((s) => s.foldsOpen[key] === true);
  const toggleFold = useStore((s) => s.toggleFold);
  // a live fold reads the clock each second; a settled one keeps the time it took
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!fold.live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fold.live]);
  const first = fold.nodes[0]?.step.at;
  const ms = fold.live && first !== undefined ? Math.max(0, now - first) : fold.ms;
  const flight = stepInFlight(fold);
  return (
    <>
      <li className={["step k-fold", fold.live ? "live" : "", open ? "open" : ""].filter(Boolean).join(" ")}>
        <span className="node" />
        <button type="button" className="fold-line" aria-expanded={open} title={open ? "Fold these steps away" : "Show each step"} onClick={() => toggleFold(key)}>
          <span className="fold-words">{foldWords({ nodes: fold.nodes, ms, live: fold.live })}</span>
          {flight?.tool && <code className="fold-flight">{flight.tool.title}</code>}
        </button>
      </li>
      {open && fold.nodes.map(renderStep)}
    </>
  );
}
