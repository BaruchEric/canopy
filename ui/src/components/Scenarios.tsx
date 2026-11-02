import type { ScenarioNames, ScenarioRun } from "../../../src/core/types";
import { resultWord, scenarioLine, scenarioTone } from "../landing";
import { setRows, staleWord } from "../scenarios";

/** One pass of the holdout scenarios (FR-032): its line, folding open to
 *  each result's name, kind, satisfaction or why, and output tail. Names
 *  and observations only; a scenario's text never reaches the page. `head`
 *  is the head shown now, so a pass on an older one says so. */
export function ScenarioPass({ pass, head, title }: { pass: ScenarioRun; head?: string | undefined; title: string }) {
  const stale = staleWord(pass, head);
  return (
    <details className="run-scenarios">
      <summary className={`run-branch-why ${scenarioTone(pass)}`} title={title}>
        {scenarioLine(pass)}
        {stale && <span className="dim"> · {stale}</span>}
      </summary>
      <ul>
        {pass.results.map((r) => (
          <li key={r.name} className={r.ok ? "" : "rust"}>
            <span>{resultWord(r)}</span> <span>{r.name}</span> <span className="dim">{r.kind}</span>
            {(r.why ?? r.unjudged) && <span className="dim"> {r.why ?? r.unjudged}</span>}
            {r.tail && <pre>{r.tail}</pre>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A repo's holdout set in its landing section: each scenario by name and
 *  kind, and each file that does not read. Built from `ScenarioNames`
 *  alone, which is all the page is ever sent. */
export function ScenarioList({ set }: { set: ScenarioNames }) {
  return (
    <div className="landing-scenarios">
      <ul className="landing-list">
        {setRows(set).map((r) => (
          <li key={r.key} className="landing-row">
            <span className="landing-branch">{r.name}</span>
            <span className={`landing-state${r.tone ? ` ${r.tone}` : ""}`}>{r.word}</span>
          </li>
        ))}
      </ul>
      <p className="landing-why">Run after the gates and before auto-merge. Their text stays on the backend; canopy scenarios lists, adds and runs them from your own shell.</p>
    </div>
  );
}
