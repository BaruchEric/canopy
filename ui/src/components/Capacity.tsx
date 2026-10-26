import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { hitStands } from "../../../src/core/capacity";
import { AGENT_NAME } from "../runs";
import { leavesPop, useFitPop } from "../pop";
import { useNow } from "./Registry";
import { useStore, idText } from "../store";
import { escapeCloses } from "../surface";
import { ageWord, CAPACITY_GLYPH, capacityRows, capacityWord, rowsTone } from "../capacity";

/** The usage windows for every backend that has answered, with limited runs below. */
export function CapacityChip() {
  const { capacity, order } = useStore(useShallow((s) => ({ capacity: s.capacity, order: s.backendOrder })));
  const limited = useStore(useShallow((s) => Object.values(s.runs)
    .filter((run) => run.status === "limited")
    .sort((a, b) => (b.limited?.at ?? b.startedAt) - (a.limited?.at ?? a.startedAt))));
  const repos = useStore((s) => s.repos);
  const now = useNow();
  const rows = useMemo(() => capacityRows(capacity, order, now), [capacity, order, now]);
  const word = capacityWord(rows);
  const tone = rowsTone(rows);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (leavesPop(event.target, ref)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => escapeCloses(event, () => setOpen(false));
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (rows.length === 0) return null;
  return (
    <div className="settings capacity" ref={ref}>
      <button
        type="button"
        className={`mini capacity-chip ${tone}${open ? " on" : ""}`}
        aria-label={`Capacity: ${word}`}
        aria-expanded={open}
        title="Usage windows by backend"
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{CAPACITY_GLYPH}</span>
        {word}
      </button>
      {open && (
        <div className="settings-pop capacity-pop" role="dialog" aria-label="Capacity">
          <h3 className="panel-label">capacity</h3>
          <div className="capacity-rows">
            {rows.map((row) => (
              <section className="capacity-row" key={`${row.backend}\u0000${row.cap.harness}`}>
                <h4>{row.backend} · {AGENT_NAME[row.cap.harness]}</h4>
                {row.lines.length === 0 ? (
                  <>
                    <span className="capacity-reading">no reading</span>
                    <span className="capacity-hint">set capacity.observedFiveHourUsd in config.json to estimate from the ledger</span>
                  </>
                ) : row.lines.map((line) => (
                  <span className={`capacity-reading ${row.tone}`} key={line}>{line}</span>
                ))}
                <span className="capacity-source">{row.source}</span>
                {row.cap.hit !== null && hitStands(row.cap.hit, now) && (
                  <span className="capacity-hit">limit hit {ageWord(now - row.cap.hit.at)}: {row.cap.hit.text}</span>
                )}
              </section>
            ))}
          </div>
          {limited.length > 0 && (
            <section className="capacity-limited">
              <h4 className="panel-label">waiting for capacity</h4>
              <ul>
                {limited.map((run) => (
                  <li key={run.id}>
                    <span className="capacity-limited-name">{run.verb} · {repos.find((repo) => repo.id === run.repoId)?.name ?? idText(run.repoId)}</span>
                    {run.error && <span className="capacity-limited-error">{run.error}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
